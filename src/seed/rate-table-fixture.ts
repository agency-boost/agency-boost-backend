import mongoose, { type Model } from 'mongoose';
import { DateTime } from 'luxon';
import type { Clock } from '@/common/clock/clock.port';
import { DEFAULT_TENANT_TIMEZONE } from '@/domain/constants';
import { calculate, type EngineRow } from '@/modules/product-data/premium-engine';
import { fingerprintOf, gapsOf } from '@/modules/product-data/rate-file';
import {
  RateRow, RateRowSchema, RateTable, RateTableSchema, type FrequencyFactors, type RateRules, type RateTestCase,
} from '@/modules/product-data/rate-table.schema';
import { catalogueRulesOf, tableFactsOf } from '@/modules/product-data/rate-table.service';
import { Product, ProductSchema } from '@/modules/products/product.schema';

/**
 * **Premium tables, seeded** (P19.15-T1, T4 AC-1; ADR-0258). **SAMPLE NUMBERS — NEVER PRUDENTIAL'S RATES.** Every rate
 * below is made up by a formula, smooth enough to look like a table and nothing more: no insurer's tariff is copied,
 * and the PDF of a proposal calculated with them says *"Tabel tarif berlaku …"* only because the demo says so.
 *
 * | What | Who to sign in as, and what they see |
 * |---|---|
 * | **PCB88 (PRUCritical Benefit 88), *Siap hitung***: version 1, in force since 1 April 2026 — ages 1 to 60, both genders, 5, 10 and 15 years (15 to age 50) and *Sekali bayar*; *Cara bayar* factors 0,09 · 0,27 · 0,52 · 1; *Ketentuan* UP kelipatan Rp1 jt, UP minimum Rp100 jt, premi minimum Rp1,2 jt a year; its three test profiles matching | `superadmin@agencyboost.test`: *Perusahaan* → *Prudential* → *Proposal* → *PCB88* → *Tabel premi*. `rina@kpm0417.test`: a new proposal → *PCB88*: type *Rp500 jt* and the premium appears; type a premium and the UP is rounded down to Rp1 jt with *"Premi disesuaikan …"* |
 * | **PCB88's version 2, *Terjadwal*** a month ahead, 4% dearer — *"Tarif baru mulai {date}"* | the same row; *Uji coba* with the date set to try it |
 * | **PRUCinta, *Perlu dicek* · *Ada celah***: a table of ages 18 to 55 only, against entry ages 10 to 60 | the list, sorted first |
 * | **PRU Anugerah Syariah, *Perlu dicek* · *Berakhir***: a complete table that ends in 12 days, nothing scheduled after it — D2's daily run tells the Super Admin | the list; the Super Admin's bell |
 * | **Every other product, *Ketik manual*** | the list |
 *
 * **Written once, until `--reset`**: a product that has any version already is left as a walk left it. Run before
 * *Kelola data produk*'s fixture, whose notices read these tables.
 */

const RECOMPILE = { overwriteModels: true } as const;

/** *Cara bayar* factors against the annual premium — sample, as the rates are. */
const FACTORS: FrequencyFactors = { monthly: 0.09, quarterly: 0.27, semiannual: 0.52, annual: 1 };
const JT = 100_000_000;

export interface RateTableFixture { versions: number; rows: number; guide: string }

/** A made-up rate per Rp1.000 for a man on a 10-year term: rising with age, as such tables do. */
const base10 = (age: number) => 3 + age * age * 0.0077;
const round2 = (n: number) => Math.round(n * 100) / 100;

