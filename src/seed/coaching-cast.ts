/**
 * **The coaching cast** (P11-T2): the people the demo AB coaches, and what the seed writes for each of
 * them so that the person tabs and the roster have something true to show.
 *
 * `demo.ts` places these people and writes their rows; `coaching-fixture.ts` holds the coaching rows
 * themselves and, in its header, the table of which member is meant to show which roster state and
 * why. This module is data and two small functions, so the seed and its spec read one copy of it.
 *
 * Every number below is an **input** a screen derives from, never a derived figure: a goal's
 * assumptions, a month's APE, a day's counts by activity code (invariant §4). What they produce is the
 * product's arithmetic — `monthlyApeTarget` and `cascadeCounts`, imported, never re-declared
 * (invariant §7).
 */
import { CASCADE_ACTIVITY_CODES } from '@/domain/constants';
import { cascadeCounts } from '@/modules/goals/goal-cascade';
import { MINOR_UNITS_PER_RP_MILLION } from '@/modules/production/production-units';

/** The six people P11-T2 adds. */
export type CastKey = 'indah' | 'dimas' | 'siti' | 'arief' | 'novi' | 'wahyu';

/** Everybody below the demo AB: the six above and the five the seed already had. */
export type CoacheeKey = CastKey | 'sari' | 'dewi' | 'rina' | 'budi' | 'yanti';

/** `GOAL_PACE_STATUS`'s four values (`metrics-and-definitions.md` §A.4, ADR-0080). */
export type RosterStatus = 'on_track' | 'watch_closely' | 'needs_attention' | 'no_goal_set';

export interface CastPerson {
  key: CastKey;
  email: string;
  fullName: string;
  /**
   * **Their own pronoun** (`users.pronoun`), which the coaching screens write about them in: *Leads that
   * need her*. Stated beside the name, never derived from it.
   */
  pronoun: 'she' | 'he';
  role: 'agent' | 'aab';
  /** `agus` is the demo AB; `arief` is the AAB this cast adds. */
  leader: 'agus' | 'arief';
  /**
   * The insurer's producer id, in the seed's `8xxxx` shape — digits only, as every new code is (ADR-0158 §4).
   * **Given, not counted**: `user()`
   * numbers the accounts it creates, so an account added to a database that already holds the rest
   * would be numbered from one again and collide with an existing code.
   */
  agentCode: string;
  /**
   * **When they joined, in days before the run**: after their leader could lead them — Agus joined, or
   * Arief became an AAB — and before their first activity day (41 back), their goal (60 back at most)
   * and any promotion. So the edge a session or a goal rests on was open on its day (`demo.ts`, the
   * office's join dates).
   */
  joinedDaysAgo: number;
  /** Promoted from Agent by Agus, so they joined as an Agent and the role change log has the row. */
  promoted?: { daysAgo: number; reason: string };
}

/**
 * **Agus gets direct agents, and a second AAB unit with agents of its own** (P11-T2 AC-1).
 *
 * Dewi stays an AAB who leads nobody. ADR-0087 names her as the seeded case of *a leader is anyone with
 * direct reports* (`isLeader: false`), the sign-in panel labels her *leads nobody*, and P11-T6's nav item
 * and landing are tested against exactly that case. The second populated unit is Arief's instead.
 *
 * Order matters: Agus's people first, then Arief, then the two who report to him. Arief joined as an
 * Agent and was promoted 90 days ago; Novi and Wahyu joined his unit after that, because an Agent leads
 * nobody (`role-change.service.ts`).
 */
export const COACHING_CAST: readonly CastPerson[] = [
  { key: 'indah', email: 'indah@kpm0417.test', fullName: 'Indah Permatasari', pronoun: 'she', role: 'agent', leader: 'agus', agentCode: '80101', joinedDaysAgo: 97 },
  { key: 'dimas', email: 'dimas@kpm0417.test', fullName: 'Dimas Pratama', pronoun: 'he', role: 'agent', leader: 'agus', agentCode: '80102', joinedDaysAgo: 94 },
  { key: 'siti', email: 'siti@kpm0417.test', fullName: 'Siti Rahmawati', pronoun: 'she', role: 'agent', leader: 'agus', agentCode: '80103', joinedDaysAgo: 101 },
  {
    key: 'arief', email: 'arief@kpm0417.test', fullName: 'Arief Hidayat', pronoun: 'he', role: 'aab', leader: 'agus', agentCode: '80104',
    joinedDaysAgo: 104, promoted: { daysAgo: 90, reason: 'Ready to lead a unit of his own' },
  },
  { key: 'novi', email: 'novi@kpm0417.test', fullName: 'Novi Andriani', pronoun: 'she', role: 'agent', leader: 'arief', agentCode: '80105', joinedDaysAgo: 84 },
  { key: 'wahyu', email: 'wahyu@kpm0417.test', fullName: 'Wahyu Saputra', pronoun: 'he', role: 'agent', leader: 'arief', agentCode: '80106', joinedDaysAgo: 79 },
];

