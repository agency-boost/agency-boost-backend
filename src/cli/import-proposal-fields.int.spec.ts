import { Writable } from 'node:stream';
import mongoose from 'mongoose';
import { SEED_PRODUCTS } from '@/domain/constants';
import { proposalFieldsHash } from '@/modules/products/proposal-fields-import';
import { PRUDENTIAL_PROPOSAL_ROWS } from '@/modules/products/proposal-fields-prudential';
import { clearCollections, startMongo, stopMongo } from '../../test/mongo';
import { configModule } from '../../test/config-module';
import { IMPORT_ACTOR, parseArgs, run, USAGE } from './import-proposal-fields';

const NOW = new Date('2026-11-05T03:00:00Z');
const COMPANY = '66f0000000000000000000c1';

function capture(): Writable & { text: () => string } {
  const chunks: string[] = [];
  const stream = new Writable({ write(chunk, _e, done) { chunks.push(String(chunk)); done(); } });
  return Object.assign(stream, { text: () => chunks.join('') });
}

/**
 * **P19.7-T1 AC-4, P19.14-T2 AC-5 — the Prudential list of 11 November, imported** (ADR-0225 §10; ADR-0255 §9): the
 * operator's command against the in-memory database the way the VM runs it — its own connection, the environment it is
 * given — onto a company holding the Prudential catalogue the seed gives every company, over the draft of 3 November
 * wherever nobody edited it since.
 */