export async function seedRateTableFixture(input: {
  clock: Clock;
  /** Prudential's id. */
  companyId: string;
  superAdminUserId: string;
}): Promise<RateTableFixture> {
  const { clock, companyId, superAdminUserId } = input;
  const model = (name: string, schema: mongoose.Schema): never => mongoose.model(name, schema, undefined, RECOMPILE) as never;
  const tables: Model<RateTable> = model(RateTable.name, RateTableSchema);
  const rowsModel: Model<RateRow> = model(RateRow.name, RateRowSchema);
  const products: Model<Product> = model(Product.name, ProductSchema);
  const now = clock.now();
  const today = clock.localDateFor(DEFAULT_TENANT_TIMEZONE);
  const plusDays = (n: number) => DateTime.fromISO(today, { zone: 'utc' }).plus({ days: n }).toISODate()!;
  let versions = 0;
  let rowCount = 0;

  /** One version: its rows, its rules, three test profiles worked out by the engine from them (sample), activated. */
  async function version(product: Record<string, unknown> & { _id: unknown }, v: {
    number: number; effectiveFrom: string; effectiveTo: string | null; rows: EngineRow[]; rules: Partial<RateRules>;
    fileName: string;
  }): Promise<void> {
    const facts = tableFactsOf(product as never);
    const rules: RateRules = { ...catalogueRulesOf(product), ...v.rules };
    const { gaps, count } = gapsOf(v.rows, facts, rules);
    const term = facts.payTerms.find((t) => t.key === 'y10') ?? facts.payTerms[0];
    const testCases: RateTestCase[] = [[35, 'male'], [42, 'female'], [28, 'male']].map(([age, gender]) => {
      const inputs = {
        age: age as number, gender: gender as 'male' | 'female', smoker: null, plan: null, payTerm: term?.key ?? null,
        payFrequency: 'monthly' as const, amountMinor: 500 * JT,
      };
      const result = calculate({ rows: v.rows.filter((r) => r.age === inputs.age), rules, frequencies: FACTORS, ageRated: true }, {
        calcType: 'up_premium', profile: { ...inputs, currency: 'IDR' }, payFrequency: 'monthly', singlePayTerm: false,
        fixed: 'up', up: inputs.amountMinor, premium: null, goal: null,
      });
      return { inputs, expectedMinor: result.premium ?? 0, actualMinor: result.premium, match: result.premium !== null };
    });
    const created = await tables.create({
      companyId, productId: String(product._id), version: v.number, effectiveFrom: v.effectiveFrom, effectiveTo: v.effectiveTo,
      activatedAt: now, activatedBy: superAdminUserId,
      source: { fileName: v.fileName, type: 'xlsx', assetKey: null, intakeItemId: null },
      uploadedBy: superAdminUserId, uploadedAt: now, columnMap: {}, mappedAt: now, raw: null, basis: 'per_mille',
      rowCount: v.rows.length, gaps, gapCount: count, testCases, overrideReason: null, rules, frequencies: FACTORS,
      rulesSource: 'ketentuan', rulesConfirmed: true, productFingerprint: fingerprintOf(facts), firstUsedAt: null,
      updatedBy: superAdminUserId,
    });
    for (let i = 0; i < v.rows.length; i += 1000) {
      await rowsModel.insertMany(v.rows.slice(i, i + 1000).map((r) => ({ ...r, rateTableId: String(created._id), deletedAt: null })));
    }
    versions += 1;
    rowCount += v.rows.length;
  }

  /** Rows for every age, gender and pay term the product allows, the rate scaled per term — never a copied tariff. */
  const sampleRows = (terms: readonly { key: string; scale: number; maxAge: number }[], from: number, to: number, dearer = 1): EngineRow[] => {
    const out: EngineRow[] = [];
    for (let age = from; age <= to; age += 1) {
      for (const gender of ['male', 'female'] as const) {
        for (const term of terms) {
          if (age > term.maxAge) continue;
          const rate = round2(base10(age) * term.scale * (gender === 'female' ? 0.88 : 1) * dearer);
          out.push({ age, gender, smoker: null, plan: null, payTerm: term.key, currency: 'IDR', frequency: null, basis: 'per_mille', rate, bandMin: null, bandMax: null });
        }
      }
    }
    return out;
  };

  const byCode = (code: string) => products.findOne({ companyId, code, deletedAt: null }).lean().exec();
  const untouched = async (productId: unknown) => !(await tables.exists({ productId: String(productId) }).exec());

  const pcb88 = await byCode('PRUCRITICAL_BENEFIT_88');
  if (pcb88 && await untouched(pcb88._id)) {
    const terms = [{ key: 'y5', scale: 1.85, maxAge: 60 }, { key: 'y10', scale: 1, maxAge: 60 }, { key: 'y15', scale: 0.78, maxAge: 50 }, { key: 'single', scale: 7.2, maxAge: 60 }];
    const rules = {
      upStep: JT, upMin: 100 * JT, upMax: null, premiumMin: 120_000_000, premiumMax: null, entryAgeMin: 1, entryAgeMax: 60,
      payTermMaxAge: { y5: 60, y10: 60, y15: 50, single: 60 },
    };
    await products.updateOne({ _id: pcb88._id }, { $set: { upStep: rules.upStep, upMin: rules.upMin, premiumMin: rules.premiumMin } }).exec();
    const fresh = (await byCode('PRUCRITICAL_BENEFIT_88'))!;
    await version(fresh as never, { number: 1, effectiveFrom: '2026-04-01', effectiveTo: null, rows: sampleRows(terms, 1, 60), rules, fileName: 'Contoh tarif PCB88 2026.xlsx' });
    await version(fresh as never, {
      number: 2, effectiveFrom: plusDays(30), effectiveTo: null, rows: sampleRows(terms, 1, 60, 1.04), rules, fileName: 'Contoh tarif PCB88 baru.xlsx',
    });
    const latest = await tables.findOne({ productId: String(pcb88._id) }).sort({ effectiveFrom: -1 }).lean().exec();
    await products.updateOne({ _id: pcb88._id }, { $set: { rateTableId: latest ? String(latest._id) : null } }).exec();
  }

  const cinta = await byCode('PRUCINTA');
  if (cinta && await untouched(cinta._id)) {
    await version(cinta as never, {
      number: 1, effectiveFrom: '2026-07-01', effectiveTo: null, rows: sampleRows([{ key: 'y10', scale: 1.4, maxAge: 60 }], 18, 55),
      rules: { upStep: JT, upMin: 50 * JT }, fileName: 'Contoh tarif PRUCinta.csv',
    });
  }

  const anugerah = await byCode('PRUANUGERAH_SYARIAH');
  if (anugerah && await untouched(anugerah._id)) {
    await version(anugerah as never, {
      number: 1, effectiveFrom: '2026-01-01', effectiveTo: plusDays(12),
      rows: sampleRows([{ key: 'y5', scale: 2, maxAge: 70 }, { key: 'y10', scale: 1.1, maxAge: 60 }, { key: 'y15', scale: 0.85, maxAge: 55 }], 21, 70),
      rules: { upStep: JT, upMin: 100 * JT }, fileName: 'Contoh tarif PRU Anugerah Syariah.xlsx',
    });
  }

  return {
    versions,
    rows: rowCount,
    guide: versions === 0
      ? 'Premium tables: already seeded.'
      : `Premium tables (${versions} versions, ${rowCount} rows — SAMPLE numbers, never Prudential's rates): `
        + 'superadmin@agencyboost.test at Perusahaan → Prudential → Proposal — PCB88 Siap hitung with a version scheduled a '
        + 'month ahead, PRUCinta Ada celah, PRU Anugerah Syariah Berakhir; rina@kpm0417.test: a new proposal → PCB88 calculates.',
  };
}
