import mongoose from 'mongoose';

export interface ProductKindAndCurrencyResult {
  /** Products given `kind: 'base'`: every product written before the field. */
  kind: number;
  /** Products given `attachesTo: []`. */
  attachesTo: number;
  /** Products given `currencies: ['IDR']`. */
  currencies: number;
}

/**
 * **Every product is a base, attached to nothing, and sold in IDR** (P19.4-T4 AC-3, AC-12; the riders spec's *Done
 * when* 1; ADR-0209 §1, §8). A product carries `kind`, `attachesTo` and `currencies` from Phase 19.4; every one written
 * before them was a standalone product sold in rupiah, and is given exactly that: `kind: 'base'`, `attachesTo: []`,
 * `currencies: ['IDR']`. A row that already says any of them keeps it.
 *
 * **Nothing changes for agents**, and no version moves: these are the values the schema reads a missing field as, so
 * the catalogue an agent reads before and after is the same (a test compares the two). Deleted rows are filled too, so
 * a code's history reads the same shape.
 *
 * **Idempotent and forward-only**: each write is conditional on the field being absent or `null`; a second run finds
 * none and writes nothing. On an empty database there is no collection to read, and it writes nothing.
 */
export async function up(db: mongoose.mongo.Db): Promise<ProductKindAndCurrencyResult> {
  const products = db.collection('products');
  const absent = { $in: [null] };
  const kind = await products.updateMany({ kind: absent }, { $set: { kind: 'base' } });
  const attachesTo = await products.updateMany({ attachesTo: absent }, { $set: { attachesTo: [] } });
  const currencies = await products.updateMany({ currencies: absent }, { $set: { currencies: ['IDR'] } });
  return { kind: kind.modifiedCount, attachesTo: attachesTo.modifiedCount, currencies: currencies.modifiedCount };
}
