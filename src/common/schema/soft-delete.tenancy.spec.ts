import { Schema } from 'mongoose';
import { AuditLogSchema } from '@/modules/audit/audit-log.schema';
import { AssetSchema } from '@/modules/assets/asset.schema';
import {
  NotificationPreferencesSchema, NotificationSchema,
} from '@/modules/notifications/notification.schema';
import { UserSchema } from '@/modules/users/user.schema';
import { AuthTokenSchema } from '@/modules/auth/auth-token.schema';
import { CompanySchema } from '@/modules/tenants/company.schema';
import { CompanyOrgLevelSchema } from '@/modules/tenants/company-org-level.schema';
import { KpmSchema } from '@/modules/tenants/kpm.schema';
import { KpmRequestSchema } from '@/modules/tenants/kpm-request.schema';
import { GroupSchema } from '@/modules/org/group.schema';
import { JoinRequestSchema } from '@/modules/org/join-request.schema';
import { MembershipHistorySchema } from '@/modules/org/membership-history.schema';
import { MembershipSchema } from '@/modules/org/membership.schema';
import { unclassified } from './registered-schemas';
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
  ActivityLogCorrectionSchema, ActivityLogEntrySchema, ActivityLogSchema,
} from '@/modules/activity/activity-log.schema';
import {
  LeadCommitmentSchema, LeadContactSchema, LeadSchema, LeadTransitionSchema,
} from '@/modules/leads/lead.schema';
import {
  GoalCascadeMappingSchema, GoalSchema, GoalSnapshotSchema,
} from '@/modules/goals/goal.schema';
import {
  CampaignSchema, CriteriaGroupSchema, QualificationRuleSchema, RequirementSchema,
} from '@/modules/campaigns/campaign.schema';
import {
  CapabilityCatalogSchema, CapabilityEntrySchema, CapabilityGridRowSchema,
  CapabilityStageRowSchema,
} from '@/modules/capability/capability.schema';

/**
 * P2-T8: soft delete everywhere.
 *
 * Erasure under UU 27/2022 is a deliberate, audited, cascading operation — not a
 * `deleteOne()`. That shape has to be right from the first collection, because
 * retrofitting cascade semantics across forty collections is a rewrite (ADR-0007).
 */

const SOFT_DELETABLE: ReadonlyArray<[string, Schema]> = [
  ['users', UserSchema],
  ['companies', CompanySchema],
  ['companyOrgLevels', CompanyOrgLevelSchema],
  ['kpms', KpmSchema],
  ['kpmRequests', KpmRequestSchema],
  ['assets', AssetSchema],
  ['notifications', NotificationSchema],
  ['notificationPreferences', NotificationPreferencesSchema],
  ['memberships', MembershipSchema],
  ['membershipHistory', MembershipHistorySchema],
  ['joinRequests', JoinRequestSchema],
  ['groups', GroupSchema],
  ['activityCategories', ActivityCategorySchema],
  ['activityTypes', ActivityTypeSchema],
  ['leadStatuses', LeadStatusSchema],
  ['ratioDefinitions', RatioDefinitionSchema],
  ['configSnapshots', ConfigSnapshotSchema],
  ['impersonationSessions', ImpersonationSessionSchema],
  ['companyTemplates', CompanyTemplateSchema],
  ['trainingCategories', TrainingCategorySchema],
  ['trainingSkills', TrainingSkillSchema],
  ['trainingModules', TrainingModuleSchema],
  ['activationTemplates', ActivationTemplateSchema],
  ['products', ProductSchema],
  ['kpmProductConfigs', KpmProductConfigSchema],
  ['eventTypes', EventTypeSchema],
  ['events', EventSchema],
  ['activityLogs', ActivityLogSchema],
  ['leads', LeadSchema],
  ['goals', GoalSchema],
  ['campaigns', CampaignSchema],
  ['capabilityCatalogs', CapabilityCatalogSchema],
  // Company-partitioned carrier rules (ADR-0035), soft-deleted like every other row.
  ['qualificationRules', QualificationRuleSchema],
];

/**
 * Collections that are append-only or self-expiring instead, each with the reason.
 * Soft delete would be meaningless on a record nobody may amend.
 */
