import mongoose, { type Model } from 'mongoose';
import { ulid } from 'ulid';
import type { Clock } from '@/common/clock/clock.port';
import { AuditLog, AuditLogSchema } from '@/modules/audit/audit-log.schema';
import { Illustration, IllustrationSchema, type IllustrationBlock } from '@/modules/product-data/illustration.schema';
import {
  IntakeItem, IntakeItemSchema, UploadIntake, UploadIntakeSchema, type IntakeQuestion,
} from '@/modules/product-data/upload-intake.schema';
import { COLUMN_CHOICES } from '@/modules/product-data/intake-understanding';
import { Product, ProductSchema } from '@/modules/products/product.schema';

/**
 * ***Unggah file* and *Ilustrasi*, seeded as stored data** (P19.15-T2, T3; ADR-0259). **Nothing here calls the AI**: the
 * reading's result is written as the reading would have written it, so a reviewer without `ANTHROPIC_API_KEY` sees the
 * cards, answers the questions and confirms.
 *
 * | What | Who to sign in as, and what they see |
 * |---|---|
 * | **An upload for Prudential, *Perlu dijawab***: two files (a workbook and a WhatsApp photo) and two cards — *Tabel premi baru PRUCerah, berlaku 1 Des 2026, 6 baris* (from *Belum ada*), and PCB88's rules *UP minimum: Rp 100 Jt → Rp 150 Jt*, *Usia masuk maksimum: 60 tahun → 55 tahun* — with **three question cards**: *Kolom "Rate A" ini tarif laki-laki atau perempuan?*, a blurry *Premi minimum* to type, and *Tanggal berlaku tidak ditemukan. Mulai kapan?* | `superadmin@agencyboost.test` at `/admin/companies` → *Prudential* → *Proposal* → *Unggah file* → the upload; `admin@kpm0417.test` (*Kelola data produk*) at *Data produk* the same, and can answer and confirm; `owner@kpm0417.test` reads it |
 * | **An illustration of PRUWell Medical, a draft**: *Manfaat utama*, *Masa tunggu / berlaku*, *Yang tidak ditanggung*, each with its page — **demo wording, not Prudential's** | the same tab → *PRUWell Medical* → *Ilustrasi*: the blocks, *Pratinjau kotak PDF*, *Terbitkan* |
 *
 * The table's figures are **demo figures, not Prudential's rates**. The originals are not stored (no file is kept for a
 * seeded upload), so a source names its file, sheet and cell without a link. **Written once, until `--reset`**: a demo
 * upload already there is left as a walk left it.
 */

const RECOMPILE = { overwriteModels: true } as const;

/** The demo upload's first file: what tells a second run it is already there. */
export const DEMO_INTAKE_FILE = 'Tarif PRUCerah Des 2026.xlsx';
export const DEMO_ILLUSTRATION_FILE = 'Ilustrasi PRUWell Medical Silver A.pdf';

export interface ProductDataIntakeFixture { intake: boolean; illustration: boolean; guide: string }

const question = (over: Partial<IntakeQuestion> & Pick<IntakeQuestion, 'kind' | 'text'>): IntakeQuestion => ({
  id: ulid(), choices: [], about: null, when: null, answer: null, answeredBy: null, answeredAt: null, ...over,
});

