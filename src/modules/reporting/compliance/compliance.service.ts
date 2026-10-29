import { Injectable, Logger } from '@nestjs/common';
import { Clock } from '@/common/clock/clock.port';
import { RequestContext } from '@/common/context/request-context';
import type { LocalDate } from '@/common/time/local-day';
import { refuseWith } from '@/common/validation/fields';
import { memberAt } from '@/domain/metrics/office-headcount';
import { SubjectReadAudit } from '@/modules/audit/subject-read-audit';
import { can } from '@/modules/rbac/permissions';
import { TenantDay } from '@/modules/tenants/tenant-day.service';
import { partitionAgencies } from '../agency-partition';
import { byName } from '../office-figures';
import { OfficePeople } from '../office-people';
import { REPORTING_REFUSALS } from '../reporting.messages';
import { ActivationComplianceCategory } from './activation.category';
import { ActivityComplianceCategory } from './activity.category';
import { CampaignsComplianceCategory, type CampaignsComplianceCatalog } from './campaigns.category';
import {
  COMPLIANCE_CATEGORIES, SINGLE_ITEM_CATEGORIES, type ComplianceCategory, type ComplianceCategoryKey,
  type ComplianceCategoryRead, type ComplianceCell, type ComplianceScope,
} from './compliance-category';
import { EventsComplianceCategory, type EventsComplianceCatalog } from './events.category';
import { GoalsComplianceCategory, type GoalsComplianceCatalog } from './goals.category';
import { TrainingComplianceCategory, type TrainingComplianceCatalog } from './training.category';

/** A person the tree names: a card's or a section's head. `leads`: heads anybody now — their name opens the Unit Dashboard. */
export interface CompliancePerson {
  membershipId: string;
  name: string;
  leads: boolean;
}

/** One member's row: their own row on the card they head is `personal` (*Personal*, always first). */
export interface ComplianceRow extends CompliancePerson {
  personal: boolean;
  cell: ComplianceCell;
}

/**
 * A unit card: the AB's own (*(Direct)*) or an AAB's. `done / of` count the rows the item applies to. `rung` names
 * the **class** of the card's head, as `partitionAgencies` placed them (ADR-0156): a *Senior Leader* rung's agency
 * is an `AB` card whatever the rung is called.
 */
export interface ComplianceUnit {
  head: CompliancePerson;
  rung: 'AB' | 'AAB';
  done: number;
  of: number;
  rows: ComplianceRow[];
}

/** One AB agency: its cards, and *"{n} / {m} done overall"* — the sum of theirs. */
export interface ComplianceSection {
  head: CompliancePerson;
  done: number;
  of: number;
  units: ComplianceUnit[];
}

/** `GET /kpm/analytics/compliance`: the summary, the catalog, the selection and the tree (contract-tree.md). */
export interface ComplianceView {
  today: LocalDate;
  /** The sub-line's *"{people} people across {units} units"*: the rows, and the AB agencies. */
  people: number;
  units: number;
  summary: { category: ComplianceCategoryKey; count: number; of: number }[];
  catalog: {
    training: TrainingComplianceCatalog;
    goals: GoalsComplianceCatalog;
    events: EventsComplianceCatalog;
    campaigns: CampaignsComplianceCatalog;
  };
  selected: { category: ComplianceCategoryKey; item: string | null };
  tree: ComplianceSection[];
  can: { override: boolean };
}

/** What the read takes: a category, and — on the three categories that hold several — an item. */
export interface ComplianceQuery {
  category?: ComplianceCategoryKey;
  item?: string;
}

/** The cell of a row whose category has no item to read: *—*, out of every count. */
const NO_ITEM: ComplianceCell = { status: null, done: null, on: null };

