import mongoose from 'mongoose';
import { RequestContext } from '@/common/context/request-context';
import { NoMembershipException } from '@/common/errors/domain.exception';
import { activeAgentsIn } from '@/modules/production/active-agents';
import { clearCollections, startMongo, stopMongo } from '../../../test/mongo';
import { configModule } from '../../../test/config-module';
import {
  buildCoachingOffice, KPM_A, KPM_B, ROSTER_NOW, ROSTER_TODAY, type CoachingOffice, type Who,
} from '../../../test/coaching-office';
import type { UnitDashboardView, UnitGroup, UnitRow } from './unit-dashboard.service';

const rowsOf = (g: UnitGroup): UnitRow[] => [g.head, ...g.members, ...g.units.flatMap(rowsOf)];
const everyRow = (v: UnitDashboardView): UnitRow[] => [...v.yourUnit.rows, ...v.units.flatMap(rowsOf), ...(v.unled?.rows ?? [])];

/**
 * **P19.18-T1, T2 — the Unit Dashboard for the whole office, and what each row and tile now carries** (ADR-0271; the brief
 * of 19 November 2026, part A). `test/coaching-office.ts`'s office — Wilson the Owner over Maya (the Admin), Agus and
 * Hendra, all ABs — today Monday 14 September 2026 in Jakarta; and, written here:
 *
 * - **three new hires** of September: one registered by Rina and placed under Hendra (outside Agus's tree), a test account
 *   registered by Rina, one of office B registered by Bayu — and one of August, registered by Budi;
 * - **leads registered** this year by Indah: two sales (one in September, one in March) and a recruitment one in
 *   September; one of office B's under Indah's id.
 */
