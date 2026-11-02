import mongoose from 'mongoose';
import type { Clock } from '@/common/clock/clock.port';
import { DEFAULT_ORG_LADDER, DEFAULT_TENANT_TIMEZONE } from '@/domain/constants';
import { Company, CompanySchema } from '@/modules/tenants/company.schema';
import { CompanyOrgLevel, CompanyOrgLevelSchema } from '@/modules/tenants/company-org-level.schema';
import { DEFAULT_KPM_SETTINGS, type KpmStartedFrom } from '@/modules/tenants/kpm.schema';
import { NamedTemplate, NamedTemplateSchema } from '@/modules/config/named-template.schema';
import { ActivityCategory, ActivityCategorySchema } from '@/modules/config/activity-category.schema';
import { ActivityType, ActivityTypeSchema } from '@/modules/config/activity-type.schema';
import { CapabilityCatalog, CapabilityCatalogSchema } from '@/modules/capability/capability.schema';
import { capabilitySeedDocument } from '@/modules/capability/capability-payload';
import { OFFICE_TEMPLATE_KINDS, withCascadeTypes, withPlatformLadder } from '@/modules/config/template-defaults';
import { up as namedTemplates, type NamedTemplatesResult } from '@/migrations/0023-named-templates';
import { up as templateCompany, type TemplateCompanyResult } from '@/migrations/0037-template-company';
import { seedObjectId } from './coaching-fixture';

/**
 * **Named templates, and an office started *Empty*, seeded** (Phase 13.2, *Seed*; ADR-0115, P13.2-T6).
 *
 * Which account shows what — every field account on `"demo password field"`:
 *
 * | What | Its state | Who to sign in as, and what they see |
 * |---|---|---|
 * | **Prudential** | holds **Prudential template**, its default — the template migration `0023` gives every company, holding the event types the seed published and each other kind as a published version 1 of the AgencyBoost defaults | `superadmin@agencyboost.test` at `/admin/companies/{Prudential}` (*Template KPM*, ADR-0185): its card, *★ Default*, its office count, its sections published; at `/admin/tenants/new`, *Mulai dari* offers it first, then *Template bawaan AgencyBoost* and *Kosong* — no *AgencyBoost defaults* since ADR-0168 §2 |
 * | **Allianz Life** | **Allianz Life template**, the same way, with its own two event types | the picker on Allianz's template screen |
 * | **Sejahtera Baru Life** (new) | a company created **without** the defaults — *Started blank* — whose default template, *Sejahtera Baru Life template*, holds nothing | its template screen: every tab empty |
 * | **Template** (P18.9-T3) | the *Template library* (ADR-0164): made by migration `0037`, as every environment's is — the default ladder with its tiers, the 31 products, the carrier rules, the playbook, and **Default template**, its default, every kind a published version 1 of the AgencyBoost defaults | `superadmin@agencyboost.test` at `/admin/companies`: the card *Template bawaan AgencyBoost* above the table (ADR-0185), not a row; its company page; at `/admin/tenants/new`, *Mulai dari* offers it, under *Template bawaan AgencyBoost*, after the company's own; at `/admin/org-levels`, listed under *Company* and badged *Template library*, its ladder edited like any company's (ADR-0168 §3); not offered as a company at `/admin/tenants/new`, nor at registration, `/admin` or `/admin/analytics` |
 * | **0701** Cempaka Putih (new), Sejahtera Baru Life | started ***Empty***: the three cascade activity types in *Leads Generation* and *Selling*, the platform capability ladder (ADR-0116: four stages, five milestones, four grids), and nothing else — no lead stages, ratios, training, checklist or event types — so **no activation** | `owner@kpm0701.test`: every other settings screen opens empty and authors its first row, *Capability Mapping* shows the standard ladder; archiving one of the three is refused. `agent@kpm0701.test`: Log Activity with the three, the empty states elsewhere, no *New agent* section |
 *
 * A second Prudential template, *BSD City settings* saved from 0417, is the copies' fixture's (P13.2-T7,
 * `template-copy-fixture.ts`).
 *
 * **Ids are derived** (`seedObjectId`) and every row is **written only where missing**, so a re-seed
 * without `--reset` writes nothing, and a template renamed or published in a walk is kept. Office 0417's
 * configuration is not touched: the migration gives Prudential's existing rows a template and moves
 * nothing an office reads.
 */

