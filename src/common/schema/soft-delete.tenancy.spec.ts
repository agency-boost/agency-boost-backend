import { Schema } from 'mongoose';
import { AuditLogSchema } from '@/modules/audit/audit-log.schema';
import { AssetSchema } from '@/modules/assets/asset.schema';
import {
  NotificationPreferencesSchema, NotificationSchema,
} from '@/modules/notifications/notification.schema';
import { UserSchema } from '@/modules/users/user.schema';
import { AuthTokenSchema } from '@/modules/auth/auth-token.schema';
import { AccountLinkSchema } from '@/modules/auth/account-link.schema';
import { CompanySchema } from '@/modules/tenants/company.schema';
import { CompanyOrgLevelSchema } from '@/modules/tenants/company-org-level.schema';
import { KpmSchema } from '@/modules/tenants/kpm.schema';
import { KpmRequestSchema } from '@/modules/tenants/kpm-request.schema';
import { GroupSchema } from '@/modules/org/group.schema';
import { JoinRequestSchema } from '@/modules/org/join-request.schema';
import { LeaderLimitRequestSchema } from '@/modules/org/leader-limit-request.schema';
import { MemberInviteSchema } from '@/modules/org/member-invite.schema';
import { TransferRequestSchema } from '@/modules/org/transfer-request.schema';
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
import { ActivityBindingSchema } from '@/modules/config/activity-binding.schema';
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
  TrainingContentFileSchema, TrainingContentHistoryEntrySchema, TrainingContentLinkSchema, TrainingContentSchema,
  TrainingModuleSchema,
} from '@/modules/training/training-module.schema';
import {
  ActivationAspectSchema, ActivationItemSchema, ActivationTemplateSchema,
} from '@/modules/activation/activation-template.schema';
import {
  AttackPlanSchema, CommissionYearSchema, ObjectionSchema, ProductSchema,
} from '@/modules/products/product.schema';
import {
  KpmProductConfigSchema, ProductDocumentRefSchema,
} from '@/modules/products/kpm-product-config.schema';
import {
  EventAudienceSchema, EventSchema, EventTypeSchema,
} from '@/modules/events/event.schema';
import { EventRsvpSchema } from '@/modules/events/event-rsvp.schema';
import { EventFeedbackSchema } from '@/modules/events/event-feedback.schema';
import {
  ActivityLogCorrectionSchema, ActivityLogEntrySchema, ActivityLogSchema,
} from '@/modules/activity/activity-log.schema';
import {
  LeadCommitmentSchema, LeadContactSchema, LeadNextActionDoneSchema, LeadSchema, LeadTransitionSchema,
} from '@/modules/leads/lead.schema';
import {
  GoalCascadeMappingSchema, GoalRevisionSchema, GoalSchema, GoalSnapshotSchema,
} from '@/modules/goals/goal.schema';
import { PolicySchema } from '@/modules/production/policy.schema';
import { ProductionMonthSchema } from '@/modules/production/production-month.schema';
import { DataUploadBatchSchema } from '@/modules/production/data-upload-batch.schema';
import { DataUploadRowSchema } from '@/modules/production/data-upload-row.schema';
import { UnregisteredAgentDataSchema } from '@/modules/production/unregistered-agent-data.schema';
import {
  MetricValueSchema, MonthlyAgentDataSchema,
} from '@/modules/production/monthly-agent-data.schema';
import {
  CampaignSchema, CriteriaGroupSchema, QualificationRuleSchema, RequirementSchema,
} from '@/modules/campaigns/campaign.schema';
import { CampaignChaseSchema } from '@/modules/campaigns/campaign-chase.schema';
import { CampaignStandingSchema } from '@/modules/campaigns/campaign-standing.schema';
import {
  CapabilityCatalogSchema, CapabilityEntrySchema, CapabilityGridRowSchema,
  CapabilityStageRowSchema,
} from '@/modules/capability/capability.schema';
import {
  CoachingActionItemDoneSchema, CoachingActionItemSchema, CoachingLastWeekItemSchema, CoachingLastWeekSchema, CoachingLeadActionSchema,
  CoachingSessionCorrectionSchema, CoachingSessionSchema, CoachingSnapshotSchema, CoachingTipSchema,
} from '@/modules/coaching/coaching-session.schema';
import { CoachingProfileRevisionSchema, CoachingProfileSchema } from '@/modules/coaching/coaching-profile.schema';
import { LeaderNoteRevisionSchema, LeaderNoteSchema } from '@/modules/coaching/leader-note.schema';
import { CalendarAttendeeSchema, CalendarEventSchema } from '@/modules/calendar/calendar-event.schema';
import {
  ActivationItemStateSchema, ActivationNoteSchema, ActivationProgressSchema,
} from '@/modules/activation/activation-progress.schema';
import { RecruitmentPlaybookSchema } from '@/modules/recruitment/recruitment-playbook.schema';
import { PitchConfirmationSchema, RecruitmentPitchSlotSchema } from '@/modules/recruitment/recruitment-pitch.schema';
import {
  LeaderMeetingActionItemSchema, LeaderMeetingAgendaItemSchema, LeaderMeetingAgendaSchema, LeaderMeetingSchema,
} from '@/modules/leader-meetings/leader-meeting.schema';
import { LeaderMeetingShareLinkSchema } from '@/modules/leader-meetings/leader-meeting-share-link.schema';
import { TrainingProgressSchema } from '@/modules/training/training-progress.schema';
import { SurveyRunSchema } from '@/modules/surveys/survey-run.schema';
import { SurveyParticipationSchema } from '@/modules/surveys/survey-participation.schema';
import { SurveyResponseSchema } from '@/modules/surveys/survey-response.schema';
import { AnalyticsTargetSchema } from '@/modules/reporting/advanced-analytics/analytics-target.schema';
import { QuantRunSchema } from '@/modules/reporting/advanced-analytics/quant-run.schema';
import { ProposalSchema } from '@/modules/proposals/proposal.schema';
import { KpmBrandingSchema } from '@/modules/branding/kpm-branding.schema';
import { KpmRecruitTargetSchema } from '@/modules/reporting/kpm-recruit-target.schema';
import { KpmSetupMarkSchema } from '@/modules/reporting/kpm-setup-mark.schema';

