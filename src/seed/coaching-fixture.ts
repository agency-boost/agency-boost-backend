/**
 * **The coaching fixture** (P11-T2 AC-3): the demo's sessions, capability ticks and leader notes,
 * defined here and **inserted by the task that builds their collection** — `coachingSessions` by
 * P11-T5, `coachingProfiles` and `leaderNotes` by P11-T9. Nothing here writes. `demo.ts` builds it from
 * the rows it has just seeded and hands it back from `seedDemo()`, so the inserting task adds one loop.
 *
 * ## Which member shows which roster state, and why (AC-4)
 *
 * The roster is the demo AB's: **Agus** (`agus@kpm0417.test`) reaches everybody below him (ADR-0074).
 * *Status* is `GOAL_PACE_STATUS` on the calendar month (`metrics-and-definitions.md` §A.4, ADR-0080):
 * no goal for the office's year is *No goal set*; then not `PACING_TO_MAA` is *Needs attention*; then
 * this month's APE over `MONTHLY_APE_TARGET` at `PACE_ON_TRACK_RATIO` (0.90) or more is *On track*, and
 * anything less *Watch closely*. `PACING_TO_MAA` (§A.2, as `functional/coaching.md` corrects it) is
 * `closings × logged ÷ (leads + appointments + closings) ≥ 1`, the targets being the cascade on this
 * month's APE target and `logged` the month's count on the goal's three cascade codes. *Last 1:1* is
 * `DAYS_SINCE_LAST_COACHING` over the sessions below once P11-T5 inserts them; overdue is more than the
 * office's `coachingOverdueDays` (7 on the seed).
 *
 * | Member · rung · leader | Status | Why | Last 1:1 |
 * |---|---|---|---|
 * | Indah Permatasari · Agent · Agus | **On track** | This month's APE is 1.25 × her monthly target, worked out from the year to date the office holds (`coaching-cast.ts`); her month's cascade count is topped up past `pacingFloor` (40% / 40%: 15) | **4 days ago**, Agus — *recent*. Agus also has a **draft** open with her today, which does not count |
 * | Arief Hidayat · AAB · Agus | **On track** | APE 1.30 × target; pacing as Indah | No 1:1 yet |
 * | Dimas Pratama · Agent · Agus | **Watch closely** | Pacing (floor 17 at 35% / 35%); APE 0.40 × target | No 1:1 yet |
 * | Novi Andriani · Agent · Arief | **Watch closely** | Pacing (17); APE 0.35 × target | No 1:1 yet |
 * | Yanti Kusuma (her second membership) · Agent · Sari | **Watch closely** | Pacing (24 at 30% / 30%); not in this month's file, so no APE is held for the month (Phase 9's two members left out) | No 1:1 yet. Her **first** membership, removed, has one with Sari: a former coachee's, which the roster never reads |
 * | Rina Wijaya · Agent · Sari | **Watch closely**, from September to April; **On track** from May to August on a seed run in those months | Pacing (24). Her APE is Phase 9's formula figure against her 500 M plan: in October Rp 13 M of a Rp 142.7 M month (9%); from May to August the same formula puts her month above 90% of a smaller target. P11-T6 should check her against the month it runs in, and the designated rows above for the fixed answers | **Today**, Sari — the third of three weekly sessions |
 * | Siti Rahmawati · Agent · Agus | **Needs attention** | Logs almost daily, but nothing on the three cascade codes this month: attainment 0, projected 0 | No 1:1 yet. She holds the one lead promised this month with **no next action date** (*Pak Fauzan Akbar*), so a session with her refuses to finalize until it has one (`LEAD_THIS_MONTH_UNDATED`) |
 * | Wahyu Saputra · Agent · Arief | **Needs attention** | As Siti | No 1:1 yet |
 * | Dewi Lestari · AAB, leads nobody · Agus | **Needs attention** | Weeks of training and team development, no cascade code at all — and no ratio denominator, so her ratio cards stay *Not enough data* | No 1:1 yet |
 * | Budi Santoso · Agent · Sari | **Needs attention** | Four weeks of selling a month ago and more, one day nine days ago, nothing since: at most that day's three counts this month | No 1:1 yet |
 * | Sari Puspita · AAB · Agus | **No goal set** | No goal saved for the year — the one coachee without one (AC-2) | **12 days ago**, Agus — *overdue*: `coachingOverdueDays + 5`. Her two sessions with Agus are a leader's own history as a coachee, for `/coaching/me` |
 *
 * Every state the roster draws is there: *No 1:1 yet*, *Today*, a recent one and an overdue one; *On
 * track*, *Watch closely*, *Needs attention* and *No goal set*. The statuses are computed by P11-T6,
 * which checks them on the seed; `coaching-seed.spec.ts` pins the inputs that produce them.
 *
 * ## What the fixture holds
 *
 * - **Rina's three weekly sessions with Sari**, a week apart and the last today: typed action items
 *   with due dates, lead-derived ones (*Leads · {name}*), tips, and in each later session *last week's
 *   items* — some ticked done, the rest carried forward. Only Sari edits them (ADR-0081).
 * - **Agus's session with Indah four days ago, and his open draft with her today** — *the* open draft,
 *   one per coach and coachee (ADR-0081): one of last week's items ticked, the other two carried
 *   **undated**, so finalizing it asks for their dates first.
 * - **Sari's two sessions with Agus**, the leader's own history as a coachee of the AB.
 * - **A former coachee's session** (ADR-0088): one Sari led with Yanti's **first** membership, five days
 *   after its edge under Sari opened and before Yanti left — dated from that edge as the office holds it,
 *   so every run dates it inside the same edge. Sari no longer coaches that membership, so
 *   `GET /coaching/me/sessions` lists it under `ledFormerly` for her, and the roster never shows it:
 *   Yanti's second membership, the one Sari coaches now, still reads *No 1:1 yet* (invariant §2).
 * - **Capability ticks** (by catalog code, ADR-0025) and **a leader note** for Rina (Sari's) and for
 *   Indah (Agus's). Under ADR-0073 Agus — and the Owner, the root AB — read Sari's note about Rina as
 *   her ancestors; Rina never does, and Sari never reads Agus's.
 *
 * ## How the inserting task uses it
 *
 * - **Field names are `erd.md`'s** for `coachingSessions`, `coachingProfiles` and `leaderNotes`.
 * - **Every `_id` is derived** from the office, the pair and the row's slot (`seedObjectId`), so it is
 *   the row's natural key: insert a row when its `_id` is absent and leave it when present. A re-seed
 *   without `--reset` then duplicates nothing, and a session somebody went on to finalize in a walk is
 *   never written over (AC-6). Session ids are known before insert, so `lastWeek.sessionId` resolves.
 * - **Every date is relative to the run's today in `Asia/Jakarta`** (AC-5), through the codebase's day
 *   helpers. A row is dated by the run that writes it; a later run without `--reset` keeps it, as it
 *   keeps the leads' next action dates — `--reset` before a rehearsal is what makes *Today* today again.
 * - **`snapshot` is `null` here** and is P11-T5's to take as it inserts a finalized session, with
 *   finalize's own snapshot builder, as of the session's `date` and `frozenAt`. A seeded snapshot and a
 *   real one are then one computation, and its activity targets use the constants P11-T4 adds rather
 *   than a copy of them here (invariant §7).
 * - `version` counts writes: *Start* is 1, each save one more, finalize one more. A finalized session
 *   here was started, saved once and finalized (3); the draft was started and saved once (2).
 */