/*
 * Every money figure below is written in Rp millions times `MINOR_UNITS_PER_RP_MILLION`, the production
 * module's own definition of the unit, imported rather than declared a second time (invariant §7).
 */

export interface CoachingGoalPlan {
  key: CoacheeKey;
  mode: 'direct' | 'from_savings';
  /** Sen. For `from_savings`, what the savings and the commission rate come to. */
  annual: number;
  savings?: number;
  commissionPct?: number;
  caseSize: number;
  leadsToAppt: number;
  closing: number;
  savedDaysAgo: number;
  /** A leader saved it, in a 1-on-1 (ADR-0046). The owner otherwise. */
  savedBy?: 'arief';
}

/**
 * **A goal for the office's current year for every coachee but Sari** (AC-2).
 *
 * Sari is the one with no goal, which is the state Phase 10's Summary already shows on her account
 * (*"You haven't set a goal"*) and the roster's *No goal set* (ADR-0080). Rina, Budi and Dewi keep the
 * goals Phase 8 gave them. Each annual target here is above anything the member's production can reach
 * by December, so no month's target is zero and no status here rests on a year already made (ADR-0047).
 */
export const COACHING_GOALS: readonly CoachingGoalPlan[] = [
  { key: 'indah', mode: 'direct', annual: 420 * MINOR_UNITS_PER_RP_MILLION, caseSize: 12 * MINOR_UNITS_PER_RP_MILLION, leadsToAppt: 40, closing: 40, savedDaysAgo: 25 },
  {
    // Thinks in take-home pay, as Budi does: Rp 36 M at 10% is an APE target of Rp 360 M.
    key: 'dimas', mode: 'from_savings', annual: 360 * MINOR_UNITS_PER_RP_MILLION, savings: 36 * MINOR_UNITS_PER_RP_MILLION, commissionPct: 10,
    caseSize: 10 * MINOR_UNITS_PER_RP_MILLION, leadsToAppt: 35, closing: 35, savedDaysAgo: 40,
  },
  { key: 'siti', mode: 'direct', annual: 300 * MINOR_UNITS_PER_RP_MILLION, caseSize: 10 * MINOR_UNITS_PER_RP_MILLION, leadsToAppt: 30, closing: 30, savedDaysAgo: 60 },
  { key: 'arief', mode: 'direct', annual: 600 * MINOR_UNITS_PER_RP_MILLION, caseSize: 20 * MINOR_UNITS_PER_RP_MILLION, leadsToAppt: 40, closing: 40, savedDaysAgo: 33 },
  { key: 'novi', mode: 'direct', annual: 300 * MINOR_UNITS_PER_RP_MILLION, caseSize: 10 * MINOR_UNITS_PER_RP_MILLION, leadsToAppt: 35, closing: 35, savedDaysAgo: 18, savedBy: 'arief' },
  { key: 'wahyu', mode: 'direct', annual: 240 * MINOR_UNITS_PER_RP_MILLION, caseSize: 8 * MINOR_UNITS_PER_RP_MILLION, leadsToAppt: 30, closing: 30, savedDaysAgo: 50 },
  // Back since her second membership, and planning big. Above the most her rows reach by December.
  { key: 'yanti', mode: 'direct', annual: 600 * MINOR_UNITS_PER_RP_MILLION, caseSize: 15 * MINOR_UNITS_PER_RP_MILLION, leadsToAppt: 30, closing: 30, savedDaysAgo: 20 },
];

export interface CoachingProductionPlan {
  key: CastKey;
  /** Sen: last month's APE, and every earlier month's when nothing earlier is held. */
  baseMonthly: number;
  /**
   * This month's APE as a share of the member's `MONTHLY_APE_TARGET`, worked out from the year to date
   * the office holds when the row is written. Above 1 is *On track* whatever the month; well under the
   * 0.9 of `PACE_ON_TRACK_RATIO` is *Watch closely* for a member who is pacing.
   */
  thisMonthShareOfTarget: number;
}

