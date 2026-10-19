import mongoose from 'mongoose';
import { FixedClock } from '@/common/clock/clock.port';
import { RequestContext } from '@/common/context/request-context';
import { addDays } from '@/common/time/local-day';
import { CASCADE_ACTIVITY_CODES, PERFORMANCE } from '@/domain/constants';
import { PasswordService } from '@/modules/auth/password.service';
import { annualTargetOf, cascadeCounts } from '@/modules/goals/goal-cascade';
import { EDGE_EVENTS } from '@/modules/org/membership-history.schema';
import {
  Notification, NotificationPreferences, NotificationPreferencesSchema, NotificationSchema,
} from '@/modules/notifications/notification.schema';
import { NotificationRepository } from '@/modules/notifications/notification.repository';
import { NotificationService, TemplateRenderer } from '@/modules/notifications/notification.service';
import { NotificationTemplate, type RenderedMessage } from '@/modules/notifications/notification.types';
import { MINOR_UNITS_PER_RP_MILLION } from '@/modules/production/production-units';
import { monthlyApeTarget, ytdBeforeThisMonth } from '@/modules/summary/summary-figures';
import { startMongo, stopMongo } from '../../../test/mongo';
import { configModule } from '../../../test/config-module';
import {
  COACHING_CAST, pacingFloor, type CoacheeKey, type RosterStatus,
} from '../coaching-cast';
import { ROSTER_PLAN, seedObjectId, type CoachingFixture, type LastOneToOne } from '../coaching-fixture';
import { seedDemo, type SeedResult } from '../demo';
import { backfillCoachingSnapshots } from '../coaching-snapshots';
import { SUBSCRIPTION_FIXTURE_PEOPLE } from '../subscription-fixture';
import { TEMPLATE_FIXTURE_PEOPLE } from '../template-fixture';
import { REPORTING_CAST } from '../reporting-fixture';

/** The people the subscription fixture makes, by pronoun. */
const subscriptionPeople = (pronoun: 'she' | 'he') =>
  Object.values(SUBSCRIPTION_FIXTURE_PEOPLE).filter((p) => p.pronoun === pronoun).map((p) => p.email);
/** The people the template fixture makes — office 0701, started Empty — by pronoun. */
const templatePeople = (pronoun: 'she' | 'he') =>
  Object.values(TEMPLATE_FIXTURE_PEOPLE).filter((p) => p.pronoun === pronoun).map((p) => p.email);

/**
 * P11-T2 — the early coaching demo seed, run on the in-memory database.
 *
 * The seed is excluded from coverage because running it is what proves it (`jest.config.ts`); this spec
 * runs it, as the command does, and reads what it wrote.
 */

const RUN_MS = 240_000;
const TZ = 'Asia/Jakarta';
const CASCADE: readonly string[] = [
  CASCADE_ACTIVITY_CODES.leadsCode, CASCADE_ACTIVITY_CODES.appointmentsCode, CASCADE_ACTIVITY_CODES.closingsCode,
];

const db = () => mongoose.connection.db as mongoose.mongo.Db;
const col = (name: string) => db().collection(name);
const quiet = () => undefined;

/** The office everything below is in: KPM 0417. */
async function office(): Promise<string> {
  const kpm = await col('kpms').findOne({ code: '0417' });
  return String(kpm!._id);
}

/** The live membership of the account with this email, in KPM 0417. */
async function memberOf(email: string) {
  const account = await col('users').findOne({ email });
  const membership = await col('memberships').findOne({
    kpmId: await office(), userId: String(account!._id), status: 'active',
  });
  return membership!;
}

const EMAIL: Record<CoacheeKey, string> = {
  ...Object.fromEntries(COACHING_CAST.map((p) => [p.key, p.email])) as Record<(typeof COACHING_CAST)[number]['key'], string>,
  sari: 'sari@kpm0417.test', dewi: 'dewi@kpm0417.test', rina: 'rina@kpm0417.test',
  budi: 'budi@kpm0417.test', yanti: 'removed@kpm0417.test',
};
const KEYS = Object.keys(ROSTER_PLAN) as CoacheeKey[];

async function coacheeIds(): Promise<Record<CoacheeKey, string>> {
  const ids = {} as Record<CoacheeKey, string>;
  for (const key of KEYS) ids[key] = String((await memberOf(EMAIL[key]))._id);
  return ids;
}

/**
 * **`GOAL_PACE_STATUS` as `metrics-and-definitions.md` §A.4 defines it**, read straight off the rows,
 * with the product's own arithmetic. An oracle for the seed's inputs, not the roster's computation: that
 * is P11-T6's, which checks the same table on the seed.
 */
async function statusOf(membershipId: string, today: string) {
  const kpmId = await office();
  const year = today.slice(0, 4);
  const month = today.slice(0, 7);
  const m = Number(today.slice(5, 7));
  const goal = await col('goals').findOne({ kpmId, membershipId, period: year, deletedAt: null });
  const annual = goal ? annualTargetOf({
    mode: goal.mode, annualApeTargetMinor: goal.annualApeTargetMinor, savingsTargetMinor: goal.savingsTargetMinor,
    commissionRatePct: goal.commissionRatePct, monthsLeft: 1, apeAchievedMinor: goal.apeAchievedMinor,
    caseSizeMinor: goal.caseSizeMinor, leadsToApptPct: goal.leadsToApptPct, closingRatePct: goal.closingRatePct,
  }) : 0;
  if (!goal || annual <= 0) return { status: 'no_goal_set' as RosterStatus, projected: null, attainment: null, floor: null, logged: 0 };

  const rows = col('monthlyAgentData');
  const previous = m === 1 ? null : `${year}-${String(m - 1).padStart(2, '0')}`;
  const [through] = previous
    ? await rows.find({ kpmId, membershipId, month: { $gte: `${year}-01`, $lte: previous }, 'apeYtd.value': { $ne: null } })
      .sort({ month: -1 }).limit(1).toArray()
    : [];
  const [latest] = await rows.find({ kpmId, membershipId, month: { $gte: `${year}-01`, $lte: `${year}-12` }, 'apeYtd.value': { $ne: null } })
    .sort({ month: -1 }).limit(1).toArray();
  const thisMonth = await rows.findOne({ kpmId, membershipId, month, 'apeMonthly.value': { $ne: null } });
  const before = ytdBeforeThisMonth({
    month: m,
    throughLastMonthMinor: through ? through.apeYtd.value : null,
    thisMonth: thisMonth && latest?.month === month
      ? { ytdMinor: latest.apeYtd.value, monthlyMinor: thisMonth.apeMonthly.value } : null,
    ownFigureMinor: null,
  });
  const target = monthlyApeTarget(annual, before, m);
  const counts = cascadeCounts(target, goal as unknown as Parameters<typeof cascadeCounts>[1]);

  const days = await col('activityLogs').find({ kpmId, membershipId, localDate: { $gte: `${month}-01`, $lte: today } }).toArray();
  const logged = days.reduce((sum, day) => sum + (day.entries as { activityTypeCode: string; count: number }[])
    .filter((entry) => CASCADE.includes(entry.activityTypeCode))
    .reduce((total, entry) => total + entry.count, 0), 0);
  const sum = counts.leads + counts.appointments + counts.policies;
  const projected = sum > 0 ? (counts.policies * logged) / sum : 0;
  const attainment = thisMonth ? thisMonth.apeMonthly.value / target : 0;
  const floor = pacingFloor(goal as unknown as Parameters<typeof pacingFloor>[0]);
  // `MAA_PROJECTED_SUBMISSIONS_MIN` is 1 (§B.4); P11-T6 makes it a constant with its own test.
  const status: RosterStatus = projected < 1 ? 'needs_attention'
    : attainment >= PERFORMANCE.ON_TRACK_PACE_THRESHOLD ? 'on_track' : 'watch_closely';
  return { status, projected, attainment, floor, logged };
}

