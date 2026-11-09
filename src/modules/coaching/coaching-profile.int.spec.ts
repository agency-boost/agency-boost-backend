import { INestApplication } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { Test } from '@nestjs/testing';
import mongoose from 'mongoose';
import request from 'supertest';
import { PermissionsGuard } from '@/common/auth/permissions.guard';
import { RequestContext } from '@/common/context/request-context';
import { DomainExceptionFilter } from '@/common/errors/error.filter';
import { startMongo, stopMongo, syncIndexes } from '../../../test/mongo';
import { configModule } from '../../../test/config-module';
import {
  ADMIN, declaredPermissions, NO_CLASS, OWNER, productionPipe, session, StubAuth, SUPER_ADMIN,
} from '../../../test/http-permissions';
import { listenOnLoopback } from '../../../test/listen';
import {
  buildCoachingOffice, KPM_A, ROSTER_NOW, type CoachingOffice, type Who,
} from '../../../test/coaching-office';
import { CoachingProfileController } from './coaching-profile.controller';
import { NOTE_LIMITS } from './coaching-profile.dto';
import { CoachingProfileService } from './coaching-profile.service';
import { LEADER_NOTE_READ_ACTION, LEADER_NOTE_SAVED_ACTION, LeaderNoteService } from './leader-note.service';

type Doc = Record<string, unknown>;

/** Three notes, each a phrase no other payload could hold by accident. */
const NOTE = {
  sariOnRina: 'SARI-ON-RINA: strong on first meetings, loses momentum after the illustration.',
  agusOnRina: 'AGUS-ON-RINA: talk to Sari about pairing her with a closer.',
  agusOnSari: 'AGUS-ON-SARI: ready to lead a second unit; watch her coaching cadence.',
} as const;

/**
 * **The Leader Notes tab over HTTP, per role** (P11-T9 AC-1 to AC-9; ADR-0073, ADR-0090; roles §7.2's
 * `coachee_cannot_read_leader_notes`, `lower_or_peer_leader_cannot_read_leader_notes`,
 * `office_roles_cannot_read_leader_notes`, `support_session_cannot_read_leader_notes` and
 * `support_session_cannot_write_leader_notes`).
 *
 * Through the real `PermissionsGuard`, the production pipe and the real services over
 * `test/coaching-office.ts`'s office. Every test starts from the same three notes — Sari's and Agus's
 * about Rina, and Agus's about Sari, an AAB who leads people of her own — and no profile.
 */
