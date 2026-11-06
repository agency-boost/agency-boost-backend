import mongoose from 'mongoose';
import {
  startActivationHarness, stopActivationHarness, TODAY, type ActivationHarness, type Who,
} from '../../../test/activation-office';

type Row = {
  hire: { membershipId: string; name: string }; unit: { kind: string; leader: { membershipId: string; name: string } | null };
  joinDate: string; day: number; firstSaleDate: string | null; firstSaleDay: number | null; firstSaleSource: string | null;
  status: string; activation3M: string; leftOn: string | null;
  checklist: { state: string; done: number; total: number; pct: number; overdue: boolean } | null;
};
type Share = { activated: number; notActivated: number; late: number; inProgress: number; pct: number | null };
type Figures = { all: Share; byMonth: (Share & { month: string })[] };
type Roster = {
  today: string; window: { from: string; to: string }; days: number; activation3M: Figures;
  units: { kind: string; leader: { name: string } | null; activation3M: Figures }[];
  sections: Record<'inProgress' | 'activated' | 'notActivated', Row[]>;
};

/**
 * **P18.8-T6 — 3M activation and `/new-hires`, over HTTP** (ADR-0171 §2, ADR-0173). The activation harness: the
 * permission guard in front of the real services, the leads' routes for a first sale, and the production file's
 * corrections through the services. The clock is Monday 14 September 2026, 10:00 in Jakarta; the year listed runs from
 * 15 September 2025.
 */
