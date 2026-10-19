import mongoose from 'mongoose';
import { FixedClock } from '@/common/clock/clock.port';
import { RequestContext } from '@/common/context/request-context';
import { clearCollections, startMongo, stopMongo, syncIndexes } from '../../../test/mongo';
import { configModule } from '../../../test/config-module';
import {
  buildCoachingOffice, KPM_A, ROSTER_NOW, type CoachingOffice, type Who,
} from '../../../test/coaching-office';
import { LEADER_NOTE_READ_ACTION, LEADER_NOTE_SAVED_ACTION, LEADER_NOTE_SURFACE } from './leader-note.service';
import { LeaderNoteSchema } from './leader-note.schema';

type Doc = Record<string, unknown>;

/**
 * **Leader notes** (P11-T9 AC-4, AC-5, AC-6, AC-7; ADR-0073; `functional/coaching.md`, *Who reads a
 * leader note*, *A note read writes its own entry*; `erd.md`, *`leaderNotes`*).
 *
 * The record, the audited read and the pinned save over `test/coaching-office.ts`'s office:
 *
 * ```
 * OWNER ── AGUS ─┬── INDAH, DIMAS
 *                └── SARI (AAB) ─┬── RINA, BUDI
 *                                └── NINA (AAB) ── DODI
 * ```
 *
 * A note is read by its author and by the author's ancestors on the current edges — never by the person
 * it is about, a leader who leads people included, and never sideways or downwards. The guard's 403s (an
 * Agent, the office roles as such, a support session) are `coaching-profile.int.spec.ts`'s, over HTTP.
 */
