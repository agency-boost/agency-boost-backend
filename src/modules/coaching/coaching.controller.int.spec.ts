import { INestApplication } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { PermissionsGuard } from '@/common/auth/permissions.guard';
import { RequestContext } from '@/common/context/request-context';
import { DomainExceptionFilter } from '@/common/errors/error.filter';
import { clearCollections, startMongo, stopMongo } from '../../../test/mongo';
import { configModule } from '../../../test/config-module';
import { ADMIN, declaredPermissions, NO_CLASS, OWNER, productionPipe, session, StubAuth, SUPER_ADMIN } from '../../../test/http-permissions';
import { listenOnLoopback } from '../../../test/listen';
import {
  buildCoachingOffice, ROSTER_NOW, ROSTER_TODAY, type CoachingOffice, type Who,
} from '../../../test/coaching-office';
import { CoachingController } from './coaching.controller';
import { CoachingRosterService } from './coaching-roster.service';
import { CoacheeService } from './coachee.service';
import { CoachingSessionService } from './coaching-session.service';

/** Every route, and the permission it must declare. */
const ROUTES: Record<string, string> = {
  coachees: 'coaching_session:read',
  // P11-T7: the person a coaching page opens on (`coachee.int.spec.ts`).
  coachee: 'coaching_session:read',
  // P11-T5: the session lifecycle (`coaching-session.int.spec.ts` walks each).
  history: 'coaching_session:read',
  start: 'coaching_session:create',
  read: 'coaching_session:read',
  save: 'coaching_session:edit',
  finalize: 'coaching_session:finalize',
  reopen: 'coaching_session:reopen',
};

type Row = { membershipId: string; name: string };
type Body = { directAgents: Row[]; units: { head: Row; members: Row[] }[] };
const everybody = (body: Body) => [...body.directAgents, ...body.units.flatMap((u) => [u.head, ...u.members])];

/**
 * **`GET /coaching/coachees` over HTTP, per role** (P11-T6; `functional/coaching.md`, the Data contract).
 *
 * With the real `PermissionsGuard`, the production pipe and the real service over
 * `test/coaching-office.ts`'s office. `coaching-roster.tenancy.spec.ts` proves what the roster holds; this
 * proves who is answered and who is refused, and that the wire carries nothing but the contract.
 */
