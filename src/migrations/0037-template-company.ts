import mongoose from 'mongoose';
import {
  DEFAULT_CURRENCY, DEFAULT_ORG_LADDER, DEFAULT_TENANT_TIMEZONE, SEED_PRODUCTS,
} from '@/domain/constants';
import {
  defaultCampaignKinds, qualificationRuleSeedDocuments,
} from '@/modules/campaigns/campaign-kinds-payload';
import { OFFICE_TEMPLATE_KINDS, platformDefaultPayload } from '@/modules/config/template-defaults';
import { defaultPlaybookBody } from '@/modules/recruitment/recruitment-playbook-defaults';
import { TEMPLATE_LIBRARY } from '@/modules/tenants/template-library';

/** What one run did. Printed by `run.ts`, so the deploy log is the record of it. */
export interface TemplateCompanyResult {
  /** Whether this run wrote the company. `false` on every run after the one that made it. */
  created: boolean;
  /** Ladder rungs written: the default ladder, with its leader tiers. */
  rungs: number;
  products: number;
  /** The carrier's qualification rules: the production club tiers and MOC. */
  carrierRules: number;
  /** Whether the recruitment playbook was written. */
  playbook: boolean;
  /** Kinds of the Default template published as version 1. Seven on the run that makes it. */
  kinds: number;
  /** Whether the Default template itself was written. */
  template: boolean;
}

/**
 * **The *Template* company** (ADR-0164 §1, §2; P18.6-T3 AC-2).
 *
 * The *Template library*: a company of kind `template`, named **Template** (slug `template`), holding what a
 * new company copies — the role ladder with its leader tiers (ADR-0156), the 31 products, the carrier rules,
 * the recruitment playbook — and one named template, **Default template**, the company's default, with each of
 * the seven kinds published as version 1. All of it from the AgencyBoost defaults as Phase 18.5 left them: the
 * activity labels and benchmarks of ADR-0160, the tiers, and the activity binding of ADR-0163 in the taxonomy.
 * It runs on every deploy, so **every environment has it**, staging and production alike, before any tenant.
 *
 * **What a company created with the defaults is given, written the way the earlier migrations write it**, so
 * that `0001` (the ladder), `0013` (the products), `0023` (a default template, each kind published) and `0025`
 * (the playbook) find each already there on the next run and add nothing. `usesPlatformDefaults` is written
 * `true`, which is what those read. The carrier rules are `CampaignService.seedForCompany`'s, from the same
 * payload `campaign_kinds` publishes. No `campaign_kinds` row is written: a company that never published the
 * kind reads the platform's on its tab, as every company created with the defaults does.
 *
 * **The parts first, the company last, every write keyed on the fixed ids** (`TEMPLATE_LIBRARY`): a run that
 * stopped part-way left parts and no company, and the next one adds what is missing under the same ids before
 * it writes the company. Until then no earlier migration sees the company, so none of them gives it anything
 * of its own — `0023` would have named its default *"Template template"*.
 *
 * **Does nothing once the company exists**, whatever its slug has become since: the Template is the Super
 * Admin's to edit from then on, and a deploy never puts back a default somebody changed (ADR-0164 §2).
 *
 * **Refuses, naming it, a company that already holds the slug** and is not the Template. Nothing is written,
 * and the deploy stops at the migration step with the message: the slug is changed at `/admin/companies` and
 * the deploy run again. Taking another slug silently would leave the platform with a company called *Template*
 * that registration lists as an insurer.
 */
