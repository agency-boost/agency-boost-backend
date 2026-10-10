import mongoose from 'mongoose';
import { RequestContext } from '@/common/context/request-context';
import { clearCollections, startMongo, stopMongo, syncIndexes } from '../../../test/mongo';
import { configModule } from '../../../test/config-module';
import { buildCoachingOffice, KPM_A, KPM_B, ROSTER_NOW, type CoachingOffice, type Who } from '../../../test/coaching-office';

const wib = (local: string) => new Date(`${local}+07:00`).toISOString();
const APE = { metricKey: 'APE_ACHIEVED', comparator: 'gte', value: 1 };

/**
 * **KPM A never overrides KPM B** (P18.6-T2 AC-5; invariant §1): both offices run a campaign with the same code, each
 * final with a chaser's stored standing. An office's Owner reaches another office's member as nobody (`404`), and an
 * override in one office never touches the other's row — not through the service, not through the repository.
 */
describe('the override across offices (P18.6-T2 AC-5)', () => {
  let wired: ReturnType<typeof configModule>;
  let office: CoachingOffice;
  const db = () => mongoose.connection.db!;
  const ownerA = () => office.as('OWNER');
  const ownerB = () => {
    const b = office.as('B_AB');
    return new RequestContext(b.userId, 'none', { ...b.membership!, isKpmOwner: true });
  };
  const rowOf = (kpmId: string, who: Who) => db().collection('campaignStandings').findOne({ kpmId, campaignCode: 'AUGUST_PUSH', membershipId: office.id[who] });

  beforeAll(async () => {
    await startMongo();
    wired = configModule(ROSTER_NOW);
    await syncIndexes();
    await clearCollections();
    office = await buildCoachingOffice(wired);
    const august = { code: 'AUGUST_PUSH', title: 'August Push', startsAt: wib('2026-08-01T00:00:00'), endsAt: wib('2026-08-31T23:59:00'), requirements: [APE] };
    await wired.campaigns.create(ownerA(), august);
    await wired.campaigns.create(ownerB(), august);
    for (const [kpmId, who] of [[KPM_A, 'BUDI'], [KPM_B, 'B_AGENT']] as const) {
      await db().collection('campaignChases').insertOne({
        kpmId, membershipId: office.id[who], campaignCode: 'AUGUST_PUSH', chasing: true, chasedAt: new Date('2026-01-05T02:00:00Z'),
        unchasedAt: null, closedBy: null, deletedAt: null,
      });
    }
    // The first reads freeze both windows.
    await wired.campaignStandingsReader.ofOffice(ownerA(), { codes: ['AUGUST_PUSH'] });
    await wired.campaignStandingsReader.ofOffice(ownerB(), { codes: ['AUGUST_PUSH'] });
  }, 120_000);
  afterAll(stopMongo);

  it('P18.6-T2 AC-5 cross-tenant: A’s Owner reaches B’s member as nobody, 404, and B’s row is untouched', async () => {
    await expect(wired.campaignStandingOverrides.override(ownerA(), 'AUGUST_PUSH', office.id.B_AGENT, { status: 'qualified', reason: 'x' }))
      .rejects.toMatchObject({ code: 'NOT_FOUND', status: 404 });
    await expect(wired.campaignStandingOverrides.clear(ownerA(), 'AUGUST_PUSH', office.id.B_AGENT, { reason: 'x' }))
      .rejects.toMatchObject({ status: 404 });
    expect((await rowOf(KPM_B, 'B_AGENT'))!.override ?? null).toBeNull();
  });

  it('P18.6-T2 AC-5 cross-tenant: B’s Owner reaches A’s member as nobody, 404', async () => {
    await expect(wired.campaignStandingOverrides.override(ownerB(), 'AUGUST_PUSH', office.id.BUDI, { status: 'qualified', reason: 'x' }))
      .rejects.toMatchObject({ code: 'NOT_FOUND', status: 404 });
    expect((await rowOf(KPM_A, 'BUDI'))!.override ?? null).toBeNull();
  });

  it('P18.6-T2 AC-5 cross-tenant: an override in A writes A’s row alone, though B runs the same code', async () => {
    await wired.campaignStandingOverrides.override(ownerA(), 'AUGUST_PUSH', office.id.BUDI, { status: 'qualified', reason: 'Corrected' });
    expect((await rowOf(KPM_A, 'BUDI'))!.override).toMatchObject({ status: 'qualified' });
    expect((await rowOf(KPM_B, 'B_AGENT'))!.override ?? null).toBeNull();
    const b = await wired.campaignStandingsReader.ofOffice(ownerB(), { codes: ['AUGUST_PUSH'], memberIds: [office.id.B_AGENT] });
    // 0555 holds no August file: its chaser's result is final and undecided, and stays so.
    expect(b.standings).toEqual([expect.objectContaining({ status: 'unknown', overridden: null })]);
    expect(await db().collection('auditLog').countDocuments({ action: 'campaign_standing.overridden', kpmId: KPM_B })).toBe(0);
  });

  it('P18.6-T2 AC-5 cross-tenant: the repository’s write, handed B’s row id in A’s context, writes nothing', async () => {
    const row = (await rowOf(KPM_B, 'B_AGENT'))!;
    const wrote = await wired.campaignStandings.setOverride(ownerA(), String(row._id), (row.version as number | undefined) ?? null, {
      status: 'qualified', reason: 'x', byMembershipId: office.id.OWNER, at: ROSTER_NOW, previousStatus: 'unknown',
    }, ROSTER_NOW);
    expect(wrote).toBe(false);
    expect((await rowOf(KPM_B, 'B_AGENT'))!.override ?? null).toBeNull();
  });

  it('P18.6-T2 AC-5 the repository’s write refuses a context with no office', async () => {
    await expect(wired.campaignStandings.setOverride(RequestContext.platform('root'), '66f0000000000000000000ff', null, null, ROSTER_NOW))
      .rejects.toThrow();
  });
});
