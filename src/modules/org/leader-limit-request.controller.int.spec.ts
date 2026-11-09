import { INestApplication } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { PermissionsGuard } from '@/common/auth/permissions.guard';
import { RequestContext } from '@/common/context/request-context';
import { DomainExceptionFilter } from '@/common/errors/error.filter';
import { DirectoryColumns } from '@/modules/reporting/directory-columns';
import {
  AAB, AB, ADMIN, AGENT, OWNER, SUPER_ADMIN, declaredPermissions, productionPipe, session, StubAuth,
} from '../../../test/http-permissions';
import { listenOnLoopback } from '../../../test/listen';
import { AdminDelegationService } from './admin-delegation.service';
import { DirectoryService } from './directory.service';
import { GroupService } from './group.service';
import { LeaderLimitRequestAdminController } from './leader-limit-request.controller';
import { LeaderLimitRequestService } from './leader-limit-request.service';
import { OrgController } from './org.controller';
import { OrgTreeService } from './org-tree.service';
import { RemovalService } from './removal.service';
import { RoleChangeService } from './role-change.service';

const REQUEST_ID = '66f00000000000000000ee01';
const MEMBER_ID = '66f00000000000000000ee02';

/** A support session as the Owner, read-only or elevated: the member's own grants, the operator on the row. */
const supporting = (readOnly: boolean) =>
  new RequestContext(OWNER.userId, 'none', OWNER.membership, 'root', null, false, readOnly);

/**
 * **The leader-limit request routes over HTTP** (P18.5-T2 AC-3 to AC-5, ADR-0157): who the API refuses — the
 * decorators and the real `PermissionsGuard` — and what the production pipe turns away. What the service does
 * with a request is `leader-limit-request.tenancy.spec.ts`'s; here it is a spy that answers `[]`.
 */