/**
 * **The Owner's compliance tree** (Phase 18.6, P18.6-T1; `functional/kpm-analytics.md`, *Compliance, Events, and
 * Campaigns*): `KPM_Owner.html:1262-1286`, `:3449-4118` — one read per screen, computed on each read, not paginated.
 *
 * - **Who is in it** (D-units, ADR-0135, ADR-0136): the office's active members at the end of its day — the
 *   Overview's own headcount — placed by `partitionAgencies`. A member under no active AB is in no row and no chip.
 * - **The tree**: one section per AB agency, A to Z by the head's name; in each, the AB's own card (the AB and those
 *   in no AAB's unit), then one card per AAB who leads somebody, A to Z; every card's head first, *Personal*.
 * - **Six categories, every chip on every read** (D-chips, T1 AC-3): each category reads its facts through the module
 *   that owns them — `training.category.ts`, `goals.category.ts`, `activity.category.ts`, `activation.category.ts`,
 *   `events.category.ts`, `campaigns.category.ts` — the chosen one first, with its cells, then the other five in
 *   parallel. A fixed number of queries for any office (`compliance.performance.spec.ts`), none per member.
 * - **The audit** (D-audit-tree): the chosen category's disclosure, written here and only here, once the answer
 *   exists, in one insert, failing open — the reader skipped, both actors in a support session. A refused read —
 *   403, 400, 404 — has thrown before it and writes no entry.
 * - **`can.override`**: the reader holds `campaign_qualification:override` and may write with it — a read-only
 *   support session may not (its verb).
 */
@Injectable()
export class ComplianceService {
  private readonly logger = new Logger(ComplianceService.name);

  constructor(
    private readonly people: OfficePeople,
    private readonly days: TenantDay,
    private readonly clock: Clock,
    private readonly subjectReads: SubjectReadAudit,
    private readonly training: TrainingComplianceCategory,
    private readonly goals: GoalsComplianceCategory,
    private readonly activity: ActivityComplianceCategory,
    private readonly activation: ActivationComplianceCategory,
    private readonly events: EventsComplianceCategory,
    private readonly campaigns: CampaignsComplianceCategory,
  ) {}

