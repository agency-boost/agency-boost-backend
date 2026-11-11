import { INestApplication } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { Test } from '@nestjs/testing';
import mongoose from 'mongoose';
import request from 'supertest';
import { PermissionsGuard } from '@/common/auth/permissions.guard';
import { DomainExceptionFilter } from '@/common/errors/error.filter';
import { UNIT_DASHBOARD } from '@/domain/constants';
import { DirectoryColumns } from '@/modules/reporting/directory-columns';
import { clearCollections, startMongo, stopMongo } from '../../../test/mongo';
import { configModule } from '../../../test/config-module';
import { declaredPermissions, productionPipe, session, StubAuth } from '../../../test/http-permissions';
import { listenOnLoopback } from '../../../test/listen';
import {
  buildCoachingOffice, KPM_A, KPM_B, ROSTER_NOW, type CoachingOffice, type Who,
} from '../../../test/coaching-office';
import { AdminDelegationService } from './admin-delegation.service';
import { DirectoryService } from './directory.service';
import { Group, GroupSchema } from './group.schema';
import { GroupService } from './group.service';
import { LeaderLimitRequestService } from './leader-limit-request.service';
import { OrgController } from './org.controller';
import { GroupRepository } from './org.repositories';
import { OrgTreeService } from './org-tree.service';
import { RemovalService } from './removal.service';
import { RoleChangeService } from './role-change.service';

/**
 * ***+ Tambah ke grup* over HTTP** (P19.12-T6 AC-4; the client's message of 11 November 2026, item 7; ADR-0249 §4):
 * `POST /members/groups/:groupId/members`, with the real `PermissionsGuard`, the production pipe and the real
 * `GroupService` over the coaching office. `member:tag_group` is the Owner's and an Admin's; everybody else is refused
 * by the guard, and the server — not the screen — says so.
 */
describe('POST /members/groups/:groupId/members over HTTP (P19.12-T6)', () => {
  let app: INestApplication;
  let wired: ReturnType<typeof configModule>;
  let office: CoachingOffice;
  const db = () => mongoose.connection.db!;
  const as = (who: Who) => { session.current = office.as(who); };
  const add = (groupId: string, membershipIds: unknown) =>
    request(app.getHttpServer()).post(`/members/groups/${groupId}/members`).send({ membershipIds });
  const group = async (name: string, over: Record<string, unknown> = {}, kpmId = KPM_A) => {
    const _id = new mongoose.Types.ObjectId();
    await db().collection('groups').insertOne({
      _id, kpmId, name, ownerMembershipId: office.id.AGUS, status: 'active', archivedAt: null, createdByMembershipId: null,
      deletedAt: null, ...over,
    });
    return String(_id);
  };
  const tagsOf = async (who: Who) =>
    (await db().collection('memberships').findOne({ _id: new mongoose.Types.ObjectId(office.id[who]) }))?.groupIds ?? [];
  const tagged = () => db().collection('auditLog').countDocuments({ action: 'member.tagged' });

  beforeAll(async () => {
    await startMongo();
    wired = configModule(ROSTER_NOW);
    await clearCollections();
    office = await buildCoachingOffice(wired);
    const model = mongoose.models[Group.name] ?? mongoose.model(Group.name, GroupSchema);
    const groups = new GroupService(new GroupRepository(model as never), wired.memberships, wired.users as never, wired.audit, wired.clock);

    const moduleRef = await Test.createTestingModule({
      controllers: [OrgController],
      providers: [
        { provide: GroupService, useValue: groups },
        // The others back routes this spec never calls.
        ...[
          DirectoryService, RoleChangeService, RemovalService, OrgTreeService, AdminDelegationService, DirectoryColumns,
          LeaderLimitRequestService,
        ].map((provide) => ({ provide, useValue: {} })),
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
  afterEach(async () => {
    await db().collection('groups').deleteMany({});
    await db().collection('memberships').updateMany({}, { $set: { groupIds: [] } });
  });

  it('P19.12-T6 AC-4 declares member:tag_group on the route', () => {
    expect(declaredPermissions(OrgController).addGroupMembers).toBe('member:tag_group');
  });

  it('P19.12-T6 AC-4 positive: the Owner tags the ABs into a leader’s group at once, one audit entry each', async () => {
    const circle = await group('Agus Circle');
    const before = await tagged();
    as('OWNER');
    const res = await add(circle, [office.id.PEER_AB, office.id.ADMIN]).expect(201);
    expect(res.body).toEqual({ groupId: circle, name: 'Agus Circle', added: 2, memberCount: 2 });
    expect(await tagsOf('PEER_AB')).toEqual([circle]);
    expect(await tagged()).toBe(before + 2);
  });

  it('P19.12-T6 AC-4 positive: an Admin may too; somebody already in the group is not counted again', async () => {
    const circle = await group('Agus Circle');
    as('ADMIN');
    await add(circle, [office.id.PEER_AB]).expect(201);
    expect((await add(circle, [office.id.PEER_AB, office.id.ADMIN]).expect(201)).body).toMatchObject({ added: 1, memberCount: 2 });
  });

  it.each(['AGUS', 'SARI', 'LUKAS', 'INDAH'] as const)(
    'P19.12-T6 AC-4 negative: %s — an AB, an AAB, an Agent who leads, an Agent — is refused 403, nothing tagged',
    async (who) => {
      const circle = await group('Agus Circle');
      as(who);
      const res = await add(circle, [office.id.PEER_AB]).expect(403);
      expect(res.body.error).toMatchObject({ code: 'PERM_DENIED', details: { permission: 'member:tag_group' } });
      expect(await tagsOf('PEER_AB')).toEqual([]);
    },
  );

  it('P19.12-T6 AC-4 cross-tenant: another office’s group is 404, and nothing is tagged', async () => {
    const theirs = await group('B Circle', { ownerMembershipId: office.id.B_AB }, KPM_B);
    const before = await tagged();
    as('OWNER');
    expect((await add(theirs, [office.id.PEER_AB]).expect(404)).body.error.code).toBe('NOT_FOUND');
    expect(await tagsOf('PEER_AB')).toEqual([]);
    expect(await tagged()).toBe(before);
  });

  it('P19.12-T6 AC-4 cross-tenant: another office’s member, or one who left, is 404 — and the others are not tagged either', async () => {
    const circle = await group('Agus Circle');
    as('OWNER');
    for (const outsider of [office.id.B_AGENT, office.id.LEFT, 'not-an-id']) {
      expect((await add(circle, [office.id.PEER_AB, outsider]).expect(404)).body.error.code).toBe('NOT_FOUND');
    }
    expect(await tagsOf('PEER_AB')).toEqual([]);
  });

  it('P19.12-T6 AC-4 an archived group is 404', async () => {
    const archived = await group('Old', { status: 'archived', archivedAt: ROSTER_NOW });
    as('OWNER');
    await add(archived, [office.id.PEER_AB]).expect(404);
  });

  it.each([
    ['nobody', []],
    ['not a list', 'x'],
    ['an id that is not text', [42]],
    ['more than one add takes', Array.from({ length: UNIT_DASHBOARD.MAX_TAGGED_PER_ADD + 1 }, (_, i) => `id${i}`)],
  ])('P19.12-T6 AC-4 %s is 400 VALIDATION_FAILED', async (_, ids) => {
    const circle = await group('Agus Circle');
    as('OWNER');
    expect((await add(circle, ids).expect(400)).body.error.code).toBe('VALIDATION_FAILED');
  });
});
