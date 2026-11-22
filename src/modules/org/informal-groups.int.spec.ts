import { INestApplication } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { Test } from '@nestjs/testing';
import mongoose from 'mongoose';
import request from 'supertest';
import { PermissionsGuard } from '@/common/auth/permissions.guard';
import { RequestContext } from '@/common/context/request-context';
import { DomainExceptionFilter } from '@/common/errors/error.filter';
import { INFORMAL_GROUPS } from '@/domain/constants';
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
 * **Informal groups over HTTP** (P19.17-T4; ADR-0270): every group route with the real `PermissionsGuard`, the production
 * pipe and the real `GroupService` over the coaching office. The KPM's stewards — the Owner, an Admin, a core leader —
 * write; an AB, an AAB or an agent who is none is refused by the guard, and the server, not the screen, says so.
 *
 * ```
 * OWNER Wilson (AB) ─┬─ ADMIN Maya (AB)
 *                    ├─ AGUS (AB) ── SARI (AAB) …, INDAH, DIMAS, LUKAS (agents) …
 *                    └─ PEER_AB ── PEER_AAB ── PEER_AGENT
 * Office B: B_AB ── B_AGENT
 * ```
 */
describe('informal groups over HTTP (P19.17-T4)', () => {
  let app: INestApplication;
  let wired: ReturnType<typeof configModule>;
  let office: CoachingOffice;
  const db = () => mongoose.connection.db!;
  const http = () => request(app.getHttpServer());
  const as = (who: Who) => { session.current = office.as(who); };
  /** `who`, with a flag on top: tagged core leader (ADR-0268 §1), or office B's Owner. */
  const asWith = (who: Who, flags: Record<string, boolean>) => {
    const plain = office.as(who);
    session.current = new RequestContext(plain.userId, 'none', { ...plain.membership!, ...flags } as never);
  };
  const asCore = (who: Who) => asWith(who, { isCoreLeader: true });
  const group = async (name: string, over: Record<string, unknown> = {}, kpmId = KPM_A) => {
    const _id = new mongoose.Types.ObjectId();
    await db().collection('groups').insertOne({
      _id, kpmId, name, leaderMembershipIds: [], status: 'active', archivedAt: null, createdByMembershipId: null,
      deletedAt: null, ...over,
    });
    return String(_id);
  };
  const tag = (who: Who, groupId: string) => db().collection('memberships')
    .updateOne({ _id: new mongoose.Types.ObjectId(office.id[who]) }, { $set: { groupIds: [groupId] } });
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
    await db().collection('memberships').updateMany({}, { $set: { groupIds: [], isCoreLeader: false } });
  });

  it('P19.17-T4 AC-2 declares each route’s permission', () => {
    expect(declaredPermissions(OrgController)).toMatchObject({
      listGroups: 'member:read_tags',
      createGroup: 'group_informal:create',
      updateGroup: 'group_informal:update',
      archiveGroup: 'group_informal:archive',
      appointGroupLeader: 'group_informal:update',
      removeGroupLeader: 'group_informal:update',
      addGroupMembers: 'member:tag_group',
      setAbGroup: 'member:tag_group',
      readTags: 'member:tag_group',
      tagMember: 'member:tag_group',
      setCoreLeader: 'member:tag_core_leader',
    });
  });

  describe('GET /members/groups', () => {
    it('P19.17-T4 AC-2 positive: the Owner reads each group with its ABs, leaders and counts, the teams following', async () => {
      const circle = await group('Agus Circle', { leaderMembershipIds: [office.id.AGUS] });
      await tag('AGUS', circle);
      as('OWNER');
      const res = await http().get('/members/groups').expect(200);
      expect(res.body.groups).toEqual([{
        groupId: circle, name: 'Agus Circle', leaders: [{ membershipId: office.id.AGUS, name: office.name.AGUS }],
        // Agus, Indah, Dimas, Sari, Rina, Budi, Nina, Dodi, Dewi, Lukas, Tari: Agus's AB group. Sari, Nina and Dewi are AABs.
        abs: [expect.objectContaining({ membershipId: office.id.AGUS, isGroupLeader: true, people: 11, leaders: 4 })],
        counts: { leaders: 4, people: 11, abGroups: 1 },
      }]);
      expect(res.body.ungrouped.abs.map((a: { membershipId: string }) => a.membershipId).sort())
        .toEqual([office.id.OWNER, office.id.ADMIN, office.id.PEER_AB].sort());
      expect(res.body.canWrite).toBe(true);
    });

    it('P19.17-T4 DATA-DEFINITIONS a test account is never counted in a group\u2019s people (ADR-0267 §1)', async () => {
      const circle = await group('Agus Circle');
      await tag('AGUS', circle);
      const indah = { _id: new mongoose.Types.ObjectId(office.id.INDAH) };
      await db().collection('memberships').updateOne(indah, { $set: { testAccount: true } });
      try {
        as('OWNER');
        const res = await http().get('/members/groups').expect(200);
        expect(res.body.groups[0].counts).toEqual({ leaders: 4, people: 10, abGroups: 1 });
      } finally {
        await db().collection('memberships').updateOne(indah, { $set: { testAccount: false } });
      }
    });

    it.each(['AGUS', 'SARI', 'INDAH'] as const)('P19.17-T4 AC-2 negative: %s — no steward — is refused 403', async (who) => {
      as(who);
      expect((await http().get('/members/groups').expect(403)).body.error).toMatchObject({ code: 'PERM_DENIED' });
    });

    it('P19.17-T4 cross-tenant: office B reads none of office A’s groups', async () => {
      await group('Agus Circle');
      asWith('B_AB', { isKpmOwner: true });
      expect((await http().get('/members/groups').expect(200)).body.groups).toEqual([]);
    });
  });

  describe('POST, PUT, DELETE /members/groups', () => {
    it('P19.17-T4 AC-2 positive: Group baru (a name only, the AB’s picker moving them), Ubah nama, Hapus group', async () => {
      as('OWNER');
      const made = await http().post('/members/groups').send({ name: 'Rising Stars', abMembershipId: office.id.PEER_AB }).expect(201);
      const id = made.body.groupId;
      expect(made.body.view.groups[0]).toMatchObject({
        groupId: id, name: 'Rising Stars', leaders: [], abs: [{ membershipId: office.id.PEER_AB, people: 3 }],
      });
      expect(await tagsOf('PEER_AB')).toEqual([id]);
      as('ADMIN');
      expect((await http().put(`/members/groups/${id}`).send({ name: 'Rising Stars 2027' }).expect(200)).body.groups[0].name)
        .toBe('Rising Stars 2027');
      asCore('AGUS');
      expect((await http().delete(`/members/groups/${id}`).expect(200)).body.groups).toEqual([]);
      expect(await tagsOf('PEER_AB')).toEqual([]);
    });

    it.each([
      ['no name', {}],
      ['a blank name', { name: '   ' }],
      ['a name too long', { name: 'x'.repeat(INFORMAL_GROUPS.NAME_MAX + 1) }],
      ['an AB id that is no id', { name: 'X', abMembershipId: 'nope' }],
      ['a field the API does not take', { name: 'X', ownerMembershipId: null }],
    ])('P19.17-T4 Group baru with %s is 400 VALIDATION_FAILED', async (_, body) => {
      as('OWNER');
      expect((await http().post('/members/groups').send(body).expect(400)).body.error.code).toBe('VALIDATION_FAILED');
    });

    it('P19.17-T4 AC-1 Group baru from an agent’s picker is 422 ORG_GROUP_AB_ONLY; a name taken 409', async () => {
      as('OWNER');
      expect((await http().post('/members/groups').send({ name: 'X', abMembershipId: office.id.INDAH }).expect(422)).body.error.code)
        .toBe('ORG_GROUP_AB_ONLY');
      await group('Taken');
      expect((await http().post('/members/groups').send({ name: 'Taken' }).expect(409)).body.error.code).toBe('ORG_GROUP_NAME_TAKEN');
    });

    it.each(['AGUS', 'SARI', 'LUKAS', 'INDAH'] as const)('P19.17-T4 AC-2 negative: %s, no steward, writes no group (403)', async (who) => {
      const id = await group('Circle');
      as(who);
      await http().post('/members/groups').send({ name: 'Mine' }).expect(403);
      await http().put(`/members/groups/${id}`).send({ name: 'Mine' }).expect(403);
      await http().delete(`/members/groups/${id}`).expect(403);
      expect(await db().collection('groups').countDocuments()).toBe(1);
    });

    it('P19.17-T4 cross-tenant: another office’s group is 404 to rename or delete', async () => {
      const theirs = await group('B Circle', {}, KPM_B);
      as('OWNER');
      await http().put(`/members/groups/${theirs}`).send({ name: 'Mine' }).expect(404);
      await http().delete(`/members/groups/${theirs}`).expect(404);
      expect(await db().collection('groups').findOne({ name: 'B Circle' })).toMatchObject({ status: 'active' });
    });
  });

  describe('PUT /members/:membershipId/group', () => {
    it('P19.17-T4 AC-2 positive: an Admin and a core leader move an AB, the team following; null is Tanpa group', async () => {
      const circle = await group('Circle');
      as('ADMIN');
      const res = await http().put(`/members/${office.id.AGUS}/group`).send({ groupId: circle }).expect(200);
      expect(res.body.groups[0].counts).toEqual({ leaders: 4, people: 11, abGroups: 1 });
      asCore('PEER_AB');
      await http().put(`/members/${office.id.AGUS}/group`).send({ groupId: null }).expect(200);
      expect(await tagsOf('AGUS')).toEqual([]);
    });

    it('P19.17-T4 AC-1 an AAB or an agent is 422 ORG_GROUP_AB_ONLY; a malformed or missing group id 400', async () => {
      const circle = await group('Circle');
      as('OWNER');
      for (const who of ['SARI', 'INDAH'] as const) {
        expect((await http().put(`/members/${office.id[who]}/group`).send({ groupId: circle }).expect(422)).body.error.code)
          .toBe('ORG_GROUP_AB_ONLY');
      }
      await http().put(`/members/${office.id.AGUS}/group`).send({ groupId: 'nope' }).expect(400);
      await http().put(`/members/${office.id.AGUS}/group`).send({}).expect(400);
    });

    it.each(['AGUS', 'SARI', 'INDAH'] as const)('P19.17-T4 AC-2 negative: %s, no steward, is refused 403', async (who) => {
      as(who);
      await http().put(`/members/${office.id.PEER_AB}/group`).send({ groupId: null }).expect(403);
    });

    it('P19.17-T4 cross-tenant: another office’s AB, or group, is 404 and nothing moves', async () => {
      const theirs = await group('B Circle', {}, KPM_B);
      as('OWNER');
      await http().put(`/members/${office.id.B_AB}/group`).send({ groupId: null }).expect(404);
      await http().put(`/members/${office.id.AGUS}/group`).send({ groupId: theirs }).expect(404);
      expect(await tagsOf('AGUS')).toEqual([]);
    });
  });

  describe('PUT, DELETE /members/groups/:groupId/leaders/:membershipId', () => {
    it('P19.17-T4 AC-2 positive: several Group Leaders, each an AB of the group; removing keeps them in it', async () => {
      const circle = await group('Circle');
      await tag('AGUS', circle);
      await tag('PEER_AB', circle);
      as('OWNER');
      await http().put(`/members/groups/${circle}/leaders/${office.id.AGUS}`).expect(200);
      asCore('ADMIN');
      const res = await http().put(`/members/groups/${circle}/leaders/${office.id.PEER_AB}`).expect(200);
      expect(res.body.groups[0].leaders.map((l: { membershipId: string }) => l.membershipId).sort())
        .toEqual([office.id.AGUS, office.id.PEER_AB].sort());
      const left = await http().delete(`/members/groups/${circle}/leaders/${office.id.AGUS}`).expect(200);
      expect(left.body.groups[0].leaders).toEqual([{ membershipId: office.id.PEER_AB, name: office.name.PEER_AB }]);
      expect(await tagsOf('AGUS')).toEqual([circle]);
    });

    it('P19.17-T4 AC-1 an AB outside the group is 422 ORG_GROUP_LEADER_NOT_IN_GROUP; an AAB 422 ORG_GROUP_AB_ONLY', async () => {
      const circle = await group('Circle');
      as('OWNER');
      expect((await http().put(`/members/groups/${circle}/leaders/${office.id.AGUS}`).expect(422)).body.error.code)
        .toBe('ORG_GROUP_LEADER_NOT_IN_GROUP');
      expect((await http().put(`/members/groups/${circle}/leaders/${office.id.SARI}`).expect(422)).body.error.code)
        .toBe('ORG_GROUP_AB_ONLY');
    });

    it.each(['AGUS', 'SARI', 'INDAH'] as const)('P19.17-T4 AC-2 negative: %s, no steward, is refused 403', async (who) => {
      const circle = await group('Circle');
      as(who);
      await http().put(`/members/groups/${circle}/leaders/${office.id.AGUS}`).expect(403);
      await http().delete(`/members/groups/${circle}/leaders/${office.id.AGUS}`).expect(403);
    });

    it('P19.17-T4 cross-tenant: another office’s group is 404', async () => {
      const theirs = await group('B Circle', { leaderMembershipIds: [office.id.B_AB] }, KPM_B);
      as('OWNER');
      await http().put(`/members/groups/${theirs}/leaders/${office.id.AGUS}`).expect(404);
      await http().delete(`/members/groups/${theirs}/leaders/${office.id.B_AB}`).expect(404);
      expect(await db().collection('groups').findOne({ name: 'B Circle' })).toMatchObject({ leaderMembershipIds: [office.id.B_AB] });
    });
  });

  describe('POST /members/groups/:groupId/members — + Tambah ke grup', () => {
    it('P19.17-T4 AC-2 positive: the Owner moves the ABs into a group at once, each with their team, one audit entry each', async () => {
      const circle = await group('Agus Circle');
      const before = await tagged();
      as('OWNER');
      const res = await http().post(`/members/groups/${circle}/members`)
        .send({ membershipIds: [office.id.PEER_AB, office.id.ADMIN] }).expect(201);
      // Hendra's AB group is three people; Maya leads nobody.
      expect(res.body).toEqual({ groupId: circle, name: 'Agus Circle', added: 2, memberCount: 4 });
      expect(await tagsOf('PEER_AB')).toEqual([circle]);
      expect(await tagged()).toBe(before + 2);
      expect((await http().post(`/members/groups/${circle}/members`).send({ membershipIds: [office.id.PEER_AB] }).expect(201)).body.added)
        .toBe(0);
    });

    it('P19.17-T4 AC-1 an AAB or an agent among them is 422 ORG_GROUP_AB_ONLY, and nobody moves', async () => {
      const circle = await group('Circle');
      as('OWNER');
      await http().post(`/members/groups/${circle}/members`).send({ membershipIds: [office.id.PEER_AB, office.id.SARI] }).expect(422);
      expect(await tagsOf('PEER_AB')).toEqual([]);
    });

    it.each(['AGUS', 'SARI', 'LUKAS', 'INDAH'] as const)('P19.17-T4 AC-2 negative: %s is refused 403, nothing tagged', async (who) => {
      const circle = await group('Circle');
      as(who);
      const res = await http().post(`/members/groups/${circle}/members`).send({ membershipIds: [office.id.PEER_AB] }).expect(403);
      expect(res.body.error).toMatchObject({ code: 'PERM_DENIED', details: { permission: 'member:tag_group' } });
      expect(await tagsOf('PEER_AB')).toEqual([]);
    });

    it('P19.17-T4 cross-tenant: another office’s group, or member, or one who left, is 404 — and nobody moves', async () => {
      const theirs = await group('B Circle', {}, KPM_B);
      const circle = await group('Circle');
      as('OWNER');
      await http().post(`/members/groups/${theirs}/members`).send({ membershipIds: [office.id.PEER_AB] }).expect(404);
      for (const outsider of [office.id.B_AB, office.id.LEFT, 'not-an-id']) {
        await http().post(`/members/groups/${circle}/members`).send({ membershipIds: [office.id.PEER_AB, outsider] }).expect(404);
      }
      expect(await tagsOf('PEER_AB')).toEqual([]);
    });

    it.each([
      ['nobody', []],
      ['not a list', 'x'],
      ['an id that is not text', [42]],
      ['more than one add takes', Array.from({ length: INFORMAL_GROUPS.MAX_PER_ADD + 1 }, (_, i) => `id${i}`)],
    ])('%s is 400 VALIDATION_FAILED', async (_, ids) => {
      const circle = await group('Circle');
      as('OWNER');
      expect((await http().post(`/members/groups/${circle}/members`).send({ membershipIds: ids }).expect(400)).body.error.code)
        .toBe('VALIDATION_FAILED');
    });
  });

  describe('the member page’s tags, and the Core Leader tag', () => {
    it('P19.17-T4 AC-5 the Owner tags a leader core leader; a core leader may not (403); an agent is 400', async () => {
      as('OWNER');
      expect((await http().put(`/members/${office.id.AGUS}/core-leader`).send({ isCoreLeader: true }).expect(200)).body.isCoreLeader)
        .toBe(true);
      expect((await http().put(`/members/${office.id.INDAH}/core-leader`).send({ isCoreLeader: true }).expect(400)).body.error.code)
        .toBe('CORE_LEADER_NOT_A_LEADER');
      asCore('PEER_AB');
      await http().put(`/members/${office.id.AGUS}/core-leader`).send({ isCoreLeader: false }).expect(403);
    });

    it('P19.17-T4 AC-1 reads an agent’s group from their AB, and refuses a group on them (422); another office 404', async () => {
      const circle = await group('Circle');
      await tag('AGUS', circle);
      as('OWNER');
      expect((await http().get(`/members/${office.id.TARI}/tags`).expect(200)).body).toMatchObject({
        groupIds: [], canCarryGroup: false, group: { groupId: circle, name: 'Circle' }, ab: { membershipId: office.id.AGUS },
      });
      await http().put(`/members/${office.id.TARI}/tags`).send({ groupIds: [circle], isCoreLeader: false }).expect(422);
      asWith('B_AB', { isKpmOwner: true });
      await http().get(`/members/${office.id.TARI}/tags`).expect(404);
    });
  });

  /*
   * **The Super Admin, inside a KPM and in none, and a support session** (ADR-0268 §3, ADR-0206; the permission review of
   * 20 November 2026): inside KPM A the Super Admin is its Owner — the groups read and written, the audit row naming them;
   * in no KPM there are no groups to reach; *Lihat sebagai* the Owner reads them and writes none.
   */
  describe('ADR-0268 §3 the Super Admin and a support session', () => {
    it('ADR-0268 §3 the Super Admin inside KPM A reads and writes the groups, audited as themselves; in no KPM, refused', async () => {
      session.current = RequestContext.superAdminInKpm(RequestContext.platform('u-root'), KPM_A);
      await http().get('/members/groups').expect(200);
      const made = await http().post('/members/groups').send({ name: 'Platform Circle', abMembershipId: office.id.PEER_AB }).expect(201);
      expect(await tagsOf('PEER_AB')).toEqual([made.body.groupId]);
      const audit = await db().collection('auditLog').findOne({ action: 'group.created', targetId: made.body.groupId });
      expect(audit).toMatchObject({ kpmId: KPM_A, actorUserId: 'u-root', actorMembershipId: null });

      session.current = RequestContext.platform('u-root');
      expect((await http().get('/members/groups')).status).toBe(403);
      expect((await http().post('/members/groups').send({ name: 'Nowhere', abMembershipId: office.id.AGUS })).status).toBe(403);
      expect(await db().collection('groups').countDocuments({ name: 'Nowhere' })).toBe(0);
    });

    it('ADR-0206 a support session as the Owner reads the groups and writes none', async () => {
      const owner = office.as('OWNER');
      session.current = new RequestContext(owner.userId, 'none', owner.membership, 'u-super', null, false, true);
      await http().get('/members/groups').expect(200);
      expect((await http().post('/members/groups').send({ name: 'Looked at', abMembershipId: office.id.AGUS })).status).toBe(403);
      expect((await http().put(`/members/${office.id.AGUS}/group`).send({ groupId: null })).status).toBe(403);
      expect(await db().collection('groups').countDocuments({})).toBe(0);
    });
  });
});
