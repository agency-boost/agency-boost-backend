import mongoose from 'mongoose';
import { RequestContext } from '@/common/context/request-context';
import {
  startActivationHarness, stopActivationHarness, KPM_B, type ActivationHarness, type Who,
} from '../../../test/activation-office';

type Item = { code: string; done: boolean; source: string | null; doneBy: { membershipId: string } | null };
type View = { pct: number; done: number; aspects: { code: string; status: string; items: Item[] }[] };
const item = (view: View, code: string) => view.aspects.flatMap((a) => a.items).find((i) => i.code === code)!;

const GOAL = {
  mode: 'direct', annualApeTargetMinor: 300_000_000_00, savingsTargetMinor: 0, commissionRatePct: 10, monthsLeft: 4,
  apeAchievedMinor: 0, caseSizeMinor: 10_000_000_00, leadsToApptPct: 30, closingRatePct: 30,
};

/**
 * **The auto-completion engine, over HTTP** (P13-T3; the phase's exit criteria). Every write here goes
 * through the module that owns the record — `PUT /goals`, `POST /leads`, `PUT /activity/log`,
 * `POST /activity/log/correction` — and the item it completes is read off the stored activation **before**
 * any read of the checklist, so what is proven is the write's call, not the read that heals a missed one.
 */
describe('the activation’s linked items complete from real writes (Phase 13 exit criterion 1)', () => {
  let h: ActivationHarness;
  const id = (who: Who) => h.id(who);
  const kpmOf = (who: Who) => h.office.as(who).kpmId!;
  /** The item as the activation stores it, with no read of the checklist in between. */
  const stored = async (who: Who, code: string) => {
    const doc = await h.col('activationProgress').findOne({ membershipId: id(who) });
    return (doc!.items as Record<string, unknown>[]).find((i) => i.code === code)!;
  };
  /** A day of the hire's log written as the activity module writes it, for weeks before the save window. */
  const logged = (who: Who, localDate: string, count: number) => h.col('activityLogs').insertOne({
    kpmId: kpmOf(who), membershipId: id(who), localDate, totalCount: count, deletedAt: null, source: 'self',
    entries: count ? [{ activityTypeId: 't', activityTypeCode: 'LEADS_CONTACTED', count }] : [],
    enteredByMembershipId: id(who), version: 1, frozenAt: null, corrections: [],
    createdAt: new Date('2026-08-01T00:00:00Z'), updatedAt: new Date('2026-08-01T00:00:00Z'),
  });
  const day = (date: string, count: number) => ({ date, counts: { LEADS_CONTACTED: count } });

  beforeAll(async () => { h = await startActivationHarness(); });
  afterAll(async () => { await stopActivationHarness(h); });
  beforeEach(async () => {
    await h.reset();
    jest.restoreAllMocks();
  });

  describe.each([
    ['the hire', 'BUDI'],
    ['a leader with ?for= (ADR-0046)', 'SARI'],
  ] as const)('feature:goals — a goal saved by %s', (_who, by) => {
    it('P13-T3 AC-2 completes the goal item in the write, attributed to whoever saved it and naming the goal', async () => {
      await h.start('BUDI', '2026-07-15');
      h.as(by);
      const res = await h.http().put('/goals/2026').query(by === 'BUDI' ? {} : { for: id('BUDI') }).send(GOAL).expect(200);
      expect(await stored('BUDI', 'GOAL_SETTING')).toMatchObject({
        done: true, source: 'link', doneByMembershipId: id(by), recordCollection: 'goals', recordId: res.body.id,
      });
    });
  });

  describe.each([
    ['the hire, a sales lead', 'BUDI', 'sales'],
    ['a leader in a session (ADR-0076), a recruitment lead', 'SARI', 'recruitment'],
  ] as const)('feature:leads — a lead created by %s', (_who, by, type) => {
    it('P13-T3 AC-3 completes the prospects item in the write, of either type, attributed to whoever added it', async () => {
      await h.start('BUDI', '2026-07-15');
      h.as(by);
      const res = await h.http().post('/leads').query(by === 'BUDI' ? {} : { owner: id('BUDI') })
        .send({ name: 'Ibu Melinda Sari', type }).expect(201);
      expect(await stored('BUDI', 'ADD_PROSPECTS')).toMatchObject({
        done: true, source: 'link', doneByMembershipId: id(by), recordCollection: 'leads', recordId: res.body.id,
      });
    });
  });

  describe('feature:activity — four consecutive office weeks (ADR-0031, P13-T3 AC-4)', () => {
    it('P13-T3 AC-4 a day saved: the third week does not complete it, the fourth does — on the first day of the fourth', async () => {
      await h.start('BUDI', '2026-07-15');
      await logged('BUDI', '2026-08-18', 3);
      await logged('BUDI', '2026-08-24', 1);
      h.as('BUDI');
      await h.http().put('/activity/log').send(day('2026-09-02', 2)).expect(200);
      expect(await stored('BUDI', 'ACTIVITY_TRACKER_WEEKLY')).toMatchObject({ done: false });

      await h.http().put('/activity/log').send(day('2026-09-08', 2)).expect(200);
      const row = await h.col('activityLogs').findOne({ membershipId: id('BUDI'), localDate: '2026-09-08' });
      expect(await stored('BUDI', 'ACTIVITY_TRACKER_WEEKLY')).toMatchObject({
        done: true, source: 'link', doneByMembershipId: id('BUDI'), recordCollection: 'activityLogs',
        recordId: String(row!._id), doneAt: h.clock.now(),
      });
    });

    it('P13-T3 AC-4 a week of all-zero days counts for none', async () => {
      await h.start('BUDI', '2026-07-15');
      await logged('BUDI', '2026-08-18', 3);
      await logged('BUDI', '2026-08-24', 1);
      h.as('BUDI');
      await h.http().put('/activity/log').send(day('2026-09-01', 0)).expect(200);
      await h.http().put('/activity/log').send(day('2026-09-03', 0)).expect(200);
      await h.http().put('/activity/log').send(day('2026-09-08', 2)).expect(200);
      expect(await stored('BUDI', 'ACTIVITY_TRACKER_WEEKLY')).toMatchObject({ done: false });
    });

    it('P13-T3 AC-4 a day corrected counts as corrected: a zero week corrected above zero makes the fourth', async () => {
      await h.start('BUDI', '2026-07-15');
      await logged('BUDI', '2026-07-27', 0);
      for (const date of ['2026-08-03', '2026-08-11', '2026-08-23']) await logged('BUDI', date, 2);
      h.as('BUDI');
      await h.http().post('/activity/log/correction')
        .send({ ...day('2026-07-27', 4), reason: 'Forgot the Monday calls' }).expect(201);
      // The record named is the day that made the fourth week of the run: Sunday the 23rd's, now that the
      // corrected 27 July is its first.
      const row = await h.col('activityLogs').findOne({ membershipId: id('BUDI'), localDate: '2026-08-23' });
      expect(await stored('BUDI', 'ACTIVITY_TRACKER_WEEKLY')).toMatchObject({
        done: true, recordId: String(row!._id), doneByMembershipId: id('BUDI'),
      });
    });

    it('P13-T3 AC-4 only weeks from the start date count: a week before it is not one of the four', async () => {
      await h.start('BUDI', '2026-08-24');
      for (const date of ['2026-08-10', '2026-08-17', '2026-08-23']) await logged('BUDI', date, 2);
      h.as('BUDI');
      await h.http().put('/activity/log').send(day('2026-09-01', 1)).expect(200);
      await h.http().put('/activity/log').send(day('2026-09-08', 1)).expect(200);
      expect(await stored('BUDI', 'ACTIVITY_TRACKER_WEEKLY')).toMatchObject({ done: false });
    });

    it('P13-T3 AC-4 an entry at 23:30 on a Sunday in Jakarta is that Sunday’s, the end of its own week', async () => {
      await h.start('BUDI', '2026-07-15');
      for (const date of ['2026-08-24', '2026-08-31', '2026-09-07']) await logged('BUDI', date, 1);
      // 23:30 WIB on Sunday 13 September is 16:30 UTC — still the week of the 7th in the office.
      h.clock.set(new Date('2026-09-13T16:30:00Z'));
      h.as('BUDI');
      await h.http().put('/activity/log').send({ counts: { LEADS_CONTACTED: 1 } }).expect(200);
      expect(await stored('BUDI', 'ACTIVITY_TRACKER_WEEKLY')).toMatchObject({ done: false });
      expect(await h.col('activityLogs').findOne({ membershipId: id('BUDI'), localDate: '2026-09-13' })).not.toBeNull();
      // Half an hour later it is Monday the 14th, the fourth week.
      h.clock.set(new Date('2026-09-13T17:30:00Z'));
      await h.http().put('/activity/log').send({ counts: { LEADS_CONTACTED: 1 } }).expect(200);
      expect(await stored('BUDI', 'ACTIVITY_TRACKER_WEEKLY')).toMatchObject({ done: true });
    });
  });

  describe('sticky (ADR-0031, parity F-32; P13-T3 AC-6)', () => {
    it('P13-T3 AC-6 a done link stays done, and keeps its record, when the goal is replaced, the lead deleted and the week corrected to zero', async () => {
      await h.start('BUDI', '2026-07-15');
      await logged('BUDI', '2026-08-03', 0);
      for (const date of ['2026-08-10', '2026-08-17', '2026-08-24']) await logged('BUDI', date, 2);
      h.as('BUDI');
      const goal = (await h.http().put('/goals/2026').send(GOAL).expect(200)).body;
      const lead = (await h.http().post('/leads').send({ name: 'Pak Hendro' }).expect(201)).body;
      await h.http().post('/activity/log/correction').send({ ...day('2026-08-03', 3), reason: 'Missed it' }).expect(201);
      const before = await h.col('activationProgress').findOne({ membershipId: id('BUDI') });

      h.clock.advance(3_600_000);
      h.as('SARI');
      await h.http().put('/goals/2026').query({ for: id('BUDI') }).send({ ...GOAL, caseSizeMinor: 12_000_000_00 }).expect(200);
      h.as('BUDI');
      await h.http().delete(`/leads/${lead.id}`).expect(200);
      for (const date of ['2026-08-10', '2026-08-17']) {
        await h.http().post('/activity/log/correction').send({ ...day(date, 0), reason: 'Logged on the wrong day' }).expect(201);
      }
      const view = (await h.http().get('/activation/me').expect(200)).body as View;
      for (const code of ['GOAL_SETTING', 'ADD_PROSPECTS', 'ACTIVITY_TRACKER_WEEKLY']) {
        expect(item(view, code)).toMatchObject({ done: true, source: 'link' });
      }
      const after = await h.col('activationProgress').findOne({ membershipId: id('BUDI') });
      expect(after!.items).toEqual(before!.items);
      expect(after!.items.find((i: { code: string }) => i.code === 'GOAL_SETTING')).toMatchObject({ recordId: goal.id, doneByMembershipId: id('BUDI') });
    });

    it('P13-T3 AC-6 only an open activation is evaluated: a graduated or expired one is not written', async () => {
      await h.start('BUDI', '2026-07-15', { graduatedAt: new Date('2026-09-01T02:00:00Z'), graduatedByMembershipId: id('BUDI') });
      await h.start('TARI', '2026-02-01');
      for (const who of ['BUDI', 'TARI'] as const) {
        h.as(who);
        await h.http().put('/goals/2026').send(GOAL).expect(200);
        await h.http().post('/leads').send({ name: 'Ibu Wati' }).expect(201);
        expect([who, (await h.col('activationProgress').findOne({ membershipId: id(who) }))!.version]).toEqual([who, 1]);
        expect((await h.http().get('/activation/me').expect(200)).body.done).toBe(0);
      }
    });
  });

  describe('fails open, and the read heals (D-links; P13-T3 AC-5)', () => {
    it('P13-T3 AC-5 an evaluator that throws breaks no write — each still answers — and the next read completes what it missed', async () => {
      await h.start('BUDI', '2026-07-15');
      for (const date of ['2026-08-17', '2026-08-24', '2026-08-31']) await logged('BUDI', date, 1);
      const evaluate = jest.spyOn(h.wired.activationEngine, 'evaluate').mockRejectedValue(new Error('the evaluator is down'));
      h.as('BUDI');
      await h.http().put('/goals/2026').send(GOAL).expect(200);
      await h.http().post('/leads').send({ name: 'Pak Rudi' }).expect(201);
      await h.http().put('/activity/log').send(day('2026-09-08', 2)).expect(200);
      for (const code of ['GOAL_SETTING', 'ADD_PROSPECTS', 'ACTIVITY_TRACKER_WEEKLY']) {
        expect(await stored('BUDI', code)).toMatchObject({ done: false });
      }
      expect(evaluate).toHaveBeenCalledTimes(3);

      evaluate.mockRestore();
      const view = (await h.http().get('/activation/me').expect(200)).body as View;
      expect(['GOAL_SETTING', 'ADD_PROSPECTS', 'ACTIVITY_TRACKER_WEEKLY'].map((c) => item(view, c).done)).toEqual([true, true, true]);
      expect(view.done).toBe(3);
    });

    it('P18.8-T7 AC-1 (UI-007) the leader’s first read of a hire left unhealed answers the settled counts — Initial Setup 3/4, never the stored 1/4 — and so do two first reads at once', async () => {
      // Dimas's shape on staging: his leader ticked *Set up company CRM system*, and his goal and his lead were written
      // straight into their collections, as the seed writes them — no write signalled the engine — so the stored row
      // holds one of Initial Setup's four.
      const kpmId = h.office.as('BUDI').kpmId!;
      const crm = { done: true, doneAt: new Date('2026-07-30T03:00:00Z'), source: 'leader', doneByMembershipId: id('SARI') };
      const doc = await h.start('BUDI', '2026-07-15');
      await h.col('activationProgress').updateOne(
        { _id: doc._id, 'items.code': 'CRM_SETUP' },
        { $set: Object.fromEntries(Object.entries(crm).map(([k, v]) => [`items.$.${k}`, v])) },
      );
      const at = new Date('2026-07-20T03:00:00Z');
      await h.col('goals').insertOne({
        kpmId, membershipId: id('BUDI'), year: 2026, savedAt: at, savedByMembershipId: id('BUDI'), deletedAt: null, createdAt: at,
      });
      await h.col('leads').insertOne({
        kpmId, ownerMembershipId: id('BUDI'), name: 'Ibu Melinda', type: 'sales', dateRegistered: at, createdBy: id('BUDI'),
        deletedAt: null, createdAt: at,
      });
      const initialSetup = (view: { aspects: { code: string; done: number; total: number; status: string }[] }) =>
        view.aspects.find((a) => a.code === 'INITIAL_SETUP')!;
      expect((await stored('BUDI', 'GOAL_SETTING')).done).toBe(false);

      h.as('SARI');
      const first = (await h.http().get(`/new-hires/${id('BUDI')}`).expect(200)).body;
      expect(initialSetup(first)).toMatchObject({ done: 3, total: 4, status: 'in_progress' });
      expect(['GOAL_SETTING', 'ADD_PROSPECTS'].map((c) => item(first, c))).toEqual([
        expect.objectContaining({ done: true, source: 'link' }), expect.objectContaining({ done: true, source: 'link' }),
      ]);

      // Unhealed again, and read twice at once: each read evaluates on its own, and neither answers the stored 1/4.
      await h.col('activationProgress').updateOne({ _id: doc._id }, {
        $set: { 'items.$[g].done': false, 'items.$[g].source': null, 'items.$[g].doneAt': null },
      }, { arrayFilters: [{ 'g.code': { $in: ['GOAL_SETTING', 'ADD_PROSPECTS'] } }] });
      const both = await Promise.all([1, 2].map(() => h.http().get(`/new-hires/${id('BUDI')}`).expect(200)));
      expect(both.map((res) => [initialSetup(res.body).done, res.body.done])).toEqual([[3, 3], [3, 3]]);
    });

    it('P13-T3 AC-5 a write for a member with no activation evaluates nothing and answers as before', async () => {
      h.as('BUDI');
      await h.http().put('/goals/2026').send(GOAL).expect(200);
      await h.http().post('/leads').send({ name: 'Ibu Tini' }).expect(201);
      expect(await h.col('activationProgress').countDocuments({})).toBe(0);
    });
  });

  describe('by code, never by position (invariant §4; D-version)', () => {
    it('P13-T3 AC-1 an office that binds feature:goals to another item sees that item complete; a running activation keeps its version', async () => {
      // Office B's own hire, on version 1, before the Owner moves the goal link.
      await h.start('B_AGENT', '2026-08-01');
      const owner = RequestContext.forJob(KPM_B, 'activation-spec');
      const v1 = await h.wired.activation.read(owner);
      const draft = {
        aspects: v1.published!.aspects.map((a) => ({
          code: a.code, label: a.label,
          items: a.items.map((i) => ({
            code: i.code, label: i.code === 'CRM_SETUP' ? 'Set up the company CRM' : i.label,
            autoLink: i.code === 'GOAL_SETTING' ? null : i.code === 'CRM_SETUP' ? 'feature:goals' : i.autoLink,
          })),
        })).reverse(),
      };
      await h.wired.activation.saveDraft(owner, draft);
      await h.wired.activation.publish(owner);
      // An unchanged draft is never a version (P13-T1 AC-2).
      await h.wired.activation.saveDraft(owner, draft);
      await expect(h.wired.activation.publish(owner)).rejects.toThrow(/same as version 2/);

      // A second hire, joining now, is pinned to version 2.
      const lina = new mongoose.Types.ObjectId(id('B_AGENT'));
      const bayu = (await h.col('memberships').findOne({ _id: lina }))!;
      const newcomer = await h.col('memberships').insertOne({
        ...bayu, _id: new mongoose.Types.ObjectId(), userId: new mongoose.Types.ObjectId().toString(), agentSeq: 99,
        // Joined on 10 September, a new hire (ADR-0169), as a placement writes them.
        leaderCode: 'NEWCOMER', joinedAt: new Date('2026-09-10T02:00:00Z'), joinDate: '2026-09-10', joinedAs: 'new_hire',
      });
      const asNewcomer = new RequestContext('u-newcomer', 'none', {
        ...h.office.as('B_AGENT').membership!, membershipId: String(newcomer.insertedId),
      });
      try {
        await h.wired.activationProgress.joined(asNewcomer, String(newcomer.insertedId));
        h.as(asNewcomer);
        await h.http().put('/goals/2026').send(GOAL).expect(200);
        const v2 = (await h.http().get('/activation/me').expect(200)).body as View & { startDate: string };
        expect(v2.startDate).toBe('2026-09-10');
        expect(v2.aspects[0].code).toBe('ONGOING_HABITS');
        expect(item(v2, 'CRM_SETUP')).toMatchObject({ done: true, source: 'link', label: 'Set up the company CRM' });
        expect(item(v2, 'GOAL_SETTING')).toMatchObject({ done: false, link: null });
        await h.http().put('/activation/me/items/GOAL_SETTING').send({ done: true }).expect(200);
        await h.http().put('/activation/me/items/CRM_SETUP').send({ done: false }).expect(409);

        // Bayu, under way on version 1, is unmoved: same order, same labels, same links.
        h.as('B_AGENT');
        const kept = (await h.http().get('/activation/me').expect(200)).body as View;
        expect(kept.aspects[0].code).toBe('INTRODUCTION');
        expect(item(kept, 'CRM_SETUP')).toMatchObject({ label: 'Siapkan sistem CRM perusahaan', link: null });
        expect(item(kept, 'GOAL_SETTING')).toMatchObject({ link: expect.objectContaining({ kind: 'feature:goals' }) });
      } finally {
        await h.col('memberships').deleteOne({ _id: newcomer.insertedId });
      }
    });
  });
});

