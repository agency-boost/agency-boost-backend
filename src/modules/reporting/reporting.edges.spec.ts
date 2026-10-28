import mongoose from 'mongoose';
import { FixedClock } from '@/common/clock/clock.port';
import { RequestContext } from '@/common/context/request-context';
import { officeHeadcount } from '@/domain/metrics/office-headcount';
import { MemberNames } from '@/modules/org/member-names.service';
import { MembershipRepository } from '@/modules/org/membership.repository';
import { Membership, MembershipSchema } from '@/modules/org/membership.schema';
import { User, UserSchema } from '@/modules/users/user.schema';
import { clearCollections, startMongo, stopMongo } from '../../../test/mongo';
import { configModule, provisionOffice } from '../../../test/config-module';
import { OfficePeople } from './office-people';

const M = 1_000_000 * 100;
const COMPANY = '66f0000000000000000000c9';
const EMPTY = '66f0000000000000000000e1';
const LONE = '66f0000000000000000000e2';
const JAN = '66f0000000000000000000e3';
const NEW = '66f0000000000000000000e4';
const NOBODY = '66f0000000000000000000e5';
const NAMELESS = '66f0000000000000000000e6';
/** P18.96-T5: an office of a company that is gone, so the platform's company count below is untouched. */
const JOINING = '66f0000000000000000000e7';
/** P18.97-T3 AC-10: an agency of 40, 23 of them producing this month — exactly 57,5%. */
const HALF = '66f0000000000000000000e8';

/**
 * **The states the prototype lacks, and the edges of the calendar** (P18-T1 AC-9, P18-T2 AC-9): an office with
 * nobody but its Owner and no file, session or lead — 0701's *Empty* — where every figure is `null` or a count of
 * nobody and nothing is divided by zero; an office whose company is gone; January, whose previous month is last
 * year's; and a save of the target that races another to the unique index.
 */
