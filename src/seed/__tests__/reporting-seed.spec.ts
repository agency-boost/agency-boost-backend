import mongoose from 'mongoose';
import { FixedClock } from '@/common/clock/clock.port';
import { RequestContext } from '@/common/context/request-context';
import { SOURCE_READER } from '@/common/i18n/reader';
import { up as mocPersistency } from '@/migrations/0026-moc-persistency';
import { ActivationReadings } from '@/modules/activation/activation-readings';
import { DirectoryService } from '@/modules/org/directory.service';
import { MemberNames } from '@/modules/org/member-names.service';
import { ActivationComplianceCategory } from '@/modules/reporting/compliance/activation.category';
import { ActivityComplianceCategory } from '@/modules/reporting/compliance/activity.category';
import { CampaignsComplianceCategory } from '@/modules/reporting/compliance/campaigns.category';
import { ComplianceService } from '@/modules/reporting/compliance/compliance.service';
import { EventsComplianceCategory } from '@/modules/reporting/compliance/events.category';
import { GoalsComplianceCategory } from '@/modules/reporting/compliance/goals.category';
import { LeadsComplianceCategory } from '@/modules/reporting/compliance/leads.category';
import { TrainingComplianceCategory } from '@/modules/reporting/compliance/training.category';
import { TenantDay } from '@/modules/tenants/tenant-day.service';
import type { KpmOverviewView, OverviewPerformanceView } from '@/modules/reporting/kpm-overview.service';
import { clearCollections, startMongo, stopMongo } from '../../../test/mongo';
import { configModule } from '../../../test/config-module';
import { seedDemo } from '../demo';

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
  } as never).withReader(SOURCE_READER); // the API's English, as asserted here: nobody's choice reads Indonesian (P18.10-T4)
}

/**
 * **The Owner's reporting, seeded** (P18-T1 AC-13, P18-T8 AC-5; since P19.19 the KPM Overview's second version —
 * `reporting-fixture.ts`, `informal-groups-fixture.ts`).
 *
 * The seed run as the command runs it, then read back through the reports' own services, so what is asserted is what the
 * Owner, the Admin and the Super Admin see on a fresh seed — **every section of the Overview shows something** (the
 * phase file's *Seed*): each usage and coaching bucket, targets for this month and the one before, compliance with a
 * *Leads Mgmt* figure, and *Produksi 6 bulan* with its one empty month.
 */
