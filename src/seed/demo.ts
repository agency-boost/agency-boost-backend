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
import { DEFAULT_ORG_LADDER } from '@/domain/constants';
import {
  CompanyOrgLevel, CompanyOrgLevelSchema,
} from '@/modules/tenants/company-org-level.schema';
import { DEFAULT_KPM_SETTINGS, Kpm, KpmSchema } from '@/modules/tenants/kpm.schema';
import { generateLeaderCode } from '@/modules/org/leader-code';
import { Membership, MembershipSchema } from '@/modules/org/membership.schema';
import {
  MembershipHistory, MembershipHistorySchema,
} from '@/modules/org/membership-history.schema';
import { Group, GroupSchema } from '@/modules/org/group.schema';
import { JoinRequest, JoinRequestSchema } from '@/modules/org/join-request.schema';
import { KpmRequest, KpmRequestSchema } from '@/modules/tenants/kpm-request.schema';
import { AuditLog, AuditLogSchema } from '@/modules/audit/audit-log.schema';
import { Notification, NotificationSchema } from '@/modules/notifications/notification.schema';
import { NotificationTemplate } from '@/modules/notifications/notification.types';

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
  const OrgLevels = mongoose.model(CompanyOrgLevel.name, CompanyOrgLevelSchema);
  const Kpms = mongoose.model(Kpm.name, KpmSchema);
  const Memberships = mongoose.model(Membership.name, MembershipSchema);
  const History = mongoose.model(MembershipHistory.name, MembershipHistorySchema);
  const Groups = mongoose.model(Group.name, GroupSchema);
  const JoinRequests = mongoose.model(JoinRequest.name, JoinRequestSchema);
  const KpmRequests = mongoose.model(KpmRequest.name, KpmRequestSchema);
  const Audit = mongoose.model(AuditLog.name, AuditLogSchema);
  const Notifications = mongoose.model(Notification.name, NotificationSchema);

  if (process.argv.includes('--reset')) {
    // Empty the collections rather than drop the database. An Atlas user with ordinary
    // read/write permissions cannot `dropDatabase` — the seed failed outright against
    // one — and emptying named collections will not take out a database someone pointed
    // at by mistake.
    const owned = [
      'memberships', 'membershipHistory', 'joinRequests', 'groups', 'kpms', 'companies', 'users',
      'authTokens', 'auditLog', 'notifications', 'notificationPreferences', 'assets',
      'kpmRequests',
    ];
    for (const name of owned) {
      const { deletedCount } = await mongoose.connection.collection(name).deleteMany({});
      if (deletedCount) console.log(`cleared ${deletedCount} from ${name}`);
      /*
       * **And the indexes.** Emptying a collection leaves its indexes exactly as they
       * were, so a database seeded before a schema change keeps enforcing the old shape —
       * `memberships { kpmId, agentCode }` was unique until ADR-0017, and a reseed hit
       * `E11000` on the member who leaves and rejoins. Mongoose rebuilds what the schema
       * says on the next write. A deployed database gets the same thing from migration
       * `0002`; this is `--reset` meaning reset.
       */
      await mongoose.connection.collection(name).dropIndexes().catch(() => undefined);
    }
    console.log(`reset ${dbName}`);
  }

  /** Idempotent: running the seed twice must not mint a second of anything. */
  /**
   * A person, and the insurer that issued them a code.
   *
   * `companyId` and `agentCode` are on the account, not the membership (ADR-0017): the
   * code is the insurer's and it exists before any office admits them. A Super Admin
   * sells for nobody and carries neither, which is the pair the unique index excludes.
   *
   * The codes below deliberately do **not** look like `KPM0417-001`. That format was ours
   * and it is gone; a real Prudential producer id is what a demo should show.
   */
  let issued = 0;
  async function user(
    email: string,
    fullName: string,
    opts: {
      password?: string;
      platformRole?: 'super_admin' | 'none';
      status?: string;
      companyId?: string;
      agentCode?: string;
    } = {},
  ) {
    const existing = await Users.findOne({ email }).exec();
    if (existing) return existing;
    const platformRole = opts.platformRole ?? 'none';
    const sellsForSomebody = platformRole !== 'super_admin';
    issued += 1;
    return Users.create({
      email,
      passwordHash: await passwords.hash(opts.password ?? FIELD_PASSWORD),
      fullName,
      platformRole,
      companyId: sellsForSomebody ? (opts.companyId ?? String(prudential._id)) : null,
      agentCode: sellsForSomebody
        ? (opts.agentCode ?? `PRU-${String(80000 + issued)}`)
        : null,
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
    kpm: { _id: unknown; code: string; companyId: string },
    userId: string,
    role: Role,
    leader: Placed | null,
    opts: {
      status?: 'active' | 'pending' | 'removed';
      isKpmAdmin?: boolean;
      grantedByUserId?: string;
      /** Backdates a grant, so "Admin since" reads as a date rather than as today. */
      adminSinceDaysAgo?: number;
      /** Backdates a removal, so the Removed tab does not read as though it happened today. */
      removedDaysAgo?: number;
    } = {},
  ): Promise<Placed> {
    const kpmId = String(kpm._id);
    // A removed row is not "already placed". Re-running the seed must not adopt somebody's
    // old membership as their current one — that is the mistake P3-T7 AC-4 forbids, and the
    // partial unique index draws the same line.
    const existing = await Memberships.findOne({
      kpmId,
      userId,
      status: { $ne: 'removed' },
    }).exec();
    if (existing) {
      return {
        id: String(existing._id),
        ancestorIds: existing.get('ancestorIds') as string[],
        depth: existing.get('depth') as number,
      };
    }

    const counted = await Kpms.findOneAndUpdate(
      { _id: kpm._id },
      { $inc: { 'counters.nextMemberSeq': 1 } },
      { new: false },
    ).exec();
    const seq = (counted?.get('counters')?.nextMemberSeq as number) ?? 1;

    // Copied off the account, never minted here. The membership carries it so the roster,
    // the search and the production import have one field to read; it cannot drift,
    // because the code is immutable and an office sits inside one company.
    const account = await Users.findOne({ _id: userId }).exec();
    const agentCode = account?.get('agentCode') as string | null;
    if (!agentCode) throw new Error(`No agent code on the account for ${userId}`);
    const status = opts.status ?? 'active';
    const leaderId = leader ? leader.id : null;

    // The rung the role names, on this office's company ladder. The seed writes straight
    // to the model rather than through HierarchyService, so it resolves this itself —
    // and a missing rung throws here rather than producing a membership with no level.
    const level = await OrgLevels.findOne({
      companyId: kpm.companyId, code: role.toUpperCase(), status: 'active', deletedAt: null,
    }).exec();
    if (!level) throw new Error(`No ${role.toUpperCase()} rung on the ladder for KPM ${kpm.code}`);

    const created = await Memberships.create({
      kpmId,
      userId,
      agentCode,
      // The same generator production uses, so a seeded code is shaped like a real one.
      leaderCode: generateLeaderCode(),
      agentSeq: seq,
      orgLevelId: String(level._id),
      role,
      leaderId,
      ancestorIds: leader ? [...leader.ancestorIds, leader.id] : [],
      depth: leader ? leader.depth + 1 : 0,
      status,
      joinedAt: status === 'pending' ? null : clock.now(),
      removedAt: status === 'removed' ? daysAgo(opts.removedDaysAgo ?? 0) : null,
      recruitedByMembershipId: leaderId,
      // A grant nobody made and nobody dated reads as a bug on Manage KPM admins, so
      // the seed records both — the Owner, months ago.
      adminAccess: opts.isKpmAdmin
        ? {
            isKpmAdmin: true,
            grantedByUserId: opts.grantedByUserId ?? null,
            grantedAt: daysAgo(opts.adminSinceDaysAgo ?? 0),
            revokedAt: null,
          }
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
        fromRole: role, validFrom: daysAgo(opts.removedDaysAgo ?? 0), validTo: null,
        reason: 'Left the industry — seeded so the Removed tab has something to show',
      });
    }

    return {
      id: String(created._id),
      ancestorIds: created.get('ancestorIds') as string[],
      depth: created.get('depth') as number,
    };
  }

  /**
   * A role change that happened before today.
   *
   * The Role change log reads `membershipHistory`, so an office seeded only with
   * `joined` rows shows an empty log — which is indistinguishable from a broken screen.
   * The `toRole` here always matches the role the person actually holds; a seeded
   * transition that contradicts the membership would be a lie in the audit trail.
   */
  const daysAgo = (days: number) =>
    new Date(clock.now().getTime() - days * 24 * 60 * 60 * 1000);

  async function promotedEarlier(
    kpmId: string,
    membership: Placed,
    from: Role,
    to: Role,
    actor: Placed,
    reason: string,
    days: number,
  ) {
    if (await History.findOne({ membershipId: membership.id, eventType: 'role_changed' }).exec()) {
      return;
    }
    await History.create({
      kpmId,
      membershipId: membership.id,
      eventType: 'role_changed',
      fromRole: from,
      toRole: to,
      validFrom: daysAgo(days),
      validTo: null,
      actorMembershipId: actor.id,
      reason,
    });
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

  // **The insurer first.** `user()` defaults everybody who is not a Super Admin to a
  // Prudential account, and reading a `const` before its declaration throws. The two
  // operators below happen to skip that branch, so ordering it the other way round
  // survived only by short-circuit evaluation — which is not a thing to rely on.
  const prudential = await company('Prudential', 'prudential');

  const superAdmin = await user('superadmin@agencyboost.test', 'Platform Operator', {
    password: 'demo super admin', platformRole: 'super_admin',
  });
  // A second one, because "a Super Admin cannot be impersonated" needs two to show.
  await user('root@agencyboost.test', 'Second Operator', { platformRole: 'super_admin' });

  /**
   * Prudential's ladder (P3.5-T7 AC-5), junior first, exactly as the prototype writes it:
   * *"Role ladder: Agent → AAB → AB"* (`Superadmin.html:311`).
   *
   * The codes are what `memberships.orgLevelId` will resolve to in T8, and they match the
   * `HierarchyRole` enum lower-cased — which is the whole reason v1's one-to-one mapping
   * lets the enum keep working while the reference becomes the stored truth.
   */
  for (const { code, label, displayOrder } of DEFAULT_ORG_LADDER) {
    const existing = await OrgLevels.findOne({ companyId: String(prudential._id), code }).exec();
    if (!existing) {
      await OrgLevels.create({
        companyId: String(prudential._id), code, label, displayOrder,
        status: 'active', archivedAt: null, deletedAt: null,
      });
    }
  }

  // ---------------------------------------------------------- KPM 0417, the main office

  const ownerUser = await user('owner@kpm0417.test', 'Wilson Tanoto', { password: 'demo password 0417' });
  const kpm0417 = await office(String(prudential._id), '0417', 'BSD City Branch', {
    ownerUserId: String(ownerUser._id),
    address: 'Jl. Raya Serpong, Tangerang Selatan',
  });
  const office0417 = {
    _id: kpm0417._id,
    code: kpm0417.get('code') as string,
    companyId: kpm0417.get('companyId') as string,
  };
  const id0417 = String(kpm0417._id);

  const owner = await place(office0417, String(ownerUser._id), 'ab', null);

  // Admin rights are orthogonal to hierarchy role: this one is an AB as well.
  const adminUser = await user('admin@kpm0417.test', 'Maya Halim');
  const admin = await place(office0417, String(adminUser._id), 'ab', owner, {
    isKpmAdmin: true,
    grantedByUserId: String(ownerUser._id),
    adminSinceDaysAgo: 234,
  });
  if (!(await History.findOne({ membershipId: admin.id, eventType: 'admin_granted' }).exec())) {
    await History.create({
      kpmId: id0417, membershipId: admin.id, eventType: 'admin_granted',
      validFrom: daysAgo(234), validTo: null, actorMembershipId: owner.id,
      actorUserId: String(ownerUser._id),
    });
  }

  // An AB who is neither Owner nor Admin, with a unit of their own.
  const abUser = await user('agus@kpm0417.test', 'Agus Prasetyo');
  const ab = await place(office0417, String(abUser._id), 'ab', owner);

  const sariUser = await user('sari@kpm0417.test', 'Sari Puspita');
  const sari = await place(office0417, String(sariUser._id), 'aab', ab);

  // The case OD-23 settles: holds the role, leads nobody.
  const dewiUser = await user('dewi@kpm0417.test', 'Dewi Lestari');
  const dewi = await place(office0417, String(dewiUser._id), 'aab', ab);

  // Both AABs were agents first. Without these the Role change log is empty, and an
  // empty log reads as a screen that does not work.
  await promotedEarlier(id0417, sari, 'agent', 'aab', ab, 'Ready to lead a unit of her own', 62);
  await promotedEarlier(id0417, dewi, 'agent', 'aab', ab, 'Took the AAB track after Q2', 21);

  const rinaUser = await user('rina@kpm0417.test', 'Rina Wijaya', { password: 'demo password rina' });
  const rina = await place(office0417, String(rinaUser._id), 'agent', sari);
  const budiUser = await user('budi@kpm0417.test', 'Budi Santoso');
  const budi = await place(office0417, String(budiUser._id), 'agent', sari);

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
  await place(office0417, String(removedUser._id), 'agent', sari, {
    status: 'removed',
    removedDaysAgo: 48,
  });

  // Came back. A second, live membership for the same person, with its own agent code —
  // the case P3-T7 AC-4 exists for, and the one a reader will not believe until they
  // see the same name twice on the roster.
  await place(office0417, String(removedUser._id), 'agent', sari);

  for (const id of [owner.id, ab.id, sari.id]) await recount(id0417, id);

  /**
   * Informal groups, and the Core Leader tag.
   *
   * Seeded so the Groups tab has something to show and the person page has a tag to
   * render. Deliberately cutting across the hierarchy — Rina reports to Sari, Maya to
   * the Owner — because that is the whole point of a group: it is not the tree.
   */
  const groupSeeds = [
    { name: 'New Agent Mentoring Circle', owner: sari.id, members: [rina.id, budi.id] },
    { name: 'Top Producers 2026', owner: owner.id, members: [ab.id, sari.id] },
  ];
  for (const seed of groupSeeds) {
    const existing = await Groups.findOne({ kpmId: id0417, name: seed.name }).exec();
    const group =
      existing ??
      (await Groups.create({
        kpmId: id0417,
        name: seed.name,
        ownerMembershipId: seed.owner,
        status: 'active',
        createdByMembershipId: owner.id,
      }));
    await Memberships.updateMany(
      { _id: { $in: seed.members } },
      { $addToSet: { groupIds: String(group._id) } },
    ).exec();
  }
  // Core Leader gates Leader Forum co-editing (Phase 14) and nothing else.
  await Memberships.updateMany(
    { _id: { $in: [ab.id, sari.id] } },
    { $set: { isCoreLeader: true } },
  ).exec();

  /*
   * Readable leader codes, so the sign-in panel and the docs can quote them.
   *
   * `HierarchyService` generates a random six-character code with every membership; the
   * seed overwrites two of them with something a person can read off a page. That is the
   * one thing it does differently from the API, and it is why they are quotable.
   *
   * There is nothing else to seed here. Invites used to have four states — working, spent,
   * withdrawn, expired — and each needed a fixture. A leader code has one (P3.6-T1).
   */
  for (const [membershipId, code] of [[sari.id, 'SARI01'], [ab.id, 'AGUS01']] as const) {
    await Memberships.updateOne({ _id: membershipId }, { $set: { leaderCode: code } });
  }

  // ------------------------------------------------- KPM 0555, for cross-tenant checks

  const owner0555User = await user('owner@kpm0555.test', 'Hendra Wijaya');
  const kpm0555 = await office(String(prudential._id), '0555', 'Kelapa Gading Branch', {
    ownerUserId: String(owner0555User._id),
    address: 'Jl. Boulevard Raya, Jakarta Utara',
  });
  const office0555 = {
    _id: kpm0555._id,
    code: kpm0555.get('code') as string,
    companyId: kpm0555.get('companyId') as string,
  };
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
    {
      _id: kpm0999._id,
      code: kpm0999.get('code') as string,
      companyId: kpm0999.get('companyId') as string,
    },
    String(suspendedOwnerUser._id),
    'ab',
    null,
  );

  // ------------------------------------------------- offices asking to exist

  /**
   * `/admin/kpm-requests` had no rows, because nothing seeded the collection it reads.
   *
   * The approved one is `owner@kpm0555.test` asking for the office they now run, so the
   * second tenant has a provenance rather than appearing from nowhere. The two pending
   * ones are the screen's actual work; the declined one carries a reason, because the
   * decline dialog requires one and a reader should see what that looks like afterwards.
   */
  async function kpmRequest(
    email: string,
    fullName: string,
    branchName: string,
    fields: Record<string, unknown>,
  ) {
    const who = await user(email, fullName);
    const existing = await KpmRequests.findOne({ branchName }).exec();
    if (existing) return existing;
    return KpmRequests.create({
      companyId: String(prudential._id),
      branchName,
      requestedByUserId: String(who._id),
      note: null,
      status: 'pending',
      ...fields,
    });
  }

  await kpmRequest('ade@agencyboost.test', 'Ade Kurniawan', 'Bandung Kota Branch', {
    note: 'Six agents ready to move across from a branch that is closing.',
    createdAt: daysAgo(3),
  });
  await kpmRequest('maya@agencyboost.test', 'Maya Sari', 'Surabaya Timur Branch', {
    note: null,
    createdAt: daysAgo(1),
  });
  await kpmRequest('tomi@agencyboost.test', 'Tomi Halim', 'Medan Selatan Branch', {
    status: 'declined',
    decidedAt: daysAgo(9),
    decidedByUserId: String(superAdmin._id),
    reason: 'Too close to an existing office. Reapply once the territory split is settled.',
    createdAt: daysAgo(12),
  });
  await kpmRequest('owner@kpm0555.test', 'Hendra Wijaya', 'Kelapa Gading Branch', {
    status: 'approved',
    decidedAt: daysAgo(40),
    decidedByUserId: String(superAdmin._id),
    createdKpmId: String(kpm0555._id),
    createdAt: daysAgo(45),
  });

  // ------------------------------------------------------------- the inbox

  /**
   * Every screen in the product has a bell, and it was empty for everybody.
   *
   * Only the seven templates whose subject matter Phase 3 actually built are seeded. The
   * other three in-app templates — goals, coaching, event reminders — say things like
   * *"Open Goals to accept it"*, and pointing a reader at a screen that does not exist is
   * worse than an empty row. They arrive with their phases.
   *
   * Each one describes something that genuinely happened in this fixture: Putri really
   * did ask Sari, Sari and Dewi really were promoted, Yanti really was removed and came
   * back. A notification about an event the rest of the seed does not contain would send
   * somebody looking for a record that is not there.
   */
  async function notify(
    to: { userId: string; membershipId: string | null },
    templateId: string,
    payload: Record<string, unknown>,
    opts: { readDaysAgo?: number; sentDaysAgo: number },
  ) {
    const existing = await Notifications.findOne({
      userId: to.userId, templateId, createdAt: daysAgo(opts.sentDaysAgo),
    }).exec();
    if (existing) return;
    const at = daysAgo(opts.sentDaysAgo);
    await Notifications.create({
      kpmId: id0417,
      membershipId: to.membershipId,
      userId: to.userId,
      templateId,
      payload,
      delivery: {
        in_app: { status: 'sent', at },
        email: { status: 'sent', at },
      },
      readAt: opts.readDaysAgo === undefined ? null : daysAgo(opts.readDaysAgo),
      createdAt: at,
    });
  }

  // Sari: an open request to act on, and the promotion she already read about.
  await notify(
    { userId: String(sariUser._id), membershipId: sari.id },
    NotificationTemplate.JOIN_REQUEST_RECEIVED,
    { fullName: 'Putri Anggraini' },
    { sentDaysAgo: 2 },
  );
  await notify(
    { userId: String(sariUser._id), membershipId: sari.id },
    NotificationTemplate.ROLE_CHANGED,
    { reason: 'Ready to lead a unit of her own' },
    { sentDaysAgo: 62, readDaysAgo: 61 },
  );
  await notify(
    { userId: String(dewiUser._id), membershipId: dewi.id },
    NotificationTemplate.ROLE_CHANGED,
    { reason: 'Took the AAB track after Q2' },
    { sentDaysAgo: 21, readDaysAgo: 20 },
  );

  // Rina and Budi: how each of them arrived. Two different doors, two templates.
  await notify(
    { userId: String(rinaUser._id), membershipId: rina.id },
    NotificationTemplate.JOIN_REQUEST_APPROVED,
    {},
    { sentDaysAgo: 30, readDaysAgo: 29 },
  );
  await notify(
    { userId: String(budiUser._id), membershipId: budi.id },
    NotificationTemplate.MEMBER_TAGGED_BY_LEADER,
    {},
    { sentDaysAgo: 5 },
  );

  // Maya: the grant the Owner made, which is a row on /people/admins as well.
  await notify(
    { userId: String(adminUser._id), membershipId: null },
    NotificationTemplate.ADMIN_ACCESS_CHANGED,
    { granted: true },
    { sentDaysAgo: 200, readDaysAgo: 199 },
  );

  // Yanti: removed, then back. Both rows, in that order.
  await notify(
    { userId: String(removedUser._id), membershipId: null },
    NotificationTemplate.MEMBER_REMOVED,
    { reason: 'Left for a competitor, then came back three weeks later.' },
    { sentDaysAgo: 50, readDaysAgo: 49 },
  );
  await notify(
    { userId: String(removedUser._id), membershipId: null },
    NotificationTemplate.JOIN_REQUEST_APPROVED,
    {},
    { sentDaysAgo: 28 },
  );

  // Fajar has asked nobody *now* — because the first time he asked, he was declined.
  await notify(
    { userId: String(untaggedUser._id), membershipId: null },
    NotificationTemplate.JOIN_REQUEST_DECLINED,
    { reason: 'My unit is full this quarter — ask Agus, he has room.' },
    { sentDaysAgo: 8 },
  );

  // ------------------------------------------------------------ the audit log

  /**
   * `/admin/audit` read an empty collection, because the seed writes through models
   * rather than through the services that stamp audit rows.
   *
   * These are the actions the rest of the fixture implies, with the real action names the
   * services emit — a row here that invented a name would teach the wrong vocabulary to
   * anyone reading the screen to learn what the log contains.
   */
  async function audited(
    action: string,
    targetCollection: string,
    fields: Record<string, unknown>,
  ) {
    const existing = await Audit.findOne({ action, ...fields }).exec();
    if (existing) return;
    await Audit.create({
      kpmId: null,
      actorUserId: String(superAdmin._id),
      action,
      targetCollection,
      ...fields,
    });
  }

  await audited('company.created', 'companies', {
    targetId: String(prudential._id),
    after: { name: 'Prudential', slug: 'prudential' },
    createdAt: daysAgo(120),
  });
  /*
   * `kpmId: null` on all of these, which is not an oversight.
   *
   * `AuditService.record` stamps `kpmId: ctx.kpmId`, and a Super Admin provisioning an
   * office has no tenant context — so provisioning is a **platform-level** row, which is
   * exactly the side `/admin/audit` shows by default. Seeding them under the office they
   * created would put them behind the scope toggle and misrepresent the shape the
   * service actually writes.
   */
  for (const [kpm, days] of [[kpm0417, 110], [kpm0555, 40], [kpm0999, 30]] as const) {
    await audited('kpm.created', 'kpms', {
      targetId: String(kpm._id),
      after: { code: kpm.get('code'), branchName: kpm.get('branchName') },
      createdAt: daysAgo(days),
    });
  }
  await audited('kpm.owner_assigned', 'kpms', {
    targetId: id0417,
    after: { ownerUserId: String(ownerUser._id) },
    createdAt: daysAgo(109),
  });
  await audited('kpm.suspended', 'kpms', {
    targetId: String(kpm0999._id),
    before: { status: 'active' },
    after: { status: 'suspended', reason: 'Unpaid platform fees' },
    createdAt: daysAgo(14),
  });
  await audited('kpm_request.declined', 'kpmRequests', {
    after: { branchName: 'Medan Selatan Branch' },
    createdAt: daysAgo(9),
  });
  // Tenant-level rows, so the screen's "Show platform level" toggle has both sides.
  await audited('kpm_admin.granted', 'memberships', {
    kpmId: id0417,
    actorUserId: String(ownerUser._id),
    targetMembershipId: admin.id,
    after: { granted: true },
    createdAt: daysAgo(200),
  });
  await audited('member.role_changed', 'memberships', {
    kpmId: id0417,
    actorUserId: String(ownerUser._id),
    targetMembershipId: sari.id,
    before: { role: 'agent' },
    after: { role: 'aab' },
    createdAt: daysAgo(62),
  });
  await audited('member.removed', 'memberships', {
    kpmId: id0417,
    actorUserId: String(sariUser._id),
    targetMembershipId: rina.id,
    onBehalfOf: true,
    after: { reason: 'Left for a competitor' },
    createdAt: daysAgo(50),
  });

  /*
   * The pair is deliberately asymmetric, because the service writes it that way.
   *
   * Starting a session is done *as the Super Admin* — no tenant context, no
   * `effectiveUserId`, so it is a platform row. Ending one is done *while impersonating*,
   * so the context carries the target's office and `record` fills `effectiveUserId` in.
   * One support session therefore appears on both sides of the scope toggle, which is
   * worth seeing before somebody assumes a missing row means a missing event.
   */
  await audited('impersonation.started', 'users', {
    targetId: String(rinaUser._id),
    after: { reason: 'Support ticket 118 — cannot see her unit', minutes: 60 },
    createdAt: daysAgo(6),
  });
  await audited('impersonation.ended', 'users', {
    kpmId: id0417,
    effectiveUserId: String(rinaUser._id),
    targetId: String(rinaUser._id),
    createdAt: daysAgo(6),
  });

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
    admin@kpm0417.test                                 KPM Admin since Jan 2026, granted by the Owner,
                                                       and an AB — the two are independent
    agus@kpm0417.test                                  AB with a unit, neither Owner nor Admin
    sari@kpm0417.test                                  AAB leading two agents
    dewi@kpm0417.test                                  AAB leading nobody — the OD-23 case
                                                       Sari and Dewi were promoted from Agent,
                                                       so /people/members Role change log has rows
    rina@kpm0417.test            demo password rina    Agent under Sari
    budi@kpm0417.test                                  Agent under Sari
    pending@kpm0417.test                               Registered, request sent to Sari, waiting
    untagged@kpm0417.test                              Registered, has asked nobody
    removed@kpm0417.test                               Removed once, rejoined — two memberships,
                                                       two agent codes, one person (P3-T7 AC-4)

  KPM 0555 · Kelapa Gading Branch  (${String(kpm0555._id)})
    owner@kpm0555.test                                 KPM Owner — for cross-tenant checks
    agent@kpm0555.test                                 Agent

  KPM 0999 · Suspended Branch
    owner@kpm0999.test                                 Signing in returns TENANT_SUSPENDED

  NO OFFICE
    newcomer@agencyboost.test                          Brand new — starts at Register KPM

  GROUPS in KPM 0417, at /people/members → Groups
    New Agent Mentoring Circle   owned by Sari · Rina and Budi tagged
    Top Producers 2026           owned by the Owner · Agus and Sari tagged
    Agus and Sari also carry the Core Leader tag

  KPM REQUESTS at /admin/kpm-requests  (Super Admin)
    Bandung Kota Branch          pending, with a note — ade@agencyboost.test
    Surabaya Timur Branch        pending, no note — maya@agencyboost.test
    Medan Selatan Branch         declined, with the reason on the row
    Kelapa Gading Branch         approved — this is where KPM 0555 came from

  NOTIFICATIONS at /notifications  (the bell on every screen)
    sari@kpm0417.test            1 unread: Putri's request. Plus her own promotion, read
    budi@kpm0417.test            1 unread: tagged by a leader
    untagged@kpm0417.test        1 unread: declined, with the leader's reason
    removed@kpm0417.test         1 unread: back in. Plus the removal, read
    rina / dewi / admin          read-only inboxes — the "nothing new" state
    owner@kpm0417.test           empty, deliberately: nothing in this fixture is
                                 addressed to the Owner, and an empty inbox is a
                                 state worth seeing too

  AUDIT LOG at /admin/audit  (Super Admin)
    Platform-level and tenant-level rows, so the scope toggle has both sides.
    Includes an impersonation.started / .ended pair on Rina.
    The log also accumulates from real API use, so expect more than the seed writes —
    run with --reset for only these.

  LEADER CODES for KPM 0417, at /join?code=<code>
    SARI01   Sari's. Redeeming it lands you in her unit, active, with no approval
    AGUS01   Agus's, the same
    Everybody else has one too — a random six characters, on their own membership.
    There is nothing to withdraw and nothing that expires: a code is issued once,
    with the membership, and lasts as long as it does. Sign in first — the preview
    and the redemption both need an account.

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
