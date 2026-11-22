import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import { requireOfficeSteward } from '@/common/auth/office-steward';
import { Clock } from '@/common/clock/clock.port';
import { RequestContext } from '@/common/context/request-context';
import type { LocalDate } from '@/common/time/local-day';
import { refuseWith } from '@/common/validation/fields';
import { KPM_REPORTING } from '@/domain/constants';
import { rateOver } from '@/domain/metrics/rate';
import { SubjectReadAudit } from '@/modules/audit/subject-read-audit';
import { MemberNames } from '@/modules/org/member-names.service';
import { can } from '@/modules/rbac/permissions';
import { TenantDay } from '@/modules/tenants/tenant-day.service';
import { OfficeGroups } from '../office-groups';
import { overviewTree, scopeOf, type OverviewGroupRef } from '../overview-tree';
import { REPORTING_REFUSALS } from '../reporting.messages';
import { ActivationComplianceCategory } from './activation.category';
import { ActivityComplianceCategory } from './activity.category';
import { CampaignsComplianceCategory, type CampaignsComplianceCatalog } from './campaigns.category';
import {
  COMPLIANCE_CATEGORIES, SINGLE_ITEM_CATEGORIES, type ComplianceCategory, type ComplianceCategoryKey,
  type ComplianceCategoryRead, type ComplianceCell, type ComplianceScope,
} from './compliance-category';
import { EventsComplianceCategory, type EventsComplianceCatalog } from './events.category';
import { GoalsComplianceCategory } from './goals.category';
import { LeadsComplianceCategory } from './leads.category';
import { TrainingComplianceCategory, type TrainingComplianceCatalog } from './training.category';

/** One card: *"Leads Mgmt 47% · 14 dari 30 anggota"*. `pct` is `null` when the item applies to nobody (`of: 0`). */
export interface ComplianceCard {
  category: ComplianceCategoryKey;
  count: number;
  of: number;
  pct: number | null;
}

/** One person's cell for the card opened, keyed by their membership: the Overview's tree draws the rows. */
export interface ComplianceCellRow extends ComplianceCell {
  membershipId: string;
}

/** `GET /kpm/overview/compliance`: the seven cards, the pickers, and — with `category` — the card's people. */
export interface ComplianceView {
  today: LocalDate;
  /** Where a card turns yellow and green (`KPM_REPORTING`, 34 / 67), so no screen re-declares them. */
  thresholds: { lowBelowPct: number; highFromPct: number };
  /** The informal group the cards are over (`?group=`), `null` for the whole KPM; `groupId: null` is *Tanpa group*. */
  group: OverviewGroupRef | null;
  /** The seven cards, **lowest % first**, a card that applies to nobody last, the brief's order within a tie. */
  cards: ComplianceCard[];
  /** What the opened card's picker lists: Training's modules (*Modul: … ⌄*), the events and the campaigns. */
  catalog: {
    training: TrainingComplianceCatalog;
    events: EventsComplianceCatalog;
    campaigns: CampaignsComplianceCatalog;
  };
  /**
   * The card asked about (`?category=`): its item — the module, the event, the campaign, or `null` for a single-item card
   * and for *Semua event* / *Semua campaign* — *"x dari y"* over it, and every person's cell, in the tree's order.
   * `null` when no card was asked about, and nothing is disclosed.
   */
  selected: {
    category: ComplianceCategoryKey;
    item: string | null;
    done: number;
    of: number;
    cells: ComplianceCellRow[];
  } | null;
  /** The reader may override a campaign's final standing (`campaign_qualification:override`), never in a view-only session. */
  can: { override: boolean };
}

/** What the read takes: a card, an item on the three cards that hold several, and an informal group. */
export interface ComplianceQuery {
  category?: ComplianceCategoryKey;
  item?: string;
  group?: string;
}

