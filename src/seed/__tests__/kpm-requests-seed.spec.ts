import mongoose from 'mongoose';
import { FixedClock } from '@/common/clock/clock.port';
import { RequestContext } from '@/common/context/request-context';
import { AuditLog, AuditLogSchema } from '@/modules/audit/audit-log.schema';
import { AuditService } from '@/modules/audit/audit.service';
import { Company, CompanySchema } from '@/modules/tenants/company.schema';
import { KpmRequest, KpmRequestSchema } from '@/modules/tenants/kpm-request.schema';
import { KpmRequestService } from '@/modules/tenants/kpm-request.service';
import { User, UserSchema } from '@/modules/users/user.schema';
import { clearCollections, startMongo, stopMongo } from '../../../test/mongo';
import { seedDemo } from '../demo';

const RUN_MS = 240_000;
const quiet = () => undefined;
const col = (name: string) => mongoose.connection.db!.collection(name);

/**
 * **A KPM request in production's shape, seeded** (P19-T3; UI-165, UI-168): Rudi Hartono signed up with Allianz Life,
 * and his request arrived as Prudential. Read back through the queue the Super Admin's page reads, so the card can be
 * reviewed in a browser: his phone, the company he signed up with beside the request's, and a verified address.
 */
describe('P19-T3 the KPM requests seed', () => {
  const clock = new FixedClock(new Date('2026-11-04T03:00:00Z'));
  let service: KpmRequestService;

  beforeAll(async () => {
    await startMongo();
    await clearCollections();
    await seedDemo({ clock, log: quiet });
    service = new KpmRequestService(
      mongoose.model(KpmRequest.name, KpmRequestSchema) as never,
      mongoose.model(Company.name, CompanySchema) as never,
      mongoose.model(User.name, UserSchema) as never,
      // Only the decided rows' offices are read through it, and this spec reads the pending one.
      { officesByIds: async () => new Map() } as never,
      new AuditService(mongoose.model(AuditLog.name, AuditLogSchema) as never),
      clock,
    );
  }, RUN_MS);
  afterAll(stopMongo);

  it('P19-T3 AC-1 AC-2 seeds a pending request from an Allianz Life applicant that arrived as Prudential', async () => {
    const queue = await service.queue(RequestContext.platform('seed-spec'));
    const rudi = queue.find((r) => r.branchName === 'Bekasi Utara Branch');
    expect(rudi).toMatchObject({
      status: 'pending',
      companyName: 'Prudential',
      requestedByName: 'Rudi Hartono',
      requestedByEmail: 'rudi@agencyboost.test',
      requestedByPhone: '+62 812 7788 1001',
      requesterCompanyName: 'Allianz Life',
      requesterEmailVerified: true,
    });
    // Pending first: the two that were there, and his.
    expect(queue.filter((r) => r.status === 'pending')).toHaveLength(3);
  });

  it('P19-T3 a second run seeds it once', async () => {
    await seedDemo({ clock, log: quiet });
    expect(await col('kpmRequests').countDocuments({ branchName: 'Bekasi Utara Branch' })).toBe(1);
    expect(await col('users').countDocuments({ email: 'rudi@agencyboost.test' })).toBe(1);
  }, RUN_MS);
});