import { createHash } from 'node:crypto';
import type { Clock } from '@/common/clock/clock.port';
import { addDays, type LocalDate } from '@/common/time/local-day';
import type { CoacheeKey, RosterStatus } from './coaching-cast';

/** A 24-hex id derived from its parts: the same row gets the same id on every run (AC-6). */
export function seedObjectId(...parts: readonly string[]): string {
  return createHash('sha256').update(parts.join('|')).digest('hex').slice(0, 24);
}

/** The roster's *Last 1:1*, as the fixture plans it. */
export type LastOneToOne = 'none' | 'today' | 'recent' | 'overdue';

export interface RosterPlanRow {
  status: RosterStatus;
  /** Rina: *On track* instead in the months the header names. Every other row is fixed. */
  monthDependent?: true;
  lastOneToOne: LastOneToOne;
}

/** The table above, as data: the seed's spec and its printed guide read it. */
export const ROSTER_PLAN: Readonly<Record<CoacheeKey, RosterPlanRow>> = {
  indah: { status: 'on_track', lastOneToOne: 'recent' },
  arief: { status: 'on_track', lastOneToOne: 'none' },
  dimas: { status: 'watch_closely', lastOneToOne: 'none' },
  novi: { status: 'watch_closely', lastOneToOne: 'none' },
  yanti: { status: 'watch_closely', lastOneToOne: 'none' },
  rina: { status: 'watch_closely', monthDependent: true, lastOneToOne: 'today' },
  siti: { status: 'needs_attention', lastOneToOne: 'none' },
  wahyu: { status: 'needs_attention', lastOneToOne: 'none' },
  dewi: { status: 'needs_attention', lastOneToOne: 'none' },
  budi: { status: 'needs_attention', lastOneToOne: 'none' },
  sari: { status: 'no_goal_set', lastOneToOne: 'overdue' },
};

