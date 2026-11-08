import mongoose from 'mongoose';
import type { Test } from 'supertest';
import {
  startActivationHarness, stopActivationHarness, TODAY, type ActivationHarness, type Who,
} from '../../../test/activation-office';

type Item = { code: string; done: boolean; source: string | null; doneBy: { membershipId: string } | null; note: string | null; date: string | null };
const item = (view: { aspects: { items: Item[] }[] }, code: string) => view.aspects.flatMap((a) => a.items).find((i) => i.code === code)!;

/**
 * **A leader's new hires over HTTP** (P13-T5, P13-T6, and the read P13-T9's coaching tab makes): the roster
 * and its groups, one hire's activation, a leader's tick, the start date's correction and the coaching note
 * — reach by `COACH`, 404 outside it, each read recorded, each write audited.
 */
describe('a leader’s new hires over HTTP (Phase 13)', () => {
  let h: ActivationHarness;
  const id = (who: Who) => h.id(who);
  const reads = () => h.col('auditLog').find({ action: 'activity_log.read_raw', 'after.surface': 'activation' }).toArray();
  const writes = () => h.col('auditLog').find({ action: { $regex: '^activation\\.' } }).sort({ createdAt: 1 }).toArray();
  type Row = {
    hire: { membershipId: string; name: string }; unit: { kind: string; leader: { membershipId: string; name: string } | null };
    joinDate: string; day: number; firstSaleDate: string | null; activation3M: string; leftOn: string | null;
    checklist: { state: string; done: number; total: number; pct: number; overdue: boolean } | null;
  };
  const roster = async () => (await h.http().get('/new-hires').expect(200)).body as {
    today: string;
    sections: Record<'inProgress' | 'activated' | 'notActivated', Row[]>;
    units: { kind: string; leader: { membershipId: string; name: string } | null }[];
  };
  /**
   * P18.8-T6 (ADR-0173): the roster is sections by 3M result now, each row naming its unit. `shape` keeps the D-group
   * grouping these tests pin — the units in their order, each with its rows by day, highest first.
   */
  const shape = (r: Awaited<ReturnType<typeof roster>>) => {
    const rows = Object.values(r.sections).flat();
    return r.units.map((u) => [
      u.kind, u.leader?.name ?? null,
      rows.filter((x) => (x.unit.leader?.membershipId ?? null) === (u.leader?.membershipId ?? null))
        .sort((a, b) => b.day - a.day).map((x) => `${x.hire.name} ${x.day}`),
    ]);
  };
  const rowOf = (r: Awaited<ReturnType<typeof roster>>, name: string) => Object.values(r.sections).flat().find((x) => x.hire.name === name)!;

  /** Six hires across Agus's downline, each a different day. */
  async function sixHires() {
    await h.start('INDAH', '2026-06-10'); // day 97, past the window
    await h.start('DIMAS', '2026-08-20'); // day 26
    await h.start('TARI', '2026-08-01'); // day 45, under Lukas — an Agent who leads
    await h.start('RINA', '2026-07-18'); // day 59
    await h.start('BUDI', '2026-07-15'); // day 62
    await h.start('DODI', '2026-09-01'); // day 14, under Nina, under Sari
  }

  beforeAll(async () => { h = await startActivationHarness(); });
  afterAll(async () => { await stopActivationHarness(h); });
  beforeEach(async () => { await h.reset(); });
  afterEach(() => { jest.restoreAllMocks(); });

  describe('GET /new-hires (D-group, OD-122)', () => {
    it('P13-T5 AC-2 Agus: Direct Unit first, then a card per AAB below him, each hire under the nearest; rows by day, highest first', async () => {
      await sixHires();
      h.as('AGUS');
      const r = await roster();
      expect(r.today).toBe(TODAY);
      expect(shape(r)).toEqual([
        // Tari is Lukas's, and Lukas is an Agent: no unit of his own between Agus and her.
        ['direct', null, ['Indah Permatasari 97', 'Tari Anggraini 45', 'Dimas Pratama 26']],
        // Dewi leads nobody, so her card is hidden. The cards by the leader's name, A to Z.
        ['aab', 'Nina Lestari', ['Dodi Kurniawan 14']],
        ['aab', 'Sari Puspita', ['Budi Santoso 62', 'Rina Wijaya 59']],
      ]);
      // P18.8-T6: past day 90 with no first sale, Indah is not activated; her checklist is overdue as before.
      expect(rowOf(r, 'Indah Permatasari')).toEqual({
        hire: { membershipId: id('INDAH'), name: 'Indah Permatasari' }, unit: { kind: 'direct', leader: null },
        joinDate: '2026-06-10', day: 97, firstSaleDate: null, firstSaleDay: null, firstSaleSource: null, status: 'not_yet',
        activation3M: 'not_activated', leftOn: null, checklist: { state: 'open', done: 1, total: 16, pct: 6, overdue: true },
      });
      expect(r.units[2].leader).toEqual({ membershipId: id('SARI'), name: 'Sari Puspita' });
    });

    it('Phase 13 exit review the leader cards are A to Z by the leader’s full name, Direct Unit first — not in COACH’s order, nearest first', async () => {
      await sixHires();
      await h.start('PEER_AGENT', '2026-08-10'); // day 36, under Putu Ayu, under Hendra
      h.as('OWNER');
      // COACH's order would put Agus (nearest) first, then Sari and Nina and Putu at the next depths.
      const r = await roster();
      expect(r.units.map((g) => [g.kind, g.leader?.name ?? null])).toEqual([
        ['ab', 'Agus Salim'], ['aab', 'Nina Lestari'], ['aab', 'Putu Ayu'], ['aab', 'Sari Puspita'],
      ]);
      expect(shape(r).map(([, , rows]) => (rows as string[]).map((x) => Number(x.split(' ').pop())))).toEqual([[97, 45, 26], [14], [36], [62, 59]]);
      // And the reader's own Direct Unit always leads.
      h.as('SARI');
      expect((await roster()).units.map((g) => [g.kind, g.leader?.name ?? null])).toEqual([['direct', null], ['aab', 'Nina Lestari']]);
    });

    it('P13-T5 AC-2 an AB under the reader names the rung: the Owner’s roster has an AB card for Agus', async () => {
      await sixHires();
      h.as('OWNER');
      expect(shape(await roster())).toEqual([
        ['ab', 'Agus Salim', ['Indah Permatasari 97', 'Tari Anggraini 45', 'Dimas Pratama 26']],
        ['aab', 'Nina Lestari', ['Dodi Kurniawan 14']],
        ['aab', 'Sari Puspita', ['Budi Santoso 62', 'Rina Wijaya 59']],
      ]);
    });

    it('P13-T5 AC-3 Sari’s is her own unit and Nina’s below it; OD-122 Lukas, an Agent with a direct report, has his', async () => {
      await sixHires();
      h.as('SARI');
      expect(shape(await roster())).toEqual([
        ['direct', null, ['Budi Santoso 62', 'Rina Wijaya 59']],
        ['aab', 'Nina Lestari', ['Dodi Kurniawan 14']],
      ]);
      h.as('LUKAS');
      expect(shape(await roster())).toEqual([['direct', null, ['Tari Anggraini 45']]]);
    });

    it('P13-T5 AC-2 Active Agent is FIRST_CASE_CLOSED done, whoever ticked it', async () => {
      await sixHires();
      h.as('SARI');
      // P18.8-T4 AC-3: ticked by hand with the closing it names, logged in Budi's leads — waiting for data, and done.
      await h.http().put(`/new-hires/${id('BUDI')}/items/FIRST_CASE_CLOSED`)
        .send({ done: true, record: { kind: 'closing', name: 'Ibu Ratna', date: '2026-09-01' } }).expect(200);
      const budi = rowOf(await roster(), 'Budi Santoso');
      // Two of sixteen: the closing is a lead in his pipeline, so *Add prospects* completes from it too. P18.8-T6: the
      // row carries his first sale — the logged closing's day — where the *Active Agent* ✓ was. UI-023: a first sale by day
      // 90 is Teraktivasi at once, and a closing logged from the checklist is the leader's own record — `manual` (D-26).
      expect(budi).toMatchObject({
        firstSaleDate: '2026-09-01', firstSaleSource: 'manual', status: 'activated', activation3M: 'activated', checklist: { pct: 13 },
      });
    });

    it('P18.8-T6 AC-3 a graduated or expired checklist no longer takes its hire off: the year lists them, by result', async () => {
      // Amends P13-T5 AC-3 (ADR-0173 §1): the page lists new hires of the last twelve months, not open activations.
      await h.start('RINA', '2026-07-18', { graduatedAt: new Date('2026-09-10T02:00:00Z'), graduatedByMembershipId: id('RINA') });
      await h.start('BUDI', '2026-03-10');
      await h.start('DODI', '2026-09-01');
      h.as('SARI');
      const r = await roster();
      expect(shape(r)).toEqual([['direct', null, ['Budi Santoso 189', 'Rina Wijaya 59']], ['aab', 'Nina Lestari', ['Dodi Kurniawan 14']]]);
      expect(rowOf(r, 'Rina Wijaya').checklist).toMatchObject({ state: 'graduated', overdue: false });
      expect(rowOf(r, 'Budi Santoso')).toMatchObject({ activation3M: 'not_activated', checklist: { state: 'expired', overdue: false } });
    });

    it('P13-T5 AC-8 404 for a reader who reaches no new hire of the year — an Agent and an AAB who lead nobody, a peer — and no read is recorded', async () => {
      await sixHires();
      for (const who of ['INDAH', 'DEWI', 'PEER_AB', 'ADMIN'] as const) {
        h.as(who);
        expect([who, (await h.http().get('/new-hires').expect(404)).body.error.code]).toEqual([who, 'NOT_FOUND']);
      }
      expect(await reads()).toEqual([]);
    });

    it('P13-T5 AC-7 the roster records one §3.5 read per hire it shows, surface activation', async () => {
      await sixHires();
      h.as('SARI');
      await roster();
      const rows = await reads();
      expect(rows.map((r) => [r.targetMembershipId, r.actorMembershipId, r.after]).sort()).toEqual([
        // From each one's join date, which is their activation's start (ADR-0169 §2).
        [id('BUDI'), id('SARI'), { surface: 'activation', from: '2026-07-15', to: TODAY }],
        [id('DODI'), id('SARI'), { surface: 'activation', from: '2026-09-01', to: TODAY }],
        [id('RINA'), id('SARI'), { surface: 'activation', from: '2026-07-18', to: TODAY }],
      ].sort());
    });

    it('Phase 13 exit review N7 the roster’s per-hire reads are written together, not one after another', async () => {
      await sixHires();
      const real = h.wired.subjectReads.record.bind(h.wired.subjectReads);
      let inFlight = 0;
      let most = 0;
      jest.spyOn(h.wired.subjectReads, 'record').mockImplementation(async (...args) => {
        inFlight += 1;
        most = Math.max(most, inFlight);
        // Yield before writing: one awaited after another never has two in flight.
        await new Promise((resolve) => setImmediate(resolve));
        try {
          return await real(...args);
        } finally {
          inFlight -= 1;
        }
      });
      h.as('SARI');
      await roster();
      expect(most).toBe(3);
      expect(await reads()).toHaveLength(3);
    });

    it('Phase 13 exit review N7 still failing open: an entry that cannot be written loses that entry, never the roster', async () => {
      await sixHires();
      jest.spyOn(h.wired.audit, 'record').mockRejectedValueOnce(new Error('audit down'));
      h.as('SARI');
      expect(shape(await roster())).toEqual([
        ['direct', null, ['Budi Santoso 62', 'Rina Wijaya 59']], ['aab', 'Nina Lestari', ['Dodi Kurniawan 14']],
      ]);
      expect(await reads()).toHaveLength(2);
    });

    it('P13-T5 AC-3 D-moves a hire who changes leader leaves the old roster at once, and the activation is untouched', async () => {
      await sixHires();
      const budi = new mongoose.Types.ObjectId(id('BUDI'));
      const before = await h.col('activationProgress').findOne({ membershipId: id('BUDI') });
      const was = (await h.col('memberships').findOne({ _id: budi }))!;
      await h.col('memberships').updateOne({ _id: budi }, {
        $set: { leaderId: id('DEWI'), ancestorIds: [id('OWNER'), id('AGUS'), id('DEWI')] },
      });
      try {
        h.as('SARI');
        expect(shape(await roster())).toEqual([
          ['direct', null, ['Rina Wijaya 59']], ['aab', 'Nina Lestari', ['Dodi Kurniawan 14']],
        ]);
        await h.http().get(`/new-hires/${id('BUDI')}`).expect(404);
        h.as('AGUS');
        // Dewi's card now has Budi, and takes its place A to Z: Dewi, Nina, Sari.
        expect(shape(await roster())[1]).toEqual(['aab', 'Dewi Lestari', ['Budi Santoso 62']]);
        expect(await h.col('activationProgress').findOne({ membershipId: id('BUDI') })).toEqual(before);
      } finally {
        await h.col('memberships').updateOne({ _id: budi }, { $set: { leaderId: was.leaderId, ancestorIds: was.ancestorIds } });
      }
    });
  });

  describe('GET /new-hires/:membershipId', () => {
    it('P13-T5 AC-5 a leader reads the hire’s activation, the hire’s own note and date not in it; one read recorded', async () => {
      await h.start('RINA', '2026-07-18');
      h.as('RINA');
      await h.http().put('/activation/me/items/CRM_SETUP').send({ done: true, note: 'Mine', date: '2026-08-02' }).expect(200);
      h.as('SARI');
      const view = (await h.http().get(`/new-hires/${id('RINA')}`).expect(200)).body;
      expect(view).toMatchObject({ hire: { membershipId: id('RINA'), name: 'Rina Wijaya' }, day: 59, done: 2 });
      expect(item(view, 'CRM_SETUP')).toMatchObject({ done: true, source: 'hire', note: null, date: null });
      expect(JSON.stringify(view)).not.toContain('Mine');
      expect((await reads()).map((r) => [r.targetMembershipId, r.after])).toEqual([
        [id('RINA'), { surface: 'activation', from: '2026-07-18', to: TODAY }],
      ]);
    });

    it('P13-T9 AC-2 a coach two levels up reads it too, and in any state', async () => {
      await h.start('RINA', '2026-07-18', { graduatedAt: new Date('2026-09-10T02:00:00Z'), graduatedByMembershipId: id('RINA') });
      h.as('AGUS');
      expect((await h.http().get(`/new-hires/${id('RINA')}`).expect(200)).body).toMatchObject({
        state: 'graduated', graduatedBy: { membershipId: id('RINA') },
      });
    });

    it('P13-T5 AC-8 404 outside COACH: the hire herself, a sibling, a peer, an AAB who leads nobody, a member who left, another office, nobody’s id — none recorded', async () => {
      await h.start('RINA', '2026-07-18');
      await h.start('LEFT', '2026-08-01');
      await h.start('B_AGENT', '2026-08-01');
      const refused: [Who, string][] = [
        ['RINA', id('RINA')], ['BUDI', id('RINA')], ['PEER_AB', id('RINA')], ['DEWI', id('RINA')],
        ['AGUS', id('LEFT')], ['AGUS', id('B_AGENT')], ['B_AB', id('RINA')], ['AGUS', 'not-an-id'],
        ['AGUS', new mongoose.Types.ObjectId().toString()], ['SARI', id('NINA')],
      ];
      for (const [who, target] of refused) {
        h.as(who);
        expect([who, target, (await h.http().get(`/new-hires/${target}`).expect(404)).body.error.code]).toEqual([who, target, 'NOT_FOUND']);
      }
      expect(await reads()).toEqual([]);
    });

    /*
     * The Phase 13 exit review, N5: every route that names a hire, for each leader who is not one of hers —
     * a peer AB and his AAB in the other branch, and the AABs beside Sari — is 404, writes nothing and
     * records nothing. Rina is Sari's; Dewi is Sari's sibling under Agus, Nina sits under Sari but is not
     * Rina's leader, and Hendra and Putu are the peer branch.
     */
    const ROUTES: [string, (target: string) => Test][] = [
      ['GET detail', (target) => h.http().get(`/new-hires/${target}`)],
      ['PUT tick', (target) => h.http().put(`/new-hires/${target}/items/CRM_SETUP`).send({ done: true })],
      ['PUT start-date', (target) => h.http().put(`/new-hires/${target}/start-date`).send({ startDate: '2026-07-01' })],
      ['PUT note', (target) => h.http().put(`/new-hires/${target}/note`).send({ text: 'Not yours to write.' })],
    ];
    const OUTSIDE: [string, Who][] = [
      ['a peer AB', 'PEER_AB'], ['a peer AAB', 'PEER_AAB'], ['a sibling AAB', 'DEWI'], ['an AAB below her leader', 'NINA'],
    ];
    it.each(OUTSIDE.flatMap(([label, who]) => ROUTES.map(([route, call]) => [label, who, route, call] as const)))(
      'Phase 13 exit review N5 %s (%s) on Rina, Sari’s hire: %s is 404, and nothing written or recorded',
      async (_label, who, _route, call) => {
        await h.start('RINA', '2026-07-18');
        const before = await h.col('activationProgress').findOne({ membershipId: id('RINA') });
        h.as(who);
        const res = await call(id('RINA'));
        expect([res.status, res.body.error.code]).toEqual([404, 'NOT_FOUND']);
        expect(await h.col('activationProgress').findOne({ membershipId: id('RINA') })).toEqual(before);
        expect(await h.col('auditLog').countDocuments({})).toBe(0);
      },
    );

    it('P13-T5 AC-8 cross-tenant: office B reads its own hire, and office A’s leaders cannot reach it by any route', async () => {
      await h.start('B_AGENT', '2026-08-01');
      h.as('B_AB');
      expect((await h.http().get(`/new-hires/${id('B_AGENT')}`).expect(200)).body.hire.name).toBe('Bayu Saputra');
      expect((await h.http().get('/new-hires').expect(200)).body.units).toHaveLength(1);
      h.as('OWNER');
      for (const res of [
        await h.http().get(`/new-hires/${id('B_AGENT')}`),
        await h.http().put(`/new-hires/${id('B_AGENT')}/items/CRM_SETUP`).send({ done: true }),
        await h.http().put(`/new-hires/${id('B_AGENT')}/start-date`).send({ startDate: '2026-07-01' }),
        await h.http().put(`/new-hires/${id('B_AGENT')}/note`).send({ text: 'Hello' }),
      ]) {
        expect([res.status, res.body.error.code]).toEqual([404, 'NOT_FOUND']);
      }
      expect(await h.col('activationProgress').findOne({ membershipId: id('B_AGENT') })).toMatchObject({ startDate: '2026-08-01', note: null, version: 1 });
    });

    /*
     * **The first year only** (P19.9-T3 AC-4, AC-5; OD-289, ADR-0233): every reader opens a new hire on this detail; from
     * the join date plus twelve calendar months it is served empty — the person, their join date and leader, and nothing
     * of the checklist — and so is a new hire New Hires lists who has no activation at all.
     */
    describe('P19.9-T3 AC-5 served empty past the first year', () => {
      const SARI_AS_LEADER = () => ({ membershipId: id('SARI'), name: 'Sari Puspita', role: 'aab' });

      it('P19.9-T3 AC-5 Rina, joined twelve months ago to the day, is empty: the person, her dates and leader, nothing of her checklist, no read recorded', async () => {
        await h.start('RINA', '2025-09-14');
        h.as('SARI');
        const view = (await h.http().get(`/new-hires/${id('RINA')}`).expect(200)).body;
        expect(view).toEqual({
          empty: 'first_year_over', hire: { membershipId: id('RINA'), name: 'Rina Wijaya' }, today: TODAY,
          joinDate: '2025-09-14', firstYearEndsOn: '2026-09-14', leader: SARI_AS_LEADER(),
        });
        expect(await reads()).toEqual([]);
        // A coach two levels up reads the same, with her leader named as hers.
        h.as('AGUS');
        expect((await h.http().get(`/new-hires/${id('RINA')}`).expect(200)).body).toMatchObject({
          empty: 'first_year_over', leader: SARI_AS_LEADER(),
        });
      });

      it.each([
        ['joined a year ago, her activation started later', '2025-09-14', '2025-10-01', true],
        ['joined within the year, her activation started a year ago', '2025-10-01', '2025-09-14', false],
      ])('P19.9-T3 AC-5 (exit review L3) %s: the leader’s detail and her own page count the year from the join date alike', async (_case, joinDate, startDate, over) => {
        await h.start('RINA', startDate);
        await h.col('memberships').updateOne({ _id: new mongoose.Types.ObjectId(id('RINA')) }, { $set: { joinDate } });
        h.as('SARI');
        const leaders = (await h.http().get(`/new-hires/${id('RINA')}`).expect(200)).body;
        h.as('RINA');
        const hers = (await h.http().get('/activation/me').expect(200)).body;

        const year = (v: Record<string, unknown>) => (v.empty ? [v.empty, v.joinDate, v.firstYearEndsOn] : 'whole activation');
        expect(year(leaders)).toEqual(over ? ['first_year_over', joinDate, '2026-09-14'] : 'whole activation');
        expect(year(hers)).toEqual(year(leaders));
      });

      it('P19.9-T3 AC-5 the day before, still her first year: the whole activation, as before', async () => {
        await h.start('RINA', '2025-09-15');
        h.as('SARI');
        const view = (await h.http().get(`/new-hires/${id('RINA')}`).expect(200)).body;
        expect(view).not.toHaveProperty('empty');
        expect(view).toMatchObject({ state: 'expired', startDate: '2025-09-15', newHire: { joinDate: '2025-09-15' } });
        expect(view.aspects.length).toBeGreaterThan(0);
      });

      it('P19.9-T3 AC-5 every write on an activation past its first year is refused, ACTIVATION_CLOSED, and nothing changes', async () => {
        await h.start('RINA', '2025-09-01');
        const before = await h.col('activationProgress').findOne({ membershipId: id('RINA') });
        h.as('SARI');
        for (const res of [
          await h.http().put(`/new-hires/${id('RINA')}/items/CRM_SETUP`).send({ done: true }),
          await h.http().put(`/new-hires/${id('RINA')}/start-date`).send({ startDate: '2025-09-20' }),
          await h.http().put(`/new-hires/${id('RINA')}/note`).send({ text: 'Too late.' }),
        ]) {
          expect([res.status, res.body.error.code]).toEqual([409, 'ACTIVATION_CLOSED']);
        }
        expect(await h.col('activationProgress').findOne({ membershipId: id('RINA') })).toEqual(before);
      });

      it('P19.9-T3 AC-5 a new hire New Hires lists with no activation at all opens empty too, not a 404', async () => {
        // Nina, placed as a new hire at the AAB rung: listed, with no checklist (ADR-0103).
        await h.col('memberships').updateOne(
          { _id: new mongoose.Types.ObjectId(id('NINA')) }, { $set: { joinedAs: 'new_hire', joinDate: '2026-08-01' } },
        );
        h.as('SARI');
        expect(Object.values((await roster()).sections).flat().map((r) => r.hire.name)).toContain('Nina Lestari');
        const listed = (await reads()).length;
        expect((await h.http().get(`/new-hires/${id('NINA')}`).expect(200)).body).toEqual({
          empty: 'no_activation', hire: { membershipId: id('NINA'), name: 'Nina Lestari' }, today: TODAY,
          joinDate: '2026-08-01', firstYearEndsOn: '2027-08-01', leader: SARI_AS_LEADER(),
        });
        // Past her first year with none, it is the first year that says so.
        await h.col('memberships').updateOne({ _id: new mongoose.Types.ObjectId(id('NINA')) }, { $set: { joinDate: '2025-08-01' } });
        expect((await h.http().get(`/new-hires/${id('NINA')}`).expect(200)).body).toMatchObject({ empty: 'first_year_over' });
        // The roster's own reads, and none for the empty detail.
        expect(await reads()).toHaveLength(listed);
      });

      it('P19.9-T3 AC-5 an existing agent with no activation is still 404 — not a new hire, so on no list', async () => {
        h.as('AGUS');
        expect((await h.http().get(`/new-hires/${id('DIMAS')}`).expect(404)).body.error.code).toBe('NOT_FOUND');
      });

      it('P19.9-T3 AC-5 the empty answer keeps the reach: a peer, a sibling, the hire herself and another office are 404', async () => {
        await h.start('RINA', '2025-09-01');
        await h.start('B_AGENT', '2025-01-10');
        for (const [who, target] of [['PEER_AB', 'RINA'], ['DEWI', 'RINA'], ['RINA', 'RINA'], ['OWNER', 'B_AGENT']] as const) {
          h.as(who);
          expect([who, target, (await h.http().get(`/new-hires/${id(target)}`).expect(404)).body.error.code])
            .toEqual([who, target, 'NOT_FOUND']);
        }
        // Office B's own leader reads its own empty one.
        h.as('B_AB');
        expect((await h.http().get(`/new-hires/${id('B_AGENT')}`).expect(200)).body).toMatchObject({
          empty: 'first_year_over', hire: { name: 'Bayu Saputra' },
        });
      });
    });
  });

  describe('a leader’s tick (OD-121)', () => {
    it('P13-T5 AC-6 a leader ticks a hire’s manual item in their name; the hire reads who', async () => {
      const doc = await h.start('RINA', '2026-07-18');
      h.as('SARI');
      const view = (await h.http().put(`/new-hires/${id('RINA')}/items/CRM_SETUP`).send({ done: true }).expect(200)).body;
      expect(item(view, 'CRM_SETUP')).toMatchObject({ done: true, source: 'leader', doneBy: { membershipId: id('SARI') }, note: null });
      h.as('AGUS');
      await h.http().put(`/new-hires/${id('RINA')}/items/ROLE_PLAY`).send({ done: true }).expect(200);
      h.as('RINA');
      const own = (await h.http().get('/activation/me').expect(200)).body;
      expect(item(own, 'CRM_SETUP')).toMatchObject({ source: 'leader', doneBy: { membershipId: id('SARI'), name: 'Sari Puspita' } });
      expect(item(own, 'ROLE_PLAY')).toMatchObject({ source: 'leader', doneBy: { membershipId: id('AGUS'), name: 'Agus Salim' } });
      expect((await writes()).map((r) => [r.action, r.actorMembershipId, r.targetId, r.targetMembershipId, r.onBehalfOf, r.after])).toEqual([
        ['activation.item_ticked', id('SARI'), String(doc._id), id('RINA'), true, { code: 'CRM_SETUP' }],
        ['activation.item_ticked', id('AGUS'), String(doc._id), id('RINA'), true, { code: 'ROLE_PLAY' }],
      ]);
    });

    it('P13-T5 AC-6 a leader unticks what the hire ticked; and draws no note or date: sending one is refused', async () => {
      await h.start('RINA', '2026-07-18');
      h.as('RINA');
      await h.http().put('/activation/me/items/CRM_SETUP').send({ done: true, note: 'Mine' }).expect(200);
      h.as('SARI');
      const view = (await h.http().put(`/new-hires/${id('RINA')}/items/CRM_SETUP`).send({ done: false }).expect(200)).body;
      expect(item(view, 'CRM_SETUP')).toMatchObject({ done: false, doneBy: null });
      for (const body of [{ done: true, note: 'x' }, { done: true, date: '2026-08-01' }, {}]) {
        expect((await h.http().put(`/new-hires/${id('RINA')}/items/CRM_SETUP`).send(body).expect(400)).body.error.code).toMatch(/^VALIDATION_/);
      }
    });

    it('P13-T5 AC-6 contradiction 1: a linked item is disabled on the leader’s detail too — a tick is refused and changes nothing', async () => {
      await h.start('BUDI', '2026-07-15');
      for (const who of ['SARI', 'AGUS', 'OWNER'] as const) {
        h.as(who);
        for (const code of ['GOAL_SETTING', 'ADD_PROSPECTS', 'ACTIVITY_TRACKER_WEEKLY']) {
          expect((await h.http().put(`/new-hires/${id('BUDI')}/items/${code}`).send({ done: true }).expect(409)).body.error.code)
            .toBe('ACTIVATION_ITEM_AUTOMATIC');
        }
      }
      expect(await writes()).toEqual([]);
    });

    it('P13-T2 AC-3 a graduated or expired activation refuses a leader’s every write', async () => {
      await h.start('RINA', '2026-07-18', { graduatedAt: new Date('2026-09-10T02:00:00Z'), graduatedByMembershipId: id('RINA') });
      await h.start('BUDI', '2026-02-10');
      h.as('SARI');
      for (const [who, state] of [['RINA', 'graduated'], ['BUDI', 'expired']] as const) {
        for (const res of [
          await h.http().put(`/new-hires/${id(who)}/items/CRM_SETUP`).send({ done: true }),
          await h.http().put(`/new-hires/${id(who)}/start-date`).send({ startDate: '2026-07-01' }),
          await h.http().put(`/new-hires/${id(who)}/note`).send({ text: 'Well done' }),
        ]) {
          expect([who, res.status, res.body.error.code, res.body.error.details]).toEqual([who, 409, 'ACTIVATION_CLOSED', { state }]);
        }
      }
      expect(await writes()).toEqual([]);
    });

    it('OD-122 an Agent with a direct report reads, ticks, corrects and notes his hire; an Agent who leads nobody reaches nobody', async () => {
      await h.start('TARI', '2026-08-01');
      h.as('LUKAS');
      await h.http().get(`/new-hires/${id('TARI')}`).expect(200);
      await h.http().put(`/new-hires/${id('TARI')}/items/CRM_SETUP`).send({ done: true }).expect(200);
      await h.http().put(`/new-hires/${id('TARI')}/start-date`).send({ startDate: '2026-07-20' }).expect(200);
      await h.http().put(`/new-hires/${id('TARI')}/note`).send({ text: 'Good start.' }).expect(200);
      h.as('INDAH');
      for (const res of [
        await h.http().get(`/new-hires/${id('TARI')}`),
        await h.http().put(`/new-hires/${id('TARI')}/items/CRM_SETUP`).send({ done: false }),
        await h.http().put(`/new-hires/${id('TARI')}/start-date`).send({ startDate: '2026-07-21' }),
        await h.http().put(`/new-hires/${id('TARI')}/note`).send({ text: 'Not mine to write' }),
      ]) {
        expect([res.status, res.body.error.code]).toEqual([404, 'NOT_FOUND']);
      }
    });
  });

  describe('the start date (OD-118)', () => {
    it('P13-T5 AC-5 a leader corrects it: the day and the end recomputed, who and when kept, both dates audited', async () => {
      const doc = await h.start('RINA', '2026-07-18');
      h.as('SARI');
      const view = (await h.http().put(`/new-hires/${id('RINA')}/start-date`).send({ startDate: '2026-07-01' }).expect(200)).body;
      expect(view).toMatchObject({
        startDate: '2026-07-01', day: 76, endsOn: '2027-01-01',
        startCorrected: { by: { membershipId: id('SARI'), name: 'Sari Puspita' }, at: h.clock.now().toISOString() },
      });
      // P18.8-T2 AC-3: one audit row, the activation's start and the membership's join date before and after.
      expect((await writes()).map((r) => [r.action, r.targetId, r.targetMembershipId, r.before, r.after])).toEqual([
        ['activation.start_date_corrected', String(doc._id), id('RINA'),
          { startDate: '2026-07-18', joinDate: '2026-07-18' }, { startDate: '2026-07-01', joinDate: '2026-07-01' }],
      ]);
      h.as('RINA');
      expect((await h.http().get('/activation/me').expect(200)).body.startCorrected.by.membershipId).toBe(id('SARI'));
    });

    it('P18.8-T2 AC-3 the correction moves the membership’s join date with the start, and never reclassifies', async () => {
      await h.start('RINA', '2026-07-18');
      const rina = () => h.col('memberships').findOne({ _id: new mongoose.Types.ObjectId(id('RINA')) });
      expect(await rina()).toMatchObject({ joinDate: '2026-07-18', joinedAs: 'new_hire' });
      h.as('SARI');
      // 365 days back, well over 90: still a new hire, because the classification was made once, when she joined.
      await h.http().put(`/new-hires/${id('RINA')}/start-date`).send({ startDate: '2025-09-14' }).expect(200);
      expect(await rina()).toMatchObject({ joinDate: '2025-09-14', joinedAs: 'new_hire' });
      expect((await h.col('activationProgress').findOne({ membershipId: id('RINA') }))!.startDate).toBe('2025-09-14');
      // A refused correction moves neither.
      await h.http().put(`/new-hires/${id('RINA')}/start-date`).send({ startDate: '2026-09-15' }).expect(400);
      expect(await rina()).toMatchObject({ joinDate: '2025-09-14' });
    });

    it('P18.8-T2 AC-3 a correction in another office reaches nobody, and moves no join date there', async () => {
      await h.start('B_AGENT', '2026-08-01');
      h.as('SARI');
      const res = await h.http().put(`/new-hires/${id('B_AGENT')}/start-date`).send({ startDate: '2026-07-01' });
      expect([res.status, res.body.error.code]).toEqual([404, 'NOT_FOUND']);
      expect(await h.col('memberships').findOne({ _id: new mongoose.Types.ObjectId(id('B_AGENT')) })).toMatchObject({ joinDate: '2026-08-01' });
    });

    it('P13-T5 AC-5 the bounds: the office’s today at the latest, 365 days before it at the earliest, and a real day', async () => {
      await h.start('RINA', '2026-07-18');
      h.as('SARI');
      const put = (startDate: unknown) => h.http().put(`/new-hires/${id('RINA')}/start-date`).send({ startDate });
      await put(TODAY).expect(200);
      await put('2025-09-14').expect(200);
      for (const bad of ['2026-09-15', '2025-09-13', '2026-02-30', '14/09/2026', 20260914, null]) {
        expect([bad, (await put(bad).expect(400)).body.error.code]).toEqual([bad, 'VALIDATION_FAILED']);
      }
      // The bounds in the sentence are written as ADR-0167 §1 writes a date (P18.7-T1 AC-4).
      expect((await put('2026-09-15').expect(400)).body.error.message).toBe(
        // P18.8-T2 AC-5: the date is named as the reader knows it, the join date.
        'The join date must be a day from 14 Sep 2025 to 14 Sep 2026: no later than today, and no more than 365 days before it.',
      );
    });

    it('P18.10-T5 AC-7 refuses a join date out of bounds in Indonesian, the bounds in Indonesian figures', async () => {
      await h.start('RINA', '2026-07-18');
      h.as('SARI');
      const said = 'Tanggal bergabung harus berupa hari dari 14 Sep 2025 sampai 14 Sep 2026: tidak setelah hari ini, dan tidak '
        + 'lebih dari 365 hari sebelumnya.';
      const res = await h.http().put(`/new-hires/${id('RINA')}/start-date`).set('Accept-Language', 'id')
        .send({ startDate: '2026-09-15' }).expect(400);
      expect(res.body.error).toMatchObject({ code: 'VALIDATION_FAILED', message: said, details: { violations: [said] } });
      // The pipe's own sentence for a day not written as one, the field as the API names it.
      expect((await h.http().put(`/new-hires/${id('RINA')}/start-date`).set('Accept-Language', 'id')
        .send({ startDate: '14/09/2026' }).expect(400)).body.error.details.violations)
        .toEqual(['startDate harus berupa tanggal dengan format YYYY-MM-DD.']);
    });

    it('P13-T5 AC-5 the hire’s own is read-only: a hire has no route to it', async () => {
      await h.start('RINA', '2026-07-18');
      h.as('RINA');
      expect((await h.http().put(`/new-hires/${id('RINA')}/start-date`).send({ startDate: '2026-07-01' }).expect(404)).body.error.code).toBe('NOT_FOUND');
    });

    it('P13-T5 AC-8 an elevated support session corrects as its member, both actors on the record', async () => {
      await h.start('RINA', '2026-07-18');
      h.as(h.supporting('SARI', false));
      await h.http().put(`/new-hires/${id('RINA')}/start-date`).send({ startDate: '2026-07-10' }).expect(200);
      expect((await writes()).map((r) => [r.action, r.actorUserId, r.effectiveUserId, r.actorMembershipId])).toEqual([
        ['activation.start_date_corrected', 'u-support', 'u-SARI', id('SARI')],
      ]);
    });
  });

  describe('the coaching note (OD-117, P13-T6)', () => {
    it('P13-T6 AC-2 one note per hire, written by any leader who coaches her, replaced on each save; the hire reads it', async () => {
      const doc = await h.start('RINA', '2026-07-18');
      h.as('SARI');
      const saved = (await h.http().put(`/new-hires/${id('RINA')}/note`)
        .send({ text: '  Great pace on prospecting.  ' }).expect(200)).body;
      expect(saved).toEqual({ note: { text: 'Great pace on prospecting.', by: { membershipId: id('SARI'), name: 'Sari Puspita' }, at: h.clock.now().toISOString() } });

      h.as('RINA');
      expect((await h.http().get('/activation/me').expect(200)).body.note).toEqual(saved.note);

      h.clock.advance(60_000);
      h.as('AGUS');
      await h.http().put(`/new-hires/${id('RINA')}/note`).send({ text: 'Book your first JFW this week.' }).expect(200);
      h.as('RINA');
      expect((await h.http().get('/activation/me').expect(200)).body.note).toMatchObject({
        text: 'Book your first JFW this week.', by: { membershipId: id('AGUS') },
      });
      // Ids only: the words are never in the audit log.
      const rows = (await writes()).filter((r) => r.action === 'activation.note_saved');
      expect(rows.map((r) => [r.actorMembershipId, r.targetId, r.targetMembershipId, r.after ?? null])).toEqual([
        [id('SARI'), String(doc._id), id('RINA'), null], [id('AGUS'), String(doc._id), id('RINA'), null],
      ]);
      expect(JSON.stringify(rows)).not.toMatch(/prospecting|JFW/);
    });

    it('P13-T6 AC-2 the limit is the contract’s: 1 to 1,000 characters once trimmed', async () => {
      await h.start('RINA', '2026-07-18');
      h.as('SARI');
      const put = (text: unknown) => h.http().put(`/new-hires/${id('RINA')}/note`).send({ text });
      await put('x'.repeat(1000)).expect(200);
      for (const bad of ['', '   ', 'x'.repeat(1001), 42, null]) {
        expect((await put(bad).expect(400)).body.error.code).toBe('VALIDATION_FAILED');
      }
    });

    it('P18.10-T5 AC-7 refuses a note out of bounds in Indonesian: its bound written the Indonesian way', async () => {
      await h.start('RINA', '2026-07-18');
      h.as('SARI');
      const said = 'text harus 1 sampai 1.000 karakter, tanpa spasi di awal dan akhir.';
      expect((await h.http().put(`/new-hires/${id('RINA')}/note`).set('Accept-Language', 'id').send({ text: '   ' }).expect(400))
        .body.error).toMatchObject({ code: 'VALIDATION_FAILED', message: said, details: { violations: [said] } });
      expect((await h.http().put(`/new-hires/${id('RINA')}/note`).send({ text: '   ' }).expect(400)).body.error.message)
        .toBe('text must be 1 to 1000 characters once trimmed.');
    });

    it('P13-T6 AC-4 it is not a Leader Note: no Leader Note reaches the hire’s payload, and the note is not in leaderNotes', async () => {
      await h.start('RINA', '2026-07-18');
      await h.wired.leaderNotes.save(h.office.as('SARI'), id('RINA'), { version: 0, text: 'Private: hesitates at the close.' });
      h.as('SARI');
      await h.http().put(`/new-hires/${id('RINA')}/note`).send({ text: 'Visible to Rina.' }).expect(200);
      h.as('RINA');
      const own = JSON.stringify((await h.http().get('/activation/me').expect(200)).body);
      expect(own).toContain('Visible to Rina.');
      expect(own).not.toContain('hesitates');
      const notes = await h.col('leaderNotes').find({ coacheeMembershipId: id('RINA') }).toArray();
      expect(notes.map((n) => n.text)).toEqual(['Private: hesitates at the close.']);
      await h.col('leaderNotes').deleteMany({});
    });

    it('P13-T6 AC-5 a read-only support session reads both pages and the note, and is refused every write', async () => {
      await h.start('RINA', '2026-07-18');
      h.as('SARI');
      await h.http().put(`/new-hires/${id('RINA')}/note`).send({ text: 'Keep going.' }).expect(200);
      h.as(h.supporting('SARI'));
      await h.http().get('/new-hires').expect(200);
      expect((await h.http().get(`/new-hires/${id('RINA')}`).expect(200)).body.note.text).toBe('Keep going.');
      for (const res of [
        await h.http().put(`/new-hires/${id('RINA')}/items/CRM_SETUP`).send({ done: true }),
        await h.http().put(`/new-hires/${id('RINA')}/start-date`).send({ startDate: '2026-07-01' }),
        await h.http().put(`/new-hires/${id('RINA')}/note`).send({ text: 'Changed' }),
      ]) {
        expect([res.status, res.body.error.code]).toEqual([403, 'PERM_DENIED']);
      }
      expect((await writes()).map((r) => r.action)).toEqual(['activation.note_saved']);
    });
  });
});
