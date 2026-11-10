import mongoose from 'mongoose';
import { FixedClock } from '@/common/clock/clock.port';
import { RequestContext } from '@/common/context/request-context';
import { SUMMARY } from '@/domain/constants';
import { clearCollections, startMongo, stopMongo } from '../../../test/mongo';
import { configModule } from '../../../test/config-module';
import { seedDemo } from '../demo';
import { SUMMARY_LEADS } from '../summary-leads-fixture';

const RUN_MS = 240_000;
const quiet = () => undefined;
const col = (name: string) => mongoose.connection.db!.collection(name);

async function as(email: string): Promise<RequestContext> {
  const kpm = await col('kpms').findOne({ code: '0417' });
  const account = await col('users').findOne({ email });
  const member = (await col('memberships').findOne({ kpmId: String(kpm!._id), userId: String(account!._id), status: 'active' }))!;
  const direct = await col('memberships').countDocuments({ leaderId: String(member._id), status: 'active' });
  return new RequestContext(String(member.userId), 'none', {
    membershipId: String(member._id), kpmId: member.kpmId, orgLevelCode: member.orgLevelCode,
    hierarchyRole: member.role, status: 'active', isKpmOwner: false, isKpmAdmin: false, directCount: direct,
  } as never);
}

/**
 * **P19.11-T5 — the Personal Summary's leads, seeded** (`summary-leads-fixture.ts`): a run on a **Monday**, the day this
 * week's *Tugas* leave nothing of Agus's late, read back through `SummaryService` itself — more than five open leads, the
 * most overdue on top, the dated before the undated, and the undated one registered longest ago first among them.
 */
describe('P19.11-T5 the Summary leads seed — a run at 10:00 on Monday 9 November 2026 in Jakarta', () => {
  const clock = new FixedClock(new Date('2026-11-09T03:00:00Z'));
  let wired: ReturnType<typeof configModule>;

  beforeAll(async () => {
    await startMongo();
    await clearCollections();
    await seedDemo({ clock, log: quiet });
    wired = configModule(clock.now());
    await Promise.all(mongoose.modelNames().map((name) => mongoose.model(name).init()));
  }, RUN_MS);
  afterAll(stopMongo);

  it('P19.11-T5 AC-2 AC-3 Agus: more than five open leads — the late one first, the dated, then the undated, waiting longest first', async () => {
    const { leads } = await wired.summary.read(await as('agus@kpm0417.test'));
    const [late, undated] = SUMMARY_LEADS;

    // *Lihat semua (N)* shows: more than the five drawn, every one answered.
    expect(leads.shown).toBe(SUMMARY.LEADS_SHOWN);
    expect(leads.total).toBeGreaterThan(SUMMARY.LEADS_SHOWN);
    expect(leads.rows).toHaveLength(leads.total);
    // A mix: overdue, dated today or later, and undated.
    expect(leads.rows[0]).toMatchObject({ name: late.name, nextActionDate: '2026-11-06', flags: expect.arrayContaining(['overdue']) });
    expect(leads.rows.some((r) => r.nextActionDate !== null && r.nextActionDate >= '2026-11-09')).toBe(true);
    const firstUndated = leads.rows.findIndex((r) => r.nextActionDate === null);
    expect(firstUndated).toBeGreaterThan(0);
    expect(leads.rows[firstUndated].name).toBe(undated.name);
    // Every dated one before every undated one, nearest first.
    const dated = leads.rows.slice(0, firstUndated).map((r) => r.nextActionDate!);
    expect(dated).toEqual([...dated].sort());
    expect(leads.rows.slice(firstUndated).every((r) => r.nextActionDate === null)).toBe(true);
    // Open, his own, none switched on for the month by this fixture.
    expect(leads.rows.every((r) => r.outcome === null && r.ownerMembershipId === leads.rows[0].ownerMembershipId)).toBe(true);
    expect(leads.rows.filter((r) => SUMMARY_LEADS.some((s) => s.name === r.name)).every((r) => !r.thisMonth)).toBe(true);
  });

  it('a second run writes nothing', async () => {
    const before = await col('leads').countDocuments({});
    await seedDemo({ clock, log: quiet });
    expect(await col('leads').countDocuments({})).toBe(before);
  }, RUN_MS);
});