// ------------------------------------------------------------------ the rows, by erd.md's names

export interface LastWeekItemSeed {
  itemId: string;
  text: string;
  dueDate: LocalDate | null;
  leadId: string | null;
  leadName: string | null;
  done: boolean;
}

export interface ActionItemSeed {
  itemId: string;
  text: string;
  dueDate: LocalDate | null;
  carriedFromItemId: string | null;
}

export interface TipSeed {
  tipId: string;
  text: string;
  carriedFromTipId: string | null;
}

export interface LeadActionSeed {
  leadId: string;
  leadName: string;
  dueDate: LocalDate;
  text: string;
}

/** `corrections[]`'s shape. None is seeded: no fixture session has been reopened. */
export interface CorrectionSeed {
  version: number;
  lastWeekItems: LastWeekItemSeed[];
  actionItems: ActionItemSeed[];
  tips: TipSeed[];
  leadActions: LeadActionSeed[];
  finalizedAt: Date;
  finalizedByMembershipId: string;
  at: Date;
  byMembershipId: string;
  reason: string;
}

export interface CoachingSessionSeed {
  _id: string;
  kpmId: string;
  coachMembershipId: string;
  coacheeMembershipId: string;
  status: 'draft' | 'finalized';
  /** The office's day of the first finalize; `null` on a draft. */
  date: LocalDate | null;
  lastWeek: { sessionId: string; version: number; date: LocalDate } | null;
  lastWeekItems: LastWeekItemSeed[];
  actionItems: ActionItemSeed[];
  tips: TipSeed[];
  /** Taken at finalize; empty on a draft, whose list is derived from the coachee's leads on each read. */
  leadActions: LeadActionSeed[];
  /** P11-T5 fills it as it inserts a finalized session; see the header. */
  snapshot: null;
  finalizedAt: Date | null;
  finalizedByMembershipId: string | null;
  version: number;
  frozenAt: Date | null;
  corrections: CorrectionSeed[];
  deletedAt: null;
  createdAt: Date;
  createdBy: string;
  updatedAt: Date;
  updatedBy: string;
}

export interface CoachingProfileSeed {
  _id: string;
  kpmId: string;
  coacheeMembershipId: string;
  milestoneCodes: string[];
  skillCodes: string[];
  version: number;
  revisions: { version: number; milestoneCodes: string[]; skillCodes: string[]; at: Date; byMembershipId: string }[];
  deletedAt: null;
  createdAt: Date;
  createdBy: string;
  updatedAt: Date;
  updatedBy: string;
}

export interface LeaderNoteSeed {
  _id: string;
  kpmId: string;
  authorMembershipId: string;
  coacheeMembershipId: string;
  text: string;
  version: number;
  revisions: { version: number; text: string; at: Date }[];
  deletedAt: null;
  createdAt: Date;
  createdBy: string;
  updatedAt: Date;
  updatedBy: string;
}

export interface CoachingFixture {
  /** The run's today in the office's zone: every date below counts from it. */
  today: LocalDate;
  sessions: CoachingSessionSeed[];
  profiles: CoachingProfileSeed[];
  notes: LeaderNoteSeed[];
}

/** A lead as the fixture needs it: the session's lead-derived items name it and carry its date. */
export interface FixtureLead {
  id: string;
  name: string;
  nextActionDate: LocalDate | null;
  nextActionNote: string | null;
}

