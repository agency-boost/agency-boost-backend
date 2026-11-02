import mongoose from 'mongoose';
import { CASCADE_ACTIVITY_CODES } from '@/domain/constants';
import { OFFICE_TEMPLATE_KINDS, platformDefaultPayload } from '@/modules/config/template-defaults';
import { emptyIfMissing } from './missing-collection';

/** What one run did. Printed by `run.ts`, so the deploy log is the record of it. */
export interface NamedTemplatesResult {
  companies: number;
  /** Default templates made, one per company that had none. */
  templatesCreated: number;
  /** `companyTemplates` rows of the seven kinds given their company's default template. */
  rowsAssigned: number;
  /** `campaign_kinds` rows given `templateId: null` — the company's, under no template. */
  campaignRowsMarked: number;
  /** Kinds a defaults company had never published, published as version 1 of the defaults. */
  defaultsPublished: number;
  /** Drafts moved from version 1 to 2 to make room for that version 1. */
  draftsRenumbered: number;
  /** Whether the old one-version-per-company index was dropped. */
  oldIndexDropped: boolean;
  /**
   * **Offices with a cascade activity type archived** (ADR-0115 §2). Reported and left alone: the
   * office archived it before archiving one was refused, and the migration touches no office.
   */
  cascadeArchived: { kpmId: string; codes: string[] }[];
}

const RESERVED: readonly string[] = Object.values(CASCADE_ACTIVITY_CODES);

/**
 * **Named templates** (ADR-0115 §3, P13.2-T6 AC-1).
 *
 * Each company gets one template, *"{Company name} template"*, **its default**, holding every
 * `companyTemplates` row of the seven per-office kinds it has — so nothing it published moves, and
 * every office that records a version of it still records a version of the same thing. Its
 * `origin` is `migration`, which is also what makes it answer for the offices created before 13.2
 * (`startedFrom: null`) in the template screen's counts.
 *
 * **A company created with the defaults** (`usesPlatformDefaults`, absent meaning true as in `0017`)
 * gets each kind it never published as a **published version 1 of the AgencyBoost defaults**. Provisioning
 * used to fall back to those defaults for an unpublished kind; it no longer falls back (ADR-0115 §1),
 * so without this the company's next office would arrive empty where its last arrived full. With it,
 * that office gets exactly what one gets today. **A blank company gets nothing**: its unpublished kinds
 * stay unpublished, so its next office starts empty — which is the defect the client reported, fixed.
 *
 * `campaign_kinds` is the company's, one per company and shared by every template (ADR-0026): its rows
 * are given `templateId: null` and nothing else.
 *
 * The unique index moves from `(companyId, kind, version)` to `(companyId, templateId, kind, version)`:
 * a second template's version 1 of a kind is not a duplicate of the first's.
 *
 * **Touches no office.** An office with a cascade activity type archived is reported, never changed.
 *
 * **Idempotent**: a company with a default template is not given another; rows already under a
 * template are not reassigned; a kind already published is not published again; a dropped index is
 * not dropped twice.
 */
