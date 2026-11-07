import mongoose from 'mongoose';
import { SUBJECT_READ_ACTION } from '@/modules/audit/subject-read-audit';
import { MemberNames } from '@/modules/org/member-names.service';
import { TenantDay } from '@/modules/tenants/tenant-day.service';
import { clearCollections, startMongo, stopMongo } from '../../../test/mongo';
import { configModule } from '../../../test/config-module';
import {
  buildCoachingOffice, COMPANY, KPM_A, KPM_B, ROSTER_NOW, ROSTER_TODAY, type CoachingOffice, type Who,
} from '../../../test/coaching-office';
import { UnitPotensiService, type PotensiPerson, type UnitPotensiView } from './unit-potensi.service';

const at = (iso: string) => new Date(iso);

/**
 * **P19.1-T6 — the Unit Dashboard's *Potensi* tab, on real rows** (UI-155, UI-159 item 4; ADR-0193): office 0417 (KPM
 * A) beside 0555 (KPM B), `test/coaching-office.ts`'s people — Agus (AB) over Indah and Dimas, Sari's unit (Budi, Rina,
 * and Nina's unit with Dodi), Dewi who leads nobody, Lukas leading Tari. *Today* is Monday 14 September 2026 in Jakarta.
 *
 * | Who | September | August |
 * |---|---|---|
 * | RINA | two sales leads switched on, open; a kandidat switched on, open; Maya, switched on, *Berhasil* 10 Sep | — |
 * | BUDI | a sales lead switched on, *Berhasil* 12 Sep; another switched on, open | — |
 * | INDAH | no switch; the month's row shows 2 policies | — |
 * | DODI | a sales lead *Berhasil* at 00:30 WIB on 1 September (17:30 UTC on 31 August) | — |
 * | DIMAS | a kandidat **not** switched on | — |
 * | SARI | — | a sales lead switched on, *Berhasil* 20 Aug |
 * | NINA | — | a sales lead switched on for August, still open |
 * | B_AGENT (office B) | a sales lead switched on, *Berhasil* | — |
 */
