import { CONSOLE } from '@/domain/constants';
import type { LocalDate } from '@/common/time/local-day';
import type { CoachingStatus } from '@/domain/constants/coaching-status';
import type { OverviewTreeRow } from '@/modules/reporting/overview-tree';

/**
 * **The KPM report's model** (P19.24-T1; ADR-0280 §3, §4): everything the pages print, read and counted, before a word is
 * placed. `KpmReportReadings` fills it from the pages' own services; `kpm-report.layout.ts` draws it. Pure helpers live
 * here — the colour scale, the ▲/▼ rule, the order names are printed in — so each is pinned once by a unit test.
 */

// ------------------------------------------------------------------------------------------------ the colour scale

export type ReportTone = 'green' | 'yellow' | 'red';

/**
 * **One colour scale** (§11; the console's `CONSOLE.SCALE`, spec §3): a whole percentage at or above 80 is green, at or
 * above 50 yellow, anything lower red; no figure, no colour.
 */
export function toneOf(pct: number | null): ReportTone | null {
  if (pct === null || !Number.isFinite(pct)) return null;
  if (pct >= CONSOLE.SCALE.GREEN_FROM_PCT) return 'green';
  return pct >= CONSOLE.SCALE.YELLOW_FROM_PCT ? 'yellow' : 'red';
}

/** A share as a whole percentage, half up; `null` over nobody. */
export function pctOf(part: number, whole: number): number | null {
  if (whole <= 0) return null;
  return Math.floor((200 * part + whole) / (2 * whole));
}

// ------------------------------------------------------------------------------------------------ ▲ / ▼

/**
 * **A change against last month** (§11: *"▲/▼ vs last month on key numbers"*): a count's difference, or a share's in
 * percentage points. `null` when either side is missing — no arrow is drawn rather than a made-up one.
 */
export interface ReportDelta {
  value: number;
  kind: 'count' | 'points';
}

export function deltaOf(now: number | null, before: number | null, kind: ReportDelta['kind'] = 'count'): ReportDelta | null {
  if (now === null || before === null) return null;
  return { value: Math.round((now - before) * 10) / 10, kind };
}

/**
 * The arrow's words: *"▲ 2"*, *"▼ 1"*, *"▲ 6 poin"*, *"= 0"* when nothing moved. Whether up is good is the reader's — the
 * colour says it (`deltaTone`), never the arrow.
 */
export function deltaText(delta: ReportDelta | null, vs: string): string | null {
  if (delta === null) return null;
  const unit = delta.kind === 'points' ? ' poin' : '';
  const size = String(Math.abs(delta.value)).replace('.', ',');
  if (delta.value === 0) return `= 0${unit} vs ${vs}`;
  return `${delta.value > 0 ? '▲' : '▼'} ${size}${unit} vs ${vs}`;
}

/** Green when the change is the good way, red the other, none when nothing moved. `higherIsBetter` says which way is good. */
export function deltaTone(delta: ReportDelta | null, higherIsBetter = true): 'up' | 'down' | null {
  if (delta === null || delta.value === 0) return null;
  return (delta.value > 0) === higherIsBetter ? 'up' : 'down';
}

// ------------------------------------------------------------------------------------------------ people and the order

export type ReportRole = 'ab' | 'aab' | 'agent';

/** A name as the report prints it (§11): in CAPITALS; the orange *AB* / *AAB* label is the layout's, from `role`. */
export function printedName(name: string): string {
  return name.trim().toLocaleUpperCase('id-ID');
}

export type AttendanceMark = 'attended' | 'absent' | 'waiting' | null;

/**
 * **A person's mark for one past event**, from *Kehadiran*'s own marks (`KehadiranMark`, P19.25): `1` *Hadir* — a
 * confirmer's mark (OD-31) — `0` *Tidak hadir*, `?` an event whose roll call is not taken yet, `.` (or none) not expected.
 */
export function kehadiranMark(mark: string | undefined): AttendanceMark {
  switch (mark) {
    case '1': return 'attended';
    case '0': return 'absent';
    case '?': return 'waiting';
    default: return null;
  }
}

