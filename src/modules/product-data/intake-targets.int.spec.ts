import mongoose from 'mongoose';
import { FixedClock } from '@/common/clock/clock.port';
import { RequestContext } from '@/common/context/request-context';
import { AuditLog, AuditLogSchema } from '@/modules/audit/audit-log.schema';
import { AuditService } from '@/modules/audit/audit.service';
import { KpmProductConfig, KpmProductConfigSchema } from '@/modules/products/kpm-product-config.schema';
import { KpmProductConfigRepository } from '@/modules/products/kpm-product.repository';
import { Product, ProductSchema } from '@/modules/products/product.schema';
import { ProductService } from '@/modules/products/product.service';
import { Company, CompanySchema } from '@/modules/tenants/company.schema';
import { User, UserSchema } from '@/modules/users/user.schema';
import { startMongo, stopMongo } from '../../../test/mongo';
import type { RateRowInput } from './intake-apply-plan';
import { IntakeCatalogue } from './intake-catalogue';
import { RateTableIntakeTargets } from './intake-targets.service';
import { ProductRulesService } from './product-rules.service';
import { RateRow, RateRowSchema, RateTable, RateTableSchema } from './rate-table.schema';
import { RateTableService } from './rate-table.service';

const NOW = new Date('2026-11-12T03:00:00Z');
const PRU = '66f0000000000000000000c1';
const PCB88 = '66f0000000000000000000d1';
const ROOT = RequestContext.platform('root');
const oid = (id: string) => new mongoose.Types.ObjectId(id);

const row = (age: number, rate: number): RateRowInput => ({
  age, gender: 'male', smoker: null, plan: null, payTerm: 'y10', currency: 'IDR', frequency: null, basis: 'per_mille', rate,
  bandMin: null, bandMax: null,
});

/**
 * **P19.15-T3 AC-4 — a confirmed card reaches T1's own flows** (ADR-0259 §4; ADR-0258), with T1's real services over a
 * real database: a premium table is a **draft** version, source `intake`, its rows exactly as given; rules with no table
 * in force go through *Isian*'s write; with one in force they make a new draft holding its rows and the new rules.
 */
