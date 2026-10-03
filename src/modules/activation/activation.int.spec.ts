import mongoose from 'mongoose';
import { SUPER_ADMIN, declaredPermissions } from '../../../test/http-permissions';
import {
  startActivationHarness, stopActivationHarness, TODAY, type ActivationHarness, type Who,
} from '../../../test/activation-office';
import { ActivationProgressController } from './activation-progress.controller';
import { NewHiresController } from './new-hires.controller';

/** The view's fields, exactly: the contract the frontend builds against. */
const VIEW_KEYS = [
  'aspects', 'day', 'done', 'endsOn', 'firstCaseClosed', 'graduatedAt', 'graduatedBy', 'hire', 'note', 'overdue',
  'pct', 'startCorrected', 'startDate', 'state', 'today', 'total', 'window',
];
const ITEM_KEYS = ['code', 'date', 'done', 'doneAt', 'doneBy', 'label', 'link', 'note', 'source'];
const MANUAL = [
  'INSURANCE_BASICS', 'CAREER_MINDSET', 'COMPANY_PROFILE', 'KPM_INTRO_SESSION', 'CRM_SETUP', 'CHECK_CONTEST',
  'MANDATORY_TRAINING', 'CERTIFY_PRODUCTS', 'ROLE_PLAY', 'JOINT_FIELD_WORK', 'FIRST_CASE_CLOSED', 'WEEKLY_CHECK_IN',
  'INDEPENDENT_AGENT_MILESTONE',
];

type Item = { code: string; done: boolean; source: string | null; doneBy: { membershipId: string; name: string } | null; note: string | null; date: string | null; link: { live: boolean } | null };
const items = (view: { aspects: { items: Item[] }[] }) => view.aspects.flatMap((a) => a.items);
const item = (view: { aspects: { items: Item[] }[] }, code: string) => items(view).find((i) => i.code === code)!;

/**
 * **The hire's own activation over HTTP** (P13-T1, T2, T4 and T7's backend): the read, a tick with the
 * hire's note and date, graduation, `GET /auth/me`'s two facts, and every refusal — with the decorators,
 * the production pipe and the permission guard in front of the real services.
 */
