import mongoose from 'mongoose';
import {
  SEEDED_SALES_SUBTITLE_BEFORE_OD_150, SEEDED_TRAINING_DESCRIPTIONS_BEFORE_P18_97,
} from '@/domain/constants/training-taxonomy';

/**
 * **Sales's subtitle without the Skill Tracker promise** (OD-150, answered 2026-10-10 as recommended; P18.2-T1).
 *
 * The seeded Sales category read *"Structured modules — tracked here, and later in your Skill Tracker."* — the
 * prototype's promise of a link no feature makes (the only Skill tracker is a leader's private grid, ADR-0073, and
 * ADR-0029 keeps it separate). A new office is given *"Structured modules — tracked here."*; this gives an existing
 * office the same words **only where it still holds the seeded ones**. An Owner who wrote their own keeps them.
 *
 * - **The working copy** (`trainingCategories`), which Settings › Training edits;
 * - **each office's newest published snapshot** (`configSnapshots`), which agents read — so the subtitle changes
 *   without anybody publishing, as 0021 changed the summary tiles: words, not anything an agent counted;
 * - **every Company template** of kind `training_taxonomy`, draft and published, so the next office a company
 *   creates starts where its existing ones now stand.
 *
 * **No version moves**, so no publish bar speaks and no office reads as built from another template version.
 * **Idempotent**: only the seeded words are matched, and they are what is replaced.
 */
export async function up(db: mongoose.mongo.Db): Promise<{ categories: number; snapshots: number; templates: number }> {
  const before = SEEDED_SALES_SUBTITLE_BEFORE_OD_150;
  // The words OD-150 gave, pinned: the seed's own moved on in P18.9-T4, and migration 0045 takes them from here.
  const after = SEEDED_TRAINING_DESCRIPTIONS_BEFORE_P18_97.SALES;

  const categories = await db.collection('trainingCategories').updateMany(
    { code: 'SALES', description: before },
    { $set: { description: after } },
  );

  // Each office's newest snapshot, where it still carries the seeded words.
  const snapshots = db.collection('configSnapshots');
  let snapshotsWritten = 0;
  for (const kpmId of await snapshots.distinct('kpmId', { deletedAt: null })) {
    const [newest] = await snapshots.find({ kpmId, deletedAt: null }).sort({ version: -1 }).limit(1).toArray();
    const training = (newest?.payload as { training?: { code?: unknown; description?: unknown }[] } | undefined)?.training;
    if (!newest || !Array.isArray(training) || !training.some((c) => c.code === 'SALES' && c.description === before)) continue;
    await snapshots.updateOne(
      { _id: newest._id },
      { $set: { 'payload.training.$[c].description': after } },
      { arrayFilters: [{ 'c.code': 'SALES', 'c.description': before }] },
    );
    snapshotsWritten += 1;
  }

  const templates = await db.collection('companyTemplates').updateMany(
    { kind: 'training_taxonomy', 'payload.categories': { $elemMatch: { code: 'SALES', description: before } } },
    { $set: { 'payload.categories.$[c].description': after } },
    { arrayFilters: [{ 'c.code': 'SALES', 'c.description': before }] },
  );

  return { categories: categories.modifiedCount, snapshots: snapshotsWritten, templates: templates.modifiedCount };
}