export interface CoachingFixtureInput {
  kpmId: string;
  /** The run's clock: `now()` and the office's day boundaries. */
  clock: Clock;
  timezone: string;
  /** The office's `coachingOverdueDays`, from its settings. */
  coachingOverdueDays: number;
  /** Membership ids — the foreign key on every coaching record (invariant §2). */
  members: { agus: string; sari: string; rina: string; indah: string };
  /**
   * Yanti's first membership, removed since, and the leader edge it had under Sari — `validFrom` and the
   * instant it closed — as the office's membership history holds them. Sari's session with her rests on
   * that edge (ADR-0088's demo case).
   */
  formerCoachee: { membershipId: string; edge: { validFrom: Date; validTo: Date } };
  /** The three coachees' leads as they stand, deleted ones excluded. */
  leads: { rina: readonly FixtureLead[]; sari: readonly FixtureLead[]; indah: readonly FixtureLead[] };
  /** The office's capability catalog, active codes only: a tick names a code it holds (ADR-0025). */
  catalog: { milestoneCodes: readonly string[]; skillCodes: readonly string[] };
}

// ------------------------------------------------------------------ building a pair's sessions

interface SessionSpec {
  /** Stable within the pair: the `_id` is derived from it. */
  slot: string;
  daysAgo: number;
  status: 'draft' | 'finalized';
  /** Indexes into last week's items, in order: its typed items, then its lead-derived ones. */
  done?: readonly number[];
  /** Days after this session that a carried item is due; `null` leaves it undated, as *Start* does. */
  carryDueIn?: number | null;
  newItems: readonly { text: string; dueIn: number }[];
  /** Indexes into last week's tips that are carried, as written. */
  keepTips?: readonly number[];
  newTips: readonly string[];
  /** A finalized session's *From leads (automatic)*: named leads, or every dated lead as it stands. */
  leadActions?: readonly { lead: string; dueIn: number }[] | 'as-they-stand';
}

const FINALIZED_VERSION = 3;
const DRAFT_VERSION = 2;
/** Days after the former coachee's edge opened that Sari's session with her was held. */
const FORMER_SESSION_DAYS_IN = 5;

