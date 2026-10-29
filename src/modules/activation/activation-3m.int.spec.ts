import mongoose from 'mongoose';
import type { RemovalService } from '@/modules/org/removal.service';
import {
  startActivationHarness, stopActivationHarness, TODAY, type ActivationHarness, type Who,
} from '../../../test/activation-office';
import { KPM_A } from '../../../test/coaching-office';

type Row = {
  hire: { membershipId: string; name: string }; unit: { kind: string; leader: { membershipId: string; name: string } | null };
  joinDate: string; day: number; firstSaleDate: string | null; activation3M: string; leftOn: string | null;
  checklist: { state: string; done: number; total: number; pct: number; overdue: boolean } | null;
};
type Share = { activated: number; notActivated: number; inProgress: number; pct: number | null };
type Figures = { all: Share; byMonth: (Share & { month: string })[] };
type Roster = {
  today: string; window: { from: string; to: string }; days: number; activation3M: Figures;
  units: { kind: string; leader: { name: string } | null; activation3M: Figures }[];
  sections: Record<'inProgress' | 'activated' | 'notActivated', Row[]>;
};

/**
 * **P18.96-T6 — 3M activation and `/new-hires`, over HTTP** (ADR-0171 §2, ADR-0173). The activation harness: the
 * permission guard in front of the real services, the leads' routes for a first sale, and the production file's
 * corrections through the services. The clock is Monday 14 September 2026, 10:00 in Jakarta; the year listed runs from
 * 15 September 2025.
 */
