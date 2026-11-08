import { Injectable } from '@nestjs/common';
import { Clock } from '@/common/clock/clock.port';
import { RequestContext } from '@/common/context/request-context';
import { FIRST_SALE_STAGE_CODE } from '@/domain/constants';
import { personLeadCounts, personLeadCountsAt, type CountedLead, type DatedLead } from '@/domain/metrics/lead-counts';
import {
  leadPotensiThisMonth, openAtEndOf, personPotensi, wonIn, type PersonPotensi, type PotensiMonth,
} from '@/domain/metrics/potensi';
import { ownOpenLeadsFilter } from '@/domain/metrics/own-open-leads';
import type { LeadCountsRow } from '@/domain/metrics/unit-rollup';
import { LeadStatusRepository } from '@/modules/config/activity.repository';
import type { OfficeDay } from '@/modules/tenants/tenant-day.service';
import { leadFlags, type LeadFlag } from './lead-attention';
import { LeadRepository } from './lead.repository';
import type { LeadType } from './lead.schema';

/**
 * **One closing, as another module reads it** (P18.8-T4): a sales lead that reached *Paid and issued*, the instant it
 * first did and who moved it there, and whether it was logged from the checklist rather than walked up the ladder.
 */
export interface LeadClosing {
  leadId: string;
  name: string;
  at: Date;
  byMembershipId: string;
  logged: boolean;
}

/** What a closing is read from: a sales lead's id, owner, name, moves and origin. */
export const CLOSING_FIELDS = { ownerMembershipId: 1, name: 1, transitions: 1, loggedFrom: 1 } as const;

/** The filter every closing read shares: sales leads that have been on *Paid and issued*. */
export const CLOSING_FILTER = { type: 'sales', 'transitions.toStatusCode': FIRST_SALE_STAGE_CODE } as const;

/** A lead's closing — its first move to *Paid and issued* — or `null` for one that never made it. */
export function closingOf(row: {
  _id: unknown; name: string; transitions?: readonly { toStatusCode: string; at: Date; byMembershipId: string }[];
  loggedFrom?: string | null;
}): LeadClosing | null {
  const reached = [...(row.transitions ?? [])]
    .filter((t) => t.toStatusCode === FIRST_SALE_STAGE_CODE)
    .sort((a, b) => a.at.getTime() - b.at.getTime())[0];
  if (!reached) return null;
  return {
    leadId: String(row._id),
    name: row.name,
    at: reached.at,
    byMembershipId: reached.byMembershipId,
    logged: row.loggedFrom === 'activation_checklist',
  };
}

/** Oldest closing first, ties by id, so two reads agree. */
export function byClosedAt(a: LeadClosing, b: LeadClosing): number {
  return a.at.getTime() - b.at.getTime() || (a.leadId < b.leadId ? -1 : a.leadId > b.leadId ? 1 : 0);
}

/** One open lead, as another module reads it — the Personal Summary's *Leads that need you* (P10-T6). */
export interface OpenLead {
  id: string;
  name: string;
  type: LeadType | null;
  statusCode: string | null;
  /** The office's name for the stage, archived stages included; `null` before a first status. */
  statusLabel: string | null;
  /** Promised for the office's current month — the glossary's *Commitment*. */
  thisMonth: boolean;
  flags: LeadFlag[];
  overdueDays: number | null;
  nextActionDate: string | null;
  nextActionNote: string | null;
}

/** An open lead behind a *Potensi* row (P19.1-T6 AC-6, AC-7): the client's or the kandidat's name, and its next step. */
export interface PotensiOpenLead {
  id: string;
  name: string;
  statusCode: string | null;
  nextActionDate: string | null;
  nextActionNote: string | null;
}

/** A kandidat marked *Berhasil* in the month, and the membership they became where one is linked. */
export interface PotensiRekrutLead {
  id: string;
  name: string;
  statusCode: string | null;
  rekrutAt: Date;
  joinedMembershipId: string | null;
}

/** One member's leads behind their *Potensi* row (`LeadReadings.potensiLeadsOf`). */
export interface PotensiLeads {
  sales: PotensiOpenLead[];
  recruitment: PotensiOpenLead[];
  rekrut: PotensiRekrutLead[];
}

