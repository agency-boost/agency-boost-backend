import mongoose from 'mongoose';
import { FixedClock } from '@/common/clock/clock.port';
import { RequestContext } from '@/common/context/request-context';
import { AuditLog, AuditLogSchema } from '@/modules/audit/audit-log.schema';
import { AuditService } from '@/modules/audit/audit.service';
import { HierarchyService } from '@/modules/org/hierarchy.service';
import { MemberNames } from '@/modules/org/member-names.service';
import { MembershipHistory, MembershipHistorySchema } from '@/modules/org/membership-history.schema';
import { MembershipRepository } from '@/modules/org/membership.repository';
import { Membership, MembershipSchema } from '@/modules/org/membership.schema';
import { MembershipHistoryRepository, TransferRequestRepository } from '@/modules/org/org.repositories';
import { RoleChangeService } from '@/modules/org/role-change.service';
import { TransferRequest, TransferRequestSchema } from '@/modules/org/transfer-request.schema';
import { TransfersService } from '@/modules/org/transfers.service';
import { Company, CompanySchema } from '@/modules/tenants/company.schema';
import { CompanyOrgLevel, CompanyOrgLevelSchema } from '@/modules/tenants/company-org-level.schema';
import { Kpm, KpmSchema } from '@/modules/tenants/kpm.schema';
import { OrgLevelService } from '@/modules/tenants/org-level.service';
import { User, UserSchema } from '@/modules/users/user.schema';
import { clearCollections, seedLadder, startMongo, stopMongo } from '../../../test/mongo';
import { LEADER_CHANGE_SEED, leaderChangeRowId, seedLeaderChangeFixture } from '../leader-change-fixture';

const NOW = new Date('2026-11-11T03:00:00Z');
const KPM = new mongoose.Types.ObjectId().toString();

/**
 * **Changing a leader, seeded** (P19.12-T4; `leader-change-fixture.ts`): the fixture on a small office built as the demo
 * builds 0417's corner of it — Wilson ── Agus ── Sari, Dimas; Wilson ── Yosef — then read back through the services the
 * screens call: Agus's *Tim Anda* and the office's *Permintaan pemindahan*. Run twice, to prove the second writes nothing.
 */