describe('the hire’s own activation over HTTP (Phase 13)', () => {
  let h: ActivationHarness;
  const id = (who: Who) => h.id(who);
  const audit = () => h.col('auditLog').find({ action: { $regex: '^activation\\.' } }).sort({ createdAt: 1 }).toArray();

  beforeAll(async () => { h = await startActivationHarness(); });
  afterAll(async () => { await stopActivationHarness(h); });
  beforeEach(async () => { await h.reset(); });

  it('P13-T7 AC-5 declares a permission on every route, and the right one', () => {
    expect(declaredPermissions(ActivationProgressController)).toEqual({
      mine: 'activation:read', tick: 'activation:update_manual_item', graduate: 'activation:graduate',
    });
    expect(declaredPermissions(NewHiresController)).toEqual({
      roster: 'new_hires:read_roster', detail: 'activation:read', tick: 'activation:update_manual_item',
      correctStart: 'activation:set_start_date', saveNote: 'activation_note:write',
    });
  });

  describe('GET /activation/me', () => {
    it('P13-T4 AC-6 answers the hire’s activation in the contract’s shape, with the office’s today and day', async () => {
      await h.start('RINA', '2026-07-18');
      h.as('RINA');

      const view = (await h.http().get('/activation/me').expect(200)).body;
      expect(Object.keys(view).sort()).toEqual(VIEW_KEYS);
      expect(view).toMatchObject({
        hire: { membershipId: id('RINA'), name: 'Rina Wijaya' }, state: 'open', startDate: '2026-07-18',
        startCorrected: null, today: TODAY, day: 59, window: 90, overdue: false, endsOn: '2027-01-18',
        total: 16, graduatedAt: null, graduatedBy: null, note: null, firstCaseClosed: false,
      });
      expect(view.aspects.map((a: { label: string; total: number }) => [a.label, a.total])).toEqual([
        ['1. Introduction', 4], ['2. Initial Setup', 4], ['3. Training & Certification', 3], ['4. First Sale', 2],
        ['5. Ongoing Habits', 3],
      ]);
      expect(Object.keys(items(view)[0]).sort()).toEqual(ITEM_KEYS);
    });

    it('P13-T3 AC-2 a goal she saved before reading completes her goal item from her real data, attributed to her', async () => {
      await h.start('RINA', '2026-07-18');
      h.as('RINA');

      const view = (await h.http().get('/activation/me').expect(200)).body;
      expect(item(view, 'GOAL_SETTING')).toMatchObject({
        done: true, source: 'link', doneBy: { membershipId: id('RINA'), name: 'Rina Wijaya' },
        link: { kind: 'feature:goals', live: true },
      });
      expect(view).toMatchObject({ done: 1, pct: 6 });
      expect(view.aspects[1]).toMatchObject({ status: 'in_progress', done: 1, total: 4 });
      expect(view.aspects[0]).toMatchObject({ status: 'not_started', done: 0 });
    });

    it('P13-T1 AC-4 the day past the window, below 100%, is overdue', async () => {
      await h.start('INDAH', '2026-06-10');
      h.as('INDAH');
      expect((await h.http().get('/activation/me').expect(200)).body).toMatchObject({ day: 97, window: 90, overdue: true });
    });

    it('P13-T1 AC-4 the window is the office’s, not the literal 90', async () => {
      await h.start('INDAH', '2026-06-10');
      await h.col('kpms').updateOne({ _id: new mongoose.Types.ObjectId(h.office.as('INDAH').kpmId!) }, { $set: { 'settings.activationWindowDays': 120 } });
      h.as('INDAH');
      try {
        expect((await h.http().get('/activation/me').expect(200)).body).toMatchObject({ day: 97, window: 120, overdue: false });
      } finally {
        await h.col('kpms').updateOne({ _id: new mongoose.Types.ObjectId(h.office.as('INDAH').kpmId!) }, { $set: { 'settings.activationWindowDays': 90 } });
      }
    });

    it('P13-T1 AC-5 six months after the start it is expired, kept and read-only', async () => {
      await h.start('BUDI', '2026-03-14');
      h.as('BUDI');
      const view = (await h.http().get('/activation/me').expect(200)).body;
      expect(view).toMatchObject({ state: 'expired', endsOn: '2026-09-14', overdue: false });
      const refused = await h.http().put('/activation/me/items/CRM_SETUP').send({ done: true }).expect(409);
      expect(refused.body.error).toMatchObject({ code: 'ACTIVATION_CLOSED', details: { state: 'expired' } });
    });

    it('P13-T1 AC-1 is 404 for a reader with no activation: an AB, an Agent who joined by no leader', async () => {
      for (const who of ['AGUS', 'SARI', 'BUDI'] as const) {
        h.as(who);
        expect((await h.http().get('/activation/me').expect(404)).body.error.code).toBe('NOT_FOUND');
      }
    });
  });

  describe('a tick (P13-T2)', () => {
    it('P13-T2 AC-2 the hire ticks a manual item with a note and a date: attributed to her, audited by id', async () => {
      const doc = await h.start('RINA', '2026-07-18');
      h.as('RINA');

      const view = (await h.http().put('/activation/me/items/INSURANCE_BASICS')
        .send({ done: true, note: '  With Sari, at the branch.  ', date: '2026-07-20' }).expect(200)).body;
      expect(item(view, 'INSURANCE_BASICS')).toMatchObject({
        done: true, source: 'hire', doneBy: { membershipId: id('RINA') }, note: 'With Sari, at the branch.', date: '2026-07-20',
      });
      expect(view.aspects[0]).toMatchObject({ status: 'in_progress', done: 1 });

      const rows = await audit();
      expect(rows.map((r) => [r.action, r.targetCollection, r.targetId, r.targetMembershipId, r.after])).toEqual([
        ['activation.item_ticked', 'activationProgress', String(doc._id), id('RINA'), { code: 'INSURANCE_BASICS' }],
      ]);
    });

    it('P13-T2 AC-3 a write sets the item rather than toggling it; an untick keeps the hire’s note unless she sends one', async () => {
      await h.start('RINA', '2026-07-18');
      h.as('RINA');
      await h.http().put('/activation/me/items/CRM_SETUP').send({ done: true, note: 'Set up', date: '2026-08-01' }).expect(200);
      const twice = (await h.http().put('/activation/me/items/CRM_SETUP').send({ done: true }).expect(200)).body;
      expect(item(twice, 'CRM_SETUP')).toMatchObject({ done: true, note: 'Set up', date: '2026-08-01' });

      const off = (await h.http().put('/activation/me/items/CRM_SETUP').send({ done: false }).expect(200)).body;
      expect(item(off, 'CRM_SETUP')).toMatchObject({ done: false, source: null, doneBy: null, doneAt: null, note: 'Set up' });
      const cleared = (await h.http().put('/activation/me/items/CRM_SETUP').send({ done: false, note: '', date: null }).expect(200)).body;
      expect(item(cleared, 'CRM_SETUP')).toMatchObject({ note: null, date: null });
      expect((await audit()).map((r) => r.action)).toEqual([
        'activation.item_ticked', 'activation.item_ticked', 'activation.item_unticked', 'activation.item_unticked',
      ]);
    });

    it('P13-T2 AC-1 an item is named by its code in the pinned version: any other is 404', async () => {
      await h.start('RINA', '2026-07-18');
      h.as('RINA');
      for (const code of ['NOT_AN_ITEM', 'crm_setup', '13']) {
        expect((await h.http().put(`/activation/me/items/${code}`).send({ done: true }).expect(404)).body.error.code).toBe('NOT_FOUND');
      }
      expect(await audit()).toEqual([]);
    });

    it('P13-T2 AC-4 the note’s limit and the date’s shape are the contract’s', async () => {
      await h.start('RINA', '2026-07-18');
      h.as('RINA');
      const put = (body: Record<string, unknown>) => h.http().put('/activation/me/items/CRM_SETUP').send(body);
      await put({ done: true, note: 'x'.repeat(500) }).expect(200);
      for (const body of [
        { done: true, note: 'x'.repeat(501) }, { done: true, date: '2026-02-30' }, { done: true, date: '1 Aug' },
        { done: 'yes' }, {}, { done: true, extra: 1 },
      ]) {
        expect([body, (await put(body).expect(400)).body.error.code]).toEqual([body, expect.stringMatching(/^VALIDATION_/)]);
      }
    });

    it('P13-T3 AC-1 nobody ticks a linked item by hand: the hire, an elevated support session as her — refused, nothing changed', async () => {
      await h.start('BUDI', '2026-07-15');
      for (const who of [h.office.as('BUDI'), h.supporting('BUDI', false)]) {
        h.as(who);
        for (const code of ['GOAL_SETTING', 'ADD_PROSPECTS', 'ACTIVITY_TRACKER_WEEKLY']) {
          for (const done of [true, false]) {
            const res = await h.http().put(`/activation/me/items/${code}`).send({ done }).expect(409);
            expect(res.body.error).toMatchObject({ code: 'ACTIVATION_ITEM_AUTOMATIC', details: { code } });
          }
        }
      }
      h.as('BUDI');
      const view = (await h.http().get('/activation/me').expect(200)).body;
      expect(view.done).toBe(0);
      expect(await audit()).toEqual([]);
    });

    it('P13-T2 AC-3 a training-linked item stays tickable by hand until its evaluator exists', async () => {
      const doc = await h.start('BUDI', '2026-07-15');
      // An office that bound item 9 to a training module (`KPM_Owner.html:1546`): the link is not live.
      await h.col('activationTemplates').updateOne(
        { _id: new mongoose.Types.ObjectId(doc.templateId), 'aspects.items.code': 'MANDATORY_TRAINING' },
        { $set: { 'aspects.$[a].items.$[i].autoLink': 'training:PROSPECT_LIST' } },
        { arrayFilters: [{ 'a.code': 'TRAINING_AND_CERTIFICATION' }, { 'i.code': 'MANDATORY_TRAINING' }] },
      );
      try {
        h.as('BUDI');
        const view = (await h.http().put('/activation/me/items/MANDATORY_TRAINING').send({ done: true }).expect(200)).body;
        expect(item(view, 'MANDATORY_TRAINING')).toMatchObject({ done: true, source: 'hire', link: { kind: 'training:PROSPECT_LIST', live: false } });
      } finally {
        await h.col('activationTemplates').updateOne(
          { _id: new mongoose.Types.ObjectId(doc.templateId) },
          { $set: { 'aspects.$[a].items.$[i].autoLink': null } },
          { arrayFilters: [{ 'a.code': 'TRAINING_AND_CERTIFICATION' }, { 'i.code': 'MANDATORY_TRAINING' }] },
        );
      }
    });

    it('P13-T2 AC-3 a row an older activation lacks is added by the first tick, and nothing else moves', async () => {
      const doc = await h.start('BUDI', '2026-07-15', { items: [] });
      h.as('BUDI');
      const view = (await h.http().put('/activation/me/items/ROLE_PLAY').send({ done: true }).expect(200)).body;
      expect(view).toMatchObject({ done: 1, total: 16 });
      const stored = await h.col('activationProgress').findOne({ _id: doc._id });
      expect(stored!.items.map((i: { code: string }) => i.code)).toEqual(['ROLE_PLAY']);
    });
  });

  describe('graduation (OD-28, P13-T7)', () => {
    /** Budi's three links met by the writes their words name, and every manual item ticked but `leave`. */
    async function nearlyDone(leave: string[] = []) {
      await h.start('BUDI', '2026-07-15');
      h.as('BUDI');
      await h.http().put('/goals/2026').send({
        mode: 'direct', annualApeTargetMinor: 300_000_000_00, savingsTargetMinor: 0, commissionRatePct: 10,
        monthsLeft: 4, apeAchievedMinor: 0, caseSizeMinor: 10_000_000_00, leadsToApptPct: 30, closingRatePct: 30,
      }).expect(200);
      await h.http().post('/leads').send({ name: 'Ibu Melinda' }).expect(201);
      await h.col('activityLogs').insertMany(['2026-08-17', '2026-08-24', '2026-08-31', '2026-09-07'].map((localDate) => ({
        kpmId: h.office.as('BUDI').kpmId, membershipId: id('BUDI'), localDate, totalCount: 2, deletedAt: null,
        entries: [{ activityTypeId: 't', activityTypeCode: 'LEADS_CONTACTED', count: 2 }], source: 'self',
        enteredByMembershipId: id('BUDI'), version: 1, frozenAt: null, corrections: [],
      })));
      for (const code of MANUAL.filter((c) => !leave.includes(c))) {
        await h.http().put(`/activation/me/items/${code}`).send({ done: true }).expect(200);
      }
    }

    it('P13-T7 AC-1 is refused below 100%, naming how many are left', async () => {
      await nearlyDone(['FIRST_CASE_CLOSED']);
      const res = await h.http().post('/activation/me/graduate').expect(409);
      expect(res.body.error).toMatchObject({ code: 'ACTIVATION_INCOMPLETE', details: { done: 15, total: 16 } });
      expect((await audit()).filter((r) => r.action === 'activation.graduated')).toEqual([]);
    });

    it('P13-T7 AC-3 at 100% the hire marks it complete: who and when kept, one audit row, then closed to every write', async () => {
      await nearlyDone();
      const doc = await h.col('activationProgress').findOne({ membershipId: id('BUDI') });
      const done = (await h.http().post('/activation/me/graduate').expect(200)).body;
      expect(done).toMatchObject({
        state: 'graduated', pct: 100, done: 16, graduatedAt: h.clock.now().toISOString(),
        graduatedBy: { membershipId: id('BUDI'), name: 'Budi Santoso' }, overdue: false,
      });
      const graduated = (await audit()).filter((r) => r.action === 'activation.graduated');
      expect(graduated.map((r) => [r.targetId, r.targetMembershipId])).toEqual([[String(doc!._id), id('BUDI')]]);

      // Refused twice, and every write after it.
      expect((await h.http().post('/activation/me/graduate').expect(409)).body.error).toMatchObject({ code: 'ACTIVATION_CLOSED', details: { state: 'graduated' } });
      expect((await h.http().put('/activation/me/items/CRM_SETUP').send({ done: false }).expect(409)).body.error.code).toBe('ACTIVATION_CLOSED');
      // Still readable, as it was.
      expect((await h.http().get('/activation/me').expect(200)).body).toMatchObject({ state: 'graduated', pct: 100 });
    });

    it('P13-T7 AC-6 an expired activation cannot be graduated', async () => {
      await h.start('BUDI', '2026-02-01');
      h.as('BUDI');
      expect((await h.http().post('/activation/me/graduate').expect(409)).body.error).toMatchObject({ code: 'ACTIVATION_CLOSED', details: { state: 'expired' } });
    });

    it('Phase 13 exit review N4 an elevated support session cannot graduate its member (ADR-0100): 403, nothing graduated; the hire herself can', async () => {
      await nearlyDone();
      h.as(h.supporting('BUDI', false));
      expect((await h.http().post('/activation/me/graduate').expect(403)).body.error.code).toBe('PERM_DENIED');
      expect(await h.col('activationProgress').findOne({ membershipId: id('BUDI') })).toMatchObject({ graduatedAt: null, graduatedByMembershipId: null });
      expect((await audit()).filter((r) => r.action === 'activation.graduated')).toEqual([]);
      // The same session still ticks as her: only the declaration is hers alone.
      await h.http().put('/activation/me/items/CRM_SETUP').send({ done: true }).expect(200);
      h.as('BUDI');
      expect((await h.http().post('/activation/me/graduate').expect(200)).body).toMatchObject({ state: 'graduated', graduatedBy: { membershipId: id('BUDI') } });
    });

    it('P13-T7 AC-1 nobody graduates anybody else: a leader’s graduate is their own, and they have none', async () => {
      await h.start('RINA', '2026-07-18');
      for (const who of ['SARI', 'AGUS', 'LUKAS'] as const) {
        h.as(who);
        expect((await h.http().post('/activation/me/graduate').expect(404)).body.error.code).toBe('NOT_FOUND');
      }
    });
  });

  describe('GET /auth/me: the New agent section’s facts (P13-T7 AC-5)', () => {
    const facts = async () => {
      const body = (await h.http().get('/auth/me').expect(200)).body;
      return { activation: body.activation, newHires: body.newHires };
    };

    it('P13-T7 AC-5 a hire with an open activation, and her leaders, who reach it', async () => {
      await h.start('RINA', '2026-07-18');
      h.as('RINA');
      expect(await facts()).toEqual({ activation: { open: true, complete: false }, newHires: false });
      for (const who of ['SARI', 'AGUS', 'OWNER'] as const) {
        h.as(who);
        expect([who, await facts()]).toEqual([who, { activation: null, newHires: true }]);
      }
    });

    it('P13-T7 AC-5 OD-122 an Agent with a direct report sees New hires; one who leads nobody, a peer and an AAB who leads nobody do not', async () => {
      await h.start('TARI', '2026-08-01');
      h.as('LUKAS');
      expect(await facts()).toEqual({ activation: null, newHires: true });
      for (const who of ['INDAH', 'DEWI', 'PEER_AB', 'SARI'] as const) {
        h.as(who);
        expect([who, await facts()]).toEqual([who, { activation: null, newHires: false }]);
      }
    });

    it('P13-T7 AC-4 graduated or expired, the section goes and the roster with it', async () => {
      await h.start('RINA', '2026-07-18', { graduatedAt: new Date('2026-09-10T02:00:00Z'), graduatedByMembershipId: id('RINA') });
      await h.start('BUDI', '2026-03-01');
      h.as('RINA');
      expect((await facts()).activation).toEqual({ open: false, complete: false });
      h.as('BUDI');
      expect((await facts()).activation).toEqual({ open: false, complete: false });
      h.as('SARI');
      expect((await facts()).newHires).toBe(false);
      expect((await h.http().get('/new-hires').expect(404)).body.error.code).toBe('NOT_FOUND');
    });

    it('P13-T7 AC-5 nothing to show for an office role with no rung, a Super Admin, and a pending member', async () => {
      await h.start('RINA', '2026-07-18');
      for (const who of [h.officeOnly('OWNER'), h.officeOnly('ADMIN'), SUPER_ADMIN]) {
        h.as(who);
        expect(await facts()).toEqual({ activation: null, newHires: false });
      }
      const pending = h.office.as('RINA');
      h.as(new (pending.constructor as never as new (...a: unknown[]) => typeof pending)(
        pending.userId, 'none', { ...pending.membership!, status: 'pending' },
      ));
      expect(await facts()).toEqual({ activation: null, newHires: false });
    });

    it('P13-T4 AC-9 a read-only support session reads its member’s facts and page, and is refused every write', async () => {
      await h.start('RINA', '2026-07-18');
      h.as(h.supporting('RINA'));
      expect(await facts()).toEqual({ activation: { open: true, complete: false }, newHires: false });
      await h.http().get('/activation/me').expect(200);
      for (const res of [
        await h.http().put('/activation/me/items/CRM_SETUP').send({ done: true }),
        await h.http().post('/activation/me/graduate'),
      ]) {
        expect([res.status, res.body.error.code]).toEqual([403, 'PERM_DENIED']);
      }
      expect(await audit()).toEqual([]);
    });

    it('P13-T2 AC-2 an elevated support session ticks as its member: both actors on the record', async () => {
      await h.start('RINA', '2026-07-18');
      h.as(h.supporting('RINA', false));
      const view = (await h.http().put('/activation/me/items/CRM_SETUP').send({ done: true }).expect(200)).body;
      expect(item(view, 'CRM_SETUP')).toMatchObject({ source: 'hire', doneBy: { membershipId: id('RINA') } });
      expect((await audit()).map((r) => [r.action, r.actorUserId, r.effectiveUserId, r.actorMembershipId])).toEqual([
        ['activation.item_ticked', 'u-support', 'u-RINA', id('RINA')],
      ]);
    });

    /** Every activation as stored, in one order: what a read that writes nothing leaves as it found. */
    const stored = () => h.col('activationProgress').find({}).sort({ _id: 1 }).toArray();
    const storedItem = async (who: Who, code: string) =>
      ((await h.col('activationProgress').findOne({ membershipId: id(who) }))!.items as { code: string; done: boolean }[])
        .find((i) => i.code === code);

    it('Phase 13 exit review N3 a read-only session’s reads — /auth/me, /activation/me, /new-hires, /new-hires/:id — write nothing, and still show the links met', async () => {
      await h.start('RINA', '2026-07-18');
      // No item rows at all: the met link's row is added in memory, never to the row.
      await h.start('DIMAS', '2026-08-20', { items: [] });
      const before = await stored();
      expect(await storedItem('RINA', 'GOAL_SETTING')).toMatchObject({ done: false });

      h.as(h.supporting('RINA'));
      expect(await facts()).toEqual({ activation: { open: true, complete: false }, newHires: false });
      const own = (await h.http().get('/activation/me').expect(200)).body;
      expect(item(own, 'GOAL_SETTING')).toMatchObject({ done: true, source: 'link', doneBy: { membershipId: id('RINA') } });
      expect(own).toMatchObject({ done: 1, pct: 6 });

      h.as(h.supporting('SARI'));
      await h.http().get('/new-hires').expect(200);
      expect(item((await h.http().get(`/new-hires/${id('RINA')}`).expect(200)).body, 'GOAL_SETTING')).toMatchObject({ done: true, source: 'link' });

      h.as(h.supporting('AGUS'));
      expect(await facts()).toEqual({ activation: null, newHires: true });
      await h.http().get('/new-hires').expect(200);
      const dimas = (await h.http().get(`/new-hires/${id('DIMAS')}`).expect(200)).body;
      expect(item(dimas, 'GOAL_SETTING')).toMatchObject({ done: true, source: 'link', doneBy: { membershipId: id('DIMAS') } });
      expect(dimas).toMatchObject({ done: 1, total: 16 });

      expect(await stored()).toEqual(before);

      // The member's own read is the one that writes it.
      h.as('RINA');
      await h.http().get('/activation/me').expect(200);
      expect(await storedItem('RINA', 'GOAL_SETTING')).toMatchObject({ done: true, source: 'link' });
    });

    /** Budi as joined on 1 August, with the history `edges` writes: the shape of how he was placed. */
    async function joinedOnTheFirst(edges: (userId: string) => Record<string, unknown>[], run: () => Promise<void>) {
      const budi = (await h.col('memberships').findOne({ _id: new mongoose.Types.ObjectId(id('BUDI')) }))!;
      await h.col('memberships').updateOne({ _id: budi._id }, { $set: { joinedAt: new Date('2026-07-31T18:00:00Z') } });
      try {
        const rows = edges(String(budi.userId)).map((edge, i) => ({
          kpmId: budi.kpmId, membershipId: id('BUDI'), eventType: 'joined', toRole: 'agent', fromLeaderId: null,
          validFrom: new Date(Date.UTC(2026, 6, 31, 17, i)), validTo: null, deletedAt: null, ...edge,
        }));
        if (rows.length > 0) await h.col('membershipHistory').insertMany(rows);
        h.as('BUDI');
        await run();
      } finally {
        await h.col('memberships').updateOne({ _id: budi._id }, { $set: { joinedAt: new Date('2026-01-02T02:00:00Z') } });
        await h.col('membershipHistory').deleteMany({ membershipId: id('BUDI') });
      }
    }

    it.each([
      ['an approved request or a tag: a registration, then a joined edge naming his leader', (userId: string) => [
        { toLeaderId: null, actorUserId: userId }, { toLeaderId: id('SARI'), actorUserId: 'u-sari' },
      ]],
      ['a leader’s code: one joined edge naming his leader, written by him', (userId: string) => [
        { toLeaderId: id('SARI'), actorUserId: userId },
      ]],
    ])('P13-T1 AC-2 creation fails open, and the next read heals it, from the join date — %s', async (_how, edges) => {
      await joinedOnTheFirst(edges, async () => {
        expect(await facts()).toEqual({ activation: { open: true, complete: false }, newHires: false });
        expect((await h.http().get('/activation/me').expect(200)).body).toMatchObject({ startDate: '2026-08-01', day: 45 });
        expect(await h.col('activationProgress').countDocuments({ membershipId: id('BUDI') })).toBe(1);
        expect(await h.col('activationProgress').findOne({ membershipId: id('BUDI') })).toMatchObject({ origin: 'joined', templateVersion: 1 });
      });
    });

    it.each([
      ['a roster import: one joined edge, written by whoever imported it', () => [
        { toLeaderId: id('SARI'), actorUserId: 'u-owner' },
      ]],
      ['a code redeemed inside a support session, which reads as an import', () => [
        { toLeaderId: id('SARI'), actorUserId: 'u-support' },
      ]],
      ['a registration nobody has placed yet', (userId: string) => [{ toLeaderId: null, actorUserId: userId }]],
      ['no history at all', () => []],
    ])('P13-T1 AC-1 a read heals nobody it cannot tell was placed by a leader — %s', async (_how, edges) => {
      await joinedOnTheFirst(edges, async () => {
        expect((await facts()).activation).toBeNull();
        await h.http().get('/activation/me').expect(404);
        expect(await h.col('activationProgress').countDocuments({})).toBe(0);
      });
    });

    it('Phase 13 exit review N3 a read-only session heals nothing: its member, placed through a leader’s code, reads none and none is created; his own read creates it', async () => {
      await joinedOnTheFirst((userId) => [{ toLeaderId: id('SARI'), actorUserId: userId }], async () => {
        h.as(h.supporting('BUDI'));
        expect((await facts()).activation).toBeNull();
        expect((await h.http().get('/activation/me').expect(404)).body.error.code).toBe('NOT_FOUND');
        expect(await h.col('activationProgress').countDocuments({})).toBe(0);
        h.as('BUDI');
        expect((await facts()).activation).toEqual({ open: true, complete: false });
        expect(await h.col('activationProgress').countDocuments({ membershipId: id('BUDI') })).toBe(1);
      });
    });

    it('P13-T1 AC-1 the read heals nobody whose six months have passed: placed in January', async () => {
      const budi = (await h.col('memberships').findOne({ _id: new mongoose.Types.ObjectId(id('BUDI')) }))!;
      await h.col('membershipHistory').insertOne({
        kpmId: budi.kpmId, membershipId: id('BUDI'), eventType: 'joined', toLeaderId: id('SARI'),
        actorUserId: String(budi.userId), validFrom: new Date('2026-01-02T02:00:00Z'), validTo: null, deletedAt: null,
      });
      try {
        h.as('BUDI');
        expect((await facts()).activation).toBeNull();
        expect(await h.col('activationProgress').countDocuments({})).toBe(0);
      } finally {
        await h.col('membershipHistory').deleteMany({ membershipId: id('BUDI') });
      }
    });
  });

  describe('who the guard refuses (D-owner)', () => {
    it('P13-T5 AC-8 an Owner and an Admin with no field role, and a Super Admin, are refused every route by the guard', async () => {
      await h.start('RINA', '2026-07-18');
      for (const who of [h.officeOnly('OWNER'), h.officeOnly('ADMIN'), SUPER_ADMIN]) {
        h.as(who);
        for (const res of [
          await h.http().get('/activation/me'),
          await h.http().put('/activation/me/items/CRM_SETUP').send({ done: true }),
          await h.http().post('/activation/me/graduate'),
          await h.http().get('/new-hires'),
          await h.http().get(`/new-hires/${id('RINA')}`),
          await h.http().put(`/new-hires/${id('RINA')}/items/CRM_SETUP`).send({ done: true }),
          await h.http().put(`/new-hires/${id('RINA')}/start-date`).send({ startDate: '2026-07-01' }),
          await h.http().put(`/new-hires/${id('RINA')}/note`).send({ text: 'Hi' }),
        ]) {
          expect([res.status, res.body.error.code]).toEqual([403, 'PERM_DENIED']);
        }
      }
    });

    it('P13-T5 AC-8 an Owner who stands on a rung reads as that member (§1.1): the root AB reaches every hire', async () => {
      await h.start('RINA', '2026-07-18');
      h.as('OWNER');
      expect((await h.http().get(`/new-hires/${id('RINA')}`).expect(200)).body.hire.membershipId).toBe(id('RINA'));
    });
  });
});
