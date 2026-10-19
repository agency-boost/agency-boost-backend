/**
 * **The activation fixture** (Phase 13, *Seed*; `functional/activation.md`, *Seed*): every hire's 90-day
 * activation in the demo offices, defined here and inserted by `demo.ts` — nothing here writes.
 *
 * ## Which account shows what
 *
 * Days are the office's, counted from the run's today in `Asia/Jakarta`; the window is the office's 90.
 * **Links complete from each hire's own data the first time a read evaluates them** — the goal, the lead
 * and the four weeks of activity the coaching cast already holds — so the fixture ticks manual items only,
 * and an open activation's percentage below is what the first read shows.
 *
 * | Account | Activation | What it shows |
 * |---|---|---|
 * | `rina@kpm0417.test` (Agent, Sari) | **Day 59**, 8 of 16 (50%) | Her goal, leads and activity complete all three linked items from her real data. Three manual items ticked by her, two with her **note and date**; *Join KPM introduction session* and *Role play with leader* ticked by **Sari**, attributed. **Sari's coaching note**, which Rina reads on her page |
 * | `budi@kpm0417.test` (Agent, Sari) | **Day 62**, 6 of 16 | Part-way: two items of his, one of Sari's, and his three links |
 * | `removed@kpm0417.test` → Yanti (Agent, Sari) | **Day 29**, 5 of 16 | **The re-join**: her current membership's activation starts afresh; her first membership, removed, has none (ADR-0022) |
 * | `novi@kpm0417.test` (Agent, Arief) | **Day 85**, 9 of 16 | Her goal item done and attributed to **Arief**, who saved her goal (ADR-0046); three of Arief's ticks |
 * | `wahyu@kpm0417.test` (Agent, Arief) | **Day 87**, 5 of 16 | **A start date a leader corrected** (OD-118): Arief moved it from the day Wahyu joined here, 79 days ago, to his contract date a week earlier — audited with both dates |
 * | `siti@kpm0417.test` (Agent, Agus) | **Day 102, complete** | **Graduated** three days ago by her own *Mark activation complete →*, every item done, with the audit row. She has left every roster and her *New agent* section |
 * | `dimas@kpm0417.test` (Agent, Agus) | **Day 95**, 8 of 16 (50%), **overdue** | About half done and past the window: his day is red |
 * | `indah@kpm0417.test` (Agent, Agus) | **Day 98**, 15 of 16 (94%), **overdue** | One item short — *Reach Independent Agent milestone* — and red too. *Close first case independently* is done: the roster's *Active Agent* ✓ |
 * | `agent@kpm0555.test` → Lina (Agent, office 0555) | **Day 61**, her prospects item done from her leads | The other office's hire, which every cross-office test reads. Her start is the day she joined, 60 days back (`OFFICE_0555_JOINED_DAYS_AGO`) |
 *
 * **Who sees what.** Agus's *Your New Hires*: *Direct Unit* (Indah, Dimas), then the leader cards A to Z,
 * *AAB: Arief Hidayat* (Wahyu, Novi) and *AAB: Sari Puspita* (Budi, Rina, Yanti); Siti has left it, and Dewi,
 * who leads nobody, has no card.
 * Sari's and Arief's rosters are their own *Direct Unit*. **Sari, Dewi and Arief joined as Agents and were
 * promoted before this phase**, so the backfill, which reads the current rung, gives them none; nobody placed
 * as an AAB or an AB has one. The Owner, an AB at the top of the tree, reaches every hire, but their shell
 * has no field nav. **Not seeded:** an Agent with a direct report (OD-122's case) — adding a report to a
 * seeded Agent would move the coaching and calendar demos already reviewed, so that case is a test fixture.
 *
 * ## How it is built
 *
 * - **Field names are `erd.md`'s** for `activationProgress`; every item of the pinned version has its row,
 *   keyed by code, as a placement writes it. `origin` is `backfill`: these hires joined before Phase 13.
 * - **Every `_id` is derived** from the office and the membership (`seedObjectId`), so a re-seed without
 *   `--reset` writes only what is missing, and an activation somebody ticked in a walk is never written over.
 *   A row is dated by the run that writes it; `--reset` before a walk makes its days today's again.
 * - **The audit rows the stored writes would have left** — Wahyu's corrected start date, Siti's graduation
 *   and Sari's note — are derived the same way. The individual ticks carry their attribution on the item.
 */