/**
 * **The KPM Overview's *Compliance*** (P19.19-T3 AC-2, AC-3; ADR-0272 §6; `functional/kpm-overview.md`, section 4) —
 * where KPM Analytics' compliance tree went when that page was removed (the brief's *KPM Analytics: remove the page*,
 * §6). One read for the cards, one for the card a reader opens; computed on each read, not paginated.
 *
 * - **Who** (ADR-0268 §1): the KPM's stewards — the Super Admin inside the KPM, the Owner, an Admin, a core leader
 *   (`requireOfficeSteward`); the route's `kpm_overview:read` asks first.
 * - **Who is counted**: the Overview's scope — every active member of the KPM or of one informal group (`?group=`, `none`
 *   for *Tanpa group*), **test accounts never** (`OfficeGroups.partition`, ADR-0267 §1) — so the cards' *"dari 30
 *   anggota"* is section 1's *"dari 30 anggota"*.
 * - **Seven cards** (the brief's §6), each through the module that owns its facts — `training.category.ts` (per module,
 *   the first when none is asked), `goals.category.ts`, `activity.category.ts`, **`leads.category.ts`** (new),
 *   `activation.category.ts` (of *agent baru*), `events.category.ts` (of *yang diundang*), `campaigns.category.ts` —
 *   lowest % first. Red below 34%, yellow below 67%, green from 67% (`KPM_REPORTING`).
 * - **A card opened** (`?category=`, and `?item=` on Training, Events and Campaigns): that category first, with its cells
 *   — an item it does not list is 404 before any other reads — then the other six in parallel. No per-AB line: the
 *   screen draws the Overview's tree with each person's cell.
 * - **The audit** (D-audit-tree): the opened card's disclosure, written once the answer exists, in one insert.
 */
@Injectable()
export class ComplianceService {
  private readonly logger = new Logger(ComplianceService.name);

  constructor(
    private readonly days: TenantDay,
    private readonly clock: Clock,
    private readonly subjectReads: SubjectReadAudit,
    private readonly officeGroups: OfficeGroups,
    private readonly names: MemberNames,
    private readonly training: TrainingComplianceCategory,
    private readonly goals: GoalsComplianceCategory,
    private readonly activity: ActivityComplianceCategory,
    private readonly activation: ActivationComplianceCategory,
    private readonly events: EventsComplianceCategory,
    private readonly campaigns: CampaignsComplianceCategory,
    /** *Leads Mgmt* (P19.19-T3). Optional only so a harness built before it still constructs; the app always provides it. */
    @Optional() @Inject(LeadsComplianceCategory) private readonly leads: LeadsComplianceCategory | null = null,
  ) {}