/** `DAYS_SINCE_LAST_COACHING` over the fixture's finalized sessions, as the roster will draw it. */
function lastOneToOne(fixture: CoachingFixture, coacheeId: string, overdueDays: number): LastOneToOne {
  const dates = fixture.sessions
    .filter((s) => s.coacheeMembershipId === coacheeId && s.status === 'finalized')
    .map((s) => s.date!)
    .sort();
  if (dates.length === 0) return 'none';
  const days = new FixedClock(new Date()).daysBetween(TZ, dates.at(-1)!, fixture.today);
  if (days === 0) return 'today';
  return days <= overdueDays ? 'recent' : 'overdue';
}

/**
 * **Every person the seed makes, by the pronoun it states for them** (`users.pronoun`), so the coaching
 * screens write *her* and *him* about the demo's people. The two operator accounts are not people anybody
 * coaches, and keep the default.
 */
const WOMEN = [
  'admin@kpm0417.test', 'sari@kpm0417.test', 'dewi@kpm0417.test', 'rina@kpm0417.test', 'pending@kpm0417.test',
  'removed@kpm0417.test', 'indah@kpm0417.test', 'siti@kpm0417.test', 'novi@kpm0417.test', 'agent@kpm0555.test',
  'maya@agencyboost.test', 'newcomer@agencyboost.test',
  // P13.2: offices 0601 and 0602 (`subscription-fixture.ts`).
  ...subscriptionPeople('she'),
  // P13.2-T6: office 0701 (`template-fixture.ts`).
  ...templatePeople('she'),
];
const MEN = [
  'owner@kpm0417.test', 'agus@kpm0417.test', 'budi@kpm0417.test', 'untagged@kpm0417.test', 'dimas@kpm0417.test',
  'arief@kpm0417.test', 'wahyu@kpm0417.test', 'owner@kpm0555.test', 'owner@kpm0999.test', 'ade@agencyboost.test',
  'tomi@agencyboost.test',
  ...subscriptionPeople('he'),
  ...templatePeople('he'),
];
const OPERATORS = ['superadmin@agencyboost.test', 'root@agencyboost.test'];

/** The emails holding each pronoun, sorted. */
async function pronouns(): Promise<Record<string, string[]>> {
  const users = await col('users').find({}).sort({ email: 1 }).toArray();
  const by: Record<string, string[]> = {};
  for (const u of users) (by[u.pronoun ?? 'missing'] ??= []).push(u.email);
  return by;
}

/** The inbox reads no template body: a renderer that renders nothing is all it needs. */
class NoRenderer extends TemplateRenderer {
  render(templateId: string): RenderedMessage {
    return { subject: templateId, body: '' };
  }
}

async function countAll(): Promise<Record<string, number>> {
  const names = (await db().listCollections({}, { nameOnly: true }).toArray()).map((c) => c.name).sort();
  const counts: Record<string, number> = {};
  for (const name of names) counts[name] = await col(name).countDocuments({});
  return counts;
}

