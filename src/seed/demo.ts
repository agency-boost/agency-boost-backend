/**
 * Seeds a demo tenant so the API can actually be exercised.
 *
 * Phase 3 scope: a platform Super Admin, one company, one KPM, its Owner, and a small
 * hierarchy underneath — an AB with an AAB and agents, plus a childless AAB, because
 * that is the case leadership-by-graph exists to get right (OD-23).
 *
 * Activity, leads and production arrive as Phases 6–9 create their collections. This
 * grows with them rather than pretending to be the full fixture now.
 *
 *   pnpm seed:demo            create, leaving anything that already exists
 *   pnpm seed:demo --reset    drop the database first
 */
import 'reflect-metadata';
import mongoose from 'mongoose';
import { config as loadEnv } from 'dotenv';
import { SystemClock } from '@/common/clock/clock.port';
import { PasswordService } from '@/modules/auth/password.service';
import { User, UserSchema } from '@/modules/users/user.schema';
import { Company, CompanySchema } from '@/modules/tenants/company.schema';
import { DEFAULT_KPM_SETTINGS, Kpm, KpmSchema } from '@/modules/tenants/kpm.schema';
import { Membership, MembershipSchema } from '@/modules/org/membership.schema';
import {
  MembershipHistory, MembershipHistorySchema,
} from '@/modules/org/membership-history.schema';
import { formatAgentCode } from '@/modules/org/agent-code';

loadEnv();

const SUPER_ADMIN = { email: 'superadmin@agencyboost.test', password: 'demo super admin', fullName: 'Platform Operator' };
const OWNER = { email: 'owner@kpm0417.test', password: 'demo password 0417', fullName: 'Wilson Tanoto' };
const AGENT = { email: 'rina@kpm0417.test', password: 'demo password rina', fullName: 'Rina Wijaya' };