import type { Clock } from '@/common/clock/clock.port';
import { addDays, type LocalDate } from '@/common/time/local-day';
import type {
  ActivationItemSource, ActivationItemState, ActivationRecordCollection,
} from '@/modules/activation/activation-progress.schema';
import { freshItemState } from '@/modules/activation/activation-rules';
import { seedObjectId } from './coaching-fixture';

/** The hires the fixture starts, and the leaders who tick, by the seed's keys. */
export type ActivationHireKey = 'rina' | 'budi' | 'yanti' | 'novi' | 'wahyu' | 'siti' | 'dimas' | 'indah' | 'lina';
export type ActivationLeaderKey = 'sari' | 'arief' | 'agus';

/** One published checklist version, as the fixture pins it. */
export interface PinnedVersionSeed {
  id: string;
  version: number;
  codes: readonly string[];
}

export interface ActivationFixtureInput {
  clock: Clock;
  timezone: string;
  kpm0417: string;
  kpm0555: string;
  versions: { kpm0417: PinnedVersionSeed; kpm0555: PinnedVersionSeed };
  /** Membership ids. */
  members: Record<ActivationHireKey | ActivationLeaderKey, string>;
  /** User ids, for the audit rows' actors. */
  users: Record<'sari' | 'arief' | 'siti', string>;
  /** When each hire joined, in days before the run (`demo.ts`, `coaching-cast.ts`). */
  joinedDaysAgo: Record<ActivationHireKey, number>;
  /** The records that completed Siti's three links before she graduated. */
  sitiRecords: { goal: string | null; lead: string | null; day: string | null };
}

/** One `activationProgress` row, by `erd.md`'s names. */
export interface ActivationSeed {
  _id: string;
  kpmId: string;
  membershipId: string;
  templateId: string;
  templateVersion: number;
  startDate: LocalDate;
  startCorrectedAt: Date | null;
  startCorrectedByMembershipId: string | null;
  origin: 'backfill';
  items: ActivationItemState[];
  note: { text: string; byMembershipId: string; at: Date } | null;
  graduatedAt: Date | null;
  graduatedByMembershipId: string | null;
  version: number;
  deletedAt: null;
  createdBy: null;
  updatedBy: string | null;
  createdAt: Date;
  updatedAt: Date;
}

