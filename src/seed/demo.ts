/**
 * Seeds a demo tenant so the API and the screens can actually be exercised.
 *
 * The cast is chosen to make **states** reachable, not to look populous. Every account
 * below exists because some behaviour is only visible through it: a childless AAB for
 * leadership-by-graph (OD-23), a pending member for the join gate, a removed one for
 * what survives leaving, a second office for isolation, and a suspended office for the
 * error that is deliberately distinct from a permission failure.
 *
 * Activity, leads and production arrive as Phases 6–9 create their collections. This
 * grows with them rather than pretending to be the full fixture now.
 *
 *   pnpm seed:demo            create, leaving anything that already exists
 *   pnpm seed:demo --reset    empty the collections it owns first
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
import { JoinRequest, JoinRequestSchema } from '@/modules/org/join-request.schema';
import { formatAgentCode } from '@/modules/org/agent-code';

loadEnv();

/**
 * One password for every field account, so the sign-in panel stays readable. The three
 * that predate this keep their own, because the documentation quotes them.
 */
const FIELD_PASSWORD = 'demo password field';

type Role = 'ab' | 'aab' | 'agent';

interface Placed {
  id: string;
  ancestorIds: string[];
  depth: number;
}

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
  const Memberships = mongoose.model(Membership.name, MembershipSchema);
  const History = mongoose.model(MembershipHistory.name, MembershipHistorySchema);
  const JoinRequests = mongoose.model(JoinRequest.name, JoinRequestSchema);

  if (process.argv.includes('--reset')) {
    // Empty the collections rather than drop the database. An Atlas user with ordinary
    // read/write permissions cannot `dropDatabase` — the seed failed outright against
    // one — and emptying named collections will not take out a database someone pointed
    // at by mistake.
    const owned = [
      'memberships', 'membershipHistory', 'joinRequests', 'kpms', 'companies', 'users',
      'authTokens', 'auditLog', 'notifications', 'notificationPreferences', 'assets',
    ];
    for (const name of owned) {
      const { deletedCount } = await mongoose.connection.collection(name).deleteMany({});
      if (deletedCount) console.log(`cleared ${deletedCount} from ${name}`);
    }
    console.log(`reset ${dbName}`);
  }

  /** Idempotent: running the seed twice must not mint a second of anything. */
  async function user(
    email: string,
    fullName: string,
    opts: { password?: string; platformRole?: 'super_admin' | 'none'; status?: string } = {},
  ) {
    const existing = await Users.findOne({ email }).exec();
    if (existing) return existing;
    return Users.create({
      email,
      passwordHash: await passwords.hash(opts.password ?? FIELD_PASSWORD),
      fullName,
      platformRole: opts.platformRole ?? 'none',
      status: opts.status ?? 'active',
      // Pre-verified: the point of a demo tenant is to sign in, not to chase an inbox.
      emailVerifiedAt: clock.now(),
    });
  }

  async function company(name: string, slug: string) {
    return (
      (await Companies.findOne({ slug }).exec()) ??
      (await Companies.create({
        name, slug,
        defaultCurrency: 'IDR', defaultLocale: 'id-ID', defaultTimezone: 'Asia/Jakarta',
      }))
    );
  }

  async function office(
    companyId: string,
    code: string,
    branchName: string,
    opts: { ownerUserId?: string; status?: string; address?: string } = {},
  ) {
    const existing = await Kpms.findOne({ companyId, code }).exec();
    if (existing) return existing;
    return Kpms.create({
      companyId,
      code,
      branchName,
      address: opts.address ?? null,
      ownerUserId: opts.ownerUserId ?? null,
      timezone: 'Asia/Jakarta',
      settings: { ...DEFAULT_KPM_SETTINGS },
      counters: { nextAgentCodeSeq: 1 },
      status: opts.status ?? 'active',
    });
  }

  /**
   * Place somebody in an office.
   *
   * The agent code comes from the office counter, the same way the service issues one —
   * a seed that made codes up would not exercise the numbering that everything else
   * joins on.
   */
  async function place(
    kpm: { _id: unknown; code: string },
    userId: string,
    role: Role,
    leader: Placed | null,
    opts: { status?: 'active' | 'pending' | 'removed'; isKpmAdmin?: boolean } = {},
  ): Promise<Placed> {
    const kpmId = String(kpm._id);
    const existing = await Memberships.findOne({ kpmId, userId }).exec();
    if (existing) {
      return {
        id: String(existing._id),
        ancestorIds: existing.get('ancestorIds') as string[],
        depth: existing.get('depth') as number,
      };
    }

    const counted = await Kpms.findOneAndUpdate(
      { _id: kpm._id },
      { $inc: { 'counters.nextAgentCodeSeq': 1 } },
      { new: false },
    ).exec();
    const seq = (counted?.get('counters')?.nextAgentCodeSeq as number) ?? 1;
    const status = opts.status ?? 'active';
    const leaderId = leader ? leader.id : null;

    const created = await Memberships.create({
      kpmId,
      userId,
      agentCode: formatAgentCode(kpm.code, seq),
      agentSeq: seq,
      role,
      leaderId,
      ancestorIds: leader ? [...leader.ancestorIds, leader.id] : [],
      depth: leader ? leader.depth + 1 : 0,
      status,
      joinedAt: status === 'pending' ? null : clock.now(),
      removedAt: status === 'removed' ? clock.now() : null,
      recruitedByMembershipId: leaderId,
      adminAccess: opts.isKpmAdmin
        ? { isKpmAdmin: true, grantedByUserId: null, grantedAt: clock.now(), revokedAt: null }
        : { isKpmAdmin: false, grantedByUserId: null, grantedAt: null, revokedAt: null },
    });

    // History is written from the first day, not from the day a screen reads it.
    await History.create({
      kpmId, membershipId: String(created._id), eventType: 'joined',
      toRole: role, toLeaderId: leaderId, validFrom: clock.now(), validTo: null,
    });
    if (status === 'removed') {
      await History.create({
        kpmId, membershipId: String(created._id), eventType: 'removed',
        fromRole: role, validFrom: clock.now(), validTo: null,
        reason: 'Left the industry — seeded so the Removed tab has something to show',
      });
    }

    return {
      id: String(created._id),
      ancestorIds: created.get('ancestorIds') as string[],
      depth: created.get('depth') as number,
    };
  }

  /** Counts are derived, never incremented, so they cannot drift out of step. */
  async function recount(kpmId: string, membershipId: string) {
    const directs = await Memberships.find({ kpmId, leaderId: membershipId, status: 'active' }).exec();
    const counts = { ab: 0, aab: 0, agent: 0, total: directs.length };
    for (const d of directs) counts[d.get('role') as Role] += 1;
    const subtreeCount = await Memberships.countDocuments({
      kpmId, ancestorIds: membershipId, status: 'active',
    });
    await Memberships.updateOne({ _id: membershipId }, { $set: { directCounts: counts, subtreeCount } });
  }

  // ---------------------------------------------------------------- platform

  const superAdmin = await user('superadmin@agencyboost.test', 'Platform Operator', {
    password: 'demo super admin', platformRole: 'super_admin',
  });
  // A second one, because "a Super Admin cannot be impersonated" needs two to show.
  await user('root@agencyboost.test', 'Second Operator', { platformRole: 'super_admin' });

  const prudential = await company('Prudential', 'prudential');

  // ---------------------------------------------------------- KPM 0417, the main office

  const ownerUser = await user('owner@kpm0417.test', 'Wilson Tanoto', { password: 'demo password 0417' });
  const kpm0417 = await office(String(prudential._id), '0417', 'BSD City Branch', {
    ownerUserId: String(ownerUser._id),
    address: 'Jl. Raya Serpong, Tangerang Selatan',
  });
  const office0417 = { _id: kpm0417._id, code: kpm0417.get('code') as string };
  const id0417 = String(kpm0417._id);

  const owner = await place(office0417, String(ownerUser._id), 'ab', null);

  // Admin rights are orthogonal to hierarchy role: this one is an AB as well.
  const adminUser = await user('admin@kpm0417.test', 'Maya Halim');
  await place(office0417, String(adminUser._id), 'ab', owner, { isKpmAdmin: true });

  // An AB who is neither Owner nor Admin, with a unit of their own.
  const abUser = await user('agus@kpm0417.test', 'Agus Prasetyo');
  const ab = await place(office0417, String(abUser._id), 'ab', owner);

  const sariUser = await user('sari@kpm0417.test', 'Sari Puspita');
  const sari = await place(office0417, String(sariUser._id), 'aab', ab);

  // The case OD-23 settles: holds the role, leads nobody.
  const dewiUser = await user('dewi@kpm0417.test', 'Dewi Lestari');
  await place(office0417, String(dewiUser._id), 'aab', ab);

  const rinaUser = await user('rina@kpm0417.test', 'Rina Wijaya', { password: 'demo password rina' });
  await place(office0417, String(rinaUser._id), 'agent', sari);
  const budiUser = await user('budi@kpm0417.test', 'Budi Santoso');
  await place(office0417, String(budiUser._id), 'agent', sari);

  // Registered and waiting on a leader, with the request already sent.
  const pendingUser = await user('pending@kpm0417.test', 'Putri Anggraini');
  const pending = await place(office0417, String(pendingUser._id), 'agent', null, { status: 'pending' });
  if (!(await JoinRequests.findOne({ membershipId: pending.id }).exec())) {
    await JoinRequests.create({
      kpmId: id0417,
      membershipId: pending.id,
      leaderMembershipId: sari.id,
      status: 'pending',
    });
  }

  // Registered and has asked nobody yet — the untagged pool.
  const untaggedUser = await user('untagged@kpm0417.test', 'Fajar Nugroho');
  await place(office0417, String(untaggedUser._id), 'agent', null, { status: 'pending' });

  // Left the office. The row stays, and so does everything attached to it.
  const removedUser = await user('removed@kpm0417.test', 'Yanti Kusuma');
  await place(office0417, String(removedUser._id), 'agent', sari, { status: 'removed' });

  for (const id of [owner.id, ab.id, sari.id]) await recount(id0417, id);

  // ------------------------------------------------- KPM 0555, for cross-tenant checks

  const owner0555User = await user('owner@kpm0555.test', 'Hendra Wijaya');
  const kpm0555 = await office(String(prudential._id), '0555', 'Kelapa Gading Branch', {
    ownerUserId: String(owner0555User._id),
    address: 'Jl. Boulevard Raya, Jakarta Utara',
  });
  const office0555 = { _id: kpm0555._id, code: kpm0555.get('code') as string };
  const owner0555 = await place(office0555, String(owner0555User._id), 'ab', null);
  const agent0555User = await user('agent@kpm0555.test', 'Lina Marlina');
  await place(office0555, String(agent0555User._id), 'agent', owner0555);
  await recount(String(kpm0555._id), owner0555.id);

  // ------------------------------------------- a suspended office, and somebody in it

  const suspendedOwnerUser = await user('owner@kpm0999.test', 'Bagus Setiawan');
  const kpm0999 = await office(String(prudential._id), '0999', 'Suspended Branch', {
    ownerUserId: String(suspendedOwnerUser._id),
    status: 'suspended',
  });
  await place(
    { _id: kpm0999._id, code: kpm0999.get('code') as string },
    String(suspendedOwnerUser._id),
    'ab',
    null,
  );

  // ---------------------------------------------------------- in no office at all

  await user('newcomer@agencyboost.test', 'Nadia Safitri');

  void superAdmin;

  console.log(`
Seeded. Every field account uses the password "${FIELD_PASSWORD}" unless noted.

  PLATFORM
    superadmin@agencyboost.test   demo super admin     Super Admin
    root@agencyboost.test                              Super Admin — a second, so SA-on-SA can be refused

  KPM 0417 · BSD City Branch  (${id0417})
    owner@kpm0417.test           demo password 0417    KPM Owner, AB at the root
    admin@kpm0417.test                                 KPM Admin, and an AB — the two are independent
    agus@kpm0417.test                                  AB with a unit, neither Owner nor Admin
    sari@kpm0417.test                                  AAB leading two agents
    dewi@kpm0417.test                                  AAB leading nobody — the OD-23 case
    rina@kpm0417.test            demo password rina    Agent under Sari
    budi@kpm0417.test                                  Agent under Sari
    pending@kpm0417.test                               Registered, request sent to Sari, waiting
    untagged@kpm0417.test                              Registered, has asked nobody
    removed@kpm0417.test                               Removed — the row and its history stay

  KPM 0555 · Kelapa Gading Branch  (${String(kpm0555._id)})
    owner@kpm0555.test                                 KPM Owner — for cross-tenant checks
    agent@kpm0555.test                                 Agent

  KPM 0999 · Suspended Branch
    owner@kpm0999.test                                 Signing in returns TENANT_SUSPENDED

  NO OFFICE
    newcomer@agencyboost.test                          Brand new — starts at Register KPM

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
