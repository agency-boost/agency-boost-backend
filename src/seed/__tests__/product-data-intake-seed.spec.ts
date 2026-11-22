import mongoose from 'mongoose';
import { FixedClock } from '@/common/clock/clock.port';
import { openQuestions } from '@/modules/product-data/intake-understanding';
import { clearCollections, startMongo, stopMongo } from '../../../test/mongo';
import { DEMO_INTAKE_FILE, seedProductDataIntakeFixture } from '../product-data-intake-fixture';

const col = (name: string) => mongoose.connection.db!.collection(name);
const oid = (id: string) => new mongoose.Types.ObjectId(id);
const PRU = '66f0000000000000000000c1';
const ROOT = '66f0000000000000000000e1';

/**
 * **P19.15-T2, T3 — *Unggah file* and *Ilustrasi*, seeded as stored data** (`product-data-intake-fixture.ts`): a Prudential
 * upload waiting on three questions over two cards, and a draft illustration of PRUWell Medical — written once, and
 * never by calling the AI.
 */
describe('P19.15-T3 the Unggah file seed', () => {
  const clock = new FixedClock(new Date('2026-11-12T03:00:00Z'));

  beforeAll(startMongo);
  afterAll(stopMongo);
  beforeEach(async () => {
    await clearCollections();
    for (const name of ['products', 'uploadIntakes', 'intakeItems', 'illustrations', 'auditLog']) await col(name).deleteMany({});
    await col('products').insertMany([
      { _id: oid('66f0000000000000000000d1'), companyId: PRU, code: 'PRUWELL_MEDICAL', name: 'PRUWell Medical', deletedAt: null },
      { _id: oid('66f0000000000000000000d2'), companyId: PRU, code: 'PRUCRITICAL_BENEFIT_88', name: 'PRUCritical Benefit 88', deletedAt: null },
      { _id: oid('66f0000000000000000000d3'), companyId: PRU, code: 'PRUCERAH', name: 'PRUCerah', deletedAt: null },
    ]);
  });

  const seed = () => seedProductDataIntakeFixture({ clock, companyId: PRU, superAdminUserId: ROOT });

  it('P19.15-T3 AC-2 AC-3 writes an upload in needs_answers: a premium-table card and a rules card, three questions', async () => {
    expect(await seed()).toMatchObject({ intake: true, illustration: true });
    const intake = await col('uploadIntakes').findOne({ companyId: PRU });
    expect(intake).toMatchObject({ status: 'needs_answers', files: [{ name: DEMO_INTAKE_FILE, kind: 'xlsx' }, { kind: 'image' }] });
    const cards = await col('intakeItems').find({ intakeId: String(intake!._id) }).sort({ createdAt: 1 }).toArray();
    expect(cards.map((c) => [c.kind, c.status])).toEqual([['premium_table', 'needs_answers'], ['product_rules', 'needs_answers']]);
    expect(cards[0].diff[0]).toMatchObject({ old: 'Belum ada', new: 'Tabel premi baru, berlaku 1 Des 2026, 6 baris', source: { fileName: DEMO_INTAKE_FILE, sheet: 'Tarif' } });
    expect(cards[1].diff[0]).toMatchObject({ label: 'UP minimum', old: 'Rp 100 Jt', new: 'Rp 150 Jt' });
    expect(cards.flatMap((c) => openQuestions(c.questions)).map((q) => q.kind)).toEqual(['column', 'type_number', 'date']);
    expect(await col('auditLog').countDocuments({ action: 'intake.uploaded' })).toBe(1);
  });

  it('P19.15-T2 AC-1 writes a draft illustration of PRUWell Medical with blocks and their pages', async () => {
    await seed();
    const row = await col('illustrations').findOne({ companyId: PRU });
    expect(row).toMatchObject({ status: 'draft', productId: '66f0000000000000000000d1', illustrationDate: '2026-11-01' });
    expect(row!.blocks.map((b: { block: string; page: number }) => [b.block, b.page])).toEqual([['manfaat', 3], ['masa', 5], ['pengecualian', 9]]);
  });

  it('writes nothing again on a second run', async () => {
    await seed();
    expect(await seed()).toMatchObject({ intake: false, illustration: false });
    expect(await col('uploadIntakes').countDocuments()).toBe(1);
    expect(await col('illustrations').countDocuments()).toBe(1);
  });
});
