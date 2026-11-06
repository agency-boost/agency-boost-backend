import mongoose from 'mongoose';
import { splitTrainingTitle, type TrainingTitleSplit } from '@/domain/constants/training-taxonomy';
import {
  differencesOf, itemsOfOffice, itemsOfPayload, ownMaterialDifferences, type OfficeRows,
} from '@/modules/config/template-push';

/** The migration's name, as its snapshots and template versions record it. */
export const TITLE_SPLIT = '0059-training-title-split';

type Doc = Record<string, unknown> & { _id: unknown };
type Level = 'skill' | 'module';

/** One name split, or left whole with its reason — what the deploy log prints. */
export interface TitleSplitLine {
  /** `kpm:<id>` or `template:<companyId>/<templateId>`. */
  where: string;
  level: Level;
  code: string;
  from: string;
  /** Split: the name and the description. Left whole: why. */
  result: { name: string; description: string } | { leftWhole: 'empty_half' | 'too_long' };
}

export interface TitleSplitResult {
  /** Template versions written: a new published one per template whose newest published training split. */
  templateVersions: number;
  /** Open drafts split in place. */
  drafts: number;
  /** KPMs with at least one row split. */
  kpms: number;
  /** KPMs whose published configuration was published again with the split (origin `migration`). */
  republished: number;
  /** KPMs unchanged against their template, `seededFrom.training_taxonomy` moved to its split version. */
  seededFromMoved: number;
  /** Every split and every refusal, per KPM and template. A title with no colon at all is not listed. */
  lines: TitleSplitLine[];
}

/** The field a level's name is in. */
const NAME: Record<Level, 'label' | 'title'> = { skill: 'label', module: 'title' };

/** What the rule decides for one stored name: the split, a refusal worth reporting, or nothing to say. */
function decide(name: unknown): TrainingTitleSplit {
  return splitTrainingTitle(typeof name === 'string' ? name : '');
}

/** A refusal is reported when there was a colon to split at. */
const reported = (d: TrainingTitleSplit): d is { split: false; reason: 'empty_half' | 'too_long' } =>
  !d.split && d.reason !== 'no_colon';

/**
 * A `training_taxonomy` payload with every skill and module given a `description` key: split where the rule splits, `null`
 * where it does not. A row that already has the key is left as it is. `changed` is whether any words moved.
 */
function splitPayload(payload: Record<string, unknown>, where: string, lines: TitleSplitLine[]) {
  let changed = false;
  let keyed = false;
  const next: Record<string, unknown> = { ...payload };
  for (const [key, level] of [['skills', 'skill'], ['modules', 'module']] as const) {
    if (!Array.isArray(payload[key])) continue;
    next[key] = (payload[key] as Record<string, unknown>[]).map((row) => {
      if (row.description !== undefined) return row;
      keyed = true;
      const d = decide(row[NAME[level]]);
      const from = String(row[NAME[level]] ?? '');
      if (d.split) {
        changed = true;
        lines.push({ where, level, code: String(row.code), from, result: { name: d.name, description: d.description } });
        return { ...row, [NAME[level]]: d.name, description: d.description };
      }
      if (reported(d)) lines.push({ where, level, code: String(row.code), from, result: { leftWhole: d.reason } });
      return { ...row, description: null };
    });
  }
  return { next, changed, keyed };
}

/**
 * **Every *"Name: description"* split once into a name and a short description** (P19.6-T4 AC-2; ADR-0220 §3; UI-161).
 * The rule is `splitTrainingTitle`: at the first colon followed by a space; left whole with no such colon, an empty half,
 * or a description past 160 characters, each refusal reported.
 *
 * **The templates first**, every company's, every template's `training_taxonomy`:
 * - **the newest published version, where it splits, gets a new published version** with the split — a published
 *   version never changes — `createdBy: '0059-training-title-split'`. A version that does not split gains nothing;
 * - **an open draft is split in place**, numbered one past the new version, its `revision` moved so an editor holding it
 *   open is refused a stale save rather than overwriting the split.
 *
 * **Then every KPM's skills and modules**, archived ones too:
 * - **a row it splits takes a new `version`**, as an Owner's edit would; one left whole gains `description: null` and
 *   keeps its version. **That field is the ledger**: a row holding `description` — `null` included — is never read again,
 *   so a name an Owner later writes with a colon is theirs, on every later deploy;
 * - **its agents see the split**: the newest published configuration is published again (origin `{ source: 'migration'
 *   }`) with each split row whose published copy was the live row; a row the KPM edited since its last publish waits
 *   for its next *Terbitkan ke agent*, as it would have;
 * - ***changed by the KPM* stays true** (ADR-0208 §4): measured before the split, against the version it was last given.
 *   A KPM given its template's newest version and unchanged has `seededFrom.training_taxonomy` moved to the split
 *   version, so it is not offered a push of its own words. Every comparison reads a row without `description` split,
 *   the same rule (`namedAs`), so one given an older version reads unchanged too.
 *
 * **Nothing else moves**: no code, progress, material, link, order, archived state or publish state. It runs in every
 * KPM, KaiZen included: a split changes which field holds the words, not the words. **Idempotent**: a second run finds
 * every row and every newest version keyed, and writes nothing.
 */
