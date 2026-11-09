import mongoose from 'mongoose';
import { RequestContext } from '@/common/context/request-context';
import { clearCollections, startMongo, stopMongo } from '../../../test/mongo';
import { configModule } from '../../../test/config-module';
import { buildCoachingOffice, KPM_A, KPM_B, ROSTER_NOW, type CoachingOffice } from '../../../test/coaching-office';

const wib = (local: string) => new Date(`${local}+07:00`).toISOString();

/**
 * **One office's campaigns, chases and standings are invisible to another** (P18.2-T7 AC-1, AC-5; P18.2-T8 AC-8;
 * P18.2-T9 AC-2; invariant §1) — 0417 (`KPM_A`) against 0555 (`KPM_B`), on every route and reader: the list, the
 * dialog, the chase and its drop, whose chases, the Unit Dashboard's chase reader, the standings port and the
 * settings list. Another office's campaign is **404**, never 403; its code, even shared, names nothing here.
 */
describe('campaigns and chases across offices (P18.2-T7, T8, T9)', () => {
  let wired: ReturnType<typeof configModule>;
  let office: CoachingOffice;
  const db = () => mongoose.connection.db!;
  /** 0555's root AB, as its Owner. */
  const bOwner = () => {
    const b = office.as('B_AB');
    return new RequestContext(b.userId, 'none', { ...b.membership!, isKpmOwner: true });
  };

  beforeAll(async () => {
    await startMongo();
    wired = configModule(ROSTER_NOW);
    await clearCollections();
    office = await buildCoachingOffice(wired);
    const sprint = (code: string) => ({
      code, title: code, startsAt: wib('2026-09-01T00:00:00'), endsAt: wib('2026-09-30T23:59:00'),
      requirements: [{ metricKey: 'APE_ACHIEVED', comparator: 'gte', value: 1 }],
    });
    await wired.campaigns.create(office.as('OWNER'), sprint('APE_SPRINT'));
    // The same code in both offices: a code is stable within an office, never across them.
    await wired.campaigns.create(bOwner(), sprint('APE_SPRINT'));
    await wired.campaigns.create(bOwner(), sprint('GADING_PUSH'));
    await wired.campaignAgent.chase(office.as('B_AGENT'), 'GADING_PUSH');
    await wired.campaignAgent.chase(office.as('B_AGENT'), 'APE_SPRINT');
    await wired.campaignAgent.chase(office.as('RINA'), 'APE_SPRINT');
  }, 60_000);
  afterAll(stopMongo);

  it('P18.2-T7 AC-1 the list answers each office its own campaigns only', async () => {
    expect((await wired.campaignAgent.list(office.as('RINA'))).campaigns.map((c) => c.code)).toEqual(['APE_SPRINT']);
    expect((await wired.campaignAgent.list(office.as('B_AGENT'))).campaigns.map((c) => c.code).sort()).toEqual(['APE_SPRINT', 'GADING_PUSH']);
  });

  it('P18.2-T7 AC-1 another office’s campaign is 404 to the dialog, the chase and the drop', async () => {
    for (const call of [
      () => wired.campaignAgent.detail(office.as('RINA'), 'GADING_PUSH'),
      () => wired.campaignAgent.chase(office.as('RINA'), 'GADING_PUSH'),
      () => wired.campaignAgent.unchase(office.as('RINA'), 'GADING_PUSH'),
    ]) {
      await expect(call()).rejects.toMatchObject({ status: 404 });
    }
    // The shared code reads each office's own, and its own chase.
    expect((await wired.campaignAgent.detail(office.as('RINA'), 'APE_SPRINT')).chasing).toBe(true);
    expect((await wired.campaignAgent.detail(office.as('B_AGENT'), 'APE_SPRINT')).chasing).toBe(true);
  });

  it('P18.2-T7 AC-5 a chase is the office’s own row: each carries its office, and a drop in one leaves the other', async () => {
    await wired.campaignAgent.unchase(office.as('RINA'), 'APE_SPRINT');
    const rows = await db().collection('campaignChases').find({ campaignCode: 'APE_SPRINT' }).toArray();
    expect(rows.map((r) => [r.kpmId, r.chasing]).sort()).toEqual([[KPM_A, false], [KPM_B, true]]);
    await wired.campaignAgent.chase(office.as('RINA'), 'APE_SPRINT');
  });

  it('P18.2-T9 AC-2 whose chases: another office’s member is 404, even to the Owner', async () => {
    await expect(wired.campaignAgent.chasing(office.as('OWNER'), office.id.B_AGENT)).rejects.toMatchObject({ status: 404 });
    await expect(wired.campaignAgent.chasing(bOwner(), office.id.RINA)).rejects.toMatchObject({ status: 404 });
    expect((await wired.campaignAgent.chasing(bOwner(), office.id.B_AGENT)).campaigns.map((c) => c.code).sort())
      .toEqual(['APE_SPRINT', 'GADING_PUSH']);
  });

  it('P18.2-T7 AC-8 the chase reader, asked about another office’s member, finds nothing', async () => {
    const read = await wired.campaignChaseReadings.ofMany(office.as('OWNER'), [office.id.RINA, office.id.B_AGENT]);
    expect(read.byMember.get(office.id.RINA)!.map((c) => c.code)).toEqual(['APE_SPRINT']);
    expect(read.byMember.get(office.id.B_AGENT)).toEqual([]);
  });

  it('P18.2-T8 AC-8 the standings port reads the context’s office and no other', async () => {
    const a = await wired.campaignStandingsReader.ofOffice(office.as('OWNER'));
    expect(a.campaigns.map((c) => c.code)).toEqual(['APE_SPRINT']);
    expect(a.standings.some((s) => s.membershipId === office.id.B_AGENT)).toBe(false);
    const b = await wired.campaignStandingsReader.ofOffice(bOwner());
    expect(b.campaigns.map((c) => c.code)).toEqual(['APE_SPRINT', 'GADING_PUSH']);
    expect(b.standings.filter((s) => s.chasing).map((s) => [s.campaignCode, s.membershipId]).sort())
      .toEqual([['APE_SPRINT', office.id.B_AGENT], ['GADING_PUSH', office.id.B_AGENT]]);
  });

  it('P18.2-T7 the settings list answers each Owner their own office’s campaigns', async () => {
    expect((await wired.campaigns.list(office.as('OWNER'), true)).map((c) => c.code)).toEqual(['APE_SPRINT']);
    expect((await wired.campaigns.list(bOwner(), true)).map((c) => c.code).sort()).toEqual(['APE_SPRINT', 'GADING_PUSH']);
  });

  it('P18.2-T7 AC-5 a departure read in one office closes chases there and never another office’s', async () => {
    await wired.campaignDeparture.left(bOwner(), office.id.RINA);
    expect(await db().collection('campaignChases').countDocuments({ membershipId: office.id.RINA, chasing: true })).toBe(1);
    await wired.campaignDeparture.left(bOwner(), office.id.B_AGENT);
    expect(await db().collection('campaignChases').countDocuments({ membershipId: office.id.B_AGENT, chasing: true })).toBe(0);
  });
});