describe('P11-T2 the early coaching demo seed — a run on 2 October 2026, 10:00 in Jakarta', () => {
  const clock = new FixedClock(new Date('2026-10-02T03:00:00Z'));
  const TODAY = '2026-10-02';
  let first: SeedResult;
  let ids: Record<CoacheeKey, string>;
  let agus: mongoose.mongo.WithId<mongoose.mongo.Document>;

  beforeAll(async () => {
    await startMongo();
    first = await seedDemo({ clock, log: quiet });
    ids = await coacheeIds();
    agus = await memberOf('agus@kpm0417.test');
  }, RUN_MS);
  afterAll(stopMongo);

  // ------------------------------------------------------------------ AC-1: the cast

  it('P11-T2 AC-1 the demo AB has direct agents as well as AAB units, so both roster groups have rows', async () => {
    const directs = await col('memberships').find({ kpmId: await office(), leaderId: String(agus._id), status: 'active' }).toArray();
    const agents = directs.filter((d) => d.role === 'agent');
    const aabs = directs.filter((d) => d.role === 'aab');
    expect(agents.map((a) => String(a._id)).sort()).toEqual([ids.indah, ids.dimas, ids.siti].sort());
    expect(aabs.map((a) => String(a._id)).sort()).toEqual([ids.sari, ids.dewi, ids.arief].sort());
    // The counts the roster and the tree read are recounted, not left at what they were.
    expect(agus.directCounts).toEqual({ ab: 0, aab: 3, agent: 3, total: 6 });
  });

  it("P11-T2 AC-1 an AAB's unit has agents of its own, and Dewi still leads nobody (ADR-0087)", async () => {
    const kpmId = await office();
    const under = async (id: string) => (await col('memberships').find({ kpmId, leaderId: id, status: 'active' }).toArray())
      .map((m) => String(m._id)).sort();
    expect(await under(ids.arief)).toEqual([ids.novi, ids.wahyu].sort());
    expect(await under(ids.sari)).toEqual(expect.arrayContaining([ids.rina, ids.budi, ids.yanti]));
    expect(await under(ids.dewi)).toEqual([]);
  });

  it('P11-T2 AC-1 every new leader edge is written as the org module writes it: leader, cached ancestors, an open edge', async () => {
    const kpmId = await office();
    for (const person of COACHING_CAST) {
      const member = await memberOf(person.email);
      const leader = person.leader === 'agus' ? agus : await memberOf('arief@kpm0417.test');
      expect(member).toMatchObject({
        role: person.role, leaderId: String(leader._id), depth: leader.depth + 1,
        ancestorIds: [...leader.ancestorIds, String(leader._id)], status: 'active',
      });
      const edges = await col('membershipHistory').find({ kpmId, membershipId: String(member._id), eventType: 'joined' }).toArray();
      expect(edges).toHaveLength(1);
      // Arief joined as an Agent: the role change log, not this edge, has his promotion, and the
      // promotion closed this edge at its own instant (P11-T3's amendment, as `openEdge` does).
      const promotedAt = person.promoted ? clock.now().getTime() - person.promoted.daysAgo * 24 * 60 * 60 * 1000 : null;
      expect(edges[0]).toMatchObject({
        toRole: person.promoted ? 'agent' : person.role, toLeaderId: String(leader._id),
        validTo: promotedAt === null ? null : new Date(promotedAt),
      });
      expect(edges[0].validFrom.getTime()).toBeLessThanOrEqual(clock.now().getTime());
    }
    // Promoted, like Sari and Dewi, so the role change log tells the truth about the AAB.
    expect(await col('membershipHistory').findOne({ membershipId: ids.arief, eventType: 'role_changed' }))
      .toMatchObject({ fromRole: 'agent', toRole: 'aab', toLeaderId: String(agus._id), validTo: null });
  });

  /*
   * Invariant §5 and roles §6.1: a switch never makes two open edges. The seed wrote a promotion's
   * `role_changed` row and a removal's `removed` row open beside the `joined` row, so every reset gave
   * Arief, Sari, Dewi and Yanti's removed membership two current edges. Admin rights are a chain of
   * their own beside the edge (`ADMIN_EVENTS`), and are not counted here.
   */
  it('P11-T3 AC-2 every membership the seed writes has exactly one open edge, a promotion and a removal included', async () => {
    const open = await col('membershipHistory').aggregate([
      { $match: { eventType: { $in: [...EDGE_EVENTS] }, validTo: null, deletedAt: null } },
      { $group: { _id: '$membershipId', events: { $push: '$eventType' } } },
    ]).toArray();
    expect(open.filter((m) => m.events.length > 1)).toEqual([]);

    const memberships = await col('memberships').find({ deletedAt: null }).project({ _id: 1 }).toArray();
    expect(open.map((m) => String(m._id)).sort()).toEqual(memberships.map((m) => String(m._id)).sort());

    // The four that had two: each earlier row closed at the instant the later one opened.
    const kpmId = await office();
    const removed = await col('memberships').findOne({ kpmId, status: 'removed' });
    for (const membershipId of [ids.arief, ids.sari, ids.dewi, String(removed!._id)]) {
      const rows = await col('membershipHistory')
        .find({ membershipId, eventType: { $in: [...EDGE_EVENTS] } }).sort({ validFrom: 1 }).toArray();
      expect(rows.map((r) => r.eventType)).toEqual(['joined', membershipId === String(removed!._id) ? 'removed' : 'role_changed']);
      expect(rows[0].validTo).toEqual(rows[1].validFrom);
      expect(rows[1].validTo).toBeNull();
    }
  });

  it('P11-T2 AC-1 every coachee joined before their first day, plan, promotion and session, and after their leader could lead them', async () => {
    const kpmId = await office();
    const history = col('membershipHistory');
    const joinedOn = async (membershipId: string): Promise<Date> => {
      const edges = await history.find({ kpmId, membershipId, eventType: 'joined' }).toArray();
      expect(edges).toHaveLength(1);
      return edges[0].validFrom;
    };
    const promotedOn = async (membershipId: string): Promise<Date | null> =>
      (await history.findOne({ kpmId, membershipId, eventType: 'role_changed' }))?.validFrom ?? null;
    // An Agent leads nobody: a leader leads from their promotion, or from joining when they joined to lead.
    const leadsFrom = async (membershipId: string) => (await promotedOn(membershipId)) ?? joinedOn(membershipId);

    for (const key of KEYS) {
      const member = await memberOf(EMAIL[key]);
      const id = String(member._id);
      const joined = await joinedOn(id);
      const [firstDay] = await col('activityLogs').find({ kpmId, membershipId: id }).sort({ localDate: 1 }).limit(1).toArray();
      const plan = await col('goals').findOne({ kpmId, membershipId: id, period: TODAY.slice(0, 4) });
      const planned: Date[] = plan ? [plan.savedAt, ...plan.revisions.map((r: { at: Date }) => r.at)] : [];
      const promoted = await promotedOn(id);

      expect({
        key,
        sameInstant: member.joinedAt.getTime() === joined.getTime(),
        afterLeader: joined > (await leadsFrom(member.leaderId)),
        beforeFirstDay: firstDay.localDate > clock.localDateFor(TZ, joined),
        beforePlans: planned.every((at) => at > joined),
        beforePromotion: promoted === null || promoted > joined,
      }).toEqual({
        key, sameInstant: true, afterLeader: true, beforeFirstDay: true, beforePlans: true, beforePromotion: true,
      });
    }

    // Every session in the fixture rests on edges that were open on its day, the coach's lead included.
    for (const session of first.coaching.sessions) {
      const opened = [await joinedOn(session.coacheeMembershipId), await leadsFrom(session.coachMembershipId)];
      expect({ session: session._id, open: opened.every((at) => at < session.createdAt) })
        .toEqual({ session: session._id, open: true });
    }
  });

  it("P11-T2 AC-1 the new people follow the seed's patterns: an email at the office, the field password, a PRU code of their own", async () => {
    const passwords = new PasswordService();
    const codes = new Set<string>();
    for (const person of COACHING_CAST) {
      const account = await col('users').findOne({ email: person.email });
      expect(person.email).toMatch(/^[a-z]+@kpm0417\.test$/);
      expect(account).toMatchObject({ fullName: person.fullName, agentCode: person.agentCode, status: 'active' });
      expect(person.agentCode).toMatch(/^PRU-8\d{4}$/);
      expect(await passwords.verify(account!.passwordHash, 'demo password field')).toBe(true);
      expect((await memberOf(person.email)).agentCode).toBe(person.agentCode);
      codes.add(person.agentCode);
    }
    // Unique across the company, the existing accounts included.
    const all = await col('users').find({ agentCode: { $type: 'string' } }).toArray();
    expect(new Set(all.map((u) => u.agentCode)).size).toBe(all.length);
    // The accounts the seed had keep the codes a fresh seed has always given them.
    expect(await col('users').findOne({ email: 'owner@kpm0417.test' })).toMatchObject({ agentCode: 'PRU-80003' });
    expect(await col('users').findOne({ email: 'newcomer@agencyboost.test' })).toMatchObject({ agentCode: 'PRU-80019' });
  });

  it('P11-T7 the demo people have their own pronouns, so coaching writes she and he; the operators keep they', async () => {
    // Phase 18's reporting cast states no pronoun (`reporting-fixture.ts`): coaching writes *they* of them.
    expect(await pronouns()).toEqual({
      she: [...WOMEN].sort(), he: [...MEN].sort(), they: [...OPERATORS, ...REPORTING_CAST.map((p) => p.email)].sort(),
    });
    for (const person of COACHING_CAST) {
      expect(await col('users').findOne({ email: person.email })).toMatchObject({ pronoun: person.pronoun });
    }
    // What a coaching page opens on reads them: Agus opening Indah's and Dimas's.
    const wired = configModule(clock.now());
    await Promise.all(mongoose.modelNames().map((name) => mongoose.model(name).init()));
    const asAgus = new RequestContext(String(agus.userId), 'none', {
      membershipId: String(agus._id), kpmId: await office(), orgLevelCode: agus.orgLevelCode, hierarchyRole: agus.role,
      status: 'active', isKpmOwner: false, isKpmAdmin: false, directCount: 6,
    } as never);
    expect(await wired.coachee.read(asAgus, ids.indah)).toMatchObject({ name: 'Indah Permatasari', pronoun: 'she' });
    expect(await wired.coachee.read(asAgus, ids.dimas)).toMatchObject({ name: 'Dimas Pratama', pronoun: 'he' });
    // A fresh database: nothing an earlier run made was there to amend.
    expect(first.pronounsSet).toBe(0);
  });

  // ------------------------------------------------------------------ AC-2: what the person tabs read

  it('P11-T2 AC-2 every coachee has weeks of activity, open leads with a date, and production rows', async () => {
    const kpmId = await office();
    for (const key of KEYS) {
      const days = await col('activityLogs').countDocuments({ kpmId, membershipId: ids[key] });
      expect({ key, weeks: days >= 14 }).toEqual({ key, weeks: true });
      const open = await col('leads').find({ kpmId, ownerMembershipId: ids[key], outcome: null, deletedAt: null }).toArray();
      expect({ key, open: open.length >= 2, dated: open.some((l) => l.nextActionDate !== null) })
        .toEqual({ key, open: true, dated: true });
      expect({ key, production: await col('monthlyAgentData').countDocuments({ kpmId, membershipId: ids[key] }) > 0 })
        .toEqual({ key, production: true });
    }
  });

  it('P11-T2 AC-2 every coachee but exactly one holds a goal for the current year', async () => {
    const kpmId = await office();
    const without: CoacheeKey[] = [];
    for (const key of KEYS) {
      if (!(await col('goals').findOne({ kpmId, membershipId: ids[key], period: '2026', deletedAt: null }))) without.push(key);
    }
    expect(without).toEqual(['sari']);
  });

  it('P11-T2 AC-2 one lead promised this month with a date per coachee, and one promised with none, where no seeded session can trip on it', async () => {
    const kpmId = await office();
    const promised = (await col('leads').find({ kpmId, 'commitments.month': '2026-10', outcome: null, deletedAt: null }).toArray())
      .filter((l) => KEYS.some((key) => ids[key] === l.ownerMembershipId));
    for (const key of KEYS) {
      const dated = promised.filter((l) => l.ownerMembershipId === ids[key] && l.nextActionDate !== null);
      // Rina keeps the three Phase 7 promised her; Indah a recruitment candidate besides (Phase 15,
      // `unit-dashboard-fixture.ts`); everybody else holds exactly one.
      const expected = key === 'indah' ? 2 : 1;
      expect({ key, dated: key === 'rina' ? dated.length >= 1 : dated.length === expected }).toEqual({ key, dated: true });
    }
    const undated = promised.filter((l) => l.nextActionDate === null);
    expect(undated.map((l) => [l.name, l.ownerMembershipId])).toEqual([['Pak Fauzan Akbar', ids.siti]]);
    // LEAD_THIS_MONTH_UNDATED: nobody with a finalized seeded session holds one.
    const coached = new Set(first.coaching.sessions.map((s) => s.coacheeMembershipId));
    expect(coached.has(ids.siti)).toBe(false);
  });

  // ------------------------------------------------------------------ AC-4: every roster state

  it('P11-T2 AC-4 the seeded goals, production and activity give each coachee the status the fixture plans', async () => {
    const seen = new Set<RosterStatus>();
    for (const key of KEYS) {
      const result = await statusOf(ids[key], TODAY);
      seen.add(result.status);
      // Rina is on the months the fixture's header names; October is one of her Watch closely months.
      expect({ key, status: result.status }).toEqual({ key, status: ROSTER_PLAN[key].status });
      if (result.status === 'on_track' || result.status === 'watch_closely') {
        expect({ key, paces: result.logged >= result.floor! }).toEqual({ key, paces: true });
      }
    }
    expect([...seen].sort()).toEqual(['needs_attention', 'no_goal_set', 'on_track', 'watch_closely']);
  });

  it('P11-T2 AC-4 the fixture gives the roster No 1:1 yet, Today, a recent 1:1 and an overdue one', async () => {
    const seen = new Set<LastOneToOne>();
    for (const key of KEYS) {
      const state = lastOneToOne(first.coaching, ids[key], 7);
      seen.add(state);
      expect({ key, state }).toEqual({ key, state: ROSTER_PLAN[key].lastOneToOne });
    }
    expect([...seen].sort()).toEqual(['none', 'overdue', 'recent', 'today']);
  });

  it('P11-T2 AC-4 the pacing floors the fixture header quotes are what the cascade gives', () => {
    const floor = (closing: number, leadsToAppt: number) =>
      pacingFloor({ caseSizeMinor: 10 * MINOR_UNITS_PER_RP_MILLION, closingRatePct: closing, leadsToApptPct: leadsToAppt });
    expect(floor(40, 40)).toBe(15);
    expect(floor(35, 35)).toBe(17);
    expect(floor(30, 30)).toBe(24);
  });

  // ------------------------------------------------------------------ P11-T5 AC-10, P11-T6: the stored sessions, read

  /** The reporting fixture's own 1:1s (Phase 18): its cast's, and 0555's — not the coaching fixture's to account for. */
  const reportingSessions = async () => {
    const accounts = await col('users').find({ email: { $in: REPORTING_CAST.map((p) => p.email) } }).toArray();
    const coaches = new Set((await col('memberships').find({ userId: { $in: accounts.map((a) => String(a._id)) } }).toArray())
      .map((m) => String(m._id)));
    const kpm0417 = String((await col('kpms').findOne({ code: '0417' }))!._id);
    return (s: { coachMembershipId: string; kpmId: string }) => coaches.has(s.coachMembershipId) || s.kpmId !== kpm0417;
  };

  it('P11-T5 AC-10 the fixture’s sessions are stored, each under its own id, as the fixture writes them', async () => {
    const theirs = await reportingSessions();
    const stored = (await col('coachingSessions').find({}).sort({ _id: 1 }).toArray())
      .filter((s) => !theirs(s as never));
    expect(stored.map((s) => String(s._id))).toEqual(first.coaching.sessions.map((s) => s._id).sort());
    for (const seed of first.coaching.sessions) {
      const row = stored.find((s) => String(s._id) === seed._id)!;
      expect({ id: seed._id, row }).toEqual({
        id: seed._id,
        row: expect.objectContaining({
          kpmId: seed.kpmId, coachMembershipId: seed.coachMembershipId, coacheeMembershipId: seed.coacheeMembershipId,
          status: seed.status, date: seed.date, version: seed.version, corrections: [], deletedAt: null,
          // Taken by finalize's own builder, as of the session's first finalize — never typed by the seed.
          snapshot: seed.status === 'finalized' ? expect.objectContaining({ takenAt: seed.frozenAt }) : null,
          createdAt: seed.createdAt, updatedAt: seed.updatedAt, frozenAt: seed.frozenAt,
        }),
      });
      expect(row.actionItems).toHaveLength(seed.actionItems.length);
      expect(row.lastWeekItems.map((i: { done: boolean }) => i.done)).toEqual(seed.lastWeekItems.map((i) => i.done));
    }
  });

  it('P11-T5 AC-10 each finalized session carries the snapshot finalize’s builder takes, as of its own day, and a re-run keeps it', async () => {
    const theirs = await reportingSessions();
    const finalized = (await col('coachingSessions').find({ status: 'finalized' }).toArray()).filter((s) => !theirs(s as never));
    expect(finalized).toHaveLength(first.coaching.sessions.filter((s) => s.status === 'finalized').length);
    for (const row of finalized) {
      const snapshot = row.snapshot as {
        goal: { period: string; month: string; currency: string }; ratios: { to: string; days: number; rows: unknown[] };
        activity: { from: string; to: string; targets: { code: string }[] };
      };
      expect({ id: String(row._id), when: [snapshot.goal.period, snapshot.goal.month, snapshot.ratios.to, snapshot.activity.to] })
        .toEqual({ id: String(row._id), when: [row.date.slice(0, 4), row.date.slice(0, 7), row.date, row.date] });
      expect(snapshot.goal.currency).toBe('IDR');
      expect(snapshot.ratios.days).toBe(30);
      expect(snapshot.activity.targets.map((t) => t.code)).toEqual([...CASCADE]);
    }
    // Rina has a goal and production: her 1:1 today froze figures, not blanks.
    const rina = finalized.find((row) => row.date === first.coaching.today && row.coachMembershipId !== row.coacheeMembershipId)!;
    expect(rina.snapshot.goal.yearly.targetMinor).toEqual(expect.any(Number));

    const kept = finalized.map((row) => row.snapshot);
    expect(await backfillCoachingSnapshots(await office())).toBe(0);
    expect((await col('coachingSessions').find({ status: 'finalized' }).toArray()).filter((s) => !theirs(s as never)).map((row) => row.snapshot))
      .toEqual(kept);
  });

  it('P11-T6 AC-3 AC-4 the roster Agus reads gives every coachee the status and the Last 1:1 the fixture plans', async () => {
    const wired = configModule(clock.now());
    // Compiling the services' models creates their collections in the background (`autoCreate`): settle
    // that here, so the AC-6 counts below compare a database nothing is still adding a collection to.
    await Promise.all(mongoose.modelNames().map((name) => mongoose.model(name).init()));
    const view = await wired.coachingRoster.read(new RequestContext(String(agus.userId), 'none', {
      membershipId: String(agus._id), kpmId: await office(), orgLevelCode: agus.orgLevelCode, hierarchyRole: agus.role,
      status: 'active', isKpmOwner: false, isKpmAdmin: false, directCount: 6,
    } as never));
    const rows = [...view.directAgents, ...view.units.flatMap((u) => [u.head, ...u.members])];

    expect(view.directAgents.map((r) => r.name)).toEqual(['Dimas Pratama', 'Indah Permatasari', 'Siti Rahmawati']);
    expect(view.units.map((u) => u.head.name)).toEqual(['Arief Hidayat', 'Dewi Lestari', 'Sari Puspita']);
    for (const key of KEYS) {
      const row = rows.find((r) => r.membershipId === ids[key])!;
      const last = row.lastOneOnOne === null ? 'none'
        : row.lastOneOnOne.days === 0 ? 'today' : row.lastOneOnOne.overdue ? 'overdue' : 'recent';
      expect({ key, status: row.status, last })
        .toEqual({ key, status: ROSTER_PLAN[key].status, last: ROSTER_PLAN[key].lastOneToOne });
    }
    // Rina's latest 1:1 was led by Sari, and Sari's by Agus: *Last Coached By* is the session's coach.
    expect(rows.find((r) => r.membershipId === ids.rina)!.lastOneOnOne?.coach?.name).toBe('Sari Puspita');
    expect(rows.find((r) => r.membershipId === ids.sari)!.lastOneOnOne).toMatchObject({ days: 12, overdue: true });
    expect(rows.find((r) => r.membershipId === ids.indah)!.lastOneOnOne?.coach?.membershipId).toBe(String(agus._id));
  });

  // ------------------------------------------------------------------ P11-T9 AC-8: the ticks and the notes, stored and read

  it('P11-T9 AC-8 the fixture’s ticks and notes are stored, each under its own id, as the fixture writes them', async () => {
    const stored = async (name: string, seeds: readonly { _id: string }[]) => {
      const rows = await col(name).find({}).sort({ _id: 1 }).toArray();
      expect(rows.map((r) => String(r._id))).toEqual(seeds.map((s) => s._id).sort());
      return rows;
    };
    const profiles = await stored('coachingProfiles', first.coaching.profiles);
    for (const seed of first.coaching.profiles) {
      const row = profiles.find((r) => String(r._id) === seed._id)!;
      expect(row).toMatchObject({
        kpmId: seed.kpmId, coacheeMembershipId: seed.coacheeMembershipId, milestoneCodes: seed.milestoneCodes,
        skillCodes: seed.skillCodes, version: seed.version, revisions: seed.revisions, deletedAt: null,
        createdAt: seed.createdAt, updatedAt: seed.updatedAt, createdBy: seed.createdBy, updatedBy: seed.updatedBy,
      });
    }
    const notes = await stored('leaderNotes', first.coaching.notes);
    for (const seed of first.coaching.notes) {
      const row = notes.find((r) => String(r._id) === seed._id)!;
      expect(row).toMatchObject({
        kpmId: seed.kpmId, authorMembershipId: seed.authorMembershipId, coacheeMembershipId: seed.coacheeMembershipId,
        text: seed.text, version: seed.version, revisions: seed.revisions, deletedAt: null,
        createdAt: seed.createdAt, updatedAt: seed.updatedAt,
      });
    }
  });

  it('P11-T9 AC-8 the Leader Notes tab reads them as ADR-0073 says: up the author’s chain, never the coachee', async () => {
    const wired = configModule(clock.now());
    await Promise.all(mongoose.modelNames().map((name) => mongoose.model(name).init()));
    const kpmId = await office();
    const as = (member: mongoose.mongo.WithId<mongoose.mongo.Document>) => new RequestContext(String(member.userId), 'none', {
      membershipId: String(member._id), kpmId, orgLevelCode: member.orgLevelCode, hierarchyRole: member.role,
      status: 'active', isKpmOwner: false, isKpmAdmin: false, directCount: 1,
    } as never);
    const sari = await memberOf('sari@kpm0417.test');
    const rina = await memberOf('rina@kpm0417.test');
    const [sariOnRina, agusOnIndah] = first.coaching.notes;

    // Agus reads Sari's note about Rina as her leader above, and his own about Indah as his.
    expect((await wired.leaderNotes.read(as(agus), ids.rina)).others.map((n) => n.text)).toEqual([sariOnRina.text]);
    expect((await wired.leaderNotes.read(as(agus), ids.indah)).mine!.text).toBe(agusOnIndah.text);
    // Sari reads her own, and never Agus's: Indah is not hers to coach.
    expect((await wired.leaderNotes.read(as(sari), ids.rina)).mine!.text).toBe(sariOnRina.text);
    await expect(wired.leaderNotes.read(as(sari), ids.indah)).rejects.toMatchObject({ code: 'NOT_FOUND' });
    // Rina never reads hers.
    await expect(wired.leaderNotes.read(as(rina), ids.rina)).rejects.toMatchObject({ code: 'NOT_FOUND' });

    // The ticks give the stages the fixture names them for.
    expect(await wired.coachingProfile.read(as(agus), ids.rina)).toMatchObject({ stageCode: 'COMPETENT_PRODUCER', version: 2 });
    expect(await wired.coachingProfile.read(as(agus), ids.indah)).toMatchObject({ stageCode: 'INDEPENDENT_PRODUCER', version: 1 });
  });

  // ------------------------------------------------------------------ AC-3: the fixture

  it('P11-T2 AC-3 three finalized weekly sessions for Rina, a week apart, the last today', () => {
    const rina = first.coaching.sessions.filter((s) => s.coacheeMembershipId === ids.rina);
    expect(rina.map((s) => [s.status, s.date, s.coachMembershipId])).toEqual([
      ['finalized', '2026-09-18', ids.sari],
      ['finalized', '2026-09-25', ids.sari],
      ['finalized', TODAY, ids.sari],
    ]);
    expect(rina.map((s) => s.lastWeek?.sessionId ?? null)).toEqual([null, rina[0]._id, rina[1]._id]);
  });

  it('P11-T2 AC-3 every finalized session carries dated, non-empty items and tips, and the chain of last weeks holds', () => {
    const finalized = first.coaching.sessions.filter((s) => s.status === 'finalized');
    // Rina's three, Indah's one, Sari's two as a coachee, and the one Sari led with Yanti before she left.
    expect(finalized).toHaveLength(7);
    for (const session of finalized) {
      expect(session.actionItems.length + session.leadActions.length).toBeGreaterThan(0);
      for (const item of session.actionItems) {
        expect(item.text.trim()).not.toBe('');
        expect(item.dueDate).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      }
      for (const item of session.lastWeekItems) {
        expect(item.text.trim()).not.toBe('');
        expect(item.dueDate).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      }
      for (const tip of session.tips) expect(tip.text.trim()).not.toBe('');
      expect(session.leadActions.every((a) => a.dueDate >= '2026-01-01' && a.text.trim() !== '')).toBe(true);
      expect(session).toMatchObject({
        finalizedByMembershipId: session.coachMembershipId, frozenAt: session.finalizedAt, snapshot: null, corrections: [],
      });
      expect(session.finalizedAt!.getTime()).toBeLessThanOrEqual(clock.now().getTime());
      if (session.lastWeek) {
        const previous = first.coaching.sessions.find((s) => s._id === session.lastWeek!.sessionId)!;
        expect(session.lastWeek).toEqual({ sessionId: previous._id, version: previous.version, date: previous.date });
        expect(previous.date! < session.date!).toBe(true);
        // Last week's items are the previous session's typed items, then its lead-derived ones.
        expect(session.lastWeekItems.map((i) => i.text))
          .toEqual([...previous.actionItems.map((i) => i.text), ...previous.leadActions.map((a) => a.text)]);
      }
    }
  });

  it("P11-T2 AC-3 some of last week's items are done, some are lead-tagged, and what was not done is carried", () => {
    const later = first.coaching.sessions.filter((s) => s.lastWeek !== null);
    const items = later.flatMap((s) => s.lastWeekItems);
    expect(items.some((i) => i.done)).toBe(true);
    expect(items.some((i) => !i.done)).toBe(true);
    expect(items.some((i) => i.leadId !== null && i.leadName !== null)).toBe(true);
    for (const session of later) {
      const notDoneTyped = session.lastWeekItems.filter((i) => !i.done && i.leadId === null).map((i) => i.itemId);
      expect(session.actionItems.filter((i) => i.carriedFromItemId !== null).map((i) => i.carriedFromItemId))
        .toEqual(notDoneTyped);
    }
  });

  it('P11-T2 AC-3 one open draft, at most one per coach and coachee, undated like a fresh Start', () => {
    const drafts = first.coaching.sessions.filter((s) => s.status === 'draft');
    expect(drafts).toHaveLength(1);
    const pairs = first.coaching.sessions.filter((s) => s.status === 'draft')
      .map((s) => `${s.coachMembershipId}:${s.coacheeMembershipId}`);
    expect(new Set(pairs).size).toBe(pairs.length);
    expect(drafts[0]).toMatchObject({
      coachMembershipId: String(agus._id), coacheeMembershipId: ids.indah,
      date: null, finalizedAt: null, frozenAt: null, finalizedByMembershipId: null, snapshot: null, leadActions: [],
    });
    expect(drafts[0].lastWeek?.date).toBe('2026-09-28');
    expect(drafts[0].actionItems.filter((i) => i.carriedFromItemId !== null).every((i) => i.dueDate === null)).toBe(true);
  });

  it("P11-T2 AC-3 a leader's own history as a coachee of the AB, for /coaching/me", () => {
    const sari = first.coaching.sessions.filter((s) => s.coacheeMembershipId === ids.sari);
    expect(sari.map((s) => [s.coachMembershipId, s.status, s.date])).toEqual([
      [String(agus._id), 'finalized', '2026-09-11'],
      [String(agus._id), 'finalized', '2026-09-20'],
    ]);
  });

  it('ADR-0088 a former coach on the demo: Sari led one session with Yanti’s removed membership, inside its edge, and reads it under ledFormerly', async () => {
    const kpmId = await office();
    const sari = await memberOf('sari@kpm0417.test');
    const removed = (await col('memberships').findOne({ kpmId, status: 'removed' }))!;
    const edge = (await col('membershipHistory').findOne({ kpmId, membershipId: String(removed._id), eventType: 'joined' }))!;
    const led = first.coaching.sessions.filter((s) => s.coacheeMembershipId === String(removed._id));

    // Five days after her edge under Sari opened (60 days before the run), so 55 days before it.
    expect(led.map((s) => [s.coachMembershipId, s.status, s.date])).toEqual([[String(sari._id), 'finalized', '2026-08-08']]);
    expect(addDays(led[0].date!, 55)).toBe(TODAY);
    // While the edge was open, under Sari, and after Sari could lead (her promotion, 62 days before the run).
    expect(edge).toMatchObject({ toLeaderId: String(sari._id) });
    expect(edge.validTo).not.toBeNull();
    expect(led[0].createdAt > edge.validFrom && led[0].finalizedAt! < edge.validTo).toBe(true);
    // Stored under its own id, with the snapshot finalize's builder took as of its day.
    expect(await col('coachingSessions').findOne({ _id: new mongoose.Types.ObjectId(led[0]._id) }))
      .toMatchObject({ status: 'finalized', date: '2026-08-08', snapshot: expect.objectContaining({ takenAt: led[0].frozenAt }) });
    expect(led[0]._id).toBe(seedObjectId('coachingSession', kpmId, String(sari._id), String(removed._id), 'former-1'));

    const wired = configModule(clock.now());
    await Promise.all(mongoose.modelNames().map((name) => mongoose.model(name).init()));
    const as = (member: mongoose.mongo.WithId<mongoose.mongo.Document>) => new RequestContext(String(member.userId), 'none', {
      membershipId: String(member._id), kpmId, orgLevelCode: member.orgLevelCode, hierarchyRole: member.role,
      status: 'active', isKpmOwner: false, isKpmAdmin: false, directCount: 3,
    } as never);

    // `GET /coaching/me/sessions`: Sari led it with somebody she no longer coaches.
    expect((await wired.coachingRecord.mine(as(sari))).ledFormerly).toEqual([{
      sessionId: led[0]._id, date: '2026-08-08', coachee: { membershipId: String(removed._id), name: 'Yanti Kusuma' },
      actionItemCount: 3, completedCount: 0,
    }]);
    // Its archive opens for her, the coach who led it (ADR-0082).
    expect(await wired.coachingSession.read(as(sari), led[0]._id)).toMatchObject({ sessionId: led[0]._id, status: 'finalized' });
    // Agus coaches everybody he led a session with: nothing is formerly his.
    expect((await wired.coachingRecord.mine(as(agus))).ledFormerly).toEqual([]);
    // Yanti's live membership is another membership: her history there is empty, and the roster's *No 1:1 yet* holds.
    expect((await wired.coachingRecord.mine(as(await memberOf('removed@kpm0417.test')))).sessions).toEqual([]);
  });

  it('P11-T10 AC-8 each coachee holds the notice their latest finalize sent, and its link opens that session at /coaching/me', async () => {
    const kpmId = await office();
    const finalized = first.coaching.sessions.filter((s) => s.status === 'finalized');
    const notices = await col('notifications').find({ templateId: NotificationTemplate.COACHING_SESSION_FINALIZED }).toArray();

    // Rina's, Indah's and Sari's: the latest finalized session of each live coachee membership.
    const latest = (membershipId: string) => finalized.filter((s) => s.coacheeMembershipId === membershipId)
      .sort((a, b) => a.finalizedAt!.getTime() - b.finalizedAt!.getTime()).at(-1)!;
    const isLatest = (n: (typeof notices)[number]) => n.payload.sessionId === latest(String(n.membershipId))._id;
    expect(notices.filter(isLatest).map((n) => n.membershipId).sort()).toEqual([ids.rina, ids.indah, ids.sari].sort());
    /*
     * P12.1-T4: Rina's and Sari's earlier finalizes sent theirs too, for the long inboxes the pager is reviewed
     * with — each its own session's, dated by its finalize and read since. Indah's inbox is not one of them.
     */
    const earlier = notices.filter((n) => !isLatest(n));
    expect(earlier.map((n) => n.payload.sessionId).sort()).toEqual(finalized
      .filter((s) => [ids.rina, ids.sari].includes(s.coacheeMembershipId) && s._id !== latest(s.coacheeMembershipId)._id)
      .map((s) => s._id).sort());
    for (const notice of earlier) {
      const session = finalized.find((s) => s._id === notice.payload.sessionId)!;
      expect(notice).toMatchObject({ createdAt: session.finalizedAt, readAt: expect.any(Date) });
      expect(Object.keys(notice.delivery)).toEqual(['in_app']);
    }
    for (const notice of notices.filter(isLatest)) {
      const session = latest(notice.membershipId);
      const coachee = (await col('memberships').findOne({ _id: new mongoose.Types.ObjectId(String(notice.membershipId)) }))!;
      // What `announceFinalized` writes: in-app only, `{ sessionId }` and nothing a leader typed, unread.
      expect(notice).toMatchObject({
        kpmId, userId: String(coachee.userId), payload: { sessionId: session._id },
        delivery: { in_app: { status: 'sent', at: session.finalizedAt } }, readAt: null, createdAt: session.finalizedAt,
      });
      expect(Object.keys(notice.delivery)).toEqual(['in_app']);
    }
    // Rina's is for today's session, the third of her weekly three, not an earlier one.
    expect(notices.find((n) => n.membershipId === ids.rina)!.payload.sessionId)
      .toBe(first.coaching.sessions.filter((s) => s.coacheeMembershipId === ids.rina).at(-1)!._id);
    // Yanti's removed membership has a finalized session too, and no notice: her live `/coaching/me` does not list it.
    const removed = (await col('memberships').findOne({ kpmId, status: 'removed' }))!;
    expect(finalized.some((s) => s.coacheeMembershipId === String(removed._id))).toBe(true);
    expect(await col('notifications').countDocuments({ 'payload.sessionId': latest(String(removed._id))._id })).toBe(0);

    // Walked as each of them: the bell's row opens /coaching/me on the session, which their own list holds.
    const wired = configModule(clock.now());
    const notificationModel = mongoose.model(Notification.name, NotificationSchema);
    const inboxes = new NotificationService(
      notificationModel as never,
      new NotificationRepository(notificationModel as never),
      mongoose.model(NotificationPreferences.name, NotificationPreferencesSchema) as never,
      new NoRenderer(), clock, { record: async () => undefined } as never, [],
    );
    await Promise.all(mongoose.modelNames().map((name) => mongoose.model(name).init()));
    for (const key of ['rina', 'indah', 'sari'] as const) {
      const member = await memberOf(EMAIL[key]);
      const as = new RequestContext(String(member.userId), 'none', {
        membershipId: String(member._id), kpmId, orgLevelCode: member.orgLevelCode, hierarchyRole: member.role,
        status: 'active', isKpmOwner: false, isKpmAdmin: false, directCount: member.directCounts?.total ?? 0,
      } as never);
      const sessionId = latest(ids[key])._id;
      const row = (await inboxes.inbox(as)).items.find((i) => i.templateId === NotificationTemplate.COACHING_SESSION_FINALIZED);
      expect({ key, row }).toEqual({
        key,
        row: expect.objectContaining({
          title: 'A coaching session was finalized', href: `/coaching/me?session=${sessionId}`, readAt: null,
        }),
      });
      expect((await wired.coachingRecord.mine(as)).sessions.map((s) => s.sessionId)).toContain(sessionId);
      expect(await wired.coachingSession.read(as, sessionId)).toMatchObject({ sessionId, status: 'finalized' });
    }
  });

  it('P12.1-T4 Agus, Sari and Rina each have an inbox of more than two pages, read and unread, some opening a session or a week', async () => {
    const kpmId = await office();
    const notificationModel = mongoose.model(Notification.name, NotificationSchema);
    const inboxes = new NotificationService(
      notificationModel as never,
      new NotificationRepository(notificationModel as never),
      mongoose.model(NotificationPreferences.name, NotificationPreferencesSchema) as never,
      new NoRenderer(), clock, { record: async () => undefined } as never, [],
    );
    for (const email of ['agus@kpm0417.test', 'sari@kpm0417.test', 'rina@kpm0417.test']) {
      const member = await memberOf(email);
      const as = new RequestContext(String(member.userId), 'none', {
        membershipId: String(member._id), kpmId, orgLevelCode: member.orgLevelCode, hierarchyRole: member.role,
        status: 'active', isKpmOwner: false, isKpmAdmin: false, directCount: 0,
      } as never);
      const pages = await Promise.all([1, 2, 3].map((page) => inboxes.inbox(as, page)));
      const items = pages.flatMap((page) => page.items);
      expect({ email, total: pages[0].total > 40, third: pages[2].items.length > 0 }).toEqual({ email, total: true, third: true });
      expect({ email, unread: pages[0].unread > 0, read: items.some((i) => i.readAt !== null) })
        .toEqual({ email, unread: true, read: true });
      const hrefs = items.map((i) => i.href);
      expect({ email, linked: hrefs.some((h) => h?.startsWith('/calendar')), plain: hrefs.includes(null) })
        .toEqual({ email, linked: true, plain: true });
      // Every row is the account's own and in its own office, and no two say the same thing at the same moment.
      const rows = await col('notifications').find({ userId: String(member.userId) }).toArray();
      expect(rows.every((r) => r.kpmId === kpmId && r.membershipId === String(member._id))).toBe(true);
      expect(new Set(rows.map((r) => `${r.templateId}|${JSON.stringify(r.payload)}|${r.createdAt.toISOString()}`)).size).toBe(rows.length);
    }
    // Rina and Sari were coached: their earlier sessions open from the bell too.
    for (const email of ['sari@kpm0417.test', 'rina@kpm0417.test']) {
      const member = await memberOf(email);
      const finalizes = await col('notifications')
        .countDocuments({ userId: String(member.userId), templateId: NotificationTemplate.COACHING_SESSION_FINALIZED });
      expect({ email, finalizes: finalizes > 1 }).toEqual({ email, finalizes: true });
    }
  });

  it("P11-T2 AC-3 ticks name codes in the office's catalog, and each note's author leads its coachee", async () => {
    const catalog = await col('capabilityCatalogs').findOne({ kpmId: await office() });
    const milestones = new Set(catalog!.milestones.map((m: { code: string }) => m.code));
    const skills = new Set(catalog!.grids.flatMap((g: { items: { code: string }[] }) => g.items.map((i) => i.code)));
    expect(first.coaching.profiles.map((p) => p.coacheeMembershipId).sort()).toEqual([ids.rina, ids.indah].sort());
    for (const profile of first.coaching.profiles) {
      expect(profile.milestoneCodes.every((code) => milestones.has(code))).toBe(true);
      expect(profile.skillCodes.every((code) => skills.has(code))).toBe(true);
      expect(profile.version).toBe(profile.revisions.length + 1);
    }
    expect(first.coaching.notes).toHaveLength(2);
    for (const note of first.coaching.notes) {
      const coachee = await col('memberships').findOne({ _id: new mongoose.Types.ObjectId(note.coacheeMembershipId) });
      expect(coachee!.ancestorIds).toContain(note.authorMembershipId);
      expect(note.authorMembershipId).not.toBe(note.coacheeMembershipId);
      expect(note.version).toBe(note.revisions.length + 1);
    }
  });

  it('P11-T2 AC-3 every fixture id is a stable 24-hex key, unique across the fixture', () => {
    const all = [
      ...first.coaching.sessions.map((s) => s._id),
      ...first.coaching.sessions.flatMap((s) => [...s.actionItems.map((i) => i.itemId), ...s.tips.map((t) => t.tipId)]),
      ...first.coaching.profiles.map((p) => p._id),
      ...first.coaching.notes.map((n) => n._id),
    ];
    expect(all.every((id) => /^[0-9a-f]{24}$/.test(id))).toBe(true);
    expect(new Set(all).size).toBe(all.length);
    expect(first.coaching.sessions[0]._id)
      .toBe(seedObjectId('coachingSession', first.coaching.sessions[0].kpmId, ids.sari, ids.rina, 'weekly-1'));
  });

  it('P11-T2 AC-3 no lead in the office carries the full name of anybody in it, so a lead item never reads as a member', async () => {
    const kpmId = await office();
    const people = new Set<string>();
    for (const membership of await col('memberships').find({ kpmId }).toArray()) {
      const account = await col('users').findOne({ _id: new mongoose.Types.ObjectId(String(membership.userId)) });
      people.add(account!.fullName);
    }
    const leads = await col('leads').find({ kpmId }).toArray();
    const clashes = leads.map((lead) => String(lead.name).replace(/^(Ibu|Pak|Sdri\.)\s+/, ''))
      .filter((name) => people.has(name));
    expect(clashes).toEqual([]);
    // Rina's sessions name her leads, and every one of them is a lead of hers.
    const rinaLeads = new Set((await col('leads').find({ kpmId, ownerMembershipId: ids.rina }).toArray()).map((l) => String(l._id)));
    const named = first.coaching.sessions.filter((s) => s.coacheeMembershipId === ids.rina).flatMap((s) => s.leadActions);
    expect(named.length).toBeGreaterThan(0);
    expect(named.every((action) => rinaLeads.has(action.leadId))).toBe(true);
  });

  // ------------------------------------------------------------------ AC-6: a re-seed adds nothing

  it('P11-T2 AC-6 a second run the same day writes nothing, and builds the same fixture', async () => {
    const counts = await countAll();
    const second = await seedDemo({ clock, log: quiet });
    expect(second.written).toEqual({});
    expect(second.pronounsSet).toBe(0);
    expect(await countAll()).toEqual(counts);
    expect(second.coaching).toEqual(first.coaching);
  }, RUN_MS);

  it('P11-T7 a re-run gives an account an earlier run made its pronoun, once, and keeps one somebody chose', async () => {
    // A database seeded before the seed stated pronouns: the default, or no field at all.
    await col('users').updateOne({ email: 'agus@kpm0417.test' }, { $set: { pronoun: 'they' } });
    await col('users').updateOne({ email: 'indah@kpm0417.test' }, { $unset: { pronoun: '' } });
    // Somebody chose another in a walk: theirs, not the seed's to undo.
    await col('users').updateOne({ email: 'rina@kpm0417.test' }, { $set: { pronoun: 'he' } });
    const counts = await countAll();
    const lines: string[] = [];

    const again = await seedDemo({ clock, log: (text) => lines.push(text) });
    expect(again.pronounsSet).toBe(2);
    expect(again.written).toEqual({});
    expect(await countAll()).toEqual(counts);
    expect(await col('users').findOne({ email: 'agus@kpm0417.test' })).toMatchObject({ pronoun: 'he' });
    expect(await col('users').findOne({ email: 'indah@kpm0417.test' })).toMatchObject({ pronoun: 'she' });
    expect(await col('users').findOne({ email: 'rina@kpm0417.test' })).toMatchObject({ pronoun: 'he' });
    expect(lines.slice(-2)).toEqual([
      'Set the pronoun on 2 accounts an earlier run made (users.pronoun).',
      'This run wrote 0 rows: everything it seeds was already there.',
    ]);
    // And once: the next run finds nothing left to set.
    expect((await seedDemo({ clock, log: quiet })).pronounsSet).toBe(0);

    await col('users').updateOne({ email: 'rina@kpm0417.test' }, { $set: { pronoun: 'she' } });
  }, RUN_MS);

  it('P11-T2 AC-6 a run the next day duplicates no notice, audit entry, person, goal, lead or month: only the new day is written', async () => {
    const counts = await countAll();
    clock.advance(24 * 60 * 60 * 1000);
    const third = await seedDemo({ clock, log: quiet });
    expect(Object.keys(third.written)).toEqual(['activityLogs']);
    const now = await countAll();
    for (const name of Object.keys(counts).filter((n) => n !== 'activityLogs')) {
      expect({ name, count: now[name] }).toEqual({ name, count: counts[name] });
    }
    // One activity row per member per day, the new day included.
    const days = await col('activityLogs').aggregate([
      { $group: { _id: { m: '$membershipId', d: '$localDate' }, n: { $sum: 1 } } }, { $match: { n: { $gt: 1 } } },
    ]).toArray();
    expect(days).toEqual([]);
    // The fixture keeps its keys; only its dates moved with the run's today.
    expect(third.coaching.sessions.map((s) => s._id)).toEqual(first.coaching.sessions.map((s) => s._id));
    expect(third.coaching.today).toBe(addDays(TODAY, 1));
  }, RUN_MS);

  it('P11-T2 AC-6 a lead the seed has renamed is not written again into a database that holds it under its old name', async () => {
    const kpmId = await office();
    // A database seeded before the rename: Rina's lead under the AAB's name.
    await col('leads').updateOne({ kpmId, name: 'Ibu Rosa Damayanti' }, { $set: { name: 'Ibu Dewi Lestari' } });
    const counts = await countAll();
    const again = await seedDemo({ clock, log: quiet });
    expect(again.written).toEqual({});
    expect(await countAll()).toEqual(counts);
    expect(await col('leads').countDocuments({ kpmId, name: { $in: ['Ibu Rosa Damayanti', 'Ibu Dewi Lestari'] } })).toBe(1);
  }, RUN_MS);
});