/**
 * **Nearest next action first, undated last** (`Overall.html:6182-6187`). An overdue date is the
 * nearest of all, so the leads most late lead the list. Ties keep the order leads were registered in —
 * the prototype's array order, oldest first — and then the id, so two reads never shuffle.
 */
export function byNextAction(
  a: { nextActionDate: string | null; registeredAt: number; id: string },
  b: { nextActionDate: string | null; registeredAt: number; id: string },
): number {
  if (a.nextActionDate !== b.nextActionDate) {
    if (a.nextActionDate === null) return 1;
    if (b.nextActionDate === null) return -1;
    return a.nextActionDate < b.nextActionDate ? -1 : 1;
  }
  if (a.registeredAt !== b.registeredAt) return a.registeredAt - b.registeredAt;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

/**
 * **`RECRUITMENT_PIPELINE_NOW` and `RECRUITMENT_EXPECTED_TO_CLOSE`, defined once** (P7-T6, ADR-0043): the two
 * `$facet` branches that count an office's open recruitment leads not on a terminal stage, and those on a stage
 * the office ticked *Expected to close*. `LeadService.summary` and the Owner's Overview (`recruitmentPipeline`,
 * Phase 18, D-recruit) build their counts from this one function, so the two cannot disagree. The office's own
 * ladder decides both, by code (invariant §4).
 */
export function recruitmentPipelineFacets(
  stages: readonly { code: string; isTerminal?: boolean; isLateStage?: boolean }[],
): { recruitmentPipelineNow: Record<string, unknown>[]; recruitmentExpectedToClose: Record<string, unknown>[] } {
  const terminal = stages.filter((s) => s.isTerminal).map((s) => s.code);
  const late = stages.filter((s) => s.isLateStage).map((s) => s.code);
  const openWhen = (when: unknown) => [
    { $match: { $expr: { $and: [{ $eq: ['$outcome', null] }, when] } } },
    { $count: 'n' },
  ];
  return {
    recruitmentPipelineNow: openWhen({
      $and: [
        { $eq: ['$type', 'recruitment'] },
        { $not: [{ $in: [{ $ifNull: ['$statusCode', ''] }, terminal] }] },
      ],
    }),
    recruitmentExpectedToClose: openWhen({
      $and: [
        { $eq: ['$type', 'recruitment'] },
        { $in: [{ $ifNull: ['$statusCode', ''] }, late] },
      ],
    }),
  };
}

/**
 * **Leads, as the rest of the product reads them** (P10-T6) — the seam `ActivityReadings` and
 * `ProductionReadings` are for their modules. A module that needs a member's leads asks here, and gets
 * the flags `leadFlags` defines rather than a second reading of the rule.
 */
@Injectable()
export class LeadReadings {
  constructor(
    private readonly leads: LeadRepository,
    private readonly statuses: LeadStatusRepository,
    private readonly clock: Clock,
  ) {}

  /**
   * **A member's own open leads**, nearest next action first. Their own only — a leader's `lead:read`
   * reaches their downline's too, and *Leads that need you* is about the reader (P10-T6 AC-1).
   */
  async openOf(ctx: RequestContext, membershipId: string, day: OfficeDay): Promise<OpenLead[]> {
    const [rows, stages] = await Promise.all([
      this.leads.find(ctx, { ownerMembershipId: membershipId, outcome: null, deletedAt: null }),
      this.statuses.find(ctx, {}),
    ]);
    const labels = new Map(stages.map((s) => [s.code, s.label] as [string, string]));

    return rows
      .map((row) => ({ row, id: String(row._id), registeredAt: row.dateRegistered?.getTime() ?? 0, nextActionDate: row.nextActionDate }))
      .sort(byNextAction)
      .map(({ row, id }) => {
        const flags = leadFlags(row, day.today);
        return {
          id,
          name: row.name,
          type: row.type,
          statusCode: row.statusCode,
          statusLabel: row.statusCode ? labels.get(row.statusCode) ?? null : null,
          thisMonth: (row.commitments ?? []).some((c) => c.month === day.month),
          flags,
          // Whole calendar days in the office's zone, exactly as the Leads screen counts them.
          overdueDays: flags.includes('overdue') && row.nextActionDate
            ? this.clock.daysBetween(day.timezone, row.nextActionDate, day.today)
            : null,
          nextActionDate: row.nextActionDate,
          nextActionNote: row.nextActionNote,
        };
      });
  }

  /**
   * **How many open leads some members hold between them** (P18.5-T15 AC-4): open is `openOf`'s rule — no outcome,
   * not deleted. `owners` `null` is the office, the reader's own leads left out by `except`. A count, never rows.
   */
  async countOpenOf(ctx: RequestContext, owners: readonly string[] | null, except: string): Promise<number> {
    if (owners === null) return this.leads.count(ctx, { ownerMembershipId: { $ne: except }, outcome: null, deletedAt: null });
    const others = [...new Set(owners)].filter((id) => id !== except);
    if (others.length === 0) return 0;
    return this.leads.count(ctx, { ownerMembershipId: { $in: others }, outcome: null, deletedAt: null });
  }

  /**
   * **`OWN_OPEN_LEADS`: every open lead one member owns** (P19.9-T1 AC-5; §A.17; ADR-0232): Home's *Leads* tile — any type
   * and any stage, as `/leads` opens on them (`ownOpenLeadsFilter`). One count over the `{kpmId, ownerMembershipId,
   * deletedAt}` index; never a row.
   */
  async ownOpenOf(ctx: RequestContext, membershipId: string): Promise<number> {
    return this.leads.count(ctx, ownOpenLeadsFilter(membershipId));
  }

  /**
   * **Each member's four lead counts, for many members at once** (Phase 15, D-leads): the Unit Dashboard's
   * *Leads* column — open sales leads, those promised for the office's month, `RECRUITMENT_PIPELINE_NOW`
   * and the recruitment leads promised for the month — by **`LeadService.summary`'s rules** over one owner
   * each (`personLeadCounts`). The office's own recruitment ladder decides what *still running* is, as the
   * summary's does.
   *
   * **Two reads for the whole list**, whatever its length: the office's recruitment stages, and the open
   * leads of every member asked about — the four fields the counts read, over the `{kpmId,
   * ownerMembershipId, deletedAt}` index the list uses. Counts, never rows: nothing about a lead leaves
   * here. Every member asked about gets an entry, all zeros where they hold none.
   */
  async countsOfMany(
    ctx: RequestContext, membershipIds: readonly string[], day: { month: string },
  ): Promise<Map<string, LeadCountsRow>> {
    const ids = [...new Set(membershipIds)];
    if (ids.length === 0) return new Map();
    const [stages, rows] = await Promise.all([
      this.statuses.find(ctx, { pipeline: 'recruitment' }),
      this.leads.find(
        ctx,
        { ownerMembershipId: { $in: ids }, outcome: null },
        { projection: { ownerMembershipId: 1, type: 1, outcome: 1, statusCode: 1, commitments: 1 } },
      ),
    ]);
    const terminalRecruitmentCodes = stages.filter((stage) => stage.isTerminal).map((stage) => stage.code);
    const byOwner = new Map<string, CountedLead[]>(ids.map((id) => [id, []]));
    for (const row of rows) byOwner.get(row.ownerMembershipId)!.push(row);
    return new Map(ids.map((id) => [id, personLeadCounts(byOwner.get(id)!, { month: day.month, terminalRecruitmentCodes })]));
  }

  /**
   * **The office's recruitment pipeline** (Phase 18, D-recruit): *Expected to close* and *Pipeline now* on the
   * Overview — `LeadService.summary`'s two counts over every owner in the office, from the same facets
   * (`recruitmentPipelineFacets`). Two reads: the office's recruitment stages, and one aggregate. Counts, never
   * a lead: the Owner and the Admin hold counts (roles §3.6).
   */
  async recruitmentPipeline(ctx: RequestContext): Promise<{ pipelineNow: number; expectedToClose: number }> {
    const stages = await this.statuses.find(ctx, { pipeline: 'recruitment' });
    const [facets] = await this.leads.aggregate(ctx, [{ $match: {} }, { $facet: recruitmentPipelineFacets(stages) }]);
    const n = (key: string) => (facets?.[key] as { n?: number }[] | undefined)?.[0]?.n ?? 0;
    return { pipelineNow: n('recruitmentPipelineNow'), expectedToClose: n('recruitmentExpectedToClose') };
  }

  /**
   * **`countsOfMany` as the leads stood at the end of a month** (Phase 18, D-period): the unit comparison's
   * *Total leads* under *Previous month* — each member's four counts over their leads **as they were then**
   * (`personLeadCountsAt`: registered by then, closed only if closed by then, on the stage their last move by
   * then names), with *promised* meaning promised for that month. Two reads for the whole list, as
   * `countsOfMany`: the office's recruitment stages, and every lead of the members asked about that was still
   * open at `at` or is still open now. Counts, never rows.
   */
  async countsOfManyAt(
    ctx: RequestContext, membershipIds: readonly string[], day: { month: string; at: Date },
  ): Promise<Map<string, LeadCountsRow>> {
    const ids = [...new Set(membershipIds)];
    if (ids.length === 0) return new Map();
    const [stages, rows] = await Promise.all([
      this.statuses.find(ctx, { pipeline: 'recruitment' }),
      this.leads.find(
        ctx,
        { ownerMembershipId: { $in: ids }, $or: [{ outcome: null }, { outcomeAt: { $gte: day.at } }] },
        {
          projection: {
            ownerMembershipId: 1, type: 1, outcome: 1, outcomeAt: 1, statusCode: 1, commitments: 1,
            transitions: 1, dateRegistered: 1, createdAt: 1,
          },
        },
      ),
    ]);
    const terminalRecruitmentCodes = stages.filter((stage) => stage.isTerminal).map((stage) => stage.code);
    const byOwner = new Map<string, DatedLead[]>(ids.map((id) => [id, []]));
    for (const row of rows) {
      byOwner.get(row.ownerMembershipId)!.push({
        type: row.type, outcome: row.outcome, statusCode: row.statusCode, commitments: row.commitments,
        outcomeAt: row.outcomeAt ?? null, transitions: row.transitions,
        registeredAt: row.dateRegistered ?? (row as unknown as { createdAt?: Date }).createdAt ?? null,
      });
    }
    return new Map(ids.map((id) => [id, personLeadCountsAt(byOwner.get(id)!, { ...day, terminalRecruitmentCodes })]));
  }

  /*
   * `recruitmentClosed` was here: `RECRUITMENT_CLOSED_LAST_MONTH` as the recruitment leads closed won in a month (Phase
   * 18, D-recruit). Retired by P19.3-T1 (ADR-0200 §5, D2): the figure is the office's upload's `RECRUITMENT`
   * (`OfficialApe.officeMonths`), and a lead is a candidate the pipeline counts by stage.
   */

  /**
   * **Each member's closings, for many members at once** (P18.8-T4 AC-1, AC-2): every **sales** lead of theirs that
   * has reached *Paid and issued* (`FIRST_SALE_STAGE_CODE`), with the instant it **first** did, who moved it there,
   * and whether it was logged from the checklist (`loggedFrom`). A recruitment lead never: it is a person joining, not
   * a case. A deleted lead is not among them. One read for the whole list, on the `(kpmId, ownerMembershipId, …)`
   * index, five fields each; oldest first. Every member asked about gets an entry, empty where they have none.
   */
  async closingsOfMany(ctx: RequestContext, membershipIds: readonly string[]): Promise<Map<string, LeadClosing[]>> {
    const ids = [...new Set(membershipIds)];
    const out = new Map<string, LeadClosing[]>(ids.map((id) => [id, []]));
    if (ids.length === 0) return out;
    const rows = await this.leads.find(
      ctx, { ownerMembershipId: { $in: ids }, ...CLOSING_FILTER }, { projection: { ...CLOSING_FIELDS } },
    );
    for (const row of rows) {
      const closing = closingOf(row);
      if (closing) out.get(row.ownerMembershipId)!.push(closing);
    }
    for (const list of out.values()) list.sort(byClosedAt);
    return out;
  }

  /**
   * **Each member's *Potensi* figures for a month, for many members at once** (P19.1-T6; ADR-0193): over every lead
   * switched on for the month or marked *Berhasil* inside it — `personPotensi`'s rules, defined once in
   * `domain/metrics/potensi.ts`. One read for the whole list, on the `(kpmId, ownerMembershipId, …)` index, five fields
   * each; a count leaves here, never a lead. Every member asked about gets an entry, all zeros where they hold none.
   */
  async potensiOfMany(
    ctx: RequestContext, membershipIds: readonly string[], m: PotensiMonth,
  ): Promise<Map<string, PersonPotensi>> {
    const ids = [...new Set(membershipIds)];
    const byOwner = new Map<string, Parameters<typeof personPotensi>[0][number][]>(ids.map((id) => [id, []]));
    if (ids.length > 0) {
      const rows = await this.leads.find(ctx, {
        ownerMembershipId: { $in: ids },
        $or: [{ 'commitments.month': m.month }, { outcome: 'won', outcomeAt: { $gte: m.start, $lt: m.endExclusive } }],
      }, { projection: { ownerMembershipId: 1, type: 1, outcome: 1, outcomeAt: 1, commitments: 1 } });
      for (const row of rows) {
        byOwner.get(row.ownerMembershipId)!.push({
          type: row.type, outcome: row.outcome, outcomeAt: row.outcomeAt ?? null, commitments: row.commitments,
        });
      }
    }
    return new Map(ids.map((id) => [id, personPotensi(byOwner.get(id)!, m)]));
  }

  /**
   * **One member's leads behind their *Potensi* row** (P19.1-T6 AC-6, AC-7; Q-2: a leader sees the names): their
   * sales leads that are *potensi* for the month — switched on and still open at its end — nearest next action first,
   * and their recruitment leads that are *potensi*, then those marked *Berhasil* in the month (*rekrut*), newest first,
   * with the membership each became where one is linked. The caller decides who may read them and records the read.
   */
  async potensiLeadsOf(ctx: RequestContext, membershipId: string, m: PotensiMonth): Promise<PotensiLeads> {
    const rows = await this.leads.find(ctx, {
      ownerMembershipId: membershipId,
      type: { $in: ['sales', 'recruitment'] },
      $or: [{ 'commitments.month': m.month }, { outcome: 'won', outcomeAt: { $gte: m.start, $lt: m.endExclusive } }],
    });
    const open = rows
      .filter((row) => leadPotensiThisMonth(row, m.month) && openAtEndOf({ outcome: row.outcome, outcomeAt: row.outcomeAt ?? null }, m))
      .map((row) => ({ row, id: String(row._id), registeredAt: row.dateRegistered?.getTime() ?? 0, nextActionDate: row.nextActionDate }))
      .sort(byNextAction)
      .map(({ row, id }) => ({
        id, name: row.name, type: row.type!, statusCode: row.statusCode,
        nextActionDate: row.nextActionDate, nextActionNote: row.nextActionNote,
      }));
    const rekrut = rows
      .filter((row) => row.type === 'recruitment' && wonIn({ outcome: row.outcome, outcomeAt: row.outcomeAt ?? null }, m))
      .sort((a, b) => b.outcomeAt!.getTime() - a.outcomeAt!.getTime() || (String(a._id) < String(b._id) ? -1 : 1))
      .map((row) => ({
        id: String(row._id), name: row.name, statusCode: row.statusCode, rekrutAt: row.outcomeAt!,
        joinedMembershipId: row.joinedMembershipId ?? null,
      }));
    return {
      sales: open.filter((l) => l.type === 'sales').map(({ type: _type, ...l }) => l),
      recruitment: open.filter((l) => l.type === 'recruitment').map(({ type: _type, ...l }) => l),
      rekrut,
    };
  }

  /**
   * **Each member's newest lead, of either type, for many members at once** (P13-T3 AC-3, AC-7): what
   * completes an activation's `feature:leads` item, and who added it — the owner, or a leader in a session
   * (ADR-0076). One aggregate for the whole list, within the office; a deleted lead is not among them.
   */
  async latestOfMany(
    ctx: RequestContext, membershipIds: readonly string[],
  ): Promise<Map<string, { id: string; at: Date; byMembershipId: string }>> {
    const out = new Map<string, { id: string; at: Date; byMembershipId: string }>();
    if (membershipIds.length === 0) return out;
    const rows = await this.leads.aggregate(ctx, [
      { $match: { ownerMembershipId: { $in: [...new Set(membershipIds)] } } },
      { $sort: { dateRegistered: -1, _id: -1 } },
      {
        $group: {
          _id: '$ownerMembershipId',
          id: { $first: '$_id' },
          at: { $first: { $ifNull: ['$dateRegistered', '$createdAt'] } },
          by: { $first: { $ifNull: ['$createdBy', '$ownerMembershipId'] } },
        },
      },
    ]);
    for (const row of rows) {
      out.set(String(row._id), { id: String(row.id), at: row.at as Date, byMembershipId: String(row.by) });
    }
    return out;
  }
}
