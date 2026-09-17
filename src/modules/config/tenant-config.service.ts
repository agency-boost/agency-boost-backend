import { createHash } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import { OrgLevelRow, OrgLevelService } from '@/modules/tenants/org-level.service';
import { Clock } from '@/common/clock/clock.port';
import { RequestContext } from '@/common/context/request-context';
import { AuditService } from '@/modules/audit/audit.service';
import { ConfigSnapshotRepository } from './activity.repository';
import { ConfigSnapshotDocument } from './config-snapshot.schema';
import { ActivityConfigService, type ActivityCategoryView } from './activity.service';
import { LeadStatusService, type LeadPipelineView } from './lead-status.service';
import { RatioService, type RatioDefinitionView } from './ratio.service';

export interface PublishState {
  /** The published version agents are on, or 0 when nothing has been published. */
  publishedVersion: number;
  /**
   * The highest live row version. Informational only — **not** what decides
   * `hasUnpublishedChanges`, because a new row, an edit below it and an archive all leave
   * it where it was (P5-T11).
   */
  workingVersion: number;
  hasUnpublishedChanges: boolean;
  publishedAt: string | null;
}

export interface TenantConfigView {
  /** Every active activity category with its types, in display order. */
  activity: ActivityCategoryView[];
  ratios: RatioDefinitionView[];
  leadPipelines: LeadPipelineView[];
  /**
   * The highest `version` across everything above.
   *
   * **Not a change detector, and it was used as one.** It does not move when a row is
   * created (a new row starts at version 1), when a row below the maximum is edited up to
   * it, or when a row is archived (it leaves the active rows this is taken over). The
   * publish gate compared it and missed all three until P5-T11. What does answer "has
   * anything changed" is which rows are present at which version — see `changedSince`.
   */
  version: number;
}

/**
 * One read for every agent surface (P4-T7).
 *
 * **One round trip, not three.** The Log Activity screen needs the taxonomy, the ratio
 * strip needs the definitions, and the Leads screen needs the pipelines — and the agent's
 * daily loop has to work on a mid-range Android phone over 4G, which is the performance
 * budget `frontend/CLAUDE.md` sets. Three requests to render one screen is how that budget
 * gets spent before anything is drawn.
 *
 * **Active rows only.** This is what an agent may work against today; an archived type is
 * still readable wherever history names it, but it is not something new can be logged
 * against. The settings screens ask for the archived ones explicitly.
 */
@Injectable()
export class TenantConfigService {
  constructor(
    private readonly activity: ActivityConfigService,
    private readonly ratios: RatioService,
    private readonly leadStatuses: LeadStatusService,
    private readonly snapshots: ConfigSnapshotRepository,
    private readonly audit: AuditService,
    private readonly clock: Clock,
    private readonly orgLevels: OrgLevelService,
  ) {}

  /**
   * What agents work against: the published copy (P4-T6).
   *
   * **Not the live rows.** An Owner restructuring a taxonomy does it in steps, and between
   * them the live configuration is genuinely inconsistent — a ratio naming a type archived
   * a minute ago computes over something nobody can log any more. Agents would see that
   * for as long as the Owner took.
   *
   * Falls back to the live rows when an office somehow has no snapshot. Provisioning
   * writes one, so this is the "created before P4-T6" case rather than a normal state —
   * and an office whose agents see nothing at all would be a worse answer than one whose
   * agents see the working copy.
   */
  async readPublished(ctx: RequestContext): Promise<TenantConfigView> {
    const snapshot = await this.newestSnapshot(ctx);
    if (!snapshot) return this.read(ctx);
    return snapshot.payload as unknown as TenantConfigView;
  }

  /**
   * Publish the working copy.
   *
   * Renders the live rows into one document rather than flipping a flag: what agents read
   * then cannot drift from what was published, whatever happens to the rows afterwards.
   */
  async publish(ctx: RequestContext): Promise<PublishState> {
    const working = await this.read(ctx);
    const previous = await this.newestSnapshot(ctx);

    await this.snapshots.create(ctx, {
      version: (previous?.version ?? 0) + 1,
      sourceVersion: working.version,
      payload: working as unknown as Record<string, unknown>,
      publishedAt: this.clock.now(),
      publishedBy: ctx.membershipId,
    } as Partial<ConfigSnapshotDocument>);

    await this.audit.record(ctx, {
      action: 'tenant_config.published',
      targetCollection: 'configSnapshots',
      targetId: ctx.kpmId ?? '',
      after: { version: (previous?.version ?? 0) + 1, sourceVersion: working.version },
    });

    return this.state(ctx);
  }

