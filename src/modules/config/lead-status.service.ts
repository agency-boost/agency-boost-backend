import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { Clock } from '@/common/clock/clock.port';
import { RequestContext } from '@/common/context/request-context';
import { AuditService } from '@/modules/audit/audit.service';
import { LeadStatusRepository } from './activity.repository';
import { LeadPipeline, LeadStatusDocument } from './lead-status.schema';

export interface LeadStatusView {
  id: string;
  pipeline: LeadPipeline;
  code: string;
  label: string;
  rank: number;
  isTerminal: boolean;
  version: number;
  status: 'active' | 'archived';
}

export interface LeadPipelineView {
  pipeline: LeadPipeline;
  statuses: LeadStatusView[];
}

const CODE_SHAPE = /^[A-Z][A-Z0-9_]{2,39}$/;

/**
 * The office's two lead pipelines (P4-T3).
 *
 * **Exactly one terminal stage per pipeline, and it is enforced here.** *Mark successful*
 * is gated on it, so two would make the gate ambiguous and none would make it unreachable
 * — a pipeline nobody can ever close. Setting a new one clears the old in the same call
 * rather than leaving the office briefly in either state.
 */
@Injectable()
export class LeadStatusService {
  constructor(
    private readonly statuses: LeadStatusRepository,
    private readonly audit: AuditService,
    private readonly clock: Clock,
  ) {}

  async list(ctx: RequestContext, includeArchived = false): Promise<LeadPipelineView[]> {
    const filter = includeArchived ? {} : { status: 'active' };
    const rows = await this.statuses.find(ctx, filter, { sort: { pipeline: 1, rank: 1 } });
    return (['sales', 'recruitment'] as const).map((pipeline) => ({
      pipeline,
      statuses: rows.filter((r) => r.pipeline === pipeline).map((r) => this.view(r)),
    }));
  }

  async create(
    ctx: RequestContext,
    input: { pipeline: LeadPipeline; code: string; label: string },
  ): Promise<LeadStatusView> {
    const code = this.normaliseCode(input.code);
    // Across both pipelines: one code must not mean two things in one office.
    if (await this.statuses.exists(ctx, { code })) {
      throw new BadRequestException(`This office already has a lead status called ${code}.`);
    }

    const inPipeline = await this.statuses.count(ctx, { pipeline: input.pipeline });
    const created = await this.statuses.create(ctx, {
      pipeline: input.pipeline,
      code,
      label: input.label.trim(),
      // Appended. A new stage at the end of a ladder is the common case, and inserting
      // would renumber rows nobody touched.
      rank: inPipeline + 1,
      // Never terminal on creation: a pipeline has exactly one, and it already has it.
      isTerminal: false,
      version: 1,
      status: 'active',
    } as Partial<LeadStatusDocument>);

    await this.record(ctx, 'lead_status.created', String(created._id), { code, pipeline: input.pipeline });
    return this.view(created);
  }

  /** The label only. The code is what every lead holds. */
  async rename(ctx: RequestContext, id: string, label: string): Promise<LeadStatusView> {
    const updated = await this.statuses.updateById(ctx, id, {
      $set: { label: label.trim() },
      $inc: { version: 1 },
    });
    if (!updated) throw new NotFoundException('Lead status');
    await this.record(ctx, 'lead_status.renamed', id, { label });
    return this.view(updated);
  }

  /**
   * Move the terminal flag, atomically enough.
   *
   * There are no transactions (ADR-0002), so the old flag is cleared **first**: a moment
   * with no terminal stage refuses a *mark successful* that would otherwise have been
   * allowed at the wrong stage, and refusing briefly is the safer of the two failures.
   */
  async setTerminal(ctx: RequestContext, id: string): Promise<LeadPipelineView> {
    const target = await this.statuses.findById(ctx, id);
    if (!target) throw new NotFoundException('Lead status');
    if (target.status === 'archived') {
      throw new BadRequestException('An archived status cannot be the one that closes a pipeline.');
    }

    const current = await this.statuses.find(ctx, {
      pipeline: target.pipeline, isTerminal: true,
    });
    await Promise.all(current
      .filter((row) => String(row._id) !== id)
      .map((row) => this.statuses.updateById(ctx, String(row._id), {
        $set: { isTerminal: false }, $inc: { version: 1 },
      })));

    await this.statuses.updateById(ctx, id, { $set: { isTerminal: true }, $inc: { version: 1 } });
    await this.record(ctx, 'lead_status.terminal_changed', id, {
      pipeline: target.pipeline, code: target.code,
    });
    return (await this.list(ctx)).find((p) => p.pipeline === target.pipeline)!;
  }

  /** Reorder one pipeline, by naming all of it. */
  async reorder(ctx: RequestContext, pipeline: LeadPipeline, ids: string[]): Promise<LeadPipelineView> {
    const live = await this.statuses.find(ctx, { pipeline });
    const known = new Set(live.map((r) => String(r._id)));
    if (ids.length !== known.size || ids.some((id) => !known.has(id))) {
      throw new BadRequestException(
        `Send every ${pipeline} status, once each, in the order you want them.`,
      );
    }
    await Promise.all(ids.map((id, i) => this.statuses.updateById(ctx, id, { $set: { rank: i + 1 } })));
    await this.record(ctx, 'lead_status.reordered', ctx.kpmId ?? '', { pipeline, count: ids.length });
    return (await this.list(ctx)).find((p) => p.pipeline === pipeline)!;
  }

  async archive(ctx: RequestContext, id: string): Promise<LeadStatusView> {
    const target = await this.statuses.findById(ctx, id);
    if (!target) throw new NotFoundException('Lead status');
    if (target.isTerminal) {
      // Archiving it would leave the pipeline with no way to be marked successful, and
      // nothing on the leads screen would say why the tick stopped working.
      throw new BadRequestException(
        'This is the stage that closes the pipeline. Make another one terminal first.',
      );
    }

    const updated = await this.statuses.updateById(ctx, id, {
      $set: { status: 'archived', archivedAt: this.clock.now() },
      $inc: { version: 1 },
    });
    await this.record(ctx, 'lead_status.archived', id, { code: target.code });
    return this.view(updated!);
  }

  async restore(ctx: RequestContext, id: string): Promise<LeadStatusView> {
    const updated = await this.statuses.updateById(ctx, id, {
      $set: { status: 'active', archivedAt: null },
      $inc: { version: 1 },
    });
    if (!updated) throw new NotFoundException('Lead status');
    await this.record(ctx, 'lead_status.restored', id, { code: updated.code });
    return this.view(updated);
  }

  private normaliseCode(raw: string): string {
    const code = raw.trim().toUpperCase();
    if (!CODE_SHAPE.test(code)) {
      throw new BadRequestException(
        'A code is 3–40 characters of A–Z, 0–9 and underscore, starting with a letter. '
          + 'It is permanent once saved: every lead holds it.',
      );
    }
    return code;
  }

  private view(doc: LeadStatusDocument): LeadStatusView {
    return {
      id: String(doc._id),
      pipeline: doc.pipeline,
      code: doc.code,
      label: doc.label,
      rank: doc.rank,
      isTerminal: doc.isTerminal,
      version: doc.version,
      status: doc.status,
    };
  }

  private async record(
    ctx: RequestContext, action: string, targetId: string, after: Record<string, unknown>,
  ): Promise<void> {
    await this.audit.record(ctx, { action, targetCollection: 'leadStatuses', targetId, after });
  }
}
