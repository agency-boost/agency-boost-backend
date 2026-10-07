import mongoose from 'mongoose';
import { RequestContext } from '@/common/context/request-context';
import { SUBJECT_READ_ACTION } from '@/modules/audit/subject-read-audit';
import { SUPER_ADMIN } from '../../../test/http-permissions';
import { type Who } from '../../../test/coaching-office';
import { startCalendar, stopCalendar, timed, type CalendarHarness } from '../../../test/calendar-office';
import { CALENDAR_SETTINGS_AUDIT_ACTION } from './calendar.service';

type Doc = Record<string, unknown>;

/** A busy block's keys, and nothing else (`functional/calendar.md`, *A busy block*). */
const BUSY_KEYS = ['allDay', 'busy', 'date', 'end', 'endsAt', 'endsOn', 'start', 'startsAt', 'startsOn'];

/**
 * ***Hide my personal activities*** over HTTP (P13.1-T8; ADR-0110, amending ADR-0093;
 * `functional/calendar.md`, *Who reads what* and the Data contract): the member's own setting, off by
 * default and kept on their membership, and what a leader comparing their week is answered once it is on —
 * busy blocks for everything they organised, unless the leader is on the entry.
 */
describe('Hide my personal activities (P13.1-T8)', () => {
  let h: CalendarHarness;
  const create = async (who: Who, body: Doc) => {
    h.as(who);
    return (await h.http().post('/calendar/entries').send(body).expect(201)).body;
  };
  const hide = async (who: Who | RequestContext, hideDetails: boolean) => {
    h.as(who);
    return h.http().put('/calendar/settings').send({ hideDetails });
  };
  const compare = (who: Who, member: Who) => {
    h.as(who);
    return h.http().get('/calendar/entries').query({ for: h.id(member) });
  };
  const stored = async (who: Who) =>
    (await h.col('memberships').findOne({ _id: new mongoose.Types.ObjectId(h.id(who)) }))!.calendarHideDetails;
  const settingRows = () => h.col('auditLog').find({ action: CALENDAR_SETTINGS_AUDIT_ACTION }).sort({ _id: 1 }).toArray();

  beforeAll(async () => { h = await startCalendar(); }, 120_000);
  afterAll(() => stopCalendar(h));
  beforeEach(() => h.reset());
  // The harness keeps its memberships between tests: everybody starts with the setting as a new row has it.
  afterEach(() => h.col('memberships').updateMany({}, { $unset: { calendarHideDetails: '' } }));

  // ------------------------------------------------------------------ the setting

  describe('the setting (P13.1-T8 AC-2)', () => {
    it.each(['AGUS', 'SARI', 'INDAH'] as const)('P13.1-T8 AC-2 %s reads theirs off by default, turns it on and off, and it is kept', async (who) => {
      h.as(who);
      expect((await h.http().get('/calendar/settings').expect(200)).body).toEqual({ hideDetails: false });
      expect((await hide(who, true).then((r) => r.body))).toEqual({ hideDetails: true });
      h.as(who);
      expect((await h.http().get('/calendar/settings').expect(200)).body).toEqual({ hideDetails: true });
      expect(await stored(who)).toBe(true);
      expect((await hide(who, false)).body).toEqual({ hideDetails: false });
      expect(await stored(who)).toBe(false);
    });

    it('P13.1-T8 AC-2 is the reader’s own: turning it on touches nobody else’s membership', async () => {
      await hide('SARI', true).then((r) => expect(r.status).toBe(200));
      for (const who of ['AGUS', 'RINA', 'OWNER'] as const) {
        h.as(who);
        expect([who, (await h.http().get('/calendar/settings').expect(200)).body]).toEqual([who, { hideDetails: false }]);
      }
      expect(await h.col('memberships').countDocuments({ calendarHideDetails: true })).toBe(1);
    });

    it('P13.1-T8 AC-2 a save that loses a race writes and records nothing, and answers what is stored', async () => {
      // Another device turned it on between this save's read and its write: nothing is left to turn over.
      const repo = (h.wired.calendar as unknown as { memberships: { updateMany: (...a: unknown[]) => Promise<number> } }).memberships;
      const spy = jest.spyOn(repo, 'updateMany').mockImplementationOnce(async () => {
        await h.col('memberships').updateOne({ _id: new mongoose.Types.ObjectId(h.id('SARI')) }, { $set: { calendarHideDetails: true } });
        return 0;
      });
      try {
        const res = await hide('SARI', true);
        expect([res.status, res.body]).toEqual([200, { hideDetails: true }]);
        expect(await settingRows()).toEqual([]);
      } finally {
        spy.mockRestore();
      }
    });

    it('P13.1-T8 AC-2 two saves of one change leave one audit row', async () => {
      const [a, b] = await Promise.all([hide('SARI', true), hide('SARI', true)]);
      expect([a.body, b.body]).toEqual([{ hideDetails: true }, { hideDetails: true }]);
      expect(await stored('SARI')).toBe(true);
      expect(await settingRows()).toHaveLength(1);
    });

    it('P13.1-T8 AC-2 answers 404 and records nothing when the membership is gone between its read and its write', async () => {
      // A member removed by their office mid-request: the write finds nobody, and the re-read neither.
      const repo = (h.wired.calendar as unknown as { memberships: { updateMany: (...a: unknown[]) => Promise<number>; findById: (...a: unknown[]) => Promise<unknown> } }).memberships;
      const write = jest.spyOn(repo, 'updateMany').mockResolvedValueOnce(0);
      const original = repo.findById.bind(repo);
      let reads = 0;
      const read = jest.spyOn(repo, 'findById').mockImplementation(async (...a: unknown[]) => (++reads === 1 ? original(...a) : null));
      try {
        const res = await hide('SARI', true);
        expect([res.status, res.body.error?.code]).toEqual([404, 'NOT_FOUND']);
        expect(await settingRows()).toEqual([]);
      } finally {
        write.mockRestore();
        read.mockRestore();
      }
    });

    it('P13.1-T8 AC-2 refuses a body that is not the whole setting, and a read with a parameter, by name', async () => {
      h.as('SARI');
      for (const body of [{}, { hideDetails: 'true' }, { hideDetails: 1 }, { hideDetails: null }, { hideDetails: true, membershipId: h.id('RINA') }]) {
        const res = await h.http().put('/calendar/settings').send(body);
        expect([body, res.status, res.body.error?.code]).toEqual([body, 400, 'VALIDATION_FAILED']);
      }
      const read = await h.http().get('/calendar/settings').query({ for: h.id('RINA') }).expect(400);
      expect(read.body.error.code).toBe('VALIDATION_FAILED');
      expect(await h.col('memberships').countDocuments({ calendarHideDetails: true })).toBe(0);
    });
  });

  // ------------------------------------------------------------------ per role

  describe('per role (P13.1-T8 AC-4; roles §3.15)', () => {
    it('P13.1-T8 AC-4 an Owner and an Admin with no field role, and a Super Admin, meet the guard on both routes', async () => {
      const refused: [string, RequestContext][] = [
        ['an Owner with no field role', h.officeOnly('OWNER')],
        ['an Admin with no field role', h.officeOnly('ADMIN')],
        ['a Super Admin', SUPER_ADMIN],
      ];
      for (const [who, ctx] of refused) {
        h.as(ctx);
        const read = await h.http().get('/calendar/settings');
        const write = await h.http().put('/calendar/settings').send({ hideDetails: true });
        expect([who, read.status, read.body.error?.code, write.status, write.body.error?.code])
          .toEqual([who, 403, 'PERM_DENIED', 403, 'PERM_DENIED']);
      }
      expect(await h.col('memberships').countDocuments({ calendarHideDetails: true })).toBe(0);
    });

    it('P13.1-T8 AC-4 an Owner who stands on a rung switches their own, as that member (§1.1)', async () => {
      expect((await hide('OWNER', true)).body).toEqual({ hideDetails: true });
      expect(await stored('OWNER')).toBe(true);
    });

    it('P13.1-T8 AC-4 a member who is pending or has left holds no calendar grant', async () => {
      for (const status of ['pending', 'removed'] as const) {
        const indah = h.office.as('INDAH');
        const ctx = new RequestContext(indah.userId, 'none', { ...indah.membership!, status });
        h.as(ctx);
        expect((await h.http().get('/calendar/settings').expect(403)).body.error.code).toBe('PERM_DENIED');
        expect((await hide(ctx, true)).status).toBe(403);
      }
      expect(await stored('INDAH')).toBeUndefined();
    });

    it('P13.1-T8 AC-2 a read-only support session reads the member’s setting and cannot change it (§3.13)', async () => {
      await hide('SARI', true);
      await h.col('auditLog').deleteMany({});
      h.as(h.supporting('SARI'));
      expect((await h.http().get('/calendar/settings').expect(200)).body).toEqual({ hideDetails: true });
      const res = await hide(h.supporting('SARI'), false);
      expect([res.status, res.body.error.code]).toEqual([403, 'PERM_DENIED']);
      expect(await stored('SARI')).toBe(true);
      expect(await settingRows()).toEqual([]);
    });

    it('P13.1-T8 AC-2 an elevated support session switches it as the member, both people on the record', async () => {
      await hide(h.supporting('INDAH', false), true).then((r) => expect(r.status).toBe(200));
      expect((await settingRows()).map((r) => [r.actorUserId, r.effectiveUserId, r.actorMembershipId, r.targetMembershipId]))
        .toEqual([['u-support', h.office.as('INDAH').userId, h.id('INDAH'), h.id('INDAH')]]);
    });
  });

  // ------------------------------------------------------------------ the record

  it('P13.1-T8 AC-2 a change leaves one row — the member and the setting before and after — and a save that changes nothing leaves none', async () => {
    await hide('SARI', false);
    await hide('SARI', true);
    await hide('SARI', true);
    await hide('SARI', false);
    const rows = await settingRows();
    expect(rows.map((r) => [r.targetCollection, r.targetId, r.targetMembershipId, r.before, r.after, r.onBehalfOf])).toEqual([
      ['memberships', h.id('SARI'), h.id('SARI'), { hideDetails: false }, { hideDetails: true }, false],
      ['memberships', h.id('SARI'), h.id('SARI'), { hideDetails: true }, { hideDetails: false }, false],
    ]);
  });

  // ------------------------------------------------------------------ what a leader reads

  describe('what a leader comparing the member reads (P13.1-T8 AC-3)', () => {
    it('calendar_hidden_details_are_busy_to_an_ancestor P13.1-T8 AC-3 on, everything the member organised is a busy block to each leader above them', async () => {
      const visit = await create('SARI', timed(2, '10:00', '11:00', {
        type: 'client', title: 'Client visit — Kusuma', notes: 'Client site — Kusuma residence, Jl. Melati 4', inviteeIds: [h.id('RINA')],
      }));
      const trip = await create('SARI', { type: 'travel', title: 'Client trip — Surabaya', notes: 'Hotel Majapahit', startsOn: '2026-09-17', endsOn: '2026-09-18' });
      await hide('SARI', true);

      for (const who of ['AGUS', 'OWNER'] as const) {
        const { entries } = (await compare(who, 'SARI').expect(200)).body;
        expect(entries.map((e: Doc) => Object.keys(e).sort())).toEqual([BUSY_KEYS, BUSY_KEYS]);
        expect(entries).toEqual([
          { busy: true, allDay: false, date: '2026-09-16', start: '10:00', end: '11:00', startsOn: null, endsOn: null, startsAt: visit.startsAt, endsAt: visit.endsAt },
          { busy: true, allDay: true, date: null, start: null, end: null, startsOn: '2026-09-17', endsOn: '2026-09-18', startsAt: trip.startsAt, endsAt: trip.endsAt },
        ]);
        // The payload, not the screen: nothing of either entry but its time is on the wire.
        const wire = JSON.stringify(entries);
        for (const text of ['Kusuma', 'Surabaya', 'Majapahit', visit.entryId, trip.entryId, h.id('RINA')]) {
          expect([who, text, wire.includes(text)]).toEqual([who, text, false]);
        }
      }
      // Each look is still recorded, one per pane read.
      expect(await h.col('auditLog').countDocuments({ action: SUBJECT_READ_ACTION, targetMembershipId: h.id('SARI') })).toBe(2);
    });

    it('P13.1-T8 AC-3 off again, the leader reads them in full, as before', async () => {
      const visit = await create('SARI', timed(2, '10:00', '11:00', { type: 'client', title: 'Client visit — Kusuma' }));
      await hide('SARI', true);
      await hide('SARI', false);
      expect((await compare('AGUS', 'SARI').expect(200)).body.entries).toEqual([
        expect.objectContaining({ entryId: visit.entryId, title: 'Client visit — Kusuma', readerIs: 'ancestor' }),
      ]);
    });

    it('P13.1-T8 AC-3 a leader on the entry still reads it in full: invited, and their own block on the member', async () => {
      const review = await create('SARI', timed(1, '09:00', '10:00', { title: 'Goal review', inviteeIds: [h.id('AGUS')] }));
      h.as('AGUS');
      const block = (await h.http().post('/calendar/blocks')
        .send({ ...timed(3, '11:00', '11:30', { type: 'coaching', title: '1:1 with Sari Puspita' }), membershipId: h.id('SARI') })
        .expect(201)).body;
      await hide('SARI', true);

      const { entries } = (await compare('AGUS', 'SARI').expect(200)).body;
      expect(entries).toEqual([
        expect.objectContaining({ entryId: review.entryId, title: 'Goal review', readerIs: 'invitee' }),
        expect.objectContaining({ entryId: block.entryId, title: '1:1 with Sari Puspita', readerIs: 'organiser' }),
      ]);
      // The Owner, on neither, coaches Agus: his block is his, not Sari's to hide, and reads as it did.
      const owner = (await compare('OWNER', 'SARI').expect(200)).body.entries;
      expect(Object.keys(owner[0]).sort()).toEqual(BUSY_KEYS);
      expect(owner[1]).toMatchObject({ entryId: block.entryId, title: '1:1 with Sari Puspita', readerIs: 'ancestor' });
    });

    it('P13.1-T8 AC-3 what the member organised is busy in another member’s pane too, though the leader coaches them', async () => {
      const call = await create('SARI', timed(4, '13:00', '14:00', { title: 'Joint call — Hartono', inviteeIds: [h.id('RINA')] }));
      // Agus compares Rina, who is on Sari's call; Agus coaches Sari, so he reads it in full while she shares.
      expect((await compare('AGUS', 'RINA').expect(200)).body.entries).toEqual([
        expect.objectContaining({ entryId: call.entryId, title: 'Joint call — Hartono', readerIs: 'ancestor' }),
      ]);
      await hide('SARI', true);
      const { entries } = (await compare('AGUS', 'RINA').expect(200)).body;
      expect(Object.keys(entries[0]).sort()).toEqual(BUSY_KEYS);
      expect(JSON.stringify(entries)).not.toContain('Hartono');
    });

    it('P13.1-T8 AC-3 the member’s own calendar, and the people on an entry, are unchanged', async () => {
      const visit = await create('SARI', timed(2, '10:00', '11:00', {
        type: 'client', title: 'Client visit — Kusuma', notes: 'Kusuma residence', inviteeIds: [h.id('RINA')],
      }));
      await hide('SARI', true);
      h.as('SARI');
      expect((await h.http().get('/calendar/entries').expect(200)).body.entries).toEqual([
        expect.objectContaining({ entryId: visit.entryId, notes: 'Kusuma residence', readerIs: 'organiser' }),
      ]);
      h.as('RINA');
      expect((await h.http().get('/calendar/entries').expect(200)).body.entries).toEqual([
        expect.objectContaining({ entryId: visit.entryId, notes: 'Kusuma residence', readerIs: 'invitee' }),
      ]);
      await h.http().get(`/calendar/entries/${visit.entryId}`).expect(200);
    });

    it('P13.1-T8 AC-3 a member who hides changes nothing about what they read of others', async () => {
      const rinas = await create('RINA', timed(1, '15:00', '16:00', { title: 'Prospect follow-up' }));
      await hide('SARI', true);
      expect((await compare('SARI', 'RINA').expect(200)).body.entries).toEqual([
        expect.objectContaining({ entryId: rinas.entryId, title: 'Prospect follow-up', readerIs: 'ancestor' }),
      ]);
    });
  });
});
