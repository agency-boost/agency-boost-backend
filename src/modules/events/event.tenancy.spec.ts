import mongoose from 'mongoose';
import { RequestContext } from '@/common/context/request-context';
import { clearCollections, startMongo, stopMongo } from '../../../test/mongo';
import { configModule } from '../../../test/config-module';

const NOW = new Date('2026-09-18T02:00:00Z');
const KPM_A = '66f0000000000000000000a1';
const KPM_B = '66f0000000000000000000b1';

const member = (kpmId: string) => new RequestContext('u1', 'none', {
  membershipId: `mem-${kpmId}`, kpmId, orgLevelCode: 'AB', hierarchyRole: 'ab',
  status: 'active', isKpmOwner: true, isKpmAdmin: false, directCount: 0,
} as never);

/** A membership of one office, with however many direct reports the graph gives it. */
const membership = async (kpmId: string, over: Record<string, unknown> = {}) => {
  const row = await mongoose.model('Membership').create({
    kpmId,
    userId: new mongoose.Types.ObjectId().toString(),
    role: 'agent',
    orgLevelCode: 'AGENT',
    orgLevelId: new mongoose.Types.ObjectId().toString(),
    status: 'active',
    agentCode: `A${Math.random().toString(36).slice(2, 8)}`,
    agentSeq: Math.floor(Math.random() * 100000),
    leaderCode: Math.random().toString(36).slice(2, 8).toUpperCase(),
    deletedAt: null,
    ...over,
  });
  return String(row._id);
};

/**
 * The events an office runs (P5-T6, ADR-0034).
 *
 * Two things carry the design and are proved here: an **audience is three structured facts**
 * rather than the prototype's free-text string, so an invitee can actually be checked against the
 * office; and **nothing about when an event is happening is stored**, so no record can say
 * *Running* while its own dates say otherwise.
 */
