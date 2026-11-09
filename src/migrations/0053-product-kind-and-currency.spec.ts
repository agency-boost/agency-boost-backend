import mongoose from 'mongoose';
import { RequestContext } from '@/common/context/request-context';
import { SEED_PRODUCTS } from '@/domain/constants';
import { Kpm, KpmSchema } from '@/modules/tenants/kpm.schema';
import { ProductCatalogService } from '@/modules/products/product-catalog.service';
import { clearCollections, startMongo, stopMongo } from '../../test/mongo';
import { configModule } from '../../test/config-module';
import { up } from './0053-product-kind-and-currency';

const NOW = new Date('2026-11-05T02:00:00Z');
const COMPANY = '66f0000000000000000000c1';
const KPM = '66f0000000000000000000a1';
const agent = new RequestContext('u-agent', 'none', {
  membershipId: 'mem-agent', kpmId: KPM, orgLevelCode: 'AGENT', hierarchyRole: 'agent', status: 'active',
  isKpmOwner: false, isKpmAdmin: false, directCount: 0,
} as never);

/**
 * **0053 — every product a base, attached to nothing, sold in IDR** (P19.4-T4 AC-3, AC-12; the riders spec's *Done
 * when* 1; ADR-0209 §1, §8): a product written before the fields gets them, a product that states one keeps it, a
 * second run writes nothing, and the agents' catalogue reads the same before and after.
 */
describe('0053 — every product a base, attached to nothing, sold in IDR (ADR-0209)', () => {
  const db = () => mongoose.connection.db as mongoose.mongo.Db;
  let wired: ReturnType<typeof configModule>;
  beforeAll(async () => {
    await startMongo();
    wired = configModule(NOW);
  });
  afterAll(stopMongo);
  beforeEach(async () => {
    await clearCollections();
    await (wired.companies as { create: (d: unknown) => Promise<unknown> })
      .create({ _id: COMPANY, name: 'Sequis', slug: 'sequis' });
    await mongoose.model(Kpm.name, KpmSchema).create({
      _id: KPM, companyId: COMPANY, code: '0417', branchName: '0417', timezone: 'Asia/Jakarta',
    });
  });

  /** The catalogue as migration 0013 wrote it: the shape of its day, with none of the three fields. */
  const oldShelf = async () => {
    await db().collection('products').insertMany(SEED_PRODUCTS.map((product) => ({
      ...product, companyId: COMPANY, commissionSchedule: [], replacedByProductId: null, version: 1, deletedAt: null,
    })));
  };

  it('P19.4-T4 AC-3 makes every old product a base with no attachments, IDR, and nothing changes for agents', async () => {
    await oldShelf();
    const catalog = new ProductCatalogService(wired.kpmProducts, wired.clock);
    const before = await catalog.catalog(agent);
    const drawerBefore = await catalog.product(agent, 'PRUMAPAN');

    expect(await up(db())).toEqual({ kind: 31, attachesTo: 31, currencies: 31 });

    const rows = await db().collection('products').find({ companyId: COMPANY }).toArray();
    expect(rows.every((r) => r.kind === 'base' && r.attachesTo.length === 0 && r.currencies.join() === 'IDR')).toBe(true);
    // No version moved: the values are the ones a missing field was read as.
    expect(rows.every((r) => r.version === 1)).toBe(true);
    expect(await catalog.catalog(agent)).toEqual(before);
    expect(await catalog.product(agent, 'PRUMAPAN')).toEqual(drawerBefore);
  });

  it('P19.4-T4 AC-3 keeps what a product states, and a second run writes nothing', async () => {
    await oldShelf();
    await db().collection('products').updateOne(
      { companyId: COMPANY, code: 'PRUMAPAN' }, { $set: { kind: 'rider', attachesTo: ['x'], currencies: ['USD'] } },
    );
    expect(await up(db())).toEqual({ kind: 30, attachesTo: 30, currencies: 30 });
    expect(await db().collection('products').findOne({ code: 'PRUMAPAN' }))
      .toMatchObject({ kind: 'rider', attachesTo: ['x'], currencies: ['USD'] });
    expect(await up(db())).toEqual({ kind: 0, attachesTo: 0, currencies: 0 });
  });

  it('P19.4-T4 AC-3 writes nothing on a database with no products, twice', async () => {
    await db().collection('products').deleteMany({});
    expect(await up(db())).toEqual({ kind: 0, attachesTo: 0, currencies: 0 });
    expect(await up(db())).toEqual({ kind: 0, attachesTo: 0, currencies: 0 });
  });
});
