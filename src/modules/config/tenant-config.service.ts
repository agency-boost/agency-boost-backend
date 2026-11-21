import { createHash } from 'node:crypto';
import { Injectable, Optional, Inject } from '@nestjs/common';
import { OrgLevelRow, OrgLevelService } from '@/modules/tenants/org-level.service';
import { Clock } from '@/common/clock/clock.port';
import { RequestContext } from '@/common/context/request-context';
import { AuditService } from '@/modules/audit/audit.service';
import { ConfigSnapshotRepository } from './activity.repository';
import { ConfigSnapshotDocument, type ConfigSnapshotOrigin } from './config-snapshot.schema';
import { ActivityConfigService, type ActivityCategoryView } from './activity.service';
import { ActivityBindingService, type ActivityBindingView } from './activity-binding.service';
import { LeadStatusService, type LeadPipelineView } from './lead-status.service';
import { RatioService, type RatioDefinitionView } from './ratio.service';
import { TrainingService, type TrainingCategoryView } from '@/modules/training/training.service';
import {
  ActivationService, type ActivationVersionView,
} from '@/modules/activation/activation.service';
import { EventService } from '@/modules/events/event.service';
import {
  CapabilityService, type CapabilityCatalogView,
} from '@/modules/capability/capability.service';
import {
  highestVersion, mergeForPublish, PUBLISHED_SETTINGS, type PublishedSetting, settingChanged, settingVersionsOf,
} from './publish-settings';

/**
 * An event type as the snapshot carries it (P5-T9 AC-1).
 *
 * `EventTypeView` minus its live `events` count and its `status`: a count belongs to the rows it
 * counts, and only active types are here at all.
 */
export interface SnapshotEventTypeView {
  id: string;
  code: string;
  label: string;
  description: string | null;
  emoji: string | null;
  color: string | null;
  displayOrder: number;
  version: number;
}

/**
 * **One setting's state** (P19.21-T2 AC-3; ADR-0274 §5): the version agents are on — *"Agent masih memakai versi n"* —
 * whether it has changes they do not see yet, and when it was last published with changes.
 */
export interface SettingPublishState {
  setting: PublishedSetting;
  /** `0` when it was never published. For `activation_checklist`, the version new hires are given. */
  version: number;
  hasUnpublishedChanges: boolean;
  publishedAt: string | null;
}

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
  /** Each of the six settings with a draft, in `PUBLISHED_SETTINGS` order (P19.21-T2). */
  settings: SettingPublishState[];
}

