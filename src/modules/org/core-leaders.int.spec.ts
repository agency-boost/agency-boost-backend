import { INestApplication } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { Test } from '@nestjs/testing';
import mongoose from 'mongoose';
import request from 'supertest';
import { PermissionsGuard } from '@/common/auth/permissions.guard';
import { ViewOnlySessionGuard } from '@/common/auth/view-only-session.guard';
import { RequestContext } from '@/common/context/request-context';
import { DomainExceptionFilter } from '@/common/errors/error.filter';
import { CORE_LEADERS } from '@/domain/constants';
import { DirectoryColumns } from '@/modules/reporting/directory-columns';
import { TenantDay } from '@/modules/tenants/tenant-day.service';
import { clearCollections, startMongo, stopMongo } from '../../../test/mongo';
import { configModule } from '../../../test/config-module';
import { declaredPermissions, productionPipe, session, StubAuth } from '../../../test/http-permissions';
import { listenOnLoopback } from '../../../test/listen';
import {
  buildCoachingOffice, ROSTER_NOW, type CoachingOffice, type Who,
} from '../../../test/coaching-office';
import { AdminDelegationService } from './admin-delegation.service';
import { CoreLeadersService, type CoreLeadersView } from './core-leaders.service';
import { DirectoryService } from './directory.service';
import { Group, GroupSchema } from './group.schema';
import { GroupService } from './group.service';
import { LeaderLimitRequestService } from './leader-limit-request.service';
import { MemberNames } from './member-names.service';
import { OrgController } from './org.controller';
import { GroupRepository } from './org.repositories';
import { OrgTreeService } from './org-tree.service';
import { RemovalService } from './removal.service';
import { RoleChangeService } from './role-change.service';

/**
 * ***Core leaders & groups* over HTTP** (P19.13-T3; UI-199; ADR-0253): `GET /members/core-leaders`, `PUT
 * /members/core-leaders/bulk`, `PUT /members/core-leaders/:membershipId`, and the group routes the page drives, with the
 * real `PermissionsGuard`, `ViewOnlySessionGuard`, the production pipe and the real services over the coaching office —
 * 0417's leaders: the Owner, the Admin and Agus (ABs), Sari, Nina and Dewi (AABs), Hendra (an AB) and Putu (an AAB).
 */