const NOT_SOFT_DELETABLE: ReadonlyArray<[string, Schema, string]> = [
  ['auditLog', AuditLogSchema, 'append-only: an audit row that can be hidden is not evidence'],
  [
    'activationAspect (subdocument)',
    ActivationAspectSchema,
    'a subdocument of activationTemplates: it is deleted with the document that holds it',
  ],
  [
    'activationItem (subdocument)',
    ActivationItemSchema,
    'a subdocument of an activation aspect, for the same reason',
  ],
  [
    'trainingContent (subdocument)',
    TrainingContentSchema,
    'a subdocument of trainingModules: it is deleted with the module that holds it',
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
    'capabilityEntry (subdocument)',
    CapabilityEntrySchema,
    'a subdocument of capabilityCatalogs: it is deleted with the catalog that holds it',
  ],
  [
    'capabilityStageRow (subdocument)',
    CapabilityStageRowSchema,
    'a subdocument of capabilityCatalogs, for the same reason',
  ],
  [
    'capabilityGridRow (subdocument)',
    CapabilityGridRowSchema,
    'a subdocument of capabilityCatalogs, for the same reason',
  ],
  [
    'requirement (subdocument)',
    RequirementSchema,
    'a subdocument of campaigns and qualificationRules: it is deleted with the row that holds it',
  ],
  [
    'criteriaGroup (subdocument)',
    CriteriaGroupSchema,
    'a subdocument of qualificationRules, for the same reason',
  ],
  [
    'eventAudience (subdocument)',
    EventAudienceSchema,
    'a subdocument of events: it is deleted with the event that holds it',
  ],
  [
    'activityLogEntry (subdocument)',
    ActivityLogEntrySchema,
    'one code\'s count inside an activity log: it goes with the day that holds it',
  ],
  [
    'leadContact (subdocument)',
    LeadContactSchema,
    'a phone and an email inside a lead: they go with the lead that holds them, and clearing '
      + 'them is a write rather than a delete',
  ],
  [
    'leadTransition (subdocument)',
    LeadTransitionSchema,
    'one move along a ladder. **Append-only and never removed** — it is what makes a jump '
      + 'legible and a leader\'s edit attributable (ADR-0044, ADR-0045)',
  ],
  [
    'goalSnapshot (subdocument)',
    GoalSnapshotSchema,
    'the figures a goal was agreed on. **Replaced whole on every save, never removed** — a goal '
      + 'that has been re-planned keeps the version that held the old ones (ADR-0042)',
  ],
  [
    'goalCascadeMapping (subdocument)',
    GoalCascadeMappingSchema,
    'the three activity codes a goal is measured against. Set once and rewritten only if the '
      + 'product changes which activities the cascade counts — deleting one would leave a column '
      + 'measuring nothing',
  ],
  [
    'leadCommitment (subdocument)',
    LeadCommitmentSchema,
    'one month an agent promised a lead for (P7-T5). A past month is unreachable by '
      + 'construction — only the current month\'s entry can be written — and un-ticking the box '
      + 'inside the month removes that entry, which is correcting today\'s promise rather than '
      + 'deleting a record of one',
  ],
  [
    'activityLogCorrection (subdocument)',
    ActivityLogCorrectionSchema,
    'a prior state of an activity log. **Append-only and never removed** — the whole point is '
      + 'that a leader who coached against the old numbers can still read them (ADR-0042)',
  ],
  [
    'productDocumentRef (subdocument)',
    ProductDocumentRefSchema,
    'a subdocument of products and kpmProductConfigs: it is deleted with the row that holds it',
  ],
  [
    'attackPlan (subdocument)',
    AttackPlanSchema,
    'a subdocument of products: it is deleted with the product that holds it',
  ],
  [
    'commissionYear (subdocument)',
    CommissionYearSchema,
    'a subdocument of products, for the same reason',
  ],
  ['authTokens', AuthTokenSchema, 'self-expiring: revokedAt and expiresAt already model the lifecycle'],
];

