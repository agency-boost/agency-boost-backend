import mongoose from 'mongoose';
import { FixedClock } from '@/common/clock/clock.port';
import { RequestContext } from '@/common/context/request-context';
import { up as mocPersistency } from '@/migrations/0026-moc-persistency';
import { DirectoryService } from '@/modules/org/directory.service';
import type { KpmAnalyticsView } from '@/modules/reporting/kpm-analytics.service';
import type { KpmOverviewView } from '@/modules/reporting/kpm-overview.service';
import type { PlatformAnalyticsView } from '@/modules/reporting/platform-analytics.service';
import { clearCollections, startMongo, stopMongo } from '../../../test/mongo';
import { configModule } from '../../../test/config-module';
import { seedDemo } from '../demo';
import { REPORTING_RECRUIT_TARGET } from '../reporting-fixture';

const RUN_MS = 300_000;
const quiet = () => undefined;
const col = (name: string) => mongoose.connection.db!.collection(name);

/** The account's live membership in an office, as a signed-in context. */
async function as(code: string, email: string, flags: { owner?: boolean; admin?: boolean } = {}): Promise<RequestContext> {
  const kpm = await col('kpms').findOne({ code });
  const account = await col('users').findOne({ email });
  const member = (await col('memberships').findOne({ kpmId: String(kpm!._id), userId: String(account!._id), status: 'active' }))!;
  return new RequestContext(String(member.userId), 'none', {
    membershipId: String(member._id), kpmId: member.kpmId, orgLevelCode: member.orgLevelCode, hierarchyRole: member.role,
    status: 'active', isKpmOwner: flags.owner ?? false, isKpmAdmin: flags.admin ?? false, directCount: 0,
  } as never);
}

/**
 * **Phase 18 — the Owner's reporting, seeded** (P18-T1 AC-13, P18-T2 AC-11, P18-T8 AC-5; `reporting-fixture.ts`).
 *
 * The seed run as the command runs it, then read back through the reports' own services, so what is asserted is
 * what the Owner, the Admin and the Super Admin see on a fresh seed — every state the phase file's *Seed* asks for.
 */