  async read(ctx: RequestContext, query: ComplianceQuery = {}): Promise<ComplianceView> {
    requireOfficeSteward(ctx, 'KPM');
    const category = query.category ?? null;
    const asked = query.item ?? null;
    if (asked !== null && (category === null || SINGLE_ITEM_CATEGORIES.includes(category))) {
      refuseWith([REPORTING_REFUSALS.VALIDATION_FAILED.itemNotTaken({ category: category ?? 'none' })]);
    }

    // The scope first: another office's, an archived or an unknown group is 404 before anything else is read.
    const partition = await this.officeGroups.partition(ctx);
    const named = await this.names.byMembershipId(ctx, [...partition.members.keys()]);
    const scope = scopeOf(overviewTree(partition, (id) => named.get(id) ?? ''), query.group);
    const office = await this.days.office(ctx);
    const { today, timezone } = office;
    const year = today.slice(0, 4);
    const from = `${year}-01-01`;
    const to = `${year}-12-31`;
    const read: ComplianceScope = {
      ctx,
      office,
      today,
      // D-window: the office's calendar year, `[start, end)`.
      year: { from, to, start: this.clock.startOfLocalDay(timezone, from), end: this.clock.endOfLocalDay(timezone, to) },
      memberIds: scope.memberIds,
    };
    const readers: Record<ComplianceCategoryKey, ComplianceCategory<unknown> | null> = {
      training: this.training,
      goals: this.goals,
      activity: this.activity,
      leads: this.leads,
      activation: this.activation,
      events: this.events,
      campaigns: this.campaigns,
    };
    const readOf = (key: ComplianceCategoryKey, selection: { selected: boolean; item: string | null }) => {
      const reader = readers[key];
      if (reader) return reader.read(read, selection);
      return Promise.resolve<ComplianceCategoryRead<unknown>>({ catalog: null, chip: { count: 0, of: 0 }, item: null, cells: null });
    };
    /*
     * **The opened card first** (the exit review, round 1, 5): an item it does not list is refused — 404 — before any
     * other category reads, so a refused read writes nothing. Then every other card, settled together. **A failure there
     * is the server's, never the opened card's**: it answers 500, logged.
     */
    const chosen = category === null ? null : await readOf(category, { selected: true, item: asked });
    const others = COMPLIANCE_CATEGORIES.filter((key) => key !== category);
    const settled = await Promise.allSettled(others.map((key) => readOf(key, { selected: false, item: null })));
    const failed = settled.findIndex((s) => s.status === 'rejected');
    if (failed !== -1) {
      const reason = (settled[failed] as PromiseRejectedResult).reason;
      this.logger.error({ err: reason, category: others[failed] }, 'a compliance card could not be read');
      throw new Error(`The ${others[failed]} card could not be read.`, { cause: reason });
    }
    const reads = new Map<ComplianceCategoryKey, ComplianceCategoryRead<unknown>>(
      others.map((key, i) => [key, (settled[i] as PromiseFulfilledResult<ComplianceCategoryRead<unknown>>).value] as const),
    );
    if (category !== null && chosen !== null) reads.set(category, chosen);

    const order = (key: ComplianceCategoryKey) => COMPLIANCE_CATEGORIES.indexOf(key);
    const cards = COMPLIANCE_CATEGORIES
      .map((key): ComplianceCard => {
        const { count, of } = reads.get(key)!.chip;
        return { category: key, count, of, pct: rateOver(count, of).pct };
      })
      .sort((a, b) => {
        if (a.pct === null || b.pct === null) return a.pct === b.pct ? order(a.category) - order(b.category) : a.pct === null ? 1 : -1;
        return a.pct - b.pct || order(a.category) - order(b.category);
      });

    let selected: ComplianceView['selected'] = null;
    if (category !== null && chosen !== null) {
      const cells = scope.memberIds.map((membershipId): ComplianceCellRow => ({
        membershipId, ...(chosen.cells?.get(membershipId) ?? { status: null, done: null, on: null }),
      }));
      selected = {
        category,
        item: chosen.item,
        done: cells.filter((c) => c.done === true).length,
        of: cells.filter((c) => c.done !== null).length,
        cells,
      };
    }

    const view: ComplianceView = {
      today,
      thresholds: {
        lowBelowPct: KPM_REPORTING.COMPLIANCE_LOW_BELOW_PCT,
        highFromPct: KPM_REPORTING.COMPLIANCE_HIGH_FROM_PCT,
      },
      group: scope.selected,
      cards,
      catalog: {
        training: reads.get('training')!.catalog as TrainingComplianceCatalog,
        events: (reads.get('events')!.catalog ?? []) as EventsComplianceCatalog,
        campaigns: (reads.get('campaigns')!.catalog ?? []) as CampaignsComplianceCatalog,
      },
      selected,
      can: { override: can(ctx, 'campaign_qualification:override') },
    };

    // Last, once the answer exists: what the opened card's cells disclosed (D-audit-tree), in one insert.
    if (chosen?.disclosure) {
      const starts = new Map(chosen.disclosure.subjects.map((s) => [s.membershipId, s.from]));
      await this.subjectReads.recordMany(
        ctx, chosen.disclosure.subjects, chosen.disclosure.surface,
        (id) => ({ from: starts.get(id) as LocalDate | null, to: today }),
      );
    }
    return view;
  }
}