async function main(): Promise<void> {
  const uri = process.env.MONGODB_URI;
  const dbName = process.env.MONGODB_DB_NAME ?? 'agencyboost';
  if (!uri) {
    console.error('MONGODB_URI is not set. Copy .env.example to .env and fill in your Atlas string.');
    process.exit(1);
  }

  await mongoose.connect(uri, { dbName });
  const passwords = new PasswordService();
  const clock = new SystemClock();

  const Users = mongoose.model(User.name, UserSchema);
  const Companies = mongoose.model(Company.name, CompanySchema);
  const Kpms = mongoose.model(Kpm.name, KpmSchema);

  if (process.argv.includes('--reset')) {
    // Empty the collections rather than drop the database. An Atlas user with ordinary
    // read/write permissions cannot `dropDatabase` — the seed failed outright against
    // one — and emptying named collections will not take out a database someone pointed
    // at by mistake.
    const owned = [
      'memberships', 'membershipHistory', 'kpms', 'companies', 'users',
      'authTokens', 'auditLog', 'notifications', 'notificationPreferences', 'assets',
    ];
    for (const name of owned) {
      const { deletedCount } = await mongoose.connection.collection(name).deleteMany({});
      if (deletedCount) console.log(`cleared ${deletedCount} from ${name}`);
    }
    console.log(`reset ${dbName}`);
  }

  async function upsertUser(spec: typeof OWNER, platformRole: 'super_admin' | 'none') {
    const existing = await Users.findOne({ email: spec.email }).exec();
    if (existing) return existing;
    return Users.create({
      email: spec.email,
      passwordHash: await passwords.hash(spec.password),
      fullName: spec.fullName,
      platformRole,
      status: 'active',
      // Pre-verified: the point of a demo tenant is to sign in, not to chase an inbox.
      emailVerifiedAt: clock.now(),
    });
  }

  const superAdmin = await upsertUser(SUPER_ADMIN, 'super_admin');
  const owner = await upsertUser(OWNER, 'none');
  const agent = await upsertUser(AGENT, 'none');

  const company =
    (await Companies.findOne({ slug: 'prudential' }).exec()) ??
    (await Companies.create({
      name: 'Prudential', slug: 'prudential',
      defaultCurrency: 'IDR', defaultLocale: 'id-ID', defaultTimezone: 'Asia/Jakarta',
    }));

  const kpm =
    (await Kpms.findOne({ companyId: String(company._id), code: '0417' }).exec()) ??
    (await Kpms.create({
      companyId: String(company._id),
      code: '0417',
      branchName: 'BSD City Branch',
      address: 'Jl. Raya Serpong, Tangerang Selatan',
      ownerUserId: String(owner._id),
      timezone: 'Asia/Jakarta',
      settings: { ...DEFAULT_KPM_SETTINGS },
      counters: { nextAgentCodeSeq: 1 },
      status: 'active',
    }));

  // The office's people. Ordered, because the agent code is issued from a counter and
  // the roster reads better when the seed's numbering matches the tree.
  const Memberships = mongoose.model(Membership.name, MembershipSchema);
  const History = mongoose.model(MembershipHistory.name, MembershipHistorySchema);
  const kpmId = String(kpm._id);

  async function member(
    userId: string,
    role: 'ab' | 'aab' | 'agent',
    leader: { _id: unknown; ancestorIds: string[]; depth: number } | null,
  ) {
    const existing = await Memberships.findOne({ kpmId, userId }).exec();
    if (existing) return existing;

    const counted = await Kpms.findOneAndUpdate(
      { _id: kpm._id },
      { $inc: { 'counters.nextAgentCodeSeq': 1 } },
      { new: false },
    ).exec();
    const seq = (counted?.get('counters')?.nextAgentCodeSeq as number) ?? 1;
    const leaderId = leader ? String(leader._id) : null;

    const created = await Memberships.create({
      kpmId,
      userId,
      agentCode: formatAgentCode(kpm.get('code') as string, seq),
      agentSeq: seq,
      role,
      leaderId,
      ancestorIds: leader ? [...leader.ancestorIds, leaderId!] : [],
      depth: leader ? leader.depth + 1 : 0,
      status: 'active',
      joinedAt: clock.now(),
      recruitedByMembershipId: leaderId,
    });
    // History is written from the first day, not from the day a screen reads it.
    await History.create({
      kpmId, membershipId: String(created._id), eventType: 'joined',
      toRole: role, toLeaderId: leaderId, validFrom: clock.now(), validTo: null,
      actorUserId: String(superAdmin._id),
    });
    return created;
  }

  async function extra(email: string, fullName: string) {
    const existing = await Users.findOne({ email }).exec();
    if (existing) return existing;
    return Users.create({
      email,
      passwordHash: await passwords.hash('demo password field'),
      fullName,
      platformRole: 'none',
      status: 'active',
      emailVerifiedAt: clock.now(),
    });
  }

  const ownerMembership = await member(String(owner._id), 'ab', null);
  const ownerRef = {
    _id: ownerMembership._id,
    ancestorIds: ownerMembership.get('ancestorIds') as string[],
    depth: ownerMembership.get('depth') as number,
  };

  const aabUser = await extra('sari@kpm0417.test', 'Sari Puspita');
  const aab = await member(String(aabUser._id), 'aab', ownerRef);
  const aabRef = {
    _id: aab._id,
    ancestorIds: aab.get('ancestorIds') as string[],
    depth: aab.get('depth') as number,
  };

  await member(String(agent._id), 'agent', aabRef);
  const budi = await extra('budi@kpm0417.test', 'Budi Santoso');
  await member(String(budi._id), 'agent', aabRef);

  // A childless AAB: holds the role, leads nobody. The case the prototype's two
  // definitions of "leader" disagree about, and the reason OD-23 picked the graph.
  const dewiUser = await extra('dewi@kpm0417.test', 'Dewi Lestari');
  await member(String(dewiUser._id), 'aab', ownerRef);

  // Counts are derived, never incremented, so they cannot drift out of step.
  for (const id of [String(ownerMembership._id), String(aab._id)]) {
    const directs = await Memberships.find({ kpmId, leaderId: id, status: 'active' }).exec();
    const counts = { ab: 0, aab: 0, agent: 0, total: directs.length };
    for (const d of directs) counts[d.get('role') as 'ab' | 'aab' | 'agent'] += 1;
    const subtreeCount = await Memberships.countDocuments({ kpmId, ancestorIds: id, status: 'active' });
    await Memberships.updateOne({ _id: id }, { $set: { directCounts: counts, subtreeCount } });
  }

  console.log(`
Seeded.

  Super Admin   ${SUPER_ADMIN.email}   ${SUPER_ADMIN.password}
  KPM Owner     ${OWNER.email}          ${OWNER.password}
  Agent         ${AGENT.email}          ${AGENT.password}

  The office's people, all with the password "demo password field":
    sari@kpm0417.test    AAB, leads two agents
    budi@kpm0417.test    Agent under Sari
    dewi@kpm0417.test    AAB who leads nobody — the case OD-23 settles

  Company       ${company.name} (${company._id})
  KPM           ${kpm.get('code')} ${kpm.get('branchName')} (${kpm._id})
  Owner user id ${owner._id}
  Agent user id ${agent._id}
  Super admin   ${superAdmin._id}

Sign in at POST /api/v1/auth/login, then send the access token as
  Authorization: Bearer <accessToken>
`);

  await mongoose.disconnect();
}

main().catch(async (err) => {
  console.error(err);
  await mongoose.disconnect();
  process.exit(1);
});
