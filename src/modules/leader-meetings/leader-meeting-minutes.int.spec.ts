import { INestApplication } from '@nestjs/common';
import mongoose from 'mongoose';
import request from 'supertest';
import { FixedClock } from '@/common/clock/clock.port';
import { LEADER_MEETING_LIMITS } from '@/domain/constants';
import { SUBJECT_READ_ACTION } from '@/modules/audit/subject-read-audit';
import { clearCollections, startMongo, stopMongo } from '../../../test/mongo';
import { configModule } from '../../../test/config-module';
import { session } from '../../../test/http-permissions';
import { ROSTER_NOW, type Who } from '../../../test/coaching-office';
import { buildForumOffice, forumApp, KPM_B, type ForumOffice } from '../../../test/forum-office';
import { LeaderMeetingSchema } from './leader-meeting.schema';

/**
 * **The minutes, written field by field** (P18.1-T2 AC-5 to AC-8, P18.1-T3 AC-5): the agenda, the tracker and the
 * *Monthly Target* cells over HTTP — one field per write, a 409 only on the same item changed since, every write one
 * audit row with before and after, the first one setting `writtenAt`, authored text stored and served as text, no
 * lock, and no §3.5 entry from any forum route.
 */
describe('the minutes, written field by field (P18.1-T2 AC-5 to AC-8)', () => {
  let app: INestApplication;
  let wired: ReturnType<typeof configModule>;
  let office: ForumOffice;
  /** The §3.5 entries the fixture's own building wrote, before any forum route ran. */
  let readsBefore: number;
  const db = () => mongoose.connection.db!;
  const http = () => request(app.getHttpServer());
  const as = (who: Who) => { session.current = office.as(who); };
  const make = async (title: string, date: string) => office.forum.create(office.as('OWNER'), { title, date });
  const read = async (id: string) => (await http().get(`/leader-meetings/${id}`).expect(200)).body;
  const auditOf = (meetingId: string, action: string) =>
    db().collection('auditLog').find({ targetId: meetingId, action }).sort({ _id: 1 }).toArray();

  beforeAll(async () => {
    await startMongo();
    wired = configModule(ROSTER_NOW);
    await clearCollections();
    office = await buildForumOffice(wired);
    readsBefore = await db().collection('auditLog').countDocuments({ action: SUBJECT_READ_ACTION });
    app = await forumApp(office);
  }, 120_000);

  afterAll(async () => {
    await app.close();
    await stopMongo();
  });

  afterEach(() => (wired.clock as FixedClock).set(ROSTER_NOW));

  describe('P18.1-T2 AC-5, ADR-0130 §3 the agenda a new meeting starts from', () => {
    it('P18.1-T2 AC-5, P18.97-T2 AC-4 an office’s first: the prototype’s ten, PICs empty, the meeting’s own month; no rows, nothing written', async () => {
      const first = await office.forum.create(office.ownerOfB(), { title: 'Strategic Check-in — #1', date: '2026-10-13' });
      expect(first.number).toBe(1);
      const view = await office.forum.read(office.ownerOfB(), first.id);
      expect(view.agenda.preparation.map((i) => i.text)).toEqual([
        'Compile follow-ups & commitments from prior session', 'Prepare October performance data', 'Review scorecard, draft talking points',
      ]);
      expect(view.agenda.during.map((i) => i.text)).toEqual([
        'Process update — review prior follow-ups', 'Performance review vs. key thresholds', 'Strategic priorities (Corporate)',
        'Strategic priorities (Agency)', 'Summarize next steps & assign owners',
      ]);
      expect(view.agenda.post.map((i) => i.text)).toEqual(['Document outcomes into template', 'Note feedback for RBDO/BDO']);
      const all = [...view.agenda.preparation, ...view.agenda.during, ...view.agenda.post];
      expect(all).toHaveLength(10);
      expect(all.every((i) => i.pic === '' && i.done === false && i.version === 1)).toBe(true);
      expect(new Set(all.map((i) => i.id)).size).toBe(10);
      expect([view.actionItems, view.writtenIn]).toEqual([[], false]);
      await db().collection('leaderMeetings').updateOne({ kpmId: KPM_B }, { $set: { deletedAt: new Date() } });
    });

    it('P18.1-T2 AC-5 a later one copies the latest meeting’s agenda — text and PIC, each box unticked, new ids — and carries no rows', async () => {
      const earlier = await make('Earlier', '2026-09-24');
      as('OWNER');
      const during = (await read(earlier.id)).agenda.during[0];
      await http().patch(`/leader-meetings/${earlier.id}/agenda-items/${during.id}`).send({ done: true, version: 1 }).expect(200);
      await http().patch(`/leader-meetings/${earlier.id}/agenda-items/${during.id}`).send({ pic: 'Wilson', version: 2 }).expect(200);
      await http().post(`/leader-meetings/${earlier.id}/action-items`).expect(201);
      const next = (await http().post('/leader-meetings').send({ title: 'Next', date: '2026-10-08' }).expect(201)).body;
      const copied = await read(next.id);
      expect(copied.agenda.during[0]).toMatchObject({ text: during.text, pic: 'Wilson', done: false, version: 1 });
      expect(copied.agenda.during[0].id).not.toBe(during.id);
      expect([copied.actionItems, copied.writtenIn]).toEqual([[], false]);
    });

    it('P18.97-T2 AC-4 every new meeting re-dates the month item, a copied agenda included — across a year’s edge — and copies the rest as typed', async () => {
      as('OWNER');
      const december = (await http().post('/leader-meetings').send({ title: 'December', date: '2026-12-29' }).expect(201)).body;
      const decemberAgenda = (await read(december.id)).agenda;
      expect(decemberAgenda.preparation[1].text).toBe('Prepare December performance data');
      // A leader's own wording of another item travels as typed.
      const review = decemberAgenda.preparation[2];
      await http().patch(`/leader-meetings/${december.id}/agenda-items/${review.id}`).send({ text: 'Review the December scorecard', version: review.version }).expect(200);
      const january = (await http().post('/leader-meetings').send({ title: 'January', date: '2027-01-12' }).expect(201)).body;
      const copied = (await read(january.id)).agenda;
      expect(copied.preparation.map((i: { text: string }) => i.text)).toEqual([
        decemberAgenda.preparation[0].text, 'Prepare January performance data', 'Review the December scorecard',
      ]);
      expect(copied.during.map((i: { text: string }) => i.text)).toEqual(decemberAgenda.during.map((i: { text: string }) => i.text));
      await db().collection('leaderMeetings').updateMany(
        { _id: { $in: [december.id, january.id].map((id) => new mongoose.Types.ObjectId(id)) } }, { $set: { deletedAt: new Date() } },
      );
    });
  });

  describe('P18.1-T2 AC-5 the agenda', () => {
    let id: string;
    beforeAll(async () => { id = (await make('Agenda', '2026-10-01')).id; });

    it('P18.1-T2 AC-5 + Add item appends "New agenda item", no PIC, unticked; the first write sets writtenAt; audited', async () => {
      as('AGUS');
      expect((await read(id)).writtenIn).toBe(false);
      const item = (await http().post(`/leader-meetings/${id}/agenda-items`).send({ section: 'post' }).expect(201)).body;
      expect(item).toEqual({ id: expect.any(String), text: 'New agenda item', pic: '', done: false, version: 1 });
      const view = await read(id);
      expect(view.agenda.post.at(-1)).toEqual(item);
      expect(view.writtenIn).toBe(true);
      const [entry] = await auditOf(id, 'leader_meeting.agenda_item_added');
      expect(entry).toMatchObject({ targetCollection: 'leaderMeetings', before: null, after: { section: 'post', item }, actorMembershipId: office.id.AGUS });
      expect((await http().post(`/leader-meetings/${id}/agenda-items`).send({ section: 'later' }).expect(400)).body.error.code).toBe('VALIDATION_FAILED');
    });

    it('P18.1-T2 AC-5 the text, the PIC and a During box, one field per write, each audited with before and after', async () => {
      as('SARI');
      const [item] = (await read(id)).agenda.during;
      const text = (await http().patch(`/leader-meetings/${id}/agenda-items/${item.id}`).send({ text: '  Reviewed  ', version: 1 }).expect(200)).body;
      expect(text).toEqual({ ...item, text: 'Reviewed', version: 2 });
      const pic = (await http().patch(`/leader-meetings/${id}/agenda-items/${item.id}`).send({ pic: 'Sari', version: 2 }).expect(200)).body;
      const done = (await http().patch(`/leader-meetings/${id}/agenda-items/${item.id}`).send({ done: true, version: 3 }).expect(200)).body;
      expect([pic.pic, done.done, done.version]).toEqual(['Sari', true, 4]);
      const saved = await auditOf(id, 'leader_meeting.agenda_item_saved');
      expect(saved.at(-1)).toMatchObject({
        before: { section: 'during', item: { id: item.id, done: false, version: 3 } },
        after: { section: 'during', item: { id: item.id, done: true, version: 4 } },
      });
    });

    it('P18.1-T2 AC-5, AC-9 refused 400: done outside During, two fields, none, an unknown field, a text or PIC too long, a null', async () => {
      as('OWNER');
      const view = await read(id);
      const prep = view.agenda.preparation[0];
      const during = view.agenda.during[1];
      for (const [itemId, body] of [
        [prep.id, { done: true, version: prep.version }],
        [during.id, { text: 'a', pic: 'b', version: during.version }],
        [during.id, { version: during.version }],
        [during.id, { owner: 'x', version: during.version }],
        [during.id, { text: 'x'.repeat(LEADER_MEETING_LIMITS.textMax + 1), version: during.version }],
        [during.id, { pic: 'x'.repeat(LEADER_MEETING_LIMITS.picMax + 1), version: during.version }],
        [during.id, { text: 'no version' }],
        // Null is no value: refused, never stored, never trimmed.
        [during.id, { text: null, version: during.version }],
        [during.id, { pic: null, version: during.version }],
        [during.id, { done: null, version: during.version }],
      ] as const) {
        const res = await http().patch(`/leader-meetings/${id}/agenda-items/${itemId}`).send(body);
        expect([body, res.status, res.body.error.code]).toEqual([body, 400, 'VALIDATION_FAILED']);
      }
      expect((await read(id)).agenda).toEqual(view.agenda);
    });

    it('P18.1-T2 AC-5 an item emptied of its text is removed, answered { removed: true }, audited with what it was', async () => {
      as('OWNER');
      const [first] = (await read(id)).agenda.preparation;
      expect((await http().patch(`/leader-meetings/${id}/agenda-items/${first.id}`).send({ text: '   ', version: first.version }).expect(200)).body)
        .toEqual({ removed: true });
      expect((await read(id)).agenda.preparation.map((i: { id: string }) => i.id)).not.toContain(first.id);
      const [entry] = await auditOf(id, 'leader_meeting.agenda_item_removed');
      expect(entry).toMatchObject({ before: { section: 'preparation', item: first }, after: null });
    });

    it('P18.1-T2 AC-7 two leaders writing two different items both land; the same item again is 409 for that item alone', async () => {
      const [a, b] = (await read(id)).agenda.during.slice(2);
      as('AGUS');
      await http().patch(`/leader-meetings/${id}/agenda-items/${a.id}`).send({ text: 'Agus wrote this', version: a.version }).expect(200);
      as('SARI');
      await http().patch(`/leader-meetings/${id}/agenda-items/${b.id}`).send({ text: 'Sari wrote this', version: b.version }).expect(200);
      const stale = await http().patch(`/leader-meetings/${id}/agenda-items/${a.id}`).send({ pic: 'Sari', version: a.version }).expect(409);
      expect(stale.body.error).toMatchObject({ code: 'VERSION_CONFLICT', details: { expectedVersion: a.version, actualVersion: a.version + 1 } });
      const after = await read(id);
      expect(after.agenda.during.find((i: { id: string }) => i.id === a.id)).toMatchObject({ text: 'Agus wrote this', pic: '' });
      expect(after.agenda.during.find((i: { id: string }) => i.id === b.id)).toMatchObject({ text: 'Sari wrote this' });
      // An item removed meanwhile is a change since it was read too.
      await http().patch(`/leader-meetings/${id}/agenda-items/${b.id}`).send({ text: '', version: b.version + 1 }).expect(200);
      const gone = await http().patch(`/leader-meetings/${id}/agenda-items/${b.id}`).send({ pic: 'x', version: b.version + 1 }).expect(409);
      expect(gone.body.error).toMatchObject({ code: 'VERSION_CONFLICT', details: { actualVersion: null } });
    });
  });

  describe('P18.1-T2 AC-6 the action items tracker', () => {
    let id: string;
    beforeAll(async () => { id = (await make('Tracker', '2026-10-02')).id; });

    it('P18.1-T2 AC-6 + Add action item appends the prototype’s row, Not yet planned; four make "4 open items"', async () => {
      as('OWNER');
      const row = (await http().post(`/leader-meetings/${id}/action-items`).expect(201)).body;
      expect(row).toEqual({
        id: expect.any(String), initiative: 'New initiative', metric: 'Success metric', action: 'New action item', pic: 'TBD',
        status: 'not_planned', remarks: 'TBD', version: 1,
      });
      for (let i = 0; i < 3; i += 1) await http().post(`/leader-meetings/${id}/action-items`).expect(201);
      const view = await read(id);
      expect(view.actionItems[0]).toEqual(row);
      expect(view.openItems).toBe(4);
    });

    it('P18.1-T2 AC-6 each cell and the status, one per write; Implemented leaves the open count', async () => {
      as('AGUS');
      const [row] = (await read(id)).actionItems;
      let version = row.version;
      for (const [field, value] of [
        ['initiative', 'Activity tracking tool adoption'], ['metric', 'Adoption 80% (currently 63%)'],
        ['action', 'Socialization on Activity Tracking Tool in LWS session'], ['pic', 'Amelia'], ['remarks', 'Scheduled for 2 Sept'],
        ['status', 'planned'], ['status', 'implemented'],
      ] as const) {
        const saved = (await http().patch(`/leader-meetings/${id}/action-items/${row.id}`).send({ [field]: value, version }).expect(200)).body;
        expect([field, saved[field], saved.version]).toEqual([field, value, version + 1]);
        version = saved.version;
      }
      expect((await read(id)).openItems).toBe(3);
      const saved = await auditOf(id, 'leader_meeting.action_item_saved');
      expect(saved).toHaveLength(7);
      expect(saved.at(-1)).toMatchObject({ before: { item: { status: 'planned' } }, after: { item: { status: 'implemented' } } });
    });

    it('P18.1-T2 AC-6, AC-9 refused 400: an unknown status, two fields, none, a cell or PIC too long, a null', async () => {
      as('OWNER');
      const [, row] = (await read(id)).actionItems;
      for (const body of [
        { status: 'done', version: row.version },
        { pic: 'a', remarks: 'b', version: row.version },
        { version: row.version },
        { remarks: 'x'.repeat(LEADER_MEETING_LIMITS.textMax + 1), version: row.version },
        { pic: 'x'.repeat(LEADER_MEETING_LIMITS.picMax + 1), version: row.version },
        // Null is no value: refused, never stored, never trimmed.
        { status: null, version: row.version },
        { initiative: null, version: row.version },
        { metric: null, version: row.version },
        { action: null, version: row.version },
        { pic: null, version: row.version },
        { remarks: null, version: row.version },
      ]) {
        const res = await http().patch(`/leader-meetings/${id}/action-items/${row.id}`).send(body);
        expect([body, res.status, res.body.error.code]).toEqual([body, 400, 'VALIDATION_FAILED']);
      }
    });

    it('P18.1-T2 AC-6 the order, by drag or keyboard, written whole; refused 409 once a row was added or removed since', async () => {
      as('SARI');
      const rows = (await read(id)).actionItems.map((r: { id: string }) => r.id);
      const reversed = [...rows].reverse();
      const answer = (await http().put(`/leader-meetings/${id}/action-items/order`).send({ itemIds: reversed }).expect(200)).body;
      expect(answer.map((r: { id: string }) => r.id)).toEqual(reversed);
      expect((await read(id)).actionItems.map((r: { id: string }) => r.id)).toEqual(reversed);
      const [entry] = await auditOf(id, 'leader_meeting.action_items_reordered');
      expect(entry).toMatchObject({ before: { itemIds: rows }, after: { itemIds: reversed } });
      // A reorder changes no row's version: a cell typed meanwhile still lands.
      expect(answer.map((r: { version: number }) => r.version)).toEqual([...(await read(id)).actionItems.map((r: { version: number }) => r.version)]);
      as('AGUS');
      await http().post(`/leader-meetings/${id}/action-items`).expect(201);
      as('SARI');
      expect((await http().put(`/leader-meetings/${id}/action-items/order`).send({ itemIds: rows }).expect(409)).body.error.code).toBe('VERSION_CONFLICT');
      expect((await http().put(`/leader-meetings/${id}/action-items/order`).send({ itemIds: [rows[0], rows[0]] }).expect(400)).body.error.code).toBe('VALIDATION_FAILED');
      expect((await http().put(`/leader-meetings/${id}/action-items/order`).send({ itemIds: 'all' }).expect(400)).body.error.code).toBe('VALIDATION_FAILED');
    });

    it('P18.1-T2 AC-6 the order of a tracker with no rows is the empty order; a row sent to it is a row it does not hold', async () => {
      const { id: empty } = await make('No rows', '2026-10-03');
      as('OWNER');
      expect((await http().put(`/leader-meetings/${empty}/action-items/order`).send({ itemIds: [] }).expect(200)).body).toEqual([]);
      expect((await http().put(`/leader-meetings/${empty}/action-items/order`).send({ itemIds: ['x'] }).expect(409)).body.error.code)
        .toBe('VERSION_CONFLICT');
    });

    it('P18.1-T2 AC-6 × removes a row at once, pinned to its version, audited with what it was', async () => {
      as('OWNER');
      const [row] = (await read(id)).actionItems;
      expect((await http().delete(`/leader-meetings/${id}/action-items/${row.id}`).query({ version: row.version + 1 }).expect(409)).body.error.code)
        .toBe('VERSION_CONFLICT');
      await http().delete(`/leader-meetings/${id}/action-items/${row.id}`).query({ version: row.version }).expect(204);
      expect((await read(id)).actionItems.map((r: { id: string }) => r.id)).not.toContain(row.id);
      const [entry] = await auditOf(id, 'leader_meeting.action_item_removed');
      expect(entry).toMatchObject({ before: { item: row }, after: null });
      const again = await http().delete(`/leader-meetings/${id}/action-items/${row.id}`).query({ version: row.version }).expect(409);
      expect(again.body.error.details).toMatchObject({ actualVersion: null });
    });
  });

  describe('P18.97-T1 AC-10 the Monthly Target cells, typed as a rate per unit (ADR-0175 §4)', () => {
    /** Rp 1 *miliar* in sen: *APE (Rp M)*'s rate, typed in the row's unit, travels in minor units. */
    const MILIAR = 1_000_000_000 * 100;

    it('P18.97-T1 AC-10 a rate × the meeting’s # of units; never typed is version 0; a stale write 409; cleared with null; audited', async () => {
      const { id } = await make('Targets', '2026-10-05');
      as('ADMIN');
      const units = (await read(id)).scorecard.chips.units;
      expect(units).toBeGreaterThan(0);
      const saved = (await http().put(`/leader-meetings/${id}/monthly-targets/avg_monthly_aa`).send({ rate: 3, version: 0 }).expect(200)).body;
      expect(saved).toEqual({ rate: 3, value: 3 * units, typed: null, version: 1 });
      const row = (await read(id)).scorecard.rows.find((r: { key: string }) => r.key === 'avg_monthly_aa');
      expect(row.monthlyTarget).toEqual(saved);
      expect((await http().put(`/leader-meetings/${id}/monthly-targets/avg_monthly_aa`).send({ rate: 1, version: 0 }).expect(409)).body.error)
        .toMatchObject({ code: 'VERSION_CONFLICT', details: { expectedVersion: 0, actualVersion: 1 } });
      // A count's rate to two places; APE's in whole sen — Rp 0,15 M a unit.
      expect((await http().put(`/leader-meetings/${id}/monthly-targets/flc`).send({ rate: 1.25, version: 0 }).expect(200)).body.value)
        .toBe(Math.round(1.25 * units * 100) / 100);
      const ape = (await http().put(`/leader-meetings/${id}/monthly-targets/ape`).send({ rate: 0.15 * 1e9 * 100, version: 0 }).expect(200)).body;
      expect(ape).toEqual({ rate: 15 * MILIAR / 100, value: (15 * MILIAR / 100) * units, typed: null, version: 1 });
      // Cleared: no rate — *APE* reads *TBD* and every other row is blank on the screen.
      const cleared = (await http().put(`/leader-meetings/${id}/monthly-targets/avg_monthly_aa`).send({ rate: null, version: 1 }).expect(200)).body;
      expect(cleared).toEqual({ rate: null, value: null, typed: null, version: 2 });
      const entries = await auditOf(id, 'leader_meeting.monthly_target_saved');
      expect(entries.filter((e) => e.after.row === 'avg_monthly_aa').map((e) => [e.before, e.after])).toEqual([
        [{ row: 'avg_monthly_aa', rate: null, typed: null, version: 0 }, { row: 'avg_monthly_aa', rate: 3, typed: null, version: 1 }],
        [{ row: 'avg_monthly_aa', rate: 3, typed: null, version: 1 }, { row: 'avg_monthly_aa', rate: null, typed: null, version: 2 }],
      ]);
    });

    it('P18.97-T1 AC-10 a rate that is not a number is refused 400 VALIDATION_FAILED — a text, the old free text included — and nothing is written', async () => {
      const { id } = await make('Refused targets', '2026-10-06');
      as('OWNER');
      const before = await db().collection('leaderMeetings').findOne({ _id: new mongoose.Types.ObjectId(id) });
      for (const body of [
        { rate: 'abc', version: 0 }, { rate: '5', version: 0 }, { rate: '1,5', version: 0 }, { rate: true, version: 0 }, { rate: {}, version: 0 },
        { rate: [1], version: 0 }, { version: 0 }, { value: '8 (1 @ unit)', version: 0 }, { rate: 1, value: 'TBD', version: 0 },
        // From 0, to two places.
        { rate: -1, version: 0 }, { rate: 1.234, version: 0 },
      ]) {
        const res = await http().put(`/leader-meetings/${id}/monthly-targets/flc`).send(body);
        expect([JSON.stringify(body), res.status, res.body.error.code]).toEqual([JSON.stringify(body), 400, 'VALIDATION_FAILED']);
      }
      // APE's is whole sen: a fraction of one is refused.
      expect((await http().put(`/leader-meetings/${id}/monthly-targets/ape`).send({ rate: 1.5, version: 0 }).expect(400)).body.error.code)
        .toBe('VALIDATION_FAILED');
      // A row that takes no target — New AA's among them since it left the table (AC-6) — or does not exist.
      for (const row of ['new_aa', 'producing_agents', 'new_agent_3m', 'cases_per_producing_agent', 'average_case_size', 'agents']) {
        const res = await http().put(`/leader-meetings/${id}/monthly-targets/${row}`).send({ rate: 1, version: 0 });
        expect([row, res.status, res.body.error.code]).toEqual([row, 400, 'VALIDATION_FAILED']);
      }
      expect(await db().collection('leaderMeetings').findOne({ _id: new mongoose.Types.ObjectId(id) })).toEqual(before);
      expect(await auditOf(id, 'leader_meeting.monthly_target_saved')).toEqual([]);
    });

    it('P18.97-T1 AC-10 an editor alone types one: the Owner, an Admin and a Core Leader yes; an untagged member 404, a read-only session 403, another office 404', async () => {
      const { id } = await make('Who types targets', '2026-10-07');
      const write = async (version: number) => http().put(`/leader-meetings/${id}/monthly-targets/case_submission`).send({ rate: 2, version });
      let version = 0;
      for (const who of ['OWNER', 'ADMIN', 'AGUS', 'SARI'] as const) {
        as(who);
        const res = await write(version);
        expect([who, res.status, res.body.version]).toEqual([who, 200, version + 1]);
        version += 1;
      }
      const stored = async () => (await db().collection('leaderMeetings').findOne({ _id: new mongoose.Types.ObjectId(id) }))!.monthlyTargets;
      const kept = await stored();
      for (const who of ['RINA', 'DEWI', 'PEER_AB'] as const) {
        as(who);
        const res = await write(version);
        expect([who, res.status, res.body.error.code]).toEqual([who, 404, 'NOT_FOUND']);
      }
      session.current = office.supported('OWNER');
      expect([(await write(version)).status]).toEqual([403]);
      session.current = office.ownerOfB();
      expect((await write(version)).body.error.code).toBe('NOT_FOUND');
      expect(await stored()).toEqual(kept);
    });
  });

  describe('P18.1-T2 AC-8 authored text is text', () => {
    it('P18.1-T2 AC-8 <b> and <script> in a title, an item, a PIC, a cell and a target are stored and served as typed', async () => {
      const bold = '<b>Bold</b>';
      const script = '<script>alert(1)</script>';
      as('OWNER');
      const meeting = (await http().post('/leader-meetings').send({ title: `${bold} ${script}`, date: '2026-10-06' }).expect(201)).body;
      expect(meeting.title).toBe(`${bold} ${script}`);
      const view = await read(meeting.id);
      const [item] = view.agenda.during;
      await http().patch(`/leader-meetings/${meeting.id}/agenda-items/${item.id}`).send({ text: script, version: 1 }).expect(200);
      await http().patch(`/leader-meetings/${meeting.id}/agenda-items/${item.id}`).send({ pic: bold, version: 2 }).expect(200);
      const row = (await http().post(`/leader-meetings/${meeting.id}/action-items`).expect(201)).body;
      await http().patch(`/leader-meetings/${meeting.id}/action-items/${row.id}`).send({ action: script, version: 1 }).expect(200);
      // A target is a number since P18.97-T1 (AC-10): markup is refused as any text is, and nothing is stored.
      expect((await http().put(`/leader-meetings/${meeting.id}/monthly-targets/ape`).send({ rate: bold, version: 0 }).expect(400)).body.error.code)
        .toBe('VALIDATION_FAILED');
      const after = await read(meeting.id);
      expect(after.title).toBe(`${bold} ${script}`);
      expect(after.agenda.during[0]).toMatchObject({ text: script, pic: bold });
      expect(after.actionItems[0].action).toBe(script);
      expect(after.scorecard.rows[0].monthlyTarget).toEqual({ rate: null, value: null, typed: null, version: 0 });
      const stored = await db().collection('leaderMeetings').findOne({ _id: new mongoose.Types.ObjectId(meeting.id) });
      expect([stored!.title, stored!.agenda.during[0].text, stored!.monthlyTargets ?? {}]).toEqual([`${bold} ${script}`, script, {}]);
    });
  });

  describe('P18.1-T3 AC-5 no lock (OD-147, ADR-0132)', () => {
    it('P18.1-T3 AC-5 a past meeting’s action item is edited, served and audited with before and after; lockedAt is no field', async () => {
      const past = await make('Past', '2026-09-01');
      as('OWNER');
      const row = (await http().post(`/leader-meetings/${past.id}/action-items`).expect(201)).body;
      const view = await read(past.id);
      expect([view.state, view.scorecard.frozenAt]).toEqual(['completed', expect.any(String)]);
      as('SARI');
      const saved = (await http().patch(`/leader-meetings/${past.id}/action-items/${row.id}`).send({ status: 'implemented', version: 1 }).expect(200)).body;
      expect(saved.status).toBe('implemented');
      await http().put(`/leader-meetings/${past.id}/monthly-targets/flc`).send({ rate: 1, version: 0 }).expect(200);
      const [entry] = await auditOf(past.id, 'leader_meeting.action_item_saved');
      expect(entry).toMatchObject({ before: { item: { status: 'not_planned' } }, after: { item: { status: 'implemented' } }, actorMembershipId: office.id.SARI });
      expect(LeaderMeetingSchema.path('lockedAt')).toBeUndefined();
      const stored = await db().collection('leaderMeetings').findOne({ _id: new mongoose.Types.ObjectId(past.id) });
      expect(Object.keys(stored!)).not.toEqual(expect.arrayContaining(['lockedAt']));
      for (const struck of ['attendees', 'notes', 'coeditorIds', 'lockedAt']) expect(LeaderMeetingSchema.path(struck)).toBeUndefined();
    });
  });

  it('P18.1-T2 AC-1 no forum route writes a §3.5 entry: the scorecard is figures over the office, the minutes the leaders’ own words', async () => {
    expect(await db().collection('auditLog').countDocuments({ action: SUBJECT_READ_ACTION })).toBe(readsBefore);
    const forum = { targetCollection: { $in: ['leaderMeetings', 'leaderMeetingShareLinks'] } };
    expect(await db().collection('auditLog').countDocuments(forum)).toBeGreaterThan(20);
    expect(await db().collection('auditLog').countDocuments({ ...forum, targetMembershipId: { $nin: [null, undefined] } })).toBe(0);
    expect(await db().collection('auditLog').countDocuments({ ...forum, onBehalfOf: true })).toBe(0);
  });
});