  async read(ctx: RequestContext, query: ComplianceQuery = {}): Promise<ComplianceView> {
    // The Owner, an Admin, or a Core Leader (ADR-0159 §2); any other field member 404, before anything is read.
    OfficePeople.requireAnalyticsReader(ctx);
    const category = query.category ?? 'training';
    const asked = query.item ?? null;
    if (asked !== null && SINGLE_ITEM_CATEGORIES.includes(category)) {
      refuseWith([REPORTING_REFUSALS.VALIDATION_FAILED.itemNotTaken({ category })]);
    }

    const office = await this.days.office(ctx);
    const { today, timezone } = office;
    const year = today.slice(0, 4);
    const roster = await this.people.read(ctx, null, timezone);
    const endOfToday = this.clock.endOfLocalDay(timezone, today);
    const members = roster.active.filter((p) => memberAt(p, endOfToday));
    const names = roster.names;
    const order = byName(names);
    const leaders = new Set(members.flatMap((p) => (p.leaderId === null ? [] : [p.leaderId])));
    const person = (membershipId: string): CompliancePerson => ({
      membershipId, name: names.get(membershipId) ?? '', leads: leaders.has(membershipId),
    });

    // D-units: the agencies, A to Z; the AB's own card, then each AAB's; a card's head first, the rest A to Z.
    const headFirst = (headId: string, ids: readonly string[]) => [headId, ...ids.filter((id) => id !== headId).sort(order)];
    const skeleton = partitionAgencies(members.map((p) => ({ ...p, active: true })))
      .agencies
      .sort((a, b) => order(a.headId, b.headId))
      .map((agency) => ({
        headId: agency.headId,
        units: [
          { headId: agency.headId, rung: 'AB' as const, memberIds: headFirst(agency.headId, agency.directIds) },
          ...[...agency.units].sort((a, b) => order(a.headId, b.headId))
            .map((unit) => ({ headId: unit.headId, rung: 'AAB' as const, memberIds: headFirst(unit.headId, unit.memberIds) })),
        ],
      }));
    const memberIds = skeleton.flatMap((agency) => agency.units.flatMap((unit) => unit.memberIds));

    const from = `${year}-01-01`;
    const to = `${year}-12-31`;
    const scope: ComplianceScope = {
      ctx,
      office,
      today,
      // D-window: the office's calendar year, `[start, end)`.
      year: { from, to, start: this.clock.startOfLocalDay(timezone, from), end: this.clock.endOfLocalDay(timezone, to) },
      memberIds,
    };
    const readers: Record<ComplianceCategoryKey, ComplianceCategory<unknown>> = {
      training: this.training,
      goals: this.goals,
      activity: this.activity,
      activation: this.activation,
      events: this.events,
      campaigns: this.campaigns,
    };
    /*
     * **The chosen category first** (the exit review, round 1, 5): an item it does not list is refused — 404 — before
     * any other category reads, so a refused read writes nothing: no activation link completed, no campaign window
     * frozen by another chip. Then every other chip (T1 AC-3), settled together so nothing is still reading when an
     * error is answered. **A failure there is the server's, never the chosen tab's**: it answers 500, logged, so an
     * unexpected refusal from another chip can never read as *this item is not listed*.
     */
    const chosen = await readers[category].read(scope, { selected: true, item: asked });
    const others = COMPLIANCE_CATEGORIES.filter((key) => key !== category);
    const settled = await Promise.allSettled(others.map((key) => readers[key].read(scope, { selected: false, item: null })));
    const failed = settled.findIndex((s) => s.status === 'rejected');
    if (failed !== -1) {
      const reason = (settled[failed] as PromiseRejectedResult).reason;
      this.logger.error({ err: reason, category: others[failed] }, 'a compliance chip could not be read');
      throw new Error(`The ${others[failed]} chip could not be read.`, { cause: reason });
    }
    const reads = new Map<ComplianceCategoryKey, ComplianceCategoryRead<unknown>>([
      [category, chosen],
      ...others.map((key, i) => [key, (settled[i] as PromiseFulfilledResult<ComplianceCategoryRead<unknown>>).value] as const),
    ]);

    const cellOf = (id: string): ComplianceCell => chosen.cells?.get(id) ?? NO_ITEM;
    const tree = skeleton.map((agency): ComplianceSection => {
      const units = agency.units.map((unit): ComplianceUnit => {
        const rows = unit.memberIds.map((id): ComplianceRow => ({ ...person(id), personal: id === unit.headId, cell: cellOf(id) }));
        return {
          head: person(unit.headId),
          rung: unit.rung,
          done: rows.filter((row) => row.cell.done === true).length,
          of: rows.filter((row) => row.cell.done !== null).length,
          rows,
        };
      });
      return {
        head: person(agency.headId),
        done: units.reduce((n, unit) => n + unit.done, 0),
        of: units.reduce((n, unit) => n + unit.of, 0),
        units,
      };
    });

    const view: ComplianceView = {
      today,
      people: memberIds.length,
      units: tree.length,
      summary: COMPLIANCE_CATEGORIES.map((key) => ({ category: key, ...reads.get(key)!.chip })),
      catalog: {
        training: reads.get('training')!.catalog as TrainingComplianceCatalog,
        goals: reads.get('goals')!.catalog as GoalsComplianceCatalog,
        events: reads.get('events')!.catalog as EventsComplianceCatalog,
        campaigns: reads.get('campaigns')!.catalog as CampaignsComplianceCatalog,
      },
      selected: { category, item: chosen.item },
      tree,
      can: { override: can(ctx, 'campaign_qualification:override') },
    };

    // Last, once the answer exists: what the chosen category's cells disclosed (D-audit-tree), in one insert.
    if (chosen.disclosure) {
      const starts = new Map(chosen.disclosure.subjects.map((s) => [s.membershipId, s.from]));
      await this.subjectReads.recordMany(
        ctx, chosen.disclosure.subjects, chosen.disclosure.surface,
        (id) => ({ from: starts.get(id) as LocalDate | null, to: today }),
      );
    }
    return view;
  }
}