describe('P11-T2 AC-5 a run at 03:30 on 16 March 2027 in Jakarta, still the 15th in UTC', () => {
  const clock = new FixedClock(new Date('2027-03-15T20:30:00Z'));
  const TODAY = '2027-03-16';
  let run: SeedResult;
  let ids: Record<CoacheeKey, string>;

  beforeAll(async () => {
    await startMongo();
    run = await seedDemo({ clock, log: quiet });
    ids = await coacheeIds();
  }, RUN_MS);
  afterAll(stopMongo);

  it("P11-T2 AC-5 the fixture counts from the office's today, not the server's", () => {
    expect(run.coaching.today).toBe(TODAY);
    const rina = run.coaching.sessions.filter((s) => s.coacheeMembershipId === ids.rina).map((s) => s.date);
    expect(rina).toEqual(['2027-03-02', '2027-03-09', TODAY]);
    const sari = run.coaching.sessions.filter((s) => s.coacheeMembershipId === ids.sari).map((s) => s.date);
    expect(sari).toEqual(['2027-02-23', '2027-03-04']);
    // Today's instants are never after the run.
    for (const session of run.coaching.sessions) {
      expect(session.createdAt.getTime()).toBeLessThanOrEqual(clock.now().getTime());
      expect(session.updatedAt.getTime()).toBeLessThanOrEqual(clock.now().getTime());
    }
  });

  it('P11-T2 AC-5 the goals are for the current year, and last year is last year', async () => {
    const kpmId = await office();
    const goals = await col('goals').find({ kpmId }).toArray();
    expect([...new Set(goals.map((g) => g.period))].sort()).toEqual(['2026', '2027']);
    expect(goals.filter((g) => g.period === '2026').map((g) => g.membershipId)).toEqual([ids.rina]);
    for (const key of KEYS.filter((k) => k !== 'sari')) {
      expect({ key, goal: Boolean(goals.find((g) => g.membershipId === ids[key] && g.period === '2027')) })
        .toEqual({ key, goal: true });
    }
  });

  it("P11-T2 AC-5 activity, leads and production are dated from the office's today", async () => {
    const kpmId = await office();
    const latest = async (key: CoacheeKey) => (await col('activityLogs')
      .find({ kpmId, membershipId: ids[key] }).sort({ localDate: -1 }).limit(1).toArray())[0]?.localDate;
    expect(await latest('indah')).toBe(TODAY);
    expect(await latest('rina')).toBe(TODAY);
    expect(await latest('budi')).toBe('2027-03-07');
    const melati = await col('leads').findOne({ kpmId, name: 'Ibu Melati Kusumawardani' });
    expect(melati).toMatchObject({ nextActionDate: '2027-03-18', commitments: [expect.objectContaining({ month: '2027-03' })] });
    const months = await col('monthlyAgentData').distinct('month', { kpmId });
    // This month and last; and since Phase 18 (`reporting-fixture.ts`) the files from January last year to three months
    // ago — the month before last, January, left empty as it always was.
    const history = Array.from({ length: 12 }, (_, i) => `2026-${String(i + 1).padStart(2, '0')}`);
    expect(months.sort()).toEqual([...history, '2027-02', '2027-03']);
  });

  it('P11-T2 AC-5 the planned statuses hold in another month too', async () => {
    for (const key of KEYS) {
      const result = await statusOf(ids[key], TODAY);
      expect({ key, status: result.status }).toEqual({ key, status: ROSTER_PLAN[key].status });
    }
  });
});
