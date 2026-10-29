import mongoose from 'mongoose';
import {
  SEEDED_TRAINING_DESCRIPTIONS_BEFORE_P18_97, SEEDED_TRAINING_WORDINGS_BEFORE_OD_238,
} from '@/domain/constants/training-taxonomy';

/** A category as the three places below hold it: its code, its words, and — on an office's rows — its version. */
interface Held {
  code?: unknown;
  description?: unknown;
  version?: unknown;
}

/** No description: what the five empty categories were seeded with, stored as `null` (an empty string is the same). */
const isNone = (value: unknown) => value === null || value === undefined || value === '';

/**
 * **Does this category still hold the words it was seeded with?** Sales by its exact sentence, as 0029 matched it. One
 * of the other five by holding no description **and never having been edited** (`version` 1, an office's rows and the
 * snapshots carrying it): an Owner who cleared a description they had written made a choice, and a migration runs on
 * every deploy (the list keeps no ledger), so without the version it would put the words back each time.
 */
function holdsSeed(category: Held, { versioned }: { versioned: boolean }): boolean {
  const code = typeof category.code === 'string' ? category.code : '';
  if (!(code in SEEDED_TRAINING_DESCRIPTIONS_BEFORE_P18_97)) return false;
  const before = SEEDED_TRAINING_DESCRIPTIONS_BEFORE_P18_97[code];
  if (before !== null) return category.description === before;
  return isNone(category.description) && (!versioned || category.version === 1);
}

/**
 * **The lines it was written for**, P18.97-T4's English: the seed has said them in Bahasa Indonesia since P18.98-T7
 * (OD-238), and an office's own configuration keeps its language. Migration `0046` gives the Template company's
 * Default template the Indonesian, where it still holds these.
 */
const AFTER = new Map(
  Object.entries(SEEDED_TRAINING_WORDINGS_BEFORE_OD_238.categories).map(([code, c]) => [code, c.description]),
);

/** The `$set` that gives each category of `list` still holding its seeded words its new line, at `path.{i}`. */
function rewrites(list: unknown, path: string, versioned: boolean): Record<string, string> {
  const set: Record<string, string> = {};
  if (!Array.isArray(list)) return set;
  list.forEach((category: Held, i) => {
    if (holdsSeed(category, { versioned })) set[`${path}.${i}.description`] = AFTER.get(category.code as string)!;
  });
  return set;
}

/**
 * **One real line of description for each default training category** (P18.97-T4 AC-9, ADR-0176 §9; the client's
 * UI-031: Sales's *"Structured modules — tracked here."* is generic, and the other five said nothing). A new office was
 * given these words (in Bahasa Indonesia since P18.98-T7); this gives them to the places that still hold the seeded ones:
 *
 * - **the working copy** (`trainingCategories`), which Settings › Training edits — archived rows too, which still
 *   render a member's history;
 * - **each office's newest published snapshot** (`configSnapshots`), which agents read, so the line arrives without
 *   anybody publishing, as 0029's did;
 * - **every Company template** of kind `training_taxonomy`, draft and published — the Template company's *Default
 *   template* among them — so the next office starts where the existing ones now stand. A template's categories carry
 *   no version, so its empty five are given their line only while its Sales still holds the seeded sentence: a template
 *   somebody has edited keeps its words, and a second run finds Sales moved on and writes nothing.
 *
 * **An office's own words are untouched**, and so is a category it has edited. **No version moves**, so no publish bar
 * speaks. **Idempotent**: a rewritten category no longer holds the seeded words.
 */
export async function up(db: mongoose.mongo.Db): Promise<{ categories: number; snapshots: number; templates: number }> {
  let categories = 0;
  const rows = db.collection('trainingCategories');
  for (const row of await rows.find({ code: { $in: Object.keys(SEEDED_TRAINING_DESCRIPTIONS_BEFORE_P18_97) } }).toArray()) {
    if (!holdsSeed(row as Held, { versioned: true })) continue;
    const written = await rows.updateOne(
      { _id: row._id, description: row.description ?? null },
      { $set: { description: AFTER.get(row.code as string)! } },
    );
    categories += written.modifiedCount;
  }

  // Each office's newest snapshot, where it still carries the seeded words.
  const snapshots = db.collection('configSnapshots');
  let snapshotsWritten = 0;
  for (const kpmId of await snapshots.distinct('kpmId', { deletedAt: null })) {
    const [newest] = await snapshots.find({ kpmId, deletedAt: null }).sort({ version: -1 }).limit(1).toArray();
    const set = rewrites((newest?.payload as { training?: unknown } | undefined)?.training, 'payload.training', true);
    if (!newest || Object.keys(set).length === 0) continue;
    await snapshots.updateOne({ _id: newest._id }, { $set: set });
    snapshotsWritten += 1;
  }

  const templates = db.collection('companyTemplates');
  let templatesWritten = 0;
  for (const template of await templates.find({ kind: 'training_taxonomy' }).toArray()) {
    const list = (template.payload as { categories?: Held[] } | undefined)?.categories;
    // The template is still the default's while its Sales holds the seeded sentence; otherwise it is somebody's.
    const sales = Array.isArray(list) ? list.find((c) => c.code === 'SALES') : undefined;
    if (!sales || !holdsSeed(sales, { versioned: false })) continue;
    const set = rewrites(list, 'payload.categories', false);
    await templates.updateOne({ _id: template._id }, { $set: set });
    templatesWritten += 1;
  }

  return { categories, snapshots: snapshotsWritten, templates: templatesWritten };
}
