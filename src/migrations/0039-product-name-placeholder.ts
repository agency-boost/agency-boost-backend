import mongoose from 'mongoose';

/**
 * What the demo seed appended to a product's name to show an office renaming it: *PRUMapan* became
 * *PRUMapan (nama kami)* — "our name". Kept here, the one place that still needs it, so the migration can
 * recognise the rows that hold it.
 */
export const SEEDED_DISPLAY_NAME_SUFFIX = ' (nama kami)';

/** The rows worth reading: a display name that ends in the suffix. The exact match is checked per row. */
const ENDS_WITH_SUFFIX = / \(nama kami\)$/;

/**
 * **A product's name without the seed's placeholder** (ADR-0167; the client's UI review of 2026-10-26, UI-023;
 * P18.95-T6 AC-4, parity I-424).
 *
 * The demo seed gave each office's first product a display name of its own, the company's name with
 * *" (nama kami)"* after it, to show an office renaming a product (P5-T5). The client read
 * *PRUMapan (nama kami)* on the Product Catalog as a placeholder nobody had filled in, which it is. The
 * seed no longer writes it; this takes it off the offices that still hold it.
 *
 * **Only the seeded words.** A row is touched when its `overrides.displayName` is **exactly** its own
 * product's company name followed by the suffix — what the seed wrote. A name an Owner typed, anything else
 * in front of or after the suffix, a row for another product, and a soft-deleted row are left as they are.
 * The platform's own data never held the placeholder: the catalog every company starts from, and the
 * Template company's, name the product *PRUMapan* (`SEED_PRODUCTS`).
 *
 * **Given back, not rewritten**: the override is `$unset`, as an Owner giving a field back to the company does
 * (`KpmProductService.resetOverride`), so the office reads the company's name — *PRUMapan* — and follows it
 * from now on. Everything else on the row stays: its approved description, its script, its documents. The
 * row's version moves once, as any write to it does.
 *
 * **Idempotent**: a cleared row no longer holds the suffix, so a second run reads nothing to clear. On an
 * empty database it reads nothing at all.
 */
export async function up(db: mongoose.mongo.Db, now: Date): Promise<{ cleared: number }> {
  const configs = db.collection('kpmProductConfigs');
  const products = db.collection('products');
  let cleared = 0;

  const rows = await configs.find({ deletedAt: null, 'overrides.displayName': ENDS_WITH_SUFFIX }).toArray();
  for (const row of rows) {
    const productId = String(row.productId);
    if (!mongoose.isValidObjectId(productId)) continue;
    const product = await products.findOne({ _id: new mongoose.Types.ObjectId(productId) });
    const seeded = product ? `${String(product.name)}${SEEDED_DISPLAY_NAME_SUFFIX}` : null;
    if (seeded === null || (row.overrides as { displayName?: unknown }).displayName !== seeded) continue;

    // Matched on the value read, so a name changed between the read and the write is the Owner's and stays.
    const result = await configs.updateOne(
      { _id: row._id, 'overrides.displayName': seeded },
      { $unset: { 'overrides.displayName': '' }, $set: { updatedAt: now }, $inc: { version: 1 } },
    );
    cleared += result.modifiedCount;
  }

  return { cleared };
}