describe('Core leaders & groups over HTTP (P19.13-T3)', () => {
  let app: INestApplication;
  let wired: ReturnType<typeof configModule>;
  let office: CoachingOffice;
  const db = () => mongoose.connection.db!;
  const as = (who: Who) => { session.current = office.as(who); };
  const http = () => request(app.getHttpServer());
  const read = async (): Promise<CoreLeadersView> => (await http().get('/members/core-leaders').expect(200)).body;
  const row = (view: CoreLeadersView, who: Who) => view.leaders.find((l) => l.membershipId === office.id[who])!;
  const bulk = (body: Record<string, unknown>) => http().put('/members/core-leaders/bulk').send(body);
  const save = (who: Who | string, body: Record<string, unknown>) =>
    http().put(`/members/core-leaders/${who in office.id ? office.id[who as Who] : who}`).send(body);
  const makeGroup = async (name: string) => {
    const list = (await http().post('/members/groups').send({ name }).expect(201)).body as { groupId: string; name: string }[];
    return list.find((g) => g.name === name)!.groupId;
  };
  const tagged = () => db().collection('auditLog').countDocuments({ action: 'member.tagged' });
  const ids = (...who: Who[]) => who.map((w) => office.id[w]);

  beforeAll(async () => {
    await startMongo();
    wired = configModule(ROSTER_NOW);
    await clearCollections();
    office = await buildCoachingOffice(wired);
    const model = mongoose.models[Group.name] ?? mongoose.model(Group.name, GroupSchema);
    const groups = new GroupService(new GroupRepository(model as never), wired.memberships, wired.users as never, wired.audit, wired.clock);
    const coreLeaders = new CoreLeadersService(
      groups, wired.memberships, new MemberNames(wired.memberships, wired.users as never), wired.analyticsTargets,
      wired.analyticsConfig, new TenantDay(wired.kpms as never, wired.clock),
    );

    const moduleRef = await Test.createTestingModule({
      controllers: [OrgController],
      providers: [
        { provide: GroupService, useValue: groups },
        { provide: CoreLeadersService, useValue: coreLeaders },
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
    app.useGlobalGuards(new StubAuth(), new ViewOnlySessionGuard(app.get(Reflector)), new PermissionsGuard(app.get(Reflector)));
    await app.init();
    await listenOnLoopback(app);
  }, 120_000);
  afterAll(async () => {
    await app.close();
    await stopMongo();
  });
  afterEach(async () => {
    await db().collection('groups').deleteMany({});
    await db().collection('analyticsTargets').deleteMany({});
    await db().collection('memberships').updateMany({}, { $set: { groupIds: [], isCoreLeader: false } });
  });

  it('P19.13-T3 AC-1 declares member:read_tags on the read and member:tag_group on the writes', () => {
    expect(declaredPermissions(OrgController)).toMatchObject({
      readCoreLeaders: 'member:read_tags', bulkCoreLeaders: 'member:tag_group', saveCoreLeader: 'member:tag_group',
    });
  });

  it('P19.13-T3 AC-7 a KPM with no groups opens without error: every leader Tanpa group, A to Z, no Agent; tiles at 0', async () => {
    as('OWNER');
    const view = await read();
    expect(view).toMatchObject({
      groups: [], counts: { leaders: 8, core: 0, withGroup: 0, withoutGroup: 8 }, canWrite: true, year: '2026',
    });
    expect(view.leaders.map((l) => l.name)).toEqual([...view.leaders.map((l) => l.name)].sort((a, b) => a.localeCompare(b)));
    expect(new Set(view.leaders.map((l) => l.membershipId))).toEqual(
      new Set(ids('OWNER', 'ADMIN', 'AGUS', 'SARI', 'NINA', 'DEWI', 'PEER_AB', 'PEER_AAB')),
    );
    expect(view.leaders.every((l) => l.groupId === null && !l.isGroupLeader && !l.isCoreLeader)).toBe(true);
  });

  it('P19.13-T3 AC-2 a leader’s targets for the year: their own once set, the template’s 3 and 6 until then', async () => {
    as('OWNER');
    await wired.analyticsTargets.setSubgroup(office.as('OWNER'), office.id.SARI, '2026', 2, 4);
    await wired.analyticsTargets.setSubgroup(office.as('OWNER'), office.id.AGUS, '2025', 9, 9);
    const view = await read();
    expect(view.canEditTargets).toBe(true);
    expect(row(view, 'SARI').targets).toEqual({ aa: 2, rec: 4, isDefault: false });
    // Last year's row is last year's: this year Agus is on the defaults.
    expect(row(view, 'AGUS').targets).toEqual({ aa: 3, rec: 6, isDefault: true });
  });

  describe('AC-1 who reaches it', () => {
    it('P19.13-T3 AC-1 positive: the Admin reads and writes with the Owner’s rights, deleting a group included', async () => {
      as('ADMIN');
      expect((await read()).canWrite).toBe(true);
      const groupId = await makeGroup('ADMIN GROUP');
      await bulk({ membershipIds: ids('AGUS'), groupId }).expect(200);
      await http().delete(`/members/groups/${groupId}`).expect(200);
      expect(row(await read(), 'AGUS').groupId).toBeNull();
    });

    it.each(['AGUS', 'SARI', 'LUKAS', 'INDAH'] as const)(
      'P19.13-T3 AC-1 negative: %s — an AB, an AAB, an Agent who leads, an Agent — is refused 403, read and write',
      async (who) => {
        as(who);
        expect((await http().get('/members/core-leaders').expect(403)).body.error)
          .toMatchObject({ code: 'PERM_DENIED', details: { permission: 'member:read_tags' } });
        const before = await tagged();
        await bulk({ membershipIds: ids('SARI'), isCoreLeader: true }).expect(403);
        await save('SARI', { groupId: null, isGroupLeader: false, isCoreLeader: true }).expect(403);
        expect(await tagged()).toBe(before);
      },
    );

    it('P19.13-T3 AC-1 the Super Admin’s view-as reads the page with canWrite false; every write 403 IMPERSONATION_READ_ONLY', async () => {
      const owner = office.as('OWNER');
      session.current = new RequestContext(owner.userId, 'none', owner.membership, 'u-super', null, false, true);
      const view = await read();
      expect(view).toMatchObject({ canWrite: false, canEditTargets: false });
      expect(view.leaders).toHaveLength(8);
      for (const write of [
        bulk({ membershipIds: ids('SARI'), isCoreLeader: true }),
        save('SARI', { groupId: null, isGroupLeader: false, isCoreLeader: true }),
        http().post('/members/groups').send({ name: 'X' }),
      ]) {
        expect((await write.expect(403)).body.error.code).toBe('IMPERSONATION_READ_ONLY');
      }
    });
  });

  describe('AC-2 one leader’s Simpan', () => {
    it('P19.13-T3 AC-2 sets the group, ★ and Core leader together; appointing another ★ moves the star; audited', async () => {
      as('OWNER');
      const groupId = await makeGroup('CAHYO');
      let view = (await save('AGUS', { groupId, isGroupLeader: true, isCoreLeader: true }).expect(200)).body as CoreLeadersView;
      expect(row(view, 'AGUS')).toMatchObject({ groupId, isGroupLeader: true, isCoreLeader: true });
      expect(view.groups).toEqual([expect.objectContaining({ groupId, headMembershipId: office.id.AGUS, leaders: 1 })]);

      await bulk({ membershipIds: ids('SARI'), groupId }).expect(200);
      view = (await save('SARI', { groupId, isGroupLeader: true, isCoreLeader: false }).expect(200)).body;
      expect(row(view, 'SARI').isGroupLeader).toBe(true);
      expect(row(view, 'AGUS')).toMatchObject({ groupId, isGroupLeader: false, isCoreLeader: true });
      expect(view.groups[0]).toMatchObject({ headMembershipId: office.id.SARI, leaders: 2 });
      expect(await db().collection('auditLog').findOne({ action: 'group.updated', targetId: groupId, 'after.ownerMembershipId': office.id.SARI }))
        .toMatchObject({ before: { ownerMembershipId: office.id.AGUS } });
    });

    it('P19.13-T3 AC-2 a ★ moved to another group or to Tanpa group loses the star; turning it off clears it', async () => {
      as('OWNER');
      const cahyo = await makeGroup('CAHYO');
      const bima = await makeGroup('BIMA');
      await save('AGUS', { groupId: cahyo, isGroupLeader: true, isCoreLeader: false }).expect(200);
      let view = (await save('AGUS', { groupId: bima, isGroupLeader: false, isCoreLeader: false }).expect(200)).body as CoreLeadersView;
      expect(view.groups.find((g) => g.groupId === cahyo)).toMatchObject({ headMembershipId: null, leaders: 0 });
      await save('SARI', { groupId: bima, isGroupLeader: true, isCoreLeader: false }).expect(200);
      view = (await bulk({ membershipIds: ids('SARI'), groupId: null }).expect(200)).body;
      expect(view.groups.find((g) => g.groupId === bima)).toMatchObject({ headMembershipId: null, leaders: 1 });
      await save('AGUS', { groupId: bima, isGroupLeader: true, isCoreLeader: false }).expect(200);
      view = (await save('AGUS', { groupId: bima, isGroupLeader: false, isCoreLeader: false }).expect(200)).body;
      expect(view.groups.find((g) => g.groupId === bima)!.headMembershipId).toBeNull();
    });

    it('P19.13-T3 AC-2 refuses ★ without a group (400 ORG_GROUP_LEADER_NEEDS_GROUP), an Agent or a leaver (404), and writes nothing', async () => {
      as('OWNER');
      const before = await tagged();
      expect((await save('AGUS', { groupId: null, isGroupLeader: true, isCoreLeader: false }).expect(400)).body.error.code)
        .toBe('ORG_GROUP_LEADER_NEEDS_GROUP');
      for (const who of ['INDAH', 'LEFT'] as const) {
        expect((await save(who, { groupId: null, isGroupLeader: false, isCoreLeader: true }).expect(404)).body.error.code).toBe('NOT_FOUND');
      }
      expect((await save('not-an-id', { groupId: null, isGroupLeader: false, isCoreLeader: true }).expect(404)).body.error.code).toBe('NOT_FOUND');
      expect(await tagged()).toBe(before);
    });

    it.each([
      ['no body', {}],
      ['a group that is no id', { groupId: 'x', isGroupLeader: false, isCoreLeader: false }],
      ['a flag that is no boolean', { groupId: null, isGroupLeader: 'yes', isCoreLeader: false }],
    ])('P19.13-T3 AC-2 %s is 400 VALIDATION_FAILED', async (_, body) => {
      as('OWNER');
      expect((await save('AGUS', body).expect(400)).body.error.code).toBe('VALIDATION_FAILED');
    });
  });

  describe('AC-3 ★ Core in one tap', () => {
    it('P19.13-T3 AC-3 PUT /members/:id/core-leader toggles it, it survives a reload, and the counts follow', async () => {
      as('OWNER');
      await http().put(`/members/${office.id.NINA}/core-leader`).send({ isCoreLeader: true }).expect(200);
      let view = await read();
      expect([row(view, 'NINA').isCoreLeader, view.counts.core]).toEqual([true, 1]);
      await http().put(`/members/${office.id.NINA}/core-leader`).send({ isCoreLeader: false }).expect(200);
      view = await read();
      expect([row(view, 'NINA').isCoreLeader, view.counts.core]).toEqual([false, 0]);
    });
  });

  describe('AC-4 a group added, renamed, given leaders, deleted', () => {
    it('P19.13-T3 AC-4 made with no ★; renamed, its members follow; deleted, they are Tanpa group and keep Core leader', async () => {
      as('OWNER');
      const groupId = await makeGroup('DAMAR');
      expect((await read()).groups).toEqual([{ groupId, name: 'DAMAR', headMembershipId: null, headName: null, leaders: 0 }]);
      await bulk({ membershipIds: ids('DEWI', 'NINA'), groupId, isCoreLeader: true }).expect(200);
      await http().put(`/members/groups/${groupId}`).send({ name: 'DAMAR BARU', ownerMembershipId: office.id.DEWI }).expect(200);
      let view = await read();
      expect(view.groups).toEqual([expect.objectContaining({ name: 'DAMAR BARU', headMembershipId: office.id.DEWI, leaders: 2 })]);
      expect(row(view, 'NINA').groupId).toBe(groupId);

      await http().delete(`/members/groups/${groupId}`).expect(200);
      view = await read();
      expect(view.groups).toEqual([]);
      expect([row(view, 'DEWI'), row(view, 'NINA')].map((l) => [l.groupId, l.isGroupLeader, l.isCoreLeader]))
        .toEqual([[null, false, true], [null, false, true]]);
      expect(view.counts).toMatchObject({ core: 2, withGroup: 0, withoutGroup: 8 });
    });

    it('P19.13-T3 AC-4 a second live group of one name is 409; another office may use it', async () => {
      as('OWNER');
      await makeGroup('ARDIAN');
      expect((await http().post('/members/groups').send({ name: 'ARDIAN' }).expect(409)).body.error.code).toBe('ORG_GROUP_NAME_TAKEN');
      as('B_AB');
      session.current = new RequestContext(session.current.userId, 'none', { ...session.current.membership!, isKpmOwner: true });
      await http().post('/members/groups').send({ name: 'ARDIAN' }).expect(201);
    });

    it('P19.13-T3 AC-4 + Tambah ke grup moves a leader: their former group, and its ★, are left; an Agent is added', async () => {
      as('OWNER');
      const first = await makeGroup('FIRST');
      const second = await makeGroup('SECOND');
      await save('PEER_AB', { groupId: first, isGroupLeader: true, isCoreLeader: false }).expect(200);
      await http().post(`/members/groups/${first}/members`).send({ membershipIds: ids('INDAH') }).expect(201);
      await http().post(`/members/groups/${second}/members`).send({ membershipIds: ids('PEER_AB', 'INDAH') }).expect(201);
      const view = await read();
      expect(row(view, 'PEER_AB').groupId).toBe(second);
      expect(view.groups.find((g) => g.groupId === first)).toMatchObject({ headMembershipId: null, leaders: 0 });
      const indah = await db().collection('memberships').findOne({ _id: new mongoose.Types.ObjectId(office.id.INDAH) });
      expect(indah!.groupIds).toEqual([first, second]);
    });
  });

  describe('AC-5 Pilih → Atur group · ★ Jadikan core', () => {
    it('P19.13-T3 AC-5 changes every ticked leader in one request, one audit entry each', async () => {
      as('OWNER');
      const groupId = await makeGroup('BIMA');
      const before = await tagged();
      const view = (await bulk({ membershipIds: ids('SARI', 'NINA', 'DEWI'), groupId }).expect(200)).body as CoreLeadersView;
      expect(view.groups[0].leaders).toBe(3);
      expect(await tagged()).toBe(before + 3);
      const core = (await bulk({ membershipIds: ids('SARI', 'NINA', 'DEWI', 'AGUS'), isCoreLeader: true }).expect(200)).body as CoreLeadersView;
      expect(core.counts.core).toBe(4);
      // Tagged already: the same again writes nothing.
      const again = await tagged();
      await bulk({ membershipIds: ids('SARI', 'NINA'), isCoreLeader: true }).expect(200);
      expect(await tagged()).toBe(again);
    });

    it('P19.13-T3 AC-5 one id that is no leader of this office — an Agent, a leaver, another office’s — is 404, and nothing is written', async () => {
      as('OWNER');
      const groupId = await makeGroup('BIMA');
      const before = await tagged();
      for (const outsider of ids('INDAH', 'LEFT', 'B_AB')) {
        expect((await bulk({ membershipIds: [office.id.SARI, outsider], groupId }).expect(404)).body.error.code).toBe('NOT_FOUND');
      }
      expect(row(await read(), 'SARI').groupId).toBeNull();
      expect(await tagged()).toBe(before);
    });

    it.each([
      ['nobody', { membershipIds: [], isCoreLeader: true }],
      ['neither a group nor the tag', { membershipIds: ['66f000000000000000000001'] }],
      ['a group that is no id', { membershipIds: ['66f000000000000000000001'], groupId: 'x' }],
      ['more than one request takes', { membershipIds: Array.from({ length: CORE_LEADERS.MAX_PER_BULK + 1 }, (_, i) => `id${i}`), isCoreLeader: true }],
    ])('P19.13-T3 AC-5 %s is 400 VALIDATION_FAILED', async (_, body) => {
      as('OWNER');
      expect((await bulk(body).expect(400)).body.error.code).toBe('VALIDATION_FAILED');
    });
  });

  describe('AC-9 KPM A and KPM B', () => {
    it('P19.13-T3 AC-9 KPM B reads its own leaders and groups only, and cannot read or change KPM A’s', async () => {
      as('OWNER');
      const theirs = await makeGroup('A ONLY');
      await bulk({ membershipIds: ids('AGUS'), groupId: theirs, isCoreLeader: true }).expect(200);

      session.current = new RequestContext(office.as('B_AB').userId, 'none', { ...office.as('B_AB').membership!, isKpmOwner: true });
      const view = await read();
      expect(view.leaders.map((l) => l.membershipId)).toEqual([office.id.B_AB]);
      expect(view.groups).toEqual([]);
      const before = await tagged();
      expect((await bulk({ membershipIds: ids('AGUS'), groupId: null }).expect(404)).body.error.code).toBe('NOT_FOUND');
      await save('AGUS', { groupId: null, isGroupLeader: false, isCoreLeader: false }).expect(404);
      await bulk({ membershipIds: ids('B_AB'), groupId: theirs }).expect(404);
      await save('B_AB', { groupId: theirs, isGroupLeader: true, isCoreLeader: false }).expect(404);
      await http().put(`/members/groups/${theirs}`).send({ name: 'TAKEN' }).expect(404);
      await http().delete(`/members/groups/${theirs}`).expect(404);
      expect(await tagged()).toBe(before);

      as('OWNER');
      expect(row(await read(), 'AGUS')).toMatchObject({ groupId: theirs, isCoreLeader: true });
    });
  });
});