  /** Whether there is anything to publish, and what agents are on meanwhile. */
  async state(ctx: RequestContext): Promise<PublishState> {
    const [snapshot, working] = await Promise.all([
      this.newestSnapshot(ctx),
      this.read(ctx),
    ]);

    return {
      publishedVersion: snapshot?.version ?? 0,
      workingVersion: working.version,
      hasUnpublishedChanges: !snapshot
        || this.changedSince(snapshot.payload as unknown as TenantConfigView, working),
      publishedAt: snapshot ? snapshot.publishedAt.toISOString() : null,
    };
  }

  /**
   * Whether the working copy differs from what was published, by **which rows are present at
   * which version** (P5-T11).
   *
   * **This replaced `working.version > snapshot.sourceVersion`, which was wrong in the
   * ordinary case.** The highest active version does not move when a row is created (it
   * starts at 1), when a row below the maximum is edited, or when a row is archived (it
   * leaves the active rows). So once any row in an office had reached version 2 and been
   * published, those three changes left the publish bar silent and agents on the old copy
   * — and the one test asserted an edit from a fresh office, the single case the old
   * comparison could see.
   *
   * Comparing the set of `(kind, id, version)` covers every write without asking any of
   * them to remember a counter: a create brings a new id, an edit a new version, an archive
   * or a restore changes which ids are there. **A reorder changes none of them**, because a
   * reorder bumps no version — so the rule that a reorder is not an unpublished change holds
   * by construction rather than by exception.
   *
   * No migration: every snapshot, including the ones provisioning and the demo seed wrote,
   * already carries its rows with their ids and versions.
   */
  private changedSince(published: TenantConfigView, working: TenantConfigView): boolean {
    const before = this.fingerprint(published);
    const now = this.fingerprint(working);
    if (before.size !== now.size) return true;
    for (const key of now) if (!before.has(key)) return true;
    return false;
  }

  /**
   * Every active row as `kind:id:version`. Order is presentation and deliberately absent.
   *
   * Read as a full `TenantConfigView`, the way `readPublished` already reads it: every writer
   * of a snapshot — `publish`, provisioning and the demo seed — renders all three lists, so a
   * fallback for a missing one would defend a shape nothing produces.
   */
  private fingerprint(view: TenantConfigView): Set<string> {
    const keys = new Set<string>();
    for (const category of view.activity) {
      keys.add(`category:${category.id}:${category.version}`);
      for (const type of category.types) keys.add(`type:${type.id}:${type.version}`);
    }
    for (const ratio of view.ratios) keys.add(`ratio:${ratio.id}:${ratio.version}`);
    for (const pipeline of view.leadPipelines) {
      for (const status of pipeline.statuses) keys.add(`lead_status:${status.id}:${status.version}`);
    }
    return keys;
  }

  private async newestSnapshot(ctx: RequestContext): Promise<ConfigSnapshotDocument | null> {
    const rows = await this.snapshots.find(ctx, {}, { sort: { version: -1 }, limit: 1 });
    return rows[0] ?? null;
  }

  /** The working copy: live rows, which is what the settings screens edit. */
  /**
   * The company ladder this office stands on (P4-T9).
   *
   * On the config service because that is what it is from an office's point of view:
   * vocabulary the office reads and does not own. The ladder itself belongs to the company
   * and is written at `/admin/org-levels` (ADR-0012).
   */
  async ladderFor(ctx: RequestContext): Promise<OrgLevelRow[]> {
    // Delegated since P4-T15, when `RatioService` became a second reader. Deriving it
    // here as well would be two answers to "which rungs does this office have".
    return this.orgLevels.ladderForOffice(ctx);
  }

  async read(ctx: RequestContext): Promise<TenantConfigView> {
    const [activity, ratios, leadPipelines] = await Promise.all([
      this.activity.list(ctx),
      this.ratios.list(ctx),
      this.leadStatuses.list(ctx),
    ]);

    const versions = [
      ...activity.map((c) => c.version),
      ...activity.flatMap((c) => c.types.map((t) => t.version)),
      ...ratios.map((r) => r.version),
      ...leadPipelines.flatMap((p) => p.statuses.map((s) => s.version)),
    ];

    return {
      activity,
      ratios,
      leadPipelines,
      version: versions.length ? Math.max(...versions) : 0,
    };
  }

  /**
   * A strong `ETag` over the whole payload.
   *
   * Hashing the rendered body rather than composing one from timestamps: the body is what
   * the client caches, so it is the only thing whose sameness is worth asserting. A
   * timestamp-derived tag would change when a row was touched without changing — an
   * archive-then-restore, a reorder — and spend the round trip it exists to save.
   */
  etag(config: TenantConfigView): string {
    const digest = createHash('sha256').update(JSON.stringify(config)).digest('base64url');
    return `"${digest.slice(0, 32)}"`;
  }
}