export interface TenantConfigView {
  /** Every active activity category with its types, in display order. */
  activity: ActivityCategoryView[];
  ratios: RatioDefinitionView[];
  leadPipelines: LeadPipelineView[];
  /**
   * The training taxonomy agents are offered (P5-T1): active categories and skills, and
   * **published** active modules only. A draft never reaches an agent.
   *
   * Absent from a snapshot published before P5-T1; read back as empty.
   */
  training: TrainingCategoryView[];
  /**
   * The 90-day checklist a new hire is given (P5-T3) — the **published** version only.
   *
   * A draft never reaches an agent, the same rule the training modules follow. `null` before an
   * office has published one, which is a real state: the checklist is seeded at provisioning but
   * an office that has edited and not published has nothing to give a hire yet.
   */
  activationChecklist: ActivationVersionView | null;
  /**
   * What an event may be filed under (P5-T6), active rows only.
   *
   * **Without the live event count `EventTypeView` carries.** A count belongs to the rows it
   * counts; freezing one into a snapshot means it is wrong the moment anybody files an event,
   * and an agent-facing screen has no use for it.
   */
  eventTypes: SnapshotEventTypeView[];
  /**
   * The capability catalog a leader assesses against (P5-T8): **every row, archived ones
   * included, each with its `status`** — `CapabilityService.own` whole, unfiltered.
   *
   * Office-owned and identical for every member, so it is snapshot material by ADR-0039's own
   * test. `null` only for an office provisioned before P5-T8.
   *
   * *Corrected 2026-10-02 (P11-T9 AC-3): this read "active rows only", which the code never did
   * — unlike `eventTypes` above, nothing filters it. A screen ticking against it offers an
   * archived item to no new tick by its `status`; the Leader Notes tab reads the catalog with
   * its profile instead (`GET /coaching/coachees/:membershipId/profile`).*
   */
  capability: CapabilityCatalogView | null;
  /**
   * **The activity binding in force when this was published** (ADR-0163 §1): which activity types each cascade
   * role counts, with its version. A record, carried so a published copy says what it was counted against and
   * *Save as template* has it — **not what the counts read**: the Super Admin keeps the binding and a rebind
   * counts from the moment it is saved, so every count reads the live one (`ActivityBindingService
   * .resolveCascadeBinding`). For the same reason it is not in the publish fingerprint: a rebind is not an
   * Owner's change waiting on Publish. `null` in a snapshot published before ADR-0163 that migration `0034` has
   * not reached.
   */
  activityBinding: ActivityBindingView | null;
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
    private readonly training: TrainingService,
    private readonly activation: ActivationService,
    private readonly events: EventService,
    private readonly capability: CapabilityService,
    // ADR-0163: the binding rendered into each snapshot. Optional for a hand-built instance; absent, none is rendered.
    @Optional() @Inject(ActivityBindingService) private readonly bindings: ActivityBindingService | null = null,
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
    return normalisedPayload(snapshot.payload);
  }

  /**
   * **Publish** (P4-T6; per setting since P19.21-T2, ADR-0274 §5).
   *
   * Renders the live rows into one document rather than flipping a flag: what agents read
   * then cannot drift from what was published, whatever happens to the rows afterwards.
   *
   * - **`settings` absent or empty** — *Terbitkan semua*, and every caller before P19.21 (a template push, a sync, a
   *   migration): the whole working copy is rendered, as it always was. Only a setting whose rows changed moves to its
   *   next version.
   * - **`settings` named** — *Terbitkan* on one setting, or the hub's bar: those settings' sections come from the
   *   working copy, every other setting's stays as agents read it now (`mergeForPublish`), and each named setting with
   *   changes moves to its next version.
   *
   * **The activation checklist's draft is the activation module's** (`ActivationService`): publishing
   * `activation_checklist` — named, or by *Terbitkan semua* — first publishes that draft as the checklist's next
   * version when it differs from the one new hires are given. Only the office's own *Terbitkan* does that; a template
   * push or a sync never publishes an Owner's draft for them.
   */
  async publish(
    ctx: RequestContext,
    /**
     * What made the version (ADR-0208 §5): the office's own *Publish* unless a template push says otherwise.
     */
    origin: ConfigSnapshotOrigin = { source: 'kpm' },
    settings?: readonly PublishedSetting[],
  ): Promise<PublishState> {
    const named = settings && settings.length > 0 ? PUBLISHED_SETTINGS.filter((s) => settings.includes(s)) : null;
    const publishing: readonly PublishedSetting[] = named ?? PUBLISHED_SETTINGS;

    if (origin.source === 'kpm' && publishing.includes('activation_checklist')
      && await this.activationDraftWaiting(ctx)) {
      await this.activation.publish(ctx);
    }

    const working = await this.read(ctx);
    const previous = await this.newestSnapshot(ctx);
    const before = previous ? normalisedPayload(previous.payload) : null;
    const payload = named && before ? mergeForPublish(before, working, named) : working;
    const changed = publishing.filter((setting) => settingChanged(setting, before, working));

    const versions = settingVersionsOf(previous);
    const stamped = { ...(previous?.settingPublished ?? {}) } as Record<string, { at: Date; by: string | null }>;
    const now = this.clock.now();
    for (const setting of changed) {
      versions[setting] = previous ? versions[setting] + 1 : 1;
      stamped[setting] = { at: now, by: ctx.membershipId };
    }
    // The checklist's number is the activation module's own: what a hire's activation pins.
    versions.activation_checklist = payload.activationChecklist?.version ?? 0;
    const version = (previous?.version ?? 0) + 1;

    await this.snapshots.create(ctx, {
      version,
      sourceVersion: working.version,
      payload: { ...payload, version: highestVersion(payload) } as unknown as Record<string, unknown>,
      publishedAt: now,
      publishedBy: ctx.membershipId,
      origin,
      settingVersions: versions,
      settingPublished: stamped,
      publishedSettings: named ? [...named] : [],
    } as Partial<ConfigSnapshotDocument>);

    await this.audit.record(ctx, {
      action: 'tenant_config.published',
      targetCollection: 'configSnapshots',
      targetId: ctx.kpmId ?? '',
      after: {
        version, sourceVersion: working.version, origin: origin.source,
        settings: named ? [...named] : 'all', changed, settingVersions: versions,
      },
    });

    return this.state(ctx);
  }

  /**
   * Whether there is anything to publish, and what agents are on meanwhile — **for the office and for each setting**
   * (P19.21-T2 AC-3).
   *
   * `hasUnpublishedChanges` keeps its meaning since P5-T11 — the working copy's rows differ from the snapshot's, any
   * setting — which a template push and a sync read to decide whether the KPM has something of its own waiting. A
   * setting's own adds, for `activation_checklist`, a saved draft that differs from the version new hires are given.
   */
  async state(ctx: RequestContext): Promise<PublishState> {
    const [snapshot, working, draftWaiting] = await Promise.all([
      this.newestSnapshot(ctx),
      this.read(ctx),
      this.activationDraftWaiting(ctx),
    ]);
    const published = snapshot ? normalisedPayload(snapshot.payload) : null;
    const versions = settingVersionsOf(snapshot);
    const stamped = snapshot?.settingPublished ?? {};
    const rowsChanged = (setting: PublishedSetting) => settingChanged(setting, published, working);

    const settings = PUBLISHED_SETTINGS.map((setting): SettingPublishState => {
      const at = stamped[setting]?.at ?? snapshot?.publishedAt ?? null;
      if (setting === 'activation_checklist') {
        const checklist = working.activationChecklist;
        return {
          setting,
          version: checklist?.version ?? 0,
          hasUnpublishedChanges: draftWaiting || (snapshot !== null && rowsChanged(setting)),
          publishedAt: checklist ? (checklist.publishedAt ?? null) : null,
        };
      }
      return {
        setting,
        version: versions[setting],
        hasUnpublishedChanges: rowsChanged(setting),
        publishedAt: snapshot && at ? new Date(at).toISOString() : null,
      };
    });

    return {
      publishedVersion: snapshot?.version ?? 0,
      workingVersion: working.version,
      hasUnpublishedChanges: !snapshot || PUBLISHED_SETTINGS.some(rowsChanged),
      publishedAt: snapshot ? snapshot.publishedAt.toISOString() : null,
      settings,
    };
  }

  /**
   * **A saved checklist draft that would publish as a new version** — the activation module's draft, differing from the
   * version new hires are given by an aspect or an item's code, label, order or link (its own `sameChecklist` rule, read
   * through the views). The unsaved starting point an office with neither is shown (`id: ''`) is not one.
   */
  private async activationDraftWaiting(ctx: RequestContext): Promise<boolean> {
    const { draft, published } = await this.activation.read(ctx);
    if (!draft || !draft.id) return false;
    return !published || checklistShape(draft.aspects) !== checklistShape(published.aspects);
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
    const [activity, ratios, leadPipelines, training, activation, eventTypes, capability, activityBinding]
      = await Promise.all([
        this.activity.list(ctx),
        this.ratios.list(ctx),
        this.leadStatuses.list(ctx),
        this.training.offered(ctx),
        // The published version, its training links named from the modules this copy offers — never a draft's
        // title, which every member would read here (the Phase 18.2 exit review, B2).
        this.activation.publishedForSnapshot(ctx),
        this.events.listTypes(ctx),
        // Whole: archived rows included, each with its status (P11-T9 AC-3).
        this.capability.own(ctx),
        this.bindings ? this.bindings.readOwn(ctx) : Promise.resolve(null),
      ]);

    /*
     * Which Phase 5 catalogs are here, and which are deliberately not (P5-T9 AC-1, ADR-0039).
     *
     * **In:** the office's own configuration — what an agent may log, measure, work a lead
     * through, be trained on, be activated against, file an event under, and be assessed on.
     * Every member of the office receives the same bytes, which is ADR-0039's whole test.
     *
     * **Out, and each for a stated reason:**
     * - **Products** are read live from the company (ADR-0033). A withdrawal has to reach every
     *   office with no Owner republishing anything, and a frozen copy cannot do that.
     * - **Carrier rules** — production clubs, MOC — are company-partitioned and read live for
     *   exactly the same reason (ADR-0026). A carrier changing MOC should not wait on fifty
     *   Owners pressing Publish.
     * - **Events and campaigns themselves** are live records with dates that pass on their own.
     *   An event's audience also differs per member, so it fails ADR-0039's test outright.
     */
    const activationChecklist = activation;
    const versions = [
      ...activity.map((c) => c.version),
      ...activity.flatMap((c) => c.types.map((t) => t.version)),
      ...ratios.map((r) => r.version),
      ...leadPipelines.flatMap((p) => p.statuses.map((s) => s.version)),
      ...training.map((c) => c.version),
      ...training.flatMap((c) => c.skills.map((s) => s.version)),
      ...training.flatMap((c) => c.skills.flatMap((s) => s.modules.map((m) => m.version))),
      ...(activationChecklist ? [activationChecklist.version] : []),
      ...eventTypes.map((t) => t.version),
      ...(capability ? [capability.version] : []),
    ];

    return {
      activity,
      ratios,
      leadPipelines,
      training,
      activationChecklist,
      eventTypes: eventTypes
        .filter((type) => type.status === 'active')
        .map((type) => ({
          id: type.id,
          code: type.code,
          label: type.label,
          description: type.description,
          emoji: type.emoji,
          color: type.color,
          displayOrder: type.displayOrder,
          version: type.version,
        })),
      // Unfiltered, unlike `eventTypes`: the catalog's archived rows travel with their status.
      capability,
      activityBinding,
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

/**
 * **A snapshot's payload as every reader meets it.** A snapshot published before the phase that added a field carries
 * none of it; its agents are offered nothing there — said as an empty list or a `null`, so every reader sees one shape
 * and no screen has to know which phase its office was provisioned in. A section published before ADR-0064 has no
 * summary tile fields: `null` on both is what it means (migration 0021 writes them; this read does not depend on it).
 */
function normalisedPayload(payload: Record<string, unknown>): TenantConfigView {
  const published = payload as unknown as TenantConfigView;
  return {
    ...published,
    activity: (published.activity ?? []).map((category) => ({
      ...category,
      summaryGroupCode: category.summaryGroupCode ?? null,
      summaryGroupLabel: category.summaryGroupLabel ?? null,
    })),
    training: published.training ?? [],
    activationChecklist: published.activationChecklist ?? null,
    eventTypes: published.eventTypes ?? [],
    capability: published.capability ?? null,
    activityBinding: published.activityBinding ?? null,
  };
}

/** A checklist version's substance — aspects and items by code, label, order and link — as `sameChecklist` reads it. */
function checklistShape(aspects: ActivationVersionView['aspects']): string {
  return JSON.stringify(aspects.map((aspect) => ({
    code: aspect.code,
    label: aspect.label,
    displayOrder: aspect.displayOrder,
    items: aspect.items.map((item) => ({
      code: item.code, label: item.label, displayOrder: item.displayOrder, autoLink: item.autoLink ?? null,
    })),
  })));
}