/** The six people's production, imported with everybody else's (`demo.ts`, the monthly upload). */
export const COACHING_PRODUCTION: readonly CoachingProductionPlan[] = [
  { key: 'indah', baseMonthly: 30 * MINOR_UNITS_PER_RP_MILLION, thisMonthShareOfTarget: 1.25 },
  { key: 'dimas', baseMonthly: 20 * MINOR_UNITS_PER_RP_MILLION, thisMonthShareOfTarget: 0.4 },
  { key: 'siti', baseMonthly: 15 * MINOR_UNITS_PER_RP_MILLION, thisMonthShareOfTarget: 0.5 },
  { key: 'arief', baseMonthly: 40 * MINOR_UNITS_PER_RP_MILLION, thisMonthShareOfTarget: 1.3 },
  { key: 'novi', baseMonthly: 18 * MINOR_UNITS_PER_RP_MILLION, thisMonthShareOfTarget: 0.35 },
  { key: 'wahyu', baseMonthly: 12 * MINOR_UNITS_PER_RP_MILLION, thisMonthShareOfTarget: 0.6 },
];

/** A day's counts, by activity type code. A code it leaves out is a zero. */
export type DayCounts = Readonly<Record<string, number>>;

export interface ActivityPlan {
  key: CoacheeKey;
  /** The days logged, as days back from the seed run's today in the office's zone. */
  days: readonly number[];
  counts: (back: number) => DayCounts;
  /**
   * **No contact, presentation or submission on any day of the current month** — the three cascade
   * codes — so the month's attainment is zero and the member is not `PACING_TO_MAA` on any day of it:
   * *Needs attention*. Their other activity, and earlier months' selling, still log.
   */
  sellingFreeThisMonth?: boolean;
  /**
   * **Tops the month up to `pacingFloor`** on today's row when the days already held and the days this
   * run writes fall short, so the member is pacing from the first of the month and not only from the
   * fourth. Never written over a day that exists.
   */
  pacing?: boolean;
}

/** `0..last`, less the days `skip` names: a working pattern with days off in it. */
const span = (last: number, skip: (back: number) => boolean, first = 0): number[] =>
  Array.from({ length: last - first + 1 }, (_, i) => first + i).filter((back) => !skip(back));

/**
 * **Weeks of activity for every coachee** (AC-2). Rina and Sari keep the days Phase 6 and Phase 10 gave
 * them (`demo.ts`); Rina's are topped up like the others' that pace.
 */