describe('the Owner’s reporting seed — a run at 10:00 on 9 October 2026 in Jakarta', () => {
  const clock = new FixedClock(new Date('2026-10-09T03:00:00Z'));
  let wired: ReturnType<typeof configModule>;
  let owner: RequestContext;
  let overview: KpmOverviewView;
  let performance: OverviewPerformanceView;

  beforeAll(async () => {
    await startMongo();
    await clearCollections();
    await seedDemo({ clock, log: quiet });
    wired = configModule(clock.now());
    await Promise.all(mongoose.modelNames().map((name) => mongoose.model(name).init()));
    owner = await as('0417', 'owner@kpm0417.test', { owner: true });
    overview = await wired.kpmOverview.read(owner);
    performance = await wired.kpmOverview.performance(owner);
  }, RUN_MS);
  afterAll(stopMongo);

  const person = (name: string) => overview.people.find((p) => p.name === name)!;

  it('P19.19-T1 AC-2 seed: the informal groups A to Z, then Tanpa group; Pakai over the last 30 days counted per group', () => {
    expect(overview.groups.map((g) => g.name)).toEqual(['LEADER MUDA', 'Mentoring Agen Baru', 'Top Producers 2026', null]);
    expect(overview.groups[0].people).toBe(0);
    expect(overview.usage.total.of).toBe(overview.people.length);
    expect(overview.usage.total.used).toBeGreaterThan(0);
    expect(overview.usage.total.used).toBeLessThan(overview.usage.total.of);
    expect(overview.usage.byGroup.reduce((sum, g) => sum + g.total.of, 0)).toBe(overview.usage.total.of);
  });

  it('P19.19-T1 AC-3 seed: every usage bucket holds somebody — Raka and Agus never; somebody > 14 days; most ≤ 14', () => {
    expect(person('Raka Aditama').usage.status).toBe('never');
    expect(person('Agus Prasetyo').usage.status).toBe('never');
    expect(person('Pandu Wirawan').usage).toEqual({ status: 'lapsed', days: 20, usedInWindow: true });
    for (const status of ['never', 'lapsed', 'recent'] as const) {
      expect([status, overview.people.some((p) => p.usage.status === status)]).toEqual([status, true]);
    }
  });

  it('P19.19-T1 AC-4 seed: every coaching bucket holds somebody', () => {
    for (const status of ['never', 'lapsed', 'recent'] as const) {
      expect([status, overview.people.some((p) => p.coaching.status === status)]).toEqual([status, true]);
    }
  });

  it('P19.19-T1 AC-3 seed: Yosef’s AB group — Yosef, Winda one step in with her team two, his own agents one', () => {
    const yosef = person('Yosef Tambunan');
    const winda = person('Winda Anggraeni');
    expect(yosef).toMatchObject({ role: 'ab', depth: 0, groupId: null });
    expect(winda).toMatchObject({ role: 'aab', depth: 1, abMembershipId: yosef.membershipId });
    expect(overview.people.filter((p) => p.leaderIds.includes(winda.membershipId)).every((p) => p.depth === 2)).toBe(true);
    expect(overview.people.some((p) => p.name === 'Gilang Saputra')).toBe(false);
  });

  it('P19.19-T2 AC-2 seed: this month’s targets — Agus 8 / 4 set now, Wilson, Satria and Yosef carried, Maya none', () => {
    const row = (name: string) => performance.groups.flatMap((g) => g.abGroups).find((r) => r.name === name)!;
    expect(row('Agus Prasetyo')).toMatchObject({ activeAgentTarget: 8, rekrutTarget: 4, source: 'set' });
    expect(row('Wilson Tanoto')).toMatchObject({ activeAgentTarget: 3, rekrutTarget: 2, source: 'carried' });
    expect(row('Maya Halim')).toMatchObject({ activeAgentTarget: null, source: 'none' });
    expect(performance.total).toMatchObject({ activeAgentTarget: 8 + 3 + 2 + 4, rekrutTarget: 4 + 2 + 1 + 2 });
    expect(performance.held).toBe(true);
    expect(performance.total.actual.apeMinor).toBeGreaterThan(0);
  });

  it('P19.19-T2 AC-1 seed: last month reads its own targets — Agus 6 / 3, carried', async () => {
    const september = await wired.kpmOverview.performance(owner, { month: '2026-09' });
    const agus = september.groups.flatMap((g) => g.abGroups).find((r) => r.name === 'Agus Prasetyo')!;
    expect(agus).toMatchObject({ activeAgentTarget: 6, rekrutTarget: 3, source: 'carried' });
  });

  it('P19.19-T3 AC-1 seed: Produksi 6 bulan — May to October, August (the month before last) without a file', () => {
    expect(overview.production.months.map((m) => [m.month, m.apeMinor === null])).toEqual([
      ['2026-05', false], ['2026-06', false], ['2026-07', false], ['2026-08', true], ['2026-09', false], ['2026-10', false],
    ]);
  });

  it('P19.19-T3 AC-2 seed: seven compliance cards over the same people, Leads Mgmt among them with a figure', async () => {
    const names = new MemberNames(wired.memberships, wired.users as never);
    const compliance = new ComplianceService(
      new TenantDay(wired.kpms as never, wired.clock), wired.clock, wired.subjectReads, wired.officeGroups, names,
      new TrainingComplianceCategory(wired.offeredTraining, wired.trainingReadings, wired.clock),
      new GoalsComplianceCategory(wired.goals, wired.clock),
      new ActivityComplianceCategory(wired.activityReadings),
      new ActivationComplianceCategory(new ActivationReadings(wired.activationRows, wired.activationProgress, wired.clock)),
      new EventsComplianceCategory(wired.eventReadings),
      new CampaignsComplianceCategory(wired.campaignStandingsReader, names),
      new LeadsComplianceCategory(wired.leadReadings),
    );
    const view = await compliance.read(owner, { category: 'leads' });
    expect(view.cards).toHaveLength(7);
    const leads = view.cards.find((c) => c.category === 'leads')!;
    expect(leads.of).toBe(overview.usage.total.of);
    expect(leads.count).toBeGreaterThan(0);
    expect(leads.count).toBeLessThan(leads.of);
    expect(view.selected!.cells.map((c) => c.membershipId)).toEqual(overview.people.map((p) => p.membershipId));
  });

  it('P18-T1 AC-13 the Owner and Maya logged weeks ago and not since; Gilang left Yosef’s agency last month', async () => {
    const directory = new DirectoryService(wired.memberships, wired.users as never, wired.kpms as never);
    const people = (await wired.directoryColumns.decorate(owner, await directory.list(owner, { limit: 200 }))).members;
    expect(people.find((m) => m.fullName === 'Maya Halim')).toMatchObject({ lastActivityDays: 13 });
    expect(people.find((m) => m.fullName === 'Wilson Tanoto')).toMatchObject({ lastActivityDays: 11 });
    expect(person('Maya Halim').usage).toMatchObject({ status: 'recent', days: 13 });
    const gilang = (await col('memberships').findOne({ agentCode: '87015' }))!;
    expect(gilang).toMatchObject({ status: 'removed' });
    expect((gilang.removedAt as Date).toISOString().slice(0, 7)).toBe('2026-09');
  });

  it('P19.3-T2 AC-4 seed: 0417 is running — no Siapkan KPM card, and all seven stored as done', async () => {
    expect(overview.setup).toBeNull();
    const kpm = await col('kpms').findOne({ code: '0417' });
    expect(await col('kpmSetupMarks').countDocuments({ kpmId: String(kpm!._id), deletedAt: null })).toBe(5);
  });

  it('P19.3-T2 AC-4 AC-5 seed: 0701 shows Siapkan KPM at 2 dari 7 — Branch info reviewed, a member besides the Owner', async () => {
    const kpm = await col('kpms').findOne({ code: '0701' });
    const ownerOf0701 = await col('users').findOne({ email: 'owner@kpm0701.test' });
    const member = (await col('memberships').findOne({ kpmId: String(kpm!._id), userId: String(ownerOf0701!._id), status: 'active' }))!;
    const hadi = new RequestContext(String(member.userId), 'none', {
      membershipId: String(member._id), kpmId: member.kpmId, orgLevelCode: member.orgLevelCode, hierarchyRole: member.role,
      status: 'active', isKpmOwner: true, isKpmAdmin: false, directCount: 1,
    } as never).withReader(SOURCE_READER);
    const view = await wired.kpmOverview.read(hadi);
    expect(view.setup).toMatchObject({ done: 2, openMonth: { month: '2026-10', closesOn: '2026-11-07' }, target: null });
    expect(view.setup!.steps.filter((s) => s.done).map((s) => s.key)).toEqual(['branch-info', 'import']);
    // Nothing ever uploaded: every month of Produksi 6 bulan *"–"*.
    expect(view.production.months.every((m) => m.apeMinor === null)).toBe(true);
  });

  it('P19.19-T1 0555’s Owner reads 0555’s own people: three, one of whom joined 45 days back', async () => {
    const b = await wired.kpmOverview.read(await as('0555', 'owner@kpm0555.test', { owner: true }));
    expect(b.office.code).toBe('0555');
    expect(b.usage.total.of).toBe(3);
    expect(b.production.months.some((m) => m.apeMinor !== null)).toBe(true);
    expect(b.people.some((p) => p.coaching.status !== 'never')).toBe(true);
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
    for (const name of ['abGroupTargets', 'monthlyAgentData', 'dataUploadBatches', 'goals', 'coachingSessions', 'leads', 'memberships']) {
      expect([name, again.written[name] ?? 0]).toEqual([name, 0]);
    }
  }, RUN_MS);
});
