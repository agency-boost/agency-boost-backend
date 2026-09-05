/**
 * Seeds a demo tenant so the API can actually be exercised.
 *
 * Phase 2 scope: a platform Super Admin, one company, one KPM, and that office's Owner.
 * Members, activity, leads and the rest arrive as Phases 3–9 create their collections —
 * this grows with them rather than pretending to be the full fixture now.
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
    await mongoose.connection.dropDatabase();
    console.log(`dropped database ${dbName}`);
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

  console.log(`
Seeded.

  Super Admin   ${SUPER_ADMIN.email}   ${SUPER_ADMIN.password}
  KPM Owner     ${OWNER.email}          ${OWNER.password}
  Agent         ${AGENT.email}          ${AGENT.password}
                (no membership yet — this is the "new agent" state, valid by design)

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