describe('P19.1-T6 the Potensi tab (UI-155)', () => {
  let wired: ReturnType<typeof configModule>;
  let office: CoachingOffice;
  let potensi: UnitPotensiService;
  const db = () => mongoose.connection.db!;

  beforeAll(async () => {
    await startMongo();
    wired = configModule(ROSTER_NOW);
    await clearCollections();
    office = await buildCoachingOffice(wired);
    potensi = new UnitPotensiService(
      wired.unitDashboard, new TenantDay(wired.kpms as never, wired.clock), wired.clock, wired.leadReadings,
      wired.productionReadings, wired.coach, wired.orgLevels, new MemberNames(wired.memberships, wired.users as never),
      wired.memberships, wired.subjectReads, wired.users as never,
    );

    let n = 0;
    const lead = (who: Who, over: Record<string, unknown>, kpmId = KPM_A) => {
      n += 1;
      return {
        kpmId, ownerMembershipId: office.id[who], type: 'sales', name: `Lead ${n}`, statusCode: 'FOLLOW_UP', outcome: null,
        outcomeAt: null, commitments: [], nextActionDate: null, nextActionNote: null, version: 1, deletedAt: null,
        dateRegistered: at('2026-08-01T02:00:00Z'), contact: { phone: null, email: null }, transitions: [],
        joinedMembershipId: null, ...over,
      };
    };
    const on = (month = '2026-09') => [{ month, at: at(`${month}-02T02:00:00Z`), byMembershipId: 'x' }];
    const won = (iso: string, stage = 'PAID_AND_ISSUED') => ({ outcome: 'won', outcomeAt: at(iso), statusCode: stage });
    await db().collection('leads').insertMany([
      lead('RINA', { name: 'Ibu Rosa Damayanti', commitments: on(), nextActionDate: '2026-09-20', nextActionNote: 'Grand Indonesia, 10:00' }),
      lead('RINA', { name: 'Ibu Kartika Dewanti', commitments: on(), nextActionDate: '2026-09-14', nextActionNote: 'Coffee after her shift.' }),
      lead('RINA', { name: 'Pak Hendro', commitments: [] }),
      lead('RINA', { type: 'recruitment', name: 'Sdri. Tia Amelia', statusCode: 'MEETING_SCHEDULED', commitments: on() }),
      lead('RINA', { type: 'recruitment', name: 'Sdri. Maya Lestari', commitments: on(), ...won('2026-09-10T03:00:00Z', 'NEW_ACTIVE_AGENT') }),
      lead('BUDI', { commitments: on(), ...won('2026-09-12T03:00:00Z') }),
      lead('BUDI', { commitments: on() }),
      // A deleted lead is no lead.
      lead('BUDI', { commitments: on(), deletedAt: at('2026-09-05T03:00:00Z') }),
      lead('DODI', won('2026-08-31T17:30:00Z')),
      lead('DIMAS', { type: 'recruitment', name: 'Sdr. Arya Putra', statusCode: 'MEETING_SCHEDULED' }),
      lead('SARI', { commitments: on('2026-08'), ...won('2026-08-20T03:00:00Z') }),
      lead('NINA', { commitments: on('2026-08') }),
      lead('B_AGENT', { commitments: on(), ...won('2026-09-05T03:00:00Z') }, KPM_B),
    ]);
    await db().collection('monthlyAgentData').updateOne(
      { membershipId: office.id.INDAH, month: '2026-09' },
      { $set: { 'values.POLICY_COUNT': { value: 2, provenance: 'imported', sourceBatchId: null } } },
    );
    // Rina's WhatsApp number, for *Chat Agent Rina*.
    const rina = await db().collection('memberships').findOne({ _id: new mongoose.Types.ObjectId(office.id.RINA) });
    await db().collection('users').updateOne({ _id: new mongoose.Types.ObjectId(String(rina!.userId)) }, { $set: { phone: '+6281211002201' } });
  }, 120_000);
  afterAll(stopMongo);

  const read = (who: Who, query: Parameters<UnitPotensiService['read']>[1] = {}) => potensi.read(office.as(who), query);
  const everyone = (view: UnitPotensiView): PotensiPerson[] => view.units.flatMap((u) => u.people);
  const person = (view: UnitPotensiView, who: Who) => everyone(view).find((p) => p.membershipId === office.id[who])!;
  const cardOf = (view: UnitPotensiView, who: Who) => view.units.find((u) => u.leader.membershipId === office.id[who])!;

  describe('AC-2, AC-3 the tiles, and the list grouped per unit', () => {
    // *Changed 2026-11-07 (P19.8-T4 AC-4, MOB UI-179; ADR-0229 §4):* the head's own card first, where it was last.
    it('P19.8-T4 AC-4 MOB UI-179 Unit Anda first, then one card per unit below the AB in the Overview’s order — each leader first', async () => {
      const view = await read('AGUS');
      expect(view.units.map((u) => [u.kind, u.leader.name, u.people.map((p) => p.name)])).toEqual([
        ['direct', 'Agus Salim', ['Agus Salim', 'Dimas Pratama', 'Indah Permatasari']],
        ['unit', 'Dewi Lestari', ['Dewi Lestari']],
        ['unit', 'Lukas Hartono', ['Lukas Hartono', 'Tari Anggraini']],
        ['unit', 'Sari Puspita', ['Sari Puspita', 'Budi Santoso', 'Rina Wijaya']],
        ['unit', 'Nina Lestari', ['Nina Lestari', 'Dodi Kurniawan']],
      ]);
      expect(view.units.every((u) => u.people[0].isLeader && u.people.slice(1).every((p) => !p.isLeader))).toBe(true);
      // Everybody in the unit, once; the leaders counted like everyone else.
      expect(everyone(view)).toHaveLength(11);
    });

    it('P19.1-T6 AC-3 the role words are the company’s rung labels, and the reader is marked', async () => {
      const view = await read('AGUS');
      expect(cardOf(view, 'SARI').leader.rung.code).toBe('AAB');
      expect(person(view, 'AGUS')).toMatchObject({ isReader: true, rung: { code: 'AB' } });
      expect(person(view, 'AGUS').rung.label).toBeTruthy();
    });

    it('P19.1-T6 AC-3 an AAB is answered their agents in their own card, a nested unit in its own', async () => {
      const view = await read('SARI');
      // The AAB's own card first (P19.8-T4 AC-4).
      expect(view.units.map((u) => [u.kind, u.people.map((p) => p.name)])).toEqual([
        ['direct', ['Sari Puspita', 'Budi Santoso', 'Rina Wijaya']],
        ['unit', ['Nina Lestari', 'Dodi Kurniawan']],
      ]);
    });

    it('P19.1-T6 AC-2 tile AA counts the people who are AA this month; tile Rekrut the kandidat who became rekrut', async () => {
      const view = await read('AGUS');
      expect(view).toMatchObject({ month: '2026-09', currentMonth: '2026-09', today: ROSTER_TODAY, tiles: { aa: 3, rekrut: 1 } });
      expect(everyone(view).filter((p) => p.aa.aa).map((p) => p.name).sort())
        .toEqual(['Budi Santoso', 'Dodi Kurniawan', 'Indah Permatasari']);
    });

    it('P19.8-T4 AC-9 MOB UI-186 each tile’s potensi x counts people with a lead switched on, whatever became of it — never leads', async () => {
      const view = await read('AGUS');
      // Sales: Rina (two switched on) and Budi (one won, one open) — 2 people, though 4 leads; Indah's AA needs no switch.
      // Recruit: Rina (Tia open, Maya won) — 1 person; Dimas's kandidat was never switched on.
      expect(view.tiles.potensi).toEqual({ aa: 2, rekrut: 1 });
      // The cards' *y* summed, one figure for both.
      expect(view.tiles.potensi.aa).toBe(view.units.reduce((sum, u) => sum + u.totals.aa.switchedPeople, 0));
      expect(view.tiles.potensi.rekrut).toBe(view.units.reduce((sum, u) => sum + u.totals.rekrut.switchedPeople, 0));
      // August: Sari's and Nina's switches, one person each.
      expect((await read('AGUS', { month: '2026-08' })).tiles).toEqual({ aa: 1, rekrut: 0, potensi: { aa: 2, rekrut: 0 } });
    });
  });

  describe('AC-5, AC-7 the people’s pills', () => {
    it('P19.1-T6 AC-12 AA by each path of OD-249: a sales lead marked Berhasil (Budi), the month’s file (Indah)', async () => {
      const view = await read('AGUS');
      expect(person(view, 'BUDI').aa).toEqual({ potensi: 1, aa: true, switched: 2 });
      // AA without the switch.
      expect(person(view, 'INDAH').aa).toEqual({ potensi: 0, aa: true, switched: 0 });
      // APE on the month's row without a policy is not a case.
      expect(person(view, 'RINA').aa).toEqual({ potensi: 2, aa: false, switched: 2 });
    });

    it('P19.1-T6 AC-5 a person already AA keeps n potensi while other leads stay switched on', async () => {
      expect(person(await read('AGUS'), 'BUDI').aa).toMatchObject({ potensi: 1, aa: true });
    });

    it('P19.1-T6 AC-7 only switched-on Recruit leads are potensi; a rekrut counts; one not switched on is left out', async () => {
      const view = await read('AGUS');
      expect(person(view, 'RINA').rekrut).toEqual({ potensi: 1, rekrut: 1, switched: 2 });
      expect(person(view, 'DIMAS').rekrut).toEqual({ potensi: 0, rekrut: 0, switched: 0 });
    });

    it('P19.1-T6 AC-4 a card’s header: n potensi · n AA, and n potensi · n rekrut', async () => {
      expect(cardOf(await read('AGUS'), 'SARI').totals).toEqual({
        aa: { potensi: 3, aa: 1, switchedPeople: 2, switchedPeopleAa: 1 },
        rekrut: { potensi: 1, rekrut: 1, switchedPeople: 1, switchedPeopleRekrut: 1 },
      });
    });
  });

  describe('AC-9, AC-12 the month: Asia/Jakarta, and an earlier month’s result', () => {
    it('P19.1-T6 AC-12 a case at 00:30 WIB on 1 September is September’s, though August’s in UTC', async () => {
      expect(person(await read('AGUS'), 'DODI').aa.aa).toBe(true);
      expect(person(await read('AGUS', { month: '2026-08' }), 'DODI').aa.aa).toBe(false);
    });

    it('P19.1-T6 AC-9 August still reads what became of its switches: potensi 1/1 · 1 AA for Sari, 0/1 for Nina', async () => {
      const august = await read('AGUS', { month: '2026-08' });
      expect(august).toMatchObject({ month: '2026-08', currentMonth: '2026-09', tiles: { aa: 1, rekrut: 0 } });
      // Sari's switched-on lead became her case: no longer a potensi, and the ✓.
      expect(cardOf(august, 'SARI').totals.aa).toEqual({ potensi: 0, aa: 1, switchedPeople: 1, switchedPeopleAa: 1 });
      // Nina's lead was open at August's end, and is still: a potensi that did not become a case.
      expect(cardOf(august, 'NINA').totals.aa).toEqual({ potensi: 1, aa: 0, switchedPeople: 1, switchedPeopleAa: 0 });
      // September's switches are not August's.
      expect(person(august, 'RINA').aa).toEqual({ potensi: 0, aa: false, switched: 0 });
    });

    it('P19.8-T4 AC-10 MOB UI-182 an earlier month lists the whole team under each card, as this month does', async () => {
      const names = (view: UnitPotensiView) => view.units.map((u) => [u.leader.name, u.people.map((p) => p.name)]);
      const september = await read('AGUS');
      // A month with nothing switched on at all still answers everybody, each at 0.
      const july = await read('AGUS', { month: '2026-07' });
      expect(names(july)).toEqual(names(september));
      expect(everyone(july)).toHaveLength(11);
      expect(everyone(july).every((p) => p.aa.potensi === 0 && !p.aa.aa && p.rekrut.potensi === 0 && p.rekrut.rekrut === 0)).toBe(true);
      expect(july.tiles).toEqual({ aa: 0, rekrut: 0, potensi: { aa: 0, rekrut: 0 } });
    });

    it('P19.1-T6 AC-12 a month after this one, or one that is not a month, is 400 VALIDATION_FAILED', async () => {
      await expect(read('AGUS', { month: '2026-10' })).rejects.toMatchObject({ code: 'VALIDATION_FAILED', status: 400 });
      await expect(read('AGUS', { month: '2026-13' })).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
    });
  });

  describe('AC-10 a leader with nobody below them', () => {
    it('P19.1-T6 AC-10 is answered their own card alone and the tiles at 0 — never an error (UI-159 item 4)', async () => {
      const view = await read('DEWI');
      expect(view.tiles).toEqual({ aa: 0, rekrut: 0, potensi: { aa: 0, rekrut: 0 } });
      expect(view.units).toHaveLength(1);
      expect(view.units[0]).toMatchObject({ kind: 'direct', people: [{ name: 'Dewi Lestari', isLeader: true, isReader: true }] });
    });
  });

  describe('AC-12 reach, the 404s, and the tenant boundary', () => {
    it('P19.1-T6 AC-12 a unit below the reader by for; outside the reach, a peer’s or another office’s, 404', async () => {
      expect((await read('AGUS', { for: office.id.SARI })).head).toMatchObject({ name: 'Sari Puspita', isReader: false });
      await expect(read('AGUS', { for: office.id.PEER_AB })).rejects.toMatchObject({ status: 404 });
      await expect(read('AGUS', { for: office.id.B_AB })).rejects.toMatchObject({ status: 404 });
      await expect(read('SARI', { for: office.id.AGUS })).rejects.toMatchObject({ status: 404 });
    });

    it('P19.1-T6 AC-12 cross-tenant: office B’s case is in office B’s figures and nowhere in office A’s', async () => {
      expect((await read('B_AB')).tiles).toEqual({ aa: 1, rekrut: 0, potensi: { aa: 1, rekrut: 0 } });
      expect(JSON.stringify(await read('OWNER'))).not.toContain(office.id.B_AGENT);
    });

    it('P19.1-T6 AC-1 the Owner and an Admin read any leader’s unit; a row opens only where lead:read reaches (§3.7)', async () => {
      const owner = await read('OWNER', { for: office.id.SARI });
      expect(everyone(owner).every((p) => p.opens)).toBe(true);
      const admin = await read('ADMIN', { for: office.id.SARI });
      expect(everyone(admin).map((p) => p.name)).toEqual(everyone(owner).map((p) => p.name));
      expect(everyone(admin).some((p) => p.opens)).toBe(false);
    });

    it('P19.1-T6 the read is recorded: one unit_dashboard entry per person shown other than the reader, the month to today', async () => {
      await db().collection('auditLog').deleteMany({});
      await read('SARI');
      const entries = await db().collection('auditLog').find({ action: SUBJECT_READ_ACTION, 'after.surface': 'unit_dashboard' }).toArray();
      expect(entries.map((e) => e.targetMembershipId).sort()).toEqual([office.id.BUDI, office.id.DODI, office.id.NINA, office.id.RINA].sort());
      expect(entries[0].after).toMatchObject({ from: '2026-09-01', to: ROSTER_TODAY });
    });
  });

  describe('AC-6, AC-7 a person’s sheet', () => {
    it('P19.1-T6 AC-6 the switched-on sales leads with the client’s name, nearest next action first, and the agent’s number', async () => {
      const sheet = await potensi.person(office.as('AGUS'), office.id.RINA);
      expect(sheet.person).toMatchObject({ name: 'Rina Wijaya', phone: '+6281211002201', isReader: false, rung: { code: 'AGENT' } });
      expect(sheet.unit).toMatchObject({ name: 'Sari Puspita', rung: { code: 'AAB' } });
      expect(sheet.sales.map((l) => [l.name, l.nextActionDate, l.nextActionNote, l.statusCode])).toEqual([
        ['Ibu Kartika Dewanti', '2026-09-14', 'Coffee after her shift.', 'FOLLOW_UP'],
        ['Ibu Rosa Damayanti', '2026-09-20', 'Grand Indonesia, 10:00', 'FOLLOW_UP'],
      ]);
    });

    it('P19.1-T6 AC-7 the kandidat: potensi first, then rekrut with the day; New Hires once the lead names a membership', async () => {
      const sheet = await potensi.person(office.as('SARI'), office.id.RINA);
      expect(sheet.kandidat.map((k) => [k.name, k.state, k.rekrutOn, k.newHireMembershipId])).toEqual([
        ['Sdri. Tia Amelia', 'potensi', null, null],
        ['Sdri. Maya Lestari', 'rekrut', '2026-09-10', null],
      ]);
      await db().collection('leads').updateOne({ name: 'Sdri. Maya Lestari' }, { $set: { joinedMembershipId: office.id.TARI } });
      const linked = await potensi.person(office.as('SARI'), office.id.RINA);
      expect(linked.kandidat[1].newHireMembershipId).toBe(office.id.TARI);
      await db().collection('leads').updateOne({ name: 'Sdri. Maya Lestari' }, { $set: { joinedMembershipId: null } });
    });

    it('P19.1-T6 AC-6 a sheet is a read of the person’s leads: one leads entry, none for the reader’s own', async () => {
      await db().collection('auditLog').deleteMany({});
      await potensi.person(office.as('AGUS'), office.id.RINA);
      await potensi.person(office.as('AGUS'), office.id.AGUS);
      const entries = await db().collection('auditLog').find({ action: SUBJECT_READ_ACTION, 'after.surface': 'leads' }).toArray();
      expect(entries).toHaveLength(1);
      expect(entries[0]).toMatchObject({ targetMembershipId: office.id.RINA, after: { from: null, to: ROSTER_TODAY } });
    });

    it('P19.1-T6 AC-12 a sheet outside lead:read’s reach — an Admin’s, a peer’s, another office’s — is 404', async () => {
      await expect(potensi.person(office.as('ADMIN'), office.id.RINA)).rejects.toMatchObject({ status: 404 });
      await expect(potensi.person(office.as('PEER_AAB'), office.id.RINA)).rejects.toMatchObject({ status: 404 });
      await expect(potensi.person(office.as('B_AB'), office.id.RINA)).rejects.toMatchObject({ status: 404 });
      await expect(potensi.person(office.as('AGUS'), office.id.B_AGENT)).rejects.toMatchObject({ status: 404 });
    });
  });

  /*
   * **The tab at its edges**, after every case above, each change to a row put back: no query at all, a root who leads
   * nobody active, an account gone, and an office whose row names no company.
   */
  describe('the tab at its edges', () => {
    const oid = (id: string) => new mongoose.Types.ObjectId(id);
    const userOf = async (who: Who) =>
      (await db().collection('memberships').findOne({ _id: oid(office.id[who]) }))!.userId as string;

    it('P19.1-T6 AC-2 asked nothing, the tab is the reader’s own unit this month', async () => {
      expect(await potensi.read(office.as('AGUS'))).toEqual(await read('AGUS'));
    });

    it('P19.1-T6 AC-6 a member at the root with nobody active below them: their sheet names no unit', async () => {
      await db().collection('memberships').updateOne({ _id: oid(office.id.B_AGENT) }, { $set: { status: 'removed' } });
      try {
        const sheet = await potensi.person(office.as('B_AB'), office.id.B_AB);
        expect(sheet).toMatchObject({ person: { membershipId: office.id.B_AB, name: 'Lina Marlina', isReader: true }, unit: null });
      } finally {
        await db().collection('memberships').updateOne({ _id: oid(office.id.B_AGENT) }, { $set: { status: 'active' } });
      }
    });

    it('P19.1-T6 AC-3 AC-6 a leader whose account is gone: no name on their card, on their sheet, or on the unit line below them', async () => {
      const userId = oid(await userOf('SARI'));
      const account = await db().collection('users').findOne({ _id: userId });
      await db().collection('users').deleteOne({ _id: userId });
      try {
        expect(cardOf(await read('AGUS'), 'SARI').leader).toMatchObject({ membershipId: office.id.SARI, name: '' });
        expect((await potensi.person(office.as('AGUS'), office.id.SARI)).person).toMatchObject({ membershipId: office.id.SARI, name: '' });
        expect((await potensi.person(office.as('AGUS'), office.id.RINA)).unit).toMatchObject({ name: '', rung: { code: 'AAB' } });
      } finally {
        await db().collection('users').insertOne(account!);
      }
    });

    it('P19.1-T6 AC-3 an office whose row names no company has no ladder: every rung reads by its own code', async () => {
      await db().collection('kpms').updateOne({ _id: oid(KPM_B) }, { $unset: { companyId: '' } });
      try {
        const view = await read('B_AB');
        expect(everyone(view).map((p) => [p.name, p.rung])).toEqual([
          ['Lina Marlina', { code: 'AB', label: 'AB' }], ['Bayu Saputra', { code: 'AGENT', label: 'AGENT' }],
        ]);
        const sheet = await potensi.person(office.as('B_AB'), office.id.B_AGENT);
        expect(sheet.person.rung).toEqual({ code: 'AGENT', label: 'AGENT' });
        expect(sheet.unit).toEqual({ name: 'Lina Marlina', rung: { code: 'AB', label: 'AB' } });
      } finally {
        await db().collection('kpms').updateOne({ _id: oid(KPM_B) }, { $set: { companyId: COMPANY } });
      }
    });
  });
});
