import mongoose from 'mongoose';
import type { Clock } from '@/common/clock/clock.port';
import { CompanyTemplate, CompanyTemplateSchema } from '@/modules/config/company-template.schema';
import { NamedTemplate, NamedTemplateSchema } from '@/modules/config/named-template.schema';
import { templateKindsFromOffice, type OfficeSettings } from '@/modules/config/office-template';
import { OFFICE_TEMPLATE_KINDS } from '@/modules/config/template-defaults';
import { seedObjectId } from './coaching-fixture';

/**
 * **A template saved from an office** (Phase 13.2, *Seed*; ADR-0115 §5; P13.2-T7).
 *
 * Which account shows what:
 *
 * | What | Its state | Who to sign in as, and what they see |
 * |---|---|---|
 * | **BSD City settings**, Prudential | saved from **KPM 0417**'s published settings — what its agents read: the snapshot's activity types, ratios, both pipelines, training, event types and capability ladder, and the published checklist — each kind a published version 1; origin *office*, 0417 | `superadmin@agencyboost.test` at `/admin/companies/{Prudential}/template`: the picker holds *Prudential template · Default* and *BSD City settings*, no office yet; at `/admin/tenants/new`, *Start from* offers it second. *Save as template* on `/admin/tenants/{0417}` and *Import from another company* on Sejahtera Baru Life's template screen are the walk's to press |
 *
 * **Made by the function the console's *Save as template* uses** (`templateKindsFromOffice`), over 0417's
 * rows read as `OfficeSettingsSource` reads them, so the seeded template is what pressing the button would
 * give. 0417 holds no training file of its own, so nothing is duplicated; a seed that gave it one would
 * have to go through storage, and this refuses rather than reference an office's file from a template.
 *
 * **Ids are derived** (`seedObjectId`) and each row is **written only where missing**: a re-seed without
 * `--reset` writes nothing, and a template renamed or republished in a walk is kept. Office 0417 is read,
 * never written.
 */

const RECOMPILE = { overwriteModels: true } as const;

/** The template, by derived id. */
export const BSD_CITY_SETTINGS = {
  _id: seedObjectId('template-copy-fixture', 'template', 'bsd-city-settings'),
  name: 'BSD City settings',
} as const;

export interface TemplateCopyFixtureDeps {
  clock: Clock;
  /** Prudential, whose template it becomes — 0417's own company. */
  companyId: string;
  /** Office 0417, whose published settings are saved. */
  kpm0417: string;
}

export interface TemplateCopyFixture {
  templateId: string;
  /** Rows this run wrote: the template and its kinds, or nothing on a re-run. */
  written: number;
  guide: string;
}

export async function seedTemplateCopyFixture(deps: TemplateCopyFixtureDeps): Promise<TemplateCopyFixture> {
  const { companyId, kpm0417: kpmId } = deps;
  const templateId = BSD_CITY_SETTINGS._id;
  const Templates = mongoose.model(NamedTemplate.name, NamedTemplateSchema, undefined, RECOMPILE);
  const Rows = mongoose.model(CompanyTemplate.name, CompanyTemplateSchema, undefined, RECOMPILE);
  const guide = `
    Prudential                   "BSD City settings", saved from KPM 0417's published settings — every
                                 kind a published version 1, no office yet (from src/seed/template-copy-fixture.ts)
`;

  // A template of that name made in a walk is the walk's: this one is not made beside it.
  const clash = await Templates.findOne({
    companyId, name: BSD_CITY_SETTINGS.name, status: 'active', deletedAt: null, _id: { $ne: templateId },
  }).collation({ locale: 'en', strength: 2 }).exec();
  if (clash) return { templateId: String(clash._id), written: 0, guide };

  const { kinds, files } = templateKindsFromOffice(await officeSettingsOf(kpmId));
  if (files.some((file) => file.owner === 'office')) {
    throw new Error(
      'KPM 0417 holds training files of its own, which a template must hold copies of (ADR-0115 §6). '
        + 'The seed has no storage to copy them through: give the seed a company file instead.',
    );
  }

  const now = deps.clock.now();
  let written = 0;
  // Its kinds first, then the template that names them — the order `writeTemplate` keeps.
  for (const kind of OFFICE_TEMPLATE_KINDS) {
    const payload = kinds[kind];
    if (!payload || (await Rows.exists({ companyId, templateId, kind, deletedAt: null }))) continue;
    await Rows.create({
      companyId, templateId, kind, version: 1, status: 'published', payload, publishedAt: now,
      deletedAt: null, createdBy: null, updatedBy: null,
    });
    written += 1;
  }
  if (!(await Templates.exists({ _id: templateId }))) {
    await Templates.create({
      _id: templateId, companyId, name: BSD_CITY_SETTINGS.name, isDefault: false, status: 'active',
      archivedAt: null, origin: { kind: 'office', kpmId, companyId }, deletedAt: null,
      createdBy: null, updatedBy: null,
    });
    written += 1;
  }
  return { templateId, written, guide };
}

/**
 * 0417's published settings, read as `OfficeSettingsSource` reads them: the newest snapshot — the taxonomy,
 * ratios, pipelines, training, event types and capability catalog its agents are on — the newest published
 * checklist, and the content of the modules that snapshot offers.
 */
async function officeSettingsOf(kpmId: string): Promise<OfficeSettings> {
  const db = mongoose.connection.db!;
  const newest = async (name: string, filter: Record<string, unknown> = {}) =>
    (await db.collection(name).find({ ...filter, kpmId, deletedAt: null }).sort({ version: -1 }).limit(1).toArray())[0];

  const snapshot = await newest('configSnapshots');
  const checklist = await newest('activationTemplates', { status: 'published' });
  const payload = (snapshot?.payload as Record<string, unknown> | undefined) ?? null;
  const training = (payload?.training ?? []) as { skills?: { modules?: { code: string }[] }[] }[];
  const codes = training.flatMap((c) => (c.skills ?? []).flatMap((s) => (s.modules ?? []).map((m) => m.code)));
  const modules = await db.collection('trainingModules')
    .find({ kpmId, deletedAt: null, code: { $in: codes } }).toArray();
  return {
    snapshot: payload,
    checklist: (checklist as unknown as OfficeSettings['checklist']) ?? null,
    moduleContent: modules.map((m) => ({
      code: m.code as string, companyContent: m.companyContent ?? null, officeContent: m.officeContent ?? null,
    })),
  };
}
