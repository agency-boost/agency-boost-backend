import { INestApplication } from '@nestjs/common';
import mongoose from 'mongoose';
import request from 'supertest';
import { clearCollections, startMongo, stopMongo } from '../../../test/mongo';
import { configModule } from '../../../test/config-module';
import { session } from '../../../test/http-permissions';
import { ROSTER_NOW } from '../../../test/coaching-office';
import { buildForumOffice, forumApp, type ForumOffice } from '../../../test/forum-office';
import type { ActionItem, MeetingView } from './leader-meeting.view';

/**
 * **The agenda and the action items, field by field, and what a write carries forward** (P19.22-T8 AC-3, AC-4;
 * ADR-0276; OD-417, OD-418) over HTTP with the real guard and pipe.
 *
 * - The agenda: *+ Tambah agenda*, a box ticked, a PIC (a member, *Semua* or none), a text emptied removes the line.
 * - The action items: *+ Tambah action item*, status *Belum · Proses · Selesai*, text, PIC and *tenggat*, the trash.
 * - **Carry-over**: #1 → #2 → #3. A write to #1's item reaches the copies in #2 and #3, that field only; a write to #2's
 *   copy never reaches #1; an item added to #1 appears in #2 and #3 *dari forum #1*; a status set back from *Selesai*
 *   carries it into a later forum that has no copy; the trash removes the later copies, never the earlier ones.
 */
