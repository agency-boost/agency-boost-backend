import { INestApplication } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { Test } from '@nestjs/testing';
import mongoose from 'mongoose';
import request from 'supertest';
import { PermissionsGuard } from '@/common/auth/permissions.guard';
import { RequestContext } from '@/common/context/request-context';
import { DomainExceptionFilter } from '@/common/errors/error.filter';
import { UNIT_DASHBOARD_CORRECTION_REASON } from '@/domain/constants';
import { clearCollections, startMongo, stopMongo } from '../../../test/mongo';
import { configModule } from '../../../test/config-module';
import { declaredPermissions, NO_CLASS, productionPipe, session, StubAuth, SUPER_ADMIN } from '../../../test/http-permissions';
import { listenOnLoopback } from '../../../test/listen';
import { buildCoachingOffice, ROSTER_NOW, type CoachingOffice, type Who } from '../../../test/coaching-office';
import { seedUnitLeads, UNIT_MONTH } from '../../../test/unit-office';
import { CoachingController } from '../coaching/coaching.controller';
import { CoachingRosterService } from '../coaching/coaching-roster.service';
import { CoacheeService } from '../coaching/coachee.service';
import { CoachingSessionService } from '../coaching/coaching-session.service';
import { ProductionController } from '../production/production.controller';
import { ProductionService } from '../production/production.service';
import { ProductionImportService } from '../production/production-import.service';
import { ProductionMonths } from '../production/production-months.service';
import { ProductionCorrections } from '../production/production-correction.service';

/** The twelve value columns of a version 1 file, keyed `metric.cadence` as these specs name them. */
const VALUE_COLUMNS = (['monthly', 'ytd'] as const).flatMap((cadence) =>
  (['ape', 'persistency', 'recruitment', 'newActiveAgents', 'fyp', 'policyCount'] as const).map((metric) => ({ metric, cadence })));
import { TEMPLATE_HEADER_V1 } from '../production/production-template';
import { SummaryController } from '../summary/summary.controller';
import { SummaryService } from '../summary/summary.service';
import { UnitActivitiesController } from './unit-activities.controller';
import { UnitActivitiesService } from './unit-activities.service';
import { UnitDashboardController } from './unit-dashboard.controller';
import { UnitDashboardService } from './unit-dashboard.service';

const M = 1_000_000 * 100;

/** A row as the wire carries it: what these specs read of it. */
interface Row {
  membershipId: string;
  name: string;
  isReader: boolean;
  goal: Record<string, unknown> & { source: { provenance: string; month: string | null } | null };
  production: { monthly: { valueMinor: number | null; provenance: string | null }; ytd: { valueMinor: number | null; provenance: string | null } };
  status: string;
  lastOneOnOne: unknown;
}
interface Group { head: Row; members: Row[]; units: Group[] }
interface View { yourUnit: { rows: Row[] }; units: Group[]; empty: boolean; production: { revision: number; canUpdate: boolean } }
const rowsOf = (g: Group): Row[] => [g.head, ...g.members, ...g.units.flatMap(rowsOf)];
const everyRow = (view: View): Row[] => [...view.yourUnit.rows, ...view.units.flatMap(rowsOf)];

/**
 * **The Unit Dashboard over HTTP, per role** (P15-T1 AC-1, AC-5, AC-10; P15-T3 AC-2, AC-4; P15-T4 AC-1, AC-5),
 * with the real `PermissionsGuard`, the production pipe and the real services over `test/coaching-office.ts`'s
 * office. And **exit criterion 2 — one answer**: for every leader and every row, the dashboard's figures equal
 * the person's own reads — `GET /summary?for=`, `GET /coaching/coachees`, `GET /kpm/data-upload/:month` —
 * through an import, a correction from the dashboard, the same file again, a restated file ticked and a revert.
 */
