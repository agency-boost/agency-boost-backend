import mongoose from 'mongoose';
import {
  defaultTrainingTaxonomy, trainingSeedDocuments, type TrainingTaxonomyPayload,
} from '@/modules/training/training-payload';

/**
 * Give every office that already exists the training taxonomy a new one is provisioned with
 * (P5-T1, ADR-0029).
 *
 * **From the company's newest published `training_taxonomy`, or the domain defaults** — what
 * `ProvisioningService.seedTrainingTaxonomy` copies — and recorded in
 * `seededFrom.training_taxonomy` the same way: a template's id and version, or a null version
 * for the defaults (P5-T12). An office left unrecorded would read as *unrecorded* on the
 * Company template's Training tab forever, when what it was built from is known.
 *
 * **Not published.** Agents on an office's existing snapshot are offered no training until its
 * Owner or an Admin next publishes, and the publish bar says so — which is true. Rewriting a
 * published snapshot would make it describe something nobody published.
 *
 * Idempotent: an office with any training row is left alone, and an existing record is never
 * overwritten.
 */
export async function up(
  db: mongoose.mongo.Db,
  now: Date,
): Promise<{ seeded: number; skipped: number }> {
  const kpms = db.collection('kpms');
  const templates = db.collection('companyTemplates');
  const collections = {
    categories: db.collection('trainingCategories'),
    skills: db.collection('trainingSkills'),
    modules: db.collection('trainingModules'),
  };

  const offices = await kpms.find({ deletedAt: null }, { projection: { companyId: 1 } }).toArray();
  let seeded = 0;
  let skipped = 0;

  for (const office of offices) {
    const kpmId = String(office._id);
    const hasAny = await collections.categories.findOne({ kpmId })
      ?? await collections.skills.findOne({ kpmId })
      ?? await collections.modules.findOne({ kpmId });
    if (hasAny) {
      skipped += 1;
      continue;
    }

    const template = await templates
      .find({ companyId: office.companyId, kind: 'training_taxonomy', status: 'published', deletedAt: null })
      .sort({ version: -1 })
      .limit(1)
      .next();
    const payload = template
      ? (template.payload as TrainingTaxonomyPayload)
      : defaultTrainingTaxonomy();

    // Timestamps by hand: these inserts have no Mongoose in between to stamp them.
    const stamped = <T extends object>(rows: T[]) => rows.map((row) => ({ ...row, createdAt: now, updatedAt: now }));
    const rows = trainingSeedDocuments(kpmId, payload);
    if (rows.categories.length) await collections.categories.insertMany(stamped(rows.categories));
    if (rows.skills.length) await collections.skills.insertMany(stamped(rows.skills));
    if (rows.modules.length) await collections.modules.insertMany(stamped(rows.modules));

    await kpms.updateOne(
      { _id: office._id, 'seededFrom.training_taxonomy': { $exists: false } },
      {
        $set: {
          'seededFrom.training_taxonomy': {
            templateId: template ? String(template._id) : null,
            version: template ? (template.version as number) : null,
          },
        },
      },
    );
    seeded += 1;
  }
  return { seeded, skipped };
}
