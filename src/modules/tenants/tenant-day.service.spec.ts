import mongoose from 'mongoose';
import { FixedClock } from '@/common/clock/clock.port';
import { RequestContext } from '@/common/context/request-context';
import { Kpm, KpmSchema } from './kpm.schema';
import { TenantDay } from './tenant-day.service';
import { clearCollections, startMongo, stopMongo } from '../../../test/mongo';

/** 17:30 UTC — already tomorrow in Jakarta, still today in New York. */
const EVENING = new Date('2026-09-25T17:30:00Z');

const member = (kpmId: string) => new RequestContext('u1', 'none', {
  membershipId: 'mem-1', kpmId, orgLevelCode: 'AGENT', hierarchyRole: 'agent',
  status: 'active', isKpmOwner: false, isKpmAdmin: false, directCount: 0,
} as never);

/**
 * What day it is in the office (P7-T4, invariant §9).
 *
 * **The zone comes from the column, never from a constant.** v1 runs every office on Asia/Jakarta
 * (ADR-0016), so every one of these would pass against a hardcoded zone too — which is exactly why
 * the second office here is somewhere else. Removing the indirection is how F-56 comes back, and it
 * comes back invisibly.
 */
describe('the office’s day (P7-T4)', () => {
  let kpms: mongoose.Model<never>;
  let days: TenantDay;

  beforeAll(async () => {
    await startMongo();
    kpms = mongoose.model(Kpm.name, KpmSchema) as never;
    days = new TenantDay(kpms as never, new FixedClock(EVENING));
  });

  afterAll(stopMongo);
  beforeEach(clearCollections);

  /** One office, and its id — which is all any of these tests wants back. */
  const office = async (over: Record<string, unknown> = {}): Promise<string> => {
    const created = await kpms.create({
      companyId: 'c1', code: '0417', branchName: 'BSD', timezone: 'Asia/Jakarta',
      locale: 'id-ID', currency: 'IDR', status: 'active', ...over,
    } as never);
    return String((created as unknown as { _id: unknown })._id);
  };

  it('is the office’s calendar day, not the server’s', async () => {
    const kpmId = await office();

    const day = await days.for(member(kpmId));

    expect(day).toEqual({ today: '2026-09-26', month: '2026-09', timezone: 'Asia/Jakarta' });
    // What the prototype would have answered, and what this exists to stop.
    expect(EVENING.toISOString().slice(0, 10)).toBe('2026-09-25');
  });

  it('answers a different day for an office in another zone, at the same instant', async () => {
    const kpmId = await office({ code: '0555', timezone: 'America/New_York' });

    const day = await days.for(member(kpmId));

    expect(day).toEqual({ today: '2026-09-25', month: '2026-09', timezone: 'America/New_York' });
  });

  it('falls back to the platform zone when the row names none', async () => {
    // An office written before the column existed. A derived label is not worth refusing a
    // request over, so it degrades rather than throwing.
    const kpmId = await office();
    await mongoose.connection.db!.collection('kpms')
      .updateOne({ _id: new mongoose.Types.ObjectId(kpmId) }, { $unset: { timezone: '' } });

    const day = await days.for(member(kpmId));

    expect(day.timezone).toBe('Asia/Jakarta');
  });

  it('falls back for an office that is not there at all', async () => {
    const day = await days.for(member('66f0000000000000000000ff'));

    expect(day.timezone).toBe('Asia/Jakarta');
  });

  it('falls back for somebody who has joined no office', async () => {
    // A Super Admin, or a brand-new agent. The services that call this refuse them by name
    // first; answering with the platform zone is what keeps that refusal from becoming a 500.
    const day = await days.for(new RequestContext('u9', 'none', null));

    expect(day.timezone).toBe('Asia/Jakarta');
  });
});
