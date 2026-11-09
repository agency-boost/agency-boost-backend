import mongoose from 'mongoose';
import {
  SEEDED_LEAD_STATUS_LABELS_BEFORE_ADR_0167, SEEDED_LEAD_STATUS_LABELS_BEFORE_OD_238,
} from '@/domain/constants/activity-taxonomy';

/** The status this rewrites, by code: the recruitment pipeline's first. */
const CODE = 'NOT_APPROACHED';

/**
 * Which pipeline, the seeded words it may still hold, and the words it takes — all read from the constants. **The
 * words it takes are the ones it was written for**, *Not yet approached*: the seed has said *Belum didekati* since
 * P18.10-T7 (OD-238), and an office's own configuration keeps its language — a template is a copy, never a link.
 */
function rewrite(): { pipeline: string; labels: string[]; label: string } {
  const before = SEEDED_LEAD_STATUS_LABELS_BEFORE_ADR_0167[CODE];
  const label = SEEDED_LEAD_STATUS_LABELS_BEFORE_OD_238[before.pipeline][CODE];
  return { pipeline: before.pipeline, labels: [...before.labels], label };
}

/**
 * **The recruitment pipeline's first status in the sales pipeline's words** (ADR-0167 §10, OD-205; the client's UI
 * review of 2026-10-26, UI-027; P18.7-T9 AC-6).
 *
 * The sales pipeline starts at *Not yet approached* and the recruitment pipeline at *Not approached* — the
 * prototype's two words for one stage. The client asked for one. A new office is given *Not yet approached* by the
 * seed; this gives an existing office the same **only where the status still holds the seeded *Not approached***.
 * An Owner who wrote their own keeps it.
 *
 * - **The working copy** (`leadStatuses`), which Settings › Lead statuses edits — archived rows included, because a
 *   lead still at an archived stage shows its label; soft-deleted rows not, because nothing reads them;
 * - **each office's newest published snapshot** (`configSnapshots`, `payload.leadPipelines[].statuses[]`), which
 *   agents read — so the lead list and its filters say the new words without anybody publishing, as 0032 did:
 *   words, not anything a lead holds. An older snapshot is history and keeps what it said;
 * - **every Company template** of kind `lead_pipeline` (`payload.statuses[]`), draft and published, of every
 *   company — the Template company's *Default template* among them — so the next office a template creates starts
 *   where its existing ones now stand.
 *
 * **Codes, never positions** (invariant §4): the status is found by `code` within the recruitment pipeline, wherever
 * an Owner has dragged it; the sales pipeline's `NOT_YET_APPROACHED`, and any other code holding the same words, is
 * not it. A lead holds the code, so no lead moves. **No version moves**, so no publish bar speaks and no office reads
 * as built from another template version. **Idempotent**: only the seeded words are matched, and they are what is
 * replaced. On an empty database it reads nothing and creates nothing.
 */
export async function up(db: mongoose.mongo.Db): Promise<{ statuses: number; snapshots: number; templates: number }> {
  const { pipeline, labels, label } = rewrite();
  const seeded = { code: CODE, label: { $in: labels } };

  const statuses = await db.collection('leadStatuses').updateMany(
    { pipeline, ...seeded, deletedAt: null },
    { $set: { label } },
  );

  // Each office's newest snapshot, where its recruitment pipeline still carries the seeded words.
  const snapshots = db.collection('configSnapshots');
  let snapshotsWritten = 0;
  for (const kpmId of await snapshots.distinct('kpmId', { deletedAt: null })) {
    const [newest] = await snapshots.find({ kpmId, deletedAt: null }).sort({ version: -1 }).limit(1).toArray();
    if (!newest) continue;
    const written = await snapshots.updateOne(
      // Guarded on the element, so a snapshot without `payload.leadPipelines` is never given an array path.
      { _id: newest._id, 'payload.leadPipelines': { $elemMatch: { pipeline, statuses: { $elemMatch: seeded } } } },
      { $set: { 'payload.leadPipelines.$[p].statuses.$[s].label': label } },
      { arrayFilters: [{ 'p.pipeline': pipeline }, { 's.code': CODE, 's.label': { $in: labels } }] },
    );
    snapshotsWritten += written.modifiedCount;
  }

  const templates = await db.collection('companyTemplates').updateMany(
    { kind: 'lead_pipeline', deletedAt: null, 'payload.statuses': { $elemMatch: { pipeline, ...seeded } } },
    { $set: { 'payload.statuses.$[s].label': label } },
    { arrayFilters: [{ 's.pipeline': pipeline, 's.code': CODE, 's.label': { $in: labels } }] },
  );

  return { statuses: statuses.modifiedCount, snapshots: snapshotsWritten, templates: templates.modifiedCount };
}