export function buildCoachingFixture(input: CoachingFixtureInput): CoachingFixture {
  const { kpmId, clock, timezone, members } = input;
  const now = clock.now();
  const today = clock.localDateFor(timezone, now);
  const startOfToday = clock.startOfLocalDay(timezone, today);

  /** An instant on an office day; on today, never later than now. */
  const at = (day: LocalDate, hours: number, minutes: number, minutesBeforeNow: number): Date => {
    if (day !== today) {
      return new Date(clock.startOfLocalDay(timezone, day).getTime() + (hours * 60 + minutes) * 60_000);
    }
    const wanted = now.getTime() - minutesBeforeNow * 60_000;
    return new Date(Math.min(now.getTime(), Math.max(startOfToday.getTime(), wanted)));
  };

  const leadText = (lead: FixtureLead) => lead.nextActionNote ?? `Follow up with ${lead.name}`;

  const chain = (
    coach: string,
    coachee: string,
    leads: readonly FixtureLead[],
    specs: readonly SessionSpec[],
  ): CoachingSessionSeed[] => {
    const byName = new Map(leads.map((lead) => [lead.name, lead]));
    const built: CoachingSessionSeed[] = [];

    for (const spec of specs) {
      const id = seedObjectId('coachingSession', kpmId, coach, coachee, spec.slot);
      const day = addDays(today, -spec.daysAgo);
      const previous = built.at(-1) ?? null;
      const finalized = spec.status === 'finalized';

      // Last week: the previous session's typed items, then its lead-derived ones, ticked here.
      const lastWeekItems: LastWeekItemSeed[] = previous
        ? [
            ...previous.actionItems.map((item) => ({
              itemId: item.itemId, text: item.text, dueDate: item.dueDate, leadId: null, leadName: null,
            })),
            ...previous.leadActions.map((action) => ({
              itemId: seedObjectId('leadItem', previous._id, action.leadId), text: action.text,
              dueDate: action.dueDate, leadId: action.leadId, leadName: action.leadName,
            })),
          ].map((item, i) => ({ ...item, done: (spec.done ?? []).includes(i) }))
        : [];

      // Carried: what was not done — except a lead item whose lead still has a date, which *From leads*
      // lists live (ADR-0081).
      const carried = lastWeekItems.filter((item) => !item.done && (
        item.leadId === null || !leads.some((lead) => lead.id === item.leadId && lead.nextActionDate !== null)
      ));
      const carryDue = spec.carryDueIn === undefined || spec.carryDueIn === null ? null : addDays(day, spec.carryDueIn);
      const actionItems: ActionItemSeed[] = [
        ...carried.map((item) => ({
          itemId: seedObjectId('item', id, 'carried', item.itemId), text: item.text, dueDate: carryDue,
          carriedFromItemId: item.itemId,
        })),
        ...spec.newItems.map((item, n) => ({
          itemId: seedObjectId('item', id, String(n)), text: item.text, dueDate: addDays(day, item.dueIn),
          carriedFromItemId: null,
        })),
      ];

      const tips: TipSeed[] = [
        ...(spec.keepTips ?? []).map((i) => previous!.tips[i]).map((tip) => ({
          tipId: seedObjectId('tip', id, 'carried', tip.tipId), text: tip.text, carriedFromTipId: tip.tipId,
        })),
        ...spec.newTips.map((text, n) => ({ tipId: seedObjectId('tip', id, String(n)), text, carriedFromTipId: null })),
      ];

      const named = (name: string): FixtureLead => {
        const lead = byName.get(name);
        if (!lead) throw new Error(`The coaching fixture names a lead the seed did not write: ${name}`);
        return lead;
      };
      const leadActions: LeadActionSeed[] = !finalized ? [] : spec.leadActions === 'as-they-stand'
        ? leads.filter((lead) => lead.nextActionDate !== null)
          .map((lead) => ({ leadId: lead.id, leadName: lead.name, dueDate: lead.nextActionDate!, text: leadText(lead) }))
        : (spec.leadActions ?? []).map(({ lead, dueIn }) => {
            const found = named(lead);
            return { leadId: found.id, leadName: found.name, dueDate: addDays(day, dueIn), text: leadText(found) };
          });
      // Nearest first, as the list is drawn (`:11041-11059`).
      leadActions.sort((a, b) => a.dueDate.localeCompare(b.dueDate) || a.leadName.localeCompare(b.leadName));

      const startedAt = at(day, 9, 30, 50);
      const closedAt = at(day, 10, 15, 10);
      built.push({
        _id: id,
        kpmId,
        coachMembershipId: coach,
        coacheeMembershipId: coachee,
        status: spec.status,
        date: finalized ? day : null,
        lastWeek: previous ? { sessionId: previous._id, version: previous.version, date: previous.date! } : null,
        lastWeekItems,
        actionItems,
        tips,
        leadActions,
        snapshot: null,
        finalizedAt: finalized ? closedAt : null,
        finalizedByMembershipId: finalized ? coach : null,
        version: finalized ? FINALIZED_VERSION : DRAFT_VERSION,
        frozenAt: finalized ? closedAt : null,
        corrections: [],
        deletedAt: null,
        createdAt: startedAt,
        createdBy: coach,
        updatedAt: closedAt,
        updatedBy: coach,
      });
    }
    return built;
  };

  const overdue = input.coachingOverdueDays;
  // Recent: inside the window, and not today. Overdue: past it by five days.
  const recent = Math.max(1, Math.min(4, overdue));

  const rinaWeekly = chain(members.sari, members.rina, input.leads.rina, [
    {
      slot: 'weekly-1', daysAgo: 14, status: 'finalized',
      newItems: [
        { text: "Book three presentations from Thursday's BOP names", dueIn: 3 },
        { text: 'Practise the critical-illness objection with Sari before Friday', dueIn: 4 },
        { text: 'Log activity every day this week, the quiet days included', dueIn: 6 },
      ],
      newTips: [
        // The prototype's own example tip (`Overall.html:10692-10699`).
        'Slow down on the opening line — let the client finish before pitching.',
        'Ask for the referral before you leave, not on the follow-up call.',
      ],
      leadActions: [{ lead: 'Pak Hendro Gunawan', dueIn: 1 }, { lead: 'Ibu Wulan Sari', dueIn: 2 }],
    },
    {
      slot: 'weekly-2', daysAgo: 7, status: 'finalized',
      // Last week: three typed items, then Pak Hendro and Ibu Wulan. Two typed items and the handover done.
      done: [0, 1, 4], carryDueIn: 6,
      newItems: [
        { text: 'Prepare a needs analysis for Pak Surya before calling him', dueIn: 2 },
        { text: 'Shadow Sari on one presentation', dueIn: 5 },
      ],
      keepTips: [0, 1],
      newTips: ['Send the illustration the same day you present it.'],
      leadActions: [{ lead: 'Pak Hendro Gunawan', dueIn: 1 }, { lead: 'Ibu Kartika Dewanti', dueIn: 4 }],
    },
    {
      slot: 'weekly-3', daysAgo: 0, status: 'finalized',
      // Last week: the carried item, two new ones, then Pak Hendro and Ibu Kartika. Pak Hendro still waits.
      done: [0, 1, 4], carryDueIn: 3,
      newItems: [
        { text: "Close Pak Hendro's illustration, or mark the lead lost", dueIn: 2 },
        { text: "Book two appointments from this month's referrals", dueIn: 5 },
      ],
      keepTips: [2],
      newTips: ['Keep the follow-up note on the lead itself, so the next 1:1 sees it.'],
      leadActions: 'as-they-stand',
    },
  ]);

  const indahSessions = chain(members.agus, members.indah, input.leads.indah, [
    {
      slot: 'session-1', daysAgo: recent, status: 'finalized',
      newItems: [
        { text: 'Ask Ibu Melati for two referrals at the policy handover', dueIn: 3 },
        { text: 'Run the education-plan comparison for Pak Gilang', dueIn: 5 },
        { text: 'Block Tuesday mornings for prospecting calls', dueIn: 6 },
      ],
      newTips: [
        "Lead with the family's goal, then the product.",
        'Confirm the next meeting before you leave the current one.',
      ],
      leadActions: [{ lead: 'Ibu Melati Kusumawardani', dueIn: 2 }, { lead: 'Pak Gilang Ramadhan', dueIn: 5 }],
    },
    {
      // The open draft: started today, saved once with the referral item ticked.
      slot: 'session-2', daysAgo: 0, status: 'draft',
      done: [0], carryDueIn: null,
      newItems: [{ text: "Review Ibu Shinta's needs analysis together", dueIn: 3 }],
      keepTips: [0, 1],
      newTips: [],
    },
  ]);

  const sariAsCoachee = chain(members.agus, members.sari, input.leads.sari, [
    {
      slot: 'leader-1', daysAgo: overdue + 14, status: 'finalized',
      newItems: [
        { text: 'Hold a 1:1 with each agent in the unit this week', dueIn: 5 },
        { text: "Invite two candidates to Thursday's BOP", dueIn: 3 },
        { text: "Go through Budi's lapsed prospects with him", dueIn: 6 },
      ],
      newTips: ['Coach the agent, not the number.'],
      leadActions: [{ lead: 'Pak Hasan Basri', dueIn: 4 }],
    },
    {
      slot: 'leader-2', daysAgo: overdue + 5, status: 'finalized',
      done: [0, 1], carryDueIn: 3,
      newItems: [{ text: "Keep Rina's weekly 1:1 going, and add Budi to the rotation", dueIn: 5 }],
      keepTips: [0],
      newTips: ['Delegate the BOP invitations, so you keep your own prospecting time.'],
      leadActions: [{ lead: 'Pak Hasan Basri', dueIn: 3 }, { lead: 'Sdri. Anisa Rahma', dueIn: 5 }],
    },
  ]);

  /*
   * **A former coachee's session** (ADR-0088): dated from the edge itself rather than from today, so a run
   * on a later day — which rebuilds the fixture and inserts nothing — still dates it inside that edge.
   * The edge must hold the whole session, start to finalize, and the session must be in the past.
   */
  const former = input.formerCoachee;
  const formerDay = addDays(clock.localDateFor(timezone, former.edge.validFrom), FORMER_SESSION_DAYS_IN);
  const ledFormerly = chain(members.sari, former.membershipId, [], [
    {
      slot: 'former-1', daysAgo: clock.daysBetween(timezone, formerDay, today), status: 'finalized',
      newItems: [
        { text: 'List thirty names for your warm market, each with a phone number', dueIn: 3 },
        { text: 'Shadow Sari on one client meeting', dueIn: 4 },
        { text: 'Book your first two fact-finding meetings', dueIn: 6 },
      ],
      newTips: ['Write a new name down the day you meet them, not at the end of the week.'],
    },
  ]);
  for (const session of ledFormerly) {
    const held = session.createdAt > former.edge.validFrom && session.finalizedAt! < former.edge.validTo
      && session.finalizedAt! <= now;
    if (!held) {
      throw new Error(
        `The former coachee's edge (${former.edge.validFrom.toISOString()} to ${former.edge.validTo.toISOString()}) `
        + `cannot hold a session on ${session.date}`,
      );
    }
  }

  const sessions = [...rinaWeekly, ...indahSessions, ...sariAsCoachee, ...ledFormerly];
  const sessionAt = (sessionsOf: readonly CoachingSessionSeed[], slot: number, minutesAfter: number) =>
    new Date(sessionsOf[slot].createdAt.getTime() + minutesAfter * 60_000);

  // ------------------------------------------------------------ ticks, by the office's codes

  const has = (codes: readonly string[], known: readonly string[], what: string) => {
    const missing = codes.filter((code) => !known.includes(code));
    if (missing.length) throw new Error(`The office's capability catalog has no ${what} ${missing.join(', ')}`);
    return [...codes];
  };
  const milestones = (codes: readonly string[]) => has(codes, input.catalog.milestoneCodes, 'milestone');
  const skills = (codes: readonly string[]) => has(codes, input.catalog.skillCodes, 'skill item');

  const profiles: CoachingProfileSeed[] = [
    {
      _id: seedObjectId('coachingProfile', kpmId, members.rina),
      kpmId,
      coacheeMembershipId: members.rina,
      // Competent Producer: she sells on her own, not yet outside her network.
      milestoneCodes: milestones(['SELLS_INDEPENDENTLY']),
      skillCodes: skills(['LEADS_GEN', 'APPROACH', 'FACT_FINDING', 'PRESENTATION', 'CANDIDATE_LEADS_GEN']),
      version: 2,
      revisions: [{
        version: 1, milestoneCodes: [], skillCodes: skills(['LEADS_GEN', 'APPROACH']),
        at: sessionAt(rinaWeekly, 0, 50), byMembershipId: members.sari,
      }],
      deletedAt: null,
      createdAt: sessionAt(rinaWeekly, 0, 50),
      createdBy: members.sari,
      updatedAt: sessionAt(rinaWeekly, 1, 50),
      updatedBy: members.sari,
    },
    {
      _id: seedObjectId('coachingProfile', kpmId, members.indah),
      kpmId,
      coacheeMembershipId: members.indah,
      // Independent Producer: both selling milestones ticked.
      milestoneCodes: milestones(['SELLS_INDEPENDENTLY', 'SELLS_OUTSIDE_NETWORK']),
      skillCodes: skills(['LEADS_GEN', 'APPROACH', 'FACT_FINDING', 'PRODUCT_ADVISORY', 'PRESENTATION', 'OBJECTION_HANDLING']),
      version: 1,
      revisions: [],
      deletedAt: null,
      createdAt: sessionAt(indahSessions, 0, 50),
      createdBy: members.agus,
      updatedAt: sessionAt(indahSessions, 0, 50),
      updatedBy: members.agus,
    },
  ];

  // ------------------------------------------------------------ notes: the author's, never the coachee's

  const notes: LeaderNoteSeed[] = [
    {
      _id: seedObjectId('leaderNote', kpmId, members.rina, members.sari),
      kpmId,
      authorMembershipId: members.sari,
      coacheeMembershipId: members.rina,
      text: 'Strong on first meetings; loses momentum after the illustration. Pair her with a closer for two weeks before the quarter ends.',
      version: 2,
      revisions: [{
        version: 1,
        text: 'Eager, and logs every day. Needs help turning presentations into submissions.',
        at: sessionAt(rinaWeekly, 0, 55),
      }],
      deletedAt: null,
      createdAt: sessionAt(rinaWeekly, 0, 55),
      createdBy: members.sari,
      updatedAt: sessionAt(rinaWeekly, 1, 55),
      updatedBy: members.sari,
    },
    {
      _id: seedObjectId('leaderNote', kpmId, members.indah, members.agus),
      kpmId,
      authorMembershipId: members.agus,
      coacheeMembershipId: members.indah,
      text: 'Ready for a bigger book. Talk to her about the AAB track before the year ends.',
      version: 1,
      revisions: [],
      deletedAt: null,
      createdAt: sessionAt(indahSessions, 0, 55),
      createdBy: members.agus,
      updatedAt: sessionAt(indahSessions, 0, 55),
      updatedBy: members.agus,
    },
  ];

  return { today, sessions, profiles, notes };
}