describe('the Owner’s reporting at its edges', () => {
  let wired: ReturnType<typeof configModule>;
  const db = () => mongoose.connection.db!;

  const place = async (kpmId: string, over: Record<string, unknown> = {}) => {
    const userId = new mongoose.Types.ObjectId();
    const id = new mongoose.Types.ObjectId();
    // Leader codes are unique, so they come from the id's counter (its last digits), never its head: an ObjectId
    // opens with the second it was made, so seven of its first digits name a sixteen-second window, and two
    // memberships placed inside one collided on the CI runner.
    await db().collection('users').insertOne({ _id: userId, email: `${id}@edge.test`, passwordHash: 'x', fullName: 'Hadi Gunawan', status: 'active', deletedAt: null });
    await db().collection('memberships').insertOne({
      _id: id, kpmId, userId: String(userId), agentCode: `E${id}`, agentSeq: 1, leaderCode: `L${String(id).slice(-7)}`, orgLevelId: 'x',
      orgLevelCode: 'AB', role: 'ab', leaderId: null, ancestorIds: [], depth: 0, status: 'active',
      joinedAt: new Date('2025-01-02T02:00:00Z'), deletedAt: null, ...over,
    });
    return new RequestContext(String(userId), 'none', {
      membershipId: String(id), kpmId, orgLevelCode: String(over.orgLevelCode ?? 'AB'), hierarchyRole: 'ab', status: 'active',
      isKpmOwner: true, isKpmAdmin: false, directCount: 0,
    } as never);
  };

  beforeAll(async () => {
    await startMongo();
    wired = configModule(new Date('2026-10-09T03:00:00Z'));
    await clearCollections();
    await db().collection('companies').insertOne({ _id: new mongoose.Types.ObjectId(COMPANY), name: 'Prudential', slug: 'edge', deletedAt: null });
    await (wired.kpms as { create: (d: unknown) => Promise<unknown> }).create([
      { _id: EMPTY, companyId: COMPANY, code: '0701', branchName: 'Cempaka Putih', timezone: 'Asia/Jakarta' },
      { _id: LONE, companyId: '66f0000000000000000000ff', code: '0702', branchName: 'Gone', timezone: 'Asia/Jakarta' },
      { _id: JAN, companyId: COMPANY, code: '0703', branchName: 'January', timezone: 'Asia/Jakarta' },
      { _id: NEW, companyId: COMPANY, code: '0704', branchName: 'New', timezone: 'Asia/Jakarta' },
      { _id: NOBODY, companyId: COMPANY, code: '0705', branchName: 'Nobody yet', timezone: 'Asia/Jakarta' },
      { _id: NAMELESS, companyId: COMPANY, code: '0706', branchName: 'Nameless', timezone: 'Asia/Jakarta' },
    ]);
    await wired.orgLevels.seedDefaultLadder(COMPANY);
    await provisionOffice(wired, EMPTY, COMPANY);
    await wired.campaigns.seedForCompany(COMPANY);
  }, 120_000);

  afterAll(stopMongo);

  it('P18-T1 AC-9, P18-T2 AC-9 an office with nobody but its Owner and nothing on file: nulls and nobody, never 0 for want of data', async () => {
    const owner = await place(EMPTY);
    const overview = await wired.kpmOverview.read(owner);
    expect(overview.composition).toMatchObject({ total: 1, newThisMonth: 0 });
    expect(overview.engagement.loggedThisMonth).toEqual({ count: 0, of: 1, pct: 0, lastMonthToDate: 0 });
    // P18.97-T3 AC-5 (UI-017): the Owner, an AB who leads nobody, is on the board with no rate — never left out, never 0%.
    expect(overview.coaching.leaderboard).toEqual([
      { membershipId: owner.membershipId, name: 'Hadi Gunawan', teamSize: 0, coached: 0, pct: null, leads: false },
    ]);
    expect(overview.recruitment).toEqual({ expectedToClose: 0, pipelineNow: 0, closedLastMonth: 0, target: null, targetMonth: '2026-10' });
    expect(overview.production).toMatchObject({
      ytd: { achievedMinor: null, targetMinor: null, pct: null, membersWithoutGoal: 1 }, projectionMinor: null,
    });
    // Nothing held this year: every month before October is waited on; October's file is not due yet (item 3).
    expect(overview.production.ytd.missingMonths).toEqual([
      '2026-01', '2026-02', '2026-03', '2026-04', '2026-05', '2026-06', '2026-07', '2026-08', '2026-09',
    ]);
    expect(overview.production.agencies).toEqual([
      { membershipId: owner.membershipId, name: 'Hadi Gunawan', achievedMinor: null, targetMinor: null, pct: null, aabUnits: [] },
    ]);
    const analytics = await wired.kpmAnalytics.read(owner, { period: 'previous_month' });
    expect(analytics.total).toMatchObject({ activeAgents: null, apeMonth: { achievedMinor: null }, leaversExcludedMinor: null, mocMet: 0, mocOf: 1 });
    expect(analytics.monthly.every((m) => m.apeMinor === null)).toBe(true);
    const moc = analytics.agencies[0].moc!;
    expect(moc.status).toBe('unknown');
    expect(moc.criteria.find((c) => c.code === 'MONTHLY2_AA_DU')).toMatchObject({ current: null, met: null, period: 'Not uploaded yet' });
    expect(moc.criteria.find((c) => c.code === 'MOC_PERSISTENCY')).toMatchObject({ current: null, period: 'Not uploaded yet' });
    expect(moc.criteria.find((c) => c.code === 'NET_APE')).toMatchObject({ current: null, period: '2026' });
    expect(analytics.agencies[0].club).toBeNull();
    expect((await wired.kpmOverview.notLogged(owner)).total).toBe(1);
  });

  it('P18-T2 AC-9 an office whose company is gone: no ladder, no rules, so no MOC and no club, and a row on a rung nobody names', async () => {
    const owner = await place(LONE, { orgLevelCode: 'AB' });
    await place(LONE, { orgLevelCode: 'MENTOR', role: 'agent', leaderId: owner.membershipId, ancestorIds: [owner.membershipId], joinedAt: null });
    const overview = await wired.kpmOverview.read(owner);
    expect(overview.office.companyName).toBe('');
    expect(overview.composition.rungs).toEqual([{ code: 'AB', label: 'AB', count: 1 }, { code: 'MENTOR', label: 'MENTOR', count: 1 }]);
    const analytics = await wired.kpmAnalytics.read(owner);
    expect(analytics.agencies[0]).toMatchObject({ moc: null, club: null });
    expect(analytics.agencies[0].members).toEqual([expect.objectContaining({ rung: { code: 'MENTOR', label: 'MENTOR' } })]);
    expect(analytics.total.mocOf).toBe(0);
    expect((await wired.kpmOverview.notLogged(owner)).members.map((m) => m.rung.code).sort()).toEqual(['AB', 'MENTOR']);
  });

  it('P18-T2 AC-3 in January, the previous month is last year’s: its file against last year’s goals as fixed then', async () => {
    (wired.clock as FixedClock).set(new Date('2027-01-12T03:00:00Z'));
    try {
      const owner = await place(JAN);
      const agent = await place(JAN, { orgLevelCode: 'AGENT', role: 'agent', leaderId: owner.membershipId, ancestorIds: [owner.membershipId] });
      const cell = (value: number) => ({ value, provenance: 'imported', sourceBatchId: null });
      await db().collection('monthlyAgentData').insertMany(['2026-11', '2026-12'].map((month, i) => ({
        kpmId: JAN, membershipId: agent.membershipId, month, agentCode: 'A', deletedAt: null,
        apeMonthly: cell(10 * M), apeYtd: cell((100 + i * 10) * M), policyCountMonthly: cell(1),
      })));
      await db().collection('goals').insertOne({
        kpmId: JAN, membershipId: agent.membershipId, period: '2026', mode: 'direct', annualApeTargetMinor: 240 * M,
        savingsTargetMinor: 0, commissionRatePct: 0, monthsLeftOverride: null, apeAchievedMinor: 0, caseSizeMinor: 18 * M,
        leadsToApptPct: 30, closingRatePct: 30, savedAt: new Date('2026-01-05T02:00:00Z'), savedByMembershipId: agent.membershipId,
        version: 1, deletedAt: null,
        cascadeMapping: { leadsCode: 'LEADS_CONTACTED', appointmentsCode: 'SELL_PRESENTATION', closingsCode: 'SELL_SUBMISSION' },
      });
      const december = await wired.kpmAnalytics.read(owner, { period: 'previous_month' });
      expect(december.month).toBe('2026-12');
      // December's target as fixed when it began: (240 − 100) over the one month left.
      expect(december.total.apeMonth).toEqual({ achievedMinor: 10 * M, targetMinor: 140 * M, pct: 7 });
      expect(december.total.activeAgents).toBe(1);
      // This year has nothing held yet, so the year to date is nobody's.
      expect(december.total.apeAnnual.achievedMinor).toBeNull();
      const moc = december.agencies[0].moc!;
      expect(moc.criteria.find((c) => c.code === 'MONTHLY2_AA_DU')).toMatchObject({ period: 'Nov and Des 2026', current: 1 });
      expect(moc.criteria.find((c) => c.code === 'NET_APE')).toMatchObject({ period: '2027', current: null });
      // A member with no goal for the year is measured against no target, whatever the month.
      const lone = await wired.kpmAnalytics.read(owner, { period: 'this_month' });
      expect(lone.total.apeMonth.targetMinor).toBeNull();
    } finally {
      (wired.clock as FixedClock).set(new Date('2026-10-09T03:00:00Z'));
    }
  });

  it('P18-T1 AC-4 an office whose people all joined this month has no last month to compare; namesakes tie on the board', async () => {
    const owner = await place(NEW, { joinedAt: new Date('2026-10-02T03:00:00Z') });
    const twin = await place(NEW, {
      leaderId: owner.membershipId, ancestorIds: [owner.membershipId], joinedAt: new Date('2026-10-02T03:00:00Z'), agentSeq: 2,
    });
    await place(NEW, {
      orgLevelCode: 'AGENT', role: 'agent', leaderId: twin.membershipId, ancestorIds: [owner.membershipId, twin.membershipId],
      joinedAt: new Date('2026-10-03T03:00:00Z'), agentSeq: 3,
    });
    // A member whose account has gone: no name to show, never a failure.
    const nameless = new mongoose.Types.ObjectId();
    await db().collection('memberships').insertOne({
      _id: nameless, kpmId: NEW, userId: String(new mongoose.Types.ObjectId()), agentCode: 'GONE', agentSeq: 4, leaderCode: 'GONE0001',
      orgLevelId: 'x', orgLevelCode: 'AGENT', role: 'agent', leaderId: twin.membershipId, ancestorIds: [owner.membershipId, twin.membershipId],
      depth: 2, status: 'active', joinedAt: new Date('2026-10-04T03:00:00Z'), deletedAt: null,
    });
    // And a leaver this year with nothing on file.
    await place(NEW, {
      status: 'removed', joinedAt: new Date('2026-10-01T03:00:00Z'), removedAt: new Date('2026-10-05T03:00:00Z'), agentSeq: 5,
      orgLevelCode: 'AGENT', role: 'agent',
    });

    const overview = await wired.kpmOverview.read(owner);
    expect(overview.composition).toMatchObject({ total: 4, newThisMonth: 4 });
    expect(overview.engagement.loggedThisMonth.lastMonthToDate).toBeNull();
    expect(overview.coaching.leaderboard.map((l) => [l.name, l.pct])).toEqual([['Hadi Gunawan', 0], ['Hadi Gunawan', 0]]);
    expect(overview.coaching.leaderboard.map((l) => l.membershipId))
      .toEqual([owner.membershipId, twin.membershipId].sort());
    expect((await wired.kpmOverview.notLogged(owner)).members.find((m) => m.membershipId === String(nameless))!.name).toBe('');
    const analytics = await wired.kpmAnalytics.read(owner);
    expect(analytics.total.leaversExcludedMinor).toBeNull();
    expect(analytics.agencies.flatMap((a) => a.members).find((m) => m.membershipId === String(nameless))!.name).toBe('');
    // September had none of them (item 1): its month's figures are nobody's; today's manpower is everybody's.
    const september = await wired.kpmAnalytics.read(owner, { period: 'previous_month' });
    expect(september.total).toMatchObject({
      apeMonth: { achievedMinor: null, targetMinor: null, pct: null }, activeAgents: null,
      leads: { sales: 0, salesPotential: 0, recruit: 0, recruitPotential: 0 }, manpower: { total: 4 },
    });
  });

  it('P18-T1 AC-5, P18-T2 AC-2 leaders whose accounts have gone: an empty name on the board, the agency, the unit and the row', async () => {
    const owner = await place(NAMELESS);
    // An AB and the AAB below them, both with no account behind the membership, and an agent under the AAB.
    const ab = new mongoose.Types.ObjectId();
    const aab = new mongoose.Types.ObjectId();
    const ghost = (id: mongoose.Types.ObjectId, over: Record<string, unknown>) => db().collection('memberships').insertOne({
      _id: id, kpmId: NAMELESS, userId: String(new mongoose.Types.ObjectId()), agentCode: `G${id}`, leaderCode: `G${String(id).slice(-7)}`,
      orgLevelId: 'x', status: 'active', joinedAt: new Date('2025-01-02T02:00:00Z'), deletedAt: null, ...over,
    });
    await ghost(ab, { agentSeq: 2, orgLevelCode: 'AB', role: 'ab', leaderId: owner.membershipId, ancestorIds: [owner.membershipId], depth: 1 });
    await ghost(aab, { agentSeq: 3, orgLevelCode: 'AAB', role: 'aab', leaderId: String(ab), ancestorIds: [owner.membershipId, String(ab)], depth: 2 });
    await place(NAMELESS, {
      agentSeq: 4, orgLevelCode: 'AGENT', role: 'agent', leaderId: String(aab), ancestorIds: [owner.membershipId, String(ab), String(aab)],
    });
    const overview = await wired.kpmOverview.read(owner);
    expect(overview.coaching.leaderboard.find((l) => l.membershipId === String(ab))!.name).toBe('');
    const row = overview.production.agencies.find((a) => a.membershipId === String(ab))!;
    expect([row.name, row.aabUnits.map((u) => u.name)]).toEqual(['', ['']]);
    const analytics = await wired.kpmAnalytics.read(owner);
    const agency = analytics.agencies.find((a) => a.head.membershipId === String(ab))!;
    expect([agency.head.name, agency.aabUnits[0].head.name, agency.head.leads]).toEqual(['', '', true]);
  });

  it('P18.97-T3 AC-10 the active share is the server’s, rateOver’s whole percent: 23 producing of 40 is 58%, never 57', async () => {
    await (wired.kpms as { create: (d: unknown) => Promise<unknown> }).create([
      // A company that is gone, as JOINING's is, so the platform's count of Prudential's offices below is untouched.
      { _id: HALF, companyId: '66f0000000000000000000fd', code: '0708', branchName: 'Half', timezone: 'Asia/Jakarta' },
    ]);
    const owner = await place(HALF, { leaderCode: 'HALF0001', agentSeq: 1 });
    const agents = Array.from({ length: 39 }, () => new mongoose.Types.ObjectId());
    await db().collection('memberships').insertMany(agents.map((id, i) => ({
      _id: id, kpmId: HALF, userId: String(new mongoose.Types.ObjectId()), agentCode: `H${id}`, agentSeq: 2 + i,
      leaderCode: `H${String(id).slice(-7)}`, orgLevelId: 'x', orgLevelCode: 'AGENT', role: 'agent', leaderId: owner.membershipId,
      ancestorIds: [owner.membershipId], depth: 1, status: 'active', joinedAt: new Date('2025-01-02T02:00:00Z'), deletedAt: null,
    })));
    const cell = (value: number) => ({ value, provenance: 'imported', sourceBatchId: null });
    // October's file for all forty: the Owner and twenty-two agents with production, the other seventeen with none.
    await db().collection('monthlyAgentData').insertMany([owner.membershipId, ...agents.map(String)].map((id, i) => ({
      kpmId: HALF, membershipId: id, month: '2026-10', agentCode: 'H', deletedAt: null,
      apeMonthly: cell(i < 23 ? 5 * M : 0), apeYtd: cell(i < 23 ? 50 * M : 0), policyCountMonthly: cell(i < 23 ? 1 : 0),
    })));

    const analytics = await wired.kpmAnalytics.read(owner, { period: 'this_month' });
    expect(Math.round((23 / 40) * 100)).toBe(57);
    expect(analytics.total).toMatchObject({ activeAgents: 23, activePct: 58, manpower: { total: 40 } });
    expect(analytics.agencies[0]).toMatchObject({ activeAgents: 23, activePct: 58, manpower: { total: 40 } });
    // The (Direct) row is the same forty here; September holds no file: no count, and no share of it.
    expect(analytics.agencies[0].direct).toMatchObject({ activeAgents: 23, activePct: 58 });
    const september = await wired.kpmAnalytics.read(owner, { period: 'previous_month' });
    expect(september.total).toMatchObject({ activeAgents: null, activePct: null });
  });

  it('P18.97-T3 AC-5 every AB on the board: the leaders lowest first, then each who leads nobody A to Z, a gone account’s name empty', async () => {
    const owner = await place(NAMELESS, { leaderCode: 'NOTEAM01', agentSeq: 10 });
    // Two ABs under the Owner who lead nobody — Zul and one whose account has gone — and an agent under the Owner.
    const zul = await place(NAMELESS, {
      leaderCode: 'NOTEAM02', agentSeq: 11, leaderId: owner.membershipId, ancestorIds: [owner.membershipId], depth: 1,
    });
    await db().collection('users').updateOne({ _id: new mongoose.Types.ObjectId(zul.userId) }, { $set: { fullName: 'Zul Anwar' } });
    const gone = new mongoose.Types.ObjectId();
    await db().collection('memberships').insertOne({
      _id: gone, kpmId: NAMELESS, userId: String(new mongoose.Types.ObjectId()), agentCode: `G${gone}`, agentSeq: 12,
      leaderCode: 'NOTEAM03', orgLevelId: 'x', orgLevelCode: 'AB', role: 'ab', leaderId: owner.membershipId,
      ancestorIds: [owner.membershipId], depth: 1, status: 'active', joinedAt: new Date('2025-01-02T02:00:00Z'), deletedAt: null,
    });
    await place(NAMELESS, {
      leaderCode: 'NOTEAM04', agentSeq: 13, orgLevelCode: 'AGENT', role: 'agent', leaderId: owner.membershipId,
      ancestorIds: [owner.membershipId], depth: 1,
    });

    const board = (await wired.kpmOverview.read(owner)).coaching.leaderboard;
    const mine = board.filter((row) => [owner.membershipId, zul.membershipId, String(gone)].includes(row.membershipId));
    expect(mine.map((row) => [row.name, row.leads, row.teamSize, row.pct])).toEqual([
      ['Hadi Gunawan', true, 3, 0], ['', false, 0, null], ['Zul Anwar', false, 0, null],
    ]);
    // The leaders first, every one: no row that leads nobody sorts above one that leads somebody.
    const firstNoTeam = board.findIndex((row) => !row.leads);
    expect(board.slice(firstNoTeam).every((row) => !row.leads)).toBe(true);
  });

  it('P18-T1 AC-6 a save that races another to the month’s unique index is retried once as an update; another failure is not swallowed', async () => {
    const owner = await place(EMPTY, { leaderCode: 'RACE0001', agentSeq: 2 });
    const model = (wired.recruitTargets as unknown as { model: mongoose.Model<unknown> }).model;
    const spy = jest.spyOn(model, 'findOneAndUpdate')
      .mockImplementationOnce((() => ({ exec: async () => { throw Object.assign(new Error('E11000'), { code: 11000 }); } })) as never);
    expect(await wired.kpmOverview.setRecruitTarget(owner, { month: '2026-10', target: 7 })).toEqual({ month: '2026-10', target: 7 });
    expect(spy).toHaveBeenCalledTimes(2);
    spy.mockReset();
    spy.mockImplementationOnce((() => ({ exec: async () => { throw new Error('the database is gone'); } })) as never);
    await expect(wired.kpmOverview.setRecruitTarget(owner, { month: '2026-10', target: 8 })).rejects.toThrow('the database is gone');
    spy.mockRestore();
  });

  it('P18-T1 AC-6 two first saves at once (item 4): one creates the row, the other’s *before* is what the first wrote', async () => {
    const owner = await place(NOBODY, { leaderCode: 'RACE0002', agentSeq: 7 });
    const admin = await place(NOBODY, { leaderCode: 'RACE0003', agentSeq: 8 });
    // The month's unique index is the guard against two rows: built before the race, as a deployed database has it.
    await (wired.recruitTargets as unknown as { model: mongoose.Model<unknown> }).model.init();
    try {
      await Promise.all([
        wired.kpmOverview.setRecruitTarget(owner, { month: '2026-10', target: 11 }),
        wired.kpmOverview.setRecruitTarget(admin, { month: '2026-10', target: 12 }),
      ]);
      const entries = await db().collection('auditLog').find({ action: 'kpm_overview.recruit_target_set', kpmId: NOBODY }).toArray();
      const row = await db().collection('kpmRecruitTargets').findOne({ kpmId: NOBODY, month: '2026-10' });
      expect(await db().collection('kpmRecruitTargets').countDocuments({ kpmId: NOBODY })).toBe(1);
      // The first entry created the row; the second replaced exactly what the first wrote, and its after is the row.
      const created = entries.find((e) => e.before === null)!;
      const replaced = entries.find((e) => e.before !== null)!;
      expect(entries).toHaveLength(2);
      expect(replaced.before).toEqual(created.after);
      expect(replaced.after).toEqual({ month: '2026-10', target: row!.target });
      expect([created.targetId, replaced.targetId]).toEqual([String(row!._id), String(row!._id)]);
    } finally {
      await db().collection('memberships').deleteMany({ kpmId: NOBODY });
      await db().collection('kpmRecruitTargets').deleteMany({ kpmId: NOBODY });
    }
  });

  it('P18.96-T5 AC-1 manpower counts each member from their join date, not the day the system let them in (ADR-0172 §1)', async () => {
    await (wired.kpms as { create: (d: unknown) => Promise<unknown> }).create(
      { _id: JOINING, companyId: '66f0000000000000000000fe', code: '0707', branchName: 'Join dates', timezone: 'Asia/Jakarta' },
    );
    const owner = await place(JOINING, { joinDate: '2020-01-02', joinedAs: 'existing_agent', leaderCode: 'JOIN0001' });
    const today = new Date('2026-10-09T03:00:00Z');
    const agent = (seq: number, over: Record<string, unknown>) => place(JOINING, {
      orgLevelCode: 'AGENT', role: 'agent', leaderId: owner.membershipId, ancestorIds: [owner.membershipId], depth: 1,
      agentSeq: seq, leaderCode: `JOIN000${seq}`, joinedAt: today, ...over,
    });
    // All three let in today: an existing agent of eleven years, a hire who started in September, one who started on 5 October.
    await agent(2, { joinDate: '2015-03-02', joinedAs: 'existing_agent' });
    const september = await agent(3, { joinDate: '2026-09-20', joinedAs: 'new_hire' });
    await agent(4, { joinDate: '2026-10-05', joinedAs: 'new_hire' });

    // *Total members* is everybody; *new this month* only the one whose join date is in October.
    expect((await wired.kpmOverview.read(owner)).composition).toMatchObject({ total: 4, newThisMonth: 1 });

    // A reader that does not pass the office's zone reads it (the forum's scorecard): September's last day held three.
    const memberships = new MembershipRepository(mongoose.model(Membership.name, MembershipSchema, undefined, { overwriteModels: true }) as never);
    const people = new OfficePeople(
      memberships, new MemberNames(memberships, mongoose.model(User.name, UserSchema, undefined, { overwriteModels: true }) as never),
      wired.kpms as never, {} as never, {} as never, new FixedClock(today),
    );
    const { everyone } = await people.read(owner, null);
    expect(everyone.find((p) => p.membershipId === september.membershipId))
      .toMatchObject({ joinDate: '2026-09-20', joinDateStart: new Date('2026-09-19T17:00:00Z') });
    expect(officeHeadcount(everyone, new Date('2026-09-30T17:00:00Z'))).toBe(3);
    expect(officeHeadcount(everyone, new Date('2026-09-19T17:00:00Z'))).toBe(2);
    // The same with the zone given: one answer.
    expect((await people.read(owner, null, 'Asia/Jakarta')).everyone).toEqual(everyone);

    // The platform's adoption is when people started on AgencyBoost: all three joined it this month (kept on `joinedAt`).
    const platform = await wired.platformAnalytics.read(RequestContext.platform('root'));
    expect(platform.offices.find((o) => o.code === '0707')).toMatchObject({ members: 4, joinedThisMonth: 3 });
  });

  it('P18-T8 AC-2 the platform with an office of a company that is gone, and a company with no office', async () => {
    const view = await wired.platformAnalytics.read(RequestContext.platform('root'));
    // Its rungs by their codes: no ladder names them.
    expect(view.offices.find((o) => o.code === '0702')).toMatchObject({
      company: { name: '' }, state: 'active', members: 2,
      byRung: [{ code: 'AB', label: 'AB', count: 1 }, { code: 'MENTOR', label: 'MENTOR', count: 1 }],
    });
    expect(view.companies).toEqual([expect.objectContaining({ name: 'Prudential', offices: 5 })]);
    // An office nobody has joined yet: zeros, never a missing row.
    expect(view.offices.find((o) => o.code === '0705')).toMatchObject({
      members: 0, signedIn7d: 0, signedIn30d: 0, joinedThisMonth: 0,
      byRung: [{ code: 'AB', label: 'AB', count: 0 }, { code: 'AAB', label: 'AAB', count: 0 }, { code: 'AGENT', label: 'Agent', count: 0 }],
    });
    await db().collection('companies').insertOne({ name: 'Allianz Life', slug: 'allianz-edge', deletedAt: null });
    const again = await wired.platformAnalytics.read(RequestContext.platform('root'));
    expect(again.companies.find((c) => c.name === 'Allianz Life')).toMatchObject({ offices: 0, members: 0, byRung: [] });
  });
});