describe('the forum’s agenda and action items (P19.22-T8)', () => {
  let app: INestApplication;
  let office: ForumOffice;
  const db = () => mongoose.connection.db!;
  const http = () => request(app.getHttpServer());
  const audits = (action: string) => db().collection('auditLog').find({ action }).toArray();
  const read = (id: string): Promise<MeetingView> => office.forum.read(office.as('OWNER'), id);
  const byLineage = (view: MeetingView, lineageId: string): ActionItem | undefined =>
    view.actionItems.find((i) => i.lineageId === lineageId);

  beforeAll(async () => {
    await startMongo();
    const wired = configModule(ROSTER_NOW);
    await clearCollections();
    office = await buildForumOffice(wired);
    app = await forumApp(office);
  }, 120_000);

  afterAll(async () => {
    await app.close();
    await stopMongo();
  });

  beforeEach(async () => {
    await db().collection('leaderMeetings').deleteMany({});
    session.current = office.as('OWNER');
  });

  describe('P19.22-T8 AC-3 the agenda: one checklist', () => {
    it('P19.22-T8 AC-3 + Tambah agenda: the line typed, its PIC, unticked, last; the forum is written in', async () => {
      const card = await office.forum.create(office.as('OWNER'), { date: '2026-09-28', time: '14:00' });
      const added = (await http().post(`/leader-meetings/${card.id}/agenda-items`)
        .send({ text: '  Rencana Closing Clinic Desember ', pic: office.id.SARI }).expect(201)).body;
      expect(added).toMatchObject({ text: 'Rencana Closing Clinic Desember', picMembershipId: office.id.SARI, picAll: false, done: false, version: 1 });
      const semua = (await http().post(`/leader-meetings/${card.id}/agenda-items`).send({ text: 'Update action items', pic: 'all' }).expect(201)).body;
      expect(semua).toMatchObject({ picMembershipId: null, picAll: true });
      const view = await read(card.id);
      expect(view.agenda.map((i) => i.text).slice(-2)).toEqual(['Rencana Closing Clinic Desember', 'Update action items']);
      expect(view.writtenIn).toBe(true);
      expect(view.people.find((p) => p.membershipId === office.id.SARI)).toMatchObject({ firstName: 'Sari', pickable: true });
    });

    it('P19.22-T8 AC-3 a box, a PIC (member → Semua → none) and a text: one field per write, each versioned and audited', async () => {
      const card = await office.forum.create(office.as('OWNER'), { date: '2026-09-28', time: '14:00' });
      const [line] = (await read(card.id)).agenda;
      const ticked = (await http().patch(`/leader-meetings/${card.id}/agenda-items/${line.id}`).send({ done: true, version: 1 }).expect(200)).body;
      expect([ticked.done, ticked.version]).toEqual([true, 2]);
      const pic = (await http().patch(`/leader-meetings/${card.id}/agenda-items/${line.id}`).send({ pic: office.id.AGUS, version: 2 }).expect(200)).body;
      expect([pic.picMembershipId, pic.picAll]).toEqual([office.id.AGUS, false]);
      const all = (await http().patch(`/leader-meetings/${card.id}/agenda-items/${line.id}`).send({ pic: 'all', version: 3 }).expect(200)).body;
      expect([all.picMembershipId, all.picAll]).toEqual([null, true]);
      const none = (await http().patch(`/leader-meetings/${card.id}/agenda-items/${line.id}`).send({ pic: null, version: 4 }).expect(200)).body;
      expect([none.picMembershipId, none.picAll]).toEqual([null, false]);
      const text = (await http().patch(`/leader-meetings/${card.id}/agenda-items/${line.id}`).send({ text: 'Review angka', version: 5 }).expect(200)).body;
      expect(text.text).toBe('Review angka');
      expect((await audits('leader_meeting.agenda_item_saved')).filter((a) => a.targetId === card.id)).toHaveLength(5);
    });

    it('P19.22-T8 AC-3 a text emptied removes the line, answered removed', async () => {
      const card = await office.forum.create(office.as('OWNER'), { date: '2026-09-28', time: '14:00' });
      const [line] = (await read(card.id)).agenda;
      expect((await http().patch(`/leader-meetings/${card.id}/agenda-items/${line.id}`).send({ text: '   ', version: 1 }).expect(200)).body)
        .toEqual({ removed: true });
      expect((await read(card.id)).agenda.map((i) => i.id)).not.toContain(line.id);
    });

    it.each<[Record<string, unknown>, string]>([
      [{ version: 1 }, 'no field'],
      [{ done: true, text: 'x', version: 1 }, 'two fields'],
      [{ done: 'yes', version: 1 }, 'a box that is not a boolean'],
      [{ pic: 'Wilson', version: 1 }, 'a PIC typed as a name'],
      [{ text: 'x'.repeat(501), version: 1 }, 'a text over 500'],
    ])('P19.22-T8 AC-3 validation: %j is 400 (%s)', async (body) => {
      const card = await office.forum.create(office.as('OWNER'), { date: '2026-09-28', time: '14:00' });
      const [line] = (await read(card.id)).agenda;
      expect((await http().patch(`/leader-meetings/${card.id}/agenda-items/${line.id}`).send(body).expect(400)).body.error.code)
        .toBe('VALIDATION_FAILED');
    });

    it('P19.22-T8 AC-3 OD-418 a PIC who is not one of the forum’s editors is 400; an empty line is 400', async () => {
      const card = await office.forum.create(office.as('OWNER'), { date: '2026-09-28', time: '14:00' });
      expect((await http().post(`/leader-meetings/${card.id}/agenda-items`).send({ text: 'x', pic: office.id.RINA }).expect(400)).body.error.code)
        .toBe('VALIDATION_FAILED');
      expect((await http().post(`/leader-meetings/${card.id}/agenda-items`).send({ text: '  ' }).expect(400)).body.error.code)
        .toBe('VALIDATION_FAILED');
    });

    it('P19.22-T8 AC-3 a stale version is 409 for that line alone; a line removed meanwhile is 409 with no version', async () => {
      const card = await office.forum.create(office.as('OWNER'), { date: '2026-09-28', time: '14:00' });
      const [a, b] = (await read(card.id)).agenda;
      await http().patch(`/leader-meetings/${card.id}/agenda-items/${a.id}`).send({ done: true, version: 1 }).expect(200);
      expect((await http().patch(`/leader-meetings/${card.id}/agenda-items/${a.id}`).send({ done: false, version: 1 }).expect(409)).body.error)
        .toMatchObject({ code: 'VERSION_CONFLICT' });
      await http().patch(`/leader-meetings/${card.id}/agenda-items/${b.id}`).send({ done: true, version: 1 }).expect(200);
      await http().patch(`/leader-meetings/${card.id}/agenda-items/${b.id}`).send({ text: '', version: 2 }).expect(200);
      expect((await http().patch(`/leader-meetings/${card.id}/agenda-items/${b.id}`).send({ done: false, version: 2 }).expect(409)).body.error.details)
        .toMatchObject({ actualVersion: null });
    });
  });

  describe('P19.22-T8 AC-4 the action items', () => {
    it('P19.22-T8 AC-4 + Tambah action item: Belum, its PIC and tenggat, last, its own lineage, raised here', async () => {
      const card = await office.forum.create(office.as('OWNER'), { date: '2026-09-28', time: '14:00' });
      const added = (await http().post(`/leader-meetings/${card.id}/action-items`)
        .send({ text: 'Siapkan Closing Clinic Desember', pic: office.id.SARI, dueOn: '2026-12-02' }).expect(201)).body;
      expect(added).toMatchObject({
        text: 'Siapkan Closing Clinic Desember', picMembershipId: office.id.SARI, dueOn: '2026-12-02', status: 'todo',
        fromNumber: null, version: 1,
      });
      expect(added.lineageId).toBe(added.id);
      const second = (await http().post(`/leader-meetings/${card.id}/action-items`).send({ text: 'Naikkan pemakaian' }).expect(201)).body;
      expect((await read(card.id)).actionItems.map((i) => i.id)).toEqual([added.id, second.id]);
    });

    it('P19.22-T8 AC-4 status Belum → Proses → Selesai, the text, the PIC and the tenggat: each one field, each versioned', async () => {
      const card = await office.forum.create(office.as('OWNER'), { date: '2026-09-28', time: '14:00' });
      const item = await office.minutes.addActionItem(office.as('OWNER'), card.id, { text: 'Aktifkan 3 agent' });
      const url = `/leader-meetings/${card.id}/action-items/${item.id}`;
      expect((await http().patch(url).send({ status: 'doing', version: 1 }).expect(200)).body.status).toBe('doing');
      expect((await http().patch(url).send({ status: 'done', version: 2 }).expect(200)).body.status).toBe('done');
      expect((await http().patch(url).send({ text: ' Aktifkan 4 agent ', version: 3 }).expect(200)).body.text).toBe('Aktifkan 4 agent');
      expect((await http().patch(url).send({ pic: office.id.AGUS, version: 4 }).expect(200)).body.picMembershipId).toBe(office.id.AGUS);
      expect((await http().patch(url).send({ dueOn: '2026-11-27', version: 5 }).expect(200)).body.dueOn).toBe('2026-11-27');
      expect((await http().patch(url).send({ dueOn: null, version: 6 }).expect(200)).body).toMatchObject({ dueOn: null, version: 7 });
      expect((await http().get(`/leader-meetings`).expect(200)).body.meetings[0].actionProgress).toEqual({ done: 1, total: 1 });
    });

    it.each<[Record<string, unknown>, string]>([
      [{ status: 'implemented', version: 1 }, 'a state of before P19.22'],
      [{ text: '', version: 1 }, 'an empty text: the trash removes an item'],
      [{ dueOn: '2026-13-01', version: 1 }, 'a tenggat that is not a day'],
      [{ pic: 'all', version: 1 }, 'Semua, which is an agenda line’s alone'],
      [{ status: 'done', text: 'x', version: 1 }, 'two fields'],
    ])('P19.22-T8 AC-4 validation: %j is 400 (%s)', async (body) => {
      const card = await office.forum.create(office.as('OWNER'), { date: '2026-09-28', time: '14:00' });
      const item = await office.minutes.addActionItem(office.as('OWNER'), card.id, { text: 'Aktifkan 3 agent' });
      expect((await http().patch(`/leader-meetings/${card.id}/action-items/${item.id}`).send(body).expect(400)).body.error.code)
        .toBe('VALIDATION_FAILED');
    });

    it('P19.22-T8 AC-4 OD-418 a PIC not an editor is 400; a stale version is 409; a delete at a stale version is 409', async () => {
      const card = await office.forum.create(office.as('OWNER'), { date: '2026-09-28', time: '14:00' });
      expect((await http().post(`/leader-meetings/${card.id}/action-items`).send({ text: 'x', pic: office.id.DEWI }).expect(400)).body.error.code)
        .toBe('VALIDATION_FAILED');
      const item = await office.minutes.addActionItem(office.as('OWNER'), card.id, { text: 'Aktifkan 3 agent' });
      await http().patch(`/leader-meetings/${card.id}/action-items/${item.id}`).send({ status: 'doing', version: 1 }).expect(200);
      expect((await http().patch(`/leader-meetings/${card.id}/action-items/${item.id}`).send({ status: 'done', version: 1 }).expect(409)).body.error.code)
        .toBe('VERSION_CONFLICT');
      expect((await http().delete(`/leader-meetings/${card.id}/action-items/${item.id}`).query({ version: 1 }).expect(409)).body.error.code)
        .toBe('VERSION_CONFLICT');
    });
  });

  describe('P19.22-T8 AC-4 OD-417 carry-over: #1 → #2 → #3', () => {
    /** #1 with one open item, then #2 and #3 made after it, each carrying it. */
    const chain = async () => {
      const owner = office.as('OWNER');
      const one = await office.forum.create(owner, { date: '2026-08-31', time: '14:00' });
      const item = await office.minutes.addActionItem(owner, one.id, { text: 'Aktifkan 3 agent', pic: office.id.AGUS, dueOn: '2026-09-20' });
      const two = await office.forum.create(owner, { date: '2026-09-14', time: '14:00' });
      const three = await office.forum.create(owner, { date: '2026-09-28', time: '14:00' });
      return { one, two, three, item };
    };

    it.each([
      ['status', { status: 'doing' }, (i: ActionItem) => i.status, 'doing'],
      ['text', { text: 'Aktifkan 5 agent' }, (i: ActionItem) => i.text, 'Aktifkan 5 agent'],
      ['PIC', { pic: 'SARI' }, (i: ActionItem) => i.picMembershipId, 'SARI'],
      ['tenggat', { dueOn: '2026-10-01' }, (i: ActionItem) => i.dueOn, '2026-10-01'],
    ] as const)('P19.22-T8 AC-4 a %s written in #1 reaches the copies in #2 and #3, that field only', async (_, body, pick, expected) => {
      const { one, two, three, item } = await chain();
      const sent = 'pic' in body ? { pic: office.id.SARI } : body;
      const want = expected === 'SARI' ? office.id.SARI : expected;
      const beforeTwo = byLineage(await read(two.id), item.lineageId)!;
      await http().patch(`/leader-meetings/${one.id}/action-items/${item.id}`).send({ ...sent, version: 1 }).expect(200);
      for (const id of [two.id, three.id]) {
        const copy = byLineage(await read(id), item.lineageId)!;
        expect(pick(copy)).toBe(want);
        expect(copy.fromNumber).toBe(1);
        expect(copy.version).toBe(2);
      }
      // Every other field of the copy is as it was.
      const afterTwo = byLineage(await read(two.id), item.lineageId)!;
      const others = (i: ActionItem) => ({ text: i.text, pic: i.picMembershipId, dueOn: i.dueOn, status: i.status });
      const changed = Object.entries(others(afterTwo)).filter(([k, v]) => others(beforeTwo)[k as keyof ReturnType<typeof others>] !== v);
      expect(changed).toHaveLength(1);
      const [audit] = (await audits('leader_meeting.action_item_saved')).filter((a) => a.targetId === one.id);
      expect(audit.after.syncedForums).toBe(2);
    });

    it('P19.22-T8 AC-4 a write in a later forum never reaches an earlier one', async () => {
      const { one, two, three, item } = await chain();
      const copy = byLineage(await read(two.id), item.lineageId)!;
      await http().patch(`/leader-meetings/${two.id}/action-items/${copy.id}`).send({ status: 'done', version: 1 }).expect(200);
      expect(byLineage(await read(one.id), item.lineageId)!.status).toBe('todo');
      expect(byLineage(await read(three.id), item.lineageId)!.status).toBe('done');
    });

    it('P19.22-T8 AC-4 an item added to #1 after #2 and #3 were made is carried into both, dari forum #1, Belum', async () => {
      const { one, two, three } = await chain();
      const late = (await http().post(`/leader-meetings/${one.id}/action-items`).send({ text: 'Naikkan pemakaian ke 80%' }).expect(201)).body;
      for (const id of [two.id, three.id]) {
        expect(byLineage(await read(id), late.lineageId)).toMatchObject({ text: 'Naikkan pemakaian ke 80%', status: 'todo', fromNumber: 1 });
      }
      const [audit] = (await audits('leader_meeting.action_item_added')).filter((a) => a.after.item.id === late.id);
      expect(audit.after.carriedTo).toBe(2);
    });

    it('P19.22-T8 AC-4 an item Selesai when #2 was made is not carried; set back to Proses in #1, it is', async () => {
      const owner = office.as('OWNER');
      const one = await office.forum.create(owner, { date: '2026-08-31', time: '14:00' });
      const item = await office.minutes.addActionItem(owner, one.id, { text: 'Closing clinic' });
      await office.minutes.saveActionItem(owner, one.id, item.id, { status: 'done', version: 1 });
      const two = await office.forum.create(owner, { date: '2026-09-14', time: '14:00' });
      expect(byLineage(await read(two.id), item.lineageId)).toBeUndefined();
      await http().patch(`/leader-meetings/${one.id}/action-items/${item.id}`).send({ status: 'doing', version: 2 }).expect(200);
      expect(byLineage(await read(two.id), item.lineageId)).toMatchObject({ status: 'doing', fromNumber: 1 });
    });

    it('P19.22-T8 AC-4 the trash removes the item and its copies in later forums, never an earlier forum’s', async () => {
      const { one, two, three, item } = await chain();
      const copy = byLineage(await read(two.id), item.lineageId)!;
      await http().delete(`/leader-meetings/${two.id}/action-items/${copy.id}`).query({ version: 1 }).expect(204);
      expect(byLineage(await read(two.id), item.lineageId)).toBeUndefined();
      expect(byLineage(await read(three.id), item.lineageId)).toBeUndefined();
      expect(byLineage(await read(one.id), item.lineageId)).toBeDefined();
      const [audit] = (await audits('leader_meeting.action_item_removed')).filter((a) => a.targetId === two.id);
      expect(audit.after).toEqual({ removedFromLaterForums: 1 });
      expect(audit.before.item.text).toBe('Aktifkan 3 agent');
    });

    it('P19.22-T8 AC-4 a forum deleted is not written to by the sync; a carried copy does not make a forum written in', async () => {
      const { one, two, three, item } = await chain();
      expect((await read(three.id)).writtenIn).toBe(false);
      await office.forum.remove(office.as('OWNER'), three.id, 1);
      await http().patch(`/leader-meetings/${one.id}/action-items/${item.id}`).send({ status: 'doing', version: 1 }).expect(200);
      const gone = await db().collection('leaderMeetings').findOne({ _id: new mongoose.Types.ObjectId(three.id) });
      expect(gone!.actionItems[0].status).toBe('todo');
      expect(byLineage(await read(two.id), item.lineageId)!.status).toBe('doing');
    });
  });
});