describe('leader notes (P11-T9)', () => {
  let wired: ReturnType<typeof configModule>;
  let office: CoachingOffice;
  let memberships: Doc[];

  const db = () => mongoose.connection.db!;
  const col = (name: string) => db().collection(name);
  const id = (who: Who) => office.id[who];
  const read = (reader: Who, subject: Who) => wired.leaderNotes.read(office.as(reader), id(subject));
  const write = (author: Who, subject: Who, text: string, version = 0) =>
    wired.leaderNotes.save(office.as(author), id(subject), { version, text });
  const reads = (filter: Doc = {}) => col('auditLog').find({ action: LEADER_NOTE_READ_ACTION, ...filter }).toArray();
  const saves = () => col('auditLog').find({ action: LEADER_NOTE_SAVED_ACTION }).toArray();

  /** Move a member under somebody else in the membership cache, as a re-parent leaves it. */
  async function move(who: Who, under: Who): Promise<void> {
    const leader = await col('memberships').findOne({ _id: new mongoose.Types.ObjectId(id(under)) });
    await col('memberships').updateOne(
      { _id: new mongoose.Types.ObjectId(id(who)) },
      { $set: { leaderId: id(under), ancestorIds: [...(leader!.ancestorIds as string[]), id(under)] } },
    );
  }

  beforeAll(async () => {
    await startMongo();
    wired = configModule(ROSTER_NOW);
    await clearCollections();
    office = await buildCoachingOffice(wired);
    await syncIndexes();
    memberships = await col('memberships').find().toArray();
  }, 120_000);
  afterAll(stopMongo);

  beforeEach(async () => {
    await col('leaderNotes').deleteMany({});
    await col('auditLog').deleteMany({});
    await col('memberships').deleteMany({});
    await col('memberships').insertMany(memberships);
    jest.restoreAllMocks();
  });

  describe('the record (erd.md)', () => {
    it('P11-T9 declares exactly the one-note-per-author-and-coachee index, and kpmId leads it', async () => {
      expect(LeaderNoteSchema.indexes()).toEqual([[
        { kpmId: 1, coacheeMembershipId: 1, authorMembershipId: 1 },
        expect.objectContaining({ unique: true, partialFilterExpression: { deletedAt: null } }),
      ]]);
      const built = (await col('leaderNotes').indexes()).filter((index) => index.name !== '_id_');
      expect(built.map((index) => Object.keys(index.key)[0])).toEqual(['kpmId']);
    });

    it('P11-T9 AC-4 one note per author and coachee at the database; a soft-deleted one does not count', async () => {
      const ctx = office.as('SARI');
      const row = { authorMembershipId: id('SARI'), coacheeMembershipId: id('RINA'), text: 'x' };
      const first = await wired.leaderNoteRows.create(ctx, row as never);
      await expect(wired.leaderNoteRows.create(ctx, row as never)).rejects.toMatchObject({ code: 11000 });
      // Another author's note about the same person is theirs.
      await expect(wired.leaderNoteRows.create(office.as('AGUS'), { ...row, authorMembershipId: id('AGUS') } as never))
        .resolves.toBeDefined();
      await wired.leaderNoteRows.softDeleteById(ctx, String(first._id), ROSTER_NOW);
      await expect(wired.leaderNoteRows.create(ctx, row as never)).resolves.toBeDefined();
    });

    it('P11-T9 another office reads none of this office’s notes, by any filter, and writes none', async () => {
      await write('SARI', 'RINA', 'Strong on first meetings.');
      const b = office.as('B_AB');
      expect(await wired.leaderNoteRows.find(b, {})).toEqual([]);
      expect(await wired.leaderNoteRows.findOne(b, { coacheeMembershipId: id('RINA') })).toBeNull();
      await expect(wired.leaderNotes.read(b, id('RINA'))).rejects.toMatchObject({ code: 'NOT_FOUND' });
      await expect(wired.leaderNotes.save(b, id('RINA'), { version: 0, text: 'x' })).rejects.toMatchObject({ code: 'NOT_FOUND' });
      expect(await col('leaderNotes').countDocuments({})).toBe(1);
      expect(await reads()).toEqual([]);
    });
  });

  describe('who reads a note (AC-5, ADR-0073)', () => {
    it('P11-T9 AC-5 its author reads it as their own, and no entry is written', async () => {
      const saved = await write('SARI', 'RINA', 'Strong on first meetings.');
      expect(await read('SARI', 'RINA')).toEqual({
        mine: { noteId: saved.noteId, text: 'Strong on first meetings.', version: 1, updatedAt: ROSTER_NOW.toISOString() },
        others: [],
      });
      expect(await reads()).toEqual([]);
    });

    it('P11-T9 AC-5 the author’s ancestors read it, read-only, named by its author', async () => {
      const saved = await write('SARI', 'RINA', 'Strong on first meetings.');
      for (const ancestor of ['AGUS', 'OWNER'] as const) {
        expect(await read(ancestor, 'RINA')).toEqual({
          mine: null,
          others: [{
            noteId: saved.noteId, author: { membershipId: id('SARI'), name: 'Sari Puspita' },
            text: 'Strong on first meetings.', updatedAt: ROSTER_NOW.toISOString(),
          }],
        });
      }
    });

    it('P11-T9 AC-5 a reader’s own note and the notes from below arrive apart, newest first', async () => {
      await write('NINA', 'DODI', 'Nina’s, first.');
      (wired.clock as FixedClock).set(new Date(ROSTER_NOW.getTime() + 60_000));
      try {
        await write('SARI', 'DODI', 'Sari’s, a minute later.');
        await write('AGUS', 'DODI', 'Agus’s own.');
      } finally {
        (wired.clock as FixedClock).set(ROSTER_NOW);
      }
      const view = await read('AGUS', 'DODI');
      expect(view.mine!.text).toBe('Agus’s own.');
      expect(view.others.map((n) => n.text)).toEqual(['Sari’s, a minute later.', 'Nina’s, first.']);
    });

    it('P11-T9 AC-5 the rule follows the author: the coachee’s own AAB never reads what the AB above wrote', async () => {
      await write('AGUS', 'RINA', 'Agus’s note.');
      await write('SARI', 'RINA', 'Sari’s note.');
      const sari = await read('SARI', 'RINA');
      expect(sari.mine!.text).toBe('Sari’s note.');
      expect(sari.others).toEqual([]);
      // A leader below the author reads nothing of theirs either, and has nothing else to read.
      await write('AGUS', 'DODI', 'Agus about Dodi.');
      expect(await read('NINA', 'DODI')).toEqual({ mine: null, others: [] });
    });

    it.each([
      ['RINA', 'RINA', 'the coachee'],
      ['SARI', 'SARI', 'a coachee who leads people of their own'],
      ['PEER_AB', 'RINA', 'a peer leader'],
      ['PEER_AAB', 'RINA', 'a peer AAB'],
      ['NINA', 'RINA', 'a leader beside the coachee'],
      ['ADMIN', 'RINA', 'the Admin, who stands above nobody'],
      ['B_AB', 'RINA', 'another office'],
    ] as [Who, Who, string][])('P11-T9 AC-5 %s about %s is not found (%s)', async (reader, subject) => {
      await write('AGUS', 'SARI', 'About Sari.');
      await write('SARI', 'RINA', 'About Rina.');
      await write('AGUS', 'RINA', 'Agus about Rina.');
      await expect(read(reader, subject)).rejects.toMatchObject({ code: 'NOT_FOUND', status: 404 });
      expect(await reads()).toEqual([]);
    });

    it('P11-T9 AC-5 never the coachee, even once they stand above the author', async () => {
      // As if Dodi had once coached Sari: Sari is now Dodi's ancestor, and the subject of his note.
      await col('leaderNotes').insertOne({
        kpmId: KPM_A, authorMembershipId: id('DODI'), coacheeMembershipId: id('SARI'), text: 'About Sari, by Dodi.',
        version: 1, revisions: [], deletedAt: null, createdAt: ROSTER_NOW, updatedAt: ROSTER_NOW,
      });
      await expect(read('SARI', 'SARI')).rejects.toMatchObject({ code: 'NOT_FOUND' });
      // Agus, above Dodi, does read it.
      expect((await read('AGUS', 'SARI')).others.map((n) => n.text)).toEqual(['About Sari, by Dodi.']);
    });

    it('P11-T9 AC-5 never the coachee under another membership: a person who left and rejoined is still them', async () => {
      // The Owner's account once held another membership here, which Agus wrote about before it ended.
      const owner = memberships.find((m) => String(m._id) === id('OWNER'))!;
      const old = new mongoose.Types.ObjectId();
      await col('memberships').insertOne({
        ...owner, _id: old, status: 'removed', leaderId: id('AGUS'), ancestorIds: [id('OWNER'), id('AGUS')], agentCode: 'OLD-1',
        leaderCode: 'OLDCODE1',
      });
      await col('leaderNotes').insertOne({
        kpmId: KPM_A, authorMembershipId: id('AGUS'), coacheeMembershipId: String(old), text: 'About the old membership.',
        version: 1, revisions: [], deletedAt: null, createdAt: ROSTER_NOW, updatedAt: ROSTER_NOW,
      });
      const asThePerson = new RequestContext(String(owner.userId), 'none', office.as('OWNER').membership);
      await expect(wired.leaderNotes.read(asThePerson, String(old))).rejects.toMatchObject({ code: 'NOT_FOUND' });
      // Anybody else standing where the Owner stands reads it as Agus's ancestor.
      expect((await wired.leaderNotes.read(office.as('OWNER'), String(old))).others).toHaveLength(1);
    });

    it('P11-T9 a current coach with nothing to read is answered both empty', async () => {
      expect(await read('AGUS', 'INDAH')).toEqual({ mine: null, others: [] });
      expect(await reads()).toEqual([]);
    });

    it('P11-T9 a coach whose edge has closed still reads what they wrote, and writes no more', async () => {
      await write('SARI', 'RINA', 'Before the move.');
      await move('RINA', 'PEER_AB');
      expect((await read('SARI', 'RINA')).mine!.text).toBe('Before the move.');
      await expect(write('SARI', 'RINA', 'After the move.', 1)).rejects.toMatchObject({ code: 'NOT_FOUND' });
      // Sari's leaders still read it, and the new leader, who coaches Rina now, does not.
      expect((await read('AGUS', 'RINA')).others.map((n) => n.text)).toEqual(['Before the move.']);
      expect(await read('PEER_AB', 'RINA')).toEqual({ mine: null, others: [] });
    });

    it('P11-T9 an author who can no longer be named is listed with an empty name', async () => {
      await write('NINA', 'DODI', 'Nina’s.');
      await col('memberships').updateOne(
        { _id: new mongoose.Types.ObjectId(id('NINA')) }, { $set: { userId: String(new mongoose.Types.ObjectId()) } },
      );
      expect((await read('SARI', 'DODI')).others[0].author).toEqual({ membershipId: id('NINA'), name: '' });
    });

    it('P11-T9 a caller with no membership is told so', async () => {
      const nobody = new RequestContext('u-new', 'none', null);
      await expect(wired.leaderNotes.read(nobody, id('RINA'))).rejects.toMatchObject({ code: 'TENANT_NO_MEMBERSHIP' });
      await expect(wired.leaderNotes.save(nobody, id('RINA'), { version: 0, text: '' }))
        .rejects.toMatchObject({ code: 'TENANT_NO_MEMBERSHIP' });
    });

    it('P11-T9 an id that is nobody’s, or not an id, is not found', async () => {
      await expect(wired.leaderNotes.read(office.as('AGUS'), 'not-an-id')).rejects.toMatchObject({ code: 'NOT_FOUND' });
      await expect(wired.leaderNotes.read(office.as('AGUS'), new mongoose.Types.ObjectId().toString()))
        .rejects.toMatchObject({ code: 'NOT_FOUND' });
    });
  });

  describe('every read by anyone but the author is audited (AC-6)', () => {
    it('P11-T9 AC-6 one leader_note.read per note somebody else wrote, never targeting the coachee', async () => {
      const sari = await write('SARI', 'DODI', 'Sari’s.');
      const nina = await write('NINA', 'DODI', 'Nina’s.');
      await write('AGUS', 'DODI', 'Agus’s own.');
      await read('AGUS', 'DODI');

      const entries = await reads();
      expect(entries).toHaveLength(2);
      expect(entries.map((e) => e.targetId).sort()).toEqual([sari.noteId, nina.noteId].sort());
      for (const entry of entries) {
        expect(entry).toMatchObject({
          kpmId: KPM_A, actorMembershipId: id('AGUS'), targetCollection: 'leaderNotes',
          targetMembershipId: null, onBehalfOf: false,
          after: { coacheeMembershipId: id('DODI'), surface: LEADER_NOTE_SURFACE },
        });
        expect([id('SARI'), id('NINA')]).toContain((entry.after as Doc).authorMembershipId);
        expect(JSON.stringify(entry)).not.toContain('’s');
      }
      // A view of the reads about Dodi — one query on that field — lists no note.
      expect(await col('auditLog').countDocuments({ targetMembershipId: id('DODI') })).toBe(0);
    });

    it('P11-T9 AC-6 a refused read writes nothing', async () => {
      await write('SARI', 'RINA', 'About Rina.');
      await expect(read('PEER_AB', 'RINA')).rejects.toBeDefined();
      await expect(read('RINA', 'RINA')).rejects.toBeDefined();
      expect(await reads()).toEqual([]);
    });

    it('P11-T9 AC-6 a read whose entry fails to write is still served (D-failopen)', async () => {
      await write('SARI', 'RINA', 'About Rina.');
      const model = (wired.audit as unknown as { model: { create: (...args: unknown[]) => Promise<unknown> } }).model;
      jest.spyOn(model, 'create').mockRejectedValueOnce(new Error('the audit store is down'));
      expect((await read('AGUS', 'RINA')).others).toHaveLength(1);
      expect(await reads()).toEqual([]);
    });
  });

  describe('the save (AC-4, AC-7)', () => {
    it('P11-T9 AC-4 a first note is version 1, its author’s, and its save is recorded without the text', async () => {
      const saved = await write('SARI', 'RINA', 'Pair her with a closer.');
      expect(saved).toEqual({ noteId: expect.any(String), version: 1, updatedAt: ROSTER_NOW.toISOString() });
      const row = (await col('leaderNotes').findOne({}))!;
      expect(row).toMatchObject({
        kpmId: KPM_A, authorMembershipId: id('SARI'), coacheeMembershipId: id('RINA'), text: 'Pair her with a closer.',
        version: 1, revisions: [], createdBy: id('SARI'), updatedBy: id('SARI'), deletedAt: null,
        createdAt: ROSTER_NOW, updatedAt: ROSTER_NOW,
      });

      const [entry] = await saves();
      expect(entry).toMatchObject({
        actorMembershipId: id('SARI'), targetCollection: 'leaderNotes', targetId: saved.noteId, targetMembershipId: null,
        after: { authorMembershipId: id('SARI'), coacheeMembershipId: id('RINA'), version: 1 },
      });
      expect(JSON.stringify(entry)).not.toContain('closer');
    });

    it('P11-T9 AC-4 every save keeps the text it replaced; blank is a save, not a delete', async () => {
      await write('SARI', 'RINA', 'First.');
      await col('leaderNotes').updateOne({}, { $set: { updatedAt: new Date('2026-09-07T04:00:00Z') } });
      await write('SARI', 'RINA', 'Second.', 1);
      const third = await write('SARI', 'RINA', '', 2);
      expect(third.version).toBe(3);

      const row = (await col('leaderNotes').findOne({}))!;
      expect(row).toMatchObject({ text: '', version: 3, deletedAt: null });
      expect(row.revisions).toEqual([
        { version: 1, text: 'First.', at: new Date('2026-09-07T04:00:00Z') },
        { version: 2, text: 'Second.', at: ROSTER_NOW },
      ]);
      expect((await read('SARI', 'RINA')).mine).toMatchObject({ text: '', version: 3 });
      expect(await saves()).toHaveLength(3);
    });

    it('P11-T9 AC-4 the text the note already has saves nothing: no version, no revision, no entry', async () => {
      const first = await write('SARI', 'RINA', 'Pair her with a closer.');
      await col('leaderNotes').updateOne({}, { $set: { updatedAt: new Date('2026-09-07T04:00:00Z') } });
      const before = (await col('leaderNotes').findOne({}))!;
      const update = jest.spyOn(wired.leaderNoteRows, 'updateIfAt');

      // The same text at the current version answers the note as it stands, and writes nothing.
      expect(await write('SARI', 'RINA', 'Pair her with a closer.', 1)).toEqual({
        noteId: first.noteId, version: 1, updatedAt: '2026-09-07T04:00:00.000Z',
      });
      expect(update).not.toHaveBeenCalled();
      expect(await col('leaderNotes').findOne({})).toEqual(before);
      expect(await saves()).toHaveLength(1);

      // The same text on a stale pin is still a conflict: the check for nothing-to-do comes after it.
      await expect(write('SARI', 'RINA', 'Pair her with a closer.', 0)).rejects.toMatchObject({
        code: 'VERSION_CONFLICT', details: { expectedVersion: 0, actualVersion: 1 },
      });

      // Identical means identical: whitespace is a change, and is saved as one.
      expect((await write('SARI', 'RINA', 'Pair her with a closer. ', 1)).version).toBe(2);
      expect(update).toHaveBeenCalledTimes(1);
      expect(await saves()).toHaveLength(2);
    });

    it('P11-T9 AC-4 two leaders each keep their own note about the same person', async () => {
      await write('SARI', 'RINA', 'Sari’s.');
      await write('AGUS', 'RINA', 'Agus’s.');
      expect(await col('leaderNotes').countDocuments({ coacheeMembershipId: id('RINA') })).toBe(2);
      expect((await read('AGUS', 'RINA')).mine!.text).toBe('Agus’s.');
    });

    it('P11-T9 a stale or a leading pin is VERSION_CONFLICT and saves nothing', async () => {
      await write('SARI', 'RINA', 'First.');
      await write('SARI', 'RINA', 'Second.', 1);
      await expect(write('SARI', 'RINA', 'Stale.', 1)).rejects.toMatchObject({
        code: 'VERSION_CONFLICT', details: { expectedVersion: 1, actualVersion: 2 },
      });
      await expect(write('SARI', 'RINA', 'A first note again.', 0)).rejects.toMatchObject({ code: 'VERSION_CONFLICT' });
      await expect(write('AGUS', 'INDAH', 'Ahead.', 4)).rejects.toMatchObject({
        code: 'VERSION_CONFLICT', details: { expectedVersion: 4, actualVersion: 0 },
      });
      expect((await col('leaderNotes').findOne({ coacheeMembershipId: id('RINA') }))!.text).toBe('Second.');
      expect(await saves()).toHaveLength(2);
    });

    it('P11-T9 a first save the database refuses as a duplicate is VERSION_CONFLICT; any other failure is not hidden', async () => {
      jest.spyOn(wired.leaderNoteRows, 'create').mockRejectedValueOnce(Object.assign(new Error('dup'), { code: 11000 }));
      await expect(write('SARI', 'RINA', 'x')).rejects.toMatchObject({
        code: 'VERSION_CONFLICT', details: { expectedVersion: 0, actualVersion: 0 },
      });
      jest.spyOn(wired.leaderNoteRows, 'create').mockRejectedValueOnce(new Error('the disk is full'));
      await expect(write('SARI', 'RINA', 'x')).rejects.toThrow('the disk is full');
      expect(await saves()).toEqual([]);
    });

    it('P11-T9 a pinned save that lost the race is VERSION_CONFLICT, read after the fact', async () => {
      await write('SARI', 'RINA', 'First.');
      jest.spyOn(wired.leaderNoteRows, 'updateIfAt').mockResolvedValueOnce(null);
      await expect(write('SARI', 'RINA', 'Second.', 1)).rejects.toMatchObject({
        code: 'VERSION_CONFLICT', details: { expectedVersion: 1, actualVersion: 1 },
      });
    });

    it.each([
      ['AGUS', 'AGUS', 'themselves'],
      ['RINA', 'RINA', 'the coachee, about themselves'],
      ['SARI', 'INDAH', 'somebody the author does not coach'],
      ['NINA', 'RINA', 'a peer’s person'],
      ['AGUS', 'LEFT', 'a member who has left'],
      ['B_AB', 'RINA', 'another office'],
    ] as [Who, Who, string][])('P11-T9 %s writing about %s is not found (%s)', async (author, subject) => {
      await expect(write(author, subject, 'x')).rejects.toMatchObject({ code: 'NOT_FOUND' });
      expect(await col('leaderNotes').countDocuments({})).toBe(0);
      expect(await saves()).toEqual([]);
    });
  });
});