/** The password every account below signs in with: the seed's field password. */
export const TEMPLATE_FIXTURE_PASSWORD = 'demo password field';

const ZONE = DEFAULT_TENANT_TIMEZONE;
const RECOMPILE = { overwriteModels: true } as const;

/** The company created without the defaults, by derived id. */
export const BLANK_COMPANY = {
  _id: seedObjectId('template-fixture', 'company', 'sejahtera-baru-life'),
  name: 'Sejahtera Baru Life',
  slug: 'sejahtera-baru-life',
} as const;

/** Office 0701, started *Empty*. */
export const EMPTY_OFFICE = {
  _id: seedObjectId('template-fixture', 'kpm', '0701'),
  code: '0701',
  branchName: 'Cempaka Putih Branch',
} as const;

/** The two people of 0701, each with their insurer's own code. */
export const TEMPLATE_FIXTURE_PEOPLE = {
  owner0701: { email: 'owner@kpm0701.test', fullName: 'Hadi Gunawan', pronoun: 'he', agentCode: '70001' },
  agent0701: { email: 'agent@kpm0701.test', fullName: 'Nadia Putri', pronoun: 'she', agentCode: '70002' },
} as const;

/** A company's default template id, derived — what migration `0023` would otherwise mint at random. */
export const defaultTemplateIdOf = (companyId: string) => seedObjectId('template-fixture', 'template', companyId, 'default');

type Role = 'ab' | 'aab' | 'agent';
interface Placed { id: string; ancestorIds: string[]; depth: number }
interface OfficeRef { _id: unknown; code: string; companyId: string }

/** What the demo seed hands over: its own helpers, so a person and a placement are made one way. */
export interface TemplateFixtureDeps {
  clock: Clock;
  /** `--reset`: the `templates` collection is this fixture's to empty. */
  reset?: boolean;
  Kpms: mongoose.Model<never>;
  /** The companies the seed already made, which migration `0023` gives their templates. */
  companies: { _id: string; name: string }[];
  user: (
    email: string,
    fullName: string,
    opts?: { pronoun?: 'she' | 'he'; agentCode?: string; companyId?: string },
  ) => Promise<{ _id: unknown }>;
  publish: (kpmId: string, at: Date) => Promise<unknown>;
  place: (
    kpm: OfficeRef, userId: string, role: Role, leader: Placed | null, opts?: { joinedDaysAgo?: number },
  ) => Promise<Placed>;
  recount: (kpmId: string, membershipId: string) => Promise<unknown>;
  daysAgo: (days: number) => Date;
}

export interface TemplateFixture {
  /** What migration `0023` did on this run: nothing on a re-run. */
  migration: NamedTemplatesResult;
  /** What migration `0037` did on this run: made the Template company after a `--reset`, nothing on a re-run. */
  library: TemplateCompanyResult;
  /** Each company's default template id. */
  defaults: Record<string, string>;
  /** The lines the printed guide carries for this fixture. */
  guide: string;
}