export const COACHING_ACTIVITY: readonly ActivityPlan[] = [
  {
    // Six weeks, one day off a week: the busy producer.
    key: 'indah', days: span(41, (b) => b % 7 === 6), pacing: true,
    counts: (b) => ({
      LEADS_GEN_ACTIVITY: 1 + (b % 2), LEADS_NEW_PROSPECT: b % 3 === 0 ? 2 : 1,
      LEADS_CONTACTED: 4 + (b % 3), SELL_PRESENTATION: 1 + (b % 2), SELL_FOLLOWUP: b % 2,
      SELL_SUBMISSION: b % 4 === 0 ? 1 : 0, RECRUIT_PRESENTATION: b % 7 === 3 ? 1 : 0,
      DEV_TRAINING_ATTEND: b % 7 === 2 ? 1 : 0,
    }),
  },
  {
    key: 'dimas', days: span(41, (b) => b % 5 === 4), pacing: true,
    counts: (b) => ({
      LEADS_GEN_ACTIVITY: b % 2, LEADS_NEW_PROSPECT: b % 4 === 0 ? 1 : 0, LEADS_CONTACTED: 3 + (b % 2),
      SELL_PRESENTATION: b % 3 === 0 ? 1 : 0, SELL_FOLLOWUP: 1, SELL_SUBMISSION: b % 9 === 0 ? 1 : 0,
      RECRUIT_FOLLOWUP: b % 7 === 4 ? 1 : 0, DEV_TRAINING_ATTEND: b % 7 === 1 ? 1 : 0,
    }),
  },
  {
    // Logs nearly every day, and this month nothing that sells: prospecting, follow-ups, training.
    key: 'siti', days: span(41, (b) => b % 6 === 5), sellingFreeThisMonth: true,
    counts: (b) => ({
      LEADS_GEN_ACTIVITY: 1 + (b % 2), LEADS_NEW_PROSPECT: b % 3 === 0 ? 1 : 0, LEADS_CONTACTED: 2 + (b % 2),
      SELL_PRESENTATION: b % 4 === 0 ? 1 : 0, SELL_FOLLOWUP: b % 2, SELL_SUBMISSION: b % 11 === 0 ? 1 : 0,
      RECRUIT_PRESENTATION: b % 7 === 0 ? 1 : 0, DEV_TRAINING_ATTEND: b % 7 === 3 ? 1 : 0,
    }),
  },
  {
    // An AAB's mix: selling, recruiting, and the unit's development.
    key: 'arief', days: span(41, (b) => b % 7 === 5), pacing: true,
    counts: (b) => ({
      LEADS_GEN_ACTIVITY: 1, LEADS_CONTACTED: 3 + (b % 2), SELL_PRESENTATION: 1, SELL_FOLLOWUP: b % 2,
      SELL_SUBMISSION: b % 5 === 0 ? 1 : 0, RECRUIT_PRESENTATION: b % 3 === 0 ? 1 : 0,
      RECRUIT_FOLLOWUP: b % 4 === 1 ? 1 : 0, RECRUIT_AGENT_CODE: b % 15 === 0 ? 1 : 0,
      DEV_TEAM_ACTIVITY: b % 2, DEV_TRAINING_ATTEND: b % 7 === 4 ? 1 : 0,
    }),
  },
  {
    key: 'novi', days: span(41, (b) => b % 4 === 3), pacing: true,
    counts: (b) => ({
      LEADS_GEN_ACTIVITY: 1, LEADS_NEW_PROSPECT: b % 5 === 0 ? 1 : 0, LEADS_CONTACTED: 2 + (b % 3),
      SELL_PRESENTATION: b % 2, SELL_FOLLOWUP: b % 3 === 1 ? 1 : 0, SELL_SUBMISSION: b % 8 === 0 ? 1 : 0,
      RECRUIT_FOLLOWUP: b % 7 === 2 ? 1 : 0, DEV_TRAINING_ATTEND: b % 7 === 6 ? 1 : 0,
    }),
  },
  {
    key: 'wahyu', days: span(41, (b) => b % 3 === 2), sellingFreeThisMonth: true,
    counts: (b) => ({
      LEADS_GEN_ACTIVITY: 1, LEADS_NEW_PROSPECT: b % 4 === 0 ? 1 : 0, LEADS_CONTACTED: 2,
      SELL_PRESENTATION: b % 4 === 1 ? 1 : 0, SELL_FOLLOWUP: b % 2, DEV_TRAINING_ATTEND: b % 7 === 0 ? 1 : 0,
    }),
  },
  {
    // Four weeks: the second membership is about that old (her return was approved 28 days ago).
    key: 'yanti', days: span(27, (b) => b % 5 === 3), pacing: true,
    counts: (b) => ({
      LEADS_GEN_ACTIVITY: b % 2, LEADS_NEW_PROSPECT: b % 6 === 0 ? 1 : 0, LEADS_CONTACTED: 2 + (b % 3),
      SELL_PRESENTATION: b % 3 === 0 ? 1 : 0, SELL_FOLLOWUP: b % 4 === 2 ? 1 : 0,
      SELL_SUBMISSION: b % 10 === 0 ? 1 : 0, DEV_TRAINING_ATTEND: b % 7 === 5 ? 1 : 0,
    }),
  },
  {
    /*
     * **Weeks of development and nothing that a ratio divides by.** Newly promoted, Dewi is on the AAB
     * track: training, team sessions, a prospect's name now and then. No code here is any ratio's
     * denominator, so every ratio card of hers still reads *Not enough data* (Phase 10's case), and no
     * cascade code either, so she is not pacing. Day 1 is left to her day of zeroes (OD-30).
     */
    key: 'dewi', days: span(35, (b) => b % 4 === 0, 2),
    counts: (b) => ({
      DEV_TRAINING_ATTEND: 1, DEV_TEAM_ACTIVITY: b % 2, LEADS_NEW_PROSPECT: b % 5 === 0 ? 1 : 0,
    }),
  },
  {
    /*
     * **Four steady weeks, a month and more ago**, then one day nine days ago (the day the Owner's
     * compliance list chases him for), then nothing. Every day here is 32 or more days back, so none is
     * in the current month, nor in the 30-day ratio window — *his ratios rest on too little to make
     * one*, as Phase 10 has it.
     */
    key: 'budi', days: span(59, (b) => b % 6 === 1, 32),
    counts: (b) => ({
      LEADS_GEN_ACTIVITY: 1, LEADS_NEW_PROSPECT: b % 3 === 0 ? 1 : 0, LEADS_CONTACTED: 2 + (b % 2),
      SELL_PRESENTATION: b % 3 === 2 ? 1 : 0, SELL_FOLLOWUP: b % 4 === 0 ? 1 : 0,
      SELL_SUBMISSION: b % 13 === 0 ? 1 : 0, RECRUIT_PRESENTATION: b % 5 === 0 ? 1 : 0,
    }),
  },
];

