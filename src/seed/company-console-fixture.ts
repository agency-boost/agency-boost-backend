import mongoose from 'mongoose';
import type { Clock } from '@/common/clock/clock.port';
import { up as namedTemplates } from '@/migrations/0023-named-templates';
import { up as templateCompany } from '@/migrations/0037-template-company';

/** The product the demo adds to Prudential and publishes to nobody yet: *Produk baru · PRUWell Medical*. */
const NEW_PRODUCT = 'PRUWELL_MEDICAL';
/** Allianz Life's new product, also unpublished, so both companies' cards say what waits. */
const ALLIANZ_PRODUCT = 'AZ_SMARTHEALTH';

/**
 * ***Perusahaan & template*'s demo state** (P19.23-T4; ADR-0278; the `always-seed-new-data` rule): what the companies
 * page and *Terbitkan ke KPM* need to be reviewed in a browser.
 *
 * - **The Default template card**: the Template library (migration `0037`) and each company's named default template
 *   (migration `0023`), both idempotent, run here so a fresh seed shows them without `pnpm migrate` first.
 * - **Two companies with unpublished changes**: Prudential — a *Lead statuses* draft (the first sales stage renamed) and
 *   *PRUWell Medical*, a new product no KPM has yet; Allianz Life — *AZ SmartHealth*, likewise new.
 * - **A KPM that changed a setting itself**: Kelapa Gading Branch (0555) renamed its first sales stage, so step 2 marks it
 *   *Lead statuses sudah diubah KPM ini* and, once the draft is chosen, *akan tertimpa*.
 *
 * Idempotent: every write is guarded by what is already there, so a second run writes nothing.
 */
export async function seedCompanyConsoleFixture(input: {
  clock: Clock;
  prudentialId: string;
  allianzId: string;
  /** Kelapa Gading Branch: the KPM that changed its lead statuses itself. */
  kpmChangedId: string;
}): Promise<{ guide: string }> {
  const db = mongoose.connection.db as mongoose.mongo.Db;
  const now = input.clock.now();
  await namedTemplates(db, now);
  await templateCompany(db, now);

  const templates = db.collection('templates');
  const rows = db.collection('companyTemplates');
  const prudentialTemplate = await templates.findOne({ companyId: input.prudentialId, isDefault: true, deletedAt: null });

  // Prudential's *Lead statuses* draft: the newest published payload with the first sales stage renamed.
  let firstSales: string | null = null;
  if (prudentialTemplate) {
    const templateId = String(prudentialTemplate._id);
    const published = await rows.find({ companyId: input.prudentialId, templateId, kind: 'lead_pipeline', status: 'published', deletedAt: null })
      .sort({ version: -1 }).limit(1).next();
    const statuses = ((published?.payload as { statuses?: { code: string; label: string; pipeline?: string }[] } | undefined)?.statuses) ?? [];
    const first = statuses.find((s) => (s.pipeline ?? 'sales') === 'sales');
    firstSales = first?.code ?? null;
    const waiting = await rows.findOne({ companyId: input.prudentialId, templateId, kind: 'lead_pipeline', status: 'draft', deletedAt: null });
    if (published && first && !waiting) {
      const payload = structuredClone(published.payload) as { statuses: { code: string; label: string }[] };
      payload.statuses.find((s) => s.code === first.code)!.label = 'Prospek baru masuk';
      await rows.insertOne({
        companyId: input.prudentialId, templateId, kind: 'lead_pipeline', version: (published.version as number) + 1,
        status: 'draft', payload, revision: 1, publishedAt: null, deletedAt: null, createdBy: null, updatedBy: null,
        createdAt: now, updatedAt: now,
      });
    }
  }

  // Kelapa Gading renamed the same stage itself: its own version, which a push would overwrite.
  if (firstSales) {
    await db.collection('leadStatuses').updateOne(
      { kpmId: input.kpmChangedId, code: firstSales, label: { $ne: 'Prospek (Kelapa Gading)' } },
      { $set: { label: 'Prospek (Kelapa Gading)', updatedAt: now } },
    );
  }

  // The new products, released to nobody: the companies' cards and step 1 list them.
  const products = db.collection('products');
  for (const [companyId, code, name, tagline] of [
    [input.prudentialId, NEW_PRODUCT, 'PRUWell Medical', 'Asuransi kesehatan dengan hadiah gaya hidup sehat; diskon premi hingga 20%.'],
    [input.allianzId, ALLIANZ_PRODUCT, 'AZ SmartHealth', 'Asuransi kesehatan rawat inap as-billed.'],
  ] as const) {
    if (await products.findOne({ companyId, code })) continue;
    const last = await products.find({ companyId, deletedAt: null }).sort({ sortOrder: -1 }).limit(1).next();
    await products.insertOne({
      companyId, code, name, tagline, channel: 'conventional', category: 'health', kind: 'base', attachesTo: [],
      currencies: ['IDR'], primaryNeeds: ['health'], eligibleAgeBands: [], eligibleBudgetBands: [], benefits: [],
      differentiator: '', bestFor: '',
      defaultAttackPlan: { goodFit: '', opening: '', benefits: [], fullScript: '', objections: [], nextAction: '' },
      defaultDocuments: {}, commissionSchedule: [], proposalFields: [], planOptions: [], faq: [], pdfDetail: [],
      calcType: 'manual', lifecycle: 'active', replacedByProductId: null, activeByDefault: true,
      sortOrder: ((last?.sortOrder as number | undefined) ?? 0) + 1, version: 1,
      draft: null, releasedTo: [], firstPublishedAt: null, alsoFits: [],
      deletedAt: null, createdBy: null, updatedBy: null, createdAt: now, updatedAt: now,
    });
  }

  return {
    guide: 'Perusahaan & template (P19.23-T4): Prudential waits on a Lead statuses draft and PRUWell Medical (no KPM has it); '
      + 'Allianz Life on AZ SmartHealth; Kelapa Gading Branch renamed its first sales stage itself — sign in as the Super '
      + 'Admin, open Perusahaan → Prudential → Terbitkan ke KPM, tick Lead statuses and Kelapa Gading: akan tertimpa.',
  };
}