export async function up(db: mongoose.mongo.Db, now: Date): Promise<NamedTemplatesResult> {
  const companies = db.collection('companies');
  const named = db.collection('templates');
  const rows = db.collection('companyTemplates');

  const result: NamedTemplatesResult = {
    companies: 0,
    templatesCreated: 0,
    rowsAssigned: 0,
    campaignRowsMarked: 0,
    defaultsPublished: 0,
    draftsRenumbered: 0,
    oldIndexDropped: false,
    cascadeArchived: [],
  };

  /*
   * The index first: with the old one standing, a second template could never publish a version 1 of
   * a kind the first template has, and this run's own version 1s would collide with nothing — but the
   * next `New template` would.
   */
  // A fresh database has no such collection yet: no index to drop. Any other failure is thrown (P18.7-T1).
  const indexes: { name?: string }[] = await emptyIfMissing(rows.indexes());
  if (indexes.some((i) => i.name === 'companyId_1_kind_1_version_1')) {
    await rows.dropIndex('companyId_1_kind_1_version_1');
    result.oldIndexDropped = true;
  }
  if (indexes.some((i) => i.name === 'companyId_1_kind_1_status_1_version_-1')) {
    await rows.dropIndex('companyId_1_kind_1_status_1_version_-1');
  }

  for (const company of await companies.find({}).toArray()) {
    result.companies += 1;
    const companyId = String(company._id);

    let template = await named.findOne({ companyId, isDefault: true, deletedAt: null });
    if (!template) {
      const inserted = await named.insertOne({
        companyId,
        name: `${String(company.name).trim()} template`,
        isDefault: true,
        status: 'active',
        archivedAt: null,
        origin: { kind: 'migration' },
        deletedAt: null,
        createdBy: null,
        updatedBy: null,
        // Timestamps by hand: there is no Mongoose here to stamp them.
        createdAt: now,
        updatedAt: now,
        version: 0,
      });
      template = await named.findOne({ _id: inserted.insertedId });
      result.templatesCreated += 1;
    }
    const templateId = String(template!._id);

    const assigned = await rows.updateMany(
      { companyId, kind: { $ne: 'campaign_kinds' }, templateId: null },
      { $set: { templateId } },
    );
    result.rowsAssigned += assigned.modifiedCount;

    const marked = await rows.updateMany(
      { companyId, kind: 'campaign_kinds', templateId: { $exists: false } },
      { $set: { templateId: null } },
    );
    result.campaignRowsMarked += marked.modifiedCount;

    // Absent is true, as migration 0017 wrote it for every company that predates the switch.
    if (company.usesPlatformDefaults === false) continue;

    for (const kind of OFFICE_TEMPLATE_KINDS) {
      if (await rows.findOne({ companyId, templateId, kind, status: 'published', deletedAt: null })) continue;

      // A draft carries the version it will be — 1, with nothing published. Publishing renumbers it.
      const renumbered = await rows.updateMany(
        { companyId, templateId, kind, status: 'draft', version: 1 },
        { $set: { version: 2 } },
      );
      result.draftsRenumbered += renumbered.modifiedCount;

      await rows.insertOne({
        companyId,
        templateId,
        kind,
        version: 1,
        status: 'published',
        payload: platformDefaultPayload(kind),
        publishedAt: now,
        deletedAt: null,
        createdBy: null,
        updatedBy: null,
        createdAt: now,
        updatedAt: now,
        __v: 0,
      });
      result.defaultsPublished += 1;
    }
  }

  /*
   * The new keys. Mongoose builds them on start as well (`autoIndex`); building them here closes the
   * gap between. One Mongoose already built with other options is left as it is, not fought over.
   */
  const ensure = (keys: Record<string, 1 | -1>, options: mongoose.mongo.CreateIndexesOptions = {}) =>
    rows.createIndex(keys, options).catch((err: { code?: number }) => {
      if (err.code !== 85 && err.code !== 86) throw err;
    });
  await ensure(
    { companyId: 1, templateId: 1, kind: 1, version: 1 },
    { unique: true, partialFilterExpression: { deletedAt: null } },
  );
  await ensure({ companyId: 1, templateId: 1, kind: 1, status: 1, version: -1 });

  const archived = await db.collection('activityTypes')
    .find({ code: { $in: [...RESERVED] }, status: 'archived', deletedAt: null }, { projection: { kpmId: 1, code: 1 } })
    .toArray();
  const byOffice = new Map<string, string[]>();
  for (const row of archived) {
    const kpmId = String(row.kpmId);
    byOffice.set(kpmId, [...(byOffice.get(kpmId) ?? []), String(row.code)].sort());
  }
  result.cascadeArchived = [...byOffice.entries()]
    .map(([kpmId, codes]) => ({ kpmId, codes }))
    .sort((a, b) => a.kpmId.localeCompare(b.kpmId));

  return result;
}