export async function up(db: mongoose.mongo.Db, now: Date): Promise<TitleSplitResult> {
  const lines: TitleSplitLine[] = [];
  const result: TitleSplitResult = { templateVersions: 0, drafts: 0, kpms: 0, republished: 0, seededFromMoved: 0, lines };
  const templates = db.collection('companyTemplates');

  // ------------------------------------------------------------------------------------------- the templates
  /** `<companyId>/<templateId>` → the version split from, and the version it became. */
  const splitTo = new Map<string, { from: number; to: number }>();
  const pairs = await templates.aggregate<{ _id: { companyId: string; templateId: string | null } }>([
    { $match: { kind: 'training_taxonomy', deletedAt: null } },
    { $group: { _id: { companyId: '$companyId', templateId: '$templateId' } } },
  ]).toArray();
  for (const { _id: { companyId, templateId } } of pairs) {
    const where = `template:${companyId}/${templateId}`;
    const scope = { companyId, templateId, kind: 'training_taxonomy', deletedAt: null };
    const [newest] = await templates.find({ ...scope, status: 'published' }).sort({ version: -1 }).limit(1).toArray();
    const draft = await templates.findOne({ ...scope, status: 'draft' });
    const [top] = await templates.find(scope).sort({ revision: -1 }).limit(1).toArray();
    let revision = Number(top?.revision ?? 0);

    if (newest) {
      const split = splitPayload((newest.payload ?? {}) as Record<string, unknown>, where, lines);
      if (split.changed) {
        const version = Number(newest.version) + 1;
        // The draft, if any, is numbered as the version it will be published as: one past the new one.
        if (draft) await templates.updateOne({ _id: draft._id }, { $set: { version: version + 1 } });
        revision += 1;
        await templates.insertOne({
          companyId, templateId, kind: 'training_taxonomy', version, revision, status: 'published',
          payload: split.next, publishedAt: now, migratedFrom: null, deletedAt: null,
          createdBy: TITLE_SPLIT, updatedBy: TITLE_SPLIT, createdAt: now, updatedAt: now,
        });
        splitTo.set(`${companyId}/${templateId}`, { from: Number(newest.version), to: version });
        result.templateVersions += 1;
      }
    }
    if (draft) {
      const split = splitPayload((draft.payload ?? {}) as Record<string, unknown>, `${where} (draft)`, lines);
      if (split.keyed) {
        revision += 1;
        await templates.updateOne({ _id: draft._id }, { $set: { payload: split.next, revision, updatedAt: now } });
        if (split.changed) result.drafts += 1;
      }
    }
  }

  // ------------------------------------------------------------------------------------------------ the KPMs
  const skills = db.collection('trainingSkills');
  const modules = db.collection('trainingModules');
  const kpmIds = new Set<string>([
    ...(await skills.distinct('kpmId', { description: { $exists: false } })),
    ...(await modules.distinct('kpmId', { description: { $exists: false } })),
  ].map(String));

  const kpmById = new Map((await db.collection('kpms')
    .find({}, { projection: { companyId: 1, seededFrom: 1, startedFrom: 1 } }).toArray())
    .map((k) => [String(k._id), k as Doc]));

  for (const kpmId of kpmIds) {
    const where = `kpm:${kpmId}`;
    const kpm = kpmById.get(kpmId);
    // *Changed by the KPM*, measured before anything is written (ADR-0208 §4).
    const unchanged = kpm ? await unchangedAgainstGiven(db, kpm, kpmId) : null;

    const splitRows = new Map<string, { label?: string; title?: string; description: string; version: number }>();
    let splitAny = false;
    for (const [collection, level] of [[skills, 'skill'], [modules, 'module']] as const) {
      for (const row of await collection.find({ kpmId, description: { $exists: false } }).toArray() as Doc[]) {
        const from = String(row[NAME[level]] ?? '');
        const d = decide(row[NAME[level]]);
        if (d.split) {
          const written = await collection.updateOne(
            { _id: row._id as never, description: { $exists: false } },
            { $set: { [NAME[level]]: d.name, description: d.description, updatedAt: now }, $inc: { version: 1 } },
          );
          if (written.modifiedCount === 0) continue;
          splitAny = true;
          splitRows.set(String(row._id), {
            [NAME[level]]: d.name, description: d.description, version: Number(row.version ?? 1) + 1,
          } as never);
          lines.push({ where, level, code: String(row.code), from, result: { name: d.name, description: d.description } });
          continue;
        }
        if (reported(d)) lines.push({ where, level, code: String(row.code), from, result: { leftWhole: d.reason } });
        await collection.updateOne({ _id: row._id as never, description: { $exists: false } }, { $set: { description: null } });
      }
    }
    if (!splitAny) continue;
    result.kpms += 1;

    if (await republish(db, kpmId, splitRows, now)) result.republished += 1;

    // An unchanged KPM given the version that was split now stands on the split version.
    const record = (kpm?.seededFrom as Record<string, { templateId?: string | null; version?: number | null }> | undefined)
      ?.training_taxonomy;
    const company = (kpm?.startedFrom as { companyId?: string } | null | undefined)?.companyId ?? String(kpm?.companyId ?? '');
    const moved = record?.templateId ? splitTo.get(`${company}/${record.templateId}`) : undefined;
    if (unchanged && moved && record?.version === moved.from) {
      await db.collection('kpms').updateOne(
        { _id: kpm!._id as never },
        { $set: { 'seededFrom.training_taxonomy': { templateId: record.templateId, version: moved.to } } },
      );
      result.seededFromMoved += 1;
    }
  }
  return result;
}

