import { Schema } from 'mongoose';
import { AuditLogSchema } from '@/modules/audit/audit-log.schema';
import { AssetSchema } from '@/modules/assets/asset.schema';
import {
  NotificationSchema,
  NotificationPreferencesSchema,
} from '@/modules/notifications/notification.schema';
import { AuthTokenSchema } from '@/modules/auth/auth-token.schema';
import { CompanySchema } from '@/modules/tenants/company.schema';
import { CompanyOrgLevelSchema } from '@/modules/tenants/company-org-level.schema';
import { KpmSchema } from '@/modules/tenants/kpm.schema';
import { KpmRequestSchema } from '@/modules/tenants/kpm-request.schema';
import { UserSchema } from '@/modules/users/user.schema';
import { GroupSchema } from '@/modules/org/group.schema';
import { JoinRequestSchema } from '@/modules/org/join-request.schema';
import { MembershipHistorySchema } from '@/modules/org/membership-history.schema';
import { MembershipSchema } from '@/modules/org/membership.schema';
import { unclassified } from '@/common/schema/registered-schemas';
import {
  ActivityCategorySchema,
} from '@/modules/config/activity-category.schema';
import { ActivityTypeSchema } from '@/modules/config/activity-type.schema';
import { LeadStatusSchema } from '@/modules/config/lead-status.schema';
import { RatioDefinitionSchema } from '@/modules/config/ratio-definition.schema';
import { ConfigSnapshotSchema } from '@/modules/config/config-snapshot.schema';
import {
  ImpersonationSessionSchema,
} from '@/modules/auth/impersonation-session.schema';
import { CompanyTemplateSchema } from '@/modules/config/company-template.schema';
import {
  TrainingCategorySchema,
} from '@/modules/training/training-category.schema';
import { TrainingSkillSchema } from '@/modules/training/training-skill.schema';
import {
  TrainingContentFileSchema, TrainingContentLinkSchema, TrainingContentSchema,
  TrainingModuleSchema,
} from '@/modules/training/training-module.schema';
import {
  ActivationAspectSchema, ActivationItemSchema, ActivationTemplateSchema,
} from '@/modules/activation/activation-template.schema';
import {
  AttackPlanSchema, CommissionYearSchema, ProductSchema,
} from '@/modules/products/product.schema';
import {
  KpmProductConfigSchema, ProductDocumentRefSchema,
} from '@/modules/products/kpm-product-config.schema';
import {
  EventAudienceSchema, EventSchema, EventTypeSchema,
} from '@/modules/events/event.schema';
import {
  CampaignSchema, CriteriaGroupSchema, QualificationRuleSchema, RequirementSchema,
} from '@/modules/campaigns/campaign.schema';

/**
 * An index on a tenant-scoped collection that does not lead with `kpmId` invites a
 * query plan that scans across tenants. MongoDB has no row-level-security backstop
 * (ADR-0002), so index shape is part of the isolation guarantee, not just performance.
 *
 * This asserts the convention over every registered schema, so a new collection cannot
 * quietly opt out.
 */

/** Schemas whose documents belong to exactly one tenant. */
const TENANT_SCOPED: ReadonlyArray<[string, Schema]> = [
  ['assets', AssetSchema],
  ['notifications', NotificationSchema],
  ['memberships', MembershipSchema],
  ['membershipHistory', MembershipHistorySchema],
  ['joinRequests', JoinRequestSchema],
  ['groups', GroupSchema],
  ['activityCategories', ActivityCategorySchema],
  ['activityTypes', ActivityTypeSchema],
  ['leadStatuses', LeadStatusSchema],
  ['ratioDefinitions', RatioDefinitionSchema],
  ['configSnapshots', ConfigSnapshotSchema],
  ['trainingCategories', TrainingCategorySchema],
  ['trainingSkills', TrainingSkillSchema],
  ['trainingModules', TrainingModuleSchema],
  ['activationTemplates', ActivationTemplateSchema],
  ['kpmProductConfigs', KpmProductConfigSchema],
  ['eventTypes', EventTypeSchema],
  ['events', EventSchema],
  ['campaigns', CampaignSchema],
];

/**
 * Schemas that are deliberately not tenant-scoped, each with the reason. Anything not
 * listed here and not above is a schema nobody classified — which is itself a finding.
 */