/** The goal's three cascade codes, which the month's attainment counts (`PACING_TO_MAA`, §A.2). */
export const CASCADE_CODES: readonly string[] = [
  CASCADE_ACTIVITY_CODES.leadsCode, CASCADE_ACTIVITY_CODES.appointmentsCode, CASCADE_ACTIVITY_CODES.closingsCode,
];

/**
 * How far above the threshold the seed sets a pacing member's month. A margin, not a definition: it is
 * here so that a reader of the roster never meets a member who paces by one count.
 */
const PACING_MARGIN = 1.25;

/**
 * **The month's cascade total that makes a member `PACING_TO_MAA` at any APE target.**
 *
 * `projectedSubmissions = closings × logged ÷ (leads + appointments + closings)`, with the targets the
 * cascade gives this month's APE target (§A.2, as `functional/coaching.md` corrects it). The ratio
 * `(leads + appointments + closings) ÷ closings` is largest when the month asks for one closing, where
 * every ceiling in the cascade rounds up the most, so a total above it keeps the projection at one
 * policy or more whatever the target turns out to be. It depends on the goal's rates alone, and so on
 * nothing the month's production or the day of the month can move.
 */
export function pacingFloor(rates: { caseSizeMinor: number; closingRatePct: number; leadsToApptPct: number }): number {
  const one = cascadeCounts(rates.caseSizeMinor, rates);
  return Math.ceil(((one.leads + one.appointments + one.policies) / one.policies) * PACING_MARGIN);
}

export interface CoachingLeadPlan {
  owner: CoacheeKey;
  name: string;
  type: 'sales' | 'recruitment';
  path: string[];
  nextActionIn?: number;
  nextActionNote?: string;
  /**
   * Promised for the current month. `'unless-held'` is promised only when the owner has no open lead
   * promised for it already: Rina's and Budi's Phase 7 leads carry this month's promise on a fresh seed,
   * and last month's on a database seeded before the month turned.
   */
  thisMonth: boolean | 'unless-held';
  remarks?: string;
  source?: string;
}

/**
 * **Open leads for every coachee** (AC-2): at least one with a next action date, and exactly one promised
 * this month *with* a date, which every finalize checks (`LEAD_THIS_MONTH_UNDATED`).
 *
 * **One lead is promised this month with no date**: Siti's *Pak Fauzan Akbar*. Nobody's seeded session
 * is with Siti, so it blocks none of the finalized sessions the fixture holds — and a session a walker
 * starts with her refuses to finalize until the lead has a date, which is the fifth check, on purpose.
 */