describe('P19.18 the Unit Dashboard for the whole office (ADR-0271)', () => {
  let wired: ReturnType<typeof configModule>;
  let office: CoachingOffice;
  const db = () => mongoose.connection.db!;
  const read = (who: Who, query: Parameters<typeof wired.unitDashboard.read>[1] = {}) => wired.unitDashboard.read(office.as(who), query);
  const as = (who: Who, over: Record<string, unknown>) => {
    const ctx = office.as(who);
    return new RequestContext(ctx.userId, 'none', { ...ctx.membership!, ...over } as never);
  };
  const row = (view: UnitDashboardView, who: Who) => everyRow(view).find((r) => r.membershipId === office.id[who]);
  const hireIds: string[] = [];

  beforeAll(async () => {
    await startMongo();
    wired = configModule(ROSTER_NOW);
    await clearCollections();
    office = await buildCoachingOffice(wired);
    let seq = 0;
    const hire = (name: string, by: Who, joinDate: string, over: Record<string, unknown> = {}, kpmId = KPM_A) => {
      seq += 1;
      const userId = new mongoose.Types.ObjectId();
      const membershipId = new mongoose.Types.ObjectId();
      hireIds.push(String(membershipId));
      return {
        user: { _id: userId, email: `hire${seq}@whole.test`, passwordHash: 'x', fullName: name, status: 'active', platformRole: 'none', deletedAt: null },
        membership: {
          _id: membershipId, kpmId, userId: String(userId), agentCode: `WO-${seq}`, agentSeq: 700 + seq, leaderCode: `WO${seq}`,
          orgLevelId: 'x', orgLevelCode: 'AGENT', role: 'agent', leaderId: kpmId === KPM_A ? office.id.PEER_AB : office.id.B_AB,
          ancestorIds: kpmId === KPM_A ? [office.id.OWNER, office.id.PEER_AB] : [office.id.B_AB], depth: 2, status: 'active',
          joinedAt: new Date(`${joinDate}T02:00:00Z`), joinDate, joinedAs: 'new_hire', registeredByMembershipId: office.id[by],
          testAccount: false, deletedAt: null, groupIds: [], ...over,
        },
      };
    };
    const hires = [
      hire('Hilmy Ramadhan', 'RINA', '2026-09-03'),
      hire('FMT Uji Coba', 'RINA', '2026-09-05', { testAccount: true }),
      hire('Ayu Lestari', 'BUDI', '2026-08-20'),
      hire('Bayu Muda', 'B_AGENT', '2026-09-04', { status: 'removed' }, KPM_B),
    ];
    await db().collection('users').insertMany(hires.map((h) => h.user));
    await db().collection('memberships').insertMany(hires.map((h) => h.membership));
    const lead = (who: Who, type: string, registered: string, kpmId = KPM_A) => ({
      kpmId, ownerMembershipId: office.id[who], type, name: `${who} ${type} ${registered}`, statusCode: null, outcome: null,
      outcomeAt: null, commitments: [], nextActionDate: null, nextActionNote: null, version: 1, deletedAt: null,
      dateRegistered: new Date(`${registered}T03:00:00Z`), contact: { phone: null, email: null }, transitions: [],
    });
    await db().collection('leads').insertMany([
      lead('INDAH', 'sales', '2026-09-08'), lead('INDAH', 'sales', '2026-03-02'), lead('INDAH', 'recruitment', '2026-09-10'),
      lead('INDAH', 'sales', '2026-09-09', KPM_B),
    ]);
  }, 120_000);
  afterAll(stopMongo);

  describe('T1 AC-1, AC-2 the period and the view each reader opens on', () => {
    it('P19.18-T1 AC-1 a read with no period is Tahun ini: the window from 1 January to today', async () => {
      const view = await read('AGUS');
      expect(view).toMatchObject({ period: 'year', window: { from: '2026-01-01', to: ROSTER_TODAY } });
      expect(view.tiles.directGroupProduction.period).toBe('year');
    });

    it('P19.18-T1 AC-2 the Owner and an Admin open on Semua downline — the whole office; an AB on Grup langsung; an AAB with only a unit on Direct Unit', async () => {
      for (const [who, scope] of [['OWNER', 'downline'], ['ADMIN', 'downline'], ['AGUS', 'direct'], ['NINA', 'unit']] as const) {
        expect({ who, scope: (await read(who)).scope }).toEqual({ who, scope });
      }
      // The office's sixteen and the two new hires placed under Hendra here (Hilmy, Ayu); the test account never.
      expect(everyRow(await read('ADMIN'))).toHaveLength(18);
    });

    it('P19.18-T1 AC-2 a core leader keeps their own team, never the office (PERMISSIONS.md: CL own team)', async () => {
      const view = await wired.unitDashboard.read(as('AGUS', { isCoreLeader: true }));
      expect(view.scope).toBe('direct');
      expect(everyRow(view)).toHaveLength(11);
      expect(view.personCard).toBe(false);
    });
  });

  describe('T1 AC-3, AC-4 the navy tiles and the people behind them', () => {
    it('P19.18-T1 AC-3 Active Agent is the upload’s, over every row, the office’s month — `activeAgentsIn`, one definition', async () => {
      const view = await read('OWNER');
      const ids = everyRow(view).map((r) => r.membershipId);
      const reading = await activeAgentsIn(wired.productionReadings, office.as('OWNER'), ids, '2026-09');
      expect(view.tiles.activeAgent).toMatchObject({ month: '2026-09', held: reading.held, count: reading.count });
      expect(view.tiles.activeAgent.people.map((p) => p.membershipId)).toEqual(reading.people.map((p) => p.membershipId));
    });

    it('P19.18-T1 AC-4 each active person carries their photo, the roster’s unit they sit in, and the month’s APE and policies', async () => {
      const view = await read('OWNER');
      for (const p of view.tiles.activeAgent.people) {
        expect(p).toEqual(expect.objectContaining({ membershipId: expect.any(String), name: expect.any(String), photoUrl: null }));
        expect(p.unit === null || typeof p.unit.name === 'string').toBe(true);
      }
      const agusPeople = view.tiles.activeAgent.people.filter((p) => p.unit?.membershipId === office.id.AGUS);
      expect(agusPeople.every((p) => rowsOf(view.units.find((u) => u.head.membershipId === office.id.AGUS)!).some((r) => r.membershipId === p.membershipId))).toBe(true);
    });

    it('P19.18-T1 AC-4 an Active Agent with no leader in the office is under Belum punya leader, and the sheet names no unit for them', async () => {
      const userId = new mongoose.Types.ObjectId();
      const membershipId = new mongoose.Types.ObjectId();
      await db().collection('users').insertOne({
        _id: userId, email: 'unled@whole.test', passwordHash: 'x', fullName: 'Tanpa Leader', status: 'active', platformRole: 'none', deletedAt: null,
      });
      await db().collection('memberships').insertOne({
        _id: membershipId, kpmId: KPM_A, userId: String(userId), agentCode: 'WO-UNLED', agentSeq: 799, leaderCode: 'WOUNLED',
        orgLevelId: 'x', orgLevelCode: 'AGENT', role: 'agent', leaderId: null, ancestorIds: [], depth: 0, status: 'active',
        joinedAt: new Date('2026-01-02T02:00:00Z'), testAccount: false, deletedAt: null, groupIds: [],
      });
      await db().collection('monthlyAgentData').insertOne({
        kpmId: KPM_A, membershipId: String(membershipId), month: '2026-09', agentCode: 'WO-UNLED', deletedAt: null,
        templateId: null, templateVersion: 1, asOf: null, values: { APE: { value: 7 * 1_000_000 * 100, provenance: 'imported' } }, ytdValues: {},
      });
      try {
        const view = await read('OWNER');
        expect(view.unled!.rows.map((r) => r.membershipId)).toContain(String(membershipId));
        expect(view.tiles.activeAgent.people.find((p) => p.membershipId === String(membershipId)))
          .toMatchObject({ name: 'Tanpa Leader', unit: null, apeMinor: 7 * 1_000_000 * 100 });
      } finally {
        await db().collection('monthlyAgentData').deleteOne({ membershipId: String(membershipId) });
        await db().collection('memberships').deleteOne({ _id: membershipId });
        await db().collection('users').deleteOne({ _id: userId });
      }
    });

    it('P19.18-T1 AC-3, AC-4 Recruitment is the new hires who joined this month, credited to somebody on the roster — never a test account, another office’s or last month’s', async () => {
      const owner = await read('OWNER');
      expect(owner.tiles.recruitment).toEqual({
        month: '2026-09', count: 1,
        people: [{
          membershipId: hireIds[0], name: 'Hilmy Ramadhan', photoUrl: null, joinDate: '2026-09-03',
          recruitedBy: { membershipId: office.id.RINA, name: 'Rina Wijaya' },
        }],
      });
      // Agus's roster holds Rina: Hilmy is his Recruitment too, though placed under Hendra since.
      expect((await read('AGUS')).tiles.recruitment.count).toBe(1);
      // Hendra's does not: credit is who registered, never where somebody sits.
      expect((await read('PEER_AB')).tiles.recruitment.count).toBe(0);
    });

    it('P19.18-T1 AC-3 cross-tenant: office B’s new hire is office B’s Recruitment and nowhere in office A’s', async () => {
      const b = office.as('B_AB');
      const bOwner = new RequestContext(b.userId, 'none', { ...b.membership!, isKpmOwner: true });
      expect((await wired.unitDashboard.read(bOwner)).tiles.recruitment.people.map((p) => p.name)).toEqual(['Bayu Muda']);
      expect(JSON.stringify(await read('OWNER'))).not.toContain('Bayu Muda');
    });
  });

  describe('T1 AC-8, AC-9 what a row carries', () => {
    it('P19.18-T1 AC-8 the coaching status tile: red never, green to 14 days, yellow after — the reader’s own row included', async () => {
      const view = await read('AGUS');
      for (const r of everyRow(view)) {
        const expected = r.coaching.days === null ? 'never' : r.coaching.days <= 14 ? 'recent' : 'lapsed';
        expect({ who: r.name, status: r.coaching.status }).toEqual({ who: r.name, status: expected });
      }
      expect(row(view, 'RINA')!.coaching).toEqual({ status: 'recent', days: 0, coach: { membershipId: office.id.SARI, name: 'Sari Puspita' } });
      expect(row(view, 'AGUS')!.coaching.status).toBeDefined();
      expect(row(view, 'AGUS')!.lastOneOnOne).toBeNull();
    });

    it('P19.18-T1 AC-8 Leads sales n · Leads rekrut n count the leads registered in the period, by type — never another office’s', async () => {
      expect(row(await read('AGUS'), 'INDAH')!.periodLeads).toMatchObject({ sales: expect.any(Number), recruitment: expect.any(Number) });
      const year = row(await read('AGUS', { period: 'year' }), 'INDAH')!.periodLeads;
      const month = row(await read('AGUS', { period: 'month' }), 'INDAH')!.periodLeads;
      // March's sales lead is this year's, not September's; office B's lead under her id is nobody's here.
      expect(year.sales - month.sales).toBe(1);
      expect(month.recruitment).toBeGreaterThanOrEqual(1);
    });

    it('P19.18-T1 AC-9 the person card’s numbers: potensi this month and activity over the last 7 days', async () => {
      const view = await read('AGUS', { period: '7d' });
      const indah = row(view, 'INDAH')!;
      expect(indah.potensi).toEqual({ sales: expect.any(Number), recruitment: expect.any(Number) });
      // Under *7 hari terakhir* the card's 7 days are the period's own counts.
      const counts = await wired.activityReadings.countsOverMany(office.as('AGUS'), [indah.membershipId], view.window);
      expect(indah.activity7d).toBe([...(counts.get(indah.membershipId)?.values() ?? [])].reduce((a, b) => a + b, 0));
      expect(row(await read('AGUS'), 'INDAH')!.activity7d).toBe(indah.activity7d);
    });

    it('P19.18-T1 AC-9 the card is the KPM Owner’s and an Admin’s; an AB, an AAB and an Agent go straight to the profile', async () => {
      for (const [who, card] of [['OWNER', true], ['ADMIN', true], ['AGUS', false], ['SARI', false], ['INDAH', false]] as const) {
        expect({ who, card: (await read(who)).personCard }).toEqual({ who, card });
      }
    });
  });

  describe('T2 AC-2 Aktivitas for the whole office', () => {
    it('P19.18-T2 AC-2 the Owner and an Admin see one column per person of the office, AB → AAB → agents within each unit', async () => {
      for (const who of ['OWNER', 'ADMIN'] as const) {
        const table = await wired.unitActivities.read(office.as(who), {});
        expect({ who, columns: table.people.length }).toEqual({ who, columns: 18 });
      }
      const owner = await wired.unitActivities.read(office.as('OWNER'), {});
      const names = owner.people.map((p) => p.name);
      expect(names[0]).toBe('Wilson Tanoto');
      // Agus's unit: Agus, then Dewi (an AAB), then his agents, then Sari's team.
      const agus = names.indexOf('Agus Salim');
      expect(names.slice(agus, agus + 4)).toEqual(['Agus Salim', 'Dewi Lestari', 'Dimas Pratama', 'Indah Permatasari']);
      expect(names).not.toContain('Fajar Nugroho');
    });

    it('P19.18-T2 AC-2 an AB’s Group stays Grup langsung; a core leader’s too', async () => {
      expect((await wired.unitActivities.read(office.as('AGUS'), {})).people).toHaveLength(11);
      expect((await wired.unitActivities.read(as('AGUS', { isCoreLeader: true }), {})).people).toHaveLength(11);
    });

    it('P19.18-T2 AC-2 test accounts are never a column (ADR-0267 §1)', async () => {
      await db().collection('memberships').updateOne({ _id: new mongoose.Types.ObjectId(office.id.TARI) }, { $set: { testAccount: true } });
      try {
        const owner = await wired.unitActivities.read(office.as('OWNER'), {});
        expect(owner.people.map((p) => p.membershipId)).not.toContain(office.id.TARI);
      } finally {
        await db().collection('memberships').updateOne({ _id: new mongoose.Types.ObjectId(office.id.TARI) }, { $set: { testAccount: false } });
      }
    });
  });

  describe('who is refused', () => {
    it('P19.18 a Super Admin inside a KPM holds no membership: these field pages still refuse them (OD-377, Phase 19.23)', async () => {
      const inside = RequestContext.superAdminInKpm(RequestContext.platform('root'), KPM_A);
      await expect(wired.unitDashboard.read(inside)).rejects.toBeInstanceOf(NoMembershipException);
      await expect(wired.coachingRoster.read(inside)).rejects.toBeInstanceOf(NoMembershipException);
    });

    it('P19.18 an AB naming another AB’s unit is not found; the Owner opens it read-only, on Grup langsung', async () => {
      await expect(read('AGUS', { for: office.id.PEER_AB })).rejects.toMatchObject({ status: 404 });
      await expect(read('AGUS', { for: office.id.B_AB })).rejects.toMatchObject({ status: 404 });
      expect(await read('OWNER', { for: office.id.AGUS })).toMatchObject({ readOnly: true, scope: 'direct', personCard: true });
    });
  });
});
