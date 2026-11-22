import mongoose from 'mongoose';
import { startMongo, stopMongo } from '../../test/mongo';
import { down, FORUM_RESHAPE_ACTOR, matcherOf, up } from './0076-forum-one-agenda-and-carried-items';

const KPM_A = '66f0000000000000000000a1';
const KPM_B = '66f0000000000000000000b1';
const NOW = new Date('2026-11-20T03:00:00Z');

/**
 * **ADR-0276 for the forums that came before** (P19.22-T8 AC-3, AC-4; OD-418): the three agenda sections become one
 * checklist in their order, the rows the new action items — text, state mapped, PIC matched to a member, own lineage —
 * nothing lost (`legacyMinutes`), every forum logged; a second run writes nothing; `down` puts it back.
 */
describe('0076 — the forum’s one agenda and its action items (ADR-0276)', () => {
  const db = () => mongoose.connection.db as mongoose.mongo.Db;
  const oid = () => new mongoose.Types.ObjectId();
  const line = (itemId: string, text: string, pic: string, done = false) => ({ itemId, text, pic, done, version: 2 });
  const row = (itemId: string, over: Record<string, unknown>) => ({
    itemId, initiative: '', metric: '', action: '', pic: '', status: 'not_planned', remarks: '', order: 0, version: 1, ...over,
  });

  beforeAll(startMongo);
  afterAll(stopMongo);
  beforeEach(async () => {
    for (const { name } of await db().listCollections({}, { nameOnly: true }).toArray()) await db().collection(name).drop();
  });

  /** 0417's people: Wilson Tanoto (the Owner), Agus Salim and Agus Prasetyo (two Agus), Sari Puspita ("Puspita"). */
  const people = async () => {
    const add = async (kpmId: string, fullName: string, preferredName: string | null, status = 'active') => {
      const userId = oid();
      const membershipId = oid();
      await db().collection('users').insertOne({ _id: userId, fullName, preferredName });
      await db().collection('memberships').insertOne({ _id: membershipId, kpmId, userId: String(userId), status, deletedAt: null });
      return String(membershipId);
    };
    return {
      wilson: await add(KPM_A, 'Wilson Tanoto', 'Wilson'),
      agusS: await add(KPM_A, 'Agus Salim', null),
      agusP: await add(KPM_A, 'Agus Prasetyo', null),
      sari: await add(KPM_A, 'Sari Puspita', 'Puspita'),
      gone: await add(KPM_A, 'Hendra Gunawan', null, 'removed'),
      other: await add(KPM_B, 'Maya Halim', null),
    };
  };

  it('P19.22-T8 AC-3, AC-4 flattens the agenda in order, maps the rows and their states, matches PICs, keeps the old minutes', async () => {
    const who = await people();
    const id = oid();
    await db().collection('leaderMeetings').insertOne({
      _id: id, kpmId: KPM_A, number: 13, title: 'Strategic Check-in — #13', date: '2026-10-30', deletedAt: null,
      agenda: {
        preparation: [line('p1', 'Siapkan data', 'Wilson'), line('p2', 'Kumpulkan follow-up', 'puspita')],
        during: [line('d1', 'Review', 'Semua', true), line('d2', 'Prioritas', 'Agus')],
        post: [line('q1', 'Catat hasil', 'Hendra Gunawan'), line('q2', 'Masukan', 'Maya Halim')],
      },
      actionItems: [
        row('r2', { action: '', initiative: 'Rekrut Q4', order: 1, status: 'planned', pic: 'agus salim' }),
        row('r1', { action: 'Aktifkan 3 agent', initiative: 'Aktivasi', order: 0, status: 'implemented', pic: 'TBD' }),
        row('r3', { metric: 'NPS 60', order: 2, version: 4 }),
      ],
    });
    const result = await up(db(), NOW);
    const forum = (await db().collection('leaderMeetings').findOne({ _id: id }))!;
    expect(forum.agenda).toBeUndefined();
    expect(forum.time).toBeNull();
    expect(forum.agendaItems.map((i: Record<string, unknown>) => [i.itemId, i.text, i.picMembershipId, i.picAll, i.done, i.version])).toEqual([
      ['p1', 'Siapkan data', who.wilson, false, false, 2],
      ['p2', 'Kumpulkan follow-up', who.sari, false, false, 2],
      ['d1', 'Review', null, true, true, 2],
      // Two Agus: no guess. A removed member and another office's person match nobody.
      ['d2', 'Prioritas', null, false, false, 2],
      ['q1', 'Catat hasil', null, false, false, 2],
      ['q2', 'Masukan', null, false, false, 2],
    ]);
    expect(forum.actionItems.map((i: Record<string, unknown>) => [i.itemId, i.lineageId, i.text, i.status, i.picMembershipId, i.dueOn, i.fromNumber, i.order, i.version])).toEqual([
      ['r1', 'r1', 'Aktifkan 3 agent', 'done', null, null, null, 0, 1],
      ['r2', 'r2', 'Rekrut Q4', 'doing', who.agusS, null, null, 1, 1],
      ['r3', 'r3', 'NPS 60', 'todo', null, null, null, 2, 4],
    ]);
    expect(forum.legacyMinutes.agenda.during[0].pic).toBe('Semua');
    expect(forum.legacyMinutes.actionItems).toHaveLength(3);
    expect(result).toEqual({ forums: 1, picsMatched: 3, picsDropped: 3, picsAll: 1 });
    const audit = await db().collection('auditLog').find({ action: 'leader_meeting.reshaped' }).toArray();
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({ kpmId: KPM_A, actorUserId: FORUM_RESHAPE_ACTOR, targetId: String(id) });
  });

  it('P19.22-T8 a second run writes nothing; a forum already in the new shape is left alone; down puts the old back', async () => {
    await people();
    const old = oid();
    const fresh = oid();
    await db().collection('leaderMeetings').insertMany([
      { _id: old, kpmId: KPM_A, number: 1, date: '2026-10-01', deletedAt: null,
        agenda: { preparation: [line('p1', 'x', '')], during: [], post: [] }, actionItems: [row('r1', { action: 'y' })] },
      { _id: fresh, kpmId: KPM_A, number: 2, date: '2026-11-01', time: '14:00', deletedAt: null, agendaItems: [], actionItems: [] },
    ]);
    expect((await up(db(), NOW)).forums).toBe(1);
    expect(await up(db(), NOW)).toEqual({ forums: 0, picsMatched: 0, picsDropped: 0, picsAll: 0 });
    expect((await db().collection('leaderMeetings').findOne({ _id: fresh }))!.time).toBe('14:00');
    expect(await down(db())).toEqual({ forums: 1 });
    const back = (await db().collection('leaderMeetings').findOne({ _id: old }))!;
    expect(back.agenda.preparation[0].text).toBe('x');
    expect(back.actionItems[0].action).toBe('y');
    expect([back.agendaItems, back.legacyMinutes, back.time]).toEqual([undefined, undefined, undefined]);
  });

  it('P19.22-T8 on an empty database it reads nothing and creates no collection', async () => {
    expect(await up(db(), NOW)).toEqual({ forums: 0, picsMatched: 0, picsDropped: 0, picsAll: 0 });
    expect(await db().listCollections({ name: 'leaderMeetings' }).toArray()).toEqual([]);
    expect(await down(db())).toEqual({ forums: 0 });
  });

  it('P19.22-T8 OD-418 a typed PIC matches one person by full, preferred or unique first name — never two, never a guess', () => {
    const match = matcherOf([
      { membershipId: 'w', fullName: 'Wilson Tanoto', preferredName: null },
      { membershipId: 'a1', fullName: 'Agus Salim', preferredName: 'Gus' },
      { membershipId: 'a2', fullName: 'Agus Prasetyo', preferredName: null },
    ]);
    expect([match(' wilson  tanoto '), match('Wilson'), match('gus'), match('Agus'), match(''), match(null), match('Nobody')])
      .toEqual(['w', 'w', 'a1', null, null, null, null]);
  });
});