describe('P18.96-T6 — 3M activation and /new-hires (ADR-0171 §2, ADR-0173)', () => {
  let h: ActivationHarness;
  const id = (who: Who) => h.id(who);
  const oid = (who: Who) => new mongoose.Types.ObjectId(id(who));
  const member = async (who: Who) => (await h.col('memberships').findOne({ _id: oid(who) }))!;
  const roster = async (as: Who | Parameters<ActivationHarness['as']>[0] = 'AGUS'): Promise<Roster> => {
    h.as(as);
    return (await h.http().get('/new-hires').expect(200)).body as Roster;
  };
  const rows = (r: Roster) => Object.values(r.sections).flat();
  const row = (r: Roster, who: Who) => rows(r).find((x) => x.hire.membershipId === id(who))!;
  const names = (list: Row[]) => list.map((x) => x.hire.name);
  /** A new hire joined `joinDate` with no checklist: an AB or an AAB placed as one (ADR-0103). */
  const newHireWithoutChecklist = (who: Who, joinDate: string) =>
    h.col('memberships').updateOne({ _id: oid(who) }, { $set: { joinDate, joinedAs: 'new_hire' } });
  const existingAgent = (who: Who, joinDate: string) =>
    h.col('memberships').updateOne({ _id: oid(who) }, { $set: { joinDate, joinedAs: 'existing_agent' } });
  /** A sales lead of `who`'s walked to *Paid and issued* through the leads routes, at `at`. */
  const sold = async (who: Who, name: string, at: string) => {
    h.as(who);
    const created = (await h.http().post('/leads').send({ name, type: 'sales' }).expect(201)).body;
    h.clock.set(new Date(at));
    for (const code of ['NOT_YET_APPROACHED', 'POLICY_SUBMITTED', 'PAID_AND_ISSUED']) {
      await h.http().patch(`/leads/${created.id}/status`).send({ statusCode: code }).expect(200);
    }
    h.clock.set(new Date('2026-09-14T03:00:00Z'));
  };
  /** The production file's policies for `who` in `month`, as the Owner's correction writes them. */
  const policies = async (who: Who, month: string, value: number) => {
    const owner = h.office.as('OWNER');
    const state = await h.wired.productionMonths.reopen(owner, month);
    return h.wired.productionCorrections.correct(owner, {
      month, membershipId: id(who), metric: 'policyCount', cadence: 'monthly', value, revision: state.revision,
      reason: 'The carrier confirmed the policy',
    });
  };
  const left = (as: Parameters<ActivationHarness['as']>[0], who: Who) => {
    h.as(as);
    return h.http().post(`/new-hires/${id(who)}/left`);
  };
  const marks = () => h.col('auditLog').find({ action: 'new_hire.marked_left' }).toArray();

  beforeAll(async () => { h = await startActivationHarness(); });
  afterAll(async () => { await stopActivationHarness(h); });
  beforeEach(async () => { await h.reset(); });
  afterEach(() => { jest.restoreAllMocks(); });

  // ------------------------------------------------------------------ AC-3: the year, and the sections

  describe('AC-3 the year of new hires, in three sections', () => {
    it('P18.96-T6 AC-3 lists the new hires who joined in the last twelve months — never an existing agent, never one older', async () => {
      await h.start('INDAH', '2025-09-15'); // the first day of the year listed
      await h.start('DIMAS', '2025-09-14'); // twelve months back to the day: off the page, in the data
      await h.start('BUDI', '2026-07-15');
      await existingAgent('RINA', '2026-08-01'); // joined lately, as an existing agent: never listed
      const r = await roster();
      expect(r.window).toEqual({ from: '2025-09-15', to: TODAY });
      expect(names(rows(r)).sort()).toEqual(['Budi Santoso', 'Indah Permatasari']);
      expect(r).toMatchObject({ today: TODAY, days: 90 });
      // Still in the data: off the page is not gone.
      expect(await member('DIMAS')).toMatchObject({ joinedAs: 'new_hire', joinDate: '2025-09-14' });
    });

    it('P18.96-T6 AC-3 in progress through day 90, activated by a first sale on or before it, not activated otherwise', async () => {
      await h.start('BUDI', '2026-07-15'); // day 62
      await sold('BUDI', 'Ibu Ratna', '2026-08-20T03:00:00Z');
      await h.start('INDAH', '2026-06-10'); // day 97
      await sold('INDAH', 'Pak Yusuf', '2026-07-01T03:00:00Z');
      await h.start('DIMAS', '2026-06-01'); // day 106, no sale
      await h.start('TARI', '2026-06-01'); // day 106 — Lukas's, an Agent who leads — sold on day 93
      await sold('TARI', 'Ibu Wati', '2026-09-01T03:00:00Z');
      const r = await roster();
      expect(names(r.sections.inProgress)).toEqual(['Budi Santoso']);
      expect(names(r.sections.activated)).toEqual(['Indah Permatasari']);
      // By join date, newest first; ties by name.
      expect(names(r.sections.notActivated)).toEqual(['Dimas Pratama', 'Tari Anggraini']);
      expect(row(r, 'BUDI')).toMatchObject({ day: 62, firstSaleDate: '2026-08-20', activation3M: 'in_progress', leftOn: null });
      expect(row(r, 'TARI')).toMatchObject({ day: 106, firstSaleDate: '2026-09-01', activation3M: 'not_activated' });
      expect(row(r, 'INDAH').checklist).toMatchObject({ state: 'open', overdue: true, total: 16 });
    });

    it('P18.96-T6 AC-1 a first sale on day 90 activates, on the office’s day; one at 00:30 on day 91 in Jakarta does not', async () => {
      await h.start('BUDI', '2026-06-01'); // day 90 is 29 August
      await sold('BUDI', 'Ibu Ratna', '2026-08-29T03:00:00Z');
      await h.start('RINA', '2026-06-01');
      // 17:30 UTC on 29 August is 00:30 on 30 August in Jakarta: day 91.
      await sold('RINA', 'Pak Hendro', '2026-08-29T17:30:00Z');
      h.as('SARI');
      const r = (await h.http().get('/new-hires').expect(200)).body as Roster;
      expect([row(r, 'BUDI').activation3M, row(r, 'RINA').activation3M]).toEqual(['activated', 'not_activated']);
      expect(row(r, 'RINA').firstSaleDate).toBe('2026-08-30');
    });

    it('P18.96-T6 AC-3 a new hire placed as an AAB has no checklist, and is listed with their result', async () => {
      await newHireWithoutChecklist('NINA', '2026-08-01');
      await h.start('DODI', '2026-08-10');
      const r = await roster('SARI');
      expect(row(r, 'NINA')).toMatchObject({ activation3M: 'in_progress', checklist: null, unit: { kind: 'direct' } });
      expect(row(r, 'DODI')).toMatchObject({ checklist: { state: 'open' }, unit: { kind: 'aab', leader: { name: 'Nina Lestari' } } });
    });
  });

  // ------------------------------------------------------------------ AC-2: the share, by month and unit

  describe('AC-2 the 3M activation %, for the reader, each unit, and each join month', () => {
    it('P18.96-T6 AC-2 activated ÷ (activated + not activated) for everybody listed and each unit, by join month', async () => {
      await h.start('INDAH', '2026-06-10');
      await sold('INDAH', 'Pak Yusuf', '2026-07-01T03:00:00Z'); // June: activated
      await h.start('DIMAS', '2026-06-01'); // June: not activated
      await h.start('RINA', '2026-05-20'); // May, Sari's: not activated
      await h.start('BUDI', '2026-07-15'); // July, Sari's: in progress
      const r = await roster();
      expect(r.activation3M.all).toEqual({ activated: 1, notActivated: 2, inProgress: 1, pct: 33 });
      expect(r.activation3M.byMonth).toEqual([
        { month: '2026-07', activated: 0, notActivated: 0, inProgress: 1, pct: null },
        { month: '2026-06', activated: 1, notActivated: 1, inProgress: 0, pct: 50 },
        { month: '2026-05', activated: 0, notActivated: 1, inProgress: 0, pct: 0 },
      ]);
      expect(r.units.map((u) => [u.kind, u.leader?.name ?? null, u.activation3M.all.pct])).toEqual([
        ['direct', null, 50], ['aab', 'Sari Puspita', 0],
      ]);
      // The AAB reads her own unit's: the same rows, the same figure.
      const sari = await roster('SARI');
      expect(sari.activation3M.all).toEqual(r.units[1].activation3M.all);
    });
  });

  // ------------------------------------------------------------------ AC-1: the lock

  describe('AC-1 the result is kept once decided, and never moves', () => {
    it('P18.96-T6 AC-1 a read keeps each decided result on the membership; one in progress keeps nothing', async () => {
      await h.start('INDAH', '2026-06-10');
      await sold('INDAH', 'Pak Yusuf', '2026-07-01T03:00:00Z');
      await h.start('DIMAS', '2026-06-01');
      await h.start('BUDI', '2026-07-15');
      await roster();
      expect([(await member('INDAH')).activation3M, (await member('DIMAS')).activation3M, (await member('BUDI')).activation3M ?? null])
        .toEqual(['activated', 'not_activated', null]);
      expect((await member('DIMAS')).activation3MLockedAt).toEqual(h.clock.now());
    });

    it('P18.96-T6 AC-1 a closing logged after day 90 with an earlier day moves the first sale, and not the result', async () => {
      await h.start('DIMAS', '2026-06-01'); // day 106, nothing read yet: nothing kept
      expect((await member('DIMAS')).activation3M ?? null).toBeNull();
      h.as('AGUS');
      await h.http().put(`/new-hires/${id('DIMAS')}/items/FIRST_CASE_CLOSED`)
        .send({ done: true, record: { kind: 'closing', name: 'Ibu Ratna', date: '2026-07-01' } }).expect(200);
      // The write kept the result before the day landed.
      expect(await member('DIMAS')).toMatchObject({ firstSaleDate: '2026-07-01', firstSaleSource: 'manual', activation3M: 'not_activated' });
      expect(row(await roster(), 'DIMAS')).toMatchObject({ firstSaleDate: '2026-07-01', activation3M: 'not_activated' });
    });

    it('P18.96-T6 AC-1 a production file uploaded after day 90 for a month inside it does not activate them', async () => {
      await h.start('DIMAS', '2026-06-01');
      await policies('DIMAS', '2026-07', 1);
      expect(await member('DIMAS')).toMatchObject({ firstSaleDate: '2026-07-01', firstSaleSource: 'monthly_file', activation3M: 'not_activated' });
    });

    it('P18.96-T6 AC-1 inside the 90 days a late record counts: the result is decided from it on day 91', async () => {
      await h.start('BUDI', '2026-07-15'); // day 62
      await policies('BUDI', '2026-07', 1);
      expect((await member('BUDI')).activation3M ?? null).toBeNull();
      h.clock.set(new Date('2026-10-13T03:00:00Z')); // day 91
      expect(row(await roster('SARI'), 'BUDI')).toMatchObject({ firstSaleDate: '2026-07-15', activation3M: 'activated' });
    });

    it('P18.96-T6 AC-1 a join date corrected after day 90 moves the date and leaves the result', async () => {
      await h.start('DIMAS', '2026-06-01');
      h.as('AGUS');
      await h.http().put(`/new-hires/${id('DIMAS')}/start-date`).send({ startDate: '2026-08-01' }).expect(200);
      const r = await roster();
      expect(row(r, 'DIMAS')).toMatchObject({ joinDate: '2026-08-01', day: 45, activation3M: 'not_activated' });
      expect(names(r.sections.notActivated)).toEqual(['Dimas Pratama']);
    });

    it('P18.96-T6 AC-1 a read-only support session is answered the same result and keeps nothing', async () => {
      await h.start('DIMAS', '2026-06-01');
      const r = await roster(h.supporting('AGUS'));
      expect(row(r, 'DIMAS').activation3M).toBe('not_activated');
      expect((await member('DIMAS')).activation3M ?? null).toBeNull();
    });

    it('P18.96-T6 AC-1 the read keeps every decided result in at most two writes, whatever their number', async () => {
      for (const who of ['INDAH', 'DIMAS', 'RINA', 'BUDI', 'DODI'] as const) await h.start(who, '2026-05-01');
      await sold('INDAH', 'Pak Yusuf', '2026-06-01T03:00:00Z');
      const writes = jest.spyOn(h.wired.memberships, 'updateMany');
      await roster();
      expect(writes).toHaveBeenCalledTimes(2);
    });
  });

  // ------------------------------------------------------------------ AC-4: Mark left

  describe('AC-4 Mark left', () => {
    it('P18.96-T6 AC-4 a leader marks a new hire left: today, the result decided and kept, audited — and removed from the office', async () => {
      await h.start('BUDI', '2026-07-15');
      await sold('BUDI', 'Ibu Ratna', '2026-08-20T03:00:00Z');
      await h.start('DODI', '2026-08-10');
      const budi = (await left('SARI', 'BUDI').expect(200)).body;
      expect(budi).toEqual({ membershipId: id('BUDI'), leftAt: h.clock.now().toISOString(), leftOn: TODAY, activation3M: 'activated' });
      // Left before any sale: not activated, at once, inside the 90 days.
      expect((await left('SARI', 'DODI').expect(200)).body.activation3M).toBe('not_activated');
      /*
       * ADR-0169 §4 as amended 2026-10-27: leaving removes them, through the removal's own path — the status and
       * `removedAt` the same instant, the edge closed and a `removed` one opened, `member.removed` — so they leave every
       * count of people as any leaver does. Their leader stays on the row, as a removal keeps it; the checklist stays.
       */
      const stored = await member('DODI');
      expect(stored).toMatchObject({
        status: 'removed', removedAt: h.clock.now(), leaderId: id('NINA'), activation3M: 'not_activated', leftAt: h.clock.now(),
      });
      expect(await h.col('membershipHistory').find({ membershipId: id('DODI'), validTo: null }).toArray())
        .toEqual([expect.objectContaining({ eventType: 'removed', actorMembershipId: id('SARI') })]);
      expect(await h.col('auditLog').countDocuments({ action: 'member.removed', targetMembershipId: id('DODI') })).toBe(1);
      expect(await h.col('activationProgress').findOne({ membershipId: id('DODI') })).toMatchObject({ graduatedAt: null });
      // Out of reach of every leader's routes now — and still on the year's list, by result.
      h.as('SARI');
      await h.http().get(`/new-hires/${id('DODI')}`).expect(404);
      const r = await roster('SARI');
      expect(r.sections.notActivated.map((x) => [x.hire.name, x.leftOn])).toEqual([['Dodi Kurniawan', TODAY]]);
      expect(r.sections.activated.map((x) => [x.hire.name, x.leftOn])).toEqual([['Budi Santoso', TODAY]]);
      expect((await marks()).map((m) => [m.targetMembershipId, m.actorMembershipId, m.targetCollection, m.before, m.after])).toEqual([
        [id('BUDI'), id('SARI'), 'memberships', { leftAt: null, activation3M: null }, { leftAt: h.clock.now().toISOString(), activation3M: 'activated' }],
        [id('DODI'), id('SARI'), 'memberships', { leftAt: null, activation3M: null }, { leftAt: h.clock.now().toISOString(), activation3M: 'not_activated' }],
      ]);
    });

    it('P18.96-T6 AC-4 leaving after day 90 changes nothing: the 90 days decided it, kept first', async () => {
      await h.start('DIMAS', '2026-06-01');
      expect((await left('AGUS', 'DIMAS').expect(200)).body.activation3M).toBe('not_activated');
      expect(await member('DIMAS')).toMatchObject({ activation3M: 'not_activated' });
    });

    it('P18.96-T6 AC-4 refused: a second time 409 NEW_HIRE_ALREADY_LEFT, an existing agent 409 NOT_A_NEW_HIRE — nothing written', async () => {
      await h.start('BUDI', '2026-07-15');
      await left('SARI', 'BUDI').expect(200);
      const again = await left('SARI', 'BUDI').expect(409);
      expect(again.body.error).toMatchObject({ code: 'NEW_HIRE_ALREADY_LEFT', details: { leftOn: TODAY } });
      await existingAgent('RINA', '2026-08-01');
      expect((await left('SARI', 'RINA').expect(409)).body.error.code).toBe('NOT_A_NEW_HIRE');
      expect((await member('RINA')).leftAt ?? null).toBeNull();
      expect(await marks()).toHaveLength(1);
    });

    it('P18.96-T6 AC-4 refused 409 NEW_HIRE_HAS_REPORTS for a new hire who leads somebody — nothing written', async () => {
      await h.start('LUKAS', '2026-08-01'); // an Agent with a direct report, Tari
      const res = await left('AGUS', 'LUKAS').expect(409);
      expect(res.body.error).toMatchObject({ code: 'NEW_HIRE_HAS_REPORTS', details: { directCount: 1 } });
      expect(res.body.error.message).toBe('1 person reports to them. Move them to another leader before marking them as left.');
      expect(await member('LUKAS')).toMatchObject({ status: 'active' });
      expect((await member('LUKAS')).leftAt ?? null).toBeNull();
      expect(await marks()).toEqual([]);
    });

    it('P18.98-T5 AC-7 refuses Mark left in Indonesian: the same code and details, in the reader’s words', async () => {
      await h.start('LUKAS', '2026-08-01'); // an Agent with a direct report, Tari
      expect((await left('AGUS', 'LUKAS').set('Accept-Language', 'id').expect(409)).body.error).toMatchObject({
        code: 'NEW_HIRE_HAS_REPORTS', details: { directCount: 1 },
        message: '1 orang melapor kepadanya. Pindahkan orang itu ke leader lain sebelum menandainya keluar.',
      });
      await existingAgent('RINA', '2026-08-01');
      expect((await left('SARI', 'RINA').set('Accept-Language', 'id').expect(409)).body.error).toMatchObject({
        code: 'NOT_A_NEW_HIRE',
        message: 'Dia bergabung sebagai agent yang sudah ada, jadi tidak ada 3M activation yang perlu diakhiri. Hanya new hire '
          + 'yang dapat ditandai keluar.',
      });
      await h.start('DODI', '2024-03-01');
      expect((await left('AGUS', 'DODI').set('Accept-Language', 'id').expect(409)).body.error).toMatchObject({
        code: 'NEW_HIRE_NOT_MARKABLE', details: { reason: 'past_the_year', joinDate: '2024-03-01' },
        message: 'Dia bergabung lebih dari setahun yang lalu, jadi dia tidak lagi ada di New Hires dan tidak ada hasil 3M yang '
          + 'perlu ditentukan. Untuk mengeluarkannya dari tim, keluarkan dia.',
      });
      await h.start('BUDI', '2026-07-15');
      await left('SARI', 'BUDI').expect(200);
      expect((await left('SARI', 'BUDI').set('Accept-Language', 'id').expect(409)).body.error).toMatchObject({
        code: 'NEW_HIRE_ALREADY_LEFT', message: 'Dia sudah ditandai keluar.', details: { leftOn: TODAY },
      });
    });

    it('P18.98-T5 AC-6 stores the reason Mark left writes in the language of whoever marks it — kept as written', async () => {
      await h.start('BUDI', '2026-07-15');
      await h.start('INDAH', '2026-07-20');
      await left('SARI', 'BUDI').expect(200);
      await left(h.officeOnly('OWNER'), 'INDAH').set('Accept-Language', 'id').expect(200);
      const reasonOf = async (who: Who) =>
        (await h.col('membershipHistory').findOne({ membershipId: id(who), eventType: 'removed' }))!.reason;
      expect(await reasonOf('BUDI')).toBe('Left the office as a new hire.');
      expect(await reasonOf('INDAH')).toBe('Keluar dari KPM sebagai new hire.');
      // Stored as text: a later read in the other language, or a later writer, changes neither.
      h.as('SARI');
      await h.http().get('/new-hires').set('Accept-Language', 'id').expect(200);
      expect(await reasonOf('BUDI')).toBe('Left the office as a new hire.');
      const removed = await h.col('auditLog').find({ action: 'member.removed' }).toArray();
      expect(removed.map((entry) => entry.after.reason).sort())
        .toEqual(['Keluar dari KPM sebagai new hire.', 'Left the office as a new hire.']);
    });

    it('P18.96-T6 AC-4 permitted: the hire’s AAB, the AB above, the Owner and an Admin as such — new_hire:mark_left', async () => {
      for (const [as, who] of [
        ['SARI', 'BUDI'], ['AGUS', 'RINA'], [h.officeOnly('OWNER'), 'DODI'], [h.officeOnly('ADMIN'), 'INDAH'],
      ] as const) {
        await h.start(who, '2026-08-01');
        const res = await left(as, who);
        expect([who, res.status]).toEqual([who, 200]);
      }
      expect(await marks()).toHaveLength(4);
    });

    it('P18.96-T6 AC-4 refused: an Agent who leads 403, a read-only session 403; a peer, Dewi, oneself and a removed member 404', async () => {
      await h.start('TARI', '2026-08-01');
      await h.start('BUDI', '2026-08-01');
      expect((await left('LUKAS', 'TARI').expect(403)).body.error.code).toBe('PERM_DENIED');
      expect((await left(h.supporting('SARI'), 'BUDI').expect(403)).body.error.code).toBe('PERM_DENIED');
      for (const [as, who] of [['PEER_AB', 'BUDI'], ['DEWI', 'BUDI'], ['AGUS', 'AGUS'], ['AGUS', 'LEFT'], ['PEER_AAB', 'TARI']] as const) {
        const res = await left(as, who);
        expect([as, who, res.status, res.body.error?.code]).toEqual([as, who, 404, 'NOT_FOUND']);
      }
      expect(await marks()).toEqual([]);
      expect((await member('BUDI')).leftAt ?? null).toBeNull();
    });

    it('P18.96-T6 AC-4 cross-tenant: office A’s leaders and Owner cannot mark office B’s new hire; office B’s leader can', async () => {
      await h.start('B_AGENT', '2026-08-01');
      for (const as of ['AGUS', h.officeOnly('OWNER')] as const) {
        expect((await left(as, 'B_AGENT').expect(404)).body.error.code).toBe('NOT_FOUND');
      }
      expect((await member('B_AGENT')).leftAt ?? null).toBeNull();
      await left('B_AB', 'B_AGENT').expect(200);
    });

    it('P18.96-T6 AC-4 an elevated support session marks as its member, both actors on the record', async () => {
      await h.start('BUDI', '2026-08-01');
      await left(h.supporting('SARI', false), 'BUDI').expect(200);
      expect((await marks()).map((m) => [m.actorUserId, m.effectiveUserId, m.actorMembershipId])).toEqual([['u-support', 'u-SARI', id('SARI')]]);
    });
  });

  // ------------------------------------------------------------------ the exit review: no wider than the removal

  describe('the P18.96 exit review: Mark left is no wider than the removal it ends in', () => {
    /** Nobody marked, removed or audited as removed: the refusal wrote nothing. */
    const nothingWritten = async (...who: Who[]) => {
      for (const w of who) {
        const m = await member(w);
        expect([w, m.status, m.leftAt ?? null, m.activation3M ?? null]).toEqual([w, 'active', null, null]);
      }
      expect(await marks()).toEqual([]);
      expect(await h.col('auditLog').countDocuments({ action: 'member.removed' })).toBe(0);
    };

    it('P18.96-T8 M1 the office’s root is refused 403 ORG_REMOVAL_NOT_PERMITTED, as the removal refuses it — nothing written', async () => {
      await h.start('OWNER', '2026-08-01'); // the root: no leader
      const res = await left(h.officeOnly('ADMIN'), 'OWNER').expect(403);
      expect(res.body.error).toMatchObject({
        code: 'ORG_REMOVAL_NOT_PERMITTED', message: 'The office’s root member cannot be removed. Reassign the office first.',
      });
      await nothingWritten('OWNER');
    });

    it('P18.96-T8 M1 the office’s owner who has a leader is refused 403 ORG_REMOVAL_NOT_PERMITTED — to their leader and an Admin', async () => {
      await h.start('INDAH', '2026-08-01');
      // Ownership moved to a member, who keeps her leader (`RemovalService.refuseTheOffice`'s second rule).
      const kpm = { _id: new mongoose.Types.ObjectId(KPM_A) };
      expect((await h.col('kpms').updateOne(kpm, { $set: { ownerUserId: (await member('INDAH')).userId } })).modifiedCount).toBe(1);
      try {
        for (const as of ['AGUS', h.officeOnly('ADMIN')] as const) {
          const res = await left(as, 'INDAH').expect(403);
          expect(res.body.error).toMatchObject({
            code: 'ORG_REMOVAL_NOT_PERMITTED', message: 'They own this office. Transfer it first — only the platform can do that.',
          });
        }
        await nothingWritten('INDAH');
      } finally {
        await h.col('kpms').updateOne(kpm, { $unset: { ownerUserId: '' } });
      }
    });

    it('P18.96-T8 M2 refused 409 NEW_HIRE_NOT_MARKABLE outside the year: three levels down and two years on, or twelve months to the day', async () => {
      await h.start('DODI', '2024-03-01'); // Agus ─ Sari ─ Nina ─ Dodi: the removal is Nina's to make, or the office's
      const old = await left('AGUS', 'DODI').expect(409);
      expect(old.body.error).toMatchObject({
        code: 'NEW_HIRE_NOT_MARKABLE', details: { reason: 'past_the_year', joinDate: '2024-03-01' },
      });
      await h.start('DIMAS', '2025-09-14'); // off the page by a day (`newHiresWindow`)
      expect((await left('AGUS', 'DIMAS').expect(409)).body.error.details.reason).toBe('past_the_year');
      // The Owner is held to the same.
      expect((await left(h.officeOnly('OWNER'), 'DODI').expect(409)).body.error.code).toBe('NEW_HIRE_NOT_MARKABLE');
      await nothingWritten('DODI', 'DIMAS');
    });

    it('P18.96-T8 M2 accepted anywhere inside the year: the year’s first day, in progress with a sale, and activated past day 90', async () => {
      await h.start('RINA', '2025-09-15'); // the first day of the year listed, not activated
      expect((await left('SARI', 'RINA').expect(200)).body.activation3M).toBe('not_activated');
      await h.start('BUDI', '2026-07-15'); // day 62, sold on day 37: still in progress
      await sold('BUDI', 'Ibu Ratna', '2026-08-20T03:00:00Z');
      expect((await left('SARI', 'BUDI').expect(200)).body.activation3M).toBe('activated');
      // Activated, day 97, its checklist overdue: the page offers Mark left on it, and the result stays activated.
      await h.start('INDAH', '2026-06-10');
      await sold('INDAH', 'Pak Yusuf', '2026-07-01T03:00:00Z');
      expect(row(await roster(), 'INDAH')).toMatchObject({ activation3M: 'activated', checklist: { overdue: true } });
      expect((await left('AGUS', 'INDAH').expect(200)).body.activation3M).toBe('activated');
    });

    it('P18.96-T8 L5 a removal that fails leaves them as they were — active, no leftAt, nothing kept or audited — and marking again works', async () => {
      await h.start('BUDI', '2026-08-01');
      const removal = (h.wired.activation3M as unknown as { removal: RemovalService }).removal;
      jest.spyOn(removal, 'depart').mockRejectedValueOnce(new Error('the database went away'));
      await left('SARI', 'BUDI').expect(500);
      await nothingWritten('BUDI');
      expect((await left('SARI', 'BUDI').expect(200)).body.activation3M).toBe('not_activated');
      expect(await member('BUDI')).toMatchObject({ status: 'removed', activation3M: 'not_activated' });
    });
  });

  // ------------------------------------------------------------------ the exit review: a withdrawn file

  describe('the P18.96 exit review: a first sale the file no longer shows (M4)', () => {
    it('P18.96-T8 M4 a month’s policies corrected to none recompute a first sale the file gave: in progress, it is gone, and day 91 decides not activated', async () => {
      await h.start('BUDI', '2026-07-15'); // day 62
      await policies('BUDI', '2026-07', 1);
      expect(await member('BUDI')).toMatchObject({ firstSaleDate: '2026-07-15', firstSaleSource: 'monthly_file' });
      await policies('BUDI', '2026-07', 0); // the wrong figure put right
      const budi = await member('BUDI');
      expect([budi.firstSaleDate, budi.firstSaleSource, budi.firstSaleRecordId]).toEqual([null, null, null]);
      h.clock.set(new Date('2026-10-13T03:00:00Z')); // day 91
      expect(row(await roster('SARI'), 'BUDI')).toMatchObject({ firstSaleDate: null, activation3M: 'not_activated' });
    });

    it('P18.96-T8 M4 what remains is the first sale: a later month of the file, or a closing', async () => {
      await h.start('BUDI', '2026-07-15');
      await policies('BUDI', '2026-07', 1);
      await policies('BUDI', '2026-08', 2);
      await policies('BUDI', '2026-07', 0);
      expect(await member('BUDI')).toMatchObject({ firstSaleDate: '2026-08-01', firstSaleSource: 'monthly_file' });
      await sold('BUDI', 'Ibu Ratna', '2026-08-20T03:00:00Z');
      await policies('BUDI', '2026-08', 0);
      expect(await member('BUDI')).toMatchObject({ firstSaleDate: '2026-08-20', firstSaleSource: 'lead' });
    });

    it('P18.96-T8 M4 a kept 3M result stays, and so does the first sale it was decided by', async () => {
      await h.start('INDAH', '2026-06-10');
      h.clock.set(new Date('2026-08-01T03:00:00Z')); // day 53: the file lands inside the 90 days
      await policies('INDAH', '2026-07', 1);
      h.clock.set(new Date('2026-09-14T03:00:00Z')); // day 97: read, decided and kept from it
      await roster();
      expect(await member('INDAH')).toMatchObject({ activation3M: 'activated', firstSaleDate: '2026-07-01' });
      await policies('INDAH', '2026-07', 0);
      expect(await member('INDAH')).toMatchObject({
        activation3M: 'activated', firstSaleDate: '2026-07-01', firstSaleSource: 'monthly_file',
      });
    });

    it('P18.96-T8 M4 a first sale from a closing is never moved by the file', async () => {
      await h.start('BUDI', '2026-07-15');
      await sold('BUDI', 'Ibu Ratna', '2026-08-20T03:00:00Z');
      await policies('BUDI', '2026-08', 1); // the 1st of August: earlier, from the file
      await policies('BUDI', '2026-08', 0);
      // The file's month went, so the closing is what remains — later, and from the leads.
      expect(await member('BUDI')).toMatchObject({ firstSaleDate: '2026-08-20', firstSaleSource: 'lead' });
      await policies('BUDI', '2026-07', 0); // a month with nothing in it: nothing to withdraw
      expect(await member('BUDI')).toMatchObject({ firstSaleDate: '2026-08-20', firstSaleSource: 'lead' });
    });
  });
});