describe('the coaching roster over HTTP (P11-T6)', () => {
  let app: INestApplication;
  let wired: ReturnType<typeof configModule>;
  let office: CoachingOffice;
  const url = '/coaching/coachees';
  const get = () => request(app.getHttpServer()).get(url);
  const as = (who: Who) => { session.current = office.as(who); };

  beforeAll(async () => {
    await startMongo();
    wired = configModule(ROSTER_NOW);
    await clearCollections();
    office = await buildCoachingOffice(wired);

    const moduleRef = await Test.createTestingModule({
      controllers: [CoachingController],
      providers: [
        { provide: CoachingRosterService, useValue: wired.coachingRoster },
        { provide: CoacheeService, useValue: wired.coachee },
        { provide: CoachingSessionService, useValue: wired.coachingSession },
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
    expect(declaredPermissions(CoachingController)).toEqual(ROUTES);
  });

  describe('who is answered', () => {
    it('P11-T6 AC-2 an AB is answered their whole downline', async () => {
      as('AGUS');
      const res = await get().expect(200);

      expect(res.body).toMatchObject({ today: ROSTER_TODAY, overdueAfterDays: 7 });
      expect(res.body.directAgents.map((r: Row) => r.name)).toEqual(['Dimas Pratama', 'Indah Permatasari']);
      expect(everybody(res.body)).toHaveLength(10);
    });

    it('P11-T6 AC-2 an AAB is answered their subtree, a nested unit included', async () => {
      as('SARI');
      const res = await get().expect(200);

      expect(everybody(res.body).map((r) => r.name).sort())
        .toEqual(['Budi Santoso', 'Dodi Kurniawan', 'Nina Lestari', 'Rina Wijaya']);
    });

    it('P11-T6 AC-2 an Agent who leads nobody holds the read and is answered an empty roster', async () => {
      // The matrix grants an Agent `own` on `coaching_session:read` (ADR-0078): the guard lets them through,
      // and `COACH` reaches nobody.
      as('INDAH');
      expect((await get().expect(200)).body).toEqual({
        today: ROSTER_TODAY, overdueAfterDays: 7, directAgents: [], units: [],
      });
    });

    it('P11-T6 AC-2 an AAB who leads nobody is answered an empty roster too', async () => {
      as('DEWI');
      expect((await get().expect(200)).body).toMatchObject({ directAgents: [], units: [] });
    });

    it('P11-T6 AC-2 the Owner, standing at the root as the office’s AB, is answered the whole office', async () => {
      as('OWNER');
      const res = await get().expect(200);
      // Seventeen people in the office: everybody but the Owner and the member who left.
      expect(everybody(res.body)).toHaveLength(15);
    });

    it('P11-T6 AC-2 the Admin, who stands above nobody, is answered an empty roster', async () => {
      as('ADMIN');
      expect((await get().expect(200)).body).toMatchObject({ directAgents: [], units: [] });
    });

    it('P11-T6 AC-2 an Owner or an Admin who leads nobody holds own-kpm and coaches nobody by it', async () => {
      for (const who of [OWNER, ADMIN]) {
        session.current = who;
        expect((await get().expect(200)).body).toMatchObject({ directAgents: [], units: [] });
      }
    });

    it('P11-T6 AC-2 a read-only support session reads the roster it would read as that leader', async () => {
      const agus = office.as('AGUS');
      session.current = new RequestContext(agus.userId, 'none', agus.membership, 'u-support', null, false, true);
      expect(everybody((await get().expect(200)).body)).toHaveLength(10);
    });
  });

  describe('who is refused, and how', () => {
    it('P11-T6 a Super Admin, who has no membership to coach from, is refused by name', async () => {
      session.current = SUPER_ADMIN;
      const res = await get().expect(403);
      expect(res.body.error.code).toBe('TENANT_NO_MEMBERSHIP');
    });

    it('P11-T6 a membership on no rung the matrix names is refused by the guard', async () => {
      const agus = office.as('AGUS');
      session.current = new RequestContext('u-x', 'none', {
        ...agus.membership!, orgLevelCode: 'NOT_A_RUNG', hierarchyRole: NO_CLASS,
      });
      const res = await get().expect(403);
      expect(res.body.error).toMatchObject({ code: 'PERM_DENIED', details: { permission: 'coaching_session:read' } });
    });

    it('P11-T6 a leader whose membership is pending holds no hierarchy grant yet', async () => {
      const agus = office.as('AGUS');
      session.current = new RequestContext('u-x', 'none', { ...agus.membership!, status: 'pending' });
      expect((await get().expect(403)).body.error.code).toBe('PERM_DENIED');
    });

    it('P11-T6 asks nothing of the caller: a query parameter is refused by name, somebody’s id included', async () => {
      as('AGUS');
      const res = await get().query({ membershipId: office.id.RINA }).expect(400);
      expect(res.body.error.code).toBe('VALIDATION_FAILED');
      expect(JSON.stringify(res.body.error.details)).toContain('membershipId');
    });
  });

  describe('the tenant boundary', () => {
    it('P11-T6 an AB of another office is answered their own people, and nothing of this office leaks', async () => {
      as('B_AB');
      const res = await get().expect(200);
      expect(everybody(res.body).map((r) => r.name)).toEqual(['Bayu Saputra']);
      expect(JSON.stringify(res.body)).not.toContain(office.id.RINA);
    });

    it('P11-T6 AC-2 a peer AAB’s agent is never on an AAB’s roster', async () => {
      as('SARI');
      expect(JSON.stringify((await get().expect(200)).body)).not.toContain(office.id.PEER_AGENT);
      as('PEER_AAB');
      expect(everybody((await get().expect(200)).body).map((r) => r.membershipId)).toEqual([office.id.PEER_AGENT]);
    });
  });

  it('P11-T6 AC-6 the wire carries statuses and dates, and no count of any activity', async () => {
    as('AGUS');
    const res = await get().expect(200);
    const rina = everybody(res.body).find((r) => r.membershipId === office.id.RINA);
    expect(Object.keys(rina!).sort()).toEqual(['depth', 'lastOneOnOne', 'membershipId', 'name', 'rung', 'status']);
    // Rina logged 53 recruiting follow-ups a day for a fortnight: not one of those numbers is in the answer.
    expect(JSON.stringify(res.body)).not.toMatch(/"(count|logged|total|totalCount|entries|compliant\w*)"/);
  });
});