describe('the Unit Dashboard over HTTP (Phase 15)', () => {
  let app: INestApplication;
  let wired: ReturnType<typeof configModule>;
  let office: CoachingOffice;
  const db = () => mongoose.connection.db!;
  const as = (who: Who) => { session.current = office.as(who); };
  const http = () => request(app.getHttpServer());
  const dashboard = (query: Record<string, string> = {}) => http().get('/unit/dashboard').query(query);
  const patch = (body: unknown) => http().patch('/unit/dashboard/production').send(body as object);
  const revision = async () => (await wired.productionMonths.state(office.as('OWNER'), UNIT_MONTH)).revision;

  beforeAll(async () => {
    await startMongo();
    wired = configModule(ROSTER_NOW);
    await clearCollections();
    office = await buildCoachingOffice(wired);
    await seedUnitLeads(office);

    const moduleRef = await Test.createTestingModule({
      controllers: [UnitDashboardController, UnitActivitiesController, SummaryController, CoachingController, ProductionController],
      providers: [
        { provide: UnitDashboardService, useValue: wired.unitDashboard },
        { provide: UnitActivitiesService, useValue: wired.unitActivities },
        { provide: SummaryService, useValue: wired.summary },
        { provide: CoachingRosterService, useValue: wired.coachingRoster },
        { provide: CoacheeService, useValue: wired.coachee },
        { provide: CoachingSessionService, useValue: wired.coachingSession },
        { provide: ProductionService, useValue: wired.production },
        { provide: ProductionImportService, useValue: wired.productionImport },
        { provide: ProductionMonths, useValue: wired.productionMonths },
        { provide: ProductionCorrections, useValue: wired.productionCorrections },
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

  it('declares a permission on every route, and the right one', () => {
    expect(declaredPermissions(UnitDashboardController)).toEqual({
      read: 'unit_dashboard:read',
      updateProduction: 'unit_dashboard:update_production',
    });
    // UI V1 (UI-001): the Activities tab reads on the dashboard's own grant.
    expect(declaredPermissions(UnitActivitiesController)).toEqual({ read: 'unit_dashboard:read' });
  });

  describe('UI-001 GET /unit/dashboard/activities — a positive and a negative per role (Phase 18.11 T4)', () => {
    const activities = (query: Record<string, string> = {}) => http().get('/unit/dashboard/activities').query(query);

    it('UI-001 positive: an AB is answered the table and the Unit and Group ratios; an AAB their own group', async () => {
      as('AGUS');
      const res = await activities({ span: 'month' }).expect(200);
      expect(res.body).toMatchObject({ empty: false, period: { span: 'month', from: '2026-09-01', to: '2026-09-30', current: true } });
      expect(res.body.people).toHaveLength(11);
      expect(res.body.ratios).toMatchObject({ days: 30 });
      expect(Array.isArray(res.body.ratios.unit) && Array.isArray(res.body.ratios.group)).toBe(true);
      as('SARI');
      expect((await activities().expect(200)).body.people.map((p: { name: string }) => p.name))
        .toEqual(['Sari Puspita', 'Budi Santoso', 'Rina Wijaya', 'Nina Lestari', 'Dodi Kurniawan']);
    });

    it('UI-001 positive: the Owner any leader’s unit by for; an Agent leading nobody the empty unit — never a 403', async () => {
      as('OWNER');
      expect((await activities({ for: office.id.SARI }).expect(200)).body.head).toMatchObject({ name: 'Sari Puspita', isReader: false });
      as('INDAH');
      expect((await activities().expect(200)).body).toMatchObject({ empty: true, people: [] });
    });

    it('UI-001 negative: a membership on no rung the matrix names is refused by the guard; a Super Admin has no office', async () => {
      const agus = office.as('AGUS');
      session.current = new RequestContext('u-x', 'none', { ...agus.membership!, orgLevelCode: 'NOT_A_RUNG', hierarchyRole: NO_CLASS });
      expect((await activities().expect(403)).body.error).toMatchObject({ code: 'PERM_DENIED', details: { permission: 'unit_dashboard:read' } });
      session.current = SUPER_ADMIN;
      expect((await activities().expect(403)).body.error.code).toBe('TENANT_NO_MEMBERSHIP');
    });

    it('UI-001 negative: outside the reach — another office’s leader, a peer’s unit — is 404, never 403', async () => {
      as('AGUS');
      expect((await activities({ for: office.id.B_AB }).expect(404)).body.error.code).toBe('NOT_FOUND');
      expect((await activities({ for: office.id.PEER_AB }).expect(404)).body.error.code).toBe('NOT_FOUND');
    });

    it.each([
      ['a span it does not know', { span: 'year' }, 'span'],
      ['a date that is not a day', { date: '14-09-2026' }, 'date'],
      ['a day after today', { date: '2026-09-15' }, 'date'],
      ['a parameter of any other name', { period: 'month' }, 'period'],
    ])('UI-001 %s is 400 VALIDATION_FAILED, named in details', async (_, query, named) => {
      as('AGUS');
      const res = await activities(query as Record<string, string>).expect(400);
      expect(res.body.error.code).toBe('VALIDATION_FAILED');
      expect(JSON.stringify(res.body.error.details)).toContain(named);
    });
  });

  describe('P15-T1 AC-1 — the read, a positive and a negative per role', () => {
    it('P15-T1 AC-1 positive: an AB is answered their unit, the period defaulting to this month', async () => {
      as('AGUS');
      const res = await dashboard().expect(200);
      expect(res.body).toMatchObject({ period: 'month', month: UNIT_MONTH, empty: false, head: { name: 'Agus Salim', isReader: true } });
      expect(everyRow(res.body)).toHaveLength(11);
      expect(res.body.production).toMatchObject({ month: UNIT_MONTH, locked: false, canUpdate: true });
    });

    it('P15-T1 AC-1 positive: an AAB is answered their subtree, a nested unit included', async () => {
      as('SARI');
      expect(everyRow((await dashboard().expect(200)).body).map((r) => r.name))
        .toEqual(['Sari Puspita', 'Budi Santoso', 'Rina Wijaya', 'Nina Lestari', 'Dodi Kurniawan']);
    });

    it('P15-T1 AC-1 positive: the Owner, the office’s root AB, is answered the whole office; the Admin, above nobody, an empty unit', async () => {
      as('OWNER');
      expect(everyRow((await dashboard().expect(200)).body)).toHaveLength(16);
      as('ADMIN');
      expect((await dashboard().expect(200)).body).toMatchObject({ empty: true, units: [], yourUnit: { rows: [] } });
      // And any leader's unit by `for`.
      expect((await dashboard({ for: office.id.SARI }).expect(200)).body.head).toMatchObject({ name: 'Sari Puspita', isReader: false });
    });

    it('P15-T1 AC-1 positive: an Agent holds the read and, leading nobody, is answered the empty unit — never a 403', async () => {
      as('INDAH');
      expect((await dashboard().expect(200)).body).toMatchObject({ empty: true, production: { canUpdate: false } });
    });

    it('P15-T1 AC-1 negative: a Super Admin outside a support session has no office to read from', async () => {
      session.current = SUPER_ADMIN;
      expect((await dashboard().expect(403)).body.error.code).toBe('TENANT_NO_MEMBERSHIP');
    });

    it('P15-T1 AC-1 negative: a membership on no rung the matrix names, or still pending, is refused by the guard', async () => {
      const agus = office.as('AGUS');
      session.current = new RequestContext('u-x', 'none', {
        ...agus.membership!, orgLevelCode: 'NOT_A_RUNG', hierarchyRole: NO_CLASS,
      });
      expect((await dashboard().expect(403)).body.error).toMatchObject({ code: 'PERM_DENIED', details: { permission: 'unit_dashboard:read' } });
      session.current = new RequestContext('u-x', 'none', { ...agus.membership!, status: 'pending' });
      expect((await dashboard().expect(403)).body.error.code).toBe('PERM_DENIED');
    });

    it('P15-T2 AC-10 a read-only support session reads the leader’s dashboard and is offered no Update production', async () => {
      const agus = office.as('AGUS');
      session.current = new RequestContext(agus.userId, 'none', agus.membership, 'u-support', null, false, true);
      const res = await dashboard().expect(200);
      expect(everyRow(res.body)).toHaveLength(11);
      expect(res.body.production.canUpdate).toBe(false);
      // An elevated one writes as the member, so it may.
      session.current = new RequestContext(agus.userId, 'none', agus.membership, 'u-support', null, false, false);
      expect((await dashboard().expect(200)).body.production.canUpdate).toBe(true);
    });
  });

  describe('P15-T1 AC-10 — refusals of the read', () => {
    it.each([
      ['a period it does not know', { period: 'week' }, 'period'],
      ['a period in another case', { period: 'Month' }, 'period'],
      ['a query parameter of any other name', { membershipId: 'x' }, 'membershipId'],
      ['a page', { page: '2' }, 'page'],
    ])('P15-T1 AC-10 %s is 400 VALIDATION_FAILED, named in details', async (_, query, named) => {
      as('AGUS');
      const res = await dashboard(query as Record<string, string>).expect(400);
      expect(res.body.error.code).toBe('VALIDATION_FAILED');
      expect(JSON.stringify(res.body.error.details)).toContain(named);
    });

    it.each(['7d', 'month', 'year'])('P15-T1 AC-10 the period %s is answered', async (period) => {
      as('AGUS');
      expect((await dashboard({ period }).expect(200)).body.period).toBe(period);
    });

    it.each([
      ['yourself', 'AGUS', 'AGUS'], ['somebody who leads nobody', 'AGUS', 'DIMAS'], ['a peer’s AAB', 'AGUS', 'PEER_AAB'],
      ['a member who left', 'AGUS', 'LEFT'], ['another office’s leader', 'AGUS', 'B_AB'], ['another office’s leader, as the Owner', 'OWNER', 'B_AB'],
    ] as const)('P15-T4 AC-5 `for` naming %s is 404 NOT_FOUND, never 403', async (_, reader, named) => {
      as(reader);
      expect((await dashboard({ for: office.id[named] }).expect(404)).body.error.code).toBe('NOT_FOUND');
    });

    it('P15-T4 AC-2 `for` naming a leader below the reader is that leader’s roster', async () => {
      as('AGUS');
      const res = await dashboard({ for: office.id.NINA, period: 'year' }).expect(200);
      expect(res.body).toMatchObject({ period: 'year', head: { name: 'Nina Lestari', isReader: false } });
      expect(everyRow(res.body).map((r) => r.name)).toEqual(['Nina Lestari', 'Dodi Kurniawan']);
    });
  });

  describe('P15-T3 AC-4 — Update production, a positive and a negative per role', () => {
    const rinaRow = (apeMonthlyMinor: number) => ({ membershipId: office.id.RINA, apeMonthlyMinor });

    it.each([['OWNER', 81], ['ADMIN', 82], ['AGUS', 83], ['SARI', 84]] as const)(
      'P15-T3 AC-4 positive: %s corrects Rina’s month',
      async (who, millions) => {
        as(who);
        const res = await patch({ month: UNIT_MONTH, revision: await revision(), rows: [rinaRow(millions * M)] }).expect(200);
        expect(res.body).toMatchObject({ updated: 1, state: { month: UNIT_MONTH, locked: false } });
        const stored = await db().collection('monthlyAgentData').findOne({ membershipId: office.id.RINA, month: UNIT_MONTH });
        expect(stored!.values.APE).toMatchObject({
          value: millions * M, provenance: 'corrected', correctedBy: office.id[who], reason: UNIT_DASHBOARD_CORRECTION_REASON,
        });
      },
    );

    it('P15-T3 AC-4 negative: an Agent holds no write, leading somebody or not', async () => {
      for (const who of ['INDAH', 'LUKAS'] as const) {
        as(who);
        const res = await patch({ month: UNIT_MONTH, revision: await revision(), rows: [{ membershipId: office.id.TARI, apeMonthlyMinor: 1 }] }).expect(403);
        expect(res.body.error).toMatchObject({ code: 'PERM_DENIED', details: { permission: 'unit_dashboard:update_production' } });
      }
    });

    it('P15-T3 AC-4 negative: the Super Admin holds no write, and a read-only support session is refused it', async () => {
      session.current = SUPER_ADMIN;
      expect((await patch({ month: UNIT_MONTH, revision: 0, rows: [rinaRow(1)] }).expect(403)).body.error.code).toBe('PERM_DENIED');
      const sari = office.as('SARI');
      session.current = new RequestContext(sari.userId, 'none', sari.membership, 'u-support', null, false, true);
      const before = await revision();
      expect((await patch({ month: UNIT_MONTH, revision: before, rows: [rinaRow(70 * M)] }).expect(403)).body.error.code).toBe('PERM_DENIED');
      expect(await revision()).toBe(before);
    });

    it('P15-T3 AC-4 an elevated support session corrects as the member, both actors on the audit row', async () => {
      const sari = office.as('SARI');
      session.current = new RequestContext(sari.userId, 'none', sari.membership, 'u-support', null, false, false);
      await patch({ month: UNIT_MONTH, revision: await revision(), rows: [rinaRow(79 * M)] }).expect(200);
      const entry = await db().collection('auditLog').findOne({ action: 'upload.cell_corrected', 'after.value': 79 * M });
      expect(entry).toMatchObject({ actorUserId: 'u-support', effectiveUserId: sari.userId, actorMembershipId: office.id.SARI });
    });

    it('P15-T3 AC-4 a row outside the reach, or another office’s member, is 404 with nothing written', async () => {
      as('SARI');
      const before = await revision();
      for (const named of ['LUKAS', 'B_AGENT', 'PEER_AGENT'] as const) {
        const res = await patch({ month: UNIT_MONTH, revision: before, rows: [rinaRow(60 * M), { membershipId: office.id[named], apeMonthlyMinor: 1 }] }).expect(404);
        expect(res.body.error.code).toBe('NOT_FOUND');
      }
      expect(await revision()).toBe(before);
    });

    it('P15-T3 AC-3 a stale revision 409 VERSION_CONFLICT; out of range 422 naming the row', async () => {
      as('SARI');
      const now = await revision();
      expect((await patch({ month: UNIT_MONTH, revision: now - 1, rows: [rinaRow(61 * M)] }).expect(409)).body.error.code).toBe('VERSION_CONFLICT');
      const res = await patch({ month: UNIT_MONTH, revision: now, rows: [{ membershipId: office.id.RINA, apeMonthlyMinor: Number.MAX_SAFE_INTEGER + 2 }] }).expect(422);
      expect(res.body.error).toMatchObject({ code: 'UPLOAD_VALUE_OUT_OF_RANGE', details: { membershipId: office.id.RINA, kode: 'APE', ytd: false } });
    });

    it('P19.5-T2 AC-7 refuses a year to date over HTTP: 400 naming it — the year is the months’ sum (R4)', async () => {
      as('SARI');
      const now = await revision();
      const res = await patch({ month: UNIT_MONTH, revision: now, rows: [{ membershipId: office.id.RINA, apeYtdMinor: 300 * M }] }).expect(400);
      expect(res.body.error).toMatchObject({ code: 'VALIDATION_FAILED', details: { field: 'apeYtdMinor', membershipId: office.id.RINA } });
      expect(await revision()).toBe(now);
    });

    it.each([
      ['no rows', { rows: [] }],
      ['more than 500 rows', { rows: Array.from({ length: 501 }, (_, i) => ({ membershipId: `m${i}`, apeMonthlyMinor: 1 })) }],
      ['a figure that is null — a leader cannot clear one', { rows: [{ membershipId: 'x', apeMonthlyMinor: null }] }],
      ['a negative figure', { rows: [{ membershipId: 'x', apeYtdMinor: -1 }] }],
      ['a fraction of a sen', { rows: [{ membershipId: 'x', apeYtdMinor: 1.5 }] }],
      ['a figure as a string', { rows: [{ membershipId: 'x', apeYtdMinor: '100' }] }],
      ['an unknown field on a row', { rows: [{ membershipId: 'x', apeYtdMinor: 1, fypMonthlyMinor: 1 }] }],
      ['an unknown field on the save', { reason: 'mine', rows: [{ membershipId: 'x', apeYtdMinor: 1 }] }],
      ['a month that is not YYYY-MM', { month: 'September', rows: [{ membershipId: 'x', apeYtdMinor: 1 }] }],
      ['no revision', { revision: undefined, rows: [{ membershipId: 'x', apeYtdMinor: 1 }] }],
      ['another month', { month: '2026-08', rows: [{ membershipId: 'x', apeYtdMinor: 1 }] }],
      ['a row with no figure', { rows: [{ membershipId: 'x' }] }],
      ['the same person twice', { rows: [{ membershipId: 'x', apeYtdMinor: 1 }, { membershipId: 'x', apeMonthlyMinor: 1 }] }],
    ])('P15-T3 AC-3 %s is 400 VALIDATION_FAILED, nothing written', async (_, over) => {
      as('SARI');
      const before = await revision();
      const res = await patch({ month: UNIT_MONTH, revision: before, ...over }).expect(400);
      expect(res.body.error.code).toBe('VALIDATION_FAILED');
      expect(await revision()).toBe(before);
    });

    /*
     * **The save's refusals in Indonesian** (P18.10-T5 AC-7): the words follow the request's `Accept-Language`, the
     * office's month in the reader's figures; the code and every detail — the field each names — are the same.
     */
    it('P18.10-T5 AC-7 refuses another month, a row with no figure, a person twice and a malformed month, in Indonesian', async () => {
      as('SARI');
      const before = await revision();
      const save = (over: Record<string, unknown>) =>
        patch({ month: UNIT_MONTH, revision: before, ...over }).set('Accept-Language', 'id').expect(400);

      expect((await save({ month: '2026-08', rows: [{ membershipId: 'x', apeYtdMinor: 1 }] })).body.error).toMatchObject({
        code: 'VALIDATION_FAILED',
        message: 'Produksi hanya dapat diperbarui di sini untuk Sep 2026, bulan berjalan KPM.',
        details: { field: 'month', month: UNIT_MONTH },
      });
      expect((await save({ rows: [{ membershipId: 'x' }] })).body.error).toMatchObject({
        message: 'Setiap baris memerlukan angka bulan ini, angka tahun ini, atau keduanya.', details: { field: 'rows[0]' },
      });
      expect((await save({ rows: [{ membershipId: 'x', apeYtdMinor: 1 }, { membershipId: 'x', apeMonthlyMinor: 1 }] })).body.error)
        .toMatchObject({
          message: 'Setiap orang hanya boleh muncul sekali dalam satu penyimpanan.',
          details: { field: 'rows[1].membershipId', membershipId: 'x' },
        });
      expect((await save({ month: 'September', rows: [{ membershipId: 'x', apeYtdMinor: 1 }] })).body.error.details)
        .toEqual({ violations: ['month harus dengan format YYYY-MM'] });
      expect(await revision()).toBe(before);
    });
  });

  /*
   * **Exit criterion 2 — one answer** (P15-T1 AC-5, P15-T3 AC-2, P15-T4 AC-1). Each row's goal figures are
   * `GET /summary?for=`'s, read by somebody who may (the Owner of the row's office); its status and *Last 1:1*
   * the leader's own `GET /coaching/coachees`; its production the month table's.
   */
  describe('exit criterion 2 — every row is the person’s own screens’ answer', () => {
    const LEADERS = ['OWNER', 'AGUS', 'SARI', 'NINA', 'LUKAS', 'PEER_AB', 'PEER_AAB', 'B_AB'] as const;
    const B_PEOPLE = new Set<string>();

    beforeAll(() => {
      for (const who of ['B_AB', 'B_AGENT'] as const) B_PEOPLE.add(office.id[who]);
    });

    /** The office's Owner for a member: 0417's, or 0555's root AB made its Owner for the read. */
    const ownerFor = (membershipId: string): RequestContext => {
      if (!B_PEOPLE.has(membershipId)) return office.as('OWNER');
      const b = office.as('B_AB');
      return new RequestContext(b.userId, 'none', { ...b.membership!, isKpmOwner: true });
    };
    const summaryOf = async (row: Row) => {
      // The Owner of the row's office reads anybody's Summary in it; their own is theirs without `for`.
      session.current = ownerFor(row.membershipId);
      const mine = row.membershipId === session.current.membershipId;
      return (await http().get('/summary').query(mine ? {} : { for: row.membershipId }).expect(200)).body;
    };

    async function agrees(leader: Who) {
      as(leader);
      const [month, year] = await Promise.all([
        dashboard().expect(200).then((r) => r.body as View),
        dashboard({ period: 'year' }).expect(200).then((r) => r.body as View),
      ]);
      as(leader);
      const roster = (await http().get('/coaching/coachees').expect(200)).body;
      const coached = [...roster.directAgents, ...roster.units.flatMap((u: { head: Row; members: Row[] }) => [u.head, ...u.members])] as Row[];
      session.current = ownerFor(office.id[leader]);
      const table = (await http().get(`/kpm/data-upload/${UNIT_MONTH}`).expect(200)).body as {
        rows: { membershipId: string; values: { APE: { value: number | null; provenance: string | null } }; ytd: { APE: { value: number | null; provenance: string | null } } }[];
      };

      for (const row of everyRow(month)) {
        const summary = await summaryOf(row);
        const yearly = everyRow(year).find((r) => r.membershipId === row.membershipId)!;
        const figures = (cell: Row['goal']) => ({
          targetMinor: cell.targetMinor, actualMinor: cell.actualMinor, attainmentPct: cell.attainmentPct, gapMinor: cell.gapMinor,
          overMinor: cell.overMinor, policiesNeeded: cell.policiesNeeded, targetMet: cell.targetMet,
          source: cell.source,
        });
        /*
         * The Summary's figures, less what the Summary adds for its own reader (UI-157: `production`, the helpers
         * without it) — and **the office's figure or nothing** (P19.1-T4 AC-12, ADR-0195): where the Summary's year is the
         * member's own (`self_reported`), the dashboard holds no APE produced for the year and no source.
         */
        const official = (period: Record<string, unknown> & { source: { provenance: string } | null }) => {
          const { production: _production, withoutProduction: _without, ...rest } = period;
          return period.source?.provenance === 'self_reported'
            ? { ...rest, actualMinor: null, attainmentPct: null, gapMinor: null, overMinor: null, policiesNeeded: null, targetMet: false, source: null }
            : rest;
        };
        expect({ leader, who: row.name, month: figures(row.goal), year: figures(yearly.goal), set: row.goal.set })
          .toEqual({ leader, who: row.name, month: official(summary.monthly), year: official(summary.yearly), set: summary.goal.set });

        if (!row.isReader) {
          const theirs = coached.find((r) => r.membershipId === row.membershipId)!;
          expect({ leader, who: row.name, status: row.status, last: row.lastOneOnOne })
            .toEqual({ leader, who: row.name, status: theirs.status, last: theirs.lastOneOnOne });
        }

        // The month table's APE and its year to date — the months' sum on both since P19.5-T2 (R4).
        const mine = table.rows.find((r) => r.membershipId === row.membershipId)!;
        expect({ leader, who: row.name, production: row.production }).toMatchObject({
          leader, who: row.name,
          production: {
            monthly: { valueMinor: mine.values.APE.value, provenance: mine.values.APE.provenance },
            ytd: { valueMinor: mine.ytd.APE.value, provenance: mine.ytd.APE.provenance },
          },
        });
      }
    }

    const all = async () => { for (const leader of LEADERS) await agrees(leader); };

    const file = (...rows: [Who, Record<string, string>][]) => ({
      buffer: Buffer.from([
        TEMPLATE_HEADER_V1.join(','),
        ...rows.map(([who, cells]) => [agentCodeOf[who], '"x"', ...VALUE_COLUMNS.map((c) => cells[`${c.metric}.${c.cadence}`] ?? '')].join(',')),
      ].join('\n')),
      originalname: 'f.csv',
      size: 0,
    });
    const agentCodeOf = {} as Record<Who, string>;
    const owner = () => office.as('OWNER');
    const importFile = async (f: ReturnType<typeof file>, replace?: string) => {
      const preview = await wired.production.preview(owner(), UNIT_MONTH, f);
      return wired.productionImport.commit(owner(), UNIT_MONTH, String(preview.revision), f, replace);
    };

    beforeAll(async () => {
      for (const who of ['RINA', 'NINA', 'DODI', 'BUDI'] as const) {
        agentCodeOf[who] = (await db().collection('memberships').findOne({ _id: new mongoose.Types.ObjectId(office.id[who]) }))!.agentCode;
      }
    });

    it('P15-T1 AC-5, P15-T4 AC-1 as the office stands: every leader, every row', all, 60_000);

    it('P15-T3 AC-2 through a file, a correction from the dashboard, the same file again, a restated file ticked, and a revert', async () => {
      // 1. A file: Nina's, Dodi's and Budi's first figures; Rina restated by the carrier.
      await importFile(file(
        ['RINA', { 'ape.monthly': '70', 'ape.ytd': '230' }], ['NINA', { 'ape.monthly': '12', 'ape.ytd': '40' }],
        ['DODI', { 'ape.monthly': '5', 'ape.ytd': '5' }], ['BUDI', { 'ape.ytd': '60' }],
      ), `${office.id.RINA}:APE`);
      await all();

      // 2. Sari corrects Rina's month and Dodi's from the dashboard (the year is the months' sum since P19.5-T2).
      as('SARI');
      await patch({
        month: UNIT_MONTH, revision: await revision(),
        rows: [{ membershipId: office.id.RINA, apeMonthlyMinor: 75 * M }, { membershipId: office.id.DODI, apeMonthlyMinor: 9 * M }],
      }).expect(200);
      await all();

      // 3. The same file again, unticked: the corrections stand (ADR-0053).
      const kept = await importFile(file(
        ['RINA', { 'ape.monthly': '70', 'ape.ytd': '230' }], ['NINA', { 'ape.monthly': '12', 'ape.ytd': '40' }],
        ['DODI', { 'ape.monthly': '5', 'ape.ytd': '5' }], ['BUDI', { 'ape.ytd': '60', 'fyp.monthly': '1' }],
      ));
      expect(kept.batch).toMatchObject({ keptCorrectionCount: 2 });
      await all();

      // 4. The carrier restates Rina's month, and the importer ticks it: the file's figure wins.
      const replaced = await importFile(file(['RINA', { 'ape.monthly': '72' }]), `${office.id.RINA}:APE`);
      as('AGUS');
      const rina = everyRow((await dashboard().expect(200)).body).find((r) => r.membershipId === office.id.RINA)!;
      expect(rina.production.monthly).toMatchObject({ valueMinor: 72 * M, provenance: 'imported' });
      await all();

      // 5. Reverting that import brings Sari's correction back, whole.
      await wired.productionImport.revert(owner(), replaced.batch.id);
      as('AGUS');
      const back = everyRow((await dashboard().expect(200)).body).find((r) => r.membershipId === office.id.RINA)!;
      expect(back.production.monthly).toMatchObject({ valueMinor: 75 * M, provenance: 'corrected', correctedBy: { name: 'Sari Puspita' } });
      expect(back.goal.source).toMatchObject({ provenance: 'corrected', correctedBy: { name: 'Sari Puspita' } });
      await all();
    }, 120_000);
  });
  /*
   * **A saved photo shows on every avatar of that person** (UI V1, UI-111): the Unit roster's rows, the coaching
   * roster's rows and the coachee's own header. `users.avatarUrl` is a storage key in a private bucket; each read
   * signs it into a link (`AvatarLinks`, over the stub storage here), and somebody without one is `null` — initials.
   */
  describe('UI-111 — the profile photo on the Unit roster, the coaching roster and the coachee header', () => {
    const KEY = 'user/66f0000000000000000009a1/avatar/01JAAAAAAAAAAAAAAAAAAAAAAA.jpg';
    const SIGNED = `https://cdn.test/${KEY}?sig=abc`;
    const rina = () => ({ email: 'rina@coaching.test' });
    beforeAll(async () => { await db().collection('users').updateOne(rina(), { $set: { avatarUrl: KEY } }); });
    afterAll(async () => { await db().collection('users').updateOne(rina(), { $set: { avatarUrl: null } }); });

    it('UI-111 GET /unit/dashboard: a row with a stored photo carries its signed link, a row without one null', async () => {
      as('SARI');
      const rows = everyRow((await dashboard().expect(200)).body) as (Row & { photoUrl: string | null })[];
      expect(rows.find((r) => r.membershipId === office.id.RINA)!.photoUrl).toBe(SIGNED);
      expect(rows.filter((r) => r.membershipId !== office.id.RINA).every((r) => r.photoUrl === null)).toBe(true);
      // Never the storage key itself.
      expect(JSON.stringify(rows)).not.toContain(`"${KEY}"`);
    });

    it('UI-111 GET /unit/dashboard/activities: each person’s column carries their signed link, or null', async () => {
      as('SARI');
      const people = (await http().get('/unit/dashboard/activities').expect(200)).body.people as
        { membershipId: string; photoUrl: string | null }[];
      expect(people.find((p) => p.membershipId === office.id.RINA)!.photoUrl).toBe(SIGNED);
      expect(people.filter((p) => p.membershipId !== office.id.RINA).every((p) => p.photoUrl === null)).toBe(true);
      expect(JSON.stringify(people)).not.toContain(`"${KEY}"`);
    });

    it('UI-111 GET /coaching/coachees: the same person’s row carries the link, everybody else null', async () => {
      as('SARI');
      const body = (await http().get('/coaching/coachees').expect(200)).body as {
        directAgents: { membershipId: string; photoUrl: string | null }[];
        units: { head: { membershipId: string; photoUrl: string | null }; members: { membershipId: string; photoUrl: string | null }[] }[];
      };
      const rows = [...body.directAgents, ...body.units.flatMap((u) => [u.head, ...u.members])];
      expect(rows.find((r) => r.membershipId === office.id.RINA)!.photoUrl).toBe(SIGNED);
      expect(rows.filter((r) => r.membershipId !== office.id.RINA).every((r) => r.photoUrl === null)).toBe(true);
    });

    it('UI-111 GET /coaching/coachees/:id: the coachee’s header carries their link, and a coachee without one null', async () => {
      as('SARI');
      expect((await http().get(`/coaching/coachees/${office.id.RINA}`).expect(200)).body.photoUrl).toBe(SIGNED);
      expect((await http().get(`/coaching/coachees/${office.id.BUDI}`).expect(200)).body.photoUrl).toBeNull();
    });
  });
});
