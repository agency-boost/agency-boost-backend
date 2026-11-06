import mongoose from 'mongoose';
import { FixedClock } from '@/common/clock/clock.port';
import { RequestContext } from '@/common/context/request-context';
import { PERFORMANCE } from '@/domain/constants';
import { DEFAULT_KPM_SETTINGS, Kpm, KpmSchema } from './kpm.schema';
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

  describe('the office’s day and its settings, in one read (P11-T6)', () => {
    it('P11-T6 AC-3 answers the office’s own knobs beside its day and its company', async () => {
      const kpmId = await office({
        settings: { ...DEFAULT_KPM_SETTINGS, coachingOverdueDays: 10, onTrackPaceThreshold: 0.8 },
      });

      const answer = await days.office(member(kpmId));

      expect(answer).toMatchObject({
        today: '2026-09-26', month: '2026-09', timezone: 'Asia/Jakarta', companyId: 'c1',
      });
      expect(answer.settings).toEqual({ ...DEFAULT_KPM_SETTINGS, coachingOverdueDays: 10, onTrackPaceThreshold: 0.8 });
    });

    it('P11-T6 AC-3 falls back knob by knob to the platform default an older row never stored', async () => {
      const kpmId = await office();
      await mongoose.connection.db!.collection('kpms').updateOne(
        { _id: new mongoose.Types.ObjectId(kpmId) },
        { $unset: { 'settings.coachingOverdueDays': '', 'settings.onTrackPaceThreshold': '' } },
      );

      const { settings } = await days.office(member(kpmId));

      expect(settings.coachingOverdueDays).toBe(PERFORMANCE.COACHING_OVERDUE_DAYS);
      expect(settings.onTrackPaceThreshold).toBe(PERFORMANCE.ON_TRACK_PACE_THRESHOLD);
      expect(settings.complianceWindowDays).toBe(DEFAULT_KPM_SETTINGS.complianceWindowDays);
    });

    it('P11-T6 AC-3 falls back whole for a row with no settings, a zone in another office included', async () => {
      const kpmId = await office({ code: '0555', timezone: 'America/New_York' });
      await mongoose.connection.db!.collection('kpms')
        .updateOne({ _id: new mongoose.Types.ObjectId(kpmId) }, { $unset: { settings: '' } });

      const answer = await days.office(member(kpmId));

      expect(answer).toMatchObject({ today: '2026-09-25', timezone: 'America/New_York' });
      expect(answer.settings).toEqual(DEFAULT_KPM_SETTINGS);
    });

    it('P11-T6 AC-3 degrades for an office that is not there, and for somebody in none', async () => {
      for (const ctx of [member('66f0000000000000000000ff'), new RequestContext('u9', 'none', null)]) {
        const answer = await days.office(ctx);
        expect(answer).toEqual({
          today: '2026-09-26', month: '2026-09', timezone: 'Asia/Jakarta',
          settings: DEFAULT_KPM_SETTINGS, companyId: null,
        });
      }
    });
  });

  describe('the office’s day and the month it opened (P18.5-T11, ADR-0161 §4)', () => {
    it('P18.5-T11 AC-1 the first month is the month the record was created, in the office’s zone', async () => {
      // 17:30 UTC on 31 January is 00:30 on 1 February in Jakarta: the office opened in February.
      const kpmId = await office({ createdAt: new Date('2026-01-31T17:30:00Z') });

      const answer = await days.calendar(member(kpmId));

      expect(answer).toEqual({ today: '2026-09-26', month: '2026-09', timezone: 'Asia/Jakarta', firstMonth: '2026-02' });
    });

    it('P18.5-T11 AC-1 the same instant is still January for an office in New York', async () => {
      const kpmId = await office({ code: '0555', timezone: 'America/New_York', createdAt: new Date('2026-01-31T17:30:00Z') });

      expect((await days.calendar(member(kpmId))).firstMonth).toBe('2026-01');
    });

    it('P18.5-T11 AC-1 is never later than this month, whatever stamped the record', async () => {
      const kpmId = await office({ createdAt: new Date('2026-11-02T02:00:00Z') });

      expect((await days.calendar(member(kpmId))).firstMonth).toBe('2026-09');
    });

    it('P18.5-T11 AC-1 a row with no stamp opened this month, and so does an office that is not there', async () => {
      const kpmId = await office();
      await mongoose.connection.db!.collection('kpms')
        .updateOne({ _id: new mongoose.Types.ObjectId(kpmId) }, { $unset: { createdAt: '' } });

      expect((await days.calendar(member(kpmId))).firstMonth).toBe('2026-09');
      for (const ctx of [member('66f0000000000000000000ff'), new RequestContext('u9', 'none', null)]) {
        expect(await days.calendar(ctx)).toEqual({ today: '2026-09-26', month: '2026-09', timezone: 'Asia/Jakarta', firstMonth: '2026-09' });
      }
    });
  });
});
