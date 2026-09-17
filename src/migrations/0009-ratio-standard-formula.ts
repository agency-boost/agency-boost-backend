import mongoose from 'mongoose';

/**
 * Record the formula every provisioned ratio was seeded with (ADR-0024).
 *
 * ADR-0024 lets an office change any ratio's formula, and a row that no longer matches what
 * it was provisioned with is flagged. That comparison needs a record of the original, and
 * rows written before this have none.
 *
 * **The current formula *is* the original, provably.** Until ADR-0024 a `platform` row's
 * `numerator` and `denominator` could not be changed — the service refused it, the staged
 * batch refused it, and both had tests. So copying the live formula into the standard is
 * exact rather than a guess, and it is only exact if it runs **before** the new code lets
 * anybody edit one. That ordering is the whole of this migration's risk: it runs in
 * `deploy.yml` before the new image starts, which is the convention it relies on.
 *
 * An office's own ratio keeps `null`: there is no standard it could have moved away from,
 * which is not the same as agreeing with one.
 *
 * Idempotent: only rows without the key are touched.
 */
export async function up(db: mongoose.mongo.Db): Promise<{ recorded: number }> {
  const ratios = db.collection('ratioDefinitions');
  const rows = await ratios
    .find(
      { origin: 'platform', standardNumerator: { $exists: false } },
      { projection: { numerator: 1, denominator: 1 } },
    )
    .toArray();

  let recorded = 0;
  for (const row of rows) {
    await ratios.updateOne(
      { _id: row._id, standardNumerator: { $exists: false } },
      {
        $set: {
          standardNumerator: Array.isArray(row.numerator) ? row.numerator : [],
          standardDenominator: Array.isArray(row.denominator) ? row.denominator : [],
        },
      },
    );
    recorded += 1;
  }
  return { recorded };
}