const EXPORT_NAMES = new Map<Schema, string>([
  [UserSchema, 'UserSchema'],
  [CompanySchema, 'CompanySchema'],
  [CompanyOrgLevelSchema, 'CompanyOrgLevelSchema'],
  [KpmSchema, 'KpmSchema'],
  [KpmRequestSchema, 'KpmRequestSchema'],
  [AssetSchema, 'AssetSchema'],
  [NotificationSchema, 'NotificationSchema'],
  [NotificationPreferencesSchema, 'NotificationPreferencesSchema'],
  [ActivityCategorySchema, 'ActivityCategorySchema'],
  [ActivityTypeSchema, 'ActivityTypeSchema'],
  [LeadStatusSchema, 'LeadStatusSchema'],
  [RatioDefinitionSchema, 'RatioDefinitionSchema'],
  [ConfigSnapshotSchema, 'ConfigSnapshotSchema'],
  [ImpersonationSessionSchema, 'ImpersonationSessionSchema'],
  [CompanyTemplateSchema, 'CompanyTemplateSchema'],
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
  [ActivityLogSchema, 'ActivityLogSchema'],
  [LeadSchema, 'LeadSchema'],
  [LeadContactSchema, 'LeadContactSchema'],
  [LeadTransitionSchema, 'LeadTransitionSchema'],
  [LeadCommitmentSchema, 'LeadCommitmentSchema'],
  [GoalSchema, 'GoalSchema'],
  [GoalSnapshotSchema, 'GoalSnapshotSchema'],
  [GoalCascadeMappingSchema, 'GoalCascadeMappingSchema'],
  [ActivityLogEntrySchema, 'ActivityLogEntrySchema'],
  [ActivityLogCorrectionSchema, 'ActivityLogCorrectionSchema'],
  [CampaignSchema, 'CampaignSchema'],
  [QualificationRuleSchema, 'QualificationRuleSchema'],
  [RequirementSchema, 'RequirementSchema'],
  [CriteriaGroupSchema, 'CriteriaGroupSchema'],
  [CapabilityCatalogSchema, 'CapabilityCatalogSchema'],
  [CapabilityEntrySchema, 'CapabilityEntrySchema'],
  [CapabilityStageRowSchema, 'CapabilityStageRowSchema'],
  [CapabilityGridRowSchema, 'CapabilityGridRowSchema'],
  [ProductDocumentRefSchema, 'ProductDocumentRefSchema'],
  [AttackPlanSchema, 'AttackPlanSchema'],
  [CommissionYearSchema, 'CommissionYearSchema'],
  [MembershipSchema, 'MembershipSchema'],
  [MembershipHistorySchema, 'MembershipHistorySchema'],
  [JoinRequestSchema, 'JoinRequestSchema'],
  [GroupSchema, 'GroupSchema'],
  [AuditLogSchema, 'AuditLogSchema'],
  [AuthTokenSchema, 'AuthTokenSchema'],
]);

describe('soft delete', () => {
  it.each(SOFT_DELETABLE)('%s declares deletedAt', (_name, schema) => {
    expect(schema.path('deletedAt')).toBeDefined();
  });

  it.each(SOFT_DELETABLE)('%s defaults deletedAt to null, not undefined', (_name, schema) => {
    // A missing field and an explicit null query differently; the repository filters on
    // `deletedAt: null`, so the default has to be null.
    const path = schema.path('deletedAt') as unknown as { defaultValue: unknown };
    expect(path.defaultValue).toBeNull();
  });

  it.each(NOT_SOFT_DELETABLE)('%s is exempt: %s', (_name, schema, reason) => {
    expect(schema).toBeDefined();
    expect(reason.length).toBeGreaterThan(20);
  });

  it('classifies every schema, so a new collection cannot quietly opt out', () => {
    // Was `SOFT_DELETABLE.length + NOT_SOFT_DELETABLE.length === 8` — a tautology that
    // survived all five Phase 3 collections. The names now come from the source tree.
    const missing = unclassified([
      ...SOFT_DELETABLE.map(([, schema]) => EXPORT_NAMES.get(schema)!),
      ...NOT_SOFT_DELETABLE.map(([, schema]) => EXPORT_NAMES.get(schema)!),
    ]);
    expect(missing).toEqual([]);
  });

  it('exempts nothing that also declares deletedAt — that would be a contradiction', () => {
    for (const [name, schema] of NOT_SOFT_DELETABLE) {
      expect([name, schema.path('deletedAt')]).toEqual([name, undefined]);
    }
  });
});
