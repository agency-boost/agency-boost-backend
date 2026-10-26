import mongoose from 'mongoose';
import { SEED_RATIO_DEFINITIONS, SEEDED_RATIO_VALUES_BEFORE_ADR_0160 } from '@/domain/constants/activity-taxonomy';

/** One move: the rows of `code` whose `field` still holds `from` take `to`. */
interface Move {
  code: string;
  field: 'benchmark' | 'label' | 'displayUnit';
  from: unknown;
  to: unknown;
  /** Only on a rule the new value fits: a unit of `percent` is for a ratio judged at or above its benchmark. */
  comparison?: 'gte';
}

/** Every field the seed moved, each on its own: an Owner's own value in one leaves the others to move. */
function moves(): Move[] {
  const out: Move[] = [];
  for (const [code, before] of Object.entries(SEEDED_RATIO_VALUES_BEFORE_ADR_0160)) {
    const after = SEED_RATIO_DEFINITIONS.find((r) => r.code === code)!;
    out.push({ code, field: 'benchmark', from: before.benchmark, to: after.benchmark });
    if (before.label !== undefined) out.push({ code, field: 'label', from: before.label, to: after.label });
    if (before.displayUnit !== undefined) {
      out.push({ code, field: 'displayUnit', from: before.displayUnit, to: after.displayUnit, comparison: 'gte' });
    }
  }
  return out;
}

/** What a row (or an array element, under `prefix`) must hold for `move` to apply. */
function matching(move: Move, prefix = ''): Record<string, unknown> {
  return {
    [`${prefix}code`]: move.code,
    [`${prefix}${move.field}`]: move.from,
    ...(move.comparison ? { [`${prefix}comparison`]: move.comparison } : {}),
  };
}

/**
 * **The client's benchmarks, and *Set appointment to meeting*** (ADR-0160 §2, OD-181; P18.8-T9 AC-2).
 *
 * Selling and recruitment success rise from 15% to 30%, leads per activity from 0.30 to 1, and *Meeting per
 * approach* becomes *Set appointment to meeting*, written as a percent, with a benchmark of 50% where it was 1.50.
 * A new office is given them by the seed; this gives an existing office the same **only where each value is still
 * the seeded one**. An Owner's own benchmark stands (ADR-0024), and so does their own name or unit.
 *
 * - **The working copy** (`ratioDefinitions`), which Settings › Ratio benchmarks edits and `/activity/ratio`
 *   reads;
 * - **each office's newest published snapshot** (`configSnapshots`, `payload.ratios[]`);
 * - **every Company template** of kind `ratio_set`, draft and published.
 *
 * Each field moves on its own, by `code` (invariant §4): an Owner who renamed the ratio and left its benchmark
 * gets the new benchmark under their name. **The formula is not touched**, and **no version moves**, so no publish
 * bar speaks. **Idempotent**: only the seeded values are matched, and none of them is a value the seed now gives.
 */
export async function up(db: mongoose.mongo.Db): Promise<{ ratios: number; snapshots: number; templates: number }> {
  const all = moves();

  const touchedRows = new Set<string>();
  for (const move of all) {
    const rows = await db.collection('ratioDefinitions').find(matching(move), { projection: { _id: 1 } }).toArray();
    if (rows.length === 0) continue;
    await db.collection('ratioDefinitions').updateMany(
      { _id: { $in: rows.map((r) => r._id) } },
      { $set: { [move.field]: move.to } },
    );
    for (const { _id } of rows) touchedRows.add(String(_id));
  }

  // Each office's newest snapshot, where it still carries a seeded value.
  const snapshots = db.collection('configSnapshots');
  let snapshotsWritten = 0;
  for (const kpmId of await snapshots.distinct('kpmId', { deletedAt: null })) {
    const [newest] = await snapshots.find({ kpmId, deletedAt: null }).sort({ version: -1 }).limit(1).toArray();
    if (!newest) continue;
    if (await moveIn(snapshots, newest._id, 'payload.ratios', all)) snapshotsWritten += 1;
  }

  const templates = db.collection('companyTemplates');
  let templatesWritten = 0;
  const candidates = await templates.find(
    { kind: 'ratio_set', $or: all.map((move) => ({ 'payload.ratios': { $elemMatch: matching(move) } })) },
    { projection: { _id: 1 } },
  ).toArray();
  for (const { _id } of candidates) {
    if (await moveIn(templates, _id, 'payload.ratios', all)) templatesWritten += 1;
  }

  return { ratios: touchedRows.size, snapshots: snapshotsWritten, templates: templatesWritten };
}

/** Every move on one document's array at `path`; whether any of them wrote. */
async function moveIn(
  collection: mongoose.mongo.Collection, _id: mongoose.mongo.ObjectId, path: string, all: readonly Move[],
): Promise<boolean> {
  let touched = false;
  for (const move of all) {
    const written = await collection.updateOne(
      // Guarded on the element, so a document without the array is never given an array path.
      { _id, [path]: { $elemMatch: matching(move) } },
      { $set: { [`${path}.$[r].${move.field}`]: move.to } },
      { arrayFilters: [matching(move, 'r.')] },
    );
    if (written.modifiedCount > 0) touched = true;
  }
  return touched;
}
