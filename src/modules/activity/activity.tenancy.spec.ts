import mongoose from 'mongoose';
import { RequestContext } from '@/common/context/request-context';
import { FixedClock } from '@/common/clock/clock.port';
import { clearCollections, startMongo, stopMongo } from '../../../test/mongo';
import { configModule, provisionOffice } from '../../../test/config-module';

const NOW = new Date('2026-03-11T02:00:00Z');
const KPM_A = '66f0000000000000000000a1';
const KPM_B = '66f0000000000000000000b1';
const COMPANY = '66f0000000000000000000c1';

/** Today in Jakarta at `NOW` — 09:00 local, so the calendar day is unambiguous. */
const TODAY = '2026-03-11';

const member = (kpmId: string, over: Record<string, unknown> = {}) => new RequestContext(
  'u1', 'none', {
    membershipId: `mem-${kpmId}`, kpmId, orgLevelCode: 'AGENT', hierarchyRole: 'agent',
    status: 'active', isKpmOwner: false, isKpmAdmin: false, directCount: 0, ...over,
  } as never,
);

/**
 * What an agent did, day by day (P6-T1, P6-T3, P6-T4, P6-T5, P6-T6).
 *
 * Two things carry this module and are proved here. **The day is the office's day** — the
 * prototype keys every entry by `toISOString()`, so a Jakarta agent logging before 07:00 files
 * against yesterday. And **nobody writes anybody else's log**: the write path has no subject to
 * pass, which is the enforcement `roles-and-permissions.md` §3.5 asks for.
 */
