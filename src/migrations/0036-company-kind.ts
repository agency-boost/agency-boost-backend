import mongoose from 'mongoose';

/**
 * **Every company that already exists is an insurer** (ADR-0164 §1, P18.9-T3 AC-1).
 *
 * `companies.kind` tells an insurer from the *Template library*, the one company migration `0037` makes to
 * hold the platform's templates. Every company before it was made by `POST /admin/companies` or the demo seed
 * for an insurer somebody works for, so `insurer` is not a guess: it is what each one is.
 *
 * **Written rather than left to the schema default**, for `0017`'s reason: Mongoose fills a missing path on
 * hydration, but a `lean()` read or a raw driver read would meet it absent. The lists that leave the Template
 * out read `kind: { $ne: 'template' }`, which holds either way; a field the product branches on belongs in
 * the document all the same.
 *
 * **Idempotent**: only a company with no `kind` is touched, so a second run, and the Template `0037` writes
 * with its own, are left as they are. On an empty database it finds nothing.
 */
export async function up(db: mongoose.mongo.Db): Promise<{ updated: number }> {
  const { modifiedCount } = await db.collection('companies').updateMany(
    { kind: { $exists: false } },
    { $set: { kind: 'insurer' } },
  );
  return { updated: modifiedCount };
}