/**
 * **Whether the KPM's training is unchanged against the version it was last given** (ADR-0208 §4): by code, on the fields
 * an Owner edits, and no module showing its own material. `null` when it holds no record of a template version.
 */
async function unchangedAgainstGiven(db: mongoose.mongo.Db, kpm: Doc, kpmId: string): Promise<boolean | null> {
  const record = (kpm.seededFrom as Record<string, { templateId?: string | null; version?: number | null }> | undefined)
    ?.training_taxonomy;
  if (!record?.templateId || !record.version) return null;
  const company = (kpm.startedFrom as { companyId?: string } | null | undefined)?.companyId ?? String(kpm.companyId ?? '');
  const given = await db.collection('companyTemplates').findOne({
    companyId: company, templateId: record.templateId, kind: 'training_taxonomy', version: record.version,
    status: 'published', deletedAt: null,
  });
  if (!given) return null;
  const rows: OfficeRows = {
    activityCategories: [], activityTypes: [], binding: null, ratios: [], leadStatuses: [],
    trainingCategories: await db.collection('trainingCategories').find({ kpmId, deletedAt: null }).toArray(),
    trainingSkills: await db.collection('trainingSkills').find({ kpmId, deletedAt: null }).toArray(),
    trainingModules: await db.collection('trainingModules').find({ kpmId, deletedAt: null }).toArray(),
    checklist: null, capability: null, eventTypes: [],
  };
  const differences = differencesOf(
    'training_taxonomy', itemsOfPayload('training_taxonomy', given.payload as Record<string, unknown>), itemsOfOffice('training_taxonomy', rows),
  );
  return differences.length === 0 && ownMaterialDifferences(rows.trainingModules).length === 0;
}

/**
 * **The newest published configuration, published again with the split** (origin `{ source: 'migration' }`): a copy of
 * it, each skill and module it carries at the version the live row had before the split given the split words and the
 * row's new version. A row it carries at another version — edited since the last publish — is left as published, and
 * waits for the KPM's own publish. `false` when there is no snapshot, or nothing in it was a split row.
 */
async function republish(
  db: mongoose.mongo.Db, kpmId: string,
  split: ReadonlyMap<string, { label?: string; title?: string; description: string; version: number }>, now: Date,
): Promise<boolean> {
  const snapshots = db.collection('configSnapshots');
  const [newest] = await snapshots.find({ kpmId, deletedAt: null }).sort({ version: -1 }).limit(1).toArray();
  const training = (newest?.payload as { training?: unknown } | undefined)?.training;
  if (!newest || !Array.isArray(training)) return false;
  let touched = false;
  const patch = <T extends Record<string, unknown>>(row: T): T => {
    const s = split.get(String(row.id));
    if (!s || Number(row.version) !== s.version - 1) return row;
    touched = true;
    const { version, ...words } = s;
    return { ...row, ...words, version };
  };
  const next = (training as Record<string, unknown>[]).map((category) => ({
    ...category,
    skills: ((category.skills ?? []) as Record<string, unknown>[]).map((skill) => ({
      ...patch(skill),
      modules: ((skill.modules ?? []) as Record<string, unknown>[]).map(patch),
    })),
  }));
  if (!touched) return false;
  const { _id: _ignored, ...rest } = newest;
  await snapshots.insertOne({
    ...rest,
    version: Number(newest.version) + 1,
    payload: { ...(newest.payload as Record<string, unknown>), training: next },
    publishedAt: now,
    publishedBy: null,
    origin: { source: 'migration', migration: TITLE_SPLIT },
    createdAt: now,
    updatedAt: now,
  });
  return true;
}
