import { Inject, Injectable, Optional } from '@nestjs/common';
import { Clock } from '@/common/clock/clock.port';
import { RequestContext } from '@/common/context/request-context';
import { NoMembershipException, NotFoundException } from '@/common/errors/domain.exception';
import type { TrainingStatus } from '@/domain/constants';
import { ActivationEvents, signalActivation } from '@/modules/activation/activation-events.port';
import { AuditService } from '@/modules/audit/audit.service';
import { SubjectReadAudit } from '@/modules/audit/subject-read-audit';
import { CoachResolver } from '@/modules/org/coach-resolver';
import { can } from '@/modules/rbac/permissions';
import { TenantDay } from '@/modules/tenants/tenant-day.service';
import { OfferedTraining, type OfferedModule } from './offered-training';
import { TrainingProgressReadings, toRow, type TrainingProgressRow } from './training-progress-readings';
import { TrainingProgressRepository } from './training-progress.repository';
import type { TrainingProgressDocument } from './training-progress.schema';
import type {
  TrainingItemView, TrainingModulePageView, TrainingOpenView, TrainingProgressView,
} from './training-progress.view';
import { TrainingService } from './training.service';

const DUPLICATE_KEY = 11000;

/**
 * **The learner's training, and the coach's read of it** (P18.2-T1, T2, T4; `functional/training.md`, the Data
 * contract; roles §3.7).
 *
 * - **What is offered is the snapshot's** (`OfferedTraining`): a module not offered is 404 on every route here,
 *   whatever its row says — a draft, one archived or unpublished and published since, one published only in the
 *   working copy, an unknown code, another office's.
 * - **The status is the member's own word** (OD-149), set rather than toggled, by the member alone: no route
 *   takes a subject on a write, and no support session writes it (D-support, `BLOCKED_WHILE_IMPERSONATING`).
 * - **Opening is recorded once per item** (D-opened), on the progress row, and only by somebody who may set the
 *   status: a support session is answered the address and records nothing.
 * - **The coach's read is the learner's** (T4 AC-4): `?for=` resolves the subject through `COACH` and reads
 *   `TrainingProgressReadings.of` exactly as the member's own read does, then writes one §3.5 entry.
 */
@Injectable()
export class TrainingProgressService {
  constructor(
    private readonly rows: TrainingProgressRepository,
    private readonly readings: TrainingProgressReadings,
    private readonly offered: OfferedTraining,
    private readonly training: TrainingService,
    private readonly coach: CoachResolver,
    private readonly subjectReads: SubjectReadAudit,
    private readonly days: TenantDay,
    private readonly audit: AuditService,
    private readonly clock: Clock,
    // T3: a module marked done completes an activation item bound to it. A port, so training does not depend on activation.
    @Optional() @Inject(ActivationEvents) private readonly activation: ActivationEvents | null = null,
  ) {}

  // ------------------------------------------------------------------ reads

  /**
   * **`GET /training/progress`**: the reader's own, or — with `for` — another member's (T4 AC-1).
   *
   * **Whose is decided by `CoachResolver.subject`** on `training_progress:read`, as every subject read is (the
   * Summary's, the Unit Dashboard's, campaigns'): omitted, or the reader's own membership, it is their own; anybody
   * else is reached by the widest scope the reader holds — a field rung's `COACH` (`own-downline`, `own-unit`), the
   * Owner's and the Admin's office (`own-kpm`, roles §3.7, a member who has left included: the office's history is
   * read whole), an Agent's `own` nobody. Outside the reach, and another office's member, is 404.
   *
   * One §3.5 entry per read of somebody else's, last, once the answer exists; none for the reader's own.
   */
  async progress(ctx: RequestContext, forMembershipId?: string): Promise<TrainingProgressView> {
    const subject = await this.coach.subject(ctx, forMembershipId, 'training_progress:read');
    const view = await this.readings.of(ctx, subject.membershipId);
    if (!subject.self) {
      const { today } = await this.days.for(ctx);
      // Open-ended, as the Summary's is: the whole record was read, not a window of it.
      await this.subjectReads.record(ctx, subject, 'training', { from: null, to: today });
    }
    return view;
  }

  /** **`GET /training/modules/:code`**: one module as offered, with the reader's status and opened items. */
  async module(ctx: RequestContext, code: string): Promise<TrainingModulePageView> {
    const me = requireMembership(ctx);
    const offered = await this.requireOffered(ctx, code);
    const row = await this.rowOf(ctx, me, offered.module.code);
    return this.page(ctx, offered, row);
  }