export async function seedProductDataIntakeFixture(input: {
  clock: Clock;
  /** Prudential's id. */
  companyId: string;
  superAdminUserId: string;
}): Promise<ProductDataIntakeFixture> {
  const { clock, companyId, superAdminUserId } = input;
  const model = (name: string, schema: mongoose.Schema): never => mongoose.model(name, schema, undefined, RECOMPILE) as never;
  const intakes: Model<UploadIntake> = model(UploadIntake.name, UploadIntakeSchema);
  const items: Model<IntakeItem> = model(IntakeItem.name, IntakeItemSchema);
  const illustrations: Model<Illustration> = model(Illustration.name, IllustrationSchema);
  const products: Model<Product> = model(Product.name, ProductSchema);
  const audit: Model<AuditLog> = model(AuditLog.name, AuditLogSchema);
  const now = clock.now();

  const byCode = async (code: string) => products.findOne({ companyId, code, deletedAt: null }).select('_id name').lean().exec();
  const [cerah, pcb88, medical] = await Promise.all([byCode('PRUCERAH'), byCode('PRUCRITICAL_BENEFIT_88'), byCode('PRUWELL_MEDICAL')]);

  let intake = false;
  if (cerah && pcb88 && !(await intakes.exists({ companyId, files: { $elemMatch: { name: DEMO_INTAKE_FILE } }, deletedAt: null }).exec())) {
    const created = await intakes.create({
      companyId,
      files: [
        { index: 0, name: DEMO_INTAKE_FILE, kind: 'xlsx', mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', bytes: 18_432, storageKey: null, fromZip: null, status: 'read', failure: null, items: 1 },
        { index: 1, name: 'WA Ketentuan PCB88.jpg', kind: 'image', mimeType: 'image/jpeg', bytes: 214_016, storageKey: null, fromZip: null, status: 'read', failure: null, items: 1 },
      ],
      uploadedBy: superAdminUserId, status: 'needs_answers', readingStartedAt: now, readAt: now, failure: null,
      usage: { inputTokens: 0, outputTokens: 0 }, deletedAt: null,
    });
    const intakeId = String(created._id);
    const file0 = (sheet: string, cell: string, quote: string | null) => ({ file: 0, fileName: DEMO_INTAKE_FILE, page: null, sheet, cell, quote });
    const file1 = (quote: string) => ({ file: 1, fileName: 'WA Ketentuan PCB88.jpg', page: 1, sheet: null, cell: null, quote });

    // Card 1: a premium table read from the workbook's own cells — one column unclear. Demo figures.
    const rows = [[30, '1.25', '1.10'], [31, '1.31', '1.15'], [32, '1.38', '1.21']];
    await items.create({
      intakeId, companyId, productId: String(cerah._id), productAsWritten: 'PRU Cerah', kind: 'premium_table',
      summary: 'Tabel premi baru PRUCerah, berlaku 1 Des 2026', effectiveFrom: '2026-12-01', effectiveTo: null,
      source: file0('Tarif', 'A1:C4', null),
      diff: [{
        key: 'table', label: 'Tabel premi', old: 'Belum ada', new: 'Tabel premi baru, berlaku 1 Des 2026, 6 baris', value: 6, certain: true,
        source: file0('Tarif', 'A1:C4', null),
      }],
      table: {
        sheet: 'Tarif', basis: 'per_mille', currency: 'IDR',
        columns: [
          { column: 'A', header: 'Usia', meaning: 'age', gender: null, smoker: null, plan: null, payTermKey: null },
          { column: 'B', header: 'Rate A', meaning: 'unclear', gender: null, smoker: null, plan: null, payTermKey: null },
          { column: 'C', header: 'Rate B', meaning: 'rate', gender: 'female', smoker: null, plan: null, payTermKey: null },
        ],
        rows: rows.map(([age, a, b], i) => ({
          row: i + 2, page: null,
          cells: { A: { text: String(age), value: null, certain: true }, B: { text: String(a), value: null, certain: true }, C: { text: String(b), value: null, certain: true } },
        })),
        gaps: ['Usia 33–60 tidak ada di tabel'],
      },
      percent: null, newProductName: null,
      questions: [question({ kind: 'column', about: 'column:B', text: 'Kolom "Rate A" ini tarif laki-laki atau perempuan?', choices: [...COLUMN_CHOICES] })],
      confidence: 'low', status: 'needs_answers', appliedRef: null, decidedBy: null, decidedAt: null, deletedAt: null,
    });

    // Card 2: rules read from a photographed WhatsApp message — one figure blurred, no date.
    await items.create({
      intakeId, companyId, productId: String(pcb88._id), productAsWritten: 'PCB 88', kind: 'product_rules',
      summary: 'Ketentuan baru PCB88 dari pesan WhatsApp', effectiveFrom: null, effectiveTo: null,
      source: file1('UP minimum naik jadi 150 jt'),
      diff: [
        { key: 'upMin', label: 'UP minimum', old: 'Rp 100 Jt', new: 'Rp 150 Jt', value: 15_000_000_000, certain: true, source: file1('UP min 150 jt') },
        { key: 'entryAgeMax', label: 'Usia masuk maksimum', old: '60 tahun', new: '55 tahun', value: 55, certain: true, source: file1('usia masuk maks 55') },
        { key: 'premiumMin', label: 'Premi minimum', old: null, new: null, value: null, certain: false, source: file1('premi min 2,?00.000') },
      ],
      table: null, percent: null, newProductName: null,
      questions: [
        question({ kind: 'type_number', about: 'diff:premiumMin', text: 'Angka "Premi minimum" tidak terbaca jelas di foto (tertulis "2,?00.000"). Ketik angkanya.' }),
        question({ kind: 'date', about: 'effectiveFrom', text: 'Tanggal berlaku tidak ditemukan. Mulai kapan?' }),
      ],
      confidence: 'low', status: 'needs_answers', appliedRef: null, decidedBy: null, decidedAt: null, deletedAt: null,
    });
    await audit.create({
      kpmId: null, actorUserId: superAdminUserId, effectiveUserId: null, actorMembershipId: null,
      action: 'intake.uploaded', targetCollection: 'uploadIntakes', targetId: intakeId, before: null,
      after: { companyId, files: [{ name: DEMO_INTAKE_FILE }, { name: 'WA Ketentuan PCB88.jpg' }] }, onBehalfOf: false,
    });
    intake = true;
  }

  let illustration = false;
  if (medical && !(await illustrations.exists({ companyId, productId: String(medical._id), fileName: DEMO_ILLUSTRATION_FILE, deletedAt: null }).exec())) {
    const row = (label: string, text: string, page: number, note: string | null = null) => ({
      id: ulid(), label, note, formula: null, text, page, evidence: [], check: null,
    });
    const blocks: IllustrationBlock[] = [
      { block: 'manfaat', page: 3, rows: [
        row('Kamar & menginap per hari', 'Sesuai plan', 3),
        row('Biaya rumah sakit', 'Ditanggung penuh', 3, 'sesuai tagihan'),
        row('Rawat jalan setelah rawat inap', 'Ditanggung', 4),
      ] },
      { block: 'masa', page: 5, rows: [row('Masa tunggu', '30 hari', 5, 'sakit biasa'), row('Masa berlaku', 's/d usia 99', 5)] },
      { block: 'pengecualian', page: 9, rows: [
        row('Kondisi yang sudah ada sebelumnya', 'Tidak ditanggung', 9),
        row('Perawatan kosmetik', 'Tidak ditanggung', 9),
        row('Cedera karena olahraga berbahaya', 'Tidak ditanggung', 10),
      ] },
    ];
    const created = await illustrations.create({
      companyId, productId: String(medical._id), plan: 'Silver A', fileName: DEMO_ILLUSTRATION_FILE, fileKey: null,
      illustrationDate: '2026-11-01', status: 'draft', failure: null, readingStartedAt: now, blocks,
      dropped: ['Ketentuan hukum dan penafian', 'Tabel biaya yang berulang'], sampleInputs: {}, intakeItemId: null,
      uploadedBy: superAdminUserId, updatedBy: superAdminUserId, publishedBy: null, publishedAt: null, supersededAt: null,
      usage: { inputTokens: 0, outputTokens: 0 }, deletedAt: null,
    });
    await audit.create({
      kpmId: null, actorUserId: superAdminUserId, effectiveUserId: null, actorMembershipId: null,
      action: 'illustration.uploaded', targetCollection: 'illustrations', targetId: String(created._id), before: null,
      after: { companyId, productId: String(medical._id), fileName: DEMO_ILLUSTRATION_FILE, illustrationDate: '2026-11-01' }, onBehalfOf: false,
    });
    illustration = true;
  }

  return {
    intake,
    illustration,
    guide: 'Unggah file: a Prudential upload waits on 3 questions (2 cards), and PRUWell Medical has a draft illustration — '
      + 'superadmin@agencyboost.test at Perusahaan → Prudential → Proposal, or admin@kpm0417.test at Data produk.',
  };
}