export async function seedTemplateFixture(deps: TemplateFixtureDeps): Promise<TemplateFixture> {
  const now = deps.clock.now();
  const Companies = mongoose.model(Company.name, CompanySchema, undefined, RECOMPILE);
  const Ladders = mongoose.model(CompanyOrgLevel.name, CompanyOrgLevelSchema, undefined, RECOMPILE);
  const Templates = mongoose.model(NamedTemplate.name, NamedTemplateSchema, undefined, RECOMPILE);
  const Categories = mongoose.model(ActivityCategory.name, ActivityCategorySchema, undefined, RECOMPILE);
  const Types = mongoose.model(ActivityType.name, ActivityTypeSchema, undefined, RECOMPILE);
  const Catalogs = mongoose.model(CapabilityCatalog.name, CapabilityCatalogSchema, undefined, RECOMPILE);

  if (deps.reset) {
    await Templates.deleteMany({}).exec();
    await mongoose.connection.collection('templates').dropIndexes().catch(() => undefined);
  }

  /*
   * ---- The Template company (P18.9-T3 AC-7, ADR-0164 §2), by the migration every deploy runs — here, after the
   * reset above has emptied `templates`, so a `--reset` (what staging's seed runs) never leaves an environment
   * without it. Before `0023`, which then finds its default template and gives it nothing.
   */
  const library = await templateCompany(mongoose.connection.db as mongoose.mongo.Db, now);

  // ---- The blank company: created without the defaults, so no products and no carrier rules, but a
  // ladder all the same (every company has one) and a default template that holds nothing.
  const blankId = BLANK_COMPANY._id;
  if (!(await Companies.exists({ _id: blankId }))) {
    await Companies.create({
      _id: blankId, name: BLANK_COMPANY.name, slug: BLANK_COMPANY.slug,
      defaultCurrency: 'IDR', defaultLocale: 'id-ID', defaultTimezone: ZONE,
      status: 'active', usesPlatformDefaults: false, deletedAt: null,
    });
  }
  for (const { code, label, displayOrder, leaderTier } of DEFAULT_ORG_LADDER) {
    if (!(await Ladders.exists({ companyId: blankId, code }))) {
      await Ladders.create({
        companyId: blankId, code, label, displayOrder, leaderTier, status: 'active', archivedAt: null, deletedAt: null,
      });
    }
  }

  /*
   * ---- Each company's default template, by derived id. Made here before the migration runs, so the
   * migration finds one and does the rest: gives the existing rows their template, and publishes each kind
   * a defaults company never published as version 1 of the AgencyBoost defaults. The blank company's is
   * made the way `createCompany` makes one for a company that declined them: empty.
   */
  const defaults: Record<string, string> = {};
  const ensureDefault = async (companyId: string, name: string, origin: 'migration' | 'empty') => {
    const _id = defaultTemplateIdOf(companyId);
    const existing = await Templates.findOne({ companyId, isDefault: true, deletedAt: null }).exec();
    if (existing) {
      defaults[companyId] = String(existing._id);
      return;
    }
    await Templates.create({
      _id, companyId, name: `${name} template`, isDefault: true, status: 'active', archivedAt: null,
      origin: { kind: origin }, deletedAt: null, createdBy: null, updatedBy: null,
    });
    defaults[companyId] = _id;
  };
  for (const company of deps.companies) await ensureDefault(company._id, company.name, 'migration');
  await ensureDefault(blankId, BLANK_COMPANY.name, 'empty');

  const migration = await namedTemplates(mongoose.connection.db as mongoose.mongo.Db, now);

  // ---- Office 0701, started Empty: what `createKpm` writes with `startFrom: { kind: 'empty' }`.
  const ownerUser = await person(deps, 'owner0701', blankId);
  const kpmId = EMPTY_OFFICE._id;
  const Kpms = deps.Kpms as unknown as mongoose.Model<Record<string, unknown>>;
  if (!(await Kpms.exists({ _id: kpmId }))) {
    const startedFrom: KpmStartedFrom = { source: 'empty', templateId: null, templateName: null };
    await Kpms.create({
      _id: kpmId, companyId: blankId, code: EMPTY_OFFICE.code, branchName: EMPTY_OFFICE.branchName,
      address: 'Jl. Cempaka Putih Raya, Jakarta Pusat', ownerUserId: String(ownerUser._id), timezone: ZONE,
      settings: { ...DEFAULT_KPM_SETTINGS }, counters: { nextMemberSeq: 1 }, status: 'active',
      startedFrom,
      deletedAt: null,
    });
  }

  // The three cascade types, in their platform sections, and nothing else (ADR-0115 §2).
  if (!(await Types.exists({ kpmId }))) {
    const { categories, types } = withCascadeTypes([], []);
    await Categories.insertMany(categories.map((c) => ({
      kpmId, code: c.code, label: c.label, displayOrder: c.displayOrder,
      summaryGroupCode: null, summaryGroupLabel: null,
      version: 1, status: 'active', archivedAt: null, deletedAt: null, createdBy: null, updatedBy: null,
    })));
    await Types.insertMany(types.map((t) => ({
      kpmId, code: t.code, categoryCode: t.categoryCode, label: t.label, description: t.description ?? null,
      displayOrder: t.displayOrder,
      version: 1, status: 'active', archivedAt: null, deletedAt: null, createdBy: null, updatedBy: null,
    })));
  }
  // The platform ladder, by provisioning's own rule: the source has none, so it is supplied (ADR-0116).
  const ladder = withPlatformLadder(null);
  if (!(await Catalogs.exists({ kpmId }))) {
    await Catalogs.create(capabilitySeedDocument(kpmId, ladder.payload as never));
  }
  // Published, as provisioning publishes a new office's first snapshot.
  await deps.publish(kpmId, deps.daysAgo(14));
  /*
   * The seed's `publish` records five kinds as the platform defaults, as provisioning did before 13.2;
   * this office's record is all seven, each empty, the ladder marked supplied — written once, after it.
   */
  await Kpms.updateOne(
    { _id: kpmId, 'seededFrom.event_types': { $exists: false } },
    {
      $set: {
        seededFrom: Object.fromEntries(OFFICE_TEMPLATE_KINDS.map((kind) => [kind, {
          templateId: null, version: null,
          ...(kind === 'capability_ladder' && ladder.supplied ? { platformSupplied: true } : {}),
        }])),
      },
    },
  ).exec();

  // The Owner at the root, and one Agent under them. The office has no checklist, so no activation.
  const office: OfficeRef = { _id: kpmId, code: EMPTY_OFFICE.code, companyId: blankId };
  const agentUser = await person(deps, 'agent0701', blankId);
  const root = await deps.place(office, String(ownerUser._id), 'ab', null, { joinedDaysAgo: 14 });
  const agent = await deps.place(office, String(agentUser._id), 'agent', root, { joinedDaysAgo: 7 });
  await deps.recount(kpmId, root.id);
  /*
   * Nadia joined with Hadi's leader code: her one `joined` edge is written by her. That is what tells a
   * placement from an import (`placedByALeader`), so once Hadi publishes the office's first checklist her
   * next read gives her an activation from her join date (ADR-0115 §8) — the walk's last step.
   */
  await mongoose.connection.collection('membershipHistory').updateOne(
    { kpmId, membershipId: agent.id, eventType: 'joined', actorUserId: { $in: [null, undefined] } },
    { $set: { actorUserId: String(agentUser._id) } },
  );
  /*
   * And a leader's code makes her a **new hire** (ADR-0169 §3: joined a week ago, within 90 days), which is what lets
   * that read give her one — an existing agent is never given an activation. The seed's one new hire with no
   * activation: migration 0040, which reads activations, could not tell her from an existing agent, and a fresh
   * seed writes what the redemption writes.
   */
  await mongoose.connection.collection('memberships').updateOne(
    { _id: new mongoose.Types.ObjectId(agent.id), kpmId },
    { $set: { joinedAs: 'new_hire' } },
  );

  const guide = `
  KPM TEMPLATES at /admin/companies → a company → Template KPM  (Super Admin; from src/seed/template-fixture.ts)
    Template bawaan AgencyBoost  the card above the companies (the Template library, ADR-0185): "Default
                                 template", every kind of the AgencyBoost defaults; a new company copies it,
                                 and Mulai dari offers it to a new office
    Prudential                   "Prudential template", its default — the migration's, holding every
                                 kind; Mulai dari at /admin/tenants/new offers it first
    Allianz Life                 "Allianz Life template", its default
    Sejahtera Baru Life          Started blank: "Sejahtera Baru Life template" holds nothing
    KPM 0701 · Cempaka Putih     Started Empty, Sejahtera Baru Life:
      owner@kpm0701.test         Hadi, the Owner — the three cascade activity types and the platform
                                 capability ladder, nothing else; each other settings screen authors its
                                 first row; archiving one of the three is refused
      agent@kpm0701.test         Nadia, an Agent — Log Activity with the three, empty states elsewhere,
                                 no activation and no New agent section
`;

  return { migration, library, defaults, guide };
}

/** One of the two, through the seed's own `user`, as the blank company's producer. */
function person(deps: TemplateFixtureDeps, key: keyof typeof TEMPLATE_FIXTURE_PEOPLE, companyId: string) {
  const { email, fullName, pronoun, agentCode } = TEMPLATE_FIXTURE_PEOPLE[key];
  return deps.user(email, fullName, { pronoun, agentCode, companyId });
}