describe('P18.8-T6 — 3M activation and /new-hires (ADR-0171 §2, ADR-0173)', () => {
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
      month, membershipId: id(who), kode: 'POLICY_COUNT', ytd: false, value, revision: state.revision,
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
    it('P18.8-T6 AC-3 lists the new hires who joined in the last twelve months — never an existing agent, never one older', async () => {
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

    it('UI-023 sections by status: a first sale by day 90 Teraktivasi at once, after it Teraktivasi late; no sale past day 90 not', async () => {
      await h.start('BUDI', '2026-07-15'); // day 62
      await sold('BUDI', 'Ibu Ratna', '2026-08-20T03:00:00Z');
      await h.start('INDAH', '2026-06-10'); // day 97
      await sold('INDAH', 'Pak Yusuf', '2026-07-01T03:00:00Z');
      await h.start('DIMAS', '2026-06-01'); // day 106, no sale
      await h.start('TARI', '2026-06-01'); // day 106 — Lukas's, an Agent who leads — sold on day 93
      await sold('TARI', 'Ibu Wati', '2026-09-01T03:00:00Z');
      const r = await roster();
      expect(names(r.sections.inProgress)).toEqual([]);
      // Teraktivasi — by day 90 or after it — by join date, newest first; ties by name.
      expect(names(r.sections.activated)).toEqual(['Budi Santoso', 'Indah Permatasari', 'Tari Anggraini']);
      expect(names(r.sections.notActivated)).toEqual(['Dimas Pratama']);
      // Budi sold on day 37: Teraktivasi the day it was recorded (rule A), not on day 91.
      expect(row(r, 'BUDI')).toMatchObject({
        day: 62, firstSaleDate: '2026-08-20', firstSaleDay: 37, firstSaleSource: 'sales', status: 'activated',
        activation3M: 'activated', leftOn: null,
      });
      // Tari sold on day 93: Teraktivasi in amber, her 3M result not activated.
      expect(row(r, 'TARI')).toMatchObject({
        day: 106, firstSaleDate: '2026-09-01', firstSaleDay: 93, status: 'activated_late', activation3M: 'not_activated',
      });
      expect(row(r, 'DIMAS')).toMatchObject({ status: 'not_yet', firstSaleDay: null, firstSaleSource: null, activation3M: 'not_activated' });
      expect(row(r, 'INDAH').checklist).toMatchObject({ state: 'open', overdue: true, total: 16 });
    });

    it('P18.8-T6 AC-1 a first sale on day 90 activates, on the office’s day; one at 00:30 on day 91 in Jakarta does not', async () => {
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

    it('P18.8-T6 AC-3 a new hire placed as an AAB has no checklist, and is listed with their result', async () => {
      await newHireWithoutChecklist('NINA', '2026-08-01');
      await h.start('DODI', '2026-08-10');
      const r = await roster('SARI');
      expect(row(r, 'NINA')).toMatchObject({ activation3M: 'in_progress', checklist: null, unit: { kind: 'direct' } });
      expect(row(r, 'DODI')).toMatchObject({ checklist: { state: 'open' }, unit: { kind: 'aab', leader: { name: 'Nina Lestari' } } });
    });
  });

  // ------------------------------------------------------------------ AC-2: the share, by month and unit

  describe('AC-2 the 3M activation %, for the reader, each unit, and each join month', () => {
    it('P18.8-T6 AC-2 activated ÷ (activated + not activated) for everybody listed and each unit, by join month', async () => {
      await h.start('INDAH', '2026-06-10');
      await sold('INDAH', 'Pak Yusuf', '2026-07-01T03:00:00Z'); // June: activated
      await h.start('DIMAS', '2026-06-01'); // June: not activated
      await h.start('RINA', '2026-05-20'); // May, Sari's: not activated
      await h.start('BUDI', '2026-07-15'); // July, Sari's: in progress
      const r = await roster();
      expect(r.activation3M.all).toEqual({ activated: 1, notActivated: 2, late: 0, inProgress: 1, pct: 33 });
      expect(r.activation3M.byMonth).toEqual([
        { month: '2026-07', activated: 0, notActivated: 0, late: 0, inProgress: 1, pct: null },
        { month: '2026-06', activated: 1, notActivated: 1, late: 0, inProgress: 0, pct: 50 },
        { month: '2026-05', activated: 0, notActivated: 1, late: 0, inProgress: 0, pct: 0 },
      ]);
      expect(r.units.map((u) => [u.kind, u.leader?.name ?? null, u.activation3M.all.pct])).toEqual([
        ['direct', null, 50], ['aab', 'Sari Puspita', 0],
      ]);
      // The AAB reads her own unit's: the same rows, the same figure.
      const sari = await roster('SARI');
      expect(sari.activation3M.all).toEqual(r.units[1].activation3M.all);
    });

    it('UI-023 rule A: a sale after day 90 is in neither part, nor is a hire inside their 90 days with none', async () => {
      await h.start('INDAH', '2026-06-10');
      await sold('INDAH', 'Pak Yusuf', '2026-07-01T03:00:00Z'); // day 22: activated
      await h.start('DIMAS', '2026-06-01'); // past day 90, no sale: not activated
      await h.start('TARI', '2026-06-01');
      await sold('TARI', 'Ibu Wati', '2026-09-01T03:00:00Z'); // day 93: late, in neither part
      await h.start('BUDI', '2026-07-15'); // Sari's, day 62, no sale: in neither part
      const r = await roster();
      expect(r.activation3M.all).toEqual({ activated: 1, notActivated: 1, late: 1, inProgress: 1, pct: 50 });
      // Each leader's group by the same function: Sari's one hire is undecided, so hers has no figure, never 0%.
      expect(r.units.map((u) => [u.leader?.name ?? 'Direct Unit', u.activation3M.all.pct])).toEqual([
        ['Direct Unit', 50], ['Sari Puspita', null],
      ]);
    });

    it('UI-023 cross-tenant: office B’s Teraktivasi hire is in office B’s figure alone — never in office A’s rows or share', async () => {
      await h.start('INDAH', '2026-06-10'); // office A: past day 90, no sale
      await h.start('B_AGENT', '2026-08-01');
      await sold('B_AGENT', 'Ibu Bayu', '2026-08-20T03:00:00Z'); // office B: day 20, Teraktivasi
      const a = await roster();
      expect(names(rows(a))).not.toContain('Bayu Saputra');
      expect(a.activation3M.all).toMatchObject({ activated: 0, notActivated: 1, pct: 0 });
      const b = await roster('B_AB');
      expect(rows(b).map((r) => [r.hire.name, r.status, r.firstSaleDay, r.firstSaleSource])).toEqual([['Bayu Saputra', 'activated', 20, 'sales']]);
      expect(b.activation3M.all).toMatchObject({ activated: 1, notActivated: 0, pct: 100 });
    });

    it('UI-023 the detail’s strip says what the row says: the status, the day and the first sale with its day and source', async () => {
      await h.start('BUDI', '2026-07-15'); // day 62
      await sold('BUDI', 'Ibu Ratna', '2026-08-20T03:00:00Z'); // day 37
      await h.start('TARI', '2026-06-01'); // day 106
      await sold('TARI', 'Ibu Wati', '2026-09-01T03:00:00Z'); // day 93
      const strip = async (as: Who, who: Who) => {
        h.as(as);
        return (await h.http().get(`/new-hires/${id(who)}`).expect(200)).body.newHire;
      };
      expect(await strip('SARI', 'BUDI')).toEqual({
        status: 'activated', activation3M: 'activated', joinDate: '2026-07-15', day: 62,
        firstSaleDate: '2026-08-20', firstSaleDay: 37, firstSaleSource: 'sales',
        // UI-027: the header's leader and the WhatsApp number (none on file here).
        leader: { membershipId: id('SARI'), name: 'Sari Puspita', role: 'aab' }, phone: null,
      });
      expect(await strip('LUKAS', 'TARI')).toMatchObject({ status: 'activated_late', activation3M: 'not_activated', firstSaleDay: 93 });
      // The row and the strip are one function.
      const row = (await roster()).sections.activated.find((r) => r.hire.membershipId === id('BUDI'))!;
      expect([row.status, row.firstSaleDay]).toEqual(['activated', 37]);
    });

    it('UI-027 (D-26) a pecah telor date alone, from the leader: a closing logged that day, the strip Teraktivasi, recorded by them', async () => {
      await h.start('BUDI', '2026-07-15'); // day 62
      h.as('SARI');
      // In the recorder's language: the closing it logs is named by the API, in Bahasa Indonesia here.
      const view = (await h.http().put(`/new-hires/${id('BUDI')}/items/FIRST_CASE_CLOSED`).set('Accept-Language', 'id')
        .send({ done: true, record: { kind: 'closing', date: '2026-08-13' } }).expect(200)).body;
      expect(view.newHire).toMatchObject({
        status: 'activated', firstSaleDate: '2026-08-13', firstSaleDay: 30, firstSaleSource: 'manual',
      });
      const tick = view.aspects.flatMap((a: { items: { code: string }[] }) => a.items)
        .find((it: { code: string }) => it.code === 'FIRST_CASE_CLOSED');
      // *Dicatat oleh*: the tick is the leader's.
      expect(tick).toMatchObject({ done: true, source: 'leader', doneBy: { membershipId: id('SARI') } });
      const lead = await h.col('leads').findOne({ ownerMembershipId: id('BUDI'), loggedFrom: 'activation_checklist' });
      expect(lead?.name).toBe('Pecah telor (tanggal dicatat manual)');
      // The row reads the same first sale.
      expect([row(await roster(), 'BUDI').status, row(await roster(), 'BUDI').firstSaleDay]).toEqual(['activated', 30]);
    });

    it('UI-027 (D-26) refused: a pecah telor before the join date or after today, 400 — nothing ticked or logged', async () => {
      await h.start('BUDI', '2026-07-15');
      h.as('SARI');
      for (const date of ['2026-07-14', '2026-09-15']) {
        await h.http().put(`/new-hires/${id('BUDI')}/items/FIRST_CASE_CLOSED`)
          .send({ done: true, record: { kind: 'closing', date } }).expect(400);
      }
      expect(await h.col('leads').countDocuments({ ownerMembershipId: id('BUDI') })).toBe(0);
    });

    it('UI-023 a sale inside the 90 days reads activated at once and keeps nothing; day 91 keeps it', async () => {
      await h.start('BUDI', '2026-07-15'); // day 62
      await sold('BUDI', 'Ibu Ratna', '2026-08-20T03:00:00Z');
      expect(row(await roster(), 'BUDI').activation3M).toBe('activated');
      // Inside the 90 days nothing is kept, so a wrong production file put right can still take its sale back (M4).
      expect((await member('BUDI')).activation3M ?? null).toBeNull();
    });
  });

  // ------------------------------------------------------------------ AC-1: the lock

  describe('AC-1 the result is kept once decided, and never moves', () => {
    it('P18.8-T6 AC-1 a read keeps each decided result on the membership; one in progress keeps nothing', async () => {
      await h.start('INDAH', '2026-06-10');
      await sold('INDAH', 'Pak Yusuf', '2026-07-01T03:00:00Z');
      await h.start('DIMAS', '2026-06-01');
      await h.start('BUDI', '2026-07-15');
      await roster();
      expect([(await member('INDAH')).activation3M, (await member('DIMAS')).activation3M, (await member('BUDI')).activation3M ?? null])
        .toEqual(['activated', 'not_activated', null]);
      expect((await member('DIMAS')).activation3MLockedAt).toEqual(h.clock.now());
    });

    it('P18.8-T6 AC-1 a closing logged after day 90 with an earlier day moves the first sale, and not the result', async () => {
      await h.start('DIMAS', '2026-06-01'); // day 106, nothing read yet: nothing kept
      expect((await member('DIMAS')).activation3M ?? null).toBeNull();
      h.as('AGUS');
      await h.http().put(`/new-hires/${id('DIMAS')}/items/FIRST_CASE_CLOSED`)
        .send({ done: true, record: { kind: 'closing', name: 'Ibu Ratna', date: '2026-07-01' } }).expect(200);
      // The write kept the result before the day landed.
      expect(await member('DIMAS')).toMatchObject({ firstSaleDate: '2026-07-01', firstSaleSource: 'manual', activation3M: 'not_activated' });
      expect(row(await roster(), 'DIMAS')).toMatchObject({ firstSaleDate: '2026-07-01', activation3M: 'not_activated' });
    });

    it('P18.8-T6 AC-1 a production file uploaded after day 90 for a month inside it does not activate them', async () => {
      await h.start('DIMAS', '2026-06-01');
      await policies('DIMAS', '2026-07', 1);
      expect(await member('DIMAS')).toMatchObject({ firstSaleDate: '2026-07-01', firstSaleSource: 'monthly_file', activation3M: 'not_activated' });
    });

    it('P18.8-T6 AC-1 inside the 90 days a late record counts: the result is decided from it on day 91', async () => {
      await h.start('BUDI', '2026-07-15'); // day 62
      await policies('BUDI', '2026-07', 1);
      expect((await member('BUDI')).activation3M ?? null).toBeNull();
      h.clock.set(new Date('2026-10-13T03:00:00Z')); // day 91
      expect(row(await roster('SARI'), 'BUDI')).toMatchObject({ firstSaleDate: '2026-07-15', activation3M: 'activated' });
    });

    it('P18.8-T6 AC-1 a join date corrected after day 90 moves the date and leaves the result', async () => {
      await h.start('DIMAS', '2026-06-01');
      h.as('AGUS');
      await h.http().put(`/new-hires/${id('DIMAS')}/start-date`).send({ startDate: '2026-08-01' }).expect(200);
      const r = await roster();
      expect(row(r, 'DIMAS')).toMatchObject({ joinDate: '2026-08-01', day: 45, activation3M: 'not_activated' });
      expect(names(r.sections.notActivated)).toEqual(['Dimas Pratama']);
    });

    it('P18.8-T6 AC-1 a read-only support session is answered the same result and keeps nothing', async () => {
      await h.start('DIMAS', '2026-06-01');
      const r = await roster(h.supporting('AGUS'));
      expect(row(r, 'DIMAS').activation3M).toBe('not_activated');
      expect((await member('DIMAS')).activation3M ?? null).toBeNull();
    });

    it('P18.8-T6 AC-1 the read keeps every decided result in at most two writes, whatever their number', async () => {
      for (const who of ['INDAH', 'DIMAS', 'RINA', 'BUDI', 'DODI'] as const) await h.start(who, '2026-05-01');
      await sold('INDAH', 'Pak Yusuf', '2026-06-01T03:00:00Z');
      const writes = jest.spyOn(h.wired.memberships, 'updateMany');
      await roster();
      expect(writes).toHaveBeenCalledTimes(2);
    });
  });

  // ------------------------------------------------------------------ AC-4: Mark left

  describe('UI-025 Mark left is retired (ADR-0180 §6)', () => {
    it('UI-025 POST /new-hires/:membershipId/left is gone: 404 to the leader who could mark, and nothing is written', async () => {
      await h.start('BUDI', '2026-07-15');
      const res = await left('SARI', 'BUDI').expect(404);
      expect(res.body.error.code).toBe('NOT_FOUND');
      const m = await member('BUDI');
      expect([m.status, m.leftAt ?? null]).toEqual(['active', null]);
      expect(await marks()).toEqual([]);
    });
  });

  // ------------------------------------------------------------------ the exit review: the file's first sale

  describe('the P18.8 exit review: a first sale the file no longer shows (M4)', () => {
    it('P18.8-T8 M4 a month’s policies corrected to none recompute a first sale the file gave: in progress, it is gone, and day 91 decides not activated', async () => {
      await h.start('BUDI', '2026-07-15'); // day 62
      await policies('BUDI', '2026-07', 1);
      expect(await member('BUDI')).toMatchObject({ firstSaleDate: '2026-07-15', firstSaleSource: 'monthly_file' });
      await policies('BUDI', '2026-07', 0); // the wrong figure put right
      const budi = await member('BUDI');
      expect([budi.firstSaleDate, budi.firstSaleSource, budi.firstSaleRecordId]).toEqual([null, null, null]);
      h.clock.set(new Date('2026-10-13T03:00:00Z')); // day 91
      expect(row(await roster('SARI'), 'BUDI')).toMatchObject({ firstSaleDate: null, activation3M: 'not_activated' });
    });

    it('P18.8-T8 M4 what remains is the first sale: a later month of the file, or a closing', async () => {
      await h.start('BUDI', '2026-07-15');
      await policies('BUDI', '2026-07', 1);
      await policies('BUDI', '2026-08', 2);
      await policies('BUDI', '2026-07', 0);
      expect(await member('BUDI')).toMatchObject({ firstSaleDate: '2026-08-01', firstSaleSource: 'monthly_file' });
      await sold('BUDI', 'Ibu Ratna', '2026-08-20T03:00:00Z');
      await policies('BUDI', '2026-08', 0);
      expect(await member('BUDI')).toMatchObject({ firstSaleDate: '2026-08-20', firstSaleSource: 'lead' });
    });

    it('P18.8-T8 M4 a kept 3M result stays, and so does the first sale it was decided by', async () => {
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

    it('P18.8-T8 M4 a first sale from a closing is never moved by the file', async () => {
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
