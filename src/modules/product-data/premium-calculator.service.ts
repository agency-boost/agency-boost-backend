import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { isValidObjectId, Model } from 'mongoose';
import { Clock } from '@/common/clock/clock.port';
import type { StoredItem } from '@/modules/proposals/proposal-items';
import { calculateItem, type CalcOptions, type ItemPerson, type TableForItem } from './item-calculation';
import type { EngineRow } from './premium-engine';
import { inForceOn } from './rate-table-status';
import { RateRow, RateTable, type RateRowDocument, type RateTableDocument } from './rate-table.schema';

/** The fields of a version the calculation reads — never its file. */
const VERSION_FIELDS = 'productId version effectiveFrom effectiveTo activatedAt turnedOffAt deletedAt rules frequencies';

/** A row as the engine reads it. */
export function engineRowOf(row: Pick<RateRow, keyof EngineRow>): EngineRow {
  return {
    age: row.age ?? null, gender: row.gender ?? null, smoker: row.smoker ?? null, plan: row.plan ?? null,
    payTerm: row.payTerm ?? null, currency: row.currency, frequency: row.frequency ?? null, basis: row.basis,
    rate: row.rate, bandMin: row.bandMin ?? null, bandMax: row.bandMax ?? null,
  };
}

/**
 * **The version in force for a product, loaded for one insured** (P19.15-T1 AC-3, AC-5; ADR-0258 §2, §5): what the
 * agent's card, a re-opened draft and *Uji coba* calculate with. The version is chosen on every call from the product's
 * versions and the day — Asia/Jakarta's, handed in — so a scheduled one is in force from 00:00 on its *Berlaku mulai*
 * with no job; the rows are read for the insured's age only (and *any*), so a ten-thousand-row table costs one indexed
 * read of a few dozen.
 *
 * Company data, read by product id: the product came from the office's own shelf, so its versions are its company's.
 */
@Injectable()
export class PremiumCalculator {
  constructor(
    @InjectModel(RateTable.name) private readonly tables: Model<RateTableDocument>,
    @InjectModel(RateRow.name) private readonly rows: Model<RateRowDocument>,
    private readonly clock: Clock,
  ) {}

  /** **The id of the version in force on `day`**, or `null` — the product is typed. */
  async inForceId(productId: string, day: string): Promise<string | null> {
    return (await this.inForce(productId, day))?.id ?? null;
  }

  /** **The version in force on `day`, with its rows for `age`** — or `null`. */
  async tableFor(productId: string, day: string, age: number | null): Promise<TableForItem | null> {
    const version = await this.inForce(productId, day);
    return version ? this.load(version.id, version.effectiveFrom, version.rules, version.frequencies, age) : null;
  }

  /** **A named version, with its rows for `age`** — a draft too, for *Uji coba* and *Uji 3 contoh*. */
  async load(
    id: string, effectiveFrom: string, rules: RateTable['rules'], frequencies: RateTable['frequencies'], age: number | null,
  ): Promise<TableForItem> {
    const rows = await this.rows.find({ rateTableId: id, deletedAt: null, age: age === null ? null : { $in: [age, null] } })
      .lean().exec();
    const ageRated = age === null
      ? (await this.rows.exists({ rateTableId: id, deletedAt: null, age: { $ne: null } }).exec()) !== null
      : true;
    return { id, effectiveFrom, rules, frequencies, rows: rows.map(engineRowOf), ageRated };
  }

  /**
   * **An item calculated with the version in force on `day`** — `item-calculation.ts`' rules — and that version marked
   * used when it produced the amounts, so it can never be deleted under a proposal (AC-3).
   */
  async calculate(item: StoredItem, who: ItemPerson, day: string, opts: CalcOptions = {}): Promise<StoredItem> {
    const age = item.insured.relation === 'client' ? who.clientAge : item.insured.age;
    const table = item.snapshot.calcType === 'manual' ? null : await this.tableFor(item.productId, day, age);
    const next = calculateItem(item, who, table, opts);
    if (next.rateTableVersionId !== null) await this.markUsed(next.rateTableVersionId);
    return next;
  }

  /** The first time a proposal is calculated with a version. */
  async markUsed(id: string): Promise<void> {
    await this.tables.updateOne({ _id: id, firstUsedAt: null }, { $set: { firstUsedAt: this.clock.now() } }).exec();
  }

  private async inForce(productId: string, day: string) {
    if (!isValidObjectId(productId)) return null;
    const versions = await this.tables
      .find({ productId, deletedAt: null, activatedAt: { $ne: null }, turnedOffAt: null })
      .select(VERSION_FIELDS).lean().exec();
    return inForceOn(versions.map((v) => ({ ...v, id: String(v._id) })), day);
  }
}
