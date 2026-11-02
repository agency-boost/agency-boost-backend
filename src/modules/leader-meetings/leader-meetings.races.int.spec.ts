import mongoose from 'mongoose';
import { clearCollections, startMongo, stopMongo } from '../../../test/mongo';
import { configModule } from '../../../test/config-module';
import { ROSTER_NOW } from '../../../test/coaching-office';
import { buildForumOffice, KPM_B, type ForumOffice } from '../../../test/forum-office';
import type { LeaderMeetingRepository } from './leader-meeting.repository';
import type { LeaderMeetingShareLinkRepository } from './leader-meeting-share-link.repository';

type Writes = LeaderMeetingRepository;

/**
 * **What another leader does while a write is on its way** (P18.1-T2 AC-2, AC-7; P18.1-T3 AC-1): every write reads the
 * meeting, then writes it in one conditional update — and between the two somebody else may delete the meeting, take
 * its number, or revoke the link. Each case is staged by letting the other leader's write land just before ours, at
 * the repository, and the answer is what a reader would be told: the meeting's 404 once it is gone, a 409 for a write
 * that met a newer one, and never a second audit row for one act.
 */
describe('the forum’s writes when another leader’s lands first (P18.1-T2 AC-7)', () => {
  let wired: ReturnType<typeof configModule>;
  let office: ForumOffice;
  const db = () => mongoose.connection.db!;
  const owner = () => office.as('OWNER');
  const make = async (title: string, date = '2026-10-01') => office.forum.create(owner(), { title, date });
  /** Another Admin deletes the meeting through the repository, as their *Delete meeting* does. */
  const deleted = (id: string) => office.meetings.softDeleteById(office.as('ADMIN'), id, new Date());

  /** Let `before` land just ahead of the next call to `method`, then run the call as it was. */
  function first<K extends keyof Writes>(method: K, before: () => Promise<unknown>) {
    const original = (office.meetings[method] as (...args: unknown[]) => Promise<unknown>).bind(office.meetings);
    return jest.spyOn(office.meetings, method).mockImplementationOnce((async (...args: unknown[]) => {
      await before();
      return original(...args);
    }) as never);
  }

  beforeAll(async () => {
    await startMongo();
    wired = configModule(ROSTER_NOW);
    await clearCollections();
    office = await buildForumOffice(wired);
  }, 120_000);

  afterAll(stopMongo);
  afterEach(() => jest.restoreAllMocks());

  describe('the meeting deleted between the read and the write: its 404, nothing written', () => {
    it('P18.1-T2 AC-7 + Add item and + Add action item', async () => {
      const { id } = await make('Agenda gone');
      first('pushAgendaItem', () => deleted(id));
      await expect(office.minutes.addAgendaItem(owner(), id, 'post')).rejects.toMatchObject({ code: 'NOT_FOUND' });
      const { id: other } = await make('Tracker gone');
      first('pushActionItem', () => deleted(other));
      await expect(office.minutes.addActionItem(owner(), other)).rejects.toMatchObject({ code: 'NOT_FOUND' });
      expect(await db().collection('auditLog').countDocuments({ targetId: { $in: [id, other] }, action: { $regex: '_added$' } })).toBe(0);
    });

    it('P18.1-T2 AC-7 a cell of a row, the order and a Monthly Target', async () => {
      const { id } = await make('Cells gone');
      const row = await office.minutes.addActionItem(owner(), id);
      first('updateActionItem', () => deleted(id));
      await expect(office.minutes.saveActionItem(owner(), id, row.id, { pic: 'Sari', version: 1 })).rejects.toMatchObject({ code: 'NOT_FOUND' });

      const { id: ordered } = await make('Order gone');
      const rows = [await office.minutes.addActionItem(owner(), ordered), await office.minutes.addActionItem(owner(), ordered)];
      first('reorderActionItems', () => deleted(ordered));
      await expect(office.minutes.reorderActionItems(owner(), ordered, rows.map((r) => r.id).reverse())).rejects.toMatchObject({ code: 'NOT_FOUND' });

      const { id: targeted } = await make('Target gone');
      first('setMonthlyTarget', () => deleted(targeted));
      await expect(office.minutes.saveMonthlyTarget(owner(), targeted, 'flc', { rate: 1, version: 0 })).rejects.toMatchObject({ code: 'NOT_FOUND' });
    });

    it('P18.1-T2 AC-7 a move, and a second delete at once', async () => {
      const { id } = await make('Moved away');
      first('updateHead', () => deleted(id));
      await expect(office.forum.reschedule(owner(), id, { title: 'Moved', version: 1 })).rejects.toMatchObject({ code: 'NOT_FOUND' });

      const { id: twice } = await make('Deleted twice');
      first('deleteUnwritten', () => deleted(twice));
      await expect(office.forum.remove(owner(), twice, 1)).rejects.toMatchObject({ code: 'NOT_FOUND' });
      expect(await db().collection('auditLog').countDocuments({ targetId: twice, action: 'leader_meeting.deleted' })).toBe(0);
    });

    it('P18.1-T2 AC-4 the first read after its date, the meeting deleted before the freeze lands: its 404, no freeze', async () => {
      const { id } = await make('Frozen gone', '2026-09-01');
      first('freeze', () => deleted(id));
      await expect(office.forum.read(owner(), id)).rejects.toMatchObject({ code: 'NOT_FOUND' });
      expect(await db().collection('auditLog').countDocuments({ targetId: id, action: 'leader_meeting.frozen' })).toBe(0);
    });
  });

  describe('P18.1-T2 AC-7, ADR-0130 §5 Delete meeting landing just after a first write: refused, the minutes kept', () => {
    it.each([
      ['an agenda item added', 'pushAgendaItem', (id: string) => office.minutes.addAgendaItem(owner(), id, 'post')],
      ['an action item added', 'pushActionItem', (id: string) => office.minutes.addActionItem(owner(), id)],
      ['a Monthly Target typed', 'setMonthlyTarget', (id: string) => office.minutes.saveMonthlyTarget(owner(), id, 'ape', { rate: null, version: 0 })],
    ] as const)('P18.1-T2 AC-7 %s, then another Admin’s delete: LEADER_MEETING_HAS_MINUTES', async (_name, method, write) => {
      const { id } = await make('First write');
      const original = (office.meetings[method] as (...args: unknown[]) => Promise<unknown>).bind(office.meetings);
      let refused: unknown = null;
      jest.spyOn(office.meetings, method).mockImplementationOnce((async (...args: unknown[]) => {
        const landed = await original(...args);
        // Maya's *Delete meeting*, from a dialog opened before anybody wrote, lands right after this write.
        refused = await office.forum.remove(office.as('ADMIN'), id, 1).catch((err: unknown) => err);
        return landed;
      }) as never);
      await write(id);
      expect(refused).toMatchObject({ code: 'LEADER_MEETING_HAS_MINUTES' });
      expect(await office.meetings.findById(owner(), id)).toMatchObject({ writtenAt: expect.any(Date) });
      expect(await db().collection('auditLog').countDocuments({ targetId: id, action: 'leader_meeting.deleted' })).toBe(0);
    });
  });

  describe('a write that met a newer one: 409 for that item alone', () => {
    it('P18.1-T2 AC-5, AC-7 an item emptied with a version somebody moved past is a conflict, not a removal', async () => {
      const { id } = await make('Emptied late');
      const [item] = (await office.forum.read(owner(), id)).agenda.during;
      await office.minutes.saveAgendaItem(office.as('AGUS'), id, item.id, { pic: 'Agus', version: 1 });
      await expect(office.minutes.saveAgendaItem(owner(), id, item.id, { text: ' ', version: 1 }))
        .rejects.toMatchObject({ code: 'VERSION_CONFLICT', details: { expectedVersion: 1, actualVersion: 2 } });
      expect((await office.forum.read(owner(), id)).agenda.during[0]).toMatchObject({ id: item.id, pic: 'Agus' });
    });

    it('P18.1-T2 AC-6, AC-7 a row saved with a stale version, and a row that is not the meeting’s', async () => {
      const { id } = await make('Rows');
      const row = await office.minutes.addActionItem(owner(), id);
      await office.minutes.saveActionItem(office.as('SARI'), id, row.id, { status: 'planned', version: 1 });
      await expect(office.minutes.saveActionItem(owner(), id, row.id, { remarks: 'Late', version: 1 }))
        .rejects.toMatchObject({ code: 'VERSION_CONFLICT', details: { expectedVersion: 1, actualVersion: 2 } });
      await expect(office.minutes.saveActionItem(owner(), id, String(new mongoose.Types.ObjectId()), { remarks: 'x', version: 1 }))
        .rejects.toMatchObject({ code: 'VERSION_CONFLICT', details: { actualVersion: null } });
    });

    it('P18.1-T2 AC-4, AC-7 a Monthly Target sent at a version the cell never reached: its version is 0', async () => {
      const { id } = await make('Target');
      await expect(office.minutes.saveMonthlyTarget(owner(), id, 'case_submission', { rate: 2, version: 3 }))
        .rejects.toMatchObject({ code: 'VERSION_CONFLICT', details: { expectedVersion: 3, actualVersion: 0 } });
    });
  });

  it('P18.1-T2 AC-2 numbering gives up after three collisions rather than looping: 409, the dialog’s "try again"', async () => {
    const { id, number } = await make('Taken');
    jest.spyOn(office.meetings, 'highestNumber').mockResolvedValue(number - 1);
    await expect(office.forum.create(owner(), { title: 'Same number', date: '2026-10-02' }))
      .rejects.toMatchObject({ code: 'VERSION_CONFLICT', status: 409, details: { number } });
    expect(office.meetings.highestNumber).toHaveBeenCalledTimes(3);
    expect(await db().collection('leaderMeetings').countDocuments({ number, deletedAt: null, kpmId: owner().kpmId })).toBe(1);
    expect(id).toBeTruthy();
  });

  it('P18.1-T2 AC-2 a failure that is not a number taken is not retried: it is the request’s failure', async () => {
    const lost = new Error('connection reset');
    jest.spyOn(office.meetings, 'create').mockRejectedValueOnce(lost);
    const numbered = jest.spyOn(office.meetings, 'highestNumber');
    await expect(office.forum.create(owner(), { title: 'Lost', date: '2026-10-02' })).rejects.toBe(lost);
    expect(numbered).toHaveBeenCalledTimes(1);
  });

  it('P18.1-T3 AC-1 Stop sharing while another leader’s lands first: each link revoked once, by whoever got it, one audit row each', async () => {
    const { id } = await make('Shared twice');
    await office.sharing.create(owner(), id);
    await office.sharing.create(owner(), id);
    const links = office.links as LeaderMeetingShareLinkRepository;
    const original = links.liveFor.bind(links);
    jest.spyOn(links, 'liveFor').mockImplementationOnce(async (...args) => {
      const live = await original(...args);
      // Agus's *Stop sharing* revokes the first of them a moment before ours reaches it.
      await links.revoke(office.as('AGUS'), String(live[0]._id), new Date());
      return live;
    });
    expect(await office.sharing.revokeAll(owner(), id)).toEqual({ revoked: 1 });
    const rows = await db().collection('leaderMeetingShareLinks').find({ meetingId: id }).toArray();
    expect(rows.map((r) => r.revokedBy).sort()).toEqual([office.id.AGUS, office.id.OWNER].sort());
    expect(await db().collection('auditLog').countDocuments({ action: 'leader_meeting_share_link.revoked', 'before.meetingId': id })).toBe(1);
  });

  it('P18.1-T2 AC-3 an office with no Owner assigned: no Owner among the editors, none in the access note', async () => {
    const b = office.ownerOfB();
    const { id } = await office.forum.create(b, { title: '0555, unowned', date: '2026-10-05' });
    await db().collection('kpms').updateOne({ _id: new mongoose.Types.ObjectId(KPM_B) }, { $set: { ownerUserId: null } });
    try {
      const view = await office.forum.read(b, id);
      expect([view.editors.owner, view.accessNote.ownerName]).toEqual([null, null]);
    } finally {
      await db().collection('kpms').updateOne({ _id: new mongoose.Types.ObjectId(KPM_B) }, { $set: { ownerUserId: await office.userIdOf('B_AB') } });
    }
  });
});