export async function up(db: mongoose.mongo.Db, now: Date): Promise<TemplateCompanyResult> {
  const companies = db.collection('companies');
  const result: TemplateCompanyResult = {
    created: false, rungs: 0, products: 0, carrierRules: 0, playbook: false, kinds: 0, template: false,
  };

  if (await companies.findOne({ kind: 'template', deletedAt: null }, { projection: { _id: 1 } })) return result;

  const clash = await companies.findOne(
    { slug: TEMPLATE_LIBRARY.slug, deletedAt: null }, { projection: { name: 1 } },
  );
  if (clash) {
    throw new Error(
      `Cannot create the Template company: the slug "${TEMPLATE_LIBRARY.slug}" already belongs to `
        + `${String(clash.name)} (${String(clash._id)}), which is an insurer. Give that company another slug at `
        + '/admin/companies, then run the migrations again. Nothing was written.',
    );
  }

  const companyId = TEMPLATE_LIBRARY.companyId;
  const templateId = TEMPLATE_LIBRARY.defaultTemplateId;
  // Timestamps by hand: there is no Mongoose here to stamp them.
  const stamps = { createdAt: now, updatedAt: now };
  /** Insert `doc` where nothing matches `filter`; 1 when it did. A part already written is left as it is. */
  const insertMissing = async (collection: string, filter: Record<string, unknown>, doc: Record<string, unknown>) =>
    (await db.collection(collection).updateOne(filter, { $setOnInsert: doc }, { upsert: true })).upsertedCount;

  // ---- The ladder, with its tiers: what `OrgLevelService.seedDefaultLadder` gives a company.
  for (const { code, label, displayOrder, leaderTier } of DEFAULT_ORG_LADDER) {
    result.rungs += await insertMissing('companyOrgLevels', { companyId, code, deletedAt: null }, {
      companyId, code, label, displayOrder, leaderTier,
      status: 'active', archivedAt: null, deletedAt: null, ...stamps, version: 0,
    });
  }

  // ---- The products, as `0013` and `ProductService.seedForCompany` write them: no commission, which each
  // company states for itself (parity F-15).
  for (const product of SEED_PRODUCTS) {
    result.products += await insertMissing('products', { companyId, code: product.code, deletedAt: null }, {
      ...product,
      primaryNeeds: [...product.primaryNeeds],
      eligibleAgeBands: [...product.eligibleAgeBands],
      eligibleBudgetBands: [...product.eligibleBudgetBands],
      benefits: [...product.benefits],
      defaultAttackPlan: { ...product.defaultAttackPlan, benefits: [...product.defaultAttackPlan.benefits] },
      companyId,
      commissionSchedule: [],
      replacedByProductId: null,
      lifecycleChangedAt: null,
      lifecycleChangedBy: null,
      version: 1,
      deletedAt: null,
      createdBy: null,
      updatedBy: null,
      ...stamps,
    });
  }

  // ---- The carrier rules: the production club tiers and MOC, from the payload `campaign_kinds` publishes.
  for (const rule of qualificationRuleSeedDocuments(companyId, defaultCampaignKinds())) {
    result.carrierRules += await insertMissing(
      'qualificationRules', { companyId, kind: rule.kind, code: rule.code, deletedAt: null },
      { ...rule, ...stamps, __v: 0 },
    );
  }

  // ---- The recruitment playbook, version 1 of the AgencyBoost words, as `0025` writes it.
  result.playbook = await insertMissing('recruitmentPlaybooks', { companyId, deletedAt: null }, {
    companyId, body: defaultPlaybookBody(), version: 1, updatedBy: null, createdBy: null, deletedAt: null, ...stamps,
  }) > 0;

  // ---- Default template: each kind a published version 1 of the defaults, then the template that names them.
  for (const kind of OFFICE_TEMPLATE_KINDS) {
    result.kinds += await insertMissing('companyTemplates', { companyId, templateId, kind, version: 1, deletedAt: null }, {
      companyId, templateId, kind, version: 1, status: 'published',
      payload: platformDefaultPayload(kind), publishedAt: now,
      deletedAt: null, createdBy: null, updatedBy: null, ...stamps, __v: 0,
    });
  }
  result.template = await insertMissing('templates', { _id: new mongoose.Types.ObjectId(templateId) }, {
    companyId,
    name: TEMPLATE_LIBRARY.defaultTemplateName,
    isDefault: true,
    status: 'active',
    archivedAt: null,
    // Made from the AgencyBoost defaults, which is what *New template from the defaults* records.
    origin: { kind: 'defaults' },
    deletedAt: null,
    createdBy: null,
    updatedBy: null,
    ...stamps,
    version: 0,
  }) > 0;

  // ---- The company, last.
  await companies.insertOne({
    _id: new mongoose.Types.ObjectId(companyId),
    name: TEMPLATE_LIBRARY.name,
    slug: TEMPLATE_LIBRARY.slug,
    defaultCurrency: DEFAULT_CURRENCY,
    defaultLocale: 'id-ID',
    defaultTimezone: DEFAULT_TENANT_TIMEZONE,
    status: 'active',
    // Written, not left to the schema: `0013`, `0023` and `0025` read it, absent meaning true.
    usesPlatformDefaults: true,
    kind: 'template',
    deletedAt: null,
    ...stamps,
    version: 0,
  });
  result.created = true;

  return result;
}
