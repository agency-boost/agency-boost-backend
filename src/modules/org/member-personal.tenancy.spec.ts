import mongoose from 'mongoose';
import { Clock, FixedClock } from '@/common/clock/clock.port';
import { RequestContext } from '@/common/context/request-context';
import { AuditLog, AuditLogSchema } from '@/modules/audit/audit-log.schema';
import { AuditService } from '@/modules/audit/audit.service';
import { Company, CompanySchema } from '@/modules/tenants/company.schema';
import { Kpm, KpmSchema } from '@/modules/tenants/kpm.schema';
import { TenantDay } from '@/modules/tenants/tenant-day.service';
import { User, UserSchema } from '@/modules/users/user.schema';
import { clearCollections, startMongo, stopMongo } from '../../../test/mongo';
import { DirectoryService } from './directory.service';
import { MemberPersonalService } from './member-personal.service';
import { MembershipRepository } from './membership.repository';
import { Membership, MembershipSchema } from './membership.schema';

const NOW = new Date('2026-11-11T02:00:00Z');
const KPM_A = new mongoose.Types.ObjectId().toString();
const KPM_B = new mongoose.Types.ObjectId().toString();

/** The Owner of an office. */
const ownerOf = (kpmId: string) => new RequestContext(`u-owner-${kpmId}`, 'none', {
  membershipId: new mongoose.Types.ObjectId().toString(), kpmId, orgLevelCode: 'AB', hierarchyRole: 'ab',
  status: 'active', isKpmOwner: true, isKpmAdmin: false, directCount: 1,
} as never);

/**
 * **P19.12-T5 AC-3, cross-tenant** (invariant §1; ADR-0248 §3): *Lengkapi data* in one office never reads nor writes a
 * member of another — `404`, nothing written, nothing recorded — in either direction, and the route is never asked with
 * no office at all.
 */
describe('P19.12-T5 PATCH /members/:membershipId/personal — tenancy', () => {
  let service: MemberPersonalService;
  let users: mongoose.Model<User>;
  let audits: mongoose.Model<AuditLog>;
  const member: Record<'A' | 'B', string> = { A: '', B: '' };

  beforeAll(async () => {
    await startMongo();
    users = mongoose.model(User.name, UserSchema) as never;
    audits = mongoose.model(AuditLog.name, AuditLogSchema) as never;
    const kpms = mongoose.model(Kpm.name, KpmSchema);
    const members = new MembershipRepository(mongoose.model(Membership.name, MembershipSchema) as never);
    const clock = new FixedClock(NOW) as Clock;
    service = new MemberPersonalService(
      members,
      users as never,
      new DirectoryService(members, users as never, kpms as never, mongoose.model(Company.name, CompanySchema) as never),
      new TenantDay(kpms as never, clock),
      new AuditService(audits as never),
    );
  });
  afterAll(stopMongo);

  beforeEach(async () => {
    await clearCollections();
    for (const [kpmId, code, key] of [[KPM_A, '0417', 'A'], [KPM_B, '0555', 'B']] as const) {
      await mongoose.model(Kpm.name).create({
        _id: kpmId, companyId: new mongoose.Types.ObjectId().toString(), code, branchName: code, timezone: 'Asia/Jakarta',
        counters: { nextMemberSeq: 1 }, status: 'active',
      });
      const user = await users.create({
        email: `${code}@kpm.test`, passwordHash: 'x', fullName: `Member ${code}`, status: 'active', platformRole: 'none',
        agentCode: `${code}01`,
      });
      // Written as a stored row, past the schema: this spec is about which office is asked, not how a member is placed.
      const { insertedId } = await mongoose.connection.collection('memberships').insertOne({
        // A leader code of its own: `leaderCode` is unique across live memberships, whichever spec built the index first.
        kpmId, userId: String(user._id), agentCode: `${code}01`, leaderCode: `L${code}01`, agentSeq: 1, role: 'agent', orgLevelCode: 'AGENT',
        status: 'active', leaderId: null, ancestorIds: [], depth: 0, workStatus: null, deletedAt: null,
      });
      member[key] = String(insertedId);
    }
  });

  const genderOf = async (membershipId: string) => {
    const row = await mongoose.model(Membership.name).findById(membershipId).lean<{ userId: string }>().exec();
    return (await users.findById(row!.userId).lean().exec())?.gender ?? null;
  };

  it('P19.12-T5 AC-3 office A’s Owner is answered 404 for office B’s member, and nothing is written or recorded', async () => {
    await expect(service.complete(ownerOf(KPM_A), member.B, { gender: 'male', workStatus: 'full_time' }))
      .rejects.toMatchObject({ code: 'NOT_FOUND' });
    expect(await genderOf(member.B)).toBeNull();
    expect((await mongoose.model(Membership.name).findById(member.B).lean<{ workStatus?: string | null }>().exec())?.workStatus ?? null)
      .toBeNull();
    expect(await audits.countDocuments({})).toBe(0);
  });

  it('P19.12-T5 AC-3 and office B’s Owner for office A’s, while each fills their own', async () => {
    await expect(service.complete(ownerOf(KPM_B), member.A, { gender: 'female' })).rejects.toMatchObject({ code: 'NOT_FOUND' });
    expect(await genderOf(member.A)).toBeNull();

    await service.complete(ownerOf(KPM_A), member.A, { gender: 'female' });
    await service.complete(ownerOf(KPM_B), member.B, { gender: 'male' });
    expect([await genderOf(member.A), await genderOf(member.B)]).toEqual(['female', 'male']);
    // Each office's entry in its own office.
    expect((await audits.find({}).lean().exec()).map((a) => [a.kpmId, a.targetMembershipId]).sort())
      .toEqual([[KPM_A, member.A], [KPM_B, member.B]].sort());
  });

  it('P19.12-T5 AC-3 a context with no office cannot ask at all', async () => {
    const nobody = new RequestContext('u-new', 'none', null);
    await expect(service.complete(nobody, member.A, { gender: 'male' })).rejects.toThrow();
    expect(await genderOf(member.A)).toBeNull();
  });
});