describe('P19.12-T4 the changing-a-leader seed', () => {
  const clock = new FixedClock(NOW);
  let hierarchy: HierarchyService;
  let roles: RoleChangeService;
  let transfers: TransfersService;
  const told: { userId: string; templateId: string; payload: Record<string, unknown> }[] = [];
  let people: Record<'wilson' | 'agus' | 'sari' | 'dimas' | 'yosef' | 'maya', { membershipId: string; userId: string }>;

  beforeAll(async () => {
    await startMongo();
    const users = mongoose.model(User.name, UserSchema);
    const kpms = mongoose.model(Kpm.name, KpmSchema);
    const audit = new AuditService(mongoose.model(AuditLog.name, AuditLogSchema) as never);
    const members = new MembershipRepository(mongoose.model(Membership.name, MembershipSchema) as never);
    const history = new MembershipHistoryRepository(mongoose.model(MembershipHistory.name, MembershipHistorySchema) as never);
    const orgLevels = new OrgLevelService(
      mongoose.model(CompanyOrgLevel.name, CompanyOrgLevelSchema) as never, mongoose.model(Company.name, CompanySchema) as never,
      kpms as never, audit, clock,
    );
    hierarchy = new HierarchyService(members, kpms as never, users as never, history, clock, orgLevels);
    const notifications = { send: async () => undefined } as never;
    transfers = new TransfersService(
      new TransferRequestRepository(mongoose.model(TransferRequest.name, TransferRequestSchema) as never),
      members, hierarchy, new MemberNames(members, users as never), kpms as never, audit, notifications, clock,
    );
    roles = new RoleChangeService(members, hierarchy, history, users as never, audit, notifications, clock, transfers);

    await clearCollections();
    const company = await mongoose.model(Company.name).create({ name: 'Prudential', slug: 'pru-leader-change-seed' });
    await seedLadder(String(company._id));
    const account = async (fullName: string, agentCode: string) => String((await users.create({
      email: `${agentCode}@kpm0417.test`, passwordHash: 'x', fullName, status: 'active', platformRole: 'none',
      companyId: String(company._id), agentCode,
    }))._id);
    const ids = {
      wilson: await account('Wilson Tanoto', '10001'), maya: await account('Maya Halim', '10002'),
      agus: await account('Agus Prasetyo', '10003'), sari: await account('Sari Puspita', '10004'),
      dimas: await account('Dimas Pratama', '80102'), yosef: await account('Yosef Tambunan', '87001'),
    };
    await kpms.create({
      _id: KPM, companyId: String(company._id), code: '0417', branchName: 'BSD City', counters: { nextMemberSeq: 1 },
      status: 'active', timezone: 'Asia/Jakarta', ownerUserId: ids.wilson,
    });
    const job = RequestContext.forJob(KPM, 'leader-change-seed');
    const place = async (userId: string, role: 'ab' | 'aab' | 'agent', leaderId: string | null) => String((await hierarchy.create(job, {
      userId, role, leaderId, status: 'active', joining: { joinDate: '2025-01-02' },
    }))._id);
    const wilson = await place(ids.wilson, 'ab', null);
    const maya = await place(ids.maya, 'ab', wilson);
    const agus = await place(ids.agus, 'ab', wilson);
    const sari = await place(ids.sari, 'aab', agus);
    const dimas = await place(ids.dimas, 'agent', agus);
    const yosef = await place(ids.yosef, 'ab', wilson);
    people = {
      wilson: { membershipId: wilson, userId: ids.wilson }, maya: { membershipId: maya, userId: ids.maya },
      agus: { membershipId: agus, userId: ids.agus }, sari: { membershipId: sari, userId: ids.sari },
      dimas: { membershipId: dimas, userId: ids.dimas }, yosef: { membershipId: yosef, userId: ids.yosef },
    };
  });
  afterAll(stopMongo);

  const run = () => seedLeaderChangeFixture({
    clock,
    kpmId: KPM,
    agus: { membershipId: people.agus.membershipId, fullName: 'Agus Prasetyo' },
    dimas: { membershipId: people.dimas.membershipId, fullName: 'Dimas Pratama' },
    yosef: { membershipId: people.yosef.membershipId, fullName: 'Yosef Tambunan' },
    deciders: [people.wilson],
    notify: async (to, templateId, payload) => { told.push({ userId: to.userId, templateId, payload }); },
  });

  const as = (who: keyof typeof people, owner = false) => {
    const { membershipId, userId } = people[who];
    const role = who === 'sari' ? 'aab' : who === 'dimas' ? 'agent' : 'ab';
    return new RequestContext(userId, 'none', {
      membershipId, kpmId: KPM, orgLevelCode: role.toUpperCase(), hierarchyRole: role, status: 'active',
      isKpmOwner: owner, isKpmAdmin: false, directCount: 1,
    } as never);
  };

  it('P19.12-T4 AC-7 writes Agus’s waiting move for Dimas to Yosef’s unit, once, and tells the office', async () => {
    const first = await run();
    expect(first.written).toBe(1);
    expect(first.guide).toContain('Menunggu persetujuan pemindahan');
    const row = await mongoose.connection.db!.collection('transferRequests').findOne({ _id: new mongoose.Types.ObjectId(leaderChangeRowId(KPM)) });
    expect(row).toMatchObject({
      kind: 'move', status: 'pending', membershipId: people.dimas.membershipId, fromLeaderId: people.agus.membershipId,
      toLeaderId: people.yosef.membershipId, note: LEADER_CHANGE_SEED.move.note,
    });
    expect(told).toEqual([expect.objectContaining({
      userId: people.wilson.userId, templateId: 'transfer_request.received',
      payload: expect.objectContaining({ kind: 'move', toLeaderName: 'Yosef Tambunan' }),
    })]);
    expect((await run()).written).toBe(0);
  });

  it('P19.12-T4 AC-7 reads back as the screens draw it: Agus’s Tim Anda, Sari with AB among her choices, the office’s queue', async () => {
    const team = await roles.team(as('agus'));
    expect(team.find((t) => t.membershipId === people.dimas.membershipId)?.pendingTransfer).toMatchObject({ toName: 'Yosef Tambunan' });
    expect(team.find((t) => t.membershipId === people.sari.membershipId)).toMatchObject({ roleChoices: ['AGENT', 'AAB', 'AB'], orgLevelCode: 'AAB' });
    const owners = await roles.team(as('wilson', true));
    expect(owners.find((t) => t.membershipId === people.maya.membershipId)).toMatchObject({ orgLevelCode: 'AB', roleChoices: ['AGENT', 'AAB', 'AB'] });
    expect(await transfers.queue(as('wilson', true))).toEqual([expect.objectContaining({
      kind: 'move', note: LEADER_CHANGE_SEED.move.note, member: expect.objectContaining({ name: 'Dimas Pratama' }),
      to: expect.objectContaining({ name: 'Yosef Tambunan' }), requestedBy: expect.objectContaining({ name: 'Agus Prasetyo' }),
    })]);
  });
});
