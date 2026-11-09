import { Injectable } from '@nestjs/common';
import { Clock } from '@/common/clock/clock.port';
import { RequestContext } from '@/common/context/request-context';
import { InvalidRequestException, NotFoundException } from '@/common/errors/domain.exception';
import { AuditService } from '@/modules/audit/audit.service';
import { LeadStatusRepository } from './activity.repository';
import { LeadPipeline, LeadStatusDocument } from './lead-status.schema';
import { checkLeadStatusCreate, checkLeadStatusLabel } from './config-input';
import { CONFIG_REFUSALS } from './config.messages';

/** The pipelines' own refusals, in both languages (P18.10-T5 AC-3). */
const SAY = CONFIG_REFUSALS.VALIDATION_FAILED;

export interface LeadStatusView {
  id: string;
  pipeline: LeadPipeline;
  code: string;
  label: string;
  rank: number;
  isTerminal: boolean;
  isLateStage: boolean;
  version: number;
  status: 'active' | 'archived';
}

export interface LeadPipelineView {
  pipeline: LeadPipeline;
  statuses: LeadStatusView[];
}

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
    body: { pipeline: LeadPipeline; code: string; label: string },
  ): Promise<LeadStatusView> {
    // The body's own rules first, however it arrived (ADR-0030).
    const input = checkLeadStatusCreate(body);
    const { code } = input;
    // Across both pipelines: one code must not mean two things in one office.
    if (await this.statuses.exists(ctx, { code })) {
      throw new InvalidRequestException(SAY.leadStatusTaken({ code }));
    }

    const inPipeline = await this.statuses.count(ctx, { pipeline: input.pipeline });
    const created = await this.statuses.create(ctx, {
      pipeline: input.pipeline,
      code,
      label: input.label,
      // Appended. A new stage at the end of a ladder is the common case, and inserting
      // would renumber rows nobody touched.
      rank: inPipeline + 1,
      // Never terminal on creation: a pipeline has exactly one, and it already has it.
      isTerminal: false,
      // Nor late: the Owner says which stages are expected to close, and a stage appended
      // to the end of a ladder is as likely to be a new terminal as a new late one.
      isLateStage: false,
      version: 1,
      status: 'active',
    } as Partial<LeadStatusDocument>);

    await this.record(ctx, 'lead_status.created', String(created._id), { code, pipeline: input.pipeline });
    return this.view(created);
  }

  /** The label only. The code is what every lead holds. */
  async rename(ctx: RequestContext, id: string, raw: string): Promise<LeadStatusView> {
    const label = checkLeadStatusLabel(raw);
    const updated = await this.statuses.updateById(ctx, id, {
      $set: { label },
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
      throw new InvalidRequestException(SAY.archivedCannotClose);
    }

    const current = await this.statuses.find(ctx, {
      pipeline: target.pipeline, isTerminal: true,
    });
    await Promise.all(current
      .filter((row) => String(row._id) !== id)
      .map((row) => this.statuses.updateById(ctx, String(row._id), {
        $set: { isTerminal: false }, $inc: { version: 1 },
      })));

    // A closed lead is not expected to close, so the two flags cannot both stand. Cleared
    // here rather than refused, because the Owner's intent is unambiguous: they are naming
    // the stage that ends the pipeline (ADR-0043).
    await this.statuses.updateById(ctx, id, {
      $set: { isTerminal: true, isLateStage: false }, $inc: { version: 1 },
    });
    await this.record(ctx, 'lead_status.terminal_changed', id, {
      pipeline: target.pipeline, code: target.code,
    });
    return (await this.list(ctx)).find((p) => p.pipeline === target.pipeline)!;
  }

  /**
   * Flag a stage as one the lead is expected to convert from this period (ADR-0043).
   *
   * **Not exclusive, unlike the terminal flag.** An office may name as many stages as its
   * ladder warrants — the seeded sales ladder names two and the recruitment ladder three
   * — so this is a set, and setting one says nothing about the others.
   *
   * It is what `RECRUITMENT_EXPECTED_TO_CLOSE` counts, and the reason the KPM Overview's
   * *Expected to close* tile could not be computed before Phase 7.
   */
  async setLateStage(ctx: RequestContext, id: string, isLateStage: boolean): Promise<LeadStatusView> {
    const target = await this.statuses.findById(ctx, id);
    if (!target) throw new NotFoundException('Lead status');
    if (isLateStage && target.isTerminal) {
      throw new InvalidRequestException(SAY.terminalIsClosed);
    }
    if (isLateStage && target.status === 'archived') {
      throw new InvalidRequestException(SAY.archivedHoldsNoLeads);
    }
    if (target.isLateStage === isLateStage) return this.view(target);

    const updated = await this.statuses.updateById(ctx, id, {
      $set: { isLateStage }, $inc: { version: 1 },
    });
    await this.record(ctx, 'lead_status.late_stage_changed', id, {
      code: target.code, pipeline: target.pipeline, isLateStage,
    });
    return this.view(updated!);
  }

  /** Reorder one pipeline, by naming all of it. */
  async reorder(ctx: RequestContext, pipeline: LeadPipeline, ids: string[]): Promise<LeadPipelineView> {
    const live = await this.statuses.find(ctx, { pipeline });
    const known = new Set(live.map((r) => String(r._id)));
    if (ids.length !== known.size || ids.some((id) => !known.has(id))) {
      throw new InvalidRequestException(SAY.sendEveryStatus({ pipeline }));
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
      throw new InvalidRequestException(SAY.terminalCannotArchive);
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

  private view(doc: LeadStatusDocument): LeadStatusView {
    return {
      id: String(doc._id),
      pipeline: doc.pipeline,
      code: doc.code,
      label: doc.label,
      rank: doc.rank,
      isTerminal: doc.isTerminal,
      isLateStage: doc.isLateStage,
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
