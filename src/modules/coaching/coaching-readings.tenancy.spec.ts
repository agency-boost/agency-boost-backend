import mongoose from 'mongoose';
import { FixedClock } from '@/common/clock/clock.port';
import { RequestContext } from '@/common/context/request-context';
import { TenantDay } from '@/modules/tenants/tenant-day.service';
import { clearCollections, startMongo, stopMongo } from '../../../test/mongo';
import { configModule } from '../../../test/config-module';

/** 10:00 on 2 October in Jakarta. */
const NOW = new Date('2026-10-02T03:00:00Z');
const KPM_A = '66f0000000000000000000a1';
const KPM_B = '66f0000000000000000000b1';
const COMPANY = '66f0000000000000000000c1';
const AB = '66f00000000000000000ab01';
const AAB = '66f00000000000000000aa01';
const RINA = '66f00000000000000000a901';
const BUDI = '66f00000000000000000a902';

const leader = (kpmId = KPM_A) => new RequestContext('u-ab', 'none', {
  membershipId: AB, kpmId, orgLevelCode: 'AB', hierarchyRole: 'ab',
  status: 'active', isKpmOwner: false, isKpmAdmin: false, directCount: 1,
} as never);

/**
 * **The coaching metrics, over finalized sessions only** (P11-T5 AC-8; `metrics-and-definitions.md`
 * §A.3, ADR-0079).
 *
 * `DAYS_SINCE_LAST_COACHING`, `COACHED_7D` and `COACHED_30D` read the newest `date` among a coachee's
 * sessions finalized at least once — the office's day of each one's first finalize — in the office's
 * calendar. A draft never resets them, a reopened session keeps counting from its day, and a self-logged
 * `DEV_COACHING_RECEIVED` is not a session at all.
 */
