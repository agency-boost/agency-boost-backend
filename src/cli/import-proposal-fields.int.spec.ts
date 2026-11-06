import { Writable } from 'node:stream';
import mongoose from 'mongoose';
import { SEED_PRODUCTS } from '@/domain/constants';
import { CHECK_ILLUSTRATION, PRUDENTIAL_PROPOSAL_ROWS } from '@/modules/products/proposal-fields-prudential';
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
 * **P19.7-T1 AC-4 — the Prudential draft, imported** (ADR-0225 §10): the operator's command against the in-memory
 * database the way the VM runs it — its own connection, the environment it is given — onto a company holding the
 * Prudential catalogue the seed gives every company.
 */
describe('P19.7-T1 AC-4 import-proposal-fields', () => {
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

  it('P19.7-T1 AC-4 maps the draft’s 16 rows to 18 product codes, as ADR-0225 §10 lists them', () => {
    expect(PRUDENTIAL_PROPOSAL_ROWS).toHaveLength(16);
    expect(PRUDENTIAL_PROPOSAL_ROWS.flatMap((r) => r.codes)).toEqual([
      'PRUWELL_MEDICAL', 'PRUWELL_MEDICAL_SYARIAH', 'PRUWELL_HEALTH', 'PRUWELL_HEALTH_SYARIAH', 'PRUSEHAT',
      'PRUCRITICAL_BENEFIT_88', 'PRUCRITICAL_AMANAH', 'PRUSOLUSI_KONDISI_KRITIS_SYARIAH', 'PRUCINTA',
      'PRUANUGERAH_SYARIAH', 'PRUFUTURE', 'PRUHERITAGE_SYARIAH', 'PRUCERAH', 'PRUTAHAPAN_CEMERLANG', 'PRUSMART_PLAN',
      'PRUMAPAN', 'PRUPROSPER', 'PRULADY',
    ]);
    // Every code but production's PRUProsper is in the catalogue a company starts with.
    const seeded = new Set(SEED_PRODUCTS.map((p) => p.code));
    expect(PRUDENTIAL_PROPOSAL_ROWS.flatMap((r) => r.codes).filter((c) => !seeded.has(c))).toEqual(['PRUPROSPER']);
  });

  it('P19.7-T1 AC-4 writes each product’s fields, types, options, defaults and ★, reports the code it lacks, and creates nothing', async () => {
    const call = io();
    expect(await run(['prudential'], call)).toBe(0);
    expect(call.out.text()).toContain('written (17)');
    expect(call.out.text()).toContain('no such product (1): PRUPROSPER');
    expect(await db().collection('products').countDocuments({ code: 'PRUPROSPER' })).toBe(0);

    const medical = await product('PRUWELL_MEDICAL');
    expect(medical!.proposalTypeLabel).toBe('KESEHATAN');
    expect(medical!.proposalFields.map((f: { key: string }) => f.key)).toEqual(['plan', 'wilayah', 'kamar', 'saver']);
    expect(medical!.proposalFields[0]).toMatchObject({
      type: 'chips', default: 'Gold', plan: true, showOnSummary: true, draft: true,
      options: ['Bronze', 'Silver', 'Gold', 'Platinum', 'Diamond'].map((label) => ({ label, years: null, currency: null })),
    });
    // ★ on Plan, Wilayah and Kamar; not on Saver. No pdfDetail.
    expect(medical!.proposalFields.map((f: { showOnSummary: boolean }) => f.showOnSummary)).toEqual([true, true, true, false]);
    expect(medical!.pdfDetail).toEqual([]);
    expect(medical!.version).toBe(2);
    expect(medical!.proposalFieldsSource).toMatchObject({ import: 'prudential-2026-11-03', hash: expect.any(String) });
  });

  it('P19.7-T1 AC-4 gives PRUCerah its insured Anak, its fixed field as text, and the years on Masa tunggu', async () => {
    await run(['prudential'], io());
    const cerah = await product('PRUCERAH');
    expect(cerah).toMatchObject({ defaultInsured: 'child', proposalTypeLabel: 'DANA PENDIDIKAN' });
    const byKey = Object.fromEntries(cerah!.proposalFields.map((f: { key: string }) => [f.key, f]));
    expect(byKey.masa_bayar).toMatchObject({ type: 'fixed', default: 'Sama dengan masa tunggu', paymentYears: false });
    expect(byKey.masa_tunggu).toMatchObject({ paymentYears: true, draft: true, default: CHECK_ILLUSTRATION });
    expect(byKey.penarikan_bulanan).toMatchObject({ type: 'money', showOnSummary: true });
    // Every other row reads its category's insured.
    expect((await product('PRUCINTA'))!.defaultInsured).toBeNull();
  });

  it('P19.7-T1 AC-4 marks every [cek] field a draft, and only those', async () => {
    await run(['prudential'], io());
    const cinta = await product('PRUCINTA');
    expect(cinta!.proposalFields[0]).toMatchObject({
      key: 'masa_bayar', type: 'fixed', default: '10 tahun', options: [{ label: '10 tahun', years: 10, currency: null }],
      paymentYears: true, draft: true,
    });
    expect(cinta!.proposalFields[1]).toMatchObject({ key: 'santunan', type: 'money', draft: false });
    const health = await product('PRUWELL_HEALTH');
    expect(health!.proposalFields.find((f: { key: string }) => f.key === 'up')).toMatchObject({ minMinor: 100_000_000_00 });
  });

  it('P19.7-T1 AC-4 gives Mata uang only the currencies the product sells', async () => {
    await db().collection('products').updateOne({ companyId: COMPANY, code: 'PRUHERITAGE_SYARIAH' }, { $set: { currencies: ['IDR', 'USD'] } });
    await run(['prudential'], io());
    const field = (p: Record<string, unknown> | null) => (p!.proposalFields as { key: string; options: unknown[] }[])
      .find((f) => f.key === 'mata_uang')!;
    expect(field(await product('PRUHERITAGE_SYARIAH')).options).toEqual([
      { label: 'Rupiah', years: null, currency: 'IDR' }, { label: 'Dolar', years: null, currency: 'USD' },
    ]);
    expect(field(await product('PRUFUTURE')).options).toEqual([{ label: 'Rupiah', years: null, currency: 'IDR' }]);
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
    // And one whose type label the Super Admin changed: the import's fields, no longer the import's whole.
    await db().collection('products').updateOne({ companyId: COMPANY, code: 'PRULADY' }, {
      $set: { proposalTypeLabel: 'WANITA' },
    });
    const call = io();
    await run(['prudential'], call);
    expect(call.out.text()).toMatch(/skipped, edited since \(2\): PRUSEHAT, PRULADY/);
    expect((await product('PRUSEHAT'))!.proposalFields[0].label).toBe('Pilihan plan');
    expect((await product('PRULADY'))!.proposalTypeLabel).toBe('WANITA');
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
      after: { reason: 'proposal_fields_import', import: 'prudential-2026-11-03' },
    });
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
