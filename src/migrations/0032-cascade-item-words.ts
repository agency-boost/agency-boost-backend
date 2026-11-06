import mongoose from 'mongoose';
import { SEED_ACTIVITY_TYPES, SEEDED_ACTIVITY_WORDINGS_BEFORE_ADR_0160 } from '@/domain/constants/activity-taxonomy';

/** One rewrite: the rows of `code` still holding one of `labels` (and `description`, when named) take `set`. */
interface Rewrite {
  code: string;
  labels: readonly string[];
  description?: string;
  set: { label: string; description?: null };
}

/**
 * The rewrites, **item 7's description first**: a row still holding both seeded words loses the note with the
 * label, and the label-only rewrite after it no longer matches that row. A row whose label an Owner wrote keeps
 * the note beside it — it may describe their label.
 */
function rewrites(): Rewrite[] {
  const label = (code: string) => SEED_ACTIVITY_TYPES.find((t) => t.code === code)!.label;
  const seven = SEEDED_ACTIVITY_WORDINGS_BEFORE_ADR_0160.RECRUIT_PRESENTATION;
  return [
    {
      code: 'RECRUIT_PRESENTATION', labels: seven.labels, description: seven.description,
      set: { label: label('RECRUIT_PRESENTATION'), description: null },
    },
    ...(['LEADS_CONTACTED', 'RECRUIT_PRESENTATION', 'RECRUIT_FOLLOWUP'] as const).map((code) => ({
      code, labels: SEEDED_ACTIVITY_WORDINGS_BEFORE_ADR_0160[code].labels, set: { label: label(code) },
    })),
  ];
}

/** What a row (or an array element, under `prefix`) must hold for `rewrite` to apply. */
function matching(rewrite: Rewrite, prefix = ''): Record<string, unknown> {
  return {
    [`${prefix}code`]: rewrite.code,
    [`${prefix}label`]: { $in: [...rewrite.labels] },
    ...(rewrite.description === undefined ? {} : { [`${prefix}description`]: rewrite.description }),
  };
}

/** `$set` for an array element at `path`: `{ '<path>.label': …, '<path>.description': … }`. */
function setting(rewrite: Rewrite, path: string): Record<string, unknown> {
  return Object.fromEntries(Object.entries(rewrite.set).map(([field, value]) => [`${path}.${field}`, value]));
}

/**
 * **Items 3, 7 and 8 in the client's words** (ADR-0160 §1, OD-180; P18.5-T8 AC-3).
 *
 * *Menghubungi prospek yang sudah ada* becomes *Set Appointment*; item 7 — *Presentasi NBO ke calon agen* in every
 * office provisioned before P13.1-T3, *Proses pendaftaran kode agen* since — becomes *Melakukan presentasi
 * recruitment*, losing its note *secara mandiri atau melalui BOP*; item 8 says *recruitment* where it said *NBO*.
 * A new office is given the words by the seed; this gives an existing office the same **only where it still holds
 * a seeded wording**. An Owner who wrote their own keeps them, label and note alike.
 *
 * - **The working copy** (`activityTypes`), which Settings › Activity types edits;
 * - **each office's newest published snapshot** (`configSnapshots`, `payload.activity[].types[]`), which agents
 *   read — so Log Activity, the ratios and the summary say the new words without anybody publishing, as 0029 did:
 *   words, not anything an agent counted;
 * - **every Company template** of kind `activity_taxonomy`, draft and published, so the next office a company
 *   creates starts where its existing ones now stand.
 *
 * **Codes, never positions** (invariant §4): a row is found by `code`, wherever an Owner has dragged it. **No
 * version moves**, so no publish bar speaks and no office reads as built from another template version.
 * **Idempotent**: only the seeded words are matched, and they are what is replaced.
 */
export async function up(db: mongoose.mongo.Db): Promise<{ types: number; snapshots: number; templates: number }> {
  const all = rewrites();

  let types = 0;
  for (const rewrite of all) {
    const written = await db.collection('activityTypes').updateMany(matching(rewrite), { $set: rewrite.set });
    types += written.modifiedCount;
  }

  // Each office's newest snapshot, where it still carries a seeded wording.
  const snapshots = db.collection('configSnapshots');
  let snapshotsWritten = 0;
  for (const kpmId of await snapshots.distinct('kpmId', { deletedAt: null })) {
    const [newest] = await snapshots.find({ kpmId, deletedAt: null }).sort({ version: -1 }).limit(1).toArray();
    if (!newest) continue;
    let touched = false;
    for (const rewrite of all) {
      const written = await snapshots.updateOne(
        // Guarded on the element, so a snapshot without `payload.activity` is never given an array path.
        { _id: newest._id, 'payload.activity.types': { $elemMatch: matching(rewrite) } },
        { $set: setting(rewrite, 'payload.activity.$[].types.$[t]') },
        { arrayFilters: [matching(rewrite, 't.')] },
      );
      if (written.modifiedCount > 0) touched = true;
    }
    if (touched) snapshotsWritten += 1;
  }

  const templates = db.collection('companyTemplates');
  let templatesWritten = 0;
  const candidates = await templates.find(
    { kind: 'activity_taxonomy', $or: all.map((rewrite) => ({ 'payload.types': { $elemMatch: matching(rewrite) } })) },
    { projection: { _id: 1 } },
  ).toArray();
  for (const { _id } of candidates) {
    let touched = false;
    for (const rewrite of all) {
      const written = await templates.updateOne(
        { _id, 'payload.types': { $elemMatch: matching(rewrite) } },
        { $set: setting(rewrite, 'payload.types.$[t]') },
        { arrayFilters: [matching(rewrite, 't.')] },
      );
      if (written.modifiedCount > 0) touched = true;
    }
    if (touched) templatesWritten += 1;
  }

  return { types, snapshots: snapshotsWritten, templates: templatesWritten };
}