export const COACHING_LEADS: readonly CoachingLeadPlan[] = [
  { owner: 'indah', name: 'Ibu Melati Kusumawardani', type: 'sales', path: ['NOT_YET_APPROACHED', 'FOLLOW_UP', 'POLICY_SUBMITTED'], nextActionIn: 2, nextActionNote: 'Collect the signed SPAJ.', thisMonth: true, source: 'Referral — Pak Gilang' },
  { owner: 'indah', name: 'Pak Gilang Ramadhan', type: 'sales', path: ['NOT_YET_APPROACHED', 'FOLLOW_UP'], nextActionIn: 5, nextActionNote: 'Second meeting, with his wife.', thisMonth: false },
  { owner: 'indah', name: 'Ibu Shinta Maharani', type: 'sales', path: ['NOT_YET_APPROACHED'], thisMonth: false, remarks: 'Asked about a plan for her parents.' },
  { owner: 'dimas', name: 'Pak Bayu Firmansyah', type: 'sales', path: ['NOT_YET_APPROACHED', 'FOLLOW_UP'], nextActionIn: 3, nextActionNote: 'Present the education plan.', thisMonth: true },
  { owner: 'dimas', name: 'Ibu Ayu Pertiwi', type: 'sales', path: ['NOT_YET_APPROACHED'], nextActionIn: 9, nextActionNote: 'First call, after payday.', thisMonth: false },
  { owner: 'dimas', name: 'Pak Teddy Kurniadi', type: 'sales', path: ['NOT_YET_APPROACHED'], thisMonth: false },
  { owner: 'siti', name: 'Ibu Ratih Purnamasari', type: 'sales', path: ['NOT_YET_APPROACHED', 'FOLLOW_UP'], nextActionIn: 4, nextActionNote: 'Call back about the health rider.', thisMonth: true },
  { owner: 'siti', name: 'Pak Fauzan Akbar', type: 'sales', path: ['NOT_YET_APPROACHED', 'FOLLOW_UP'], thisMonth: true, remarks: 'Promised for this month; no meeting booked yet.' },
  { owner: 'siti', name: 'Ibu Nurul Aini', type: 'sales', path: ['NOT_YET_APPROACHED'], nextActionIn: 12, nextActionNote: 'Send the brochure.', thisMonth: false },
  { owner: 'arief', name: 'Pak Irwan Setiadi', type: 'sales', path: ['NOT_YET_APPROACHED', 'FOLLOW_UP', 'POLICY_SUBMITTED'], nextActionIn: 1, nextActionNote: 'Confirm the medical check.', thisMonth: true },
  { owner: 'arief', name: 'Sdri. Kadek Widiastuti', type: 'recruitment', path: ['NOT_APPROACHED', 'MEETING_SCHEDULED'], nextActionIn: 6, nextActionNote: 'Recruitment presentation at the branch.', thisMonth: false },
  { owner: 'arief', name: 'Ibu Yuliana Tanjung', type: 'sales', path: ['NOT_YET_APPROACHED'], thisMonth: false },
  { owner: 'novi', name: 'Pak Agung Wicaksono', type: 'sales', path: ['NOT_YET_APPROACHED', 'FOLLOW_UP'], nextActionIn: 2, nextActionNote: 'Walk through the illustration again.', thisMonth: true },
  { owner: 'novi', name: 'Ibu Citra Ananda', type: 'sales', path: ['NOT_YET_APPROACHED'], nextActionIn: 8, thisMonth: false },
  { owner: 'wahyu', name: 'Pak Dedi Supriadi', type: 'sales', path: ['NOT_YET_APPROACHED', 'FOLLOW_UP'], nextActionIn: 6, nextActionNote: 'Ask for the decision.', thisMonth: true },
  { owner: 'wahyu', name: 'Ibu Eka Wulandari', type: 'sales', path: ['NOT_YET_APPROACHED'], nextActionIn: -3, nextActionNote: 'Call back — she asked for Monday.', thisMonth: false },
  { owner: 'sari', name: 'Pak Hasan Basri', type: 'sales', path: ['NOT_YET_APPROACHED', 'FOLLOW_UP'], nextActionIn: 3, nextActionNote: 'Bring the family-protection illustration.', thisMonth: true },
  { owner: 'sari', name: 'Sdri. Anisa Rahma', type: 'recruitment', path: ['NOT_APPROACHED', 'MEETING_SCHEDULED'], nextActionIn: 7, nextActionNote: "Invite her to Thursday's BOP.", thisMonth: false },
  { owner: 'dewi', name: 'Ibu Sekar Arum', type: 'sales', path: ['NOT_YET_APPROACHED', 'FOLLOW_UP'], nextActionIn: 5, nextActionNote: 'Meet at her shop after closing.', thisMonth: true },
  { owner: 'yanti', name: 'Pak Rahmat Sulistyo', type: 'sales', path: ['NOT_YET_APPROACHED', 'FOLLOW_UP'], nextActionIn: 2, nextActionNote: 'Bring the revised premium.', thisMonth: true },
  { owner: 'yanti', name: 'Ibu Tari Anjani', type: 'sales', path: ['NOT_YET_APPROACHED'], nextActionIn: 10, thisMonth: false },
  { owner: 'rina', name: 'Ibu Kartika Dewanti', type: 'sales', path: ['NOT_YET_APPROACHED', 'FOLLOW_UP'], nextActionIn: 6, nextActionNote: 'Coffee after her shift.', thisMonth: 'unless-held' },
  { owner: 'budi', name: 'Pak Galih Prakoso', type: 'sales', path: ['NOT_YET_APPROACHED'], nextActionIn: 5, nextActionNote: 'First call.', thisMonth: 'unless-held' },
];
