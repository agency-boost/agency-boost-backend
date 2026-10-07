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
import { NamedTemplateSchema } from '@/modules/config/named-template.schema';
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
  GoalCascadeMappingSchema, GoalRevisionSchema, GoalSchema, GoalSnapshotSchema,
} from '@/modules/goals/goal.schema';
import { PolicySchema } from '@/modules/production/policy.schema';
import { ProductionMonthSchema } from '@/modules/production/production-month.schema';
import { DataUploadBatchSchema } from '@/modules/production/data-upload-batch.schema';
import { DataUploadRowSchema } from '@/modules/production/data-upload-row.schema';
import {
  MetricValueSchema, MonthlyAgentDataSchema,
} from '@/modules/production/monthly-agent-data.schema';
import {
  CampaignSchema, CriteriaGroupSchema, QualificationRuleSchema, RequirementSchema,
} from '@/modules/campaigns/campaign.schema';
import {
  CapabilityCatalogSchema, CapabilityEntrySchema, CapabilityGridRowSchema,
  CapabilityStageRowSchema,
} from '@/modules/capability/capability.schema';
import {
  CoachingActionItemSchema, CoachingLastWeekItemSchema, CoachingLastWeekSchema, CoachingLeadActionSchema,
  CoachingSessionCorrectionSchema, CoachingSessionSchema, CoachingSnapshotSchema, CoachingTipSchema,
} from '@/modules/coaching/coaching-session.schema';
import { CoachingProfileRevisionSchema, CoachingProfileSchema } from '@/modules/coaching/coaching-profile.schema';
import { LeaderNoteRevisionSchema, LeaderNoteSchema } from '@/modules/coaching/leader-note.schema';
import { CalendarAttendeeSchema, CalendarEventSchema } from '@/modules/calendar/calendar-event.schema';
import {
  ActivationItemStateSchema, ActivationNoteSchema, ActivationProgressSchema,
} from '@/modules/activation/activation-progress.schema';

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
  ['activityLogs', ActivityLogSchema],
  ['leads', LeadSchema],
  ['goals', GoalSchema],
  ['policies', PolicySchema],
  ['monthlyAgentData', MonthlyAgentDataSchema],
  ['productionMonths', ProductionMonthSchema],
  ['dataUploadBatches', DataUploadBatchSchema],
  ['dataUploadRows', DataUploadRowSchema],
  ['campaigns', CampaignSchema],
  ['capabilityCatalogs', CapabilityCatalogSchema],
  ['coachingSessions', CoachingSessionSchema],
  ['coachingProfiles', CoachingProfileSchema],
  ['leaderNotes', LeaderNoteSchema],
  // P12-T2: one per entry; the organiser's range and an attendee's, both `kpmId`-led.
  ['calendarEvents', CalendarEventSchema],
  // P13-T1 AC-8: one per hire; the open one unique per membership, and the reads, both `kpmId`-led.
  ['activationProgress', ActivationProgressSchema],
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
  [
    'templates',
    NamedTemplateSchema,
    'company-partitioned, not tenant-scoped (ADR-0115 §3): a company\'s named templates, each a '
      + 'name over the seven kinds in companyTemplates, written only by Super Admin and read before '
      + 'the office made from one exists',
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
    'capabilityEntry (subdocument)',
    CapabilityEntrySchema,
    'a subdocument of capabilityCatalogs: no collection and no _id of its own',
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
    'activityLogEntry (subdocument)',
    ActivityLogEntrySchema,
    'one code\'s count inside an activity log: no collection and no _id of its own',
  ],
  [
    'leadContact (subdocument)',
    LeadContactSchema,
    'a phone and an email inside a lead: no collection and no _id of its own',
  ],
  [
    'leadTransition (subdocument)',
    LeadTransitionSchema,
    'one move along a ladder inside a lead: no collection and no _id of its own',
  ],
  [
    'leadCommitment (subdocument)',
    LeadCommitmentSchema,
    'one month a lead was promised for, inside the lead: no collection and no _id of its own',
  ],
  [
    'goalSnapshot (subdocument)',
    GoalSnapshotSchema,
    'what a goal\'s inputs produced when they were agreed, inside the goal: no collection and no '
      + '_id of its own',
  ],
  [
    'goalCascadeMapping (subdocument)',
    GoalCascadeMappingSchema,
    'the three activity codes a goal is measured against, inside the goal: no collection and no '
      + '_id of its own',
  ],
  [
    'metricValue (subdocument)',
    MetricValueSchema,
    'one figure and its provenance, inside a month row: twelve of them per row, no collection and '
      + 'no _id of their own',
  ],
  [
    'goalRevision (subdocument)',
    GoalRevisionSchema,
    'a plan the goal replaced, inside the goal: no collection and no _id of its own',
  ],
  [
    'activityLogCorrection (subdocument)',
    ActivityLogCorrectionSchema,
    'a prior state of an activity log, held inside the day it belongs to',
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
  // P11-T5: the parts of a coaching session. Each lives inside the session it belongs to.
  [
    'coachingLastWeek (subdocument)',
    CoachingLastWeekSchema,
    'which finalized session a draft carried last week from, inside the session: no collection and no _id of its own',
  ],
  [
    'coachingLastWeekItem (subdocument)',
    CoachingLastWeekItemSchema,
    'a copy of one of last week\'s items, ticked inside the session reviewing it: no collection and no _id of its own',
  ],
  [
    'coachingActionItem (subdocument)',
    CoachingActionItemSchema,
    'one of the session\'s other action items, inside the session: no collection and no _id of its own',
  ],
  [
    'coachingTip (subdocument)',
    CoachingTipSchema,
    'one coaching tip, inside the session: no collection and no _id of its own',
  ],
  [
    'coachingLeadAction (subdocument)',
    CoachingLeadActionSchema,
    'one lead-derived action taken at finalize, inside the session: no collection and no _id of its own',
  ],
  [
    'coachingSessionCorrection (subdocument)',
    CoachingSessionCorrectionSchema,
    'a finalized state a reopen replaced, held whole inside the session it belongs to',
  ],
  [
    'coachingSnapshot (subdocument)',
    CoachingSnapshotSchema,
    'what the 1:1 was held over, frozen inside the session at its first finalize',
  ],
  // P11-T9: what a save replaced, inside the profile or the note it belongs to.
  [
    'coachingProfileRevision (subdocument)',
    CoachingProfileRevisionSchema,
    'a tick set a profile save replaced, held inside the profile: no collection and no _id of its own',
  ],
  [
    'leaderNoteRevision (subdocument)',
    LeaderNoteRevisionSchema,
    'a text a note save replaced, held inside the note: no collection and no _id of its own',
  ],
  [
    'calendarAttendee (subdocument)',
    CalendarAttendeeSchema,
    'one member on a calendar entry, inside the entry: no collection and no _id of its own',
  ],
  [
    'activationItemState (subdocument)',
    ActivationItemStateSchema,
    'one item of a hire\'s activation, keyed by its code inside the activation: no collection and no _id of its own',
  ],
  [
    'activationNote (subdocument)',
    ActivationNoteSchema,
    'the leader\'s coaching note inside a hire\'s activation: no collection and no _id of its own',
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
  'notifications:userId,deletedAt,createdAt,_id':
    "one page of the recipient's own inbox (P12.1-T4), newest first with the id breaking a tie, and " +
    'its total. Per-user and cross-office for the reason the index above gives: the inbox is read by ' +
    'the reader’s own userId, and kpmId is nullable on the notices a newcomer needs first.',
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
  [ActivityLogSchema, 'ActivityLogSchema'],
  [LeadSchema, 'LeadSchema'],
  [LeadContactSchema, 'LeadContactSchema'],
  [LeadTransitionSchema, 'LeadTransitionSchema'],
  [LeadCommitmentSchema, 'LeadCommitmentSchema'],
  [GoalSchema, 'GoalSchema'],
  [GoalSnapshotSchema, 'GoalSnapshotSchema'],
  [GoalCascadeMappingSchema, 'GoalCascadeMappingSchema'],
  [PolicySchema, 'PolicySchema'],
  [MonthlyAgentDataSchema, 'MonthlyAgentDataSchema'],
  [ProductionMonthSchema, 'ProductionMonthSchema'],
  [DataUploadBatchSchema, 'DataUploadBatchSchema'],
  [DataUploadRowSchema, 'DataUploadRowSchema'],
  [MetricValueSchema, 'MetricValueSchema'],
  [GoalRevisionSchema, 'GoalRevisionSchema'],
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
  [ImpersonationSessionSchema, 'ImpersonationSessionSchema'],
  [CompanyTemplateSchema, 'CompanyTemplateSchema'],
  [NamedTemplateSchema, 'NamedTemplateSchema'],
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
  [CoachingSessionSchema, 'CoachingSessionSchema'],
  [CoachingLastWeekSchema, 'CoachingLastWeekSchema'],
  [CoachingLastWeekItemSchema, 'CoachingLastWeekItemSchema'],
  [CoachingActionItemSchema, 'CoachingActionItemSchema'],
  [CoachingTipSchema, 'CoachingTipSchema'],
  [CoachingLeadActionSchema, 'CoachingLeadActionSchema'],
  [CoachingSessionCorrectionSchema, 'CoachingSessionCorrectionSchema'],
  [CoachingSnapshotSchema, 'CoachingSnapshotSchema'],
  [CoachingProfileSchema, 'CoachingProfileSchema'],
  [CoachingProfileRevisionSchema, 'CoachingProfileRevisionSchema'],
  [LeaderNoteSchema, 'LeaderNoteSchema'],
  [LeaderNoteRevisionSchema, 'LeaderNoteRevisionSchema'],
  [CalendarEventSchema, 'CalendarEventSchema'],
  [CalendarAttendeeSchema, 'CalendarAttendeeSchema'],
  [ActivationProgressSchema, 'ActivationProgressSchema'],
  [ActivationItemStateSchema, 'ActivationItemStateSchema'],
  [ActivationNoteSchema, 'ActivationNoteSchema'],
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
