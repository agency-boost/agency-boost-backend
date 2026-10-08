import { SummaryDto } from '@/modules/summary/summary.response.dto';
import { Type } from '@nestjs/common';
import {
  AccessTokenDto, ImpersonationSessionDto, MeDto, MyKpmRequestDto, ReadinessDto,
  RedeemedInviteDto, SessionDto, StatusAckDto,
} from '@/modules/auth/session.response.dto';
import {
  InboxDto, NotificationReadStateDto, UnreadCountDto,
} from '@/modules/notifications/notification.response.dto';
import { DeletedLeadDto, LeadPageDto, LeadResponseDto } from '@/modules/leads/lead.response.dto';
import { GoalResponseDto } from '@/modules/goals/goal.response.dto';
import {
  CorrectionResultDto, HistoryDto, ImportResultDto, MonthStateDto, MonthViewDto, TemplateFileDto,
  UploadPreviewDto,
} from '@/modules/production/production.response.dto';
import {
  DelegatedAdminDto, DirectoryMemberDto, DirectoryPageDto, GroupSummaryDto, InvitePreviewDto,
  JoinStateDto, KpmDirectoryEntryDto, LeaderChoiceDto, MemberTagsDto,
  MyLeaderCodeDto, OrgTreeDto, PendingRequestDto, RoleChangeEntryDto, RoutingChoiceDto, TeamMemberDto,
  UntaggedMemberDto,
} from '@/modules/org/org.response.dto';
import {
  KpmAdminViewDto, KpmRequestRowDto, KpmViewDto, OrgLevelRowDto, PlatformAdminRowDto,
  PlatformOverviewDto, RosterCommitDto, RosterPreviewDto, RosterTemplateDto,
} from '@/modules/tenants/tenant.response.dto';
import {
  AuditEntryResponseDto, CompanyResponseDto, PublicCompanyDto,
} from '@/modules/tenants/platform.response.dto';
import {
  ActivityCategoryDto, ActivityTypeDto, LeadPipelineDto, LeadStatusDto, RatioDefinitionDto,
  CompanyTemplateDto, NamedTemplateDto, PublishStateDto, SavedOfficeTemplateDto, TenantConfigDto,
} from '@/modules/config/config.response.dto';
import {
  ModuleContentDto, SignedUploadDto, SignedUrlDto, TrainingCategoryDto,
} from '@/modules/training/training.response.dto';
import { ActivationChecklistDto } from '@/modules/activation/activation.response.dto';
import {
  ActivationNoteSavedDto, ActivationViewDto, NewHiresRosterDto,
} from '@/modules/activation/activation-progress.response.dto';
import { ProductResponseDto } from '@/modules/products/product.response.dto';
import {
  EffectiveScriptDto, KpmProductDto, SignedUrlDto as ProductSignedUrlDto,
} from '@/modules/products/kpm-product.response.dto';
import {
  AttackPlanDto, CatalogDocumentUrlDto, CatalogListDto, CatalogProductDto,
} from '@/modules/products/product-catalog.response.dto';
import { EventDto, EventTypeDto } from '@/modules/events/event.response.dto';
import { CampaignDto, MetricDefinitionDto, QualificationRuleDto } from '@/modules/campaigns/campaign.response.dto';
import { CapabilityCatalogDto } from '@/modules/capability/capability.response.dto';
import { BillingPricesDto } from '@/modules/billing/billing.response.dto';

/** What one operation answers with: a class, and whether it comes back as an array. */
export interface ResponseShape {
  type: Type<unknown>;
  isArray?: true;
}

/**
 * Every operation's success body, keyed `Controller_method`.
 *
 * **One table rather than 69 decorators**, for the same reason the permission and the
 * failures are derived rather than restated: what matters here is *completeness*, and a
 * decorator somebody forgot on a new route is invisible. A missing entry here is a
 * failing test (`openapi.spec.ts`), which is what makes AC-1's word "every" enforceable
 * rather than aspirational.
 *
 * The classes themselves live beside the services that produce them and `implements`
 * their interfaces, so the *shape* cannot drift either. This table only says which one.
 */