const EXEMPT: ReadonlyArray<[string, Schema, string]> = [
  [
    'activationAspect (subdocument)',
    ActivationAspectSchema,
    'a subdocument of activationTemplates: no collection, no _id of its own, and its kpmId is the document it sits in',
  ],
  [
    'activationItem (subdocument)',
    ActivationItemSchema,
    'a subdocument of an activation aspect, for the same reason',
  ],
  ['auditLog', AuditLogSchema, 'kpmId is nullable: platform actions belong to no tenant'],
  [
    'notificationPreferences',
    NotificationPreferencesSchema,
    'keyed by global userId: a person carries preferences across offices',
  ],
  [
    'users',
    UserSchema,
    'identity is global: one person, one account, one login across every office they join',
  ],
  ['companies', CompanySchema, 'a company owns KPMs; it sits above the tenant, not inside one'],
  [
    'impersonationSessions',
    ImpersonationSessionSchema,
    'a platform record of a platform action: `kpmId` is nullable because a target may be '
      + 'in no office, and Super Admin reads across every tenant. An Owner\'s read is '
      + 'narrowed in the service, which refuses another office as a 404',
  ],
  [
    'companyTemplates',
    CompanyTemplateSchema,
    'company-partitioned, not tenant-scoped (ADR-0018): the preset every office of one company '
      + 'is seeded from, written only by Super Admin and read before the office exists',
  ],
  ['kpms', KpmSchema, 'the tenant record itself — it cannot be scoped to itself'],
  [
    'kpmRequests',
    KpmRequestSchema,
    'a request for a tenant that does not exist: there is nothing to scope it to until it ' +
      'is approved, and then `createdKpmId` names what it became',
  ],
  [
    'companyOrgLevels',
    CompanyOrgLevelSchema,
    'a company owns its role ladder, not any office (ADR-0012): an office cannot invent ' +
      'a rung, so scoping the ladder to one would say the opposite of what it is',
  ],
  [
    'products',
    ProductSchema,
    'company-partitioned, not tenant-scoped (ADR-0033): a product belongs to the insurer, is '
      + 'written only by Super Admin, and is read **live** by every office of that company — which '
      + 'is what makes a withdrawal reach all of them at once. Scoping it to one office would be '
      + 'the opposite of what it is',
  ],
  [
    'trainingContent (subdocument)',
    TrainingContentSchema,
    'a subdocument of trainingModules: no collection and no _id of its own',
  ],
  [
    'trainingContentFile (subdocument)',
    TrainingContentFileSchema,
    'a subdocument of a module\'s content, for the same reason',
  ],
  [
    'trainingContentLink (subdocument)',
    TrainingContentLinkSchema,
    'a subdocument of a module\'s content, for the same reason',
  ],
  [
    'requirement (subdocument)',
    RequirementSchema,
    'a subdocument of campaigns and qualificationRules: no collection and no _id of its own',
  ],
  [
    'criteriaGroup (subdocument)',
    CriteriaGroupSchema,
    'a subdocument of qualificationRules, for the same reason',
  ],
  [
    'qualificationRules',
    QualificationRuleSchema,
    'company-partitioned, not tenant-scoped (ADR-0035): MOC and the production club tiers are the '
      + 'insurer\'s carrier rules, seeded per company and editable by no office role at all — '
      + 'scoping them to one office would say the opposite of what they are',
  ],
  [
    'eventAudience (subdocument)',
    EventAudienceSchema,
    'a subdocument of events: no collection and no _id of its own',
  ],
  [
    'productDocumentRef (subdocument)',
    ProductDocumentRefSchema,
    'a subdocument of products and kpmProductConfigs: no collection and no _id of its own',
  ],
  [
    'attackPlan (subdocument)',
    AttackPlanSchema,
    'a subdocument of products: no collection and no _id of its own',
  ],
  [
    'commissionYear (subdocument)',
    CommissionYearSchema,
    'a subdocument of products, for the same reason',
  ],
  [
    'authTokens',
    AuthTokenSchema,
    'issued against a global identity before any office is chosen: refresh, email ' +
      'verification and password reset all predate membership',
  ],
];

/**
 * Indexes that deliberately do not lead with `kpmId`, each with its justification.
 *
 * The rule is not "every index leads with kpmId" — some queries are legitimately
 * per-user across tenants. The rule is that such an index is *declared* here, so it is
 * a decision somebody made rather than an oversight.
 */
const CROSS_TENANT_INDEXES: Record<string, string> = {
  'assets:companyId,createdAt':
    "the company's shared training material (ADR-0032). A company asset carries no `kpmId` at " +
    'all — it belongs to the insurer and every office of that company reads the same row by ' +
    'reference — so an index leading with one would never match it. The read is the named ' +
    'unscoped `findCompanyAsset`, filtered by company, never the scoped repository.',
  'memberships:leaderCode':
    'the leader code a joiner types before they belong anywhere. There is no tenant to ' +
    'scope the lookup to — it is the code that names the office — so it is unique ' +
    'globally and indexed that way. `inviteCodes` carried the same index for the same ' +
    'reason until P3.6-T1 retired it.',
  'notifications:userId,readAt,createdAt':
    "the recipient's own inbox. kpmId is nullable here because email verification and " +
    'password reset are sent before a user has joined any KPM, so the inbox query is ' +
    'per-user by design and reads only that user’s own rows.',
};

/**
 * The exported const name for a schema instance, so the classification lists can be
 * compared against what the source tree exports without repeating the names by hand.
 */
