import { createHash } from 'node:crypto';
import { Injectable } from '@nestjs/common';
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
  /** The highest live row version. Above `sourceVersion` means there is something to publish. */
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
   * One number a client can compare, rather than making every screen reason about three
   * collections. It moves when anything the office counts changes, and — deliberately —
   * not when somebody only reorders, because a reorder rebinds nothing.
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
      // A row above the version the snapshot was rendered from is an edit since. Not a
      // timestamp: clocks and edit ordering are a worse comparison than a counter.
      hasUnpublishedChanges: !snapshot || working.version > snapshot.sourceVersion,
      publishedAt: snapshot ? snapshot.publishedAt.toISOString() : null,
    };
  }

  private async newestSnapshot(ctx: RequestContext): Promise<ConfigSnapshotDocument | null> {
    const rows = await this.snapshots.find(ctx, {}, { sort: { version: -1 }, limit: 1 });
    return rows[0] ?? null;
  }

  /** The working copy: live rows, which is what the settings screens edit. */
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