describe('P18.5-T2 — the leader-limit request routes, over HTTP', () => {
  let app: INestApplication;
  const calls: string[] = [];
  const spy = (name: string) => async () => { calls.push(name); return []; };
  const changed: { toRole?: string }[] = [];

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      controllers: [OrgController, LeaderLimitRequestAdminController],
      providers: [
        {
          provide: LeaderLimitRequestService,
          useValue: {
            list: spy('list'), cancel: spy('cancel'), create: spy('create'),
            queue: spy('queue'), approve: spy('approve'), decline: spy('decline'),
          },
        },
        {
          provide: RoleChangeService,
          useValue: { change: async (_ctx: unknown, _id: string, toRole: string) => { changed.push({ toRole }); return []; } },
        },
        ...[DirectoryService, RemovalService, GroupService, AdminDelegationService, DirectoryColumns, OrgTreeService]
          .map((provide) => ({ provide, useValue: {} })),
      ],
    }).compile();
    app = moduleRef.createNestApplication();
    app.useGlobalPipes(productionPipe());
    app.useGlobalFilters(new DomainExceptionFilter());
    app.useGlobalGuards(new StubAuth(), new PermissionsGuard(app.get(Reflector)));
    await app.init();
    await listenOnLoopback(app);
  });
  afterAll(() => app.close());
  beforeEach(() => { calls.length = 0; changed.length = 0; });

  const http = () => request(app.getHttpServer());
  const ask = () => http().post(`/members/${MEMBER_ID}/leader-limit-request`).send({ action: 'promote', orgLevelCode: 'AAB' });

  it('declares the permission each route needs', () => {
    expect(declaredPermissions(OrgController)).toMatchObject({
      // UI V1 (UI-012, D-14; the Phase 18.11 exit review, T1): *Search agent* reads on the roster's own grant.
      search: 'member:read_profile',
      leaderLimitRequests: 'leader_limit_request:read',
      cancelLeaderLimitRequest: 'leader_limit_request:create',
      requestPastLeaderLimit: 'leader_limit_request:create',
    });
    expect(declaredPermissions(LeaderLimitRequestAdminController)).toEqual({
      queue: 'leader_limit_request:read',
      approve: 'leader_limit_request:decide',
      decline: 'leader_limit_request:decide',
    });
  });

  describe('AC-5: the office asks, lists and cancels', () => {
    it.each([['the Owner', OWNER], ['an Admin', ADMIN], ['an AB', AB], ['an AAB', AAB]])(
      'lets %s ask, list and cancel',
      async (_who, ctx) => {
        session.current = ctx;
        await ask().expect(201);
        await http().get('/members/leader-limit-requests').expect(200);
        await http().delete(`/members/leader-limit-requests/${REQUEST_ID}`).expect(200);
        expect(calls).toEqual(['create', 'list', 'cancel']);
      },
    );

    it('refuses an Agent all three, and the service is never asked', async () => {
      session.current = AGENT;
      await ask().expect(403);
      await http().get('/members/leader-limit-requests').expect(403);
      await http().delete(`/members/leader-limit-requests/${REQUEST_ID}`).expect(403);
      expect(calls).toEqual([]);
    });

    it('a read-only support session lists and may not ask or cancel; an elevated one may', async () => {
      session.current = supporting(true);
      await http().get('/members/leader-limit-requests').expect(200);
      await ask().expect(403);
      await http().delete(`/members/leader-limit-requests/${REQUEST_ID}`).expect(403);
      session.current = supporting(false);
      await ask().expect(201);
      expect(calls).toEqual(['list', 'create']);
    });

    it('the route is not read as a member: GET leader-limit-requests reaches the list', async () => {
      session.current = OWNER;
      await http().get('/members/leader-limit-requests').expect(200);
      expect(calls).toEqual(['list']);
    });

    it('turns away an action that is not one, or a rung that is no code', async () => {
      session.current = OWNER;
      await http().post(`/members/${MEMBER_ID}/leader-limit-request`).send({ action: 'raise' }).expect(400);
      await http().post(`/members/${MEMBER_ID}/leader-limit-request`)
        .send({ action: 'promote', orgLevelCode: 'Senior Manager' }).expect(400);
      expect(calls).toEqual([]);
    });
  });

  describe('AC-5: the Super Admin decides', () => {
    it('lets a Super Admin read the queue, approve and decline', async () => {
      session.current = SUPER_ADMIN;
      await http().get('/admin/leader-limit-requests').expect(200);
      await http().post(`/admin/leader-limit-requests/${REQUEST_ID}/approve`).expect(200);
      await http().post(`/admin/leader-limit-requests/${REQUEST_ID}/decline`).send({ reason: 'Not now.' }).expect(200);
      expect(calls).toEqual(['queue', 'approve', 'decline']);
    });

    it.each([['the Owner', OWNER], ['an Admin', ADMIN], ['an AB', AB], ['an AAB', AAB], ['an Agent', AGENT],
      ['a support session', supporting(false)]])('refuses %s a decision', async (_who, ctx) => {
      session.current = ctx;
      await http().post(`/admin/leader-limit-requests/${REQUEST_ID}/approve`).expect(403);
      await http().post(`/admin/leader-limit-requests/${REQUEST_ID}/decline`).send({ reason: 'x' }).expect(403);
      expect(calls).toEqual([]);
    });

    it('refuses an Agent the queue; an office’s Owner holds the read, and the service refuses them (tenancy spec)', async () => {
      session.current = AGENT;
      await http().get('/admin/leader-limit-requests').expect(403);
      expect(calls).toEqual([]);
    });

    it('a decline needs a reason', async () => {
      session.current = SUPER_ADMIN;
      await http().post(`/admin/leader-limit-requests/${REQUEST_ID}/decline`).send({}).expect(400);
      await http().post(`/admin/leader-limit-requests/${REQUEST_ID}/decline`).send({ reason: '   ' }).expect(400);
      expect(calls).toEqual([]);
    });
  });

  describe('OD-50: a role change names any rung of the company’s ladder', () => {
    it('passes a rung the company added through to the service, and turns away what is no rung code', async () => {
      session.current = OWNER;
      await http().patch(`/members/${MEMBER_ID}/role`).send({ toRole: 'SM' }).expect(200);
      await http().patch(`/members/${MEMBER_ID}/role`).send({ toRole: 'aab' }).expect(200);
      await http().patch(`/members/${MEMBER_ID}/role`).send({ toRole: 'senior manager' }).expect(400);
      await http().patch(`/members/${MEMBER_ID}/role`).send({ toRole: '' }).expect(400);
      expect(changed.map((c) => c.toRole)).toEqual(['SM', 'aab']);
    });
  });
});