const SCHEMA_EXPORT_NAMES = new Map<Schema, string>([
  [ActivityCategorySchema, 'ActivityCategorySchema'],
  [ActivityTypeSchema, 'ActivityTypeSchema'],
  [LeadStatusSchema, 'LeadStatusSchema'],
  [RatioDefinitionSchema, 'RatioDefinitionSchema'],
  [ConfigSnapshotSchema, 'ConfigSnapshotSchema'],
  [TrainingCategorySchema, 'TrainingCategorySchema'],
  [TrainingSkillSchema, 'TrainingSkillSchema'],
  [TrainingModuleSchema, 'TrainingModuleSchema'],
  [TrainingContentSchema, 'TrainingContentSchema'],
  [TrainingContentFileSchema, 'TrainingContentFileSchema'],
  [TrainingContentLinkSchema, 'TrainingContentLinkSchema'],
  [ActivationTemplateSchema, 'ActivationTemplateSchema'],
  [ActivationAspectSchema, 'ActivationAspectSchema'],
  [ActivationItemSchema, 'ActivationItemSchema'],
  [ProductSchema, 'ProductSchema'],
  [KpmProductConfigSchema, 'KpmProductConfigSchema'],
  [EventTypeSchema, 'EventTypeSchema'],
  [EventSchema, 'EventSchema'],
  [EventAudienceSchema, 'EventAudienceSchema'],
  [CampaignSchema, 'CampaignSchema'],
  [QualificationRuleSchema, 'QualificationRuleSchema'],
  [RequirementSchema, 'RequirementSchema'],
  [CriteriaGroupSchema, 'CriteriaGroupSchema'],
  [ProductDocumentRefSchema, 'ProductDocumentRefSchema'],
  [AttackPlanSchema, 'AttackPlanSchema'],
  [CommissionYearSchema, 'CommissionYearSchema'],
  [ImpersonationSessionSchema, 'ImpersonationSessionSchema'],
  [CompanyTemplateSchema, 'CompanyTemplateSchema'],
  [AssetSchema, 'AssetSchema'],
  [NotificationSchema, 'NotificationSchema'],
  [NotificationPreferencesSchema, 'NotificationPreferencesSchema'],
  [AuditLogSchema, 'AuditLogSchema'],
  [AuthTokenSchema, 'AuthTokenSchema'],
  [CompanySchema, 'CompanySchema'],
  [CompanyOrgLevelSchema, 'CompanyOrgLevelSchema'],
  [KpmSchema, 'KpmSchema'],
  [UserSchema, 'UserSchema'],
  [GroupSchema, 'GroupSchema'],
  [JoinRequestSchema, 'JoinRequestSchema'],
  [MembershipHistorySchema, 'MembershipHistorySchema'],
  [MembershipSchema, 'MembershipSchema'],
  [KpmRequestSchema, 'KpmRequestSchema'],
]);

function schemaExportName(schema: Schema): string {
  const name = SCHEMA_EXPORT_NAMES.get(schema);
  if (!name) throw new Error('Schema missing from SCHEMA_EXPORT_NAMES — add it.');
  return name;
}

function compoundIndexes(schema: Schema): Record<string, number | string>[] {
  return schema
    .indexes()
    .map(([fields]) => fields as Record<string, number | string>)
    .filter((fields) => Object.keys(fields).length > 1);
}

describe('index conventions', () => {
  describe.each(TENANT_SCOPED)('%s', (_name: string, schema: Schema) => {
    it('declares kpmId on the schema', () => {
      expect(schema.path('kpmId')).toBeDefined();
    });

    it('serves the tenant filter with at least one kpmId-leading compound index', () => {
      const tenantLed = compoundIndexes(schema).filter(
        (fields) => Object.keys(fields)[0] === 'kpmId',
      );
      expect(tenantLed.length).toBeGreaterThan(0);
    });

    it('declares any index that does not lead with kpmId, with a reason', () => {
      const undeclared = compoundIndexes(schema)
        .filter((fields) => Object.keys(fields)[0] !== 'kpmId')
        .map((fields) => `${_name}:${Object.keys(fields).join(',')}`)
        .filter((key) => !CROSS_TENANT_INDEXES[key]);

      // A new index that scans across tenants must be justified in CROSS_TENANT_INDEXES,
      // not silently added.
      expect(undeclared).toEqual([]);
    });
  });

  describe.each(EXEMPT)('%s (exempt)', (_name, schema, reason) => {
    it(`is exempt for a stated reason: ${reason}`, () => {
      expect(reason.length).toBeGreaterThan(10);
      expect(schema).toBeDefined();
    });
  });

  it('classifies every schema as scoped or exempt, so none is overlooked', () => {
    // This compared `TENANT_SCOPED.length + EXEMPT.length` to a literal until 2026-09-06,
    // which is a tautology: both sides came from the lists, so it could only fail if
    // somebody edited a list and forgot the number. Phase 3 added five collections and it
    // stayed green through all of them. The names now come from the source tree, so a new
    // `*.schema.ts` fails here until it is classified.
    const missing = unclassified([
      ...TENANT_SCOPED.map(([, schema]) => schemaExportName(schema)),
      ...EXEMPT.map(([, schema]) => schemaExportName(schema)),
    ]);
    expect(missing).toEqual([]);
  });
});
