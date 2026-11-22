import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { RequestContext } from '@/common/context/request-context';
import { calcSettingsOf, type ProposalField } from '@/modules/products/proposal-fields';
import type { RateRowInput, SettledRules } from './intake-apply-plan';
import { IntakeCatalogue } from './intake-catalogue';
import { IntakeTargets } from './intake-targets';
import type { ProductNow } from './intake-understanding';
import { ProductRulesService } from './product-rules.service';
import { RateRow, type RateRowDocument } from './rate-table.schema';
import { RateTableService } from './rate-table.service';

/**
 * **T1's flows, as *Unggah file* reaches them** (P19.15-T3 AC-4; ADR-0259 §4; ADR-0258).
 *
 * - **A premium table** is `RateTableService.createDraft`: a draft version with the rows exactly as the card holds them;
 *   then T1's gap check, three test profiles and activation, on *Tabel premi*.
 * - **Rules, while no table is in force**: the catalogue's own, through `ProductRulesService.apply` (audited
 *   `product_rules.updated`). **While a table is in force**: rules are versioned with their rates (ADR-0258 §3), and an
 *   activated version is never edited — so the rules make **a new draft version** holding the version in force's rows
 *   unchanged and the new rules, from the card's date. It meets the same three profiles before it is in force.
 * - **A percentage** reads the rows in force, which the card's rule then scales.
 */
@Injectable()
export class RateTableIntakeTargets extends IntakeTargets {
  constructor(
    private readonly tables: RateTableService,
    private readonly rules: ProductRulesService,
    private readonly catalogue: IntakeCatalogue,
    @InjectModel(RateRow.name) private readonly rows: Model<RateRowDocument>,
  ) {
    super();
  }

  async productNow(companyId: string, productId: string, today: string): Promise<ProductNow | null> {
    const product = await this.catalogue.product(companyId, productId);
    if (!product) return null;
    const plain = product.toObject() as unknown as Record<string, unknown>;
    const calc = calcSettingsOf(plain);
    const base = await this.tables.baseRules(companyId, productId, product);
    const inForce = await this.tables.inForce(productId, today);
    const fields = (plain.proposalFields as ProposalField[] | undefined) ?? [];
    const decimals = inForce ? await this.rateDecimals(String(inForce._id)) : 0;
    return {
      id: productId,
      companyId,
      name: product.name,
      lifecycle: String(plain.lifecycle ?? 'active'),
      smokerRated: calc.smokerRated,
      frequencies: (plain.frequencies as string[] | undefined) ?? [],
      payTerms: calc.payTerms.map((t) => ({ key: t.key, label: t.label, years: t.years })),
      chipFields: fields.filter((f) => f.type === 'chips').map((f) => ({ key: f.key, label: f.label, options: f.options.map((o) => o.label) })),
      rules: {
        ...base.rules,
        frequencyFactor: { monthly: base.frequencies.monthly, quarterly: base.frequencies.quarterly, semiannual: base.frequencies.semiannual },
      },
      table: inForce && inForce.companyId === companyId
        ? { effectiveFrom: inForce.effectiveFrom, basis: inForce.basis, rateDecimals: decimals }
        : null,
    };
  }

  async createRateTableDraft(ctx: RequestContext, input: Parameters<IntakeTargets['createRateTableDraft']>[1]): Promise<{ rateTableId: string }> {
    const { frequencies, ...rules } = input.rules;
    return this.tables.createDraft(ctx, {
      companyId: input.companyId,
      productId: input.productId,
      rows: input.rows,
      frequencies: frequencies ?? null,
      rules: Object.keys(rules).length ? (rules as never) : null,
      effectiveFrom: input.effectiveFrom,
      effectiveTo: input.effectiveTo,
      source: { fileName: input.source.fileName, type: 'intake', assetKey: input.source.assetKey, intakeItemId: input.source.intakeItemId },
    });
  }

  async inForceRows(companyId: string, productId: string, today: string): Promise<Awaited<ReturnType<IntakeTargets['inForceRows']>>> {
    const table = await this.tables.inForce(productId, today);
    if (!table || table.companyId !== companyId) return null;
    const rows = await this.rows.find({ rateTableId: String(table._id), deletedAt: null }).lean().exec();
    return {
      rateTableId: String(table._id),
      rows: rows.map((r) => ({
        age: r.age, gender: r.gender, smoker: r.smoker, plan: r.plan, payTerm: r.payTerm, currency: r.currency,
        frequency: null, basis: r.basis, rate: r.rate, bandMin: r.bandMin, bandMax: r.bandMax,
      })) as RateRowInput[],
      basis: table.basis,
      currency: rows[0]?.currency ?? null,
    };
  }

  async applyRules(ctx: RequestContext, input: {
    companyId: string; productId: string; rules: SettledRules; effectiveFrom: string | null; intakeItemId: string;
  }): Promise<{ kind: 'rate_table' | 'product'; id: string }> {
    const today = this.tables.today();
    const inForce = await this.inForceRows(input.companyId, input.productId, today);
    if (inForce && inForce.rows.length) {
      const table = await this.tables.inForce(input.productId, today);
      const made = await this.createRateTableDraft(ctx, {
        companyId: input.companyId, productId: input.productId, rows: inForce.rows, rules: input.rules,
        effectiveFrom: input.effectiveFrom && input.effectiveFrom > (table?.effectiveFrom ?? '') ? input.effectiveFrom : today,
        effectiveTo: table?.effectiveTo ?? null,
        source: { fileName: table?.source.fileName ?? 'intake', assetKey: null, intakeItemId: input.intakeItemId },
      });
      return { kind: 'rate_table', id: made.rateTableId };
    }
    const product = await this.catalogue.product(input.companyId, input.productId);
    const calc = calcSettingsOf((product?.toObject() ?? {}) as unknown as Record<string, unknown>);
    const r = input.rules;
    const body: Record<string, unknown> = {};
    for (const key of ['upStep', 'upMin', 'upMax', 'premiumMin', 'premiumMax'] as const) if (r[key] !== undefined) body[key] = r[key];
    if (r.entryAgeMin !== undefined || r.entryAgeMax !== undefined) {
      body.entryAge = { min: r.entryAgeMin ?? calc.entryAge?.min ?? 1, max: r.entryAgeMax ?? calc.entryAge?.max ?? 99 };
    }
    if (r.payTermMaxAge) {
      body.payTerms = calc.payTerms.map((t) => (r.payTermMaxAge![t.key] !== undefined ? { ...t, maxEntryAge: r.payTermMaxAge![t.key] } : t));
    }
    if (Object.keys(body).length === 0) return { kind: 'product', id: input.productId };
    await this.rules.apply(ctx, input.companyId, input.productId, body);
    return { kind: 'product', id: input.productId };
  }

  /** The decimals a version's rates are written with: what a percentage's result is rounded to. */
  private async rateDecimals(tableId: string): Promise<number> {
    const sample = await this.rows.find({ rateTableId: tableId, deletedAt: null, basis: { $ne: 'per_plan' } }).select('rate').limit(200).lean().exec();
    return Math.max(0, ...sample.map((r) => (String(r.rate).split('.')[1] ?? '').length));
  }
}