/**
 * P2-T8: soft delete everywhere.
 *
 * Erasure under UU 27/2022 is a deliberate, audited, cascading operation — not a
 * `deleteOne()`. That shape has to be right from the first collection, because
 * retrofitting cascade semantics across forty collections is a rewrite (ADR-0007).
 */

const SOFT_DELETABLE: ReadonlyArray<[string, Schema]> = [
  ['users', UserSchema],
  // UI-169 item 5 (ADR-0199 §3, §5): removing a link soft-deletes it, so who linked what stays readable.
  ['accountLinks', AccountLinkSchema],
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
  // ADR-0157: a leader past the office's limit, waiting for AgencyBoost.
  ['leaderLimitRequests', LeaderLimitRequestSchema],
  // P18.8-T3 (ADR-0170): a cancelled invite and a decided transfer stay, as the record of who asked for what.
  ['memberInvites', MemberInviteSchema],
  ['transferRequests', TransferRequestSchema],
  ['groups', GroupSchema],
  ['activityCategories', ActivityCategorySchema],
  ['activityTypes', ActivityTypeSchema],
  ['leadStatuses', LeadStatusSchema],
  ['ratioDefinitions', RatioDefinitionSchema],
  ['configSnapshots', ConfigSnapshotSchema],
  // ADR-0163: an office's activity binding, one row per office, `kpmId`-led.
  ['activityBindings', ActivityBindingSchema],
  ['impersonationSessions', ImpersonationSessionSchema],
  ['companyTemplates', CompanyTemplateSchema],
  ['templates', NamedTemplateSchema],
  ['trainingCategories', TrainingCategorySchema],
  ['trainingSkills', TrainingSkillSchema],
  ['trainingModules', TrainingModuleSchema],
  ['activationTemplates', ActivationTemplateSchema],
  ['products', ProductSchema],
  ['kpmProductConfigs', KpmProductConfigSchema],
  ['eventTypes', EventTypeSchema],
  ['events', EventSchema],
  // P18.2-T5, T6: a member's RSVP, claim and confirmation, and their answer — PDP erasure is P20-T1's cascade, never a delete.
  ['eventRsvps', EventRsvpSchema],
  ['eventFeedback', EventFeedbackSchema],
  ['activityLogs', ActivityLogSchema],
  ['leads', LeadSchema],
  ['goals', GoalSchema],
  ['policies', PolicySchema],
  ['monthlyAgentData', MonthlyAgentDataSchema],
  ['productionMonths', ProductionMonthSchema],
  ['dataUploadBatches', DataUploadBatchSchema],
  ['dataUploadRows', DataUploadRowSchema],
  ['unregisteredAgentData', UnregisteredAgentDataSchema],
  ['campaigns', CampaignSchema],
  ['campaignChases', CampaignChaseSchema],
  ['campaignStandings', CampaignStandingSchema],
  ['capabilityCatalogs', CapabilityCatalogSchema],
  // Company-partitioned carrier rules (ADR-0035), soft-deleted like every other row.
  ['qualificationRules', QualificationRuleSchema],
  // P11-T5. A finalized session is a dated record of the office; nothing hard-deletes one (AC-9).
  ['coachingSessions', CoachingSessionSchema],
  // P11-T9. A note is cleared by a save and never deleted by a route; P20-T1's erasure reaches both.
  ['coachingProfiles', CoachingProfileSchema],
  ['leaderNotes', LeaderNoteSchema],
  // P12-T2. A delete sets `deletedAt` and the entry leaves every calendar; P20-T1's erasure reaches it.
  ['calendarEvents', CalendarEventSchema],
  // P13-T1 AC-8. No route deletes an activation; a graduated or expired one is kept, and P20-T1 reaches it.
  ['activationProgress', ActivationProgressSchema],
  // Phase 17. A company's playbook is configuration, never hard-deleted (invariant §3); an office's pitch
  // document is replaced, never removed — *Replace* is the only change (D-replace) — and P20-T1 reaches it.
  ['recruitmentPlaybooks', RecruitmentPlaybookSchema],
  ['kpmRecruitmentPitchDocuments', RecruitmentPitchSlotSchema],
  // Phase 18 (D-recruit): an office's recruitment target per month, unique per (office, month), `kpmId`-led.
  ['kpmRecruitTargets', KpmRecruitTargetSchema],
  // P19.3-T2 (UI-149): an office's setup marks, unique per (office, mark), `kpmId`-led.
  ['kpmSetupMarks', KpmSetupMarkSchema],
  // Phase 18.1. *Delete meeting* writes `deletedAt` (ADR-0130 §5); a link expires or is revoked and stays the record
  // of who shared what (ADR-0131 §4). P20-T1's erasure cascade reaches both.
  ['leaderMeetings', LeaderMeetingSchema],
  ['leaderMeetingShareLinks', LeaderMeetingShareLinkSchema],
  // P18.2-T1 AC-2. No route deletes a member's progress; P20-T1's erasure cascade and export reach it.
  ['trainingProgress', TrainingProgressSchema],
  // P19.5-T4 (ADR-0216): a run is cancelled by `deletedAt`; nothing of a survey is hard-deleted.
  ['surveyRuns', SurveyRunSchema],
  ['surveyParticipation', SurveyParticipationSchema],
  ['surveyResponses', SurveyResponseSchema],
  // P19.5-T3 (ADR-0215 §6, §7): a target is cleared to `null`, a run frozen; neither is hard-deleted.
  ['analyticsTargets', AnalyticsTargetSchema],
  ['quantRuns', QuantRunSchema],
  // P19.7-T2 (ADR-0221 §1): an agent's proposals, items inside; every index `kpmId`-led; deleted by `deletedAt`.
  ['proposals', ProposalSchema],
  // P19.6-T1 (ADR-0218 §1, §12): a KPM's own branding, one live row; `kpmId`-led; *Kembalikan ke default* soft-deletes it.
  ['kpmBranding', KpmBrandingSchema],
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
    'trainingContentHistoryEntry (subdocument)',
    TrainingContentHistoryEntrySchema,
    'a subdocument of trainingModules (P19.4-T1): it is deleted with the module that holds it, and is itself the kept history (ADR-0208 §3)',
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
    'leadNextActionDone (subdocument)',
    LeadNextActionDoneSchema,
    'the latest ticked next action inside a lead (UI-104): *Urungkan* clears it, and the lead holds it, so it '
      + 'goes with the lead',
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
    'metricValue (subdocument)',
    MetricValueSchema,
    'one figure and its provenance, inside a month row: twelve of them per row, no collection and '
      + 'no _id of their own',
  ],
  [
    'goalRevision (subdocument)',
    GoalRevisionSchema,
    'a plan the goal replaced (ADR-0042). **Append-only and never removed** — a target somebody '
      + 'coached against does not stop having existed because it was revised',
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
  [
    'objection (subdocument)',
    ObjectionSchema,
    'one objection card inside a product\'s attack plan (P19.4-T4, ADR-0209 §9): deleted with the product that holds it',
  ],
  ['authTokens', AuthTokenSchema, 'self-expiring: revokedAt and expiresAt already model the lifecycle'],
  // P11-T5: the parts of a coaching session, each deleted with the session that holds it.
  [
    'coachingLastWeek (subdocument)',
    CoachingLastWeekSchema,
    'which finalized session a draft carried from, fixed at Start and deleted with the session holding it',
  ],
  [
    'coachingLastWeekItem (subdocument)',
    CoachingLastWeekItemSchema,
    'a copy of last week\'s item inside the session reviewing it: the draft\'s whole editable state is '
      + 'saved at once, and a finalized session keeps it in corrections[] when it is reopened (ADR-0042)',
  ],
  [
    'coachingActionItemDone (subdocument)',
    CoachingActionItemDoneSchema,
    'a coachee\'s tick on one action item, kept beside the session\'s lists (UI-104): *Urungkan* removes it, and it '
      + 'goes with the session that holds it',
  ],
  [
    'coachingActionItem (subdocument)',
    CoachingActionItemSchema,
    'one of the session\'s other action items: removed with the ✕ while the draft is edited, and kept '
      + 'whole in corrections[] once a finalized version is reopened (ADR-0042)',
  ],
  [
    'coachingTip (subdocument)',
    CoachingTipSchema,
    'one coaching tip: removed with the ✕ while the draft is edited, and kept whole in corrections[] '
      + 'once a finalized version is reopened (ADR-0042)',
  ],
  [
    'coachingLeadAction (subdocument)',
    CoachingLeadActionSchema,
    'taken whole at every finalize from the coachee\'s leads as they stand; the list it replaced stays '
      + 'in corrections[] (ADR-0042)',
  ],
  [
    'coachingSessionCorrection (subdocument)',
    CoachingSessionCorrectionSchema,
    'a finalized state a reopen replaced. **Append-only and never removed**: the earlier agreement '
      + 'stays readable to everybody who reads the session (ADR-0042, ADR-0079)',
  ],
  [
    'coachingSnapshot (subdocument)',
    CoachingSnapshotSchema,
    'taken once, at the first finalize, and carried unchanged by every later version: never rewritten '
      + 'and never removed apart from the session',
  ],
  // P11-T9: what a profile save or a note save replaced, kept whole inside the record it belongs to.
  [
    'coachingProfileRevision (subdocument)',
    CoachingProfileRevisionSchema,
    'a tick set a profile save replaced. **Append-only and never removed**: it is the attribution a '
      + 'profile save writes instead of an audit entry',
  ],
  [
    'leaderNoteRevision (subdocument)',
    LeaderNoteRevisionSchema,
    'a text a note save replaced. **Append-only and never removed** apart from the note, which P20-T1\'s '
      + 'erasure cascade reaches whole',
  ],
  // P12-T2: one member on a calendar entry, held inside the entry it belongs to.
  [
    'calendarAttendee (subdocument)',
    CalendarAttendeeSchema,
    'one member on a calendar entry: taken off by its organiser\'s edit or by leaving the office, while the '
      + 'entry itself is soft-deleted whole',
  ],
  // P13-T1: an item's state and the coaching note, held inside the hire's activation.
  [
    'activationItemState (subdocument)',
    ActivationItemStateSchema,
    'one item of a hire\'s activation, by code: ticked and unticked in place, never removed apart from the '
      + 'activation, which is soft-deleted whole',
  ],
  [
    'activationNote (subdocument)',
    ActivationNoteSchema,
    'the coaching note on a hire\'s activation: replaced by the next save, never removed apart from the '
      + 'activation, which P20-T1\'s erasure cascade reaches whole',
  ],
  [
    'pitchConfirmation (subdocument)',
    PitchConfirmationSchema,
    'one tick of a pitch slot\'s checklist: cleared by the next attach or an untick, inside the slot it '
      + 'belongs to, which is soft-deleted whole',
  ],
  [
    'leaderMeetingAgenda (subdocument)',
    LeaderMeetingAgendaSchema,
    'a meeting\'s three agenda sections, inside the meeting, which is soft-deleted whole',
  ],
  [
    'leaderMeetingAgendaItem (subdocument)',
    LeaderMeetingAgendaItemSchema,
    'an agenda item is removed by emptying its text, as the prototype has no remove (D-forum-model): the audit '
      + 'row keeps what it was, and the meeting holding it is soft-deleted whole',
  ],
  [
    'leaderMeetingActionItem (subdocument)',
    LeaderMeetingActionItemSchema,
    'a tracker row is removed by its × as drawn (`KPM_Owner.html:2867`): the audit row keeps what it was, and '
      + 'the meeting holding it is soft-deleted whole',
  ],
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
  [ActivityBindingSchema, 'ActivityBindingSchema'],
  [ImpersonationSessionSchema, 'ImpersonationSessionSchema'],
  [CompanyTemplateSchema, 'CompanyTemplateSchema'],
  [NamedTemplateSchema, 'NamedTemplateSchema'],
  [TrainingCategorySchema, 'TrainingCategorySchema'],
  [TrainingSkillSchema, 'TrainingSkillSchema'],
  [TrainingModuleSchema, 'TrainingModuleSchema'],
  [TrainingContentSchema, 'TrainingContentSchema'],
  [TrainingContentFileSchema, 'TrainingContentFileSchema'],
  [TrainingContentLinkSchema, 'TrainingContentLinkSchema'],
  [TrainingContentHistoryEntrySchema, 'TrainingContentHistoryEntrySchema'],
  [ActivationTemplateSchema, 'ActivationTemplateSchema'],
  [ActivationAspectSchema, 'ActivationAspectSchema'],
  [ActivationItemSchema, 'ActivationItemSchema'],
  [ProductSchema, 'ProductSchema'],
  [KpmProductConfigSchema, 'KpmProductConfigSchema'],
  [EventTypeSchema, 'EventTypeSchema'],
  [EventSchema, 'EventSchema'],
  [EventRsvpSchema, 'EventRsvpSchema'],
  [EventFeedbackSchema, 'EventFeedbackSchema'],
  [EventAudienceSchema, 'EventAudienceSchema'],
  [ActivityLogSchema, 'ActivityLogSchema'],
  [LeadSchema, 'LeadSchema'],
  [LeadContactSchema, 'LeadContactSchema'],
  [LeadTransitionSchema, 'LeadTransitionSchema'],
  [LeadNextActionDoneSchema, 'LeadNextActionDoneSchema'],
  [LeadCommitmentSchema, 'LeadCommitmentSchema'],
  [GoalSchema, 'GoalSchema'],
  [GoalSnapshotSchema, 'GoalSnapshotSchema'],
  [GoalCascadeMappingSchema, 'GoalCascadeMappingSchema'],
  [PolicySchema, 'PolicySchema'],
  [MonthlyAgentDataSchema, 'MonthlyAgentDataSchema'],
  [ProductionMonthSchema, 'ProductionMonthSchema'],
  [DataUploadBatchSchema, 'DataUploadBatchSchema'],
  [DataUploadRowSchema, 'DataUploadRowSchema'],
  [UnregisteredAgentDataSchema, 'UnregisteredAgentDataSchema'],
  [MetricValueSchema, 'MetricValueSchema'],
  [GoalRevisionSchema, 'GoalRevisionSchema'],
  [ActivityLogEntrySchema, 'ActivityLogEntrySchema'],
  [ActivityLogCorrectionSchema, 'ActivityLogCorrectionSchema'],
  [CampaignSchema, 'CampaignSchema'],
  [CampaignChaseSchema, 'CampaignChaseSchema'],
  [CampaignStandingSchema, 'CampaignStandingSchema'],
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
  [ObjectionSchema, 'ObjectionSchema'],
  [MembershipSchema, 'MembershipSchema'],
  [MembershipHistorySchema, 'MembershipHistorySchema'],
  [JoinRequestSchema, 'JoinRequestSchema'],
  [LeaderLimitRequestSchema, 'LeaderLimitRequestSchema'],
  [MemberInviteSchema, 'MemberInviteSchema'],
  [TransferRequestSchema, 'TransferRequestSchema'],
  [GroupSchema, 'GroupSchema'],
  [AuditLogSchema, 'AuditLogSchema'],
  [AuthTokenSchema, 'AuthTokenSchema'],
  [AccountLinkSchema, 'AccountLinkSchema'],
  [CoachingSessionSchema, 'CoachingSessionSchema'],
  [CoachingLastWeekSchema, 'CoachingLastWeekSchema'],
  [CoachingLastWeekItemSchema, 'CoachingLastWeekItemSchema'],
  [CoachingActionItemSchema, 'CoachingActionItemSchema'],
  [CoachingActionItemDoneSchema, 'CoachingActionItemDoneSchema'],
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
  [RecruitmentPlaybookSchema, 'RecruitmentPlaybookSchema'],
  [RecruitmentPitchSlotSchema, 'RecruitmentPitchSlotSchema'],
  [KpmRecruitTargetSchema, 'KpmRecruitTargetSchema'],
  [KpmSetupMarkSchema, 'KpmSetupMarkSchema'],
  [PitchConfirmationSchema, 'PitchConfirmationSchema'],
  [LeaderMeetingSchema, 'LeaderMeetingSchema'],
  [LeaderMeetingAgendaSchema, 'LeaderMeetingAgendaSchema'],
  [LeaderMeetingAgendaItemSchema, 'LeaderMeetingAgendaItemSchema'],
  [LeaderMeetingActionItemSchema, 'LeaderMeetingActionItemSchema'],
  [LeaderMeetingShareLinkSchema, 'LeaderMeetingShareLinkSchema'],
  [TrainingProgressSchema, 'TrainingProgressSchema'],
  [SurveyRunSchema, 'SurveyRunSchema'],
  [SurveyParticipationSchema, 'SurveyParticipationSchema'],
  [SurveyResponseSchema, 'SurveyResponseSchema'],
  [AnalyticsTargetSchema, 'AnalyticsTargetSchema'],
  [QuantRunSchema, 'QuantRunSchema'],
  [ProposalSchema, 'ProposalSchema'],
  [KpmBrandingSchema, 'KpmBrandingSchema'],
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
