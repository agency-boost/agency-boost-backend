import mongoose from 'mongoose';
import { FixedClock } from '@/common/clock/clock.port';
import { PremiumCalculator } from '@/modules/product-data/premium-calculator.service';
import { RateRow, RateRowSchema, RateTable, RateTableSchema } from '@/modules/product-data/rate-table.schema';
import { clearCollections, startMongo, stopMongo } from '../../../test/mongo';
import { seedRateTableFixture } from '../rate-table-fixture';

const col = (name: string) => mongoose.connection.db!.collection(name);
const oid = (id: string) => new mongoose.Types.ObjectId(id);
const PRU = '66f0000000000000000000c1';
const ROOT = '66f0000000000000000000e1';
const PCB = '66f0000000000000000000d2';

/**
 * **P19.15-T1 — the premium tables, seeded** (`rate-table-fixture.ts`): sample numbers only. PCB88 in force with a
 * version scheduled a month ahead, PRUCinta with gaps, PRU Anugerah Syariah ending in 12 days — written once.
 */
describe('P19.15-T1 the premium table seed', () => {
  const clock = new FixedClock(new Date('2026-11-12T03:00:00Z'));
  const payTerms = [
    { key: 'y5', label: '5 tahun', years: 5, toAge: null, single: false, maxEntryAge: 60, default: false },
    { key: 'y10', label: '10 tahun', years: 10, toAge: null, single: false, maxEntryAge: 60, default: true },
    { key: 'y15', label: '15 tahun', years: 15, toAge: null, single: false, maxEntryAge: 50, default: false },
    { key: 'single', label: 'Sekali bayar', years: null, toAge: null, single: true, maxEntryAge: 60, default: false },
  ];

  beforeAll(startMongo);
  afterAll(stopMongo);
  beforeEach(async () => {
    await clearCollections();
    const product = (id: string, code: string, over: Record<string, unknown>) => ({
      _id: oid(id), companyId: PRU, code, name: code, channel: 'conventional', category: 'ci', currencies: ['IDR'],
      calcType: 'up_premium', deletedAt: null, version: 1, ...over,
    });
    await col('products').insertMany([
      product(PCB, 'PRUCRITICAL_BENEFIT_88', { entryAge: { min: 1, max: 60 }, payTerms }),
      product('66f0000000000000000000d3', 'PRUCINTA', { entryAge: { min: 10, max: 60 }, payTerms: [{ ...payTerms[1], label: 'Bayar 10 th · lindung 20 th' }] }),
      product('66f0000000000000000000d4', 'PRUANUGERAH_SYARIAH', { channel: 'syariah', entryAge: { min: 21, max: 70 }, payTerms: payTerms.slice(0, 3) }),
    ]);
  });

  const seed = () => seedRateTableFixture({ clock, companyId: PRU, superAdminUserId: ROOT });

  it('P19.15-T1 writes PCB88 in force, a version scheduled a month ahead, a table with gaps and one ending soon', async () => {
    const out = await seed();
    expect(out.versions).toBe(4);
    const pcb = await col('rateTables').find({ productId: PCB }).sort({ version: 1 }).toArray();
    expect(pcb.map((t) => [t.version, t.effectiveFrom, t.gapCount])).toEqual([[1, '2026-04-01', 0], [2, '2026-12-12', 0]]);
    expect(pcb[0].testCases.every((c: { match: boolean }) => c.match)).toBe(true);
    expect(pcb[0].rules).toMatchObject({ upStep: 100_000_000, upMin: 10_000_000_000 });
    const cinta = await col('rateTables').findOne({ productId: '66f0000000000000000000d3' });
    expect(cinta!.gapCount).toBeGreaterThan(0);
    const anugerah = await col('rateTables').findOne({ productId: '66f0000000000000000000d4' });
    expect(anugerah!.effectiveTo).toBe('2026-11-24');
    expect((await col('products').findOne({ _id: oid(PCB) }))!.rateTableId).toBe(String(pcb[1]._id));
  });

  it('P19.15-T1 the agent’s card calculates with it: Rp500 jt for a man of 35, monthly', async () => {
    await seed();
    const model = (name: string, schema: mongoose.Schema) => mongoose.models[name] ?? mongoose.model(name, schema);
    const calculator = new PremiumCalculator(model(RateTable.name, RateTableSchema) as never, model(RateRow.name, RateRowSchema) as never, clock);
    const table = await calculator.tableFor(PCB, '2026-11-12', 35);
    expect(table?.effectiveFrom).toBe('2026-04-01');
    // 3 + 35² × 0,0077 = 12,43 ‰ (sample) → Rp6.215.000 a year.
    expect(table?.rows.find((r) => r.gender === 'male' && r.payTerm === 'y10')?.rate).toBe(12.43);
  });

  it('writes nothing again on a second run', async () => {
    await seed();
    expect((await seed()).versions).toBe(0);
    expect(await col('rateTables').countDocuments()).toBe(4);
  });
});