describe('an office’s events (P5-T6)', () => {
  let wired: ReturnType<typeof configModule>;

  beforeAll(async () => {
    await startMongo();
    wired = configModule(NOW);
  });
  afterAll(stopMongo);

  beforeEach(async () => {
    await clearCollections();
    // P18.5-T5 AC-9: the offices carry the zone column the day is read from (`kpms.timezone`), as every office does.
    await mongoose.model('KpmModelForConfig').create([
      { _id: KPM_A, companyId: '66f0000000000000000000c1', code: '0417', branchName: 'A', timezone: 'Asia/Jakarta' },
      { _id: KPM_B, companyId: '66f0000000000000000000c1', code: '0555', branchName: 'B', timezone: 'Asia/Jakarta' },
    ]);
    await wired.events.seedForOffice(member(KPM_A));
    await wired.events.seedForOffice(member(KPM_B));
  });

  const anEvent = (over: Record<string, unknown> = {}) => ({
    code: 'KICKOFF', typeCode: 'TRAINING', title: 'Kickoff 2026',
    startsAt: '2026-10-01T02:00:00Z', endsAt: '2026-10-01T06:00:00Z',
    location: 'Jakarta',
    audience: { issuer: 'kpm', scope: 'all_agents' },
    ...over,
  });

  describe('isolation (AC-1)', () => {
    it('keeps one office’s events out of another’s', async () => {
      await wired.events.create(member(KPM_A), anEvent());

      expect(await wired.events.list(member(KPM_A))).toHaveLength(1);
      expect(await wired.events.list(member(KPM_B))).toHaveLength(0);
    });

    it('refuses another office’s event as a 404', async () => {
      const mine = await wired.events.create(member(KPM_A), anEvent());

      await expect(wired.events.archive(member(KPM_B), mine.id))
        .rejects.toMatchObject({ code: 'NOT_FOUND' });
    });

    it('lets two offices use the same event code', async () => {
      await wired.events.create(member(KPM_A), anEvent());
      await expect(wired.events.create(member(KPM_B), anEvent())).resolves.toBeTruthy();
    });

    it('refuses the same code twice within one office, for an event and for a type', async () => {
      /*
       * The other half of the rule above, and the half that had no test: a code is unique
       * *within* an office because a tick, a filter and a report all name one — two rows sharing
       * one would make every reference ambiguous. Both checks run before anything is written.
       */
      await wired.events.create(member(KPM_A), anEvent());
      await expect(wired.events.create(member(KPM_A), anEvent()))
        .rejects.toThrow(/already has an event with the code KICKOFF/);

      const existing = (await wired.events.listTypes(member(KPM_A)))[0];
      await expect(wired.events.createType(member(KPM_A), {
        code: existing.code, label: 'Another name for it',
      })).rejects.toThrow(/already has an event type with the code/);
    });
  });

  describe('an event type is archived, never deleted (AC-2)', () => {
    it('keeps an archived type readable and stops new events being filed under it', async () => {
      const training = (await wired.events.listTypes(member(KPM_A)))
        .find((t) => t.code === 'TRAINING')!;
      await wired.events.create(member(KPM_A), anEvent());

      await wired.events.archiveType(member(KPM_A), training.id);

      // Still there, and the count says what archiving affected.
      const archived = (await wired.events.listTypes(member(KPM_A), true))
        .find((t) => t.code === 'TRAINING')!;
      expect(archived).toMatchObject({ status: 'archived', events: 1 });
      await expect(wired.events.create(member(KPM_A), anEvent({ code: 'OTHER' })))
        .rejects.toThrow(/archived/);
    });

    it('brings one back', async () => {
      const training = (await wired.events.listTypes(member(KPM_A)))
        .find((t) => t.code === 'TRAINING')!;
      await wired.events.archiveType(member(KPM_A), training.id);

      const restored = await wired.events.restoreType(member(KPM_A), training.id);
      expect(restored.status).toBe('active');
    });

    it('has no delete for a type or an event', () => {
      expect(wired.events).not.toHaveProperty('deleteType');
      expect(wired.events).not.toHaveProperty('delete');
    });
  });

  describe('when it is happening is derived, never stored (AC-3)', () => {
    it('reads upcoming, running and past off the instants', async () => {
      // The prototype hardcodes a status beside a date it never checks, and labels one record
      // Running in the list while its own data says past.
      const upcoming = await wired.events.create(member(KPM_A), anEvent());
      const running = await wired.events.create(member(KPM_A), anEvent({
        code: 'NOW', startsAt: '2026-09-18T01:00:00Z', endsAt: '2026-09-18T03:00:00Z',
      }));
      const past = await wired.events.create(member(KPM_A), anEvent({
        code: 'LAST', startsAt: '2026-09-01T01:00:00Z', endsAt: '2026-09-01T03:00:00Z',
      }));

      expect([upcoming.phase, running.phase, past.phase])
        .toEqual(['upcoming', 'running', 'past']);
      // And nothing about it reached the database.
      const stored = await mongoose.connection.db!.collection('events').findOne({ code: 'NOW' });
      expect(stored).not.toHaveProperty('phase');
      expect(stored).not.toHaveProperty('status.upcoming');
    });

    it('gives the calendar day in the office’s timezone, not the server’s', async () => {
      // 23:30 UTC is already the next day in Jakarta. A browser grouping by its own timezone
      // would file this under the wrong day.
      const late = await wired.events.create(member(KPM_A), anEvent({
        code: 'LATE', startsAt: '2026-10-01T23:30:00Z', endsAt: '2026-10-02T01:00:00Z',
      }));

      expect(late.startsAt).toBe('2026-10-01T23:30:00.000Z');
      expect(late.startsOn).toBe('2026-10-02');
    });

    it('P18.5-T5 AC-9 reads the zone from kpms.timezone, never a constant (invariant §9)', async () => {
      // 16:30 UTC is still the 1st in Jakarta and already the 2nd in Makassar: only the column can tell them apart.
      const at = { startsAt: '2026-10-01T16:30:00Z', endsAt: '2026-10-01T18:00:00Z' };
      expect((await wired.events.create(member(KPM_A), anEvent({ code: 'JKT', ...at }))).startsOn).toBe('2026-10-01');
      await mongoose.model('KpmModelForConfig').updateOne({ _id: KPM_B }, { $set: { timezone: 'Asia/Makassar' } });
      const there = await wired.events.create(member(KPM_B), anEvent({ code: 'MKS', ...at }));
      expect(there.startsOn).toBe('2026-10-02');
      expect((await wired.events.list(member(KPM_B))).find((e) => e.code === 'MKS')!.startsOn).toBe('2026-10-02');
    });

    it('refuses an event that ends before it starts, and one with no end', async () => {
      await expect(wired.events.create(member(KPM_A), anEvent({
        code: 'BACKWARDS', endsAt: '2026-10-01T01:00:00Z',
      }))).rejects.toThrow(/endsAt must be after startsAt/);

      const { endsAt, ...noEnd } = anEvent({ code: 'OPEN' });
      await expect(wired.events.create(member(KPM_A), noEnd)).rejects.toThrow(/endsAt is required/);
    });
  });

  describe('the audience is three facts, not a string (AC-4, AC-5)', () => {
    it('stores the issuer, the scope and the invitees apart', async () => {
      const someone = await membership(KPM_A);

      const event = await wired.events.create(member(KPM_A), anEvent({
        audience: { issuer: 'company', scope: 'select_agents', inviteeMembershipIds: [someone] },
      }));

      // The prototype's *"Prudential Event | Select agents"* was one string that nothing could
      // filter on, and the invitee list had nowhere to live at all.
      expect(event.audience).toEqual({
        issuer: 'company', scope: 'select_agents', inviteeMembershipIds: [someone],
      });
    });

    it('refuses an invitee from another office, as a 404', async () => {
      const theirs = await membership(KPM_B);

      await expect(wired.events.create(member(KPM_A), anEvent({
        audience: { issuer: 'kpm', scope: 'select_agents', inviteeMembershipIds: [theirs] },
      }))).rejects.toMatchObject({ code: 'NOT_FOUND' });
    });

    it('refuses a select audience with nobody in it', async () => {
      await expect(wired.events.create(member(KPM_A), anEvent({
        audience: { issuer: 'kpm', scope: 'select_agents', inviteeMembershipIds: [] },
      }))).rejects.toThrow(/needs at least one person/);
    });

    it('refuses an invitee list on a scope that invites everybody it describes', async () => {
      await expect(wired.events.create(member(KPM_A), anEvent({
        audience: { issuer: 'kpm', scope: 'all_agents', inviteeMembershipIds: ['x'] },
      }))).rejects.toThrow(/takes no invitee list/);
    });

    it('takes a leader from the graph, and refuses one from a job title (AC-5)', async () => {
      // Being an AB is a rung; leading is having somebody under you. An AAB with nobody under
      // them leads nobody, and inviting them on the strength of the enum is OD-50's defect.
      // *P18.5-T5 (D-picker):* read from who reports to whom, as the picker's `leads` is — not the
      // `directCounts` cache, which `titleOnly` below holds stale at 3 to prove it is not read.
      const leads = await membership(KPM_A, {
        role: 'ab', orgLevelCode: 'AB', directCounts: { total: 0 },
      });
      await membership(KPM_A, { leaderId: leads });
      const titleOnly = await membership(KPM_A, {
        role: 'ab', orgLevelCode: 'AB', directCounts: { total: 3 },
      });
      // Somebody who reported to `titleOnly` and has left counts for nothing either.
      await membership(KPM_A, { leaderId: titleOnly, status: 'removed' });

      await expect(wired.events.create(member(KPM_A), anEvent({
        code: 'LEADERS',
        audience: { issuer: 'kpm', scope: 'select_leaders', inviteeMembershipIds: [leads] },
      }))).resolves.toBeTruthy();

      await expect(wired.events.create(member(KPM_A), anEvent({
        code: 'LEADERS_2',
        audience: { issuer: 'kpm', scope: 'select_leaders', inviteeMembershipIds: [titleOnly] },
      }))).rejects.toThrow(/lead nobody/);
    });
  });

  describe('the paths a screen reaches only by mistake (the Phase 18.5 exit review, module coverage)', () => {
    it('P18.5-T5 AC-9 a type, an event and an unknown type code each answer as nothing found; a re-seed adds nothing', async () => {
      const nowhere = '66f00000000000000000ffff';
      await expect(wired.events.updateType(member(KPM_A), nowhere, { label: 'X' })).rejects.toMatchObject({ code: 'NOT_FOUND' });
      await expect(wired.events.archiveType(member(KPM_A), nowhere)).rejects.toMatchObject({ code: 'NOT_FOUND' });
      await expect(wired.events.archive(member(KPM_A), nowhere)).rejects.toMatchObject({ code: 'NOT_FOUND' });
      await expect(wired.events.restore(member(KPM_A), nowhere)).rejects.toMatchObject({ code: 'NOT_FOUND' });
      await expect(wired.events.update(member(KPM_A), nowhere, { title: 'X' })).rejects.toMatchObject({ code: 'NOT_FOUND' });
      await expect(wired.events.create(member(KPM_A), anEvent({ typeCode: 'NO_SUCH_TYPE' })))
        .rejects.toThrow(/NO_SUCH_TYPE is not an event type in this office/);
      expect(await wired.events.seedForOffice(member(KPM_A))).toBe(0);
    });

    it('P18.5-T5 AC-9 the first type of an office with none is first in order', async () => {
      const empty = '66f0000000000000000000e1';
      const made = await wired.events.createType(member(empty), { code: 'FIRST', label: 'First' });
      expect(made.displayOrder).toBe(1);
    });
  });

  describe('nothing per-person is stored on an event (AC-6)', () => {
    it('writes no RSVP, attendance or feedback field', async () => {
      await wired.events.create(member(KPM_A), anEvent());

      // The prototype keeps `joined`, `feedbackSubmitted`, `myScore` and `myWhy` on the shared
      // object, so with two users the second overwrites the first's RSVP.
      const stored = await mongoose.connection.db!.collection('events').findOne({ code: 'KICKOFF' });
      for (const field of ['joined', 'feedbackSubmitted', 'myScore', 'myWhy', 'rsvps']) {
        expect(stored).not.toHaveProperty(field);
      }
    });

    it('P18.5-T5 AC-6 an RSVP, a claim, a confirmation and an answer each land in their own row — never on the event', async () => {
      // A real member of 0417, so the audience as at the start holds them, and an Owner who is somebody else.
      const someone = await membership(KPM_A, { joinedAt: new Date('2026-01-02T02:00:00Z') });
      const guest = new RequestContext('u-guest', 'none', {
        membershipId: someone, kpmId: KPM_A, orgLevelCode: 'AGENT', hierarchyRole: 'agent', status: 'active',
        isKpmOwner: false, isKpmAdmin: false, directCount: 0,
      } as never);
      const upcoming = await wired.events.create(member(KPM_A), anEvent());
      const past = await wired.events.create(member(KPM_A), anEvent({
        code: 'DONE', startsAt: '2026-09-01T01:00:00Z', endsAt: '2026-09-01T03:00:00Z',
      }));

      await wired.eventGuests.rsvp(guest, upcoming.id);
      await wired.eventGuests.claim(guest, past.id);
      await wired.eventGuests.submitFeedback(guest, past.id, { score: 7, why: 'Why', improve: 'Improve' });
      await wired.eventRollCalls.saveRollCall(member(KPM_A), past.id, { entries: [{ membershipId: someone, attended: true }] });

      const events = await mongoose.connection.db!.collection('events').find({ kpmId: KPM_A }).toArray();
      for (const stored of events) {
        for (const field of [
          'joined', 'feedbackSubmitted', 'myScore', 'myWhy', 'rsvps', 'rsvpStatus', 'claimedAt', 'confirmedAttended',
          'confirmedByMembershipId', 'confirmedAt', 'attended', 'score', 'why', 'improve', 'feedback',
        ]) expect([stored.code, field, field in stored]).toEqual([stored.code, field, false]);
      }
      // …and where they did land, keyed by the membership.
      expect(await mongoose.connection.db!.collection('eventRsvps').countDocuments({ kpmId: KPM_A, membershipId: someone })).toBe(2);
      expect(await mongoose.connection.db!.collection('eventFeedback').findOne({ kpmId: KPM_A, membershipId: someone }))
        .toMatchObject({ score: 7, eventId: past.id });
    });
  });
});