/** One person's facts for the month, each a page's own reading (ADR-0280 §3). `null`: the item does not apply. */
export interface ReportPerson {
  membershipId: string;
  /** In CAPITALS (`printedName`). */
  name: string;
  role: ReportRole;
  /** Their AB group's informal group, `null` *Tanpa group*. */
  groupName: string | null;
  /** Their AB group's AB, `null` for somebody under no AB. */
  abId: string | null;
  /** The head of their unit: the AB for the AB unit, the AAB for an AAB unit. */
  unitHeadId: string | null;
  usage: { ever: boolean; recent14: boolean; days: number | null; powerUser: boolean; usedInMonth: boolean };
  coaching: { status: CoachingStatus; days: number | null };
  /** The compliance items (`ComplianceCategory`'s cells, the KPM Overview's): `true` done, `false` not, `null` n/a. */
  compliance: { goals: boolean | null; activity: boolean | null; leads: boolean | null; activation: boolean | null; events: boolean | null; campaigns: boolean | null };
  /** Answered the latest NPS run that opened: `null` when not invited, or no run has opened. */
  nps: boolean | null;
  /** `MONTHLY_ACTIVE_AGENT` in the month; `null` while the month is not uploaded. */
  activeAgent: boolean | null;
  /** A sales lead switched on for the month and still open (`POTENSI_COUNT` > 0), and not an Active Agent. */
  potensi: boolean;
  /** Goal Setting's yearly APE target and the official APE year to date, in sen; `null` with none. */
  goalMinor: number | null;
  ytdMinor: number | null;
  /** Activities logged in the month (every type's count, archived ones included). */
  activities: number;
  /** Open leads now (or at the month's end for a past month): sales and recruitment. */
  leads: { sales: number; recruit: number };
  /** `QUAL_PERSON_ISSUE_ITEMS` of the latest qualitative run; `null` not answered, or answers not kept per person. */
  qualIssues: number | null;
  /**
   * Each of the month's past events, by id, as *Kehadiran* marks it (`kehadiranMark`): `attended` · `absent` · `waiting`
   * (roll call not taken) · `null` — not expected there.
   */
  attendance: Record<string, AttendanceMark>;
}

/** One unit: the AB unit (the AB and their direct agents) or one AAB unit (the AAB and their agents); the head first. */
export interface ReportUnit {
  headId: string;
  role: 'ab' | 'aab';
  people: ReportPerson[];
}

/** One AB group and its units: the AB unit first, then each AAB unit. `ab: null` — members under no AB. */
export interface ReportAbGroup {
  ab: ReportPerson | null;
  units: ReportUnit[];
}

/** One informal group, or *Tanpa group* (`name: null`), and its AB groups in the KPM Overview's order. */
export interface ReportGroup {
  name: string | null;
  abGroups: ReportAbGroup[];
}

/**
 * **The fixed order** (§11: *"Informal group → AB group → AB unit → each AAB unit → person"*): the KPM Overview's tree
 * (`overviewTree` — the informal groups A to Z then *Tanpa group*, the ABs A to Z, each AAB A to Z with their agents,
 * the AB's direct agents) regrouped so that **the AB unit comes first** — the AB and their direct agents — then each AAB
 * unit, the AAB first. Nobody is added or dropped: every row of the tree is in exactly one unit.
 */
export function reportGroups(
  groups: readonly { groupId: string | null; name: string | null; memberIds: readonly string[] }[],
  rows: readonly OverviewTreeRow[],
  personOf: (membershipId: string) => ReportPerson,
): ReportGroup[] {
  const rowOf = new Map(rows.map((r) => [r.membershipId, r]));
  return groups.map((g) => {
    const abGroups: ReportAbGroup[] = [];
    let current: { ab: ReportPerson | null; abUnit: ReportUnit | null; aabUnits: ReportUnit[] } | null = null;
    let aab: ReportUnit | null = null;
    const close = () => {
      if (current) abGroups.push({ ab: current.ab, units: [...(current.abUnit ? [current.abUnit] : []), ...current.aabUnits] });
    };
    for (const id of g.memberIds) {
      const row = rowOf.get(id);
      if (!row) continue;
      const person = personOf(id);
      if (row.abMembershipId === null) {
        // Somebody under no AB: one block of their own at the end of *Tanpa group*, a unit with them alone.
        close();
        current = { ab: null, abUnit: { headId: id, role: 'ab', people: [person] }, aabUnits: [] };
        aab = null;
        continue;
      }
      if (row.depth === 0) {
        close();
        current = { ab: person, abUnit: { headId: id, role: 'ab', people: [person] }, aabUnits: [] };
        aab = null;
      } else if (row.depth === 1 && row.role !== 'agent') {
        aab = { headId: id, role: 'aab', people: [person] };
        current!.aabUnits.push(aab);
      } else if (row.depth === 2 && aab) {
        aab.people.push(person);
      } else {
        current!.abUnit!.people.push(person);
      }
    }
    close();
    return { name: g.name, abGroups };
  });
}

/** Everybody of the groups, in the report's order: what every list prints, top to bottom. */
export function inReportOrder(groups: readonly ReportGroup[]): ReportPerson[] {
  return groups.flatMap((g) => g.abGroups.flatMap((ab) => ab.units.flatMap((u) => u.people)));
}

// ------------------------------------------------------------------------------------------------ the model

/** A figure against a target: *"8 dari 14"*. `value: null` — not uploaded; `target: null` — none set. */
export interface ReportFigure {
  value: number | null;
  target: number | null;
}

/** A step of *Pemakaian AgencyBoost*: how many, their share, and last month's. */
export interface ReportStep {
  count: number;
  pct: number | null;
  previousCount: number;
  previousPct: number | null;
}