describe('the Leader Notes tab over HTTP (P11-T9)', () => {
  let app: INestApplication;
  let wired: ReturnType<typeof configModule>;
  let office: CoachingOffice;
  const noteIds: Record<keyof typeof NOTE, string> = {} as never;

  const db = () => mongoose.connection.db!;
  const col = (name: string) => db().collection(name);
  const http = () => request(app.getHttpServer());
  const as = (who: Who) => { session.current = office.as(who); };
  const id = (who: Who) => office.id[who];

  const getProfile = (subject: Who) => http().get(`/coaching/coachees/${id(subject)}/profile`);
  const putProfile = (subject: Who, body: unknown) => http().put(`/coaching/coachees/${id(subject)}/profile`).send(body as object);
  const getNotes = (subject: Who) => http().get(`/coaching/coachees/${id(subject)}/leader-notes`);
  const putNote = (subject: Who, body: unknown) => http().put(`/coaching/coachees/${id(subject)}/leader-notes`).send(body as object);
  const audits = (action: string) => col('auditLog').find({ action }).toArray();

  /**
   * An Owner or an Admin on no rung: the office role, and no hierarchy grant to read through. It stood on the Agent rung
   * until P19.9-T6 gave that rung the coach's grants (ADR-0234); one on it now reads as that Agent (§1.1).
   */
  const officeRole = (role: 'owner' | 'admin') => new RequestContext(`u-${role}-agent`, 'none', {
    membershipId: new mongoose.Types.ObjectId().toString(), kpmId: KPM_A, orgLevelCode: 'NO_RUNG', hierarchyRole: NO_CLASS,
    status: 'active', isKpmOwner: role === 'owner', isKpmAdmin: role === 'admin', directCount: 0,
  });

  /** A support session impersonating `who`: read-only unless it was elevated. */
  const supportSession = (who: Who, readOnly: boolean) => {
    const leader = office.as(who);
    return new RequestContext(leader.userId, 'none', leader.membership, 'u-support', null, false, readOnly);
  };

  beforeAll(async () => {
    await startMongo();
    wired = configModule(ROSTER_NOW);
    office = await buildCoachingOffice(wired);
    await syncIndexes();

    const moduleRef = await Test.createTestingModule({
      controllers: [CoachingProfileController],
      providers: [
        { provide: CoachingProfileService, useValue: wired.coachingProfile },
        { provide: LeaderNoteService, useValue: wired.leaderNotes },
      ],
    }).compile();
    app = moduleRef.createNestApplication();
    app.useGlobalPipes(productionPipe());
    app.useGlobalFilters(new DomainExceptionFilter());
    app.useGlobalGuards(new StubAuth(), new PermissionsGuard(app.get(Reflector)));
    await app.init();
    await listenOnLoopback(app);
  }, 120_000);

  afterAll(async () => {
    await app.close();
    await stopMongo();
  });

  beforeEach(async () => {
    for (const name of ['leaderNotes', 'coachingProfiles', 'auditLog']) await col(name).deleteMany({});
    noteIds.sariOnRina = (await wired.leaderNotes.save(office.as('SARI'), id('RINA'), { version: 0, text: NOTE.sariOnRina })).noteId;
    noteIds.agusOnRina = (await wired.leaderNotes.save(office.as('AGUS'), id('RINA'), { version: 0, text: NOTE.agusOnRina })).noteId;
    noteIds.agusOnSari = (await wired.leaderNotes.save(office.as('AGUS'), id('SARI'), { version: 0, text: NOTE.agusOnSari })).noteId;
    await col('auditLog').deleteMany({});
  });

  it('P11-T9 every route names the permission roles §3.8 gives it', () => {
    expect(declaredPermissions(CoachingProfileController)).toEqual({
      profile: 'coaching_profile:read',
      saveProfile: 'coaching_profile:update',
      leaderNotes: 'leader_notes:read',
      saveLeaderNote: 'leader_notes:write',
    });
  });

  describe('the profile: every current coach, and nobody else', () => {
    it('P11-T9 AC-1 AC-2 an AB reads somebody two levels down, and the wire carries the contract’s fields', async () => {
      as('AGUS');
      const res = await getProfile('RINA').expect(200);
      expect(Object.keys(res.body).sort()).toEqual(
        ['catalog', 'milestoneCodes', 'skillCodes', 'stageCode', 'updatedAt', 'updatedBy', 'version'],
      );
      expect(res.body).toMatchObject({ version: 0, stageCode: null, updatedBy: null, milestoneCodes: [], skillCodes: [] });
      expect(res.body.catalog.grids[2]).toMatchObject({ code: 'DEVELOPING_DOWNLINE_AGENT', requiresDownline: true, status: 'active' });
      expect(Object.keys(res.body.catalog.stages[0]).sort())
        .toEqual(['code', 'displayOrder', 'label', 'requiredMilestoneCodes', 'stageOrder', 'status']);
    });

    it('P11-T9 AC-7 an AAB ticks their own agent, and the AB above reads the same ticks', async () => {
      as('SARI');
      const saved = await putProfile('RINA', { version: 0, milestoneCodes: ['SELLS_INDEPENDENTLY'], skillCodes: ['LEADS_GEN'] })
        .expect(200);
      expect(saved.body).toEqual({ version: 1, stageCode: 'COMPETENT_PRODUCER', updatedAt: ROSTER_NOW.toISOString() });
      as('AGUS');
      expect((await getProfile('RINA').expect(200)).body).toMatchObject({
        version: 1, stageCode: 'COMPETENT_PRODUCER', skillCodes: ['LEADS_GEN'],
        updatedBy: { membershipId: id('SARI'), name: 'Sari Puspita' },
      });
    });

    it('P11-T9 the coachee never reads their own profile: not found, an Agent as a leader (P19.9-T6: the guard no longer refuses the rung)', async () => {
      as('RINA');
      expect((await getProfile('RINA').expect(404)).body.error.code).toBe('NOT_FOUND');
      expect((await putProfile('RINA', { version: 0, milestoneCodes: [], skillCodes: [] }).expect(404)).body.error.code)
        .toBe('NOT_FOUND');
      as('SARI');
      expect((await getProfile('SARI').expect(404)).body.error.code).toBe('NOT_FOUND');
      expect((await putProfile('SARI', { version: 0, milestoneCodes: [], skillCodes: [] }).expect(404)).body.error.code)
        .toBe('NOT_FOUND');
    });

    it.each([
      ['SARI', 'INDAH'], ['NINA', 'RINA'], ['PEER_AB', 'RINA'], ['PEER_AAB', 'RINA'], ['ADMIN', 'RINA'], ['B_AB', 'RINA'],
      ['AGUS', 'LEFT'],
    ] as [Who, Who][])('P11-T9 %s, who does not coach %s, is answered not found', async (reader, subject) => {
      as(reader);
      await getProfile(subject).expect(404);
      await putProfile(subject, { version: 0, milestoneCodes: [], skillCodes: [] }).expect(404);
      expect(await col('coachingProfiles').countDocuments({})).toBe(0);
    });

    it('P11-T9 the Owner, the Admin and the Super Admin as such hold no grant on it', async () => {
      for (const ctx of [officeRole('owner'), officeRole('admin'), SUPER_ADMIN]) {
        session.current = ctx;
        expect((await getProfile('RINA').expect(403)).body.error.code).toBe('PERM_DENIED');
        await putProfile('RINA', { version: 0, milestoneCodes: [], skillCodes: [] }).expect(403);
      }
      // One who is also an AB holds the AB's grant, and coaches nobody they do not stand above.
      for (const ctx of [OWNER, ADMIN]) {
        session.current = ctx;
        await getProfile('RINA').expect(404);
      }
    });

    it('P11-T9 AC-9 a read-only support session reads the profile and ticks nothing; an elevated one ticks it', async () => {
      session.current = supportSession('AGUS', true);
      await getProfile('INDAH').expect(200);
      expect((await putProfile('INDAH', { version: 0, milestoneCodes: [], skillCodes: ['LEADS_GEN'] }).expect(403)).body.error.code)
        .toBe('PERM_DENIED');
      expect(await col('coachingProfiles').countDocuments({})).toBe(0);
      // ADR-0090: the ladder and the grids are not notes. `coaching_profile:update` is not blocked.
      session.current = supportSession('AGUS', false);
      await putProfile('INDAH', { version: 0, milestoneCodes: [], skillCodes: ['LEADS_GEN'] }).expect(200);
    });

    it.each([
      ['no version', { milestoneCodes: [], skillCodes: [] }],
      ['a negative version', { version: -1, milestoneCodes: [], skillCodes: [] }],
      ['a version that is not a whole number', { version: 1.5, milestoneCodes: [], skillCodes: [] }],
      ['no tick lists', { version: 0 }],
      ['a tick list that is not a list', { version: 0, milestoneCodes: 'SELLS_INDEPENDENTLY', skillCodes: [] }],
      ['a code that is not text', { version: 0, milestoneCodes: [7], skillCodes: [] }],
      ['a code over 64 characters', { version: 0, milestoneCodes: ['X'.repeat(65)], skillCodes: [] }],
      ['more ticks than any catalog has', { version: 0, milestoneCodes: [], skillCodes: Array.from({ length: 201 }, (_, i) => `C${i}`) }],
      ['a field the save does not take', { version: 0, milestoneCodes: [], skillCodes: [], stageCode: 'COMPETENT_PRODUCER' }],
    ])('P11-T9 a profile save with %s is VALIDATION_FAILED', async (_what, body) => {
      as('AGUS');
      expect((await putProfile('INDAH', body).expect(400)).body.error.code).toBe('VALIDATION_FAILED');
    });

    it('P11-T9 a code the catalog does not hold is VALIDATION_FAILED, named in details', async () => {
      as('AGUS');
      const res = await putProfile('INDAH', { version: 0, milestoneCodes: ['NOPE'], skillCodes: ['LEADS_GEN'] }).expect(400);
      expect(res.body.error).toMatchObject({
        code: 'VALIDATION_FAILED', details: { unknown: { milestoneCodes: ['NOPE'], skillCodes: [] } },
        // ADR-0084 rule 2: none of the six words.
        message: 'Every tick must name a milestone or a skill item in the capability catalog.',
      });
    });

    it('P11-T9 a stale version is 409 VERSION_CONFLICT; an archived item ticked anew is 422 CONFIG_ARCHIVED', async () => {
      as('SARI');
      await putProfile('RINA', { version: 0, milestoneCodes: [], skillCodes: ['LEADS_GEN'] }).expect(200);
      as('AGUS');
      expect((await putProfile('RINA', { version: 0, milestoneCodes: [], skillCodes: [] }).expect(409)).body.error.code)
        .toBe('VERSION_CONFLICT');

      await wired.capability.setStatus(office.as('OWNER'), 'item', 'AFTER_SALES', 'archived', 'PERSONAL_SELLING');
      try {
        const res = await putProfile('RINA', { version: 1, milestoneCodes: [], skillCodes: ['LEADS_GEN', 'AFTER_SALES'] }).expect(422);
        expect(res.body.error).toMatchObject({
          code: 'CONFIG_ARCHIVED', details: { codes: ['AFTER_SALES'] },
          // The Leader Notes tab's banner shows it as written: ADR-0084 rule 2, none of the six words.
          message: 'This item has been retired. A profile that already had it keeps it; nobody ticks it anew.',
        });
      } finally {
        await wired.capability.setStatus(office.as('OWNER'), 'item', 'AFTER_SALES', 'active', 'PERSONAL_SELLING');
      }
    });
  });

  describe('the notes: the author, and the leaders above the author (ADR-0073)', () => {
    it('P11-T9 AC-4 AC-5 an AB reads their own note and what the AAB below them wrote; each read of hers is recorded', async () => {
      as('AGUS');
      const res = await getNotes('RINA').expect(200);
      expect(res.body).toEqual({
        mine: { noteId: noteIds.agusOnRina, text: NOTE.agusOnRina, version: 1, updatedAt: ROSTER_NOW.toISOString() },
        others: [{
          noteId: noteIds.sariOnRina, author: { membershipId: id('SARI'), name: 'Sari Puspita' },
          text: NOTE.sariOnRina, updatedAt: ROSTER_NOW.toISOString(),
        }],
      });
      const entries = await audits(LEADER_NOTE_READ_ACTION);
      expect(entries).toHaveLength(1);
      expect(entries[0]).toMatchObject({
        kpmId: KPM_A, actorMembershipId: id('AGUS'), targetCollection: 'leaderNotes', targetId: noteIds.sariOnRina,
        targetMembershipId: null, after: { authorMembershipId: id('SARI'), coacheeMembershipId: id('RINA') },
      });
    });

    it('P11-T9 AC-5 the Owner, standing at the root as the office’s AB, reads both as their ancestor', async () => {
      as('OWNER');
      const res = await getNotes('RINA').expect(200);
      expect(res.body.mine).toBeNull();
      expect(res.body.others.map((n: Doc) => n.text).sort()).toEqual([NOTE.agusOnRina, NOTE.sariOnRina].sort());
      expect(await audits(LEADER_NOTE_READ_ACTION)).toHaveLength(2);
    });

    it('P11-T9 lower_or_peer_leader_cannot_read_leader_notes: the coachee’s own AAB never reads the AB’s note', async () => {
      as('SARI');
      const res = await getNotes('RINA').expect(200);
      expect(res.body).toEqual({
        mine: { noteId: noteIds.sariOnRina, text: NOTE.sariOnRina, version: 1, updatedAt: ROSTER_NOW.toISOString() },
        others: [],
      });
      expect(JSON.stringify(res.body)).not.toContain('AGUS-ON');
      expect(await audits(LEADER_NOTE_READ_ACTION)).toEqual([]);
    });

    it.each([
      ['NINA', 'RINA', 'a leader beside the coachee, below the author'],
      ['PEER_AB', 'RINA', 'a peer AB'],
      ['PEER_AAB', 'RINA', 'a peer AAB'],
      ['ADMIN', 'RINA', 'the Admin, an AB who stands above nobody'],
      ['B_AB', 'RINA', 'another office'],
    ] as [Who, Who, string][])('P11-T9 lower_or_peer_leader_cannot_read_leader_notes: %s about %s is 404 (%s)', async (reader, subject) => {
      as(reader);
      const res = await getNotes(subject).expect(404);
      expect(res.body.error.code).toBe('NOT_FOUND');
      expect(JSON.stringify(res.body)).not.toMatch(/ON-RINA|note/i);
      expect(await audits(LEADER_NOTE_READ_ACTION)).toEqual([]);
    });

    it('P11-T9 AC-5 coachee_cannot_read_leader_notes: an Agent, and a coachee who leads, as not found (P19.9-T6)', async () => {
      // The Agent rung holds `leader_notes:read` since P19.9-T6 (ADR-0234): the guard lets Rina through, and the reader
      // predicate, which tests the subject first, answers her as it answers a leader.
      as('RINA');
      const agent = await getNotes('RINA').expect(404);
      expect(agent.body.error.code).toBe('NOT_FOUND');
      expect(JSON.stringify(agent.body)).not.toContain('ON-RINA');

      // Sari leads Rina, Budi and Nina's unit, and holds `leader_notes:read`; she is still the subject.
      as('SARI');
      const leader = await getNotes('SARI').expect(404);
      expect(leader.body.error.code).toBe('NOT_FOUND');
      expect(JSON.stringify(leader.body)).not.toMatch(/AGUS-ON-SARI|note/i);
      expect(await audits(LEADER_NOTE_READ_ACTION)).toEqual([]);
    });

    it('P11-T9 office_roles_cannot_read_leader_notes: 403 to the Owner, the Admin and the Super Admin as such', async () => {
      for (const ctx of [officeRole('owner'), officeRole('admin'), SUPER_ADMIN]) {
        session.current = ctx;
        expect((await getNotes('RINA').expect(403)).body.error.code).toBe('PERM_DENIED');
        expect((await putNote('RINA', { version: 0, text: 'x' }).expect(403)).body.error.code).toBe('PERM_DENIED');
      }
    });

    it('P11-T9 office_roles_cannot_read_leader_notes: 404 to an Owner or an Admin who is an AB above nobody here', async () => {
      for (const ctx of [OWNER, ADMIN]) {
        session.current = ctx;
        const res = await getNotes('RINA').expect(404);
        expect(JSON.stringify(res.body)).not.toContain('ON-RINA');
        await putNote('RINA', { version: 0, text: 'x' }).expect(404);
      }
      expect(await audits(LEADER_NOTE_READ_ACTION)).toEqual([]);
    });

    it.each([
      ['read-only', true], ['elevated', false],
    ])('P11-T9 AC-9 support_session_cannot_read_leader_notes and _write_: a %s session is refused both, and nothing changes', async (_kind, readOnly) => {
      session.current = supportSession('AGUS', readOnly);
      const read = await getNotes('RINA').expect(403);
      expect(read.body.error).toMatchObject({ code: 'PERM_DENIED', details: { permission: 'leader_notes:read' } });
      expect(JSON.stringify(read.body)).not.toContain('ON-RINA');

      const write = await putNote('RINA', { version: 1, text: '' }).expect(403);
      expect(write.body.error).toMatchObject({ code: 'PERM_DENIED', details: { permission: 'leader_notes:write' } });
      // A first note, which an elevated session would otherwise hold through Agus's `COACH` grant.
      await putNote('INDAH', { version: 0, text: 'Written by support.' }).expect(403);

      const agusOnRina = await col('leaderNotes').findOne({ _id: new mongoose.Types.ObjectId(noteIds.agusOnRina) });
      expect(agusOnRina).toMatchObject({ text: NOTE.agusOnRina, version: 1, revisions: [] });
      expect(await col('leaderNotes').countDocuments({ coacheeMembershipId: id('INDAH') })).toBe(0);
      expect(await audits(LEADER_NOTE_READ_ACTION)).toEqual([]);
      expect(await audits(LEADER_NOTE_SAVED_ACTION)).toEqual([]);
    });

    it('P11-T9 AC-4 AC-7 a save answers the version the next save pins, keeps the replaced text, and is recorded without it', async () => {
      as('SARI');
      const first = await putNote('BUDI', { version: 0, text: 'Logs every day.' }).expect(200);
      expect(first.body).toEqual({ noteId: expect.any(String), version: 1, updatedAt: ROSTER_NOW.toISOString() });
      const second = await putNote('BUDI', { version: 1, text: 'Logs every day; needs closing practice.' }).expect(200);
      expect(second.body).toMatchObject({ noteId: first.body.noteId, version: 2 });

      const row = (await col('leaderNotes').findOne({ _id: new mongoose.Types.ObjectId(first.body.noteId) }))!;
      expect(row.revisions).toEqual([{ version: 1, text: 'Logs every day.', at: ROSTER_NOW }]);
      const entries = await audits(LEADER_NOTE_SAVED_ACTION);
      expect(entries).toHaveLength(2);
      expect(JSON.stringify(entries)).not.toContain('Logs every day');
      expect(entries.every((e) => e.targetMembershipId === null)).toBe(true);
    });

    it('P11-T9 AC-4 a save of the text the note already has answers it unchanged, and records nothing', async () => {
      as('SARI');
      const first = await putNote('BUDI', { version: 0, text: 'Logs every day.' }).expect(200);
      const again = await putNote('BUDI', { version: 1, text: 'Logs every day.' }).expect(200);
      expect(again.body).toEqual(first.body);

      const row = (await col('leaderNotes').findOne({ _id: new mongoose.Types.ObjectId(first.body.noteId) }))!;
      expect(row).toMatchObject({ version: 1, revisions: [] });
      expect(await audits(LEADER_NOTE_SAVED_ACTION)).toHaveLength(1);
    });

    it('P11-T9 a stale version is 409 VERSION_CONFLICT', async () => {
      as('SARI');
      expect((await putNote('RINA', { version: 0, text: 'Again.' }).expect(409)).body.error.code).toBe('VERSION_CONFLICT');
    });

    it.each([
      ['no version', { text: 'x' }],
      ['a negative version', { version: -1, text: 'x' }],
      ['no text', { version: 0 }],
      ['a text that is not text', { version: 0, text: 42 }],
      [`a text over ${NOTE_LIMITS.TEXT_MAX} characters`, { version: 0, text: 'x'.repeat(NOTE_LIMITS.TEXT_MAX + 1) }],
      ['a field the save does not take', { version: 0, text: 'x', authorMembershipId: 'somebody' }],
    ])('P11-T9 a note save with %s is VALIDATION_FAILED, and nothing is saved', async (_what, body) => {
      as('SARI');
      expect((await putNote('BUDI', body).expect(400)).body.error.code).toBe('VALIDATION_FAILED');
      expect(await col('leaderNotes').countDocuments({ coacheeMembershipId: id('BUDI') })).toBe(0);
    });

    it(`P11-T9 a note of exactly ${NOTE_LIMITS.TEXT_MAX} characters, and a blank one, are saved`, async () => {
      as('SARI');
      await putNote('BUDI', { version: 0, text: 'x'.repeat(NOTE_LIMITS.TEXT_MAX) }).expect(200);
      await putNote('BUDI', { version: 1, text: '' }).expect(200);
    });

    it.each([
      ['SARI', 'INDAH', 'somebody the author does not coach'],
      ['SARI', 'SARI', 'themselves'],
      ['NINA', 'RINA', 'a peer’s person'],
      ['B_AB', 'RINA', 'another office'],
    ] as [Who, Who, string][])('P11-T9 %s writing about %s is 404 (%s)', async (author, subject) => {
      as(author);
      await putNote(subject, { version: 0, text: 'x' }).expect(404);
      expect(await audits(LEADER_NOTE_SAVED_ACTION)).toEqual([]);
    });

    // Was *an Agent holds no grant to write a note* (403 at the guard): P19.9-T6 (ADR-0234) — every upline coaches.
    it('P19.9-T6 AC-1 an Agent who leads writes a note about their report, reads it back, and reaches nobody else', async () => {
      as('LUKAS');
      const saved = (await putNote('TARI', { version: 0, text: 'LUKAS-ON-TARI: strong opener.' }).expect(200)).body;
      expect(saved).toMatchObject({ version: 1 });
      expect((await getNotes('TARI').expect(200)).body.mine).toMatchObject({ text: 'LUKAS-ON-TARI: strong opener.' });
      await putNote('INDAH', { version: 0, text: 'x' }).expect(404);
      await getNotes('INDAH').expect(404);
      // Tari never reads it, an Agent like him.
      as('TARI');
      expect(JSON.stringify((await getNotes('TARI').expect(404)).body)).not.toContain('LUKAS-ON-TARI');
      // Agus, above Lukas, reads it: he coaches its author.
      as('AGUS');
      expect((await getNotes('TARI').expect(200)).body.others.map((n: { text: string }) => n.text)).toContain('LUKAS-ON-TARI: strong opener.');
    });
  });
});
