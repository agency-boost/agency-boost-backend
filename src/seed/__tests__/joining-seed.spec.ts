import mongoose from 'mongoose';
import { FixedClock } from '@/common/clock/clock.port';
import { RequestContext } from '@/common/context/request-context';
import { AuditLog, AuditLogSchema } from '@/modules/audit/audit-log.schema';
import { AuditService } from '@/modules/audit/audit.service';
import { ApprovalsService } from '@/modules/org/approvals.service';
import { HierarchyService } from '@/modules/org/hierarchy.service';
import { InvitesService } from '@/modules/org/invites.service';
import { JoinRequest, JoinRequestSchema } from '@/modules/org/join-request.schema';
import { MemberInvite, MemberInviteSchema } from '@/modules/org/member-invite.schema';
import { MemberNames } from '@/modules/org/member-names.service';
import { MembershipHistory, MembershipHistorySchema } from '@/modules/org/membership-history.schema';
import { MembershipRepository } from '@/modules/org/membership.repository';
import { Membership, MembershipSchema } from '@/modules/org/membership.schema';
import {
  JoinRequestRepository, MemberInviteRepository, MembershipHistoryRepository, TransferRequestRepository,
} from '@/modules/org/org.repositories';
import { TransferRequest, TransferRequestSchema } from '@/modules/org/transfer-request.schema';
import { TransfersService } from '@/modules/org/transfers.service';
import { Company, CompanySchema } from '@/modules/tenants/company.schema';
import { CompanyOrgLevel, CompanyOrgLevelSchema } from '@/modules/tenants/company-org-level.schema';
import { Kpm, KpmSchema } from '@/modules/tenants/kpm.schema';
import { OrgLevelService } from '@/modules/tenants/org-level.service';
import { User, UserSchema } from '@/modules/users/user.schema';
import { clearCollections, startMongo, stopMongo } from '../../../test/mongo';
import { seedDemo, type SeedResult } from '../demo';
import { JOINING_SEED, joiningInviteToken } from '../joining-fixture';

const RUN_MS = 240_000;
const quiet = () => undefined;
const col = (name: string) => mongoose.connection.db!.collection(name);
const RECOMPILE = { overwriteModels: true } as const;
const model = (name: string, schema: mongoose.Schema) => mongoose.model(name, schema, undefined, RECOMPILE);

async function memberOf(email: string) {
  const account = await col('users').findOne({ email });
  return (await col('memberships').findOne({ userId: String(account!._id), status: { $in: ['active', 'pending'] } }))!;
}

async function as(email: string, flags: { owner?: boolean; admin?: boolean } = {}): Promise<RequestContext> {
  const member = await memberOf(email);
  return new RequestContext(String(member.userId), 'none', {
    membershipId: String(member._id), kpmId: member.kpmId, orgLevelCode: member.orgLevelCode, hierarchyRole: member.role,
    status: member.status, isKpmOwner: flags.owner ?? false, isKpmAdmin: flags.admin ?? false, directCount: 0,
  } as never);
}

/**
 * **Adding an agent, seeded** (P18.96-T3; `joining-fixture.ts`): the seed run as the command runs it, then read back
 * through the invites' and transfers' own services — what Agus sees on `/new-hires`, what the Owner sees on *All
 * Members*, and what Yusuf's link opens — and run again to prove the second run writes none of it.
 */
