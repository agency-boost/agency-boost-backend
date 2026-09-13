import mongoose from 'mongoose';

/**
 * `platformTemplates` → `companyTemplates` (ADR-0023).
 *
 * The rename is the whole of it — no field changes, no reshaping. What matters is that it
 * is **atomic where it can be**: `renameCollection` moves the two partial indexes with the
 * collection, where a copy would leave them to be rebuilt on the new name and leave the
 * database briefly without the uniqueness guarantee that stops two drafts existing for one
 * `(company, kind)`.
 *
 * It falls back to copy-then-drop because `renameCollection` needs a privilege a managed
 * tier may not grant, and a migration that dies on a database it merely cannot rename is
 * worse than a slower one that works. The result says which path ran, because the two
 * leave different index state and the next person debugging deserves to know.
 *
 * **Historical `auditLog` rows are not touched** — see ADR-0023. They keep
 * `platform_template.draft_saved` and `targetCollection: 'platformTemplates'`, and the
 * audit screen aliases both at render time. An append-only evidence log is not rewritten
 * so a rename looks tidy.
 *
 * Idempotent: a database that has already moved has no `platformTemplates` and returns
 * zero. A database with both, where the new one holds **rows**, is refused rather than
 * merged — that is an ambiguous half-state, and picking a winner would be guessing which
 * run was the real one.
 *
 * **An empty `companyTemplates` is not that state.** Mongoose creates a collection the
 * moment a model is registered against it, so every developer who ran the API or the test
 * suite after the rename landed has one sitting empty beside the real data. Refusing on
 * mere existence made this migration unrunnable on the machine it was written on — which
 * is how it was found.
 */
export async function up(
  db: mongoose.mongo.Db,
): Promise<{ moved: number; how: 'rename' | 'copy' | 'none' }> {
  const names = (await db.listCollections().toArray()).map((c) => c.name);
  const hasOld = names.includes('platformTemplates');
  const hasNew = names.includes('companyTemplates');

  if (!hasOld) return { moved: 0, how: 'none' };

  if (hasNew && await db.collection('companyTemplates').countDocuments({}) > 0) {
    throw new Error(
      'Both platformTemplates and companyTemplates hold rows. A previous run stopped '
        + 'halfway, and merging them would mean choosing which copy is real. Inspect both, '
        + 'keep one, drop the other, then run this again.',
    );
  }

  const moved = await db.collection('platformTemplates').countDocuments({});

  try {
    // An empty collection in the way is Mongoose's, not a previous run's. Drop it so the
    // rename has somewhere to land, taking its indexes with it.
    if (hasNew) await db.collection('companyTemplates').drop();
    await db.renameCollection('platformTemplates', 'companyTemplates');
    return { moved, how: 'rename' };
  } catch {
    // No privilege to rename. Copy, verify the count, and only then drop — dropping first
    // or trusting `insertMany` without a re-count is how a migration loses rows quietly.
    const rows = await db.collection('platformTemplates').find({}).toArray();
    if (rows.length) await db.collection('companyTemplates').insertMany(rows);
    const landed = await db.collection('companyTemplates').countDocuments({});
    if (landed !== moved) {
      throw new Error(`Copied ${landed} of ${moved} templates. Not dropping the original.`);
    }
    await db.collection('platformTemplates').drop();
    return { moved, how: 'copy' };
  }
}
