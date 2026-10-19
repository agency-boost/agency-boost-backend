import mongoose from 'mongoose';
import {
  activationSeedAspects, activationTrainingLinks, defaultActivationChecklist,
} from '@/modules/activation/activation-payload';

/**
 * Give every office that already exists the activation checklist a new one is provisioned with
 * (P5-T3, ADR-0031).
 *
 * **From the company's newest published `activation_checklist`, or the seed** — what
 * `ProvisioningService.seedActivationChecklist` copies — written as the office's **version 1,
 * published**, and recorded in `seededFrom.activation_checklist` the same way: a template's id and
 * version, or a null version for the seed (P5-T12).
 *
 * **A training link the office cannot honour falls back to the seed.** A company template may name a
 * module by code, and an office that has since archived or unpublished it would be given a checklist
 * with an item nothing can ever complete. Rather than refuse the whole migration — which would leave
 * every office after it in the list unseeded — that office is seeded from the defaults, which link to
 * no module at all, and counted separately so the run says it happened.
 *
 * Idempotent: an office that already has a checklist is left alone, and an existing record is never
 * overwritten.
 */
export async function up(
  db: mongoose.mongo.Db,
  now: Date,
): Promise<{ seeded: number; skipped: number; fellBackToDefaults: number }> {
  const kpms = db.collection('kpms');
  const templates = db.collection('companyTemplates');
  const checklists = db.collection('activationTemplates');
  const modules = db.collection('trainingModules');

  const offices = await kpms.find({ deletedAt: null }, { projection: { companyId: 1 } }).toArray();
  let seeded = 0;
  let skipped = 0;
  let fellBackToDefaults = 0;

  for (const office of offices) {
    const kpmId = String(office._id);
    if (await checklists.findOne({ kpmId })) {
      skipped += 1;
      continue;
    }

    const template = await templates
      .find({ companyId: office.companyId, kind: 'activation_checklist', status: 'published', deletedAt: null })
      .sort({ version: -1 })
      .limit(1)
      .next();

    let aspects = activationSeedAspects(template ? template.payload : defaultActivationChecklist());
    let from = template;

    const wanted = activationTrainingLinks(aspects);
    if (wanted.length) {
      const offered = await modules
        .find({ kpmId, code: { $in: wanted }, status: 'active', publishState: 'published', deletedAt: null })
        .project({ code: 1 })
        .toArray();
      if (offered.length !== wanted.length) {
        aspects = activationSeedAspects(defaultActivationChecklist());
        from = null;
        fellBackToDefaults += 1;
      }
    }

    // Timestamps by hand: this insert has no Mongoose in between to stamp it.
    await checklists.insertOne({
      kpmId,
      version: 1,
      status: 'published',
      publishedAt: now,
      aspects,
      deletedAt: null,
      createdBy: null,
      updatedBy: null,
      createdAt: now,
      updatedAt: now,
    });

    await kpms.updateOne(
      { _id: office._id, 'seededFrom.activation_checklist': { $exists: false } },
      {
        $set: {
          'seededFrom.activation_checklist': {
            templateId: from ? String(from._id) : null,
            version: from ? (from.version as number) : null,
          },
        },
      },
    );
    seeded += 1;
  }
  return { seeded, skipped, fellBackToDefaults };
}