import {
  ActivityDashboardDto, ActivityDayDto, ActivityRatiosDto, ActivitySummaryDto,
} from '@/modules/activity/activity.response.dto';
import { CoacheeDto, CoachingRosterDto } from '@/modules/coaching/coaching.response.dto';
import { ProductionUpdatedDto, UnitDashboardDto } from '@/modules/unit-dashboard/unit-dashboard.response.dto';
import {
  CoachingSessionDto, SessionDraftSavedDto, SessionHistoryDto,
} from '@/modules/coaching/coaching-session.response.dto';
import {
  CoachingProfileDto, CoachingProfileSavedDto, LeaderNoteSavedDto, LeaderNotesDto,
} from '@/modules/coaching/coaching-profile.response.dto';
import { MySessionsDto, SessionPrintDto } from '@/modules/coaching/coaching-record.response.dto';
import {
  CalendarDeletedDto, CalendarDownlineDto, CalendarEntryDto, CalendarPeoplePageDto, CalendarPeriodDto,
  CalendarSettingsDto,
} from '@/modules/calendar/calendar.response.dto';

export const RESPONSE_SHAPES: Readonly<Record<string, ResponseShape>> = {
  // P6: what an agent did, day by day.
  ActivityController_readDay: { type: ActivityDayDto },
  ActivityController_saveDay: { type: ActivityDayDto },
  ActivityController_correctDay: { type: ActivityDayDto },
  ActivityController_summary: { type: ActivitySummaryDto },
  ActivityController_dashboard: { type: ActivityDashboardDto },
  ActivityController_ratios: { type: ActivityRatiosDto },
  SummaryController_read: { type: SummaryDto },
  // Phase 15: a leader's unit, and *Update production*.
  UnitDashboardController_read: { type: UnitDashboardDto },
  UnitDashboardController_updateProduction: { type: ProductionUpdatedDto },
  // P11-T6: the coaching roster. P11-T7: the person a coaching page opens on.
  CoachingController_coachees: { type: CoachingRosterDto },
  CoachingController_coachee: { type: CoacheeDto },
  // P11-T5: the session lifecycle.
  CoachingController_history: { type: SessionHistoryDto },
  CoachingController_start: { type: CoachingSessionDto },
  CoachingController_read: { type: CoachingSessionDto },
  CoachingController_save: { type: SessionDraftSavedDto },
  CoachingController_finalize: { type: CoachingSessionDto },
  CoachingController_reopen: { type: CoachingSessionDto },
  // P11-T9: the Leader Notes tab — the capability profile and the leader notes.
  CoachingProfileController_profile: { type: CoachingProfileDto },
  CoachingProfileController_saveProfile: { type: CoachingProfileSavedDto },
  CoachingProfileController_leaderNotes: { type: LeaderNotesDto },
  CoachingProfileController_saveLeaderNote: { type: LeaderNoteSavedDto },
  // P11-T10: a finalized session's print, and the reader's own coaching.
  CoachingRecordController_mine: { type: MySessionsDto },
  CoachingRecordController_print: { type: SessionPrintDto },
  // Phase 12: the calendar — a period of one calendar, one entry, its writes, the picker and the compare list.
  CalendarController_read: { type: CalendarPeriodDto },
  CalendarController_readOne: { type: CalendarEntryDto },
  CalendarController_create: { type: CalendarEntryDto },
  CalendarController_update: { type: CalendarEntryDto },
  CalendarController_remove: { type: CalendarDeletedDto },
  CalendarController_answer: { type: CalendarEntryDto },
  CalendarController_block: { type: CalendarEntryDto },
  CalendarController_searchPeople: { type: CalendarPeoplePageDto },
  CalendarController_downline: { type: CalendarDownlineDto },
  // P13.1-T8: the reader's own calendar settings, *Hide my personal activities* (ADR-0110).
  CalendarController_readSettings: { type: CalendarSettingsDto },
  CalendarController_saveSettings: { type: CalendarSettingsDto },
  // Phase 13: the hire's own activation, and a leader's new hires.
  ActivationProgressController_mine: { type: ActivationViewDto },
  ActivationProgressController_tick: { type: ActivationViewDto },
  ActivationProgressController_graduate: { type: ActivationViewDto },
  NewHiresController_roster: { type: NewHiresRosterDto },
  NewHiresController_detail: { type: ActivationViewDto },
  NewHiresController_tick: { type: ActivationViewDto },
  NewHiresController_correctStart: { type: ActivationViewDto },
  NewHiresController_saveNote: { type: ActivationNoteSavedDto },
  AuthController_resendVerification: { type: StatusAckDto },
  AuthController_sessions: { type: SessionDto, isArray: true },
  HealthController_live: { type: StatusAckDto },
  HealthController_ready: { type: ReadinessDto },

  AuthController_register: { type: StatusAckDto },
  AuthController_login: { type: AccessTokenDto },
  AuthController_refresh: { type: AccessTokenDto },
  AuthController_logout: { type: StatusAckDto },
  // 204 both: nothing to say beyond "it is done", and a body would invite a client to
  // read one. They are in the table anyway, because the table is where completeness is
  // visible and a route missing from it is a route nobody checked.
  AuthController_logoutAll: { type: StatusAckDto },
  AuthController_revokeSession: { type: StatusAckDto },
  AuthController_verifyEmail: { type: StatusAckDto },
  AuthController_forgotPassword: { type: StatusAckDto },
  AuthController_resetPassword: { type: StatusAckDto },
  AuthController_changePassword: { type: StatusAckDto },
  AuthController_me: { type: MeDto },
  AuthController_updateMe: { type: MeDto },

  OnboardingController_me: { type: JoinStateDto },
  OnboardingController_kpms: { type: KpmDirectoryEntryDto, isArray: true },
  OnboardingController_register: { type: JoinStateDto },
  OnboardingController_myKpmRequest: { type: MyKpmRequestDto },
  OnboardingController_askForKpm: { type: KpmRequestRowDto },
  OnboardingController_leaders: { type: LeaderChoiceDto, isArray: true },
  OnboardingController_request: { type: JoinStateDto },
  OnboardingController_cancel: { type: JoinStateDto },
  OnboardingController_myLeaderCode: { type: MyLeaderCodeDto },
  OnboardingController_previewInvite: { type: InvitePreviewDto },
  OnboardingController_redeem: { type: RedeemedInviteDto },
  OnboardingController_inbox: { type: PendingRequestDto, isArray: true },
  OnboardingController_routing: { type: RoutingChoiceDto, isArray: true },
  OnboardingController_approve: { type: PendingRequestDto, isArray: true },
  OnboardingController_decline: { type: PendingRequestDto, isArray: true },
  OnboardingController_untagged: { type: UntaggedMemberDto, isArray: true },
  OnboardingController_tag: { type: UntaggedMemberDto, isArray: true },

  TenantConfigController_listActivityTypes: { type: ActivityCategoryDto, isArray: true },
  TenantConfigController_createCategory: { type: ActivityCategoryDto },
  TenantConfigController_updateCategory: { type: ActivityCategoryDto },
  TenantConfigController_archiveCategory: { type: ActivityCategoryDto },
  TenantConfigController_restoreCategory: { type: ActivityCategoryDto },
  TenantConfigController_reorderCategories: { type: ActivityCategoryDto, isArray: true },
  // The working copy as it now stands — publishing is still a separate act.
  TenantConfigController_applyChanges: { type: TenantConfigDto },
  TenantConfigController_createType: { type: ActivityTypeDto },
  TenantConfigController_reorderTypes: { type: ActivityTypeDto, isArray: true },
  TenantConfigController_updateType: { type: ActivityTypeDto },
  TenantConfigController_archiveType: { type: ActivityTypeDto },
  TenantConfigController_restoreType: { type: ActivityTypeDto },
  TenantConfigController_listLeadStatuses: { type: LeadPipelineDto, isArray: true },
  TenantConfigController_createLeadStatus: { type: LeadStatusDto },
  TenantConfigController_reorderLeadStatuses: { type: LeadPipelineDto },
  TenantConfigController_renameLeadStatus: { type: LeadStatusDto },
  TenantConfigController_setTerminal: { type: LeadPipelineDto },
  TenantConfigController_setLateStage: { type: LeadStatusDto },
  GoalController_read: { type: GoalResponseDto },
  GoalController_save: { type: GoalResponseDto },
  ProductionController_readMonth: { type: MonthViewDto },
  ProductionController_template: { type: TemplateFileDto },
  ProductionController_preview: { type: UploadPreviewDto },
  ProductionController_commit: { type: ImportResultDto },
  ProductionController_revert: { type: ImportResultDto },
  ProductionController_history: { type: HistoryDto },
  ProductionController_lock: { type: MonthStateDto },
  ProductionController_reopen: { type: MonthStateDto },
  ProductionController_correct: { type: CorrectionResultDto },
  LeadController_list: { type: LeadPageDto },
  LeadController_read: { type: LeadResponseDto },
  LeadController_create: { type: LeadResponseDto },
  LeadController_update: { type: LeadResponseDto },
  LeadController_setStatus: { type: LeadResponseDto },
  LeadController_setOutcome: { type: LeadResponseDto },
  LeadController_remove: { type: DeletedLeadDto },
  TenantConfigController_archiveLeadStatus: { type: LeadStatusDto },
  TenantConfigController_restoreLeadStatus: { type: LeadStatusDto },
  AdminController_elevateSession: { type: StatusAckDto },
  AdminController_readTemplate: { type: CompanyTemplateDto },
  AdminController_templateHistory: { type: CompanyTemplateDto, isArray: true },
  AdminController_saveTemplateDraft: { type: CompanyTemplateDto },
  AdminController_publishTemplate: { type: CompanyTemplateDto },
  // P13.2-T6: a company's named templates (ADR-0115).
  NamedTemplateController_list: { type: NamedTemplateDto, isArray: true },
  NamedTemplateController_create: { type: NamedTemplateDto },
  NamedTemplateController_update: { type: NamedTemplateDto },
  NamedTemplateController_archive: { type: NamedTemplateDto },
  // P13.2-T7: the copies across an owner boundary answer with the template they made.
  NamedTemplateController_importFrom: { type: NamedTemplateDto },
  // P13.2's exit review (finding 2): with what the office held that the template left out, and why.
  OfficeTemplateController_save: { type: SavedOfficeTemplateDto },
  TenantConfigReadController_orgLevels: { type: OrgLevelRowDto, isArray: true },
  TenantConfigReadController_readConfig: { type: TenantConfigDto },
  TenantConfigController_publishState: { type: PublishStateDto },
  TenantConfigController_publish: { type: PublishStateDto },
  TenantConfigController_readBranchInfo: { type: KpmViewDto },
  TenantConfigController_updateBranchInfo: { type: KpmViewDto },
  TenantConfigController_listRatios: { type: RatioDefinitionDto, isArray: true },
  TenantConfigController_createRatio: { type: RatioDefinitionDto },
  TenantConfigController_updateRatio: { type: RatioDefinitionDto },
  TenantConfigController_archiveRatio: { type: RatioDefinitionDto },
  TenantConfigController_restoreRatio: { type: RatioDefinitionDto },
  TrainingController_list: { type: TrainingCategoryDto, isArray: true },
  // A module's content (P5-T2). Not part of the office snapshot: it is files, not rows.
  TrainingController_requestUpload: { type: SignedUploadDto },
  TrainingController_confirmUpload: { type: ModuleContentDto },
  TrainingController_readContent: { type: ModuleContentDto },
  TrainingController_saveContent: { type: ModuleContentDto },
  TrainingController_resetContent: { type: ModuleContentDto },
  TrainingController_contentUrl: { type: SignedUrlDto },
  ActivationController_read: { type: ActivationChecklistDto },
  ActivationController_saveDraft: { type: ActivationChecklistDto },
  ActivationController_publish: { type: ActivationChecklistDto },

  // The company's product catalog (P5-T4). Every route answers with the product, or the
  // whole shelf where the act was about the shelf.
  ProductController_list: { type: ProductResponseDto, isArray: true },
  ProductController_create: { type: ProductResponseDto },
  ProductController_reorder: { type: ProductResponseDto, isArray: true },
  ProductController_update: { type: ProductResponseDto },
  ProductController_closeToNewBusiness: { type: ProductResponseDto },
  ProductController_withdraw: { type: ProductResponseDto },
  ProductController_reopen: { type: ProductResponseDto },

  // What an office decides about its company's products (P5-T5).
  KpmProductController_list: { type: KpmProductDto, isArray: true },
  KpmProductController_setActive: { type: KpmProductDto },
  KpmProductController_saveOverrides: { type: KpmProductDto },
  KpmProductController_resetOverride: { type: KpmProductDto },
  KpmProductController_setDocument: { type: KpmProductDto },
  KpmProductController_resetDocument: { type: KpmProductDto },
  KpmProductController_documentUrl: { type: ProductSignedUrlDto },
  // The script approval gate (P5-T10, ADR-0037).
  KpmProductController_pendingReviews: { type: KpmProductDto, isArray: true },
  KpmProductController_approveScript: { type: KpmProductDto },
  KpmProductController_rejectScript: { type: KpmProductDto },
  KpmProductController_effectiveScript: { type: EffectiveScriptDto },
  // Phase 14: the field reads — the office's shelf, one product, a document's link, the plan.
  ProductCatalogController_list: { type: CatalogListDto },
  ProductCatalogController_product: { type: CatalogProductDto },
  ProductCatalogController_documentUrl: { type: CatalogDocumentUrlDto },
  AttackPlanController_plan: { type: AttackPlanDto },

  // The events an office runs (P5-T6).
  EventController_listTypes: { type: EventTypeDto, isArray: true },
  EventController_createType: { type: EventTypeDto },
  EventController_updateType: { type: EventTypeDto },
  EventController_archiveType: { type: EventTypeDto },
  EventController_restoreType: { type: EventTypeDto },
  EventController_list: { type: EventDto, isArray: true },
  EventController_create: { type: EventDto },
  EventController_update: { type: EventDto },
  EventController_archive: { type: EventDto },
  EventController_restore: { type: EventDto },

  // Campaigns, and the carrier rules an office is measured against (P5-T7).
  MetricRegistryController_list: { type: MetricDefinitionDto, isArray: true },
  CampaignController_listRules: { type: QualificationRuleDto, isArray: true },
  CampaignController_list: { type: CampaignDto, isArray: true },
  CampaignController_create: { type: CampaignDto },
  CampaignController_update: { type: CampaignDto },
  CampaignController_archive: { type: CampaignDto },
  CampaignController_restore: { type: CampaignDto },

  // The office's capability catalog (P5-T8). No delete route, by design.
  CapabilityController_read: { type: CapabilityCatalogDto },
  CapabilityController_rename: { type: CapabilityCatalogDto },
  CapabilityController_setStatus: { type: CapabilityCatalogDto },
  CapabilityController_add: { type: CapabilityCatalogDto },
  CapabilityController_reorder: { type: CapabilityCatalogDto },
  OrgController_myTeam: { type: TeamMemberDto, isArray: true },
  OrgController_changeRole: { type: TeamMemberDto, isArray: true },
  OrgController_remove: { type: TeamMemberDto, isArray: true },
  OrgController_roleLog: { type: RoleChangeEntryDto, isArray: true },
  OrgController_orgTree: { type: OrgTreeDto },
  OrgController_listAdmins: { type: DelegatedAdminDto, isArray: true },
  OrgController_grantAdmin: { type: DelegatedAdminDto, isArray: true },
  OrgController_revokeAdmin: { type: DelegatedAdminDto, isArray: true },
  OrgController_listGroups: { type: GroupSummaryDto, isArray: true },
  OrgController_createGroup: { type: GroupSummaryDto, isArray: true },
  OrgController_updateGroup: { type: GroupSummaryDto, isArray: true },
  OrgController_archiveGroup: { type: GroupSummaryDto, isArray: true },
  OrgController_readTags: { type: MemberTagsDto },
  OrgController_tagMember: { type: MemberTagsDto },
  OrgController_list: { type: DirectoryPageDto },
  OrgController_read: { type: DirectoryMemberDto },
  OrgController_reports: { type: DirectoryMemberDto, isArray: true },

  // P12.1-T4: a page of the inbox; a mark answers that one row's state and the count, not the page.
  NotificationController_inbox: { type: InboxDto },
  NotificationController_readAll: { type: UnreadCountDto },
  NotificationController_read: { type: NotificationReadStateDto },
  NotificationController_unread: { type: NotificationReadStateDto },

  AdminController_overview: { type: PlatformOverviewDto },
  AdminController_tenantAdmins: { type: PlatformAdminRowDto, isArray: true },
  AdminController_kpmRequests: { type: KpmRequestRowDto, isArray: true },
  AdminController_approveKpmRequest: { type: KpmRequestRowDto, isArray: true },
  AdminController_declineKpmRequest: { type: KpmRequestRowDto, isArray: true },
  AdminController_listCompanies: { type: CompanyResponseDto, isArray: true },
  // Public, and two fields only — a visitor asking which insurer issued their agent
  // code has no business knowing how each one is configured (ADR-0017).
  CompanyController_list: { type: PublicCompanyDto, isArray: true },
  AdminController_createCompany: { type: CompanyResponseDto },
  AdminController_updateCompany: { type: CompanyResponseDto },
  AdminController_setCompanyStatus: { type: CompanyResponseDto },
  AdminController_listOrgLevels: { type: OrgLevelRowDto, isArray: true },
  AdminController_createOrgLevel: { type: OrgLevelRowDto, isArray: true },
  AdminController_updateOrgLevel: { type: OrgLevelRowDto, isArray: true },
  // P13.2-T3: the Super Admin's rows carry the subscription, Leaders used and the ended state.
  AdminController_listTenants: { type: KpmAdminViewDto, isArray: true },
  AdminController_createTenant: { type: KpmViewDto },
  AdminController_readTenant: { type: KpmAdminViewDto },
  AdminController_assignOwner: { type: KpmAdminViewDto },
  AdminController_setStatus: { type: KpmAdminViewDto },
  AdminController_updateSubscription: { type: KpmAdminViewDto },
  AdminController_rosterTemplate: { type: RosterTemplateDto },
  AdminController_previewRoster: { type: RosterPreviewDto },
  AdminController_importRoster: { type: RosterCommitDto },
  AdminController_readAudit: { type: AuditEntryResponseDto, isArray: true },
  AdminController_impersonate: { type: ImpersonationSessionDto },
  AdminController_endImpersonation: { type: StatusAckDto },
  // P13.2-T2: the quote tool's price table, the Super Admin's alone (ADR-0111).
  BillingController_prices: { type: BillingPricesDto },
};

/** Every class the table names, so Swagger emits a schema for each. */
export const RESPONSE_MODELS: Type<unknown>[] = [
  ...new Set(Object.values(RESPONSE_SHAPES).map((s) => s.type)),
];