/** One AB group's row of *Performa vs target*. */
export interface PerformanceLine {
  abId: string | null;
  label: string;
  groupName: string | null;
  apeMinor: number | null;
  apePct: number | null;
  activeAgents: ReportFigure;
  rekrutYtd: ReportFigure;
}

/** One of the eight compliance items, as the KPM Overview's card reads it. */
export interface ComplianceLine {
  key: 'goals' | 'activity' | 'leads' | 'activation' | 'events' | 'campaigns' | 'coaching' | 'nps';
  done: number;
  of: number;
}

/** An appendix part that is off in the KPM's template, or has nothing yet, is `null` and is left out. */
export interface KpmReportModel {
  office: { kpmId: string; name: string; company: string; code: string; ownerName: string | null };
  /** `YYYY-MM`. */
  month: string;
  /** The day every rolling figure is read as of: the month's last day, or today in the KPM's month (ADR-0280 §3). */
  asOf: LocalDate;
  /** The day last month's figures are read as of, for ▲/▼. */
  comparedWith: LocalDate;
  /** The KPM's today: *dibuat …*. */
  madeOn: LocalDate;
  groups: ReportGroup[];
  people: ReportPerson[];
  members: { total: number; leaders: number; agents: number };
  newMembers: number;
  funnel: { everUsed: ReportStep; used14: ReportStep; powerUsers: ReportStep };
  performance: { held: boolean; rows: PerformanceLine[]; total: PerformanceLine; aboveTarget: number };
  activity: {
    total: number;
    previousTotal: number;
    leadsSales: number;
    leadsRecruit: number;
    previousLeads: number;
    withoutActivity: number;
    previousWithout: number;
  };
  activeAgents: {
    held: boolean;
    count: number | null;
    target: number | null;
    previousCount: number | null;
    potensi: number;
    previousPotensi: number;
    recruitsMonth: number;
    previousRecruitsMonth: number;
    recruitsMonthTarget: number | null;
    recruitsYtd: number;
    recruitsYtdTarget: number | null;
    recruits: { name: string; recruiter: { name: string; role: ReportRole } | null; joinDate: LocalDate }[];
  };
  compliance: ComplianceLine[];
  /** The latest NPS run's period (*Q3 2026*), for *Survei NPS*'s line; `null` before one opens. */
  npsPeriod: string | null;
  appendix: KpmReportAppendix;
}

/** *Lampiran · Advanced analytics* (§11 section 6), each part through the page's own read; `null` left out. */
export interface KpmReportAppendix {
  demographics: {
    manpower: number;
    complete: number;
    incomplete: number;
    completePct: number | null;
    role: { key: string; count: number; label?: string }[];
    workStatus: { key: string; count: number }[];
    tenureBand: { key: string; count: number; from?: number | null; to?: number | null }[];
    ageBand: { key: string; count: number; from?: number | null; to?: number | null }[];
    gender: { key: string; count: number }[];
    /** Members with a required field missing, by id, and which fields. */
    missing: Map<string, string[]>;
  } | null;
  mapa: {
    headline: { ape: ReportFigure; activeAgent: ReportFigure; rekrut: ReportFigure };
    rows: {
      key: string;
      unit: 'idr_minor' | 'count' | 'percentage' | 'ratio';
      ytdLastYear: number | null;
      ytd: number | null;
      sameMonthLastYear: number | null;
      thisMonth: number | null;
      target: number | null;
    }[];
  } | null;
  nps: {
    period: string;
    sent: number;
    invited: number;
    leaders: number;
    agents: number;
    lines: {
      text: string;
      score: number | null;
      change: number | null;
      shares: { promoterPct: number; passivePct: number; detractorPct: number } | null;
      reasons: { text: string; who: 'leader' | 'agent' | null }[];
    }[];
  } | null;
  quant: {
    fromMonth: string | null;
    periodEnd: string;
    metrics: { code: string; value: number | null; median: number | null; previous: number | null; status: 'above' | 'in_line' | 'below' | null; percent: boolean }[];
  } | null;
  qual: {
    period: string;
    respondents: number;
    invited: number;
    blocks: { title: string; respondents: number; rows: { label: string; issuePct: number | null; previousPct: number | null }[] }[];
    /** Per person, in the report's order: answered, and their items with a problem (`null` not kept per person). */
    people: Map<string, { answered: boolean; issues: number | null }>;
  } | null;
  informal: {
    groups: { name: string | null; rows: { abId: string; label: string; people: number; maa: ReportFigure; usagePct: number | null; oneOnOne: ReportFigure; rekrut: ReportFigure }[] }[];
  } | null;
  events: {
    /** *Kehadiran*'s average over the month's recorded events. */
    summaryPct: number | null;
    /** The month's past events, newest first; `attended` / `audience` `null` until the roll call is taken. */
    list: { id: string; title: string; startsOn: LocalDate; attended: number | null; audience: number | null; pct: number | null; nps: number | null; answers: number }[];
  } | null;
}