  // ------------------------------------------------------------------ writes

  /**
   * **`POST /training/modules/:code/items/:itemId/open`** (T1 AC-6): the item's address, and its first open recorded.
   *
   * A file or a video is answered a URL signed for 300 seconds, by whichever registry owns it — the office's for
   * its own upload, the company's for material shared by reference (ADR-0032) — and refused `409
   * ASSET_NOT_CONFIRMED` while its bytes are unconfirmed. A link is answered its own address.
   *
   * **Recorded only by somebody who may set the status** (`training_progress:update`): never in a support
   * session, read-only or elevated, which is answered the address all the same; never for an Owner or an Admin
   * standing on no rung. The first open only — a second leaves the row alone.
   */
  async open(ctx: RequestContext, code: string, itemId: string): Promise<TrainingOpenView> {
    const me = requireMembership(ctx);
    const offered = await this.requireOffered(ctx, code);
    const item = (await this.items(ctx, offered.module.code)).find((i) => i.id === itemId);
    if (!item) throw new NotFoundException('Training item');

    const url = item.kind === 'link'
      ? item.url!
      : await this.training.contentUrl(ctx, offered.module.code, item.storageKey!);

    const before = await this.rowOf(ctx, me, offered.module.code);
    if (!can(ctx, 'training_progress:update') || before?.openedItemIds.includes(itemId)) {
      return { url, openedItemIds: before?.openedItemIds ?? [], recorded: false };
    }
    const { row, recorded } = await this.recordOpen(ctx, me, offered.module.code, itemId, before);
    return { url, openedItemIds: row.openedItemIds, recorded };
  }

  /**
   * **`PUT /training/modules/:code/progress`** (T1 AC-7): set the reader's status on one offered module.
   *
   * **Sets, never toggles**, so two tabs cannot fight. `startedAt` is written the first time the status leaves
   * `not_started` and kept; `completedAt` on each move to `done`, cleared on leaving it. A write that changes
   * nothing writes nothing and leaves no audit row; a change leaves one, `training_progress.status_changed`,
   * before and after. A move to `done` signals the member's activation (T3), failing open.
   */
  async setStatus(ctx: RequestContext, code: string, status: TrainingStatus): Promise<TrainingModulePageView> {
    const me = requireMembership(ctx);
    const offered = await this.requireOffered(ctx, code);
    const moduleCode = offered.module.code;

    const written = await this.writeStatus(ctx, me, moduleCode, status);
    if (written?.changed) {
      await this.audit.record(ctx, {
        action: 'training_progress.status_changed',
        targetCollection: 'trainingProgress',
        targetId: written.row.id,
        targetMembershipId: me,
        before: { moduleCode, status: written.before },
        after: { moduleCode, status },
      });
      if (status === 'done') await signalActivation(this.activation, ctx, me, 'training');
    }
    return this.page(ctx, offered, written?.row ?? (await this.rowOf(ctx, me, moduleCode)));
  }

  // ------------------------------------------------------------------ internals

  /**
   * The status written, and what it was. `null` when there was nothing to write: no row, and asked for
   * `not_started`, which is what no row already says.
   *
   * The update is **conditional on the status read**, so the audit's `before` is the value actually replaced: a
   * concurrent write that changed it first makes the filter miss, and the write is decided again on what is there
   * now. A first write racing another first write meets the unique index and is decided again the same way.
   */
  private async writeStatus(
    ctx: RequestContext, membershipId: string, moduleCode: string, status: TrainingStatus, attempt = 0,
  ): Promise<{ row: TrainingProgressRow; before: TrainingStatus; changed: boolean } | null> {
    const current = await this.rows.findOne(ctx, { membershipId, moduleCode });
    const before: TrainingStatus = current?.status ?? 'not_started';
    if (before === status) return current ? { row: toRow(current), before, changed: false } : null;

    const now = this.clock.now();
    const fields = {
      status,
      completedAt: status === 'done' ? now : null,
      ...(status !== 'not_started' && !current?.startedAt ? { startedAt: now } : {}),
    };

    let written: TrainingProgressDocument | null;
    if (current) {
      written = await this.rows.updateWhere(ctx, { _id: current._id, status: before }, { $set: fields });
    } else {
      written = await this.rows.create(ctx, {
        membershipId, moduleCode, startedAt: null, opened: [], version: 1, ...fields,
      } as Partial<TrainingProgressDocument>).catch((err: { code?: number }) => {
        if (err.code !== DUPLICATE_KEY) throw err;
        return null;
      });
    }
    if (written) return { row: toRow(written), before, changed: true };
    // Somebody else wrote first. Decide again on what is there now; twice is the most a race can need.
    if (attempt >= 2) throw new Error('trainingProgress: the status kept changing under the write');
    return this.writeStatus(ctx, membershipId, moduleCode, status, attempt + 1);
  }

