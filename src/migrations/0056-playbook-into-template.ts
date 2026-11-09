import mongoose from 'mongoose';

/** What one run did. Printed by `run.ts`, so the deploy log is the record of it. */
export interface PlaybookIntoTemplateResult {
  /** Company playbooks moved into their templates this run, each record marked `migratedTo`. */
  moved: number;
  /** Template versions written: one per template a playbook went into — its default, and each a KPM was made from. */
  versions: number;
  /** Records already moved by an earlier run, left alone. */
  current: number;
  /** Records of a company with no default template: left as they are, for a later run once it has one. */
  noTemplate: number;
  /** Records of a company made since P19.4-T5 (`playbookInTemplates`), whose words `0025` wrote: never moved. */
  skipped: number;
  /** Templates that already held a playbook of their own: kept, not overwritten. */
  ownKept: number;
}

/**
 * **Each company's recruitment playbook, moved into its templates** (P19.4-T5 AC-7; ADR-0210 §5; the 11-03 handover's
 * B1-11, *"Move each company's current playbook into its live template"*).
 *
 * For each company's live `recruitmentPlaybooks` record not yet moved:
 *
 * - **Into its default template**, as a **published** version of the `recruitment_playbook` kind, its words unchanged.
 *   **Its version continues the record's**: the record's `version` becomes the template version's, so the history reads
 *   on — the `recruitment_playbook.saved` audit entries stay where they are. The version carries `migratedFrom`.
 * - **And into every other template of the company a live KPM was made from** (`kpms.startedFrom.templateId`), the same
 *   way. A KPM reads the playbook of the template it was made from (ADR-0210 §4), and before this every KPM of the
 *   company read the company's one playbook: so **every KPM reads the same words before and after** (T5 AC-8), whichever
 *   template it was made from. *ADR-0210 §5 names the default template; the KPMs made from another one are why this
 *   goes further — see the ADR's dated note.*
 * - **The record stays**, marked `migratedTo: { templateId, version }` (the default's), read by nothing, never
 *   hard-deleted (invariant §6).
 *
 * **What it leaves alone:**
 *
 * - **A template that already holds a playbook** of its own — a version not `migratedFrom` this record — keeps it.
 * - **A company with no default template**: nothing to move into. Its record waits for a run after it has one.
 * - **A company made since P19.4-T5** (`companies.playbookInTemplates`): its playbook was never the company's. Migration
 *   `0025` still runs on every deploy and gives a company with no record the AgencyBoost words; those are never moved.
 * - **The Template library** is a company like the others: its playbook becomes its *Default template*'s.
 *
 * **Idempotent**: a template version `migratedFrom` the record is left alone, and a record marked `migratedTo` is
 * current. A second run writes nothing (a test runs it twice).
 */
export async function up(db: mongoose.mongo.Db, now: Date): Promise<PlaybookIntoTemplateResult> {
  const playbooks = db.collection('recruitmentPlaybooks');
  const companies = db.collection('companies');
  const named = db.collection('templates');
  const sections = db.collection('companyTemplates');
  const kpms = db.collection('kpms');
  const result: PlaybookIntoTemplateResult = { moved: 0, versions: 0, current: 0, noTemplate: 0, skipped: 0, ownKept: 0 };

  const records = await playbooks.find({ deletedAt: null }).sort({ _id: 1 }).toArray();
  for (const record of records) {
    if (record.migratedTo) {
      result.current += 1;
      continue;
    }
    const companyId = String(record.companyId);
    const company = await companies.findOne({ _id: { $in: ids([companyId]) } }, { projection: { playbookInTemplates: 1 } });
    if (company?.playbookInTemplates === true) {
      result.skipped += 1;
      continue;
    }
    const byDefault = await named.findOne({ companyId, isDefault: true, deletedAt: null }, { projection: { _id: 1 } });
    if (!byDefault) {
      result.noTemplate += 1;
      continue;
    }
    const defaultId = String(byDefault._id);

    // The templates its KPMs were made from, where each is one of the company's own: they read it too.
    const started = await kpms.distinct('startedFrom.templateId', {
      companyId, deletedAt: null, 'startedFrom.source': 'template',
      $or: [{ 'startedFrom.companyId': { $exists: false } }, { 'startedFrom.companyId': null }, { 'startedFrom.companyId': companyId }],
    }) as unknown[];
    const others = (await named.find(
      { companyId, deletedAt: null, _id: { $in: ids(started.filter(Boolean).map(String)) } },
      { projection: { _id: 1 } },
    ).toArray()).map((t) => String(t._id)).filter((id) => id !== defaultId);

    const recordId = String(record._id);
    const version = typeof record.version === 'number' && record.version > 0 ? record.version : 1;
    for (const templateId of [defaultId, ...others]) {
      const kind = { companyId, templateId, kind: 'recruitment_playbook', deletedAt: null };
      if (await sections.findOne({ ...kind, 'migratedFrom.recruitmentPlaybookId': recordId }, { projection: { _id: 1 } })) {
        continue;
      }
      if (await sections.findOne(kind, { projection: { _id: 1 } })) {
        result.ownKept += 1;
        continue;
      }
      // Timestamps by hand: this insert has no Mongoose in between to stamp it.
      await sections.insertOne({
        companyId,
        templateId,
        kind: 'recruitment_playbook',
        version,
        revision: version,
        status: 'published',
        payload: structuredClone(record.body),
        publishedAt: record.updatedAt ?? now,
        migratedFrom: { recruitmentPlaybookId: recordId, version },
        deletedAt: null,
        createdBy: record.updatedBy ?? null,
        updatedBy: record.updatedBy ?? null,
        createdAt: now,
        updatedAt: now,
      });
      result.versions += 1;
    }

    await playbooks.updateOne(
      { _id: record._id, migratedTo: { $in: [null] } },
      { $set: { migratedTo: { templateId: defaultId, version }, updatedAt: now } },
    );
    result.moved += 1;
  }
  return result;
}

/** Ids as they may be stored: each as written, and as an ObjectId where it is one's hex. */
function ids(list: readonly string[]): mongoose.Types.ObjectId[] {
  // A string id is matched too: the driver's types allow only ObjectIds, and both are what `_id` may hold here.
  return list.flatMap((id) => (/^[0-9a-f]{24}$/i.test(id)
    ? [id as unknown as mongoose.Types.ObjectId, new mongoose.Types.ObjectId(id)]
    : [id as unknown as mongoose.Types.ObjectId]));
}