describe('P19.15-T3 AC-4 Unggah file through T1’s flows (intake-targets.service.ts)', () => {
  const db = () => mongoose.connection.db!;
  let targets: RateTableIntakeTargets;
  let tables: RateTableService;

  beforeAll(async () => {
    await startMongo();
    const model = (name: string, schema: mongoose.Schema) => mongoose.model(name, schema) as never;
    const clock = new FixedClock(NOW);
    const audit = new AuditService(model(AuditLog.name, AuditLogSchema));
    const products = model(Product.name, ProductSchema);
    const companies = model(Company.name, CompanySchema);
    const rows = model(RateRow.name, RateRowSchema);
    tables = new RateTableService(model(RateTable.name, RateTableSchema), rows, products, model(User.name, UserSchema), audit, clock);
    const productService = new ProductService(products, companies, audit, clock, new KpmProductConfigRepository(model(KpmProductConfig.name, KpmProductConfigSchema)));
    targets = new RateTableIntakeTargets(tables, new ProductRulesService(productService, tables, clock), new IntakeCatalogue(products, companies), rows);
  });

  afterAll(stopMongo);

  beforeEach(async () => {
    for (const name of ['companies', 'products', 'rateTables', 'rateRows', 'auditLog']) await db().collection(name).deleteMany({});
    await db().collection('companies').insertOne({ _id: oid(PRU), name: 'Prudential', slug: 'prudential', kind: 'insurer', deletedAt: null });
    await db().collection('products').insertOne({
      _id: oid(PCB88), companyId: PRU, code: 'PRUCRITICAL_BENEFIT_88', name: 'PCB88', channel: 'conventional', category: 'ci',
      sortOrder: 1, version: 1, lifecycle: 'active', deletedAt: null, currencies: ['IDR'], proposalFields: [], pdfDetail: [],
      calcType: 'up_premium', upMin: 10_000_000_000, entryAge: { min: 1, max: 60 },
      payTerms: [{ key: 'y10', label: '10 tahun', years: 10, toAge: null, single: false, maxEntryAge: 60, default: true }],
    });
  });

  it('makes a premium table a draft version from the rows exactly as the card holds them', async () => {
    const made = await targets.createRateTableDraft(ROOT, {
      companyId: PRU, productId: PCB88, rows: [row(30, 1.25), row(31, 1.31)], rules: { upMin: 15_000_000_000 },
      effectiveFrom: '2026-12-01', effectiveTo: null, source: { fileName: 'tarif.xlsx', assetKey: 'k', intakeItemId: 'it-1' },
    });
    const table = await db().collection('rateTables').findOne({ _id: oid(made.rateTableId) });
    expect(table).toMatchObject({
      version: 1, activatedAt: null, effectiveFrom: '2026-12-01', rowCount: 2,
      source: { fileName: 'tarif.xlsx', type: 'intake', assetKey: 'k', intakeItemId: 'it-1' }, rules: { upMin: 15_000_000_000 },
    });
    expect((await db().collection('rateRows').find({ rateTableId: made.rateTableId }).toArray()).map((r) => [r.age, r.rate])).toEqual([[30, 1.25], [31, 1.31]]);
    expect(await targets.inForceRows(PRU, PCB88, '2026-12-05')).toBeNull(); // a draft is in force nowhere
  });

  it('applies rules through Isian while no table is in force, and reads them back as the card’s old values', async () => {
    expect(await targets.applyRules(ROOT, { companyId: PRU, productId: PCB88, rules: { upMin: 15_000_000_000, entryAgeMax: 55, payTermMaxAge: { y10: 50 } }, effectiveFrom: '2026-12-01', intakeItemId: 'it-1' }))
      .toEqual({ kind: 'product', id: PCB88 });
    const product = await db().collection('products').findOne({ _id: oid(PCB88) });
    expect(product).toMatchObject({ upMin: 15_000_000_000, entryAge: { min: 1, max: 55 }, payTerms: [expect.objectContaining({ key: 'y10', maxEntryAge: 50 })] });
    const now = await targets.productNow(PRU, PCB88, '2026-11-12');
    expect(now?.rules).toMatchObject({ upMin: 15_000_000_000, entryAgeMax: 55, payTermMaxAge: { y10: 50 } });
    expect(now?.table).toBeNull();
  });

  it('makes rules a new draft with the in-force rows when a table is in force, never editing the activated one', async () => {
    const made = await targets.createRateTableDraft(ROOT, {
      companyId: PRU, productId: PCB88, rows: [row(30, 1.25)], rules: {}, effectiveFrom: '2026-04-01', effectiveTo: null,
      source: { fileName: 'tarif.xlsx', assetKey: null, intakeItemId: 'it-0' },
    });
    await db().collection('rateTables').updateOne({ _id: oid(made.rateTableId) }, { $set: { activatedAt: NOW } });
    expect(await targets.inForceRows(PRU, PCB88, '2026-11-12')).toMatchObject({ rateTableId: made.rateTableId, rows: [expect.objectContaining({ age: 30, rate: 1.25 })] });

    const ref = await targets.applyRules(ROOT, { companyId: PRU, productId: PCB88, rules: { upMin: 15_000_000_000 }, effectiveFrom: '2026-12-01', intakeItemId: 'it-2' });
    expect(ref.kind).toBe('rate_table');
    const draft = await db().collection('rateTables').findOne({ _id: oid(ref.id) });
    expect(draft).toMatchObject({ version: 2, activatedAt: null, effectiveFrom: '2026-12-01', rowCount: 1, rules: { upMin: 15_000_000_000 }, source: { intakeItemId: 'it-2' } });
    expect(await db().collection('rateTables').findOne({ _id: oid(made.rateTableId) })).toMatchObject({ version: 1, rules: expect.not.objectContaining({ upMin: 15_000_000_000 }) });
  });
});