describe('P18.96-T3 the adding-an-agent seed — a run at 10:00 on 27 October 2026 in Jakarta', () => {
  const clock = new FixedClock(new Date('2026-10-27T03:00:00Z'));
  let first: SeedResult;
  let invites: InvitesService;
  let transfers: TransfersService;

  beforeAll(async () => {
    await startMongo();
    await clearCollections();
    first = await seedDemo({ clock, log: quiet });
    const users = model(User.name, UserSchema);
    const kpms = model(Kpm.name, KpmSchema);
    const companies = model(Company.name, CompanySchema);
    const audit = new AuditService(model(AuditLog.name, AuditLogSchema) as never);
    const members = new MembershipRepository(model(Membership.name, MembershipSchema) as never);
    const history = new MembershipHistoryRepository(model(MembershipHistory.name, MembershipHistorySchema) as never);
    const requests = new JoinRequestRepository(model(JoinRequest.name, JoinRequestSchema) as never);
    const orgLevels = new OrgLevelService(model(CompanyOrgLevel.name, CompanyOrgLevelSchema) as never, companies as never, kpms as never, audit, clock);
    const hierarchy = new HierarchyService(members, kpms as never, users as never, history, clock, orgLevels);
    const notifications = { send: async () => undefined } as never;
    const names = new MemberNames(members, users as never);
    transfers = new TransfersService(
      new TransferRequestRepository(model(TransferRequest.name, TransferRequestSchema) as never), members, hierarchy, names,
      kpms as never, audit, notifications, clock,
    );
    invites = new InvitesService(
      new MemberInviteRepository(model(MemberInvite.name, MemberInviteSchema) as never), members, hierarchy,
      new ApprovalsService(members, hierarchy, requests, history, users as never, audit, notifications, clock),
      transfers, requests, names, kpms as never, companies as never, users as never, audit, notifications, clock,
    );
  }, RUN_MS);
  afterAll(stopMongo);

  it('P18.96-T3 Seed Agus has one invite waiting to join — Yusuf, code 80777, joining today — and no other', async () => {
    const { today, invites: mine } = await invites.list(await as('agus@kpm0417.test'));
    expect(today).toBe('2026-10-27');
    expect(mine.map((i) => [i.fullName, i.agentCode, i.joinDate, i.status, i.leader.name])).toEqual([
      [JOINING_SEED.invite.fullName, '80777', '2026-10-27', 'pending', 'Agus Prasetyo'],
    ]);
    // Rudi's was cancelled: a row, the record of it, and in no list.
    expect(await col('memberInvites').findOne({ agentCode: '80778' })).toMatchObject({ status: 'cancelled', fullName: 'Rudi Hartono' });
    // An invite counts in nothing: nobody holds either code.
    expect(await col('users').countDocuments({ agentCode: { $in: ['80777', '80778'] } })).toBe(0);
  });

  it('P18.96-T3 Seed Yusuf’s link opens the banner the guide prints', async () => {
    const kpm = await col('kpms').findOne({ code: '0417' });
    const token = joiningInviteToken(String(kpm!._id));
    expect(first.joining.invitePath).toBe(`/register?invite=${encodeURIComponent(token)}`);
    expect(await invites.banner(token)).toMatchObject({
      leaderName: 'Agus Prasetyo', kpm: { code: '0417' }, agentCode: '80777', joinDate: '2026-10-27',
      fullName: JOINING_SEED.invite.fullName, existingAccount: false,
    });
  });

  it('P18.96-T3 Seed the Owner has Agus’s transfer request for Raka Aditama, who still reports to Satria; Agus sees it as his', async () => {
    const queue = await transfers.queue(await as('owner@kpm0417.test', { owner: true }));
    expect(queue.map((t) => [t.member.name, t.from?.name, t.to.name, t.requestedBy.name, t.requestedName])).toEqual([
      ['Raka Aditama', 'Satria Nugraha', 'Agus Prasetyo', 'Agus Prasetyo', 'Raka Aditama'],
    ]);
    expect((await memberOf('raka@kpm0417.test')).leaderId).toBe(String((await memberOf('satria@kpm0417.test'))._id));
    // P18.96-T8 M3: Agus sees the name he typed, and nothing of Satria's unit.
    const mine = await transfers.mine(await as('agus@kpm0417.test'));
    expect(mine.map((t) => [t.requestedName, t.to.name, t.status])).toEqual([['Raka Aditama', 'Agus Prasetyo', 'pending']]);
    expect(JSON.stringify(mine)).not.toContain('Satria');
    const told = await col('notifications').find({ templateId: 'transfer_request.received' }).toArray();
    expect(told.map((n) => n.payload.memberName)).toEqual(['Raka Aditama', 'Raka Aditama']);
  });

  it('P18.96-T3 Seed Putri and Fajar stay leaderless, so + Add agent with their codes links them', async () => {
    for (const email of ['pending@kpm0417.test', 'untagged@kpm0417.test']) {
      expect([email, await memberOf(email)]).toEqual([email, expect.objectContaining({ status: 'pending', leaderId: null })]);
    }
  });

  it('P18.96-T3 Seed a second run writes none of it', async () => {
    const again = await seedDemo({ clock, log: quiet });
    expect(again.joining.written).toBe(0);
    expect(first.joining.written).toBe(3);
    expect(await col('memberInvites').countDocuments({})).toBe(2);
    expect(await col('transferRequests').countDocuments({})).toBe(1);
    expect(await col('notifications').countDocuments({ templateId: 'transfer_request.received' })).toBe(2);
  }, RUN_MS);
});