describe('P19.7-T1 / P19.14-T2 import-proposal-fields', () => {
  let env: Record<string, string>;
  let wired: ReturnType<typeof configModule>;
  const db = () => mongoose.connection.db!;
  const product = (code: string) => db().collection('products').findOne({ companyId: COMPANY, code });

  beforeAll(async () => {
    const uri = await startMongo();
    env = { MONGODB_URI: uri, MONGODB_DB_NAME: mongoose.connection.db!.databaseName };
    wired = configModule(NOW);
  });
  afterAll(stopMongo);
  beforeEach(async () => {
    await clearCollections();
    await db().collection('companies').insertOne({
      _id: new mongoose.Types.ObjectId(COMPANY), name: 'Prudential', slug: 'prudential', deletedAt: null,
    });
    await wired.products.seedForCompany(COMPANY);
  });

  const io = () => {
    const out = capture();
    const err = capture();
    return { stdout: out, stderr: err, env, out, err };
  };

  it('P19.14-T2 AC-5 maps the list’s 18 rows to 20 product codes; three are production’s alone', () => {
    expect(PRUDENTIAL_PROPOSAL_ROWS).toHaveLength(18);
    expect(PRUDENTIAL_PROPOSAL_ROWS.flatMap((r) => r.codes)).toEqual([
      'PRUWELL_MEDICAL', 'PRUWELL_MEDICAL_SYARIAH', 'PRUWELL_HEALTH', 'PRUWELL_HEALTH_SYARIAH', 'PRUSEHAT',
      'PRUCRITICAL_BENEFIT_88', 'PRUCRITICAL_AMANAH', 'PRUSOLUSI_KONDISI_KRITIS_SYARIAH', 'PRUCINTA',
      'PRUANUGERAH_SYARIAH', 'PRUCARE_360_SYARIAH', 'PRUFUTURE', 'PRUHERITAGE_SYARIAH', 'PRULADY', 'PRUCERAH_PLUS',
      'PRUCERAH', 'PRUTAHAPAN_CEMERLANG', 'PRUSMART_PLAN', 'PRUMAPAN', 'PRUPROSPER',
    ]);
    const seeded = new Set(SEED_PRODUCTS.map((p) => p.code));
    expect(PRUDENTIAL_PROPOSAL_ROWS.flatMap((r) => r.codes).filter((c) => !seeded.has(c)))
      .toEqual(['PRUCARE_360_SYARIAH', 'PRUCERAH_PLUS', 'PRUPROSPER']);
  });

  it('P19.14-T2 AC-5 writes each product’s fields and calculation fields, reports the codes it lacks, and creates nothing', async () => {
    const call = io();
    expect(await run(['prudential'], call)).toBe(0);
    expect(call.out.text()).toContain('written (17)');
    expect(call.out.text()).toContain('no such product (3): PRUCARE_360_SYARIAH, PRUCERAH_PLUS, PRUPROSPER');
    expect(await db().collection('products').countDocuments({ code: 'PRUPROSPER' })).toBe(0);

    const medical = await product('PRUWELL_MEDICAL');
    expect(medical).toMatchObject({
      proposalTypeLabel: 'KESEHATAN', calcType: 'plan_priced', entryAge: { min: 1, max: 75 }, needTag: 'HOSPITAL',
      smokerRated: false, frequencies: [], rateTableId: null, version: 2,
      proposalFieldsSource: { import: 'prudential-2026-11-11', hash: expect.any(String) },
    });
    expect(medical!.proposalFields.map((f: { key: string; type: string }) => [f.key, f.type]))
      .toEqual([['wilayah', 'chips'], ['kamar', 'chips'], ['saver', 'chips'], ['plan', 'derived']]);
    // ★ on Wilayah, Kamar and the plan; not on Saver. Nothing is a draft: the list was checked field by field.
    expect(medical!.proposalFields.map((f: { showOnSummary: boolean; draft: boolean }) => [f.showOnSummary, f.draft]))
      .toEqual([[true, false], [true, false], [false, false], [true, false]]);
    expect(medical!.planRule.rules[0]).toEqual({ when: { wilayah: 'Indonesia', kamar: '2 tempat tidur' }, value: 'Bronze A' });
    expect(medical!.payTerms).toEqual([{ key: 'renew_99', label: 'Diperbarui tiap tahun s/d usia 99', years: null, toAge: 99, single: false, maxEntryAge: null, default: true }]);
  });

  it('P19.14-T2 AC-4 gives each pay term its maximum entry age, and the bold one as default', async () => {
    await run(['prudential'], io());
    expect((await product('PRUCRITICAL_BENEFIT_88'))!.payTerms.map((t: { key: string; maxEntryAge: number; single: boolean; default: boolean }) =>
      [t.key, t.maxEntryAge, t.single, t.default])).toEqual([['y5', 60, false, false], ['y10', 60, false, true], ['y15', 50, false, false], ['single', 60, true, false]]);
    expect((await product('PRUHERITAGE_SYARIAH'))!.payTerms.map((t: { key: string; toAge: number | null }) => [t.key, t.toAge]))
      .toEqual([['y5', null], ['y10', null], ['y15', null], ['to_60', 60], ['to_99', 99]]);
    // *[cek]*: an entry age the list does not give stays unknown.
    expect((await product('PRUFUTURE'))!.entryAge).toBeNull();
  });

  it('P19.14-T2 AC-4 rates the smokers where the list says so, and nowhere else', async () => {
    await run(['prudential'], io());
    for (const code of ['PRUCRITICAL_AMANAH', 'PRUFUTURE', 'PRUHERITAGE_SYARIAH']) expect((await product(code))!.smokerRated).toBe(true);
    for (const code of ['PRUCRITICAL_BENEFIT_88', 'PRUWELL_MEDICAL', 'PRUCINTA']) expect((await product(code))!.smokerRated).toBe(false);
  });

  it('P19.14-T2 AC-5 the sum assured is no field on an up_premium product; PRUCerah insures Anak with Masa tunggu 8–18', async () => {
    await run(['prudential'], io());
    const cinta = await product('PRUCINTA');
    expect(cinta).toMatchObject({ calcType: 'up_premium', proposalFields: [], defaultInsured: null });
    const cerah = await product('PRUCERAH');
    expect(cerah).toMatchObject({ defaultInsured: 'child', proposalTypeLabel: 'DANA PENDIDIKAN', calcType: 'manual', needTag: 'EDUCATION' });
    const tunggu = cerah!.proposalFields.find((f: { key: string }) => f.key === 'masa_tunggu');
    expect(tunggu.options).toHaveLength(11);
    expect(tunggu.default).toBe('15 tahun');
    expect((await product('PRUSMART_PLAN'))!.frequencies).toEqual(['monthly', 'annual']);
  });

  it('P19.14-T2 AC-5 lets the plan choose the currency only where the product sells both', async () => {
    await db().collection('products').updateOne({ companyId: COMPANY, code: 'PRUHERITAGE_SYARIAH' }, { $set: { currencies: ['IDR', 'USD'] } });
    await run(['prudential'], io());
    const plan = (p: Record<string, unknown> | null) => (p!.proposalFields as { key: string; options: unknown[]; currency: boolean }[])
      .find((f) => f.key === 'plan')!;
    expect(plan(await product('PRUHERITAGE_SYARIAH'))).toMatchObject({
      currency: true, options: [{ label: 'Essential (IDR)', years: null, currency: 'IDR' }, { label: 'Essential (USD)', years: null, currency: 'USD' }],
    });
    expect(plan(await product('PRUFUTURE'))).toMatchObject({
      currency: false, options: [{ label: 'Basic (IDR)', years: null, currency: null }, { label: 'Waiver (IDR)', years: null, currency: null }],
    });
  });

  it('P19.14-T2 AC-5 writes over the draft of 3 November where nobody edited it, and never where somebody did', async () => {
    // Two products as the draft of 3 November left them: one untouched, one edited since.
    const draft = { proposalFields: [{ key: 'plan', label: 'Plan', labelSyariah: null, type: 'chips', options: [{ label: 'A', years: null, currency: null }], default: 'A', quickAmounts: [], minMinor: null, showOnPdf: true, showOnSummary: true, paymentYears: false, plan: true, currency: false, draft: false }], proposalTypeLabel: 'KESEHATAN', defaultInsured: null };
    const hash = proposalFieldsHash(draft as never, true);
    for (const code of ['PRUSEHAT', 'PRULADY']) {
      await db().collection('products').updateOne({ companyId: COMPANY, code }, { $set: { ...draft, proposalFieldsSource: { import: 'prudential-2026-11-03', hash } } });
    }
    await db().collection('products').updateOne({ companyId: COMPANY, code: 'PRULADY' }, { $set: { 'proposalFields.0.label': 'Pilihan plan' } });
    const call = io();
    await run(['prudential'], call);
    expect(call.out.text()).toMatch(/skipped, edited since \(1\): PRULADY/);
    expect((await product('PRUSEHAT'))!.proposalFieldsSource.import).toBe('prudential-2026-11-11');
    expect((await product('PRUSEHAT'))!.proposalFields[0].options.map((o: { label: string }) => o.label)).toEqual(['Plan Sehat A', 'Plan Sehat B']);
    expect((await product('PRULADY'))!.proposalFields[0].label).toBe('Pilihan plan');
  });

  it('P19.7-T1 AC-4 changes nothing when run twice: every product unchanged, no version moved, no audit row', async () => {
    await run(['prudential'], io());
    const before = await db().collection('products').find({ companyId: COMPANY }).toArray();
    const audits = await db().collection('auditLog').countDocuments({});
    const call = io();
    expect(await run([COMPANY], call)).toBe(0);
    expect(call.out.text()).toContain('written (0)');
    expect(call.out.text()).toContain('unchanged (17)');
    expect(await db().collection('products').find({ companyId: COMPANY }).toArray()).toEqual(before);
    expect(await db().collection('auditLog').countDocuments({})).toBe(audits);
  });

  it('P19.7-T1 AC-4 never overwrites a Super Admin’s edit: the product is reported skipped and left as it is', async () => {
    await run(['prudential'], io());
    const sehat = await product('PRUSEHAT');
    const edited = { ...sehat!.proposalFields[0], label: 'Pilihan plan' };
    await db().collection('products').updateOne({ _id: sehat!._id }, { $set: { 'proposalFields.0': edited }, $inc: { version: 1 } });
    // And one whose calculation field the Super Admin changed: the import's fields, no longer the import's whole.
    await db().collection('products').updateOne({ companyId: COMPANY, code: 'PRULADY' }, { $set: { entryAge: { min: 1, max: 60 } } });
    const call = io();
    await run(['prudential'], call);
    expect(call.out.text()).toMatch(/skipped, edited since \(2\): PRUSEHAT, PRULADY/);
    expect((await product('PRUSEHAT'))!.proposalFields[0].label).toBe('Pilihan plan');
    expect((await product('PRULADY'))!.entryAge).toEqual({ min: 1, max: 60 });
  });

  it('P19.7-T1 AC-4 never writes onto fields a Super Admin set before any import', async () => {
    await db().collection('products').updateOne({ companyId: COMPANY, code: 'PRULADY' }, {
      $set: { proposalTypeLabel: 'WANITA' },
    });
    const call = io();
    await run(['prudential'], call);
    expect(call.out.text()).toMatch(/skipped, edited since \(1\): PRULADY/);
    expect((await product('PRULADY'))!.proposalFields).toEqual([]);
  });

  it('P19.7-T1 AC-4 audits each write as product.updated, reason proposal_fields_import, its actor the job, no value', async () => {
    await run(['prudential'], io());
    const rows = await db().collection('auditLog').find({ action: 'product.updated' }).toArray();
    expect(rows).toHaveLength(17);
    expect(rows[0]).toMatchObject({
      kpmId: null, actorUserId: IMPORT_ACTOR, targetCollection: 'products',
      after: { reason: 'proposal_fields_import', import: 'prudential-2026-11-11' },
    });
    expect(rows[0].after.fields).toEqual(expect.arrayContaining(['proposalFields', 'calcType', 'payTerms', 'entryAge']));
    expect(JSON.stringify(rows)).not.toContain('Bronze');
  });

  it('P19.7-T1 AC-4 refuses a usage error with 2, and a company it cannot find with 1, writing nothing', async () => {
    expect(() => parseArgs([])).toThrow(USAGE);
    expect(() => parseArgs(['a', 'b'])).toThrow(USAGE);
    const usage = io();
    expect(await run(['--force', 'prudential'], usage)).toBe(2);
    const missing = io();
    expect(await run(['allianz'], missing)).toBe(1);
    expect(missing.err.text()).toContain('No company "allianz"');
    expect(await db().collection('auditLog').countDocuments({})).toBe(0);
  });
});