  /**
   * The item's first open, on the row — creating the row at *Not started* when there is none. `recorded` is
   * false when a racing request recorded it first.
   */
  private async recordOpen(
    ctx: RequestContext, membershipId: string, moduleCode: string, itemId: string,
    current: TrainingProgressRow | null,
  ): Promise<{ row: TrainingProgressRow; recorded: boolean }> {
    const at = this.clock.now();
    if (!current) {
      const created = await this.rows.create(ctx, {
        membershipId, moduleCode, status: 'not_started', startedAt: null, completedAt: null,
        opened: [{ itemId, at }], version: 1,
      } as Partial<TrainingProgressDocument>).catch((err: { code?: number }) => {
        if (err.code !== DUPLICATE_KEY) throw err;
        return null;
      });
      if (created) return { row: toRow(created), recorded: true };
    }
    // `$ne` in the filter: an open recorded by a racing request is never written twice.
    const updated = await this.rows.updateWhere(
      ctx, { membershipId, moduleCode, 'opened.itemId': { $ne: itemId } }, { $push: { opened: { itemId, at } } },
    );
    return updated
      ? { row: toRow(updated), recorded: true }
      : { row: (await this.rowOf(ctx, membershipId, moduleCode))!, recorded: false };
  }

  private async rowOf(ctx: RequestContext, membershipId: string, moduleCode: string): Promise<TrainingProgressRow | null> {
    const doc = await this.rows.findOne(ctx, { membershipId, moduleCode });
    return doc ? toRow(doc) : null;
  }

  /** The module as the snapshot offers it, or the 404 that says nothing about whether it exists. */
  private async requireOffered(ctx: RequestContext, code: string): Promise<OfferedModule> {
    const found = (await this.offered.catalog(ctx)).modules.get(code.trim().toUpperCase());
    if (!found) throw new NotFoundException('Training module');
    return found;
  }

  /** The module's live content as items, files then videos then links, each in its stored order. */
  private async items(
    ctx: RequestContext, moduleCode: string,
  ): Promise<(TrainingItemView & { storageKey: string | null })[]> {
    const { content } = await this.training.readContent(ctx, moduleCode);
    const file = (kind: 'file' | 'video') => (f: (typeof content.files)[number]) => ({
      id: f.id, kind, label: f.label, mimeType: f.mimeType, bytes: f.bytes, url: null, storageKey: f.storageKey,
    });
    return [
      ...content.files.map(file('file')),
      ...content.videos.map(file('video')),
      ...content.links.map((l) => ({
        id: l.id, kind: 'link' as const, label: l.label, mimeType: null, bytes: null, url: l.url, storageKey: null,
      })),
    ];
  }

  private async page(
    ctx: RequestContext, offered: OfferedModule, row: TrainingProgressRow | null,
  ): Promise<TrainingModulePageView> {
    const items = await this.items(ctx, offered.module.code);
    const status = row?.status ?? 'not_started';
    return {
      code: offered.module.code,
      title: offered.module.title,
      description: offered.module.description ?? null,
      category: { code: offered.category.code, label: offered.category.label },
      skill: { code: offered.skill.code, label: offered.skill.label },
      // The storage key never leaves the server: an address is signed per open.
      items: items.map(({ storageKey: _key, ...item }) => item),
      status,
      startedAt: row?.startedAt ? row.startedAt.toISOString() : null,
      completedAt: status === 'done' && row?.completedAt ? row.completedAt.toISOString() : null,
      openedItemIds: row?.openedItemIds ?? [],
      can: { update: can(ctx, 'training_progress:update') },
    };
  }
}

/** The caller's own membership, or the refusal that says what to do about it. */
function requireMembership(ctx: RequestContext): string {
  const me = ctx.membershipId;
  if (!me) throw new NoMembershipException();
  return me;
}
