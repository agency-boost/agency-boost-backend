import mongoose from 'mongoose';
import { FixedClock } from '@/common/clock/clock.port';
import { RequestContext } from '@/common/context/request-context';
import { AuditLog, AuditLogSchema } from '@/modules/audit/audit-log.schema';
import { AuditService } from '@/modules/audit/audit.service';
import { MembershipRepository } from '@/modules/org/membership.repository';
import { Membership, MembershipSchema } from '@/modules/org/membership.schema';
import { PlatformReads } from '@/modules/reporting/platform/platform-reads.service';
import { Company, CompanySchema } from '@/modules/tenants/company.schema';
import { Kpm, KpmSchema } from '@/modules/tenants/kpm.schema';
import { User, UserSchema } from '@/modules/users/user.schema';
import { clearCollections, startMongo, stopMongo } from '../../../test/mongo';
import { seedDemo } from '../demo';
import { REGISTERED_ACCOUNTS_SEED } from '../registered-accounts-fixture';

const RUN_MS = 240_000;
const quiet = () => undefined;
const model = <T>(name: string, schema: mongoose.Schema<T>) => mongoose.models[name] ?? mongoose.model(name, schema);

/**
 * **Registered, and in no KPM yet — seeded** (P19.12-T2 AC-1, AC-2; ADR-0245 §1): read back through the read the Super
 * Admin's *Akun terdaftar* tab calls, so the client's case can be reviewed in a browser on staging — the leader with no
 * KPM found by email and by name, verified and signed in; the account signed in unverified; and *Tanpa KPM* holding the
 * seed's other accounts in no office, while *Punya KPM* holds the offices' members.
 */
describe('P19.12-T2 the registered-accounts seed', () => {
  const clock = new FixedClock(new Date('2026-11-11T03:00:00Z'));
  let reads: PlatformReads;
  const sa = RequestContext.platform('seed-spec');

  beforeAll(async () => {
    await startMongo();
    await clearCollections();
    await seedDemo({ clock, log: quiet });
    reads = new PlatformReads(
      model(Kpm.name, KpmSchema) as never, model(Company.name, CompanySchema) as never, model(User.name, UserSchema) as never,
      new MembershipRepository(model(Membership.name, MembershipSchema) as never),
      null as never, null as never, null as never, null as never, null as never, null as never, null as never,
      null as never, null as never, new AuditService(model(AuditLog.name, AuditLogSchema) as never), clock,
    );
  }, RUN_MS);
  afterAll(stopMongo);

  it('P19.12-T2 AC-2 the leader with no KPM is found by email and by name: verified, signed in, Belum punya KPM', async () => {
    const { leader } = REGISTERED_ACCOUNTS_SEED;
    for (const q of ['hadi.leader@', 'Hadi Santoso']) {
      const page = await reads.accounts(sa, { q });
      expect(page.rows).toEqual([expect.objectContaining({
        fullName: leader.fullName, email: leader.email, company: expect.objectContaining({ name: 'Prudential' }),
        registeredOn: '2026-11-09', emailVerified: true, lastSignInOn: '2026-11-10', kpmCount: 0,
      })]);
    }
  });

  it('P19.12-T2 AC-1 Tanpa KPM holds the client’s two and the seed’s other accounts in no office; Punya KPM the members', async () => {
    const none = await reads.accounts(sa, { kpm: 'none' });
    // Newest first by the moment each was made; the rest of the seed is stamped by the wall clock, so no order is asserted.
    const citra = none.rows.find((r) => r.email === REGISTERED_ACCOUNTS_SEED.unverified.email);
    expect(citra).toMatchObject({ emailVerified: false, lastSignInOn: '2026-11-11', kpmCount: 0 });
    expect(none.rows.find((r) => r.email === REGISTERED_ACCOUNTS_SEED.leader.email)).toMatchObject({ kpmCount: 0 });
    expect(none.rows.map((r) => r.email)).toEqual(expect.arrayContaining([
      'newcomer@agencyboost.test', 'unverified@agencyboost.test', 'rudi@agencyboost.test',
    ]));
    // No Super Admin is an account to find.
    const every = (await reads.accounts(sa, { q: 'agencyboost.test' })).rows.map((r) => r.email);
    expect(every).not.toContain('superadmin@agencyboost.test');
    expect(every).not.toContain('root@agencyboost.test');
    const some = await reads.accounts(sa, { kpm: 'some', q: 'kpm0417' });
    expect(some.total).toBeGreaterThan(5);
    for (const row of some.rows) expect(row.kpmCount).toBeGreaterThan(0);
  });

  it('P19.12-T2 a second run makes neither again, and keeps their days', async () => {
    await seedDemo({ clock, log: quiet });
    const users = mongoose.connection.db!.collection('users');
    for (const seed of Object.values(REGISTERED_ACCOUNTS_SEED)) {
      expect(await users.countDocuments({ email: seed.email })).toBe(1);
    }
    expect((await reads.accounts(sa, { q: 'citra.baru' })).rows[0]).toMatchObject({ registeredOn: '2026-11-11' });
  }, RUN_MS);
});
