import { Logger } from '@nestjs/common';
import mongoose from 'mongoose';
import { RequestContext } from '@/common/context/request-context';
import { readerIn, SOURCE_READER } from '@/common/i18n/reader';
import { UNIT_DASHBOARD_CORRECTION_REASON } from '@/domain/constants';
import { clearCollections, startMongo, stopMongo } from '../../../test/mongo';
import { configModule } from '../../../test/config-module';
import { NO_CLASS } from '../../../test/http-permissions';
import {
  buildCoachingOffice, COMPANY, KPM_A, KPM_B, ROSTER_NOW, ROSTER_TODAY, type CoachingOffice, type Who,
} from '../../../test/coaching-office';
import { seedUnitLeads, UNIT_MONTH } from '../../../test/unit-office';
import { MonthlyAgentData } from '../production/monthly-agent-data.schema';

/** The twelve value columns of a version 1 file, keyed `metric.cadence` as these specs name them. */
const VALUE_COLUMNS = (['monthly', 'ytd'] as const).flatMap((cadence) =>
  (['ape', 'persistency', 'recruitment', 'newActiveAgents', 'fyp', 'policyCount'] as const).map((metric) => ({ metric, cadence })));
import { TEMPLATE_HEADER_V1 } from '../production/production-template';
import type { UnitDashboardView, UnitGroup, UnitRow } from './unit-dashboard.service';

const M = 1_000_000 * 100;

/** Every row of a dashboard, in the order drawn. */
const rowsOf = (group: UnitGroup): UnitRow[] => [group.head, ...group.members, ...group.units.flatMap(rowsOf)];
const everyRow = (view: UnitDashboardView): UnitRow[] => [...view.yourUnit.rows, ...view.units.flatMap(rowsOf)];

/**
 * **The Unit Dashboard on real rows** (P15-T1, P15-T3; `functional/unit-dashboard.md`), and **its tenant
 * boundary** (P15-T1 AC-9, P15-T4 AC-5): office 0417 (KPM A) and 0555 (KPM B) on one database, a leader of
 * one never reading or writing the other's people. The office is `test/coaching-office.ts`'s, with the leads
 * `test/unit-office.ts` adds. Over HTTP, per role, is `unit-dashboard.int.spec.ts`.
 */