describe('the coaching metrics (P11-T5 AC-8)', () => {
  let wired: ReturnType<typeof configModule>;
  let days: TenantDay;
  const clock = () => wired.clock as FixedClock;

  beforeAll(async () => {
    await startMongo();
    wired = configModule(NOW);
    days = new TenantDay(wired.kpms as never, wired.clock);
  });
  afterAll(stopMongo);
  beforeEach(async () => {
    clock().set(NOW);
    await clearCollections();
    await (wired.kpms as { create: (d: unknown) => Promise<unknown> }).create([
      { _id: KPM_A, companyId: COMPANY, code: '0417', branchName: 'A', timezone: 'Asia/Jakarta' },
      { _id: KPM_B, companyId: COMPANY, code: '0555', branchName: 'B', timezone: 'Asia/Jakarta' },
    ]);
  });

  /** A session on the record: finalized at least once on `date` unless `over` says otherwise. */
  const session = (date: string | null, over: Record<string, unknown> = {}, ctx = leader()) =>
    wired.coachingSessions.create(ctx, {
      coachMembershipId: AB, coacheeMembershipId: RINA,
      status: date === null ? 'draft' : 'finalized', date,
      frozenAt: date === null ? null : new Date(`${date}T03:00:00Z`),
      finalizedAt: date === null ? null : new Date(`${date}T03:00:00Z`),
      finalizedByMembershipId: date === null ? null : AB,
      version: date === null ? 2 : 3,
      ...over,
    } as never);

  /** The metrics for these coachees, as of the office's today at the clock's instant. */
  const recency = async (ids: string[] = [RINA], ctx = leader()) =>
    wired.coachingReadings.recencyOf(ctx, ids, await days.office(ctx));

  it('P11-T5 AC-8 a member never coached is No 1:1 yet: null, and coached in neither window', async () => {
    expect((await recency()).get(RINA)).toEqual({
      last: null, daysSinceLastCoaching: null, coached7d: false, coached30d: false,
    });
  });

  it('P11-T5 AC-8 counts the newest finalized session, by its date, in whole days', async () => {
    await session('2026-09-18');
    const latest = await session('2026-09-25');

    expect((await recency()).get(RINA)).toEqual({
      last: { sessionId: String(latest._id), date: '2026-09-25', coachMembershipId: AB },
      daysSinceLastCoaching: 7, coached7d: true, coached30d: true,
    });
  });

  it('P11-T5 AC-8 a draft never resets it — not even one opened today', async () => {
    await session('2026-09-22');
    await session(null);

    expect((await recency()).get(RINA)).toMatchObject({ daysSinceLastCoaching: 10, coached7d: false });
  });

  it('P11-T5 AC-8 a draft alone is still No 1:1 yet', async () => {
    await session(null);
    expect((await recency()).get(RINA)?.last).toBeNull();
  });

  it('P11-T5 AC-8 ADR-0079: a reopened session keeps counting from its date', async () => {
    await session('2026-09-27', {
      status: 'reopened', version: 4,
      corrections: [{
        version: 3, lastWeekItems: [], actionItems: [], tips: [], leadActions: [],
        finalizedAt: new Date('2026-09-27T03:00:00Z'), finalizedByMembershipId: AB,
        at: new Date('2026-10-01T03:00:00Z'), byMembershipId: AB, reason: 'The wrong lead was on it.',
      }],
    });

    expect((await recency()).get(RINA)).toMatchObject({ daysSinceLastCoaching: 5, coached7d: true });
  });

  it('P11-T5 AC-8 ADR-0079: correcting a session today does not make today a 1:1', async () => {
    // First finalized on 20 September, reopened, and finalized again this morning: its day is the 20th.
    await session('2026-09-20', { finalizedAt: NOW, version: 5 });

    expect((await recency()).get(RINA)).toMatchObject({ daysSinceLastCoaching: 12, coached7d: false, coached30d: true });
  });

  it('P11-T5 AC-8 a self-logged DEV_COACHING_RECEIVED never resets it', async () => {
    await session('2026-09-22');
    await mongoose.connection.db!.collection('activityLogs').insertOne({
      kpmId: KPM_A, membershipId: RINA, localDate: '2026-10-02', totalCount: 1, source: 'self',
      entries: [{ activityTypeId: 't-dev', activityTypeCode: 'DEV_COACHING_RECEIVED', count: 1 }],
      enteredByMembershipId: RINA, version: 1, frozenAt: null, corrections: [], deletedAt: null,
    });

    expect((await recency()).get(RINA)).toMatchObject({ daysSinceLastCoaching: 10 });
  });

  it('P11-T5 AC-8 the latest 1:1 is the coachee’s, whoever led it; on one day, the later finalize', async () => {
    await session('2026-09-30', { frozenAt: new Date('2026-09-30T02:00:00Z') });
    const later = await session('2026-09-30', { coachMembershipId: AAB, frozenAt: new Date('2026-09-30T08:00:00Z') });

    expect((await recency()).get(RINA)?.last).toEqual({
      sessionId: String(later._id), date: '2026-09-30', coachMembershipId: AAB,
    });
  });

  it('P11-T5 AC-8 a deleted session does not count, and nor does another office’s', async () => {
    const gone = await session('2026-10-01');
    await wired.coachingSessions.softDeleteById(leader(), String(gone._id), NOW);
    await session('2026-10-02', {}, leader(KPM_B));

    expect((await recency()).get(RINA)?.last).toBeNull();
    expect((await recency([RINA], leader(KPM_B))).get(RINA)).toMatchObject({ daysSinceLastCoaching: 0 });
  });

  it('P11-T5 AC-8 answers every coachee asked about in one read, and nothing for an empty list', async () => {
    await session('2026-09-02');
    await session('2026-09-30', { coacheeMembershipId: BUDI });

    const both = await recency([RINA, BUDI, AAB]);
    expect([...both.entries()].map(([id, r]) => [id, r.daysSinceLastCoaching, r.coached7d, r.coached30d])).toEqual([
      [RINA, 30, false, true], [BUDI, 2, true, true], [AAB, null, false, false],
    ]);
    expect(await recency([])).toEqual(new Map());
  });

  describe('the office’s day, pinned at the boundary (invariant §9)', () => {
    it('P11-T5 AC-8 at 23:59 in Jakarta the 1:1 of that day is today; at 00:01 it was yesterday', async () => {
      await session('2026-09-30');

      // 23:59 on 30 September in Jakarta.
      clock().set(new Date('2026-09-30T16:59:00Z'));
      expect((await recency()).get(RINA)).toMatchObject({ daysSinceLastCoaching: 0, coached7d: true });

      // 00:01 on 1 October in Jakarta — still the 30th in UTC, which a server-clock day would count as 0.
      clock().set(new Date('2026-09-30T17:01:00Z'));
      expect((await recency()).get(RINA)).toMatchObject({ daysSinceLastCoaching: 1, coached7d: true });
    });

    it('P11-T5 AC-8 coached in the last 7 days ends at midnight in Jakarta, not in UTC', async () => {
      await session('2026-09-23');

      clock().set(new Date('2026-09-30T16:59:00Z'));
      expect((await recency()).get(RINA)).toMatchObject({ daysSinceLastCoaching: 7, coached7d: true });

      clock().set(new Date('2026-09-30T17:01:00Z'));
      expect((await recency()).get(RINA)).toMatchObject({ daysSinceLastCoaching: 8, coached7d: false, coached30d: true });
    });

    it('P11-T5 AC-8 coached in the last 30 days ends at the same midnight', async () => {
      await session('2026-08-31');

      clock().set(new Date('2026-09-30T16:59:00Z'));
      expect((await recency()).get(RINA)).toMatchObject({ daysSinceLastCoaching: 30, coached30d: true });

      clock().set(new Date('2026-09-30T17:01:00Z'));
      expect((await recency()).get(RINA)).toMatchObject({ daysSinceLastCoaching: 31, coached30d: false });
    });
  });

  describe('OD-140 — the next open action item of the latest 1:1, typed or from a lead (ADR-0124)', () => {
    const item = (text: string, dueDate: string | null) => ({ itemId: text, text, dueDate, carriedFromItemId: null });
    const leadAction = (leadName: string, dueDate: string) => ({ leadId: `l-${leadName}`, leadName, dueDate, text: `Call ${leadName}` });
    /** The follow-ups for the coachees' latest 1:1s, as the Unit Dashboard asks for them. */
    const followUps = async (ids: string[] = [RINA, BUDI], ctx = leader(), leadsShown = (_: string) => true) => {
      const office = await days.office(ctx);
      const latest = await wired.coachingReadings.recencyOf(ctx, ids, office);
      return wired.coachingReadings.followUpsOf(
        ctx, [...latest.values()].flatMap((r) => (r.last ? [r.last.sessionId] : [])), office, leadsShown,
      );
    };

    it('P15-T2 AC-5 reads the latest finalized session only: an older one’s items and a draft’s are not follow-ups', async () => {
      await session('2026-09-18', { actionItems: [item('Old item', '2026-09-20')] });
      await session('2026-09-25', { actionItems: [item('Book two presentations', '2026-10-05'), item('   ', '2026-09-01')] });
      await session(null, { actionItems: [item('A draft’s', '2026-09-01')] });

      expect((await followUps()).get(RINA)).toEqual({ text: 'Book two presentations', dueDate: '2026-10-05', overdueDays: null });
    });

    it('P15-T2 AC-5 a lead action the session froze is a candidate too, and the earlier due date wins', async () => {
      await session('2026-09-25', {
        actionItems: [item('Practise the objection', '2026-09-30')],
        leadActions: [leadAction('Pak Hendro', '2026-09-28')],
      });
      // Due on the 28th, four office days before the 2nd: Overdue 4d.
      expect((await followUps()).get(RINA)).toEqual({ text: 'Call Pak Hendro', dueDate: '2026-09-28', overdueDays: 4 });
    });

    it('Phase 15 exit B1: to a reader who may not read the coachee’s leads, no lead action and no item carried from a lead', async () => {
      await session('2026-09-25', {
        actionItems: [
          { itemId: 'c1', text: 'Note from Pak Hendro’s lead', dueDate: '2026-09-26', carriedFromItemId: 'lead-abc' },
          item('Typed, later', '2026-10-04'),
        ],
        leadActions: [leadAction('Pak Hendro', '2026-09-27')],
      });
      const asked: string[] = [];
      const hidden = await followUps([RINA], leader(), (id) => { asked.push(id); return false; });
      expect(hidden.get(RINA)).toEqual({ text: 'Typed, later', dueDate: '2026-10-04', overdueDays: null });
      expect(JSON.stringify([...hidden])).not.toMatch(/Hendro/);
      expect(asked).toEqual([RINA]);
      // The same session, to a reader who may: the carried item, earliest.
      expect((await followUps([RINA])).get(RINA)?.text).toBe('Note from Pak Hendro’s lead');
    });

    it('P15-T2 AC-5 on the same due date the typed item comes before the lead action', async () => {
      await session('2026-09-25', {
        actionItems: [item('Typed', '2026-09-28')],
        leadActions: [leadAction('Ibu Wulan', '2026-09-28')],
      });
      expect((await followUps()).get(RINA)?.text).toBe('Typed');
    });

    it('P15-T2 AC-5 a reopened session counts as the version it was finalized at, not the correction in progress', async () => {
      await session('2026-09-27', {
        status: 'reopened', version: 4,
        actionItems: [item('Being rewritten', '2026-09-01')], leadActions: [],
        corrections: [{
          version: 3, lastWeekItems: [], tips: [],
          actionItems: [item('As finalized', '2026-10-09')], leadActions: [leadAction('Ibu Kartika', '2026-10-10')],
          finalizedAt: new Date('2026-09-27T03:00:00Z'), finalizedByMembershipId: AB,
          at: new Date('2026-10-01T03:00:00Z'), byMembershipId: AB, reason: 'The wrong lead was on it.',
        }],
      });
      expect((await followUps()).get(RINA)).toEqual({ text: 'As finalized', dueDate: '2026-10-09', overdueDays: null });
    });

    it('P15-T2 AC-5 nobody coached, a session with nothing to follow up, or no session asked about: no entry', async () => {
      await session('2026-09-25', { actionItems: [], leadActions: [] });
      expect([...(await followUps()).keys()]).toEqual([]);
      expect(await wired.coachingReadings.followUpsOf(leader(), [], await days.office(leader()), () => true)).toEqual(new Map());
    });

    it('P15-T2 AC-5 another office’s session is never read, though its id is asked for', async () => {
      const theirs = await session('2026-09-25', { actionItems: [item('Theirs', '2026-09-26')] }, leader(KPM_B));
      expect(await wired.coachingReadings.followUpsOf(leader(), [String(theirs._id)], await days.office(leader()), () => true)).toEqual(new Map());
    });
  });
});
