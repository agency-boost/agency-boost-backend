import { INestApplication } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { Test } from '@nestjs/testing';
import mongoose from 'mongoose';
import request from 'supertest';
import { PermissionsGuard } from '@/common/auth/permissions.guard';
import { RequestContext } from '@/common/context/request-context';
import { DomainExceptionFilter } from '@/common/errors/error.filter';
import { AB_GROUP_TARGETS } from '@/domain/constants';
import { clearCollections, startMongo, stopMongo, syncIndexes } from '../../../../test/mongo';
import { configModule } from '../../../../test/config-module';
import { declaredPermissions, productionPipe, session, StubAuth } from '../../../../test/http-permissions';
import { listenOnLoopback } from '../../../../test/listen';
import {
  buildCoachingOffice, KPM_A, KPM_B, ROSTER_NOW, type CoachingOffice, type Who,
} from '../../../../test/coaching-office';
import { AbGroupTargetsController } from './ab-group-targets.controller';
import { AbGroupTargetsService } from './ab-group-targets.service';

/** Rp 1 M in sen. */
const M = 1_000_000 * 100;

/**
 * **Monthly targets per AB group over HTTP** (P19.17-T4; ADR-0270 §4–§6): `GET` and `PUT /kpm/ab-group-targets` with the
 * real `PermissionsGuard`, the production pipe and the real service over the coaching office — its month September 2026.
 * The KPM's stewards read and write; an AB, an AAB or an agent who is none is refused by the guard; KPM B reads and writes
 * none of KPM A's.
 *
 * Agus's AB group is eleven people — himself, Sari, Nina and Dewi (AABs), seven agents — and Indah, Dimas and Rina each
 * hold a Rp 500 M Goal Setting for 2026: an APE target of Rp 125 M a month.
 */