describe('an agent’s activity log (P6)', () => {
  let wired: ReturnType<typeof configModule>;

  beforeAll(async () => {
    await startMongo();
    wired = configModule(NOW);
  });
  afterAll(stopMongo);

  beforeEach(async () => {
    await clearCollections();
    await (wired.kpms as { create: (d: unknown) => Promise<unknown> }).create([
      { _id: KPM_A, companyId: COMPANY, code: '0417', branchName: 'A', timezone: 'Asia/Jakarta' },
      { _id: KPM_B, companyId: COMPANY, code: '0555', branchName: 'B', timezone: 'Asia/Jakarta' },
    ]);
    await provisionOffice(wired, KPM_A, COMPANY);
    await provisionOffice(wired, KPM_B, COMPANY);
  });

  const save = (ctx: RequestContext, counts: Record<string, number>, date?: string) =>
    wired.activityLogs.saveDay(ctx, { date, counts });

  /** Move the office's clock. Time only moves when a test moves it. */
  const at = (instant: string) => (wired.clock as FixedClock).set(new Date(instant));

  afterEach(() => at(NOW.toISOString()));

  /** The stored document — the only place a version bump or a correction is visible. */
  const stored = (kpmId: string, membershipId: string, localDate: string) =>
    mongoose.connection.db!.collection('activityLogs').findOne({ kpmId, membershipId, localDate });

  describe('isolation (invariant §1)', () => {
    it('keeps one office’s days out of another’s', async () => {
      await save(member(KPM_A), { SELL_SUBMISSION: 3 });

      const mine = await wired.activityLogs.readDay(member(KPM_A), {});
      const theirs = await wired.activityLogs.readDay(member(KPM_B), {});

      expect(mine.totalCount).toBe(3);
      expect(theirs.totalCount).toBe(0);
    });

    it('refuses another office’s member as not found, never as forbidden', async () => {
      // A 403 would confirm the membership exists. The office boundary answers 404.
      const owner = member(KPM_B, { isKpmOwner: true });

      await expect(wired.activityLogs.readDay(owner, { membershipId: `mem-${KPM_A}` }))
        .rejects.toMatchObject({ status: 404 });
    });

    it('lets two offices hold the same day for the same date', async () => {
      await save(member(KPM_A), { SELL_SUBMISSION: 1 });
      await expect(save(member(KPM_B), { SELL_SUBMISSION: 9 })).resolves.toBeTruthy();

      expect((await stored(KPM_A, `mem-${KPM_A}`, TODAY))!.totalCount).toBe(1);
      expect((await stored(KPM_B, `mem-${KPM_B}`, TODAY))!.totalCount).toBe(9);
    });
  });

  describe('the day is the office’s day (invariant §9)', () => {
    it('files 09:00 Jakarta against today, not against the UTC day', async () => {
      // NOW is 2026-03-11T02:00Z — the 11th in Jakarta and the 11th in UTC, so this alone
      // proves little. The instant that separates them is the next test.
      const day = await save(member(KPM_A), { SELL_SUBMISSION: 1 });
      expect(day.localDate).toBe(TODAY);
    });

    it('files an evening before 07:00 local against the right day — the prototype’s defect', async () => {
      // 22:30Z on the 10th is 05:30 on the 11th in Jakarta. `toISOString()` answers the 10th.
      at('2026-03-10T22:30:00Z');

      const day = await save(member(KPM_A), { SELL_SUBMISSION: 1 });

      expect(day.localDate).toBe('2026-03-11');
      expect(new Date('2026-03-10T22:30:00Z').toISOString().slice(0, 10)).toBe('2026-03-10');
    });
  });

  describe('one row per person per day, upserted (AC-1)', () => {
    it('replaces the day and bumps the version rather than adding a second row', async () => {
      await save(member(KPM_A), { SELL_SUBMISSION: 3 });
      await save(member(KPM_A), { SELL_SUBMISSION: 5 });

      const rows = await mongoose.connection.db!.collection('activityLogs')
        .find({ kpmId: KPM_A, membershipId: `mem-${KPM_A}`, localDate: TODAY }).toArray();

      expect(rows).toHaveLength(1);
      expect(rows[0].totalCount).toBe(5);
      expect(rows[0].version).toBe(2);
    });

    it('carries the code on every entry, so an archived type still renders (P4 exit AC-4)', async () => {
      /*
       * Phase 4's exit criterion 4 has been `Partial` since 2026-09-12 — *"the renders in history
       * half needs Phase 6 activity logs"*. This is that half.
       */
      await save(member(KPM_A), { SELL_SUBMISSION: 4 });
      const type = (await wired.activity.list(member(KPM_A, { isKpmOwner: true })))
        .flatMap((category) => category.types)
        .find((t) => t.code === 'SELL_SUBMISSION')!;
      await wired.activity.archiveType(member(KPM_A, { isKpmOwner: true }), type.id);

      const row = await stored(KPM_A, `mem-${KPM_A}`, TODAY);
      const entry = (row!.entries as { activityTypeCode: string; count: number }[])
        .find((e) => e.activityTypeCode === 'SELL_SUBMISSION');

      // The stored row still names the code and the count, whatever the taxonomy now says.
      expect(entry).toMatchObject({ activityTypeCode: 'SELL_SUBMISSION', count: 4 });
    });

    it('stores an all-zero day as a real row (AC-6, OD-30)', async () => {
      await save(member(KPM_A), {});

      const row = await stored(KPM_A, `mem-${KPM_A}`, TODAY);
      expect(row).toBeTruthy();
      expect(row!.totalCount).toBe(0);
    });
  });

  describe('what a count may be', () => {
    it('clamps to 0–999, and reads a non-number as zero', async () => {
      const day = await save(member(KPM_A), {
        SELL_SUBMISSION: 1000, SELL_PRESENTATION: -4, LEADS_CONTACTED: Number.NaN,
      });
      const count = (code: string) =>
        day.entries.find((e) => e.activityTypeCode === code)!.count;

      expect(count('SELL_SUBMISSION')).toBe(999);
      expect(count('SELL_PRESENTATION')).toBe(0);
      expect(count('LEADS_CONTACTED')).toBe(0);
    });

    it('refuses a code this office does not have, by name', async () => {
      await expect(save(member(KPM_A), { NOT_A_CODE: 1 }))
        .rejects.toThrow(/no activity type with the code NOT_A_CODE/);
    });

    it('returns every active type, zeros included — the screen is the taxonomy', async () => {
      const day = await save(member(KPM_A), { SELL_SUBMISSION: 1 });

      expect(day.entries).toHaveLength(12);
      expect(day.entries.every((e) => typeof e.label === 'string' && e.label.length > 0)).toBe(true);
    });
  });

  describe('the correction window (P6-T3, ADR-0042)', () => {
    it('refuses a day that has not happened', async () => {
      await expect(save(member(KPM_A), { SELL_SUBMISSION: 1 }, '2026-03-12'))
        .rejects.toThrow(/has not happened yet/);
    });

    it('takes a day earlier in the same month freely', async () => {
      const day = await save(member(KPM_A), { SELL_SUBMISSION: 2 }, '2026-03-02');
      expect(day.localDate).toBe('2026-03-02');
      expect(day.editable).toBe(true);
    });

    it('takes last month while inside the grace window, and refuses it after', async () => {
      // NOW is 11 March; February closed on 7 March with the default seven-day window.
      await expect(save(member(KPM_A), { SELL_SUBMISSION: 1 }, '2026-02-20'))
        .rejects.toThrow(/closed for editing/);

      at('2026-03-05T02:00:00Z');
      await expect(save(member(KPM_A), { SELL_SUBMISSION: 1 }, '2026-02-20'))
        .resolves.toMatchObject({ localDate: '2026-02-20' });
    });

    it('keeps the prior state whole when a frozen day is corrected', async () => {
      // Written while February was open, then corrected once it had closed.
      at('2026-03-05T02:00:00Z');
      await save(member(KPM_A), { SELL_SUBMISSION: 3 }, '2026-02-20');
      at(NOW.toISOString());

      const after = await wired.activityLogs.correctDay(member(KPM_A), {
        date: '2026-02-20', counts: { SELL_SUBMISSION: 5 }, reason: 'Logged against the wrong day.',
      });

      expect(after.totalCount).toBe(5);
      expect(after.correctionCount).toBe(1);

      const row = await stored(KPM_A, `mem-${KPM_A}`, '2026-02-20');
      const [correction] = row!.corrections as {
        totalCount: number; reason: string; entries: unknown[];
      }[];
      // The whole prior state, not a diff: a coach who used the old numbers can still read them.
      expect(correction.totalCount).toBe(3);
      expect(correction.reason).toBe('Logged against the wrong day.');
      expect(correction.entries).toHaveLength(12);
      expect(row!.frozenAt).toBeTruthy();
    });

    it('requires a reason, and refuses to correct a day that is still open', async () => {
      await save(member(KPM_A), { SELL_SUBMISSION: 1 });

      await expect(wired.activityLogs.correctDay(member(KPM_A), {
        date: TODAY, counts: {}, reason: '   ',
      })).rejects.toThrow(/Say why/);

      await expect(wired.activityLogs.correctDay(member(KPM_A), {
        date: TODAY, counts: {}, reason: 'Because.',
      })).rejects.toThrow(/still open/);
    });

    it('refuses to correct a day that was never logged', async () => {
      await expect(wired.activityLogs.correctDay(member(KPM_A), {
        date: '2026-01-05', counts: {}, reason: 'Because.',
      })).rejects.toThrow(/no entry for 2026-01-05/);
    });
  });

  describe('who may read whose (P6-T6, §3.5)', () => {
    /** A second member of KPM A, reporting to the first. */
    const downline = async (leaderId: string | null) => {
      const row = await mongoose.model('Membership').create({
        kpmId: KPM_A,
        userId: new mongoose.Types.ObjectId().toString(),
        role: 'agent',
        orgLevelCode: 'AGENT',
        orgLevelId: new mongoose.Types.ObjectId().toString(),
        status: 'active',
        agentCode: `A${Math.random().toString(36).slice(2, 8)}`,
        agentSeq: Math.floor(Math.random() * 100000),
        leaderCode: Math.random().toString(36).slice(2, 10).toUpperCase(),
        leaderId,
        ancestorIds: leaderId ? [leaderId] : [],
        deletedAt: null,
      });
      return String(row._id);
    };

    it('lets an agent read only their own', async () => {
      const other = await downline(null);

      await expect(wired.activityLogs.readDay(member(KPM_A), { membershipId: other }))
        .rejects.toThrow(/only read your own/);
    });

    it('lets a leader read somebody in their downline, and not somebody outside it', async () => {
      const leader = member(KPM_A, { orgLevelCode: 'AB', hierarchyRole: 'ab', directCount: 1 });
      const mine = await downline(`mem-${KPM_A}`);
      const stranger = await downline(null);

      await expect(wired.activityLogs.readDay(leader, { membershipId: mine }))
        .resolves.toMatchObject({ membershipId: mine });
      await expect(wired.activityLogs.readDay(leader, { membershipId: stranger }))
        .rejects.toMatchObject({ status: 404 });
    });

    it('lets the Owner read anybody in the office', async () => {
      const owner = member(KPM_A, { isKpmOwner: true });
      const anybody = await downline(null);

      await expect(wired.activityLogs.readDay(owner, { membershipId: anybody }))
        .resolves.toMatchObject({ membershipId: anybody });
    });

    it('offers no way to write somebody else’s day at all', async () => {
      // The enforcement is structural: `saveDay` takes no subject. This asserts the shape,
      // because a check somebody can forget is not the guarantee §3.5 asks for.
      const leader = member(KPM_A, { orgLevelCode: 'AB', hierarchyRole: 'ab' });
      const mine = await downline(`mem-${KPM_A}`);

      await leader.membershipId;
      const day = await wired.activityLogs.saveDay(
        leader, { counts: { SELL_SUBMISSION: 2 } } as never,
      );

      // It wrote the leader's own day, not the downline's, whatever else was passed.
      expect(day.membershipId).toBe(`mem-${KPM_A}`);
      expect(await stored(KPM_A, mine, TODAY)).toBeNull();
    });
  });

  describe('the summary (P6-T4)', () => {
    it('totals per code over the rolling window, with every active code present', async () => {
      await save(member(KPM_A), { SELL_SUBMISSION: 2 }, '2026-03-09');
      await save(member(KPM_A), { SELL_SUBMISSION: 3, LEADS_CONTACTED: 4 }, TODAY);

      const summary = await wired.activityLogs.summary(member(KPM_A), { period: 'ROLLING_7D' });
      const total = (code: string) =>
        summary.totals.find((t) => t.activityTypeCode === code)!.count;

      expect(summary).toMatchObject({ from: '2026-03-05', to: TODAY, daysLogged: 2 });
      expect(total('SELL_SUBMISSION')).toBe(5);
      expect(total('LEADS_CONTACTED')).toBe(4);
      expect(total('RECRUIT_AGENT_CODE')).toBe(0);
      expect(summary.totals).toHaveLength(12);
    });

    it('makes a calendar month the calendar month (ADR-0022)', async () => {
      await save(member(KPM_A), { SELL_SUBMISSION: 1 }, '2026-03-01');

      const month = await wired.activityLogs.summary(member(KPM_A), { period: 'CALENDAR_MONTH' });

      expect(month).toMatchObject({ from: '2026-03-01', to: '2026-03-31' });
    });

    it('takes a custom range, and refuses one that starts after it ends', async () => {
      await expect(wired.activityLogs.summary(member(KPM_A), {
        from: '2026-03-10', to: '2026-03-01',
      })).rejects.toThrow(/starts after it ends/);
    });
  });

  describe('compliance (P6-T5, OD-30)', () => {
    it('counts an all-zero day as reporting — existence, not a total', async () => {
      await save(member(KPM_A), {});

      const view = await wired.activityLogs.compliance(member(KPM_A), {});

      expect(view).toMatchObject({ compliant7d: true, compliantMonth: true, lastLoggedOn: TODAY });
    });

    it('reads a member who has never logged as not compliant, and never as zero days ago', async () => {
      const view = await wired.activityLogs.compliance(member(KPM_A), {});

      expect(view.compliant7d).toBe(false);
      expect(view.lastLoggedOn).toBeNull();
    });

    it('falls out of the seven-day window without falling out of the month', async () => {
      await save(member(KPM_A), { SELL_SUBMISSION: 1 }, '2026-03-02');

      const view = await wired.activityLogs.compliance(member(KPM_A), {});

      expect(view).toMatchObject({
        compliant7d: false, compliantMonth: true, lastLoggedOn: '2026-03-02', windowDays: 7,
      });
    });
  });
});
