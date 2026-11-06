import { INestApplication } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { PermissionsGuard } from '@/common/auth/permissions.guard';
import { DomainExceptionFilter } from '@/common/errors/error.filter';
import { MemberNames } from '@/modules/org/member-names.service';
import { TenantDay } from '@/modules/tenants/tenant-day.service';
import { clearCollections, startMongo, stopMongo } from '../../../test/mongo';
import { configModule } from '../../../test/config-module';
import { declaredPermissions, productionPipe, session, StubAuth, SUPER_ADMIN } from '../../../test/http-permissions';
import { listenOnLoopback } from '../../../test/listen';
import { buildCoachingOffice, ROSTER_NOW, type CoachingOffice, type Who } from '../../../test/coaching-office';
import { UnitPotensiController } from './unit-potensi.controller';
import { UnitPotensiService } from './unit-potensi.service';

/**
 * **P19.1-T6 — the *Potensi* tab over HTTP, per role** (AC-1, AC-12; UI-155): `GET /unit/dashboard/potensi` and `GET
 * /unit/dashboard/potensi/:membershipId` through the real `PermissionsGuard`, the production pipe and the real service
 * over `test/coaching-office.ts`'s office. **An AB and an AAB are answered; an Agent is refused** — one who leads
 * nobody and one who leads somebody alike — the Owner and an Admin read it in their field view.
 */
describe('P19.1-T6 the Potensi tab over HTTP', () => {
  let app: INestApplication;
  let wired: ReturnType<typeof configModule>;
  let office: CoachingOffice;
  const as = (who: Who) => { session.current = office.as(who); };
  const http = () => request(app.getHttpServer());
  const tab = (query: Record<string, string> = {}) => http().get('/unit/dashboard/potensi').query(query);
  const sheet = (who: string, query: Record<string, string> = {}) => http().get(`/unit/dashboard/potensi/${who}`).query(query);

  beforeAll(async () => {
    await startMongo();
    wired = configModule(ROSTER_NOW);
    await clearCollections();
    office = await buildCoachingOffice(wired);
    const potensi = new UnitPotensiService(
      wired.unitDashboard, new TenantDay(wired.kpms as never, wired.clock), wired.clock, wired.leadReadings,
      wired.productionReadings, wired.coach, wired.orgLevels, new MemberNames(wired.memberships, wired.users as never),
      wired.memberships, wired.subjectReads, wired.users as never,
    );
    const moduleRef = await Test.createTestingModule({
      controllers: [UnitPotensiController],
      providers: [{ provide: UnitPotensiService, useValue: potensi }],
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

  it('P19.1-T6 AC-1 declares the tab’s own permission on both routes', () => {
    expect(declaredPermissions(UnitPotensiController)).toEqual({
      read: 'unit_dashboard:read_potensi',
      person: 'unit_dashboard:read_potensi',
    });
  });

  describe('GET /unit/dashboard/potensi — a positive and a negative per role', () => {
    it('P19.1-T6 AC-1 positive: an AB is answered their unit, this month by default', async () => {
      as('AGUS');
      const res = await tab().expect(200);
      expect(res.body).toMatchObject({ month: '2026-09', currentMonth: '2026-09', head: { name: 'Agus Salim', isReader: true } });
      expect(res.body.units.at(-1)).toMatchObject({ kind: 'direct', leader: { name: 'Agus Salim' } });
    });

    it('P19.1-T6 AC-1 positive: an AAB is answered their own; one who leads nobody, their card alone (AC-10)', async () => {
      as('SARI');
      expect((await tab().expect(200)).body.units).toHaveLength(2);
      as('DEWI');
      expect((await tab().expect(200)).body).toMatchObject({ tiles: { aa: 0, rekrut: 0 }, units: [{ kind: 'direct' }] });
    });

    it('P19.1-T6 AC-1 positive: the Owner and an Admin read a leader’s unit in their field view', async () => {
      as('OWNER');
      expect((await tab({ for: office.id.SARI }).expect(200)).body.head).toMatchObject({ name: 'Sari Puspita' });
      as('ADMIN');
      expect((await tab({ for: office.id.SARI }).expect(200)).body.head).toMatchObject({ name: 'Sari Puspita' });
    });

    it.each(['INDAH', 'LUKAS'] as const)('P19.1-T6 AC-1 negative: an Agent (%s) is refused 403, whether or not they lead somebody', async (who) => {
      as(who);
      const res = await tab().expect(403);
      expect(res.body.error).toMatchObject({ code: 'PERM_DENIED', details: { permission: 'unit_dashboard:read_potensi' } });
    });

    it('P19.1-T6 AC-1 negative: a Super Admin has no office', async () => {
      session.current = SUPER_ADMIN;
      expect((await tab().expect(403)).body.error.code).toBe('TENANT_NO_MEMBERSHIP');
    });

    it('P19.1-T6 AC-12 negative: outside the reach — a peer’s unit, another office’s leader — is 404, never 403', async () => {
      as('AGUS');
      expect((await tab({ for: office.id.PEER_AB }).expect(404)).body.error.code).toBe('NOT_FOUND');
      expect((await tab({ for: office.id.B_AB }).expect(404)).body.error.code).toBe('NOT_FOUND');
    });

    it.each([
      ['a month that is not a month', { month: '2026-9' }, 'month'],
      ['a month after this one', { month: '2026-10' }, 'month'],
      ['a parameter of any other name', { view: 'aa' }, 'view'],
    ])('P19.1-T6 AC-12 %s is 400 VALIDATION_FAILED, named in details', async (_, query, named) => {
      as('AGUS');
      const res = await tab(query as Record<string, string>).expect(400);
      expect(res.body.error.code).toBe('VALIDATION_FAILED');
      expect(JSON.stringify(res.body.error.details)).toContain(named);
    });
  });

  describe('GET /unit/dashboard/potensi/:membershipId — the sheet', () => {
    it('P19.1-T6 AC-6 positive: an AB and an AAB open a coachee’s sheet', async () => {
      as('AGUS');
      expect((await sheet(office.id.RINA).expect(200)).body.person).toMatchObject({ name: 'Rina Wijaya' });
      as('SARI');
      expect((await sheet(office.id.RINA, { month: '2026-08' }).expect(200)).body).toMatchObject({ month: '2026-08' });
    });

    it('P19.1-T6 AC-1 negative: an Agent is refused the sheet too, their own included', async () => {
      as('RINA');
      expect((await sheet(office.id.RINA).expect(403)).body.error.code).toBe('PERM_DENIED');
    });

    it('P19.1-T6 AC-12 negative: a peer AAB, an Admin outside their downline and another office are answered 404', async () => {
      for (const who of ['PEER_AAB', 'ADMIN', 'B_AB'] as const) {
        as(who);
        expect([who, (await sheet(office.id.RINA)).status]).toEqual([who, 404]);
      }
    });
  });
});
