import mongoose from 'mongoose';
import { FixedClock } from '@/common/clock/clock.port';
import { clearCollections, startMongo, stopMongo } from '../../../test/mongo';
import { seedProductDataAccessFixture } from '../product-data-access-fixture';

const col = (name: string) => mongoose.connection.db!.collection(name);
const oid = (id: string) => new mongoose.Types.ObjectId(id);
const PRU = '66f0000000000000000000c1';
const MAYA = '66f0000000000000000000e2';
const ROOT = '66f0000000000000000000e1';
const OWNER = '66f0000000000000000000e3';
const KPM = '66f0000000000000000000a1';

/**
 * **P19.15-T4 — *Kelola data produk* and the notices, seeded** (`product-data-access-fixture.ts`): Maya, 0417's Admin,
 * is given Prudential once, audited as the Super Admin's; the daily run goes over the demo's premium tables, so the
 * Super Admin's bell holds the ending notice and the Owner's the announcement; a second seed writes neither again.
 */
describe('P19.15-T4 the Kelola data produk seed', () => {
  // 10:00 on 12 November 2026 in Jakarta.
  const clock = new FixedClock(new Date('2026-11-12T03:00:00Z'));

  beforeAll(startMongo);
  afterAll(stopMongo);
  beforeEach(async () => {
    await clearCollections();
    for (const name of ['users', 'companies', 'kpms', 'products', 'rateTables', 'productDataGrants', 'notifications', 'auditLog']) {
      await col(name).deleteMany({});
    }
    await col('users').insertMany([
      { _id: oid(ROOT), fullName: 'Platform Operator', email: 'superadmin@agencyboost.test', platformRole: 'super_admin', status: 'active', deletedAt: null },
      { _id: oid(MAYA), fullName: 'Maya Halim', email: 'admin@kpm0417.test', platformRole: 'none', status: 'active', deletedAt: null },
      { _id: oid(OWNER), fullName: 'Wilson Tanoto', email: 'owner@kpm0417.test', platformRole: 'none', status: 'active', deletedAt: null },
    ]);
    await col('companies').insertOne({ _id: oid(PRU), name: 'Prudential', slug: 'prudential', kind: 'insurer', deletedAt: null });
    await col('kpms').insertOne({ _id: oid(KPM), companyId: PRU, code: '0417', status: 'active', ownerUserId: OWNER, deletedAt: null });
    await col('products').insertMany([
      { _id: oid('66f0000000000000000000d1'), companyId: PRU, code: 'PRUWELL_MEDICAL', name: 'PRUWell Medical' },
      { _id: oid('66f0000000000000000000d2'), companyId: PRU, code: 'PRUCRITICAL_BENEFIT_88', name: 'PRUCritical Benefit 88' },
    ]);
    const table = (id: string, productId: string, over: Record<string, unknown>) => ({
      _id: oid(id), companyId: PRU, productId, version: 1, effectiveFrom: '2026-04-01', effectiveTo: null,
      activatedAt: new Date('2026-03-20T03:00:00Z'), turnedOffAt: null, expiryNoticeSentAt: null,
      activationNoticeSentAt: null, deletedAt: null, ...over,
    });
    await col('rateTables').insertMany([
      table('66f0000000000000000000f1', '66f0000000000000000000d1', { effectiveTo: '2026-11-22' }),
      table('66f0000000000000000000f2', '66f0000000000000000000d2', {}),
    ]);
  });

  const seed = () => seedProductDataAccessFixture({
    clock, companyId: PRU, maya: { userId: MAYA }, superAdminUserId: ROOT,
  });

  it('P19.15-T4 AC-2 gives Maya Kelola data produk for Prudential, audited as the Super Admin\'s, once', async () => {
    const first = await seed();
    expect(first.granted).toBe(true);
    expect(await col('productDataGrants').findOne({ userId: MAYA })).toMatchObject({
      companyIds: [PRU], grantedBy: ROOT, revokedAt: null,
    });
    expect(await col('auditLog').findOne({ action: 'product_data_grant.granted' })).toMatchObject({
      actorUserId: ROOT, kpmId: null, after: { userId: MAYA, companyIds: [PRU] },
    });
    expect((await seed()).granted).toBe(false);
    expect(await col('productDataGrants').countDocuments()).toBe(1);
  });

  it('P19.15-T4 AC-4 the daily run over the demo\'s tables: the Super Admin\'s ending notice, the Owner\'s announcement, once', async () => {
    const first = await seed();
    expect(first.notices).toEqual({
      today: '2026-11-12', ending: { tables: 1, recipients: 1 }, started: { tables: 2, recipients: 2 },
    });
    expect(await col('notifications').findOne({ userId: ROOT })).toMatchObject({
      templateId: 'premium_table.ending', kpmId: null, payload: { productName: 'PRUWell Medical', effectiveTo: '2026-11-22' },
    });
    expect(await col('notifications').countDocuments({ userId: OWNER, templateId: 'premium_table.started', kpmId: KPM })).toBe(2);
    expect(first.guide).toContain('admin@kpm0417.test');
    expect((await seed()).notices).toMatchObject({ ending: { tables: 0 }, started: { tables: 0 } });
    expect(await col('notifications').countDocuments()).toBe(3);
  });
});