/**
 * **Exit criterion 2: the coaching tab reads the same progress the hire sees** (P13-T9 AC-2). For one hire,
 * after each kind of write and a manual tick, four reads: the hire's own page, the leader's detail, a coach's
 * *Activation* tab and the hire's `/coaching/me` tab — the tab reads the same routes, so it is read through
 * them — answer the same done codes, percentage and aspect statuses.
 */
describe('the four reads agree (Phase 13 exit criterion 2)', () => {
  let h: ActivationHarness;
  const id = (who: Who) => h.id(who);

  beforeAll(async () => { h = await startActivationHarness(); });
  afterAll(async () => { await stopActivationHarness(h); });
  beforeEach(async () => { await h.reset(); });

  const essence = (view: View) => ({
    done: view.aspects.flatMap((a) => a.items).filter((i) => i.done).map((i) => i.code).sort(),
    pct: view.pct,
    statuses: view.aspects.map((a) => [a.code, a.status]),
  });

  async function fourReads() {
    h.as('BUDI');
    const own = (await h.http().get('/activation/me').expect(200)).body;
    h.as('SARI');
    const detail = (await h.http().get(`/new-hires/${id('BUDI')}`).expect(200)).body;
    h.as('AGUS');
    const coachTab = (await h.http().get(`/new-hires/${id('BUDI')}`).expect(200)).body;
    h.as('BUDI');
    const coachingMe = (await h.http().get('/activation/me').expect(200)).body;
    return [own, detail, coachTab, coachingMe].map(essence);
  }

  it('P13-T9 AC-2 after a goal, a lead, four weeks of activity and a manual tick, all four answer the same', async () => {
    await h.start('BUDI', '2026-07-15');
    const steps: [string, () => Promise<unknown>][] = [
      ['a goal saved by his leader', async () => { h.as('SARI'); await h.http().put('/goals/2026').query({ for: id('BUDI') }).send(GOAL).expect(200); }],
      ['a lead he added', async () => { h.as('BUDI'); await h.http().post('/leads').send({ name: 'Ibu Yohana' }).expect(201); }],
      ['four weeks of activity', async () => {
        for (const localDate of ['2026-08-24', '2026-08-31']) {
          await h.col('activityLogs').insertOne({
            kpmId: h.office.as('BUDI').kpmId, membershipId: id('BUDI'), localDate, totalCount: 1, deletedAt: null,
            entries: [{ activityTypeId: 't', activityTypeCode: 'LEADS_CONTACTED', count: 1 }], source: 'self',
            enteredByMembershipId: id('BUDI'), version: 1, frozenAt: null, corrections: [],
          });
        }
        h.as('BUDI');
        await h.http().put('/activity/log').send({ date: '2026-09-07', counts: { LEADS_CONTACTED: 1 } }).expect(200);
        await h.http().put('/activity/log').send({ date: '2026-09-14', counts: { LEADS_CONTACTED: 1 } }).expect(200);
      }],
      ['a manual tick by his leader', async () => { h.as('SARI'); await h.http().put(`/new-hires/${id('BUDI')}/items/ROLE_PLAY`).send({ done: true }).expect(200); }],
      ['a manual tick by him', async () => { h.as('BUDI'); await h.http().put('/activation/me/items/CRM_SETUP').send({ done: true }).expect(200); }],
    ];
    let done = 0;
    for (const [step, write] of steps) {
      await write();
      const [own, ...others] = await fourReads();
      for (const other of others) expect([step, other]).toEqual([step, own]);
      expect(own.done.length).toBeGreaterThan(done);
      done = own.done.length;
    }
    expect(done).toBe(5);
  });

  it('P13-T3 AC-7 the roster’s reads are bounded: the same queries for one hire as for three, one per link kind', async () => {
    const queries = async () => {
      const seen: string[] = [];
      mongoose.set('debug', (collection: string, method: string) => { seen.push(`${collection}.${method}`); });
      try {
        h.as('SARI');
        await h.http().get('/new-hires').expect(200);
      } finally {
        mongoose.set('debug', false);
      }
      return seen.filter((q) => !q.startsWith('auditLog')).sort();
    };
    // Hires waiting on the same links, so each read asks the same questions: none has a goal, a lead or a week.
    await h.start('BUDI', '2026-07-15');
    const one = await queries();
    await h.start('DODI', '2026-09-01');
    await h.start('NINA', '2026-08-15');
    const three = await queries();
    expect(three).toEqual(one);
    expect(one).toEqual(expect.arrayContaining(['goals.aggregate', 'leads.aggregate', 'activityLogs.find', 'activationProgress.find']));
  });
});
