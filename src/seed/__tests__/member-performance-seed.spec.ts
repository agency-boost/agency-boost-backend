import mongoose from 'mongoose';
import { FixedClock } from '@/common/clock/clock.port';
import { RequestContext } from '@/common/context/request-context';
import { SOURCE_READER } from '@/common/i18n/reader';
import { MemberPerformanceService, type MemberPerformanceView } from '@/modules/summary/member-performance.service';
import { TenantDay } from '@/modules/tenants/tenant-day.service';
import { clearCollections, startMongo, stopMongo } from '../../../test/mongo';
import { configModule } from '../../../test/config-module';
import { seedDemo } from '../demo';

const RUN_MS = 300_000;
const quiet = () => undefined;
const col = (name: string) => mongoose.connection.db!.collection(name);

/** The account's live membership in KPM 0417, as a signed-in context. */
async function as(email: string, flags: { owner?: boolean } = {}): Promise<RequestContext> {
  const kpm = await col('kpms').findOne({ code: '0417' });
  const account = await col('users').findOne({ email });
  const member = (await col('memberships').findOne({ kpmId: String(kpm!._id), userId: String(account!._id), status: 'active' }))!;
  return new RequestContext(String(member.userId), 'none', {
    membershipId: String(member._id), kpmId: member.kpmId, orgLevelCode: member.orgLevelCode, hierarchyRole: member.role,
    status: 'active', isKpmOwner: flags.owner ?? false, isKpmAdmin: false, directCount: 0,
  } as never).withReader(SOURCE_READER);
}

/**
 * **P19.3-T4 AC-2 (OWN case 1) on the demo seed**: the Owner opens *All members* → Indah Permatasari, Sari Puspita and
 * Agus Prasetyo, and each page's four tiles hold figures, read by the service the route answers with — so the tiles
 * can be reviewed in a browser on a fresh seed without seeding anything of their own.
 */
describe('P19.3-T4 the member tiles on the demo seed — a run at 10:00 on 5 November 2026 in Jakarta', () => {
  const clock = new FixedClock(new Date('2026-11-05T03:00:00Z'));
  let wired: ReturnType<typeof configModule>;
  let tiles: (email: string) => Promise<MemberPerformanceView>;

  beforeAll(async () => {
    await startMongo();
    await clearCollections();
    await seedDemo({ clock, log: quiet });
    wired = configModule(clock.now());
    await Promise.all(mongoose.modelNames().map((name) => mongoose.model(name).init()));
    const service = new MemberPerformanceService(
      wired.coach, new TenantDay(wired.kpms as never, wired.clock), wired.activityLogs, wired.productionReadings,
      wired.goals, wired.coachingReadings, wired.leadReadings, wired.subjectReads,
    );
    const owner = await as('owner@kpm0417.test', { owner: true });
    tiles = async (email: string) => {
      const member = await as(email);
      return service.read(owner, member.membershipId!);
    };
  }, RUN_MS);
  afterAll(stopMongo);

  it('P19.3-T4 AC-2 an agent, Indah Permatasari: activity this week, the office’s production against her goal, a 1:1, open leads', async () => {
    const view = await tiles('indah@kpm0417.test');
    expect(view).toMatchObject({ today: '2026-11-05', activity: { from: '2026-10-30', to: '2026-11-05' }, leads: { month: '2026-11' } });
    expect(view.activity.count).toBeGreaterThan(0);
    expect(view.production).toMatchObject({ year: '2026', goalSet: true });
    expect(view.production.actualMinor).toBeGreaterThan(0);
    expect(view.production.attainmentPct).toBeGreaterThan(0);
    expect(view.lastOneOnOne).not.toBeNull();
    expect(view.leads.open).toBeGreaterThan(0);
  });

  it('P19.3-T4 AC-2 an AAB, Sari Puspita: activity, the office’s production with no goal saved, a 1:1', async () => {
    const view = await tiles('sari@kpm0417.test');
    expect(view.activity.count).toBeGreaterThan(0);
    expect(view.production).toMatchObject({ goalSet: false, targetMinor: null, attainmentPct: null });
    expect(view.production.actualMinor).toBeGreaterThan(0);
    expect(view.lastOneOnOne).not.toBeNull();
  });

  it('P19.3-T4 AC-2 an AB, Agus Prasetyo: the office’s production, never coached (*Belum pernah*, as the mockup draws him), open leads', async () => {
    const view = await tiles('agus@kpm0417.test');
    expect(view.production.actualMinor).toBeGreaterThan(0);
    expect(view.lastOneOnOne).toBeNull();
    expect(view.leads.open).toBeGreaterThan(0);
  });
});