/** An `auditLog` row a stored write would have left, ids only. */
export interface ActivationAuditSeed {
  _id: string;
  kpmId: string;
  actorUserId: string;
  effectiveUserId: null;
  actorMembershipId: string;
  onBehalfOf: boolean;
  action: string;
  targetCollection: 'activationProgress';
  targetId: string;
  targetMembershipId: string;
  before: Record<string, unknown> | null;
  after: Record<string, unknown> | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface ActivationFixture {
  /** The run's today in the office's zone. */
  today: LocalDate;
  activations: ActivationSeed[];
  audits: ActivationAuditSeed[];
}

/** A manual tick: the item, who ticked it, how many days after the start, and the hire's note and date. */
type Tick = [code: string, by: 'hire' | ActivationLeaderKey, afterStart: number, note?: string];

/** Sari's coaching note to Rina (OD-117). None of the six words. */
export const SARI_NOTE_TO_RINA =
  'Strong first two months — your prospect list keeps growing. Next: book your first Joint Field Work with me this week.';

export function buildActivationFixture(input: ActivationFixtureInput): ActivationFixture {
  const { clock, timezone, members } = input;
  const today = clock.localDateFor(timezone);
  const now = clock.now();
  /** 10:00 office time on a day before today; never later than the run. */
  const at = (date: LocalDate): Date => {
    const ten = new Date(clock.startOfLocalDay(timezone, date).getTime() + 10 * 3_600_000);
    return ten < now ? ten : now;
  };
  const activations: ActivationSeed[] = [];
  const audits: ActivationAuditSeed[] = [];

  const hire = (
    key: ActivationHireKey,
    leader: ActivationLeaderKey | null,
    ticks: readonly Tick[],
    over: Partial<Pick<ActivationSeed, 'startDate' | 'startCorrectedAt' | 'startCorrectedByMembershipId' | 'note' | 'graduatedAt' | 'graduatedByMembershipId'>> & {
      links?: Partial<Record<string, { at: Date; by: string; collection: ActivationRecordCollection; id: string | null }>>;
    } = {},
  ): ActivationSeed => {
    const kpmId = key === 'lina' ? input.kpm0555 : input.kpm0417;
    const version = key === 'lina' ? input.versions.kpm0555 : input.versions.kpm0417;
    const joinedOn = addDays(today, -input.joinedDaysAgo[key]);
    const membershipId = members[key];
    const items = new Map(version.codes.map((code) => [code, freshItemState(code)]));
    let latest = at(joinedOn);
    for (const [code, by, afterStart, note] of ticks) {
      const state = items.get(code);
      if (!state) continue;
      const date = addDays(joinedOn, afterStart);
      const source: ActivationItemSource = by === 'hire' ? 'hire' : 'leader';
      Object.assign(state, {
        done: true, doneAt: at(date), source, doneByMembershipId: by === 'hire' ? membershipId : members[by],
        note: note ?? null, date: note ? date : null,
      });
      if (at(date) > latest) latest = at(date);
    }
    for (const [code, link] of Object.entries(over.links ?? {})) {
      const state = items.get(code);
      if (!state || !link) continue;
      Object.assign(state, {
        done: true, doneAt: link.at, source: 'link', doneByMembershipId: link.by,
        recordCollection: link.id ? link.collection : null, recordId: link.id,
      });
    }
    const writes = ticks.length + (over.startCorrectedAt ? 1 : 0) + (over.note ? 1 : 0) + (over.graduatedAt ? 1 : 0);
    const stamps = [latest, over.startCorrectedAt, over.note?.at, over.graduatedAt].filter((d): d is Date => d instanceof Date);
    return {
      _id: seedObjectId('activation', kpmId, membershipId),
      kpmId,
      membershipId,
      templateId: version.id,
      templateVersion: version.version,
      startDate: over.startDate ?? joinedOn,
      startCorrectedAt: over.startCorrectedAt ?? null,
      startCorrectedByMembershipId: over.startCorrectedByMembershipId ?? null,
      origin: 'backfill',
      items: [...items.values()],
      note: over.note ?? null,
      graduatedAt: over.graduatedAt ?? null,
      graduatedByMembershipId: over.graduatedByMembershipId ?? null,
      version: 1 + writes,
      deletedAt: null,
      createdBy: null,
      updatedBy: writes > 0 ? (leader ? members[leader] : membershipId) : null,
      createdAt: at(joinedOn),
      updatedAt: new Date(Math.max(...stamps.map((d) => d.getTime()))),
    };
  };

  const audit = (
    row: ActivationSeed, action: string, by: { userId: string; membershipId: string }, when: Date,
    before: Record<string, unknown> | null = null, after: Record<string, unknown> | null = null,
  ): ActivationAuditSeed => ({
    _id: seedObjectId('activation-audit', row.kpmId, row.membershipId, action),
    kpmId: row.kpmId,
    actorUserId: by.userId,
    effectiveUserId: null,
    actorMembershipId: by.membershipId,
    onBehalfOf: by.membershipId !== row.membershipId,
    action,
    targetCollection: 'activationProgress',
    targetId: row._id,
    targetMembershipId: row.membershipId,
    before,
    after,
    createdAt: when,
    updatedAt: when,
  });

  // ---------------------------------------------------------------- under Sari

  const rinaNoteAt = at(addDays(today, -2));
  const rina = hire('rina', 'sari', [
    ['INSURANCE_BASICS', 'hire', 2, 'Read the starter pack with Sari in my first week.'],
    ['CAREER_MINDSET', 'hire', 5],
    ['COMPANY_PROFILE', 'hire', 6, 'Watched the company video twice and took notes.'],
    ['KPM_INTRO_SESSION', 'sari', 9],
    ['ROLE_PLAY', 'sari', 30],
  ], { note: { text: SARI_NOTE_TO_RINA, byMembershipId: members.sari, at: rinaNoteAt } });
  activations.push(rina);
  audits.push(audit(rina, 'activation.note_saved', { userId: input.users.sari, membershipId: members.sari }, rinaNoteAt));

  activations.push(hire('budi', 'sari', [
    ['INSURANCE_BASICS', 'hire', 1], ['CAREER_MINDSET', 'hire', 3], ['CRM_SETUP', 'sari', 12],
  ]));

  activations.push(hire('yanti', 'sari', [
    ['INSURANCE_BASICS', 'hire', 1, 'Second time round — quicker now.'], ['KPM_INTRO_SESSION', 'sari', 3],
  ]));

  // ---------------------------------------------------------------- under Arief

  activations.push(hire('novi', 'arief', [
    ['INSURANCE_BASICS', 'hire', 2], ['CAREER_MINDSET', 'hire', 4], ['COMPANY_PROFILE', 'hire', 4],
    ['KPM_INTRO_SESSION', 'arief', 7], ['CRM_SETUP', 'arief', 10], ['JOINT_FIELD_WORK', 'arief', 40],
  ]));

  // Joined here 79 days ago; his contract was signed a week before, and Arief corrected the start to it.
  const wahyuJoined = addDays(today, -input.joinedDaysAgo.wahyu);
  const wahyuStart = addDays(wahyuJoined, -7);
  const correctedAt = at(addDays(today, -10));
  const wahyu = hire('wahyu', 'arief', [['INSURANCE_BASICS', 'hire', 1], ['CRM_SETUP', 'arief', 9]], {
    startDate: wahyuStart, startCorrectedAt: correctedAt, startCorrectedByMembershipId: members.arief,
  });
  activations.push(wahyu);
  audits.push(audit(
    wahyu, 'activation.start_date_corrected', { userId: input.users.arief, membershipId: members.arief }, correctedAt,
    { startDate: wahyuJoined }, { startDate: wahyuStart },
  ));

  // ---------------------------------------------------------------- under Agus

  const sitiJoined = addDays(today, -input.joinedDaysAgo.siti);
  const sitiAt = (afterStart: number) => at(addDays(sitiJoined, afterStart));
  const graduatedAt = at(addDays(today, -3));
  const siti = hire('siti', 'agus', [
    ['INSURANCE_BASICS', 'hire', 1], ['CAREER_MINDSET', 'hire', 2], ['COMPANY_PROFILE', 'hire', 3],
    ['KPM_INTRO_SESSION', 'agus', 5], ['CRM_SETUP', 'hire', 8], ['CHECK_CONTEST', 'hire', 12],
    ['MANDATORY_TRAINING', 'hire', 20], ['ROLE_PLAY', 'agus', 25], ['CERTIFY_PRODUCTS', 'hire', 35],
    ['JOINT_FIELD_WORK', 'agus', 44], ['FIRST_CASE_CLOSED', 'hire', 52], ['WEEKLY_CHECK_IN', 'agus', 70],
    ['INDEPENDENT_AGENT_MILESTONE', 'hire', input.joinedDaysAgo.siti - 4],
  ], {
    graduatedAt, graduatedByMembershipId: members.siti,
    links: {
      GOAL_SETTING: { at: sitiAt(41), by: members.siti, collection: 'goals', id: input.sitiRecords.goal },
      ADD_PROSPECTS: { at: sitiAt(50), by: members.siti, collection: 'leads', id: input.sitiRecords.lead },
      ACTIVITY_TRACKER_WEEKLY: { at: sitiAt(88), by: members.siti, collection: 'activityLogs', id: input.sitiRecords.day },
    },
  });
  activations.push(siti);
  audits.push(audit(siti, 'activation.graduated', { userId: input.users.siti, membershipId: members.siti }, graduatedAt));

  activations.push(hire('dimas', 'agus', [
    ['INSURANCE_BASICS', 'hire', 2], ['CAREER_MINDSET', 'hire', 3], ['COMPANY_PROFILE', 'hire', 3],
    ['KPM_INTRO_SESSION', 'agus', 6], ['CRM_SETUP', 'agus', 15],
  ]));

  activations.push(hire('indah', 'agus', [
    ['INSURANCE_BASICS', 'hire', 1], ['CAREER_MINDSET', 'hire', 2],
    ['COMPANY_PROFILE', 'hire', 2, 'The branch tour helped more than the slides.'],
    ['KPM_INTRO_SESSION', 'agus', 4], ['CRM_SETUP', 'hire', 6], ['CHECK_CONTEST', 'hire', 9],
    ['MANDATORY_TRAINING', 'hire', 18], ['ROLE_PLAY', 'agus', 21], ['CERTIFY_PRODUCTS', 'hire', 30],
    ['JOINT_FIELD_WORK', 'agus', 40], ['FIRST_CASE_CLOSED', 'hire', 47], ['WEEKLY_CHECK_IN', 'agus', 60],
  ]));

  // ---------------------------------------------------------------- office 0555

  activations.push(hire('lina', null, []));

  return { today, activations, audits };
}
