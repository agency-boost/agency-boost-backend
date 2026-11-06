import mongoose from 'mongoose';
import { FixedClock } from '@/common/clock/clock.port';
import { RequestContext } from '@/common/context/request-context';
import { MemberNames } from '@/modules/org/member-names.service';
import { TenantDay } from '@/modules/tenants/tenant-day.service';
import { UnitPotensiService, type PotensiPerson, type UnitPotensiView } from '@/modules/unit-dashboard/unit-potensi.service';
import { clearCollections, startMongo, stopMongo } from '../../../test/mongo';
import { configModule } from '../../../test/config-module';
import { seedDemo } from '../demo';
import { POTENSI_LEADS, potensiLeadId } from '../potensi-fixture';

const RUN_MS = 240_000;
const quiet = () => undefined;
const col = (name: string) => mongoose.connection.db!.collection(name);

/** The account's live membership in office 0417, as a signed-in context. */
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
 * **P19.1-T2 AC-14, P19.1-T6 AC-13 — the *Potensi* switch and tab, seeded** (`potensi-fixture.ts`). The seed run as the
 * command runs it, on 4 November 2026 at 10:00 in Jakarta, then read back through the leads' and the tab's own services,
 * so what is asserted is what Rina and Agus see.
 */
describe('P19.1 the Potensi seed — a run at 10:00 on 4 November 2026 in Jakarta', () => {
  const clock = new FixedClock(new Date('2026-11-04T03:00:00Z'));
  let wired: ReturnType<typeof configModule>;
  let potensi: UnitPotensiService;
  let agus: RequestContext;
  let view: UnitPotensiView;

  beforeAll(async () => {
    await startMongo();
    await clearCollections();
    await seedDemo({ clock, log: quiet });
    wired = configModule(clock.now());
    await Promise.all(mongoose.modelNames().map((name) => mongoose.model(name).init()));
    potensi = new UnitPotensiService(
      wired.unitDashboard, new TenantDay(wired.kpms as never, wired.clock), wired.clock, wired.leadReadings,
      wired.productionReadings, wired.coach, wired.orgLevels, new MemberNames(wired.memberships, wired.users as never),
      wired.memberships, wired.subjectReads, wired.users as never,
    );
    agus = await as('agus@kpm0417.test');
    view = await potensi.read(agus);
  }, RUN_MS);
  afterAll(stopMongo);

  const everyone = (v: UnitPotensiView): PotensiPerson[] => v.units.flatMap((u) => u.people);
  const named = (first: string, v = view) => everyone(v).find((p) => p.name.startsWith(first))!;

  it('P19.1-T2 AC-14 this month: Rina’s lead switched on, one switched on and closed, one at the final stage; Budi’s Recruit lead switched on', async () => {
    const rows = (await wired.leadRecords.list(await as('rina@kpm0417.test'), { pageSize: 200 })).rows;
    const lead = (name: string) => rows.find((r) => r.name === name)!;
    expect(lead('Ibu Rosa Damayanti')).toMatchObject({ thisMonth: true, closedThisMonth: false, outcome: null });
    expect(lead(POTENSI_LEADS.rinaGreen.name)).toMatchObject({ thisMonth: true, closedThisMonth: true, outcome: 'won' });
    expect(lead('Ibu Wulan Sari')).toMatchObject({ statusCode: 'PAID_AND_ISSUED', outcome: null, thisMonth: true });
    // A Recruit lead switched on: Budi's, which the Phase 7 seed promised for the month.
    const budis = (await wired.leadRecords.list(await as('budi@kpm0417.test'), { pageSize: 200 })).rows;
    expect(budis.find((r) => r.name === 'Pak Andi Kurniawan')).toMatchObject({ type: 'recruitment', thisMonth: true, outcome: null });
  });

  it('P19.1-T6 AC-13 Agus’s group this month: potensi only, potensi and AA, AA without the switch, and ✕', () => {
    expect(named('Yanti').aa).toMatchObject({ aa: false });
    expect(named('Yanti').aa.potensi).toBeGreaterThan(0);
    expect(everyone(view).some((p) => p.aa.aa && p.aa.potensi > 0)).toBe(true);
    expect(everyone(view).some((p) => p.aa.aa && p.aa.switched === 0)).toBe(true);
    expect(named('Budi').aa).toEqual({ potensi: 0, aa: false, switched: 0 });
    expect(view.tiles.aa).toBeGreaterThan(0);
    // Grouped per unit, Agus's own card last.
    expect(view.units.at(-1)).toMatchObject({ kind: 'direct', leader: { name: 'Agus Prasetyo' } });
  });

  it('P19.1-T6 AC-13 Rekrut: a Recruit lead switched on, a rekrut linked to a membership and one not yet added', async () => {
    expect(view.tiles.rekrut).toBe(2);
    expect(named('Budi').rekrut.potensi).toBe(1);
    const indah = await potensi.person(agus, named('Indah').membershipId);
    expect(indah.kandidat).toContainEqual(expect.objectContaining({ name: 'Sdri. Sinta Rahayu', state: 'rekrut', newHireMembershipId: null }));
    const arief = await potensi.person(agus, named('Arief').membershipId);
    expect(arief.kandidat).toContainEqual(expect.objectContaining({
      name: 'Sdr. Wahyu Saputra', state: 'rekrut', newHireMembershipId: named('Wahyu').membershipId,
    }));
  });

  it('P19.1-T6 AC-13 a result for last month: Siti’s switched-on lead became her case; Dimas’s stayed open', async () => {
    const october = await potensi.read(agus, { month: '2026-10' });
    expect(named('Siti', october).aa).toMatchObject({ aa: true, switched: 1 });
    expect(named('Dimas', october).aa).toMatchObject({ potensi: 1, switched: 1 });
  });

  it('a second run writes nothing: each row’s id is derived', async () => {
    const before = await col('leads').countDocuments({});
    await seedDemo({ clock, log: quiet });
    expect(await col('leads').countDocuments({})).toBe(before);
    expect(await col('leads').countDocuments({ _id: new mongoose.Types.ObjectId(potensiLeadId(String((await col('kpms').findOne({ code: '0417' }))!._id), 'rinaGreen')) })).toBe(1);
  }, RUN_MS);
});