describe('the Unit Dashboard (Phase 15)', () => {
  let wired: ReturnType<typeof configModule>;
  let office: CoachingOffice;
  const db = () => mongoose.connection.db!;

  beforeAll(async () => {
    await startMongo();
    wired = configModule(ROSTER_NOW);
    await clearCollections();
    office = await buildCoachingOffice(wired);
    await seedUnitLeads(office);
  }, 120_000);
  afterAll(stopMongo);

  const read = (who: Who, query: Parameters<typeof wired.unitDashboard.read>[1] = {}) =>
    wired.unitDashboard.read(office.as(who), query);
  const rowFor = (view: UnitDashboardView, who: Who) => everyRow(view).find((r) => r.membershipId === office.id[who])!;
  const names = (rows: UnitRow[]) => rows.map((r) => r.name);
  const reads = () => db().collection('auditLog').countDocuments({ action: 'activity_log.read_raw', 'after.surface': 'unit_dashboard' });
  const state = () => wired.productionMonths.state(office.as('OWNER'), UNIT_MONTH);
  const save = async (who: Who, rows: { membershipId: string; apeMonthlyMinor?: number; apeYtdMinor?: number }[], revision?: number) =>
    // Saved by a leader reading the API's English — the reason is stored in the saver's language, and nobody's choice
    // is Bahasa Indonesia since P18.10-T4's exit (AC-6 below pins both).
    wired.unitDashboard.updateProduction(office.as(who).withReader(SOURCE_READER), {
      month: UNIT_MONTH, revision: revision ?? (await state()).revision, rows,
    });
  /** A member's APE cell this month, by kode (P19.5-T2; ADR-0214 §9). */
  const cell = async (who: Who) =>
    (await db().collection('monthlyAgentData').findOne({ kpmId: KPM_A, membershipId: office.id[who], month: UNIT_MONTH }))?.values?.APE;
  const snapshot = async () => ({
    rows: await db().collection('monthlyAgentData').find({}).sort({ _id: 1 }).toArray(),
    audit: await db().collection('auditLog').countDocuments({}),
    revision: (await state()).revision,
  });

  describe('P15-T1 AC-1, AC-2 — the reach and the groups', () => {
    it('P15-T1 AC-2 an AB: Your Unit is the reader and their agents who lead nobody; every other direct report heads a unit, nested two deep', async () => {
      const view = await read('AGUS');

      expect(view.head).toEqual({ membershipId: office.id.AGUS, name: 'Agus Salim', isReader: true });
      expect(view.empty).toBe(false);
      expect(names(view.yourUnit.rows)).toEqual(['Agus Salim', 'Dimas Pratama', 'Indah Permatasari']);
      expect(view.units.map((u) => u.head.name)).toEqual(['Dewi Lestari', 'Lukas Hartono', 'Sari Puspita']);
      const sari = view.units[2];
      // The head's direct reports who lead nobody, A to Z; then each who leads, with their own unit.
      expect(names(sari.members)).toEqual(['Budi Santoso', 'Rina Wijaya']);
      expect(sari.units.map((u) => [u.head.name, ...names(u.members)])).toEqual([['Nina Lestari', 'Dodi Kurniawan']]);
      expect(sari.units[0].units).toEqual([]);
      // A unit head nobody reports to stands alone; an Agent who leads heads a unit, as on the coaching roster.
      expect(view.units[0]).toMatchObject({ members: [], units: [] });
      expect(names(view.units[1].members)).toEqual(['Tari Anggraini']);
    });

    it('P15-T1 AC-2 depth counts the edges from the head; leads says who heads somebody; the rung is the ladder’s', async () => {
      const view = await read('AGUS');
      expect(view.yourUnit.rows.map((r) => [r.name, r.depth, r.leads, r.isReader])).toEqual([
        ['Agus Salim', 0, true, true], ['Dimas Pratama', 1, false, false], ['Indah Permatasari', 1, false, false],
      ]);
      const sari = view.units[2];
      expect([sari.head.depth, sari.head.leads, sari.head.rung]).toEqual([1, true, { code: 'AAB', label: 'AAB' }]);
      expect(sari.units[0].members[0]).toMatchObject({ name: 'Dodi Kurniawan', depth: 3, leads: false });
      expect(view.units[0].head).toMatchObject({ name: 'Dewi Lestari', leads: false });
    });

    it('P15-T1 AC-2 the rows are the reader and exactly whom the coaching roster lists, in the same groups', async () => {
      for (const who of ['AGUS', 'SARI', 'NINA', 'LUKAS', 'OWNER', 'PEER_AB', 'PEER_AAB', 'B_AB'] as const) {
        const [view, roster] = await Promise.all([read(who), wired.coachingRoster.read(office.as(who))]);
        expect({ who, ids: everyRow(view).slice(1).map((r) => r.membershipId).sort() }).toEqual({
          who, ids: [...roster.directAgents, ...roster.units.flatMap((u) => [u.head, ...u.members])].map((r) => r.membershipId).sort(),
        });
        // Your Unit adds only the reader to the roster's direct agents, in the same order.
        expect({ who, direct: view.yourUnit.rows.slice(1).map((r) => r.membershipId) })
          .toEqual({ who, direct: roster.directAgents.map((r) => r.membershipId) });
        // Each unit holds the same people as the roster's, its head first.
        expect({ who, units: view.units.map((u) => [u.head.membershipId, ...rowsOf(u).slice(1).map((r) => r.membershipId).sort()]) })
          .toEqual({ who, units: roster.units.map((u) => [u.head.membershipId, ...u.members.map((r) => r.membershipId).sort()]) });
      }
    });

    it('P15-T1 AC-1 an AAB reads their subtree, a nested AAB’s agent included, and nobody beside them', async () => {
      const view = await read('SARI');
      expect(names(everyRow(view))).toEqual(['Sari Puspita', 'Budi Santoso', 'Rina Wijaya', 'Nina Lestari', 'Dodi Kurniawan']);
      expect(JSON.stringify(view)).not.toContain(office.id.PEER_AGENT);
    });

    it('P15-T1 AC-1 a member who leads nobody — an Agent, an AAB with no reports, the Admin above nobody — is answered an empty unit, never refused', async () => {
      for (const who of ['INDAH', 'DEWI', 'ADMIN', 'TARI'] as const) {
        const view = await read(who);
        expect({ who, empty: view.empty, rows: view.yourUnit.rows, units: view.units }).toEqual({ who, empty: true, rows: [], units: [] });
        expect(view.head).toEqual({ membershipId: office.id[who], name: office.name[who], isReader: true });
        expect(view.tiles).toEqual({
          team: { total: 0, direct: 0, units: 0, underUnits: 0, newHires: 0 },
          directGroupProduction: {
            targetMinor: null, actualMinor: null, attainmentPct: null, missing: 0, gapMinor: null, overMinor: null, period: 'month',
          },
          potentialActive: { count: 0, of: 0, unit: { count: 0, of: 0 }, aab: { count: 0, of: 0 } },
          potentialRecruits: { yourUnit: 0, aabs: 0 },
        });
        expect(view.production.canUpdate).toBe(false);
      }
      // Under This year the empty tile says so too.
      expect((await read('INDAH', { period: 'year' })).tiles.directGroupProduction.period).toBe('year');
    });

    it('P15-T1 AC-1 an Agent who leads somebody reads their unit, as the coaching roster answers them (ADR-0087)', async () => {
      const view = await read('LUKAS');
      expect(names(everyRow(view))).toEqual(['Lukas Hartono', 'Tari Anggraini']);
      // The Agent holds `own` on the write's matrix row nowhere: no correction from the dashboard.
      expect(view.production.canUpdate).toBe(false);
    });

    it('P15-T1 AC-1 `for` opens a unit below the reader: that leader’s roster, their row named rather than the reader’s', async () => {
      const view = await read('AGUS', { for: office.id.SARI });
      expect(view.head).toEqual({ membershipId: office.id.SARI, name: 'Sari Puspita', isReader: false });
      expect(names(view.yourUnit.rows)).toEqual(['Sari Puspita', 'Budi Santoso', 'Rina Wijaya']);
      expect(view.yourUnit.rows[0]).toMatchObject({ isReader: false, depth: 0, leads: true });
      // Her row is somebody Agus coaches: coaching's last 1:1 is hers — twelve days ago with Agus, overdue.
      expect(view.yourUnit.rows[0].lastOneOnOne).toMatchObject({ days: 12, overdue: true, coach: { name: 'Agus Salim' } });
      expect(view.units.map((u) => u.head.name)).toEqual(['Nina Lestari']);
      expect(view.production.canUpdate).toBe(true);
    });

    it('P15-T4 AC-2 `coached`: every row of a leader’s own unit, or of one below them, is theirs to open in coaching', async () => {
      for (const [who, query] of [['AGUS', {}], ['AGUS', { for: office.id.SARI }], ['SARI', { for: office.id.NINA }]] as const) {
        expect({ who, coached: everyRow(await read(who, query)).every((r) => r.coached) }).toEqual({ who, coached: true });
      }
      // The Owner is the office's root AB: everybody is below them.
      expect(everyRow(await read('OWNER', { for: office.id.AGUS })).every((r) => r.coached)).toBe(true);
    });

    /*
     * Was *Phase 15 exit S1/S2: an Agent-rung leader opens no coaching tab but their own — their Summary grant is `own`*,
     * Tari's row `coached: false`. P19.9-T6 (ADR-0234, OD-287) answered ADR-0087's open question: every upline coaches.
     */
    it('P19.9-T6 AC-3 `coached`: an Agent-rung leader opens their coachees’ coaching tabs, as an AB does (ADR-0234)', async () => {
      const view = await read('LUKAS');
      expect(everyRow(view).map((r) => [r.name, r.isReader, r.coached])).toEqual([
        ['Lukas Hartono', true, true], ['Tari Anggraini', false, true],
      ]);
      // As the coaching tab answers them: the Summary of somebody below is theirs to read, and nobody else's.
      await expect(wired.summary.read(office.as('LUKAS'), office.id.TARI)).resolves.toHaveProperty('activity');
      await expect(wired.summary.read(office.as('LUKAS'), office.id.INDAH)).rejects.toMatchObject({ code: 'NOT_FOUND' });
    });

    it('P15-T4 AC-2 `coached`: an Admin who is not the root, reading a unit outside their downline, coaches none of it', async () => {
      const view = await read('ADMIN', { for: office.id.AGUS });
      expect(everyRow(view).length).toBeGreaterThan(1);
      expect(everyRow(view).filter((r) => r.coached)).toEqual([]);
      // And a peer AB made an Admin coaches their own unit's rows, and nobody else's.
      const peer = new RequestContext('u-peer', 'none', { ...office.as('PEER_AB').membership!, isKpmAdmin: true });
      const theirs = everyRow(await wired.unitDashboard.read(peer, { for: office.id.PEER_AAB }));
      expect(theirs.map((r) => [r.name, r.coached])).toEqual([['Putu Ayu', true], ['Yusuf Ramadhan', true]]);
      const outside = everyRow(await wired.unitDashboard.read(peer, { for: office.id.SARI }));
      expect(outside.every((r) => !r.coached)).toBe(true);
    });

    it('P15-T1 AC-1 the Owner and the Admin open any leader’s unit in the office', async () => {
      expect((await read('ADMIN', { for: office.id.AGUS })).head).toMatchObject({ name: 'Agus Salim', isReader: false });
      expect((await read('OWNER', { for: office.id.PEER_AAB })).yourUnit.rows.map((r) => r.name)).toEqual(['Putu Ayu', 'Yusuf Ramadhan']);
      // An Owner or an Admin with no rung at all holds `own-kpm` alone.
      const ownerOnly = new RequestContext('u-o', 'none', {
        ...office.as('ADMIN').membership!, orgLevelCode: 'NO_RUNG', hierarchyRole: NO_CLASS,
      });
      expect((await wired.unitDashboard.read(ownerOnly, { for: office.id.NINA })).head.name).toBe('Nina Lestari');
    });

    it.each([
      ['the reader themselves', 'AGUS', 'AGUS'],
      ['somebody who leads nobody', 'AGUS', 'INDAH'],
      ['a peer AAB outside the reach', 'SARI', 'LUKAS'],
      ['a peer AB’s AAB', 'AGUS', 'PEER_AAB'],
      ['a member who left', 'AGUS', 'LEFT'],
      ['another office’s leader', 'AGUS', 'B_AB'],
      ['another office’s leader, asked by the Owner', 'OWNER', 'B_AB'],
      ['somebody who leads nobody, asked by the Admin', 'ADMIN', 'DEWI'],
      ['the reader’s own leader', 'SARI', 'AGUS'],
      ['a member who left, asked by the Owner, whose reach keeps history', 'OWNER', 'LEFT'],
      ['a leader above, by an Agent who leads nobody', 'INDAH', 'SARI'],
      ['a leader outside an Agent-rung leader’s downline', 'LUKAS', 'SARI'],
      ['a peer AAB’s agent', 'AGUS', 'PEER_AGENT'],
      ['a peer AAB’s agent, by an AAB', 'SARI', 'PEER_AGENT'],
    ] as const)('P15-T1 AC-9 `for` naming %s is 404, never 403, and records nothing', async (_, reader, named) => {
      const before = await reads();
      await expect(read(reader, { for: office.id[named] })).rejects.toMatchObject({ code: 'NOT_FOUND' });
      expect(await reads()).toBe(before);
    });

    it('P15-T1 AC-9 a malformed id in `for` finds nothing, rather than failing', async () => {
      await expect(read('AGUS', { for: 'not-an-id' })).rejects.toMatchObject({ code: 'NOT_FOUND' });
      await expect(read('OWNER', { for: 'not-an-id' })).rejects.toMatchObject({ code: 'NOT_FOUND' });
    });

    it('P15-T1 AC-1 a Super Admin outside a support session has no office to read from', async () => {
      await expect(wired.unitDashboard.read(RequestContext.platform('root'))).rejects.toMatchObject({ code: 'TENANT_NO_MEMBERSHIP' });
    });
  });

  describe('P15-T1 AC-3 — each row’s figures, from the functions the person’s own screens use', () => {
    it('P15-T1 AC-5 goal figures are the Summary’s, for the month and the year, row by row', async () => {
      const agus = office.as('AGUS');
      const [month, year] = await Promise.all([read('AGUS'), read('AGUS', { period: 'year' })]);
      for (const row of everyRow(month)) {
        const summary = await wired.summary.read(agus, row.isReader ? undefined : row.membershipId);
        const yearly = everyRow(year).find((r) => r.membershipId === row.membershipId)!;
        const { source: mSource, ...mFigures } = row.goal;
        const { source: ySource, ...yFigures } = yearly.goal;
        expect({ who: row.name, ...mFigures }).toEqual({
          who: row.name, set: summary.goal.set, period: 'month', caseSizeMinor: summary.caseSizeMinor,
          targetMinor: summary.monthly.targetMinor, actualMinor: summary.monthly.actualMinor,
          attainmentPct: summary.monthly.attainmentPct, gapMinor: summary.monthly.gapMinor, overMinor: summary.monthly.overMinor,
          policiesNeeded: summary.monthly.policiesNeeded, targetMet: summary.monthly.targetMet,
        });
        /*
         * **The office's figure, or nothing** (P19.1-T4 AC-12, ADR-0195): where the Summary's year is the member's own
         * (`self_reported` — an estimate, or nothing typed), the dashboard holds no APE produced for the year and no
         * source; the target is the same.
         */
        const own = summary.yearly.source.provenance === 'self_reported';
        expect({ who: row.name, ...yFigures }).toEqual({
          who: row.name, set: summary.goal.set, period: 'year', caseSizeMinor: summary.caseSizeMinor,
          targetMinor: summary.yearly.targetMinor, actualMinor: own ? null : summary.yearly.actualMinor,
          attainmentPct: own ? null : summary.yearly.attainmentPct, gapMinor: own ? null : summary.yearly.gapMinor,
          overMinor: own ? null : summary.yearly.overMinor,
          policiesNeeded: own ? null : summary.yearly.policiesNeeded, targetMet: own ? false : summary.yearly.targetMet,
        });
        // Where the figure came from, and who corrected it — the Summary's `FigureSource`, whole, when it is the office's.
        expect({ who: row.name, source: mSource }).toEqual({ who: row.name, source: summary.monthly.source });
        expect({ who: row.name, source: ySource }).toEqual({ who: row.name, source: own ? null : summary.yearly.source });
      }
    });

    it('P15-T1 AC-5 the bulk plans are `planOf`’s, member by member — a saved goal and the office’s defaults alike', async () => {
      const agus = office.as('AGUS');
      const ids = [office.id.INDAH, office.id.DODI, office.id.SARI];
      const ledgers = await wired.productionReadings.ledgersFor(agus, ids, UNIT_MONTH);
      const plans = await wired.goals.plansOf(agus, '2026', ids, new Map(ids.map((id) => [id, ledgers.get(id)!.standing.yearToDate])));
      for (const id of ids) {
        // `measured` is the member's own read's alone; nothing else differs.
        expect({ ...plans.get(id)!, measured: null }).toEqual({ ...(await wired.goals.planOf(agus, '2026', id)), measured: null });
      }
      expect(await wired.goals.plansOf(agus, '2026', [], new Map())).toEqual(new Map());
    });

    it('P15-T1 AC-3 Indah’s month, worked: Rp 80 M of an Rp 85 M target, 94%, Rp 5 M and one policy short', async () => {
      const indah = rowFor(await read('AGUS'), 'INDAH');
      expect(indah.goal).toEqual({
        set: true, period: 'month', targetMinor: 85 * M, actualMinor: 80 * M, attainmentPct: 94, gapMinor: 5 * M,
        overMinor: 0, policiesNeeded: 1, caseSizeMinor: 18 * M, targetMet: false,
        source: { provenance: 'imported', month: UNIT_MONTH, correctedBy: null, correctedAt: null },
      });
    });

    it('P15-T1 AC-3 Not uploaded yet and No goal set are null, never 0', async () => {
      const view = await read('AGUS');
      const dodi = rowFor(view, 'DODI');
      expect(dodi.goal).toMatchObject({ set: false, targetMinor: null, actualMinor: null, attainmentPct: null, source: null });
      expect(dodi.production).toEqual({
        monthly: { valueMinor: null, provenance: null, correctedBy: null, correctedAt: null },
        ytd: { valueMinor: null, provenance: null, correctedBy: null, correctedAt: null },
      });
      expect(dodi.status).toBe('no_goal_set');
      expect(dodi.pacingToMaa).toBeNull();
      expect(dodi.activity.touches).toEqual({ logged: 0, target: null });
      // Sari has this month's file and no goal: a figure without a target.
      expect(rowFor(view, 'SARI').goal).toMatchObject({ set: false, targetMinor: null, actualMinor: 90 * M, attainmentPct: null });
    });

    it('P15-T1 AC-3 production is the month table’s cells, with their provenance', async () => {
      const [view, table] = await Promise.all([read('AGUS'), wired.production.readMonth(office.as('OWNER'), UNIT_MONTH)]);
      for (const row of everyRow(view)) {
        const mine = table.rows.find((r) => r.membershipId === row.membershipId)!;
        // The year to date is the months' sum on both (R4, P19.5-T2).
        expect({ who: row.name, monthly: row.production.monthly.valueMinor, ytd: row.production.ytd.valueMinor, p: row.production.monthly.provenance })
          .toEqual({ who: row.name, monthly: mine.values.APE.value, ytd: mine.ytd.APE.value, p: mine.values.APE.provenance });
      }
    });

    it('P15-T1 AC-3 status, the pacing mark and the last 1:1 are coaching’s, for the calendar month whatever the period', async () => {
      const roster = await wired.coachingRoster.read(office.as('AGUS'));
      const rosterRows = [...roster.directAgents, ...roster.units.flatMap((u) => [u.head, ...u.members])];
      for (const period of ['7d', 'month', 'year'] as const) {
        const view = await read('AGUS', { period });
        for (const row of everyRow(view).filter((r) => !r.isReader)) {
          const coached = rosterRows.find((r) => r.membershipId === row.membershipId)!;
          expect({ period, who: row.name, status: row.status, last: row.lastOneOnOne })
            .toEqual({ period, who: row.name, status: coached.status, last: coached.lastOneOnOne });
        }
      }
      const view = await read('AGUS');
      expect(['INDAH', 'DIMAS', 'RINA'].map((who) => rowFor(view, who as Who).status))
        .toEqual(['on_track', 'watch_closely', 'needs_attention']);
      // The reader's own row: no last 1:1 of their own here, and still their own status.
      expect(view.yourUnit.rows[0]).toMatchObject({ isReader: true, lastOneOnOne: null, status: 'no_goal_set' });
    });

    it('P15-T1 AC-3 activity is the goal’s three cascade codes over the period, against the Summary’s targets — pro-rated for the last 7 days', async () => {
      const agus = office.as('AGUS');
      const indah = (period: '7d' | 'month' | 'year') => read('AGUS', { period }).then((v) => rowFor(v, 'INDAH'));
      const summary = await wired.summary.read(agus, office.id.INDAH);
      const week = await wired.activityLogs.weekOf(agus, { membershipId: office.id.INDAH, orgLevelCode: 'AGENT' });
      const chips = (targets: { logged: number; target: number | null }[]) => targets.map((t) => ({ logged: t.logged, target: t.target }));

      const month = await indah('month');
      expect(chips([month.activity.leads, month.activity.appointments, month.activity.closings])).toEqual(chips(summary.activity.monthly.targets));
      const year = await indah('year');
      expect(chips([year.activity.leads, year.activity.appointments, year.activity.closings])).toEqual(chips(summary.activity.yearly.targets));
      const seven = await indah('7d');
      expect(chips([seven.activity.leads, seven.activity.appointments, seven.activity.closings])).toEqual(chips(week.targets));
      // Two leads a day on ten days, three of them in the last week.
      expect([month.activity.leads.logged, seven.activity.leads.logged]).toEqual([20, 6]);
      const sum = (t: { logged: number; target: number | null }[]) => ({
        logged: t.reduce((s, x) => s + x.logged, 0), target: t.reduce((s, x) => s + (x.target as number), 0),
      });
      expect(month.activity.touches).toEqual(sum(chips(summary.activity.monthly.targets)));
      // Under *Last 7 days* the goal figures are still the month's: nobody reports a week's APE.
      expect(seven.goal).toEqual(month.goal);
    });

    it('P15-T1 AC-3 the four lead counts, through the leads module’s rules', async () => {
      const view = await read('AGUS');
      expect(rowFor(view, 'RINA').leadsCounts).toEqual({ salesOpen: 3, salesClosing: 1, recruitOpen: 2, recruitNominated: 1 });
      expect(rowFor(view, 'INDAH').leadsCounts).toEqual({ salesOpen: 1, salesClosing: 1, recruitOpen: 1, recruitNominated: 1 });
      expect(rowFor(view, 'DODI').leadsCounts).toEqual({ salesOpen: 0, salesClosing: 0, recruitOpen: 1, recruitNominated: 0 });
      expect(rowFor(view, 'DIMAS').leadsCounts).toEqual({ salesOpen: 0, salesClosing: 0, recruitOpen: 0, recruitNominated: 0 });
    });

    it('P15-T1 AC-3 OD-140 the next open action item of the latest finalized session, overdue by office days or dated', async () => {
      const view = await read('AGUS');
      expect(rowFor(view, 'INDAH').followUp).toEqual({ text: 'Book two presentations', dueDate: '2026-09-10', overdueDays: 4 });
      expect(rowFor(view, 'SARI').followUp).toEqual({ text: 'Book two presentations', dueDate: '2026-09-02', overdueDays: 12 });
      // Rina's latest is today's, due today: dated, not overdue. A draft (Dimas's) is no session.
      expect(rowFor(view, 'RINA').followUp).toEqual({ text: 'Book two presentations', dueDate: ROSTER_TODAY, overdueDays: null });
      expect(rowFor(view, 'DIMAS').followUp).toBeNull();
      expect(rowFor(view, 'DODI').followUp).toBeNull();
    });
  });

  describe('P15-T1 AC-4 — totals and tiles: sums of the rows they cover, percentages from the sums', () => {
    it.each(['7d', 'month', 'year'] as const)('P15-T1 AC-4 every unit, every tile, %s', async (period) => {
      for (const who of ['AGUS', 'SARI', 'OWNER'] as const) {
        const view = await read(who, { period });
        const check = (everybody: UnitRow[], total: UnitDashboardView['yourUnit']['total']) => {
          const held = (values: (number | null)[]) => {
            const kept = values.filter((v): v is number => v !== null);
            return kept.length ? kept.reduce((a, b) => a + b, 0) : null;
          };
          // The goal and *on pace* over the people who count for production (ADR-0172 §2, P18.8-T5 AC-2).
          const rows = everybody.filter((r) => !r.newHireBeforeFirstSale);
          expect(total.newHires).toBe(everybody.length - rows.length);
          const actual = held(rows.map((r) => r.goal.actualMinor));
          // Paired (ADR-0165 §1, P18.5-T15 AC-6): a target counts only beside production held — every target when
          // nobody's is, so the total reads *Not uploaded yet* beside them as a row does.
          const counted = actual === null ? rows : rows.filter((r) => r.goal.actualMinor !== null);
          const target = held(counted.map((r) => r.goal.targetMinor));
          const both = target !== null && actual !== null;
          expect(total.goal).toEqual({
            targetMinor: target, actualMinor: actual,
            attainmentPct: target && actual !== null ? Math.min(999, Math.round((actual / target) * 100)) : null,
            missing: rows.filter((r) => r.goal.actualMinor === null).length,
            gapMinor: both ? Math.max(0, target - actual) : null,
            overMinor: both ? Math.max(0, actual - target) : null,
          });
          for (const key of ['salesOpen', 'salesClosing', 'recruitOpen', 'recruitNominated'] as const) {
            expect(total.leadsCounts[key]).toBe(everybody.reduce((s, r) => s + r.leadsCounts[key], 0));
          }
          // UI-028: a total's *Closing* is its rows'.
          expect(total.closings).toBe(everybody.reduce((s, r) => s + r.closings, 0));
          expect(total.touches).toEqual({
            logged: everybody.reduce((s, r) => s + r.activity.touches.logged, 0),
            target: held(everybody.map((r) => r.activity.touches.target)),
          });
          // UI-013: the count over the people who count for production, out of everybody — manpower.
          expect(total.potentialActive).toMatchObject({ count: rows.filter((r) => r.pacingToMaa === true).length, of: everybody.length });
        };
        check(view.yourUnit.rows, view.yourUnit.total);
        const groups = (g: UnitGroup): UnitGroup[] => [g, ...g.units.flatMap(groups)];
        for (const group of view.units.flatMap(groups)) check(rowsOf(group), group.total);

        // The tiles are over every row: production and the potential actives checked as a total of them.
        const all = everyRow(view);
        const { period: tilePeriod, ...production } = view.tiles.directGroupProduction;
        expect(tilePeriod).toBe(period === 'year' ? 'year' : 'month');
        check(all, {
          goal: production, leadsCounts: sumLeads(all), touches: sumTouches(all), potentialActive: view.tiles.potentialActive,
          newHires: view.tiles.team.newHires, closings: all.reduce((s, r) => s + r.closings, 0),
          proposalsMade: all.reduce((s, r) => s + r.proposalsMade, 0),
        });
        // UI-013: Active Agent's of is Your team's number, and its Unit / AAB split adds up to it — Unit is Your Unit.
        const { unit, aab, of } = view.tiles.potentialActive;
        expect(of).toBe(view.tiles.team.total);
        expect(unit).toEqual(view.yourUnit.total.potentialActive);
        expect([unit.count + aab.count, unit.of + aab.of]).toEqual([view.tiles.potentialActive.count, of]);
        expect(aab.of).toBe(view.units.reduce((n, g) => n + rowsOf(g).length, 0));
        expect(view.tiles.team).toEqual({
          total: all.length, direct: view.yourUnit.rows.length, units: view.units.length,
          underUnits: all.length - view.yourUnit.rows.length - view.units.length,
          newHires: all.filter((r) => r.newHireBeforeFirstSale).length,
        });
        expect(view.tiles.potentialRecruits).toEqual({
          yourUnit: view.yourUnit.rows.reduce((s, r) => s + r.leadsCounts.recruitNominated, 0),
          aabs: view.units.flatMap(rowsOf).reduce((s, r) => s + r.leadsCounts.recruitNominated, 0),
        });
      }
    });

    it('P15-T1 AC-4 Agus’s tiles, worked: eleven people; Indah’s nomination in his unit, Rina’s in Sari’s', async () => {
      const view = await read('AGUS');
      expect(view.tiles.team).toEqual({ total: 11, direct: 3, units: 3, underUnits: 5, newHires: 0 });
      expect(view.tiles.potentialRecruits).toEqual({ yourUnit: 1, aabs: 1 });
      // Four rows hold this month's APE — Indah, Dimas, Rina and Sari — and seven hold none.
      expect(view.tiles.directGroupProduction).toMatchObject({ actualMinor: 270 * M, missing: 7, period: 'month' });
    });

    it('P18.5-T15 AC-6 Agus’s Direct Group production pairs: the seven with no production are out of the target too', async () => {
      const view = await read('AGUS');
      const all = everyRow(view);
      const held = all.filter((r) => r.goal.actualMinor !== null);
      expect(held.map((r) => r.name).sort()).toEqual(['Dimas Pratama', 'Indah Permatasari', 'Rina Wijaya', 'Sari Puspita'].sort());
      const pairedTarget = held.reduce((s, r) => s + (r.goal.targetMinor ?? 0), 0);
      expect(view.tiles.directGroupProduction).toMatchObject({
        targetMinor: pairedTarget, actualMinor: 270 * M, missing: 7,
        gapMinor: Math.max(0, pairedTarget - 270 * M), overMinor: Math.max(0, 270 * M - pairedTarget),
      });
    });

    it('P15-T1 AC-4 the nested unit, two deep, has its own total inside its parent’s', async () => {
      const sari = (await read('AGUS')).units[2];
      const nina = sari.units[0];
      expect(nina.total.leadsCounts.recruitOpen).toBe(1);
      expect(nina.total.potentialActive.of).toBe(2);
      expect(sari.total.potentialActive.of).toBe(5);
      expect(sari.total.leadsCounts).toEqual({ salesOpen: 3, salesClosing: 1, recruitOpen: 3, recruitNominated: 1 });
    });
  });

  /**
   * **ADR-0172, P18.8-T5** — a new hire counts in the team from their join date, and in production and *on pace* from
   * their first sale's day. Dimas holds this month's production and a target, and is pacing: the case the client saw.
   */
  describe('P18.8-T5 — who counts where (ADR-0172)', () => {
    const memberships = () => db().collection('memberships');
    const mark = (who: Who, set: Record<string, unknown>) =>
      memberships().updateOne({ _id: new mongoose.Types.ObjectId(office.id[who]) }, { $set: set });
    afterEach(async () => {
      await memberships().updateMany({ kpmId: KPM_A }, { $unset: { joinedAs: '', firstSaleDate: '' } });
    });

    it('UI-013 a new hire with no first sale is in the team, tagged, out of production and on pace’s count — in its of', async () => {
      const before = await read('AGUS');
      const dimas = rowFor(before, 'DIMAS');
      expect([dimas.goal.actualMinor !== null, dimas.goal.targetMinor !== null, dimas.newHireBeforeFirstSale]).toEqual([true, true, false]);

      await mark('DIMAS', { joinedAs: 'new_hire', firstSaleDate: null });
      const view = await read('AGUS');
      expect(rowFor(view, 'DIMAS').newHireBeforeFirstSale).toBe(true);
      // AC-1: the team still counts him.
      expect(view.tiles.team).toEqual({ ...before.tiles.team, newHires: 1 });
      expect(view.yourUnit.rows.map((r) => r.name)).toEqual(before.yourUnit.rows.map((r) => r.name));
      // AC-2: his target and his production leave Your Unit's total and the tile; he is not missing either.
      const others = before.yourUnit.rows.filter((r) => r.membershipId !== office.id.DIMAS);
      const actual = others.map((r) => r.goal.actualMinor).filter((v): v is number => v !== null).reduce((a, b) => a + b, 0);
      expect(view.yourUnit.total).toMatchObject({ newHires: 1, goal: { actualMinor: actual, missing: before.yourUnit.total.goal.missing } });
      expect(view.tiles.directGroupProduction.actualMinor).toBe(before.tiles.directGroupProduction.actualMinor! - dimas.goal.actualMinor!);
      expect(view.tiles.directGroupProduction.targetMinor).toBe(before.tiles.directGroupProduction.targetMinor! - dimas.goal.targetMinor!);
      // UI-013 Active Agent: out of the count, never out of `of` — manpower, the same number as Your team.
      const pacing = dimas.pacingToMaa === true ? 1 : 0;
      expect(view.tiles.potentialActive).toMatchObject({
        count: before.tiles.potentialActive.count - pacing, of: before.tiles.potentialActive.of,
        unit: { count: before.tiles.potentialActive.unit.count - pacing, of: before.tiles.potentialActive.unit.of },
      });
      expect(view.tiles.potentialActive.of).toBe(view.tiles.team.total);
      expect(view.yourUnit.total.potentialActive.of).toBe(before.yourUnit.total.potentialActive.of);
      // The leads and the goal activities are still everybody's.
      expect(view.yourUnit.total.leadsCounts).toEqual(before.yourUnit.total.leadsCounts);
      expect(view.yourUnit.total.touches).toEqual(before.yourUnit.total.touches);
    });

    it('P18.8-T5 AC-2, AC-3 from the first sale’s day: not the day after today, but today and before', async () => {
      const counted = async (firstSaleDate: string) => {
        await mark('DIMAS', { joinedAs: 'new_hire', firstSaleDate });
        const view = await read('AGUS');
        return { tag: rowFor(view, 'DIMAS').newHireBeforeFirstSale, newHires: view.tiles.team.newHires, of: view.tiles.potentialActive.of };
      };
      const all = everyRow(await read('AGUS')).length;
      // UI-013: `of` is manpower whatever the first sale — the tag and the production's left-out count move.
      expect(await counted('2026-09-15')).toEqual({ tag: true, newHires: 1, of: all });
      expect(await counted(ROSTER_TODAY)).toEqual({ tag: false, newHires: 0, of: all });
      expect(await counted('2026-08-20')).toEqual({ tag: false, newHires: 0, of: all });
    });

    it('P18.8-T5 AC-2 an existing agent with no first sale counts, as today (ADR-0172 §4)', async () => {
      const before = await read('AGUS');
      await mark('DIMAS', { joinedAs: 'existing_agent', firstSaleDate: null });
      const view = await read('AGUS');
      expect(rowFor(view, 'DIMAS').newHireBeforeFirstSale).toBe(false);
      expect([view.tiles.directGroupProduction, view.tiles.potentialActive, view.yourUnit.total])
        .toEqual([before.tiles.directGroupProduction, before.tiles.potentialActive, before.yourUnit.total]);
    });

    it('UI-013 every total above a new hire leaves them out of production, never of on pace’s of — Rina in Sari’s unit', async () => {
      await mark('RINA', { joinedAs: 'new_hire', firstSaleDate: null });
      const agus = await read('AGUS');
      const sari = agus.units[2];
      expect(sari.total.newHires).toBe(1);
      expect(sari.total.potentialActive.of).toBe(rowsOf(sari).length);
      expect(sari.units[0].total.newHires).toBe(0);
      const own = await read('SARI');
      expect(own.yourUnit.total.newHires).toBe(1);
      expect(own.tiles.team.newHires).toBe(1);
      expect(own.tiles.potentialActive.of).toBe(everyRow(own).length);
    });

    it('P18.8-T5 AC-3 the head is read too: a new-hire leader before a first sale is tagged on their own dashboard', async () => {
      await mark('SARI', { joinedAs: 'new_hire', firstSaleDate: null });
      const own = await read('SARI');
      expect(own.yourUnit.rows[0]).toMatchObject({ isReader: true, newHireBeforeFirstSale: true });
      expect((await read('AGUS')).units[2].head.newHireBeforeFirstSale).toBe(true);
      expect((await read('AGUS', { for: office.id.SARI })).yourUnit.rows[0].newHireBeforeFirstSale).toBe(true);
    });
  });

  describe('P15-T1 AC-7 — the read entries (D-audit)', () => {
    it('P15-T1 AC-7 one entry per row other than the reader, surface unit_dashboard, the period’s window as the range', async () => {
      await db().collection('auditLog').deleteMany({});
      const view = await read('AGUS', { period: '7d' });
      const entries = await db().collection('auditLog').find({ action: 'activity_log.read_raw' }).toArray();

      expect(view.window).toEqual({ from: '2026-09-08', to: ROSTER_TODAY });
      expect(entries).toHaveLength(10);
      expect(entries.map((e) => e.targetMembershipId).sort())
        .toEqual(everyRow(view).filter((r) => !r.isReader).map((r) => r.membershipId).sort());
      for (const entry of entries) {
        expect(entry).toMatchObject({
          kpmId: KPM_A, actorMembershipId: office.id.AGUS, onBehalfOf: true,
          after: { surface: 'unit_dashboard', from: '2026-09-08', to: ROSTER_TODAY },
        });
      }
    });

    it('P15-T1 AC-7 a unit below the reader records its head too; an empty unit records nothing', async () => {
      await db().collection('auditLog').deleteMany({});
      await read('AGUS', { for: office.id.NINA });
      expect((await db().collection('auditLog').find({}).toArray()).map((e) => e.targetMembershipId).sort())
        .toEqual([office.id.NINA, office.id.DODI].sort());
      await db().collection('auditLog').deleteMany({});
      await read('INDAH');
      expect(await db().collection('auditLog').countDocuments({})).toBe(0);
    });

    it('P15-T1 AC-7 a support session’s read records both actors on every entry: the operator, and the leader they act as', async () => {
      await db().collection('auditLog').deleteMany({});
      const agus = office.as('AGUS');
      const support = new RequestContext(agus.userId, 'none', agus.membership, 'u-support', null, false, true);
      await wired.unitDashboard.read(support);
      const entries = await db().collection('auditLog').find({ action: 'activity_log.read_raw' }).toArray();
      expect(entries).toHaveLength(10);
      for (const entry of entries) {
        expect(entry).toMatchObject({
          actorUserId: 'u-support', effectiveUserId: agus.userId, actorMembershipId: office.id.AGUS,
          after: { surface: 'unit_dashboard' },
        });
      }
    });

    it('P15-T1 AC-7 the read is served when the entries cannot be written, and the failure is logged', async () => {
      const failing = jest.spyOn(wired.audit, 'recordMany').mockRejectedValueOnce(new Error('write concern timed out'));
      const logged = jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
      try {
        const view = await read('SARI');
        expect(everyRow(view)).toHaveLength(5);
        expect(logged).toHaveBeenCalled();
      } finally {
        failing.mockRestore();
        logged.mockRestore();
      }
    });
  });

  describe('P15-T3 — Update production: corrections of the office’s figure (OD-137, option 2)', () => {

    it('P15-T3 AC-3 writes each changed cell as a correction under the leader’s name and the fixed reason, audited per cell', async () => {
      await db().collection('auditLog').deleteMany({});
      const before = (await state()).revision;
      // The month alone since P19.5-T2: the year to date is the months' sum (R4).
      const result = await save('SARI', [
        { membershipId: office.id.RINA, apeMonthlyMinor: 85 * M },
        { membershipId: office.id.NINA, apeMonthlyMinor: 12 * M },
      ]);

      expect(result.updated).toBe(2);
      // One claim of the month's revision for the whole save.
      expect(result.state.revision).toBe(before + 1);
      expect(await cell('RINA')).toMatchObject({
        value: 85 * M, provenance: 'corrected', correctedBy: office.id.SARI, reason: UNIT_DASHBOARD_CORRECTION_REASON,
        replacedValue: 80 * M, sourceBatchId: null,
      });
      // Nina had no row this month: the correction makes one, with her agent code.
      expect(await db().collection('monthlyAgentData').findOne({ membershipId: office.id.NINA, month: UNIT_MONTH }))
        .toMatchObject({ agentCode: expect.stringMatching(/^PRU-7/), values: { APE: { value: 12 * M, replacedValue: null } }, templateVersion: 1 });
      const audit = await db().collection('auditLog').find({ action: 'upload.cell_corrected' }).toArray();
      expect(audit).toHaveLength(2);
      expect(audit.find((a) => a.targetMembershipId === office.id.RINA && a.after.field === 'APE')).toMatchObject({
        actorMembershipId: office.id.SARI,
        before: { month: UNIT_MONTH, field: 'APE', value: 80 * M, provenance: 'imported', sourceBatchId: null },
        after: {
          month: UNIT_MONTH, field: 'APE', value: 85 * M, provenance: 'corrected',
          reason: UNIT_DASHBOARD_CORRECTION_REASON, surface: 'unit_dashboard',
        },
      });
    });

    it('Phase 15 exit N2 a save is one bulk write of its rows and one insert of its entries, after one claim', async () => {
      const rows = mongoose.model(MonthlyAgentData.name);
      const bulk = jest.spyOn(rows, 'bulkWrite');
      const many = jest.spyOn(wired.audit, 'recordMany');
      const one = jest.spyOn(wired.audit, 'record');
      const claim = jest.spyOn(wired.productionMonths, 'claim');
      try {
        const result = await save('SARI', [
          { membershipId: office.id.BUDI, apeMonthlyMinor: 3 * M },
          { membershipId: office.id.DODI, apeMonthlyMinor: 4 * M },
        ]);
        expect(result.updated).toBe(2);
        expect([bulk.mock.calls.length, many.mock.calls.length, one.mock.calls.length, claim.mock.calls.length]).toEqual([1, 1, 0, 1]);
        // Two rows in the write, two cells in the entries, each naming its row.
        expect((bulk.mock.calls[0][0] as unknown[]).length).toBe(2);
        const entries = many.mock.calls[0][1];
        expect(entries.map((e) => [e.targetMembershipId, (e.after as { field: string }).field])).toEqual([
          [office.id.BUDI, 'APE'], [office.id.DODI, 'APE'],
        ]);
        const budi = await db().collection('monthlyAgentData').findOne({ membershipId: office.id.BUDI, month: UNIT_MONTH });
        expect(entries[0].targetId).toBe(String(budi!._id));
      } finally {
        [bulk, many, one, claim].forEach((spy) => spy.mockRestore());
      }
    });

    it('P15-T3 AC-1 the dashboard shows the correction’s mark, who and when; the month table and the Summary read it too', async () => {
      const view = await read('AGUS');
      const rina = rowFor(view, 'RINA');
      expect(rina.goal.source).toEqual({
        provenance: 'corrected', month: UNIT_MONTH, correctedBy: { membershipId: office.id.SARI, name: 'Sari Puspita' },
        correctedAt: ROSTER_NOW.toISOString(),
      });
      expect(rina.production.monthly).toEqual({
        valueMinor: 85 * M, provenance: 'corrected', correctedBy: { membershipId: office.id.SARI, name: 'Sari Puspita' },
        correctedAt: ROSTER_NOW.toISOString(),
      });
      const yearly = rowFor(await read('AGUS', { period: 'year' }), 'RINA');
      expect(yearly.goal.source).toMatchObject({ provenance: 'corrected', correctedBy: { name: 'Sari Puspita' } });
      const table = await wired.production.readMonth(office.as('OWNER'), UNIT_MONTH);
      expect(table.rows.find((r) => r.membershipId === office.id.RINA)!.values.APE)
        .toEqual({ value: 85 * M, provenance: 'corrected', correction: { by: 'Sari Puspita', at: ROSTER_NOW.toISOString(), reason: UNIT_DASHBOARD_CORRECTION_REASON }, outOfBounds: null });
      // The member's own Summary, and a leader's copy of it, name the leader who corrected it (option 2).
      const corrected = {
        provenance: 'corrected', month: UNIT_MONTH,
        correctedBy: { membershipId: office.id.SARI, name: 'Sari Puspita' }, correctedAt: ROSTER_NOW.toISOString(),
      };
      const summary = await wired.summary.read(office.as('AGUS'), office.id.RINA);
      expect([summary.monthly.actualMinor, summary.monthly.source, summary.yearly.source]).toEqual([85 * M, corrected, corrected]);
      const own = await wired.summary.read(office.as('RINA'));
      expect(own.monthly.source).toEqual(corrected);
    });

    it('P15-T3 AC-3 a cell already holding the figure is unchanged: not written, not audited, not counted, no claim', async () => {
      const before = await snapshot();
      const result = await save('SARI', [{ membershipId: office.id.RINA, apeMonthlyMinor: 85 * M }]);
      expect(result).toMatchObject({ updated: 0, state: { revision: before.revision } });
      expect(await snapshot()).toEqual(before);
      // Of two rows, the changed one counts once.
      const one = await save('SARI', [{ membershipId: office.id.RINA, apeMonthlyMinor: 85 * M }, { membershipId: office.id.BUDI, apeMonthlyMinor: 1 * M }]);
      expect(one.updated).toBe(1);
    });

    it('P15-T3 AC-3 the Owner and the Admin correct any active member; a leader their own figure while they lead', async () => {
      expect((await save('OWNER', [{ membershipId: office.id.ADMIN, apeMonthlyMinor: 1 * M }])).updated).toBe(1);
      expect((await save('ADMIN', [{ membershipId: office.id.PEER_AGENT, apeMonthlyMinor: 3 * M }])).updated).toBe(1);
      expect((await save('AGUS', [{ membershipId: office.id.AGUS, apeMonthlyMinor: 2 * M }])).updated).toBe(1);
      expect((await cell('AGUS'))).toMatchObject({ correctedBy: office.id.AGUS });
    });

    it.each([
      ['somebody outside the reach', 'SARI', 'RINA', 'LUKAS'],
      ['a member who left', 'AGUS', 'RINA', 'LEFT'],
      ['the reader, who leads nobody', 'DEWI', null, 'DEWI'],
      ['another office’s member', 'AGUS', 'RINA', 'B_AGENT'],
      ['another office’s member, by the Owner', 'OWNER', 'ADMIN', 'B_AGENT'],
      ['a member who left, by the Owner', 'OWNER', 'ADMIN', 'LEFT'],
      ['another office’s member, by the Admin', 'ADMIN', 'DIMAS', 'B_AGENT'],
      ['a member who left, by the Admin', 'ADMIN', 'DIMAS', 'LEFT'],
    ] as const)('P15-T3 AC-4 a row naming %s is 404, and nothing is written — a valid row beside it included', async (_, reader, valid, named) => {
      const before = await snapshot();
      await expect(save(reader, [
        ...(valid === null ? [] : [{ membershipId: office.id[valid], apeMonthlyMinor: 70 * M }]),
        { membershipId: office.id[named], apeMonthlyMinor: 1 * M },
      ])).rejects.toMatchObject({ code: 'NOT_FOUND' });
      expect(await snapshot()).toEqual(before);
    });

    it('P15-T3 AC-4 a malformed id is nobody, 404, not a server fault', async () => {
      await expect(save('OWNER', [{ membershipId: 'nope', apeMonthlyMinor: 1 }])).rejects.toMatchObject({ code: 'NOT_FOUND' });
      await expect(save('AGUS', [{ membershipId: 'nope', apeMonthlyMinor: 1 }])).rejects.toMatchObject({ code: 'NOT_FOUND' });
    });

    it('P19.5-T2 AC-7 P15-T3 AC-3 every row is checked before anything is written: a year to date is refused, the sum of the months', async () => {
      const before = await snapshot();
      // A year to date on the second row (R4: it is calculated): the first row is not written either.
      await expect(save('SARI', [
        { membershipId: office.id.BUDI, apeMonthlyMinor: 5 * M },
        { membershipId: office.id.RINA, apeYtdMinor: 300 * M },
      ])).rejects.toMatchObject({ code: 'VALIDATION_FAILED', details: { field: 'apeYtdMinor', membershipId: office.id.RINA } });
      // A figure no APE can be, by the import's own rule — naming the row and the cell.
      await expect(save('SARI', [
        { membershipId: office.id.BUDI, apeMonthlyMinor: 5 * M },
        { membershipId: office.id.RINA, apeMonthlyMinor: Number.MAX_SAFE_INTEGER + 2 },
      ])).rejects.toMatchObject({
        code: 'UPLOAD_VALUE_OUT_OF_RANGE', details: { membershipId: office.id.RINA, kode: 'APE', ytd: false },
      });
      await expect(save('SARI', [{ membershipId: office.id.RINA, apeMonthlyMinor: -1 }]))
        .rejects.toMatchObject({ code: 'UPLOAD_VALUE_OUT_OF_RANGE', details: { kode: 'APE', value: -1 } });
      expect(await snapshot()).toEqual(before);
    });

    it('P15-T3 AC-3 a stale revision is VERSION_CONFLICT and a locked month UPLOAD_MONTH_LOCKED, nothing written', async () => {
      const before = await snapshot();
      await expect(save('SARI', [{ membershipId: office.id.RINA, apeMonthlyMinor: 70 * M }], before.revision - 1))
        .rejects.toMatchObject({ code: 'VERSION_CONFLICT' });
      expect(await snapshot()).toEqual(before);

      await wired.productionMonths.lock(office.as('OWNER'), UNIT_MONTH);
      const locked = await snapshot();
      await expect(save('SARI', [{ membershipId: office.id.RINA, apeMonthlyMinor: 70 * M }]))
        .rejects.toMatchObject({ code: 'UPLOAD_MONTH_LOCKED' });
      expect(await snapshot()).toEqual(locked);
      const view = await read('SARI');
      expect(view.production).toMatchObject({ month: UNIT_MONTH, locked: true, canUpdate: true, revision: locked.revision });
      await wired.productionMonths.reopen(office.as('OWNER'), UNIT_MONTH);
    });

    it('P15-T3 AC-3 only the office’s current month; one row per person; a row with no figure is refused', async () => {
      const ctx = office.as('SARI');
      const revision = (await state()).revision;
      await expect(wired.unitDashboard.updateProduction(ctx, { month: '2026-08', revision, rows: [{ membershipId: office.id.RINA, apeMonthlyMinor: 1 }] }))
        .rejects.toMatchObject({
          code: 'VALIDATION_FAILED', details: { field: 'month', month: UNIT_MONTH },
          // The sentence names the month as ADR-0167 §1 writes one; `details` keeps it `YYYY-MM`.
          message: 'Production can only be updated here for Sep 2026, the agency\'s current month.',
        });
      await expect(save('SARI', [{ membershipId: office.id.RINA, apeMonthlyMinor: 1 }, { membershipId: office.id.RINA, apeMonthlyMinor: 300 * M }]))
        .rejects.toMatchObject({ code: 'VALIDATION_FAILED', details: { field: 'rows[1].membershipId' } });
      await expect(save('SARI', [{ membershipId: office.id.RINA }]))
        .rejects.toMatchObject({ code: 'VALIDATION_FAILED', details: { field: 'rows[0]' } });
    });

    it('P15-T3 AC-2 the next import’s preview lists a leader’s correction as it lists an Owner’s (ADR-0053)', async () => {
      const rina = (await db().collection('memberships').findOne({ _id: new mongoose.Types.ObjectId(office.id.RINA) }))!;
      const values = VALUE_COLUMNS.map((c) => (c.metric === 'ape' && c.cadence === 'monthly' ? '80' : ''));
      const file = {
        buffer: Buffer.from([TEMPLATE_HEADER_V1.join(','), [rina.agentCode, '"Rina"', ...values].join(',')].join('\n')),
        originalname: 'f.csv', size: 0,
      };
      const preview = await wired.production.preview(office.as('OWNER'), UNIT_MONTH, file);
      const flagged = preview.rows.flatMap((r) => r.cells).filter((c) => c.correction);
      expect(flagged.map((c) => [c.kode, c.ytd, c.correction!.by, c.correction!.reason]))
        .toContainEqual(['APE', false, 'Sari Puspita', UNIT_DASHBOARD_CORRECTION_REASON]);
    });
    it('P18.10-T5 AC-6 stores the fixed reason in the saving reader’s language, and shows it as stored', async () => {
      // An English reader's save first, then the Owner's, reading Indonesian: each reason is written once, in its
      // writer's language, and kept as text.
      await wired.unitDashboard.updateProduction(office.as('OWNER').withReader(readerIn('en')), {
        month: UNIT_MONTH, revision: (await state()).revision,
        rows: [{ membershipId: office.id.PEER_AGENT, apeMonthlyMinor: 9 * M }],
      });
      await wired.unitDashboard.updateProduction(office.as('OWNER').withReader(readerIn('id')), {
        month: UNIT_MONTH, revision: (await state()).revision,
        rows: [{ membershipId: office.id.PEER_AGENT, apeMonthlyMinor: 7 * M }],
      });
      expect(await cell('PEER_AGENT')).toMatchObject({
        value: 7 * M, provenance: 'corrected', reason: 'Diperbarui di Unit Dashboard dari laporan perusahaan.',
      });
      // The English reader's save keeps its English in the log; neither is translated afterwards.
      const entries = await db().collection('auditLog').find({ action: 'upload.cell_corrected', targetMembershipId: office.id.PEER_AGENT })
        .sort({ _id: 1 }).toArray();
      expect(entries.slice(-2).map((e) => e.after.reason)).toEqual([UNIT_DASHBOARD_CORRECTION_REASON, 'Diperbarui di Unit Dashboard dari laporan perusahaan.']);
      const table = await wired.production.readMonth(office.as('OWNER').withReader(readerIn('en')), UNIT_MONTH);
      expect(table.rows.find((r) => r.membershipId === office.id.PEER_AGENT)!.values.APE)
        .toMatchObject({ correction: { reason: 'Diperbarui di Unit Dashboard dari laporan perusahaan.' } });
    });
  });

  describe('P15-T1 AC-9, P15-T4 AC-5 — the tenant boundary', () => {
    it('P15-T1 AC-9 a leader of the other office reads their own people, and nothing of 0417 leaks', async () => {
      const view = await read('B_AB');
      expect(everyRow(view).map((r) => r.name)).toEqual(['Lina Marlina', 'Bayu Saputra']);
      expect(rowFor(view, 'B_AGENT').leadsCounts).toEqual({ salesOpen: 2, salesClosing: 2, recruitOpen: 0, recruitNominated: 0 });
      const text = JSON.stringify(view);
      for (const who of ['AGUS', 'RINA', 'SARI', 'OWNER'] as const) expect(text).not.toContain(office.id[who]);
    });

    it('P15-T1 AC-9 0417’s leaders never reach a 0555 member on either route, and the refusal writes nothing', async () => {
      const before = await snapshot();
      await expect(read('OWNER', { for: office.id.B_AB })).rejects.toMatchObject({ code: 'NOT_FOUND' });
      await expect(save('OWNER', [{ membershipId: office.id.B_AGENT, apeMonthlyMinor: 1 * M }])).rejects.toMatchObject({ code: 'NOT_FOUND' });
      await expect(save('B_AB', [{ membershipId: office.id.RINA, apeMonthlyMinor: 1 * M }])).rejects.toMatchObject({ code: 'NOT_FOUND' });
      expect(await snapshot()).toEqual(before);
      expect(await db().collection('monthlyAgentData').countDocuments({ kpmId: KPM_B })).toBe(0);
    });

    it('P15-T1 AC-9 the other office’s leader cannot open a 0417 unit, nor be read by an Owner of 0417', async () => {
      await expect(read('B_AB', { for: office.id.AGUS })).rejects.toMatchObject({ code: 'NOT_FOUND' });
      await expect(read('B_AB', { for: office.id.SARI })).rejects.toMatchObject({ code: 'NOT_FOUND' });
    });
  });
  describe('Phase 15 exit B1 — no lead text to a reader who may not read the person’s leads (roles §3.7)', () => {
    beforeAll(async () => {
      const latest = async (who: Who) => (await db().collection('coachingSessions')
        .find({ coacheeMembershipId: office.id[who], status: 'finalized' }).sort({ date: -1 }).limit(1).toArray())[0];
      // Indah's latest 1:1 froze a lead's next action, earlier than any typed item …
      await db().collection('coachingSessions').updateOne({ _id: (await latest('INDAH'))._id }, {
        $push: { leadActions: { leadId: 'l-hendro', leadName: 'Pak Hendro Gunawan', dueDate: '2026-09-05', text: 'Chase Pak Hendro’s illustration' } },
      } as never);
      // … and Sari's carried a lead's note forward as a typed item.
      await db().collection('coachingSessions').updateOne({ _id: (await latest('SARI'))._id }, {
        $push: { actionItems: { itemId: 'c-wulan', text: 'Call Ibu Wulan Sari about the BOP', dueDate: '2026-08-30', carriedFromItemId: 'lead-wulan' } },
      } as never);
    });

    it('Phase 15 exit B1 an Admin opening Agus’s unit reads every follow-up without a lead’s name or note in it', async () => {
      const view = await read('ADMIN', { for: office.id.AGUS });
      const text = JSON.stringify(view);
      for (const word of ['Hendro', 'Wulan', 'illustration', 'l-hendro', 'lead-wulan']) expect([word, text.includes(word)]).toEqual([word, false]);
      // The typed items are still theirs to read.
      expect(rowFor(view, 'INDAH').followUp).toEqual({ text: 'Book two presentations', dueDate: '2026-09-10', overdueDays: 4 });
      expect(rowFor(view, 'SARI').followUp).toEqual({ text: 'Book two presentations', dueDate: '2026-09-02', overdueDays: 12 });
    });

    it('Phase 15 exit B1 Agus, who coaches them, reads the lead’s next action and the note carried from one', async () => {
      for (const reader of ['AGUS', 'OWNER'] as const) {
        const view = await read(reader, reader === 'OWNER' ? { for: office.id.AGUS } : {});
        expect({ reader, f: rowFor(view, 'INDAH').followUp }).toEqual({ reader, f: { text: 'Chase Pak Hendro’s illustration', dueDate: '2026-09-05', overdueDays: 9 } });
        expect({ reader, f: rowFor(view, 'SARI').followUp }).toEqual({ reader, f: { text: 'Call Ibu Wulan Sari about the BOP', dueDate: '2026-08-30', overdueDays: 15 } });
      }
    });
  });

  describe('defensive reads: a row the office cannot fully describe still draws', () => {
    let nameless: string[];

    beforeAll(async () => {
      // Two members under Dewi whose accounts are gone, on a rung the ladder does not name.
      const dewi = (await db().collection('memberships').findOne({ _id: new mongoose.Types.ObjectId(office.id.DEWI) }))!;
      nameless = [new mongoose.Types.ObjectId(), new mongoose.Types.ObjectId()].map(String).sort();
      await db().collection('memberships').insertMany(nameless.map((id, i) => ({
        _id: new mongoose.Types.ObjectId(id), kpmId: KPM_A, userId: new mongoose.Types.ObjectId().toString(), agentCode: `GONE-${i}`,
        leaderCode: `GONE0${i}`, agentSeq: 900 + i, orgLevelCode: 'NO_RUNG', role: 'agent', leaderId: office.id.DEWI,
        ancestorIds: [...dewi.ancestorIds, office.id.DEWI], depth: dewi.depth + 1, status: 'active', deletedAt: null,
      })) as never);
    });

    it('draws a member nobody can name blank, never a placeholder; ties on the name keep the membership order', async () => {
      const view = await read('DEWI');
      expect(view.yourUnit.rows.slice(1).map((r) => [r.membershipId, r.name])).toEqual(nameless.map((id) => [id, '']));
    });

    it('labels a rung the ladder does not name by its code, and an office with no company by codes alone', async () => {
      expect(rowFor(await read('DEWI'), 'DEWI').rung).toEqual({ code: 'AAB', label: 'AAB' });
      expect((await read('DEWI')).yourUnit.rows[1].rung).toEqual({ code: 'NO_RUNG', label: 'NO_RUNG' });
      await (wired.kpms as unknown as { updateOne: (f: unknown, u: unknown) => { exec: () => Promise<unknown> } })
        .updateOne({ _id: KPM_A }, { $set: { companyId: null } }).exec();
      try {
        expect(rowFor(await read('DEWI'), 'DEWI').rung).toEqual({ code: 'AAB', label: 'AAB' });
      } finally {
        await (wired.kpms as unknown as { updateOne: (f: unknown, u: unknown) => { exec: () => Promise<unknown> } })
          .updateOne({ _id: KPM_A }, { $set: { companyId: COMPANY } }).exec();
      }
    });

    it('answers a reader nobody can name an empty unit under a blank name', async () => {
      const ctx = new RequestContext('u-gone', 'none', { ...office.as('TARI').membership!, membershipId: nameless[0], orgLevelCode: 'AGENT' });
      expect((await wired.unitDashboard.read(ctx)).head).toEqual({ membershipId: nameless[0], name: '', isReader: true });
    });
  });
});

/** The four lead counts summed over some rows. */
function sumLeads(rows: UnitRow[]) {
  const sum = (key: 'salesOpen' | 'salesClosing' | 'recruitOpen' | 'recruitNominated') => rows.reduce((s, r) => s + r.leadsCounts[key], 0);
  return { salesOpen: sum('salesOpen'), salesClosing: sum('salesClosing'), recruitOpen: sum('recruitOpen'), recruitNominated: sum('recruitNominated') };
}

/** Touches summed over some rows: the targets that exist. */
function sumTouches(rows: UnitRow[]) {
  const targets = rows.map((r) => r.activity.touches.target).filter((t): t is number => t !== null);
  return { logged: rows.reduce((s, r) => s + r.activity.touches.logged, 0), target: targets.length ? targets.reduce((a, b) => a + b, 0) : null };
}
