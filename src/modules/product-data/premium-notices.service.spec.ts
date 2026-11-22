import mongoose from 'mongoose';
import { FixedClock } from '@/common/clock/clock.port';
import { Product, ProductSchema } from '@/modules/products/product.schema';
import { Company, CompanySchema } from '@/modules/tenants/company.schema';
import { Kpm, KpmSchema } from '@/modules/tenants/kpm.schema';
import { User, UserSchema } from '@/modules/users/user.schema';
import { clearCollections, startMongo, stopMongo } from '../../../test/mongo';
import { PremiumNoticesService } from './premium-notices.service';
import { RateTable, RateTableSchema } from './rate-table.schema';

const col = (name: string) => mongoose.connection.db!.collection(name);
const oid = (id: string) => new mongoose.Types.ObjectId(id);
const PRU = '66f0000000000000000000c1';
const TABLE = '66f0000000000000000000f1';

/**
 * **P19.15-T4 AC-4 — a notice is claimed before it is sent, and given back when the send fails** (ADR-0261 §5): the
 * table version's marker is written in one conditional update, so nobody is told twice; a send that throws writes the
 * marker back to empty, so the next run tries again. Today is the office's, the Clock port's in Jakarta.
 */
describe('P19.15-T4 PremiumNoticesService', () => {
  // 00:10 on 12 November 2026 in Jakarta is still the 11th in UTC: the run's today is the office's.
  const clock = new FixedClock(new Date('2026-11-11T17:10:00Z'));
  const service = (send: jest.Mock) => new PremiumNoticesService(
    mongoose.model(RateTable.name, RateTableSchema) as never,
    mongoose.model(Product.name, ProductSchema) as never,
    mongoose.model(Company.name, CompanySchema) as never,
    mongoose.model(Kpm.name, KpmSchema) as never,
    mongoose.model(User.name, UserSchema) as never,
    { send } as never,
    clock,
  );

  beforeAll(startMongo);
  afterAll(stopMongo);
  beforeEach(async () => {
    await clearCollections();
    for (const name of ['users', 'rateTables', 'products', 'companies', 'kpms']) await col(name).deleteMany({});
    await col('users').insertOne({ _id: oid('66f0000000000000000000e1'), platformRole: 'super_admin', status: 'active', deletedAt: null });
    await col('rateTables').insertOne({
      _id: oid(TABLE), companyId: PRU, productId: '66f0000000000000000000d1', version: 1, effectiveFrom: '2026-01-01',
      effectiveTo: '2026-11-20', activatedAt: new Date('2025-12-01'), turnedOffAt: null, deletedAt: null,
      expiryNoticeSentAt: null, activationNoticeSentAt: new Date('2026-01-01'),
    });
  });

  it('P19.15-T4 AC-4 reads today in Jakarta, not the server\'s UTC day', async () => {
    const report = await service(jest.fn().mockResolvedValue(undefined)).run();
    expect(report.today).toBe('2026-11-12');
    expect(report.ending).toEqual({ tables: 1, recipients: 1 });
  });

  it('P19.15-T4 AC-4 a send that fails gives the claim back, and the next run sends it', async () => {
    const failing = jest.fn().mockRejectedValue(new Error('database away'));
    expect((await service(failing).run()).ending).toEqual({ tables: 0, recipients: 0 });
    expect((await col('rateTables').findOne({ _id: oid(TABLE) }))!.expiryNoticeSentAt).toBeNull();
    const working = jest.fn().mockResolvedValue(undefined);
    expect((await service(working).run()).ending).toEqual({ tables: 1, recipients: 1 });
    expect(working).toHaveBeenCalledWith(expect.objectContaining({
      kpmId: null, templateId: 'premium_table.ending', payload: expect.objectContaining({ productName: null, companyName: null }),
    }));
  });

  it('P19.15-T4 AC-4 a version another run has already claimed sends nothing', async () => {
    const send = jest.fn().mockResolvedValue(undefined);
    const racing = service(send);
    await col('rateTables').updateOne({ _id: oid(TABLE) }, { $set: { expiryNoticeSentAt: new Date('2026-11-11T17:09:00Z') } });
    expect((await racing.run()).ending.tables).toBe(0);
    expect(send).not.toHaveBeenCalled();
  });
});