describe('monthly targets per AB group over HTTP (P19.17-T4)', () => {
  let app: INestApplication;
  let wired: ReturnType<typeof configModule>;
  let office: CoachingOffice;
  const db = () => mongoose.connection.db!;
  const http = () => request(app.getHttpServer());
  const as = (who: Who) => { session.current = office.as(who); };
  const asWith = (who: Who, flags: Record<string, boolean>) => {
    const plain = office.as(who);
    session.current = new RequestContext(plain.userId, 'none', { ...plain.membership!, ...flags } as never);
  };
  const put = (ab: string, body: Record<string, unknown>) => http().put(`/kpm/ab-group-targets/${ab}`).send(body);
  const rows = () => db().collection('abGroupTargets').find({}).toArray();

  beforeAll(async () => {
    await startMongo();
    wired = configModule(ROSTER_NOW);
    await clearCollections();
    office = await buildCoachingOffice(wired);
    await syncIndexes();
    const moduleRef = await Test.createTestingModule({
      controllers: [AbGroupTargetsController],
      providers: [{ provide: AbGroupTargetsService, useValue: wired.abGroupTargets }],
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
    await db().collection('abGroupTargets').deleteMany({});
    await db().collection('groups').deleteMany({});
    await db().collection('memberships').updateMany({}, { $set: { groupIds: [] } });
  });

  it('P19.17-T4 AC-3 declares ab_group_target:read and :write', () => {
    expect(declaredPermissions(AbGroupTargetsController)).toEqual({ read: 'ab_group_target:read', set: 'ab_group_target:write' });
  });

  describe('GET /kpm/ab-group-targets', () => {
    it('P19.17-T4 AC-3 positive: the office’s month, every AB group under its informal group, the totals the sums', async () => {
      const { insertedId } = await db().collection('groups').insertOne({
        kpmId: KPM_A, name: 'Circle', leaderMembershipIds: [office.id.AGUS], status: 'active', archivedAt: null, deletedAt: null,
      });
      await db().collection('memberships').updateOne({ _id: new mongoose.Types.ObjectId(office.id.AGUS) }, { $set: { groupIds: [String(insertedId)] } });
      as('OWNER');
      await put(office.id.AGUS, { month: '2026-07', activeAgentTarget: 6, rekrutTarget: 3 }).expect(200);
      const view = (await http().get('/kpm/ab-group-targets').expect(200)).body;
      expect(view).toMatchObject({
        month: '2026-09', currentMonth: '2026-09', earliestMonth: '2024-01', latestMonth: '2027-09', max: AB_GROUP_TARGETS.MAX,
        currency: 'IDR', canWrite: true,
      });
      expect(view.groups.map((g: { group: { name: string } | null }) => g.group?.name ?? null)).toEqual(['Circle', null]);
      expect(view.groups[0]).toMatchObject({
        leaders: [{ membershipId: office.id.AGUS, name: office.name.AGUS }],
        totals: { activeAgentTarget: 6, rekrutTarget: 3, rekrutYtdTarget: 9, apeTargetMinor: 125 * M, unset: 0, abGroups: 1, people: 11 },
        abGroups: [{
          abMembershipId: office.id.AGUS, isGroupLeader: true, people: 11, activeAgentTarget: 6, rekrutTarget: 3,
          // July carries into August and September.
          source: 'carried', fromMonth: '2026-07', rekrutYtdTarget: 9, apeTargetMinor: 125 * M, goalsSet: 3,
        }],
      });
      // Tanpa group: Wilson, Maya, Hendra — none with a target.
      expect(view.groups[1].totals).toMatchObject({ activeAgentTarget: 0, rekrutTarget: 0, unset: 3, abGroups: 3 });
      expect(view.groups[1].abGroups.every((r: { source: string; activeAgentTarget: null }) => r.source === 'none' && r.activeAgentTarget === null)).toBe(true);
      expect(view.total).toMatchObject({ activeAgentTarget: 6, rekrutTarget: 3, unset: 3, abGroups: 4, apeTargetMinor: 125 * M, unplacedPeople: 0 });
      // A month before the target was set reads none.
      const june = (await http().get('/kpm/ab-group-targets?month=2026-06').expect(200)).body;
      expect(june.total).toMatchObject({ activeAgentTarget: 0, unset: 4 });
    });

    it('P19.17-T4 AC-3 every active member is counted somewhere: an AB whose account is gone, a namesake AB, somebody under no AB', async () => {
      const oid = (id: string) => new mongoose.Types.ObjectId(id);
      const [maya, hendra] = await Promise.all([
        db().collection('memberships').findOne({ _id: oid(office.id.ADMIN) }), db().collection('memberships').findOne({ _id: oid(office.id.PEER_AB) }),
      ]);
      // Maya's account is gone (her name with it) and she leads the group; Hendra takes Wilson's name; a new agent hangs
      // from nobody — under no AB — with a saved Rp 500 M plan of their own (Indah's, copied).
      const { insertedId: groupId } = await db().collection('groups').insertOne({
        kpmId: KPM_A, name: 'Circle', leaderMembershipIds: [office.id.ADMIN], status: 'active', archivedAt: null, deletedAt: null,
      });
      await db().collection('memberships').updateOne({ _id: maya!._id }, { $set: { userId: '66f00000000000000000ffff', groupIds: [String(groupId)] } });
      await db().collection('users').updateOne({ _id: oid(hendra!.userId as string) }, { $set: { fullName: 'Wilson Tanoto' } });
      const loose = new mongoose.Types.ObjectId();
      const planless = new mongoose.Types.ObjectId();
      const looseAgent = (_id: mongoose.Types.ObjectId, code: string) => ({
        _id, kpmId: KPM_A, userId: String(new mongoose.Types.ObjectId()), agentCode: code, agentSeq: 990, leaderCode: code,
        orgLevelId: 'x', orgLevelCode: 'AGENT', role: 'agent', leaderId: null, ancestorIds: [], depth: 0, status: 'active',
        testAccount: false, deletedAt: null, groupIds: [],
      });
      // A second loose agent with no plan at all adds nothing to it.
      await db().collection('memberships').insertMany([looseAgent(loose, 'LOOSE'), looseAgent(planless, 'PLANLESS')]);
      const goal = await db().collection('goals').findOne({ membershipId: office.id.INDAH });
      const { insertedId: goalId } = await db().collection('goals').insertOne({ ...goal, _id: new mongoose.Types.ObjectId(), membershipId: String(loose) });
      try {
        as('OWNER');
        const view = (await http().get('/kpm/ab-group-targets').expect(200)).body;
        expect(view.groups[0]).toMatchObject({ group: { name: 'Circle' }, leaders: [{ membershipId: office.id.ADMIN, name: '' }] });
        expect(view.groups[0].abGroups[0]).toMatchObject({ abMembershipId: office.id.ADMIN, name: '', isGroupLeader: true });
        // Tanpa group: two Wilson Tanotos, in one order whatever the read's — by membership id.
        const namesakes = view.groups[1].abGroups.filter((r: { name: string }) => r.name === 'Wilson Tanoto').map((r: { abMembershipId: string }) => r.abMembershipId);
        expect(namesakes).toEqual([office.id.OWNER, office.id.PEER_AB].sort());
        // The loose agent is in no AB group, and their plan still reaches the KPM's APE target: a twelfth of Rp 500 M more.
        expect(view.total.unplacedPeople).toBe(2);
        expect(view.total.apeTargetMinor).toBe(125 * M + Math.round((500 * M) / 12));
      } finally {
        await db().collection('goals').deleteOne({ _id: goalId });
        await db().collection('memberships').deleteMany({ _id: { $in: [loose, planless] } });
        await db().collection('memberships').updateOne({ _id: maya!._id }, { $set: { userId: maya!.userId } });
        await db().collection('users').updateOne({ _id: oid(hendra!.userId as string) }, { $set: { fullName: office.name.PEER_AB } });
      }
    });

    it('P19.17-T4 AC-3 a KPM with nobody in it: no AB group, no target, no plan — the empty view, nothing read for it', async () => {
      const EMPTY = '66f0000000000000000000e9';
      await db().collection('kpms').insertOne({
        _id: new mongoose.Types.ObjectId(EMPTY), code: '0999', branchName: 'Empty', timezone: 'Asia/Jakarta', status: 'active', deletedAt: null,
      });
      try {
        session.current = RequestContext.superAdminInKpm(RequestContext.platform('u-root'), EMPTY);
        const view = (await http().get('/kpm/ab-group-targets').expect(200)).body;
        expect(view).toMatchObject({ month: '2026-09', groups: [] });
        expect(view.total).toMatchObject({ abGroups: 0, people: 0, unset: 0, apeTargetMinor: 0, unplacedPeople: 0 });
      } finally {
        await db().collection('kpms').deleteOne({ _id: new mongoose.Types.ObjectId(EMPTY) });
      }
    });

    it('P19.17-T4 AC-3 a month outside January 2024 to a year ahead is 422; one that is no month 400', async () => {
      as('OWNER');
      expect((await http().get('/kpm/ab-group-targets?month=2023-12').expect(422)).body.error.code).toBe('AB_GROUP_TARGET_MONTH_CLOSED');
      await http().get('/kpm/ab-group-targets?month=2027-10').expect(422);
      expect((await http().get('/kpm/ab-group-targets?month=2026-13').expect(400)).body.error.code).toBe('VALIDATION_FAILED');
    });

    it.each(['AGUS', 'SARI', 'INDAH'] as const)('P19.17-T4 AC-3 negative: %s — no steward — is refused 403', async (who) => {
      as(who);
      expect((await http().get('/kpm/ab-group-targets').expect(403)).body.error).toMatchObject({ code: 'PERM_DENIED' });
    });

    it('P19.17-T4 AC-3 positive: an Admin and a core leader read it', async () => {
      as('ADMIN');
      await http().get('/kpm/ab-group-targets').expect(200);
      asWith('AGUS', { isCoreLeader: true });
      expect((await http().get('/kpm/ab-group-targets').expect(200)).body.canWrite).toBe(true);
    });

    it('P19.17-T4 cross-tenant: KPM B reads its own AB groups, never KPM A’s targets', async () => {
      as('OWNER');
      await put(office.id.AGUS, { month: '2026-09', activeAgentTarget: 6, rekrutTarget: 3 }).expect(200);
      asWith('B_AB', { isKpmOwner: true });
      const view = (await http().get('/kpm/ab-group-targets').expect(200)).body;
      expect(view.groups.flatMap((g: { abGroups: { abMembershipId: string }[] }) => g.abGroups.map((r) => r.abMembershipId)))
        .toEqual([office.id.B_AB]);
      expect(view.total).toMatchObject({ activeAgentTarget: 0, people: 2 });
    });
  });

  describe('PUT /kpm/ab-group-targets/:abMembershipId', () => {
    it('P19.17-T4 AC-3 positive: saves one AB group’s month, audited; the same again writes nothing; a change is audited', async () => {
      await db().collection('auditLog').deleteMany({ action: 'ab_group_target.set' });
      as('OWNER');
      const res = await put(office.id.AGUS, { month: '2026-09', activeAgentTarget: 6, rekrutTarget: 3 }).expect(200);
      expect(res.body.total).toMatchObject({ activeAgentTarget: 6, rekrutTarget: 3 });
      as('ADMIN');
      await put(office.id.AGUS, { month: '2026-09', activeAgentTarget: 6, rekrutTarget: 3 }).expect(200);
      asWith('PEER_AB', { isCoreLeader: true });
      await put(office.id.AGUS, { month: '2026-09', activeAgentTarget: 8, rekrutTarget: 4 }).expect(200);
      expect(await rows()).toEqual([expect.objectContaining({
        kpmId: KPM_A, abMembershipId: office.id.AGUS, month: '2026-09', activeAgentTarget: 8, rekrutTarget: 4, source: 'set', deletedAt: null,
      })]);
      const audits = await db().collection('auditLog').find({ action: 'ab_group_target.set' }).sort({ _id: 1 }).toArray();
      expect(audits.map((a) => [a.before, a.after])).toEqual([
        [null, { month: '2026-09', activeAgentTarget: 6, rekrutTarget: 3 }],
        [{ month: '2026-09', activeAgentTarget: 6, rekrutTarget: 3 }, { month: '2026-09', activeAgentTarget: 8, rekrutTarget: 4 }],
      ]);
    });

    it.each([
      ['no month', { activeAgentTarget: 1, rekrutTarget: 1 }],
      ['a month that is no month', { month: '2026-9', activeAgentTarget: 1, rekrutTarget: 1 }],
      ['a negative target', { month: '2026-09', activeAgentTarget: -1, rekrutTarget: 1 }],
      ['a fraction', { month: '2026-09', activeAgentTarget: 1.5, rekrutTarget: 1 }],
      ['a target above the bound', { month: '2026-09', activeAgentTarget: AB_GROUP_TARGETS.MAX + 1, rekrutTarget: 1 }],
      ['no Rekrut target', { month: '2026-09', activeAgentTarget: 1 }],
    ])('P19.17-T4 AC-3 %s is 400 VALIDATION_FAILED, nothing written', async (_, body) => {
      as('OWNER');
      expect((await put(office.id.AGUS, body).expect(400)).body.error.code).toBe('VALIDATION_FAILED');
      expect(await rows()).toEqual([]);
    });

    it('P19.17-T4 AC-3 an AAB or an agent is 422 ORG_GROUP_AB_ONLY; one who left 404; a closed month 422', async () => {
      as('OWNER');
      for (const who of ['SARI', 'INDAH'] as const) {
        expect((await put(office.id[who], { month: '2026-09', activeAgentTarget: 1, rekrutTarget: 1 }).expect(422)).body.error.code)
          .toBe('ORG_GROUP_AB_ONLY');
      }
      await put(office.id.LEFT, { month: '2026-09', activeAgentTarget: 1, rekrutTarget: 1 }).expect(404);
      await put('not-an-id', { month: '2026-09', activeAgentTarget: 1, rekrutTarget: 1 }).expect(404);
      expect((await put(office.id.AGUS, { month: '2023-12', activeAgentTarget: 1, rekrutTarget: 1 }).expect(422)).body.error.code)
        .toBe('AB_GROUP_TARGET_MONTH_CLOSED');
      expect(await rows()).toEqual([]);
    });

    it.each(['AGUS', 'SARI', 'LUKAS', 'INDAH'] as const)('P19.17-T4 AC-3 negative: %s, no steward, writes no target (403)', async (who) => {
      as(who);
      const res = await put(office.id.AGUS, { month: '2026-09', activeAgentTarget: 1, rekrutTarget: 1 }).expect(403);
      expect(res.body.error).toMatchObject({ code: 'PERM_DENIED', details: { permission: 'ab_group_target:write' } });
      expect(await rows()).toEqual([]);
    });

    /*
     * **The Super Admin, inside a KPM and in none, and a support session** (ADR-0268 §3, ADR-0206; the permission review
     * of 20 November 2026): inside KPM A the Super Admin is its Owner — reads, writes, and the audit row names them; in no
     * KPM there is nothing to read or write; *Lihat sebagai* an Owner reads and writes nothing.
     */
    it('ADR-0268 §3 the Super Admin inside KPM A reads and writes, audited as themselves; in no KPM, refused', async () => {
      await db().collection('auditLog').deleteMany({ action: 'ab_group_target.set' });
      session.current = RequestContext.superAdminInKpm(RequestContext.platform('u-root'), KPM_A);
      await http().get('/kpm/ab-group-targets?month=2026-09').expect(200);
      await put(office.id.AGUS, { month: '2026-09', activeAgentTarget: 5, rekrutTarget: 2 }).expect(200);
      expect(await rows()).toEqual([expect.objectContaining({ kpmId: KPM_A, abMembershipId: office.id.AGUS, activeAgentTarget: 5 })]);
      const [audit] = await db().collection('auditLog').find({ action: 'ab_group_target.set' }).toArray();
      expect(audit).toMatchObject({ kpmId: KPM_A, actorUserId: 'u-root', actorMembershipId: null, after: { activeAgentTarget: 5 } });

      session.current = RequestContext.platform('u-root');
      expect((await http().get('/kpm/ab-group-targets?month=2026-09')).status).toBe(403);
      expect((await put(office.id.AGUS, { month: '2026-09', activeAgentTarget: 9, rekrutTarget: 9 })).status).toBe(403);
      expect(await rows()).toEqual([expect.objectContaining({ activeAgentTarget: 5 })]);
    });

    it('ADR-0206 a support session as the Owner reads the targets and writes none', async () => {
      const owner = office.as('OWNER');
      session.current = new RequestContext(owner.userId, 'none', owner.membership, 'u-super', null, false, true);
      await http().get('/kpm/ab-group-targets?month=2026-09').expect(200);
      expect((await put(office.id.AGUS, { month: '2026-09', activeAgentTarget: 1, rekrutTarget: 1 })).status).toBe(403);
      expect(await rows()).toEqual([]);
    });

    it('P19.17-T4 AC-3 two first saves racing: the second meets the unique index, is retried as an update and replaces the first', async () => {
      const model = (wired.abGroupTargets as unknown as { targets: { model: mongoose.Model<unknown> } }).targets.model;
      // The second save's write starts after both found no row; the first's lands in between.
      const write = jest.spyOn(model, 'findOneAndUpdate').mockImplementationOnce((() => ({
        exec: async () => {
          await db().collection('abGroupTargets').insertOne({
            kpmId: KPM_A, abMembershipId: office.id.AGUS, month: '2026-09', activeAgentTarget: 4, rekrutTarget: 2, source: 'set',
            deletedAt: null, createdBy: office.id.ADMIN, updatedBy: office.id.ADMIN,
          });
          throw Object.assign(new Error('E11000 duplicate key error'), { code: 11000 });
        },
      })) as never);
      try {
        as('OWNER');
        await put(office.id.AGUS, { month: '2026-09', activeAgentTarget: 6, rekrutTarget: 3 }).expect(200);
        expect(write).toHaveBeenCalledTimes(2);
        expect(await rows()).toMatchObject([{ abMembershipId: office.id.AGUS, month: '2026-09', activeAgentTarget: 6, rekrutTarget: 3 }]);
        const entry = await db().collection('auditLog').findOne({ action: 'ab_group_target.set', 'after.activeAgentTarget': 6, 'before.activeAgentTarget': 4 });
        expect(entry).toMatchObject({ before: { month: '2026-09', activeAgentTarget: 4, rekrutTarget: 2 } });
      } finally {
        write.mockRestore();
      }
    });

    it('P19.17-T4 AC-3 a save that fails for any reason but two first saves racing is not retried: 500, nothing written', async () => {
      const model = (wired.abGroupTargets as unknown as { targets: { model: mongoose.Model<unknown> } }).targets.model;
      const write = jest.spyOn(model, 'findOneAndUpdate').mockImplementationOnce((() => ({
        exec: async () => { throw new Error('the database went away'); },
      })) as never);
      const audits = () => db().collection('auditLog').countDocuments({ action: 'ab_group_target.set' });
      const before = await audits();
      try {
        as('OWNER');
        await put(office.id.AGUS, { month: '2026-09', activeAgentTarget: 6, rekrutTarget: 3 }).expect(500);
        expect(write).toHaveBeenCalledTimes(1);
        expect(await rows()).toEqual([]);
        expect(await audits()).toBe(before);
      } finally {
        write.mockRestore();
      }
    });

    it('P19.17-T4 cross-tenant: KPM A writes no target on KPM B’s AB, nor B on A’s (404)', async () => {
      as('OWNER');
      await put(office.id.B_AB, { month: '2026-09', activeAgentTarget: 1, rekrutTarget: 1 }).expect(404);
      asWith('B_AB', { isKpmOwner: true });
      await put(office.id.AGUS, { month: '2026-09', activeAgentTarget: 1, rekrutTarget: 1 }).expect(404);
      expect(await rows()).toEqual([]);
      await put(office.id.B_AB, { month: '2026-09', activeAgentTarget: 2, rekrutTarget: 1 }).expect(200);
      expect(await rows()).toEqual([expect.objectContaining({ kpmId: KPM_B, abMembershipId: office.id.B_AB })]);
    });
  });
});