describe('Phase 18 the Owner’s reporting seed — a run at 10:00 on 9 October 2026 in Jakarta', () => {
  const clock = new FixedClock(new Date('2026-10-09T03:00:00Z'));
  let wired: ReturnType<typeof configModule>;
  let overview: KpmOverviewView;
  let analytics: KpmAnalyticsView;
  let previous: KpmAnalyticsView;
  let platform: PlatformAnalyticsView;

  beforeAll(async () => {
    await startMongo();
    await clearCollections();
    await seedDemo({ clock, log: quiet });
    wired = configModule(clock.now());
    await Promise.all(mongoose.modelNames().map((name) => mongoose.model(name).init()));
    const owner = await as('0417', 'owner@kpm0417.test', { owner: true });
    overview = await wired.kpmOverview.read(owner);
    analytics = await wired.kpmAnalytics.read(owner);
    previous = await wired.kpmAnalytics.read(owner, { period: 'previous_month' });
    platform = await wired.platformAnalytics.read(RequestContext.platform('root'));
  }, RUN_MS);
  afterAll(stopMongo);

  const agency = (name: string) => analytics.agencies.find((a) => a.head.name === name)!;

  it('P18-T1 AC-13 five AB agencies: the Owner’s, the Admin’s, Agus’s, Yosef’s and Satria’s; Satria’s furthest behind', () => {
    expect(analytics.agencies.map((a) => a.head.name).sort())
      .toEqual(['Agus Prasetyo', 'Maya Halim', 'Satria Nugraha', 'Wilson Tanoto', 'Yosef Tambunan']);
    expect(analytics.agencies.find((a) => a.head.isReader)!.head.name).toBe('Wilson Tanoto');
    expect(overview.production.agencies[0].name).toBe('Satria Nugraha');
    expect(overview.production.agencies).toHaveLength(5);
    expect(agency('Yosef Tambunan').aabUnits.map((u) => u.head.name)).toEqual(['Winda Anggraeni']);
    expect(agency('Yosef Tambunan').manpower).toEqual({ aab: 1, agents: 8, total: 10 });
  });

  it('P18-T1 AC-13 the leaderboard ranks the four ABs who lead somebody; Satria’s people were coached by nobody this week', () => {
    expect(overview.coaching.leaderboard.map((l) => l.name).sort())
      .toEqual(['Agus Prasetyo', 'Satria Nugraha', 'Wilson Tanoto', 'Yosef Tambunan']);
    expect(overview.coaching.leaderboard.find((l) => l.name === 'Satria Nugraha')).toMatchObject({ teamSize: 3, coached: 0, pct: 0 });
    expect(overview.coaching.leaderboard.find((l) => l.name === 'Yosef Tambunan')!.coached).toBe(3);
  });

  it('P18-T1 AC-13 who hasn’t logged: the two who never have, then the longest silent — the Admin, 13 days ago', async () => {
    const list = await wired.kpmOverview.notLogged(await as('0417', 'owner@kpm0417.test', { owner: true }));
    expect(list.members.map((m) => [m.name, m.daysSince])).toEqual([
      ['Agus Prasetyo', null], ['Raka Aditama', null], ['Maya Halim', 13],
    ]);
    expect(list.total).toBeGreaterThan(3);
  });

  it('P18-T1 AC-13 the Owner and Maya logged weeks ago and not since; Gilang left Yosef’s agency last month', async () => {
    const owner = await as('0417', 'owner@kpm0417.test', { owner: true });
    const directory = new DirectoryService(wired.memberships, wired.users as never, wired.kpms as never);
    const people = (await wired.directoryColumns.decorate(owner, await directory.list(owner, { limit: 200 }))).members;
    expect(people.find((m) => m.fullName === 'Maya Halim')).toMatchObject({ lastActivityDays: 13 });
    expect(people.find((m) => m.fullName === 'Wilson Tanoto')).toMatchObject({ lastActivityDays: 11 });
    const gilang = (await col('memberships').findOne({ agentCode: 'PRU-87015' }))!;
    expect(gilang).toMatchObject({ status: 'removed' });
    expect((gilang.removedAt as Date).toISOString().slice(0, 7)).toBe('2026-09');
    // On every file this year to July; the Overview's year to date holds it, the analytics' total says how much (OD-74).
    const files = await col('monthlyAgentData').find({ membershipId: String(gilang._id), month: { $gte: '2026-01' } }).sort({ month: 1 }).toArray();
    expect(files.map((f) => f.month)).toEqual(['2026-01', '2026-02', '2026-03', '2026-04', '2026-05', '2026-06', '2026-07']);
    expect(analytics.total.leaversExcludedMinor).toBe(files.at(-1)!.apeYtd.value);
    expect(overview.production.ytd.achievedMinor).toBe((analytics.total.apeAnnual.achievedMinor ?? 0) + files.at(-1)!.apeYtd.value);
  });

  it('P18-T1 AC-13 the recruitment target is 15, set by the Owner this month; late stages and two closed won last month', async () => {
    expect(overview.recruitment.target).toBe(REPORTING_RECRUIT_TARGET);
    expect(overview.recruitment.closedLastMonth).toBeGreaterThanOrEqual(2);
    expect(overview.recruitment.expectedToClose).toBeGreaterThanOrEqual(3);
    const entry = await col('auditLog').findOne({ action: 'kpm_overview.recruit_target_set' });
    expect(entry).toMatchObject({ before: null, after: { month: '2026-10', target: 15 } });
  });

  it('P18-T1 AC-13 a year of files: the month before last empty, nothing waited on, a projection to run on', () => {
    // October held: the year to date waits on nothing (item 3), August's gap covered by October's own.
    expect(overview.production.ytd.missingMonths).toEqual([]);
    // October held, August not: the year to date as of October covers ten months, the missing one included.
    expect(overview.production.projectionMinor).toBe(Math.round((overview.production.ytd.achievedMinor! / 10) * 12));
    expect(analytics.monthly.map((m) => [m.month, m.apeMinor === null])).toEqual([
      ['2026-04', false], ['2026-05', false], ['2026-06', false], ['2026-07', false], ['2026-08', true], ['2026-09', false],
    ]);
  });

  it('P18-T2 AC-11 Yosef’s agency at Star Club and meeting MOC on the standard path; Winda’s unit —; Satria’s failing with its gaps', () => {
    const yosef = agency('Yosef Tambunan');
    expect(yosef.club).toEqual({ code: 'STAR_CLUB', label: 'Star Club' });
    expect(yosef.moc).toMatchObject({ status: 'met', path: 'Met via the standard three-criteria path.' });
    // Winda's persistency is not on this month's file; her Monthly2 AA is a count, every agent of hers on both files.
    expect(yosef.aabUnits[0].moc).toMatchObject({ status: 'unknown', missing: 'Not uploaded yet: Rolling Persistency — DU.' });
    expect(yosef.aabUnits[0].moc!.criteria.find((c) => c.code === 'MONTHLY2_AA')).toMatchObject({ current: 2, met: true });
    expect(analytics.mocRulesText).toBe(
      'AAB: Net APE ≥ Rp200M AND Monthly2 AA ≥ 2 AND Rolling Persistency DU ≥ 75%.\n'
      + 'AB: (Net APE ≥ Rp600M AND Monthly2 AA DU ≥ 4 / DG ≥ 6 AND Rolling Persistency DU/DG ≥ 75%) OR Direct AB (AB on AB) ≥ 5.',
    );
    const satria = agency('Satria Nugraha');
    expect(satria.moc!.status).toBe('not_met');
    expect(satria.moc!.criteria.filter((c) => c.met === false).map((c) => c.code))
      .toEqual(['NET_APE', 'MONTHLY2_AA_DU', 'MONTHLY2_AA_DG', 'MOC_PERSISTENCY', 'DIRECT_AB_COUNT']);
    expect(satria.club).toBeNull();
  });

  it('P18-T2 AC-3 the period moves the month: September’s file is held, last month’s target fixed', () => {
    expect(previous.month).toBe('2026-09');
    expect(previous.total.apeMonth.achievedMinor).not.toBeNull();
    expect(previous.total.manpower).toEqual(analytics.total.manpower);
  });

  it('P18-T6 AC-1 on the seed, the total equals the Overview: headcount, 7-day coverage', () => {
    expect(analytics.total.manpower.total).toBe(overview.composition.total);
    expect(analytics.total.coached7d).toEqual(overview.coaching.coverage7d);
  });

  it('P18-T8 AC-5 sign-ins across offices: most of 0417 within the week; none of 0601’s within thirty days', () => {
    const office = (code: string) => platform.offices.find((o) => o.code === code)!;
    expect(office('0417').signedIn7d).toBeGreaterThan(office('0417').members / 2);
    expect(office('0417').signedIn30d).toBeGreaterThan(office('0417').signedIn7d);
    expect(office('0417').signedIn30d).toBeLessThan(office('0417').members);
    expect(office('0601')).toMatchObject({ signedIn30d: 0, state: 'ended' });
    expect(office('0555').signedIn7d).toBeGreaterThan(0);
    expect(office('0701').members).toBeGreaterThan(0);
  });

  it('P18-T1 AC-12 0555’s Owner reads 0555’s own figures; its two members joined two months ago', async () => {
    const b = await wired.kpmOverview.read(await as('0555', 'owner@kpm0555.test', { owner: true }));
    expect(b.office.code).toBe('0555');
    expect(b.composition).toMatchObject({ total: 2, newThisMonth: 0 });
    expect(b.engagement.loggedThisMonth.lastMonthToDate).not.toBeNull();
    expect(b.production.ytd.achievedMinor).not.toBeNull();
    expect(b.coaching.coverage30d.count).toBeGreaterThan(0);
  });

  it('P18-T2 AC-4 the MOC migration on the seed: every rule carries persistency; run again, it changes nothing', async () => {
    const rules = await col('qualificationRules').find({ kind: 'moc', deletedAt: null }).toArray();
    for (const rule of rules) {
      expect(rule.criteriaGroups[0].criteria.map((c: { metricKey: string }) => c.metricKey)).toContain('MOC_PERSISTENCY');
      expect(rule.waitingOnMetrics).toEqual([]);
    }
    expect(await mocPersistency(mongoose.connection.db!, clock.now())).toEqual({ added: 0, current: rules.length, cleared: 0 });
  });

  it('P18-T1 AC-13 a second run writes none of it', async () => {
    const again = await seedDemo({ clock, log: quiet });
    for (const name of ['kpmRecruitTargets', 'monthlyAgentData', 'dataUploadBatches', 'goals', 'coachingSessions', 'leads', 'memberships']) {
      expect([name, again.written[name] ?? 0]).toEqual([name, 0]);
    }
  }, RUN_MS);
});
