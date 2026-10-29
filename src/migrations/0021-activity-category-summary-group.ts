import mongoose from 'mongoose';
import { SEED_ACTIVITY_CATEGORIES } from '@/domain/constants';
import { SEEDED_ACTIVITY_WORDINGS_BEFORE_OD_238 } from '@/domain/constants/activity-taxonomy';

/**
 * Give every existing office the prototype's four summary tiles (ADR-0064, P10.1-T5).
 *
 * `summaryGroupCode` and `summaryGroupLabel` decide which tile a section counts toward on the
 * `/activity/log` and `/activity/dashboard` strips. The seed now sets them — *Personal
 * Development* and *Team Development* share **Development**; every other section is a tile of its
 * own and carries neither field (OD-101, resolved 2026-10-01), so its tile follows its name — and
 * this writes the same mapping into what already exists:
 *
 * - **the working copy** (`activityCategories`), which the settings screens edit;
 * - **the newest published snapshot** (`configSnapshots`), which is what `GET /kpm/config` serves
 *   and every agent reads. 0011 declined to rewrite a snapshot, because training was content an
 *   Owner had not published. This is not: ADR-0064 decides the strip changes **without an Owner
 *   publishing**, and a field no metric reads changes no count agents were shown (§ *Presentation,
 *   never a metric input*);
 * - **every Company template** of kind `activity_taxonomy`, draft and published, so the next
 *   office a company creates starts where its existing ones now stand.
 *
 * **No version moves.** The publish bar compares which rows are present at which version, and the
 * tile's own values (`TenantConfigService.fingerprint`); the working copy and the snapshot are
 * written the same values, so the bar stays as it was. A template's version is the one offices
 * record they were built from, and it stays too.
 *
 * **What is grouped.** A seeded code is given its seed tile only where the office holds it
 * untouched: every member of a shared tile present (`DEVELOPMENT` needs both of its sections, or
 * one alone would be relabelled *Development* for no reason), none of them already given a tile,
 * and the tile's code not already the office's own. Everything else — the seed's single sections,
 * and every section an office added — gets `null` on both: a tile of its own, under its own label,
 * which is what it already had, and which a rename carries.
 *
 * **Idempotent**: only rows with no `summaryGroupCode` key are written, and every row this touches
 * gets one. The snapshot is written before the working copy, so a run stopped between the two
 * finishes on the next: the working copy is still undecided, and the decision is recomputed from
 * the same rows.
 */

interface Section {
  code?: unknown;
  label?: unknown;
  summaryGroupCode?: unknown;
  summaryGroupLabel?: unknown;
}

/** A seeded tile, its label, and the sections it takes. */
interface SeedTile {
  label: string;
  members: string[];
}

/**
 * The seed's tiles, by code — read from the seed, the one place the mapping is written. **The label is the one it was
 * written for**, *Development*: the seed has said *Pengembangan* since P18.98-T7 (OD-238), and an office's own
 * configuration keeps its language.
 */
function seedTiles(): Map<string, SeedTile> {
  const tiles = new Map<string, SeedTile>();
  for (const category of SEED_ACTIVITY_CATEGORIES) {
    if (!category.summaryGroupCode || !category.summaryGroupLabel) continue;
    const label = SEEDED_ACTIVITY_WORDINGS_BEFORE_OD_238.categories[category.code]?.summaryGroupLabel
      ?? category.summaryGroupLabel;
    const tile = tiles.get(category.summaryGroupCode)
      ?? { label, members: [] };
    tile.members.push(category.code);
    tiles.set(category.summaryGroupCode, tile);
  }
  return tiles;
}

/** No key at all: written before the field existed, and never decided by anybody. */
const undecided = (row: Section): boolean =>
  !Object.prototype.hasOwnProperty.call(row, 'summaryGroupCode');

/** Per section code, the shared tile it joins. */
type Decision = Map<string, { summaryGroupCode: string; label: string }>;

/** Which of a set of sections get a seeded tile — the rule the docstring states. */
function decide(rows: readonly Section[], tiles: Map<string, SeedTile>): Decision {
  const held = new Map(rows.map((row) => [String(row.code), row]));
  const taken = new Set(
    rows.filter((row) => typeof row.summaryGroupCode === 'string' && row.summaryGroupCode)
      .map((row) => String(row.summaryGroupCode)),
  );
  const decision: Decision = new Map();
  for (const [summaryGroupCode, tile] of tiles) {
    const members = tile.members.map((code) => held.get(code));
    if (members.some((row) => !row || !undecided(row))) continue;
    if (taken.has(summaryGroupCode)) continue;
    for (const code of tile.members) {
      decision.set(code, { summaryGroupCode, label: tile.label });
    }
  }
  return decision;
}

/** One section with its tile written, or the section unchanged when it already has one. */
function applied<T extends Section>(row: T, decision: Decision): T {
  if (!undecided(row)) return row;
  const tile = decision.get(String(row.code));
  return {
    ...row,
    summaryGroupCode: tile ? tile.summaryGroupCode : null,
    summaryGroupLabel: tile ? tile.label : null,
  };
}

export async function up(db: mongoose.mongo.Db): Promise<{
  offices: number; categories: number; snapshots: number; templates: number;
}> {
  const tiles = seedTiles();
  const categories = db.collection('activityCategories');
  const snapshots = db.collection('configSnapshots');
  const templates = db.collection('companyTemplates');
  let offices = 0;
  let categoriesWritten = 0;
  let snapshotsWritten = 0;
  let templatesWritten = 0;

  const kpmIds = await categories.distinct('kpmId', { deletedAt: null });
  for (const kpmId of kpmIds) {
    const rows = await categories.find({ kpmId, deletedAt: null }).toArray() as (Section & { _id: unknown })[];
    const pending = rows.filter(undecided);
    if (pending.length === 0) continue;
    // Decided over every section the office holds, archived included — they count for the tile too.
    const decision = decide(rows, tiles);

    // The snapshot first: a run stopped after it finishes on the next, from the same decision.
    const [newest] = await snapshots.find({ kpmId, deletedAt: null })
      .sort({ version: -1 }).limit(1).toArray();
    const published = (newest?.payload as { activity?: Section[] } | undefined)?.activity;
    if (newest && Array.isArray(published) && published.some(undecided)) {
      await snapshots.updateOne(
        { _id: newest._id },
        { $set: { 'payload.activity': published.map((row) => applied(row, decision)) } },
      );
      snapshotsWritten += 1;
    }

    for (const row of pending) {
      const { summaryGroupCode, summaryGroupLabel } = applied(row, decision);
      await categories.updateOne(
        { _id: row._id as mongoose.mongo.ObjectId, summaryGroupCode: { $exists: false } },
        { $set: { summaryGroupCode, summaryGroupLabel } },
      );
    }
    categoriesWritten += pending.length;
    offices += 1;
  }

  const taxonomies = await templates.find({
    kind: 'activity_taxonomy', status: { $in: ['draft', 'published'] }, deletedAt: null,
  }).toArray();
  for (const template of taxonomies) {
    const rows = (template.payload as { categories?: Section[] } | undefined)?.categories;
    if (!Array.isArray(rows) || !rows.some(undecided)) continue;
    const decision = decide(rows, tiles);
    await templates.updateOne(
      { _id: template._id },
      { $set: { 'payload.categories': rows.map((row) => applied(row, decision)) } },
    );
    templatesWritten += 1;
  }

  return {
    offices, categories: categoriesWritten, snapshots: snapshotsWritten, templates: templatesWritten,
  };
}
