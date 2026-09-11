import { createHash } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import { RequestContext } from '@/common/context/request-context';
import { ActivityConfigService, type ActivityCategoryView } from './activity.service';
import { LeadStatusService, type LeadPipelineView } from './lead-status.service';
import { RatioService, type RatioDefinitionView } from './ratio.service';

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
  ) {}

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
