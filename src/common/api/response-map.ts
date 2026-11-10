import { AvatarDto, ProfileFactsDto } from '@/modules/users/profile.dto';
import { SummaryDto } from '@/modules/summary/summary.response.dto';
import { MemberPerformanceDto } from '@/modules/summary/member-performance.response.dto';
import { Type } from '@nestjs/common';
import {
  AdminAdvancedAnalyticsSectionDto, AdvancedAnalyticsShellDto, DemographicsDto, EventsNpsDto, MapaDto, MapaTargetDto,
  QuantDto, SubgroupDto, SubgroupTargetDto,
} from '@/modules/reporting/advanced-analytics/advanced-analytics.response.dto';
import { XLSX_MIME_TYPE } from '@/domain/constants';
import {
  BrandingPreviewAnswerDto, BrandingSettingsDto, ConfirmedBrandingImageDto, PublicBrandingDto,
} from '@/modules/branding/branding.response.dto';
import {
  AccessTokenDto, EmailChangedDto, ImpersonationSessionDto, MeDto, ReadinessDto,
  RedeemedInviteDto, SessionDto, StatusAckDto,
} from '@/modules/auth/session.response.dto';
import {
  InboxDto, NotificationReadStateDto, UnreadCountDto,
} from '@/modules/notifications/notification.response.dto';
import { DeletedLeadDto, LeadOrderDto, LeadPageDto, LeadResponseDto } from '@/modules/leads/lead.response.dto';
import {
  ProposalCatalogDto, ProposalDuplicatedDto, ProposalPageDto, ProposalPatchedDto, ProposalResponseDto,
} from '@/modules/proposals/proposal.response.dto';
import { GoalMonthApeResponseDto, GoalPreviewDto, GoalResponseDto } from '@/modules/goals/goal.response.dto';
import {
  CorrectionResultDto, HistoryDto, ImportResultDto, MonthStateDto, MonthViewDto, TemplateFileDto,
  UploadPreviewDto,
} from '@/modules/production/production.response.dto';
import {
  DelegatedAdminDto, DirectoryMemberDto, DirectoryPageDto, GroupSummaryDto, InvitePreviewDto,
  JoinStateDto, KpmDirectoryEntryDto, LeaderChoiceDto, LeaderLimitRequestRowDto, MemberTagsDto,
  MyLeaderCodeDto, OrgTreeDto, PendingRequestDto, RoleChangeEntryDto, RoutingChoiceDto, TeamMemberDto,
  UntaggedMemberDto, MemberPhoneDto, MemberSearchResultDto, WaitingRequestCountDto,
} from '@/modules/org/org.response.dto';
import {
  AccountChoiceDto, CodeAvailabilityDto, KpmAdminViewDto, KpmListRowDto, KpmProfileDto, KpmContentsDto, KpmCreatedDto, KpmDeletedDto, KpmRequestRowDto, KpmViewDto,
  MyKpmRequestStateDto, OrgLevelRowDto, PlatformAdminRowDto, PlatformOverviewDto, RosterCommitDto, RosterPreviewDto,
  RosterTemplateDto,
} from '@/modules/tenants/tenant.response.dto';
import { CompanyResponseDto, PublicCompanyDto } from '@/modules/tenants/platform.response.dto';
import { AuditPageDto } from '@/modules/audit/audit.response.dto';
import {
  ActivityCategoryDto, ActivityTypeDto, LeadPipelineDto, LeadStatusDto, RatioDefinitionDto,
  ActivityBindingDto, CompanyTemplateDto, NamedTemplateDto, OfficeActivityBindingDto, PublishAllDto, PublishStateDto,
  SavedOfficeTemplateDto, TemplateOfficeStandingDto, TenantConfigDto,
  ApplyTemplateResultDto, ConfirmedUploadDto,
} from '@/modules/config/config.response.dto';
import {
  ModuleContentDto, SignedUploadDto, SignedUrlDto, TrainingCategoryDto,
} from '@/modules/training/training.response.dto';
import {
  TrainingModulePageDto, TrainingOpenDto, TrainingProgressDto,
} from '@/modules/training/training-progress.response.dto';
import { TemplateSyncResultDto, TemplateSyncViewDto } from '@/modules/config/template-sync.dto';
import { ActivationChecklistDto } from '@/modules/activation/activation.response.dto';
import {
  ActivationClosingsDto, ActivationEmptyDto, ActivationNoteSavedDto, ActivationViewDto, NewHireDetailDto, NewHiresRosterDto,
} from '@/modules/activation/activation-progress.response.dto';
import { ProductResponseDto } from '@/modules/products/product.response.dto';
import {
  EffectiveScriptDto, KpmProductDto, SignedUrlDto as ProductSignedUrlDto,
} from '@/modules/products/kpm-product.response.dto';
import {
  PitchDocumentUrlDto, PitchMaterialsDto, PitchSlotDto, RecruitmentAttackPlanDto,
} from '@/modules/recruitment/recruitment.response.dto';
import {
  AttackPlanDto, CatalogDocumentUrlDto, CatalogListDto, CatalogProductDto,
} from '@/modules/products/product-catalog.response.dto';
import {
  EventDto, EventInviteeListDto, EventTypeDto, FeedbackSummaryDto, GuestEventDto, GuestEventListDto, RollCallDto,
} from '@/modules/events/event.response.dto';
import {
  CampaignDto, MetricDefinitionDto, QualificationRuleDto, StandingOverrideResultDto,
} from '@/modules/campaigns/campaign.response.dto';
import {
  CampaignCardDto, CampaignDetailDto, CampaignListDto, ChasingDto,
} from '@/modules/campaigns/campaign-agent.response.dto';
import { CapabilityCatalogDto } from '@/modules/capability/capability.response.dto';
import { BillingKpmRowDto, BillingPricesDto, QuoteSentDto } from '@/modules/billing/billing.response.dto';
import {
  AcceptedInviteDto, AddAgentResultDto, InviteBannerDto, InviteListDto, RequestedTransferDto, SharedInviteDto,
  TransferDto,
} from '@/modules/org/invites.response.dto';

/**
 * What one operation answers with: a class, and whether it comes back as an array — or, with no class, **only a file**
 * of the media types in `files` (P19.7-T3: the proposal's PDF, ADR-0222), which is documented as binary and nothing else.
 */
export interface ResponseShape {
  type?: Type<unknown>;
  isArray?: true;
  /**
   * **Another shape the same operation may answer** in place of `type`, told apart by a field only it carries: an
   * activation served empty past its first year (ADR-0233). Documented as `oneOf` the two.
   */
  or?: Type<unknown>;
  /**
   * Media types the operation may answer **as a file** instead, by a query parameter: the two templates' `format`
   * (ADR-0184). Documented beside the JSON body as binary.
   */
  files?: readonly string[];
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
import { UnitActivitiesDto } from '@/modules/unit-dashboard/unit-activities.response.dto';
import { UnitPotensiDto, UnitPotensiPersonDto } from '@/modules/unit-dashboard/unit-potensi.response.dto';
import { HomeDto } from '@/modules/home/home.response.dto';
import {
  AdoptionDto, KpmAnalyticsDto, KpmOverviewDto, NotLoggedDto, PlatformAnalyticsDto, RecruitTargetDto, ReviewedDto,
} from '@/modules/reporting/reporting.response.dto';
import { ComplianceViewDto } from '@/modules/reporting/compliance/compliance.response.dto';
import {
  CompanyKpmsDto, KpmComparisonPageDto, KpmDataDto, PlatformMembersPageDto,
} from '@/modules/reporting/platform/platform-reads.response.dto';
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
import { CoachingItemDoneResponseDto } from '@/modules/coaching/coaching-action-done.controller';
import {
  AgendaItemDto, AgendaItemSavedDto, LEADER_FORUM_SHARED_SHAPES, LeaderActionItemDto, MeetingCardDto, MeetingListViewDto,
  MeetingViewDto, MonthlyTargetSavedDto, ShareLinkDto, ShareLinksRevokedDto,
} from '@/modules/leader-meetings/leader-meetings.response.dto';

import { AnalyticsCodeCheckDto, AnalyticsOpenRunsDto } from '@/modules/config/analytics-template.response.dto';
import {
  CoachingSurveyDto, SurveyAnswerSavedDto, SurveyFormDto, SurveyListDto, SurveyPendingDto, SurveyResultsDto, SurveyRunDto,
  SurveySubmittedDto,
} from '@/modules/surveys/surveys.response.dto';

export const RESPONSE_SHAPES: Readonly<Record<string, ResponseShape>> = {
  // P6: what an agent did, day by day.
  ActivityController_readDay: { type: ActivityDayDto },
  ActivityController_saveDay: { type: ActivityDayDto },
  ActivityController_correctDay: { type: ActivityDayDto },
  ActivityController_summary: { type: ActivitySummaryDto },
  ActivityController_dashboard: { type: ActivityDashboardDto },
  ActivityController_ratios: { type: ActivityRatiosDto },
  SummaryController_read: { type: SummaryDto },
  // P19.3-T4 (ADR-0205 §1): a member's four tiles.
  MemberPerformanceController_read: { type: MemberPerformanceDto },
  // Phase 15: a leader's unit, and *Update production*.
  UnitDashboardController_read: { type: UnitDashboardDto },
  UnitDashboardController_updateProduction: { type: ProductionUpdatedDto },
  // UI V1 (Phase 18.11 T4, UI-001): the Activities tab's table.
  UnitActivitiesController_read: { type: UnitActivitiesDto },
  // P19.1-T6 (UI-155): the Potensi tab, and a person's sheet.
  UnitPotensiController_read: { type: UnitPotensiDto },
  UnitPotensiController_person: { type: UnitPotensiPersonDto },
  HomeController_read: { type: HomeDto },
  // Phase 18: the Owner's reporting — the Overview, its not-logged list and target, the analytics, the platform's.
  KpmOverviewController_read: { type: KpmOverviewDto },
  KpmOverviewController_notLogged: { type: NotLoggedDto },
  KpmOverviewController_setRecruitTarget: { type: RecruitTargetDto },
  // P19.3-T2 (UI-149): *Sudah sesuai* on a settings page, the setup card's reviewed flag.
  KpmSetupController_markReviewed: { type: ReviewedDto },
  KpmAnalyticsController_read: { type: KpmAnalyticsDto },
  PlatformAnalyticsController_read: { type: PlatformAnalyticsDto },
  // P18.3-T1: the Owner's compliance tree — the six chips, the catalog, the selection and the tree.
  ComplianceController_read: { type: ComplianceViewDto },
  // P19.4-T3 (ADR-0207 §2): the Super Admin's reads across KPMs.
  PlatformReadsController_members: { type: PlatformMembersPageDto },
  PlatformReadsController_comparison: { type: KpmComparisonPageDto },
  PlatformReadsController_analytics: { type: KpmAnalyticsDto },
  PlatformReadsController_compliance: { type: ComplianceViewDto },
  PlatformReadsController_data: { type: KpmDataDto },
  PlatformReadsController_companyKpms: { type: CompanyKpmsDto },
  // Phase 18.1: the Strategic Leader Forum — the meetings, their minutes, and their shared links.
  LeaderMeetingsController_list: { type: MeetingListViewDto },
  LeaderMeetingsController_create: { type: MeetingCardDto },
  LeaderMeetingsController_openShared: { type: MeetingViewDto },
  LeaderMeetingsController_read: { type: MeetingViewDto },
  LeaderMeetingsController_reschedule: { type: MeetingCardDto },
  // 204: nothing comes back; the entry is the table's placeholder, as `AuthController_logout`'s is.
  LeaderMeetingsController_remove: { type: StatusAckDto },
  LeaderMeetingsController_addAgendaItem: { type: AgendaItemDto },
  LeaderMeetingsController_saveAgendaItem: { type: AgendaItemSavedDto },
  LeaderMeetingsController_addActionItem: { type: LeaderActionItemDto },
  LeaderMeetingsController_reorderActionItems: { type: LeaderActionItemDto, isArray: true },
  LeaderMeetingsController_saveActionItem: { type: LeaderActionItemDto },
  LeaderMeetingsController_removeActionItem: { type: StatusAckDto },
  LeaderMeetingsController_saveMonthlyTarget: { type: MonthlyTargetSavedDto },
  LeaderMeetingsController_share: { type: ShareLinkDto },
  LeaderMeetingsController_stopSharing: { type: ShareLinksRevokedDto },
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
  // UI V1 (UI-104): a coachee's tick on an action item, from Calendar.
  CoachingActionDoneController_set: { type: CoachingItemDoneResponseDto },
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
  // ADR-0233: past the first year, the activation is answered empty.
  ActivationProgressController_mine: { type: ActivationViewDto, or: ActivationEmptyDto },
  ActivationProgressController_tick: { type: ActivationViewDto },
  ActivationProgressController_graduate: { type: ActivationViewDto },
  NewHiresController_roster: { type: NewHiresRosterDto },
  NewHiresController_detail: { type: NewHireDetailDto, or: ActivationEmptyDto },
  NewHiresController_tick: { type: ActivationViewDto },
  NewHiresController_correctStart: { type: ActivationViewDto },
  NewHiresController_saveNote: { type: ActivationNoteSavedDto },
  // P18.8-T4: the closings *Which case?* names — the hire's own, and a hire's for a leader.
  ActivationProgressController_closings: { type: ActivationClosingsDto },
  NewHiresController_closings: { type: ActivationClosingsDto },
  // P18.8-T6 AC-4: *Mark left*.
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
  // UI V1 (UI-111, ADR-0181): an email change asked for, and its link opened.
  AuthController_requestEmailChange: { type: StatusAckDto },
  AuthController_verifyEmailChange: { type: EmailChangedDto },
  AuthController_me: { type: MeDto },
  // UI-169 item 5 (ADR-0199): a linked login — the start, the link's page, the switch, and removing it (204).
  AccountLinksController_start: { type: StatusAckDto },
  AccountLinksController_confirm: { type: StatusAckDto },
  AccountLinksController_switchLogin: { type: AccessTokenDto },
  AccountLinksController_remove: { type: StatusAckDto },
  AuthController_updateMe: { type: MeDto },
  // UI V1 (UI-111): *Profil saya*'s read-only facts and its photo.
  ProfileController_facts: { type: ProfileFactsDto },
  ProfileController_requestAvatarUpload: { type: SignedUploadDto },
  ProfileController_attachAvatar: { type: AvatarDto },
  ProfileController_removeAvatar: { type: AvatarDto },

  OnboardingController_me: { type: JoinStateDto },
  OnboardingController_kpms: { type: KpmDirectoryEntryDto, isArray: true },
  OnboardingController_register: { type: JoinStateDto },
  // P19-T2 AC-2 (ADR-0191 §1): the request, and the company one is for.
  OnboardingController_myKpmRequest: { type: MyKpmRequestStateDto },
  OnboardingController_askForKpm: { type: KpmRequestRowDto },
  OnboardingController_leaders: { type: LeaderChoiceDto, isArray: true },
  OnboardingController_request: { type: JoinStateDto },
  OnboardingController_cancel: { type: JoinStateDto },
  OnboardingController_myLeaderCode: { type: MyLeaderCodeDto },
  OnboardingController_previewInvite: { type: InvitePreviewDto },
  OnboardingController_redeem: { type: RedeemedInviteDto },
  OnboardingController_inbox: { type: PendingRequestDto, isArray: true },
  OnboardingController_waitingCount: { type: WaitingRequestCountDto },
  OnboardingController_routing: { type: RoutingChoiceDto, isArray: true },
  OnboardingController_approve: { type: PendingRequestDto, isArray: true },
  OnboardingController_decline: { type: PendingRequestDto, isArray: true },
  OnboardingController_untagged: { type: UntaggedMemberDto, isArray: true },
  OnboardingController_tag: { type: UntaggedMemberDto, isArray: true },
  // P18.8-T3 (ADR-0170): + Add agent, its invites and transfers; an invite's link; the office's transfer requests.
  NewHireAgentsController_add: { type: AddAgentResultDto },
  NewHireAgentsController_list: { type: InviteListDto },
  NewHireAgentsController_resend: { type: SharedInviteDto },
  NewHireAgentsController_cancel: { type: InviteListDto },
  NewHireAgentsController_myTransfers: { type: RequestedTransferDto, isArray: true },
  InviteLinkController_banner: { type: InviteBannerDto },
  InviteLinkController_accept: { type: AcceptedInviteDto },
  TransferRequestsController_queue: { type: TransferDto, isArray: true },
  TransferRequestsController_approve: { type: TransferDto, isArray: true },
  TransferRequestsController_decline: { type: TransferDto, isArray: true },

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
  // P18.6-T2 (ADR-0163): an office's activity binding — the Owner's and Admin's read, the Super Admin's read and write.
  ActivityBindingReadController_read: { type: ActivityBindingDto },
  ActivityBindingAdminController_read: { type: OfficeActivityBindingDto },
  ActivityBindingAdminController_update: { type: OfficeActivityBindingDto },
  TenantConfigController_listLeadStatuses: { type: LeadPipelineDto, isArray: true },
  TenantConfigController_createLeadStatus: { type: LeadStatusDto },
  TenantConfigController_reorderLeadStatuses: { type: LeadPipelineDto },
  TenantConfigController_renameLeadStatus: { type: LeadStatusDto },
  TenantConfigController_setTerminal: { type: LeadPipelineDto },
  TenantConfigController_setLateStage: { type: LeadStatusDto },
  GoalController_read: { type: GoalResponseDto },
  GoalController_save: { type: GoalResponseDto },
  GoalController_saveEstimate: { type: GoalResponseDto },
  GoalController_saveMonthApe: { type: GoalMonthApeResponseDto },
  GoalController_preview: { type: GoalPreviewDto },
  ProductionController_readMonth: { type: MonthViewDto },
  // ADR-0184: `format=xlsx` answers the workbook itself.
  ProductionController_template: { type: TemplateFileDto, files: [XLSX_MIME_TYPE] },
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
  LeadController_reorder: { type: LeadOrderDto },
  LeadController_update: { type: LeadResponseDto },
  LeadController_setStatus: { type: LeadResponseDto },
  LeadController_setOutcome: { type: LeadResponseDto },
  // UI V1 (UI-104): the owner's tick on a next action, from Calendar.
  LeadController_setNextActionDone: { type: LeadResponseDto },
  LeadController_remove: { type: DeletedLeadDto },
  TenantConfigController_archiveLeadStatus: { type: LeadStatusDto },
  TenantConfigController_restoreLeadStatus: { type: LeadStatusDto },
  AdminController_readTemplate: { type: CompanyTemplateDto },
  AdminController_templateHistory: { type: CompanyTemplateDto, isArray: true },
  AdminController_saveTemplateDraft: { type: CompanyTemplateDto },
  AdminController_publishTemplate: { type: CompanyTemplateDto },
  // P19.5-T1 (ADR-0214 §1, §7): the *Advanced analytics* editor's code check and open runs.
  AnalyticsTemplateController_codeCheck: { type: AnalyticsCodeCheckDto },
  AnalyticsTemplateController_openRuns: { type: AnalyticsOpenRunsDto },
  // P19.5-T4 (ADR-0216): a member's surveys, the KPM's runs and results, and the coaching *Survei* tab.
  SurveysController_pending: { type: SurveyPendingDto },
  SurveysController_list: { type: SurveyListDto },
  SurveysController_form: { type: SurveyFormDto },
  SurveysController_answer: { type: SurveyAnswerSavedDto },
  SurveysController_submit: { type: SurveySubmittedDto },
  // 204: nothing comes back; the entry is the table's placeholder.
  SurveysController_popupShown: { type: StatusAckDto },
  SurveyRunsController_nps: { type: SurveyResultsDto },
  SurveyRunsController_qual: { type: SurveyResultsDto },
  SurveyRunsController_create: { type: SurveyRunDto },
  SurveyRunsController_update: { type: SurveyRunDto },
  SurveyRunsController_cancel: { type: StatusAckDto },
  CoachingSurveyController_read: { type: CoachingSurveyDto },
  // P19.5-T3 (ADR-0215): the KPM's *Advanced analytics* page, and the Super Admin's tab on it.
  AdvancedAnalyticsController_shell: { type: AdvancedAnalyticsShellDto },
  AdvancedAnalyticsController_demographics: { type: DemographicsDto },
  AdvancedAnalyticsController_mapa: { type: MapaDto },
  AdvancedAnalyticsController_quant: { type: QuantDto },
  AdvancedAnalyticsController_subgroup: { type: SubgroupDto },
  AdvancedAnalyticsController_events: { type: EventsNpsDto },
  AdvancedAnalyticsController_setMapaTarget: { type: MapaTargetDto },
  AdvancedAnalyticsController_setSubgroupTarget: { type: SubgroupTargetDto },
  AdminAdvancedAnalyticsController_shell: { type: AdvancedAnalyticsShellDto },
  AdminAdvancedAnalyticsController_section: { type: AdminAdvancedAnalyticsSectionDto },
  // P19.7-T2 (ADR-0221): the simple proposal. P19.7-T3 (ADR-0222): its PDF, a file and nothing else.
  ProposalController_pdf: { files: ['application/pdf'] },
  // P19.6-T5 (ADR-0219 §4): the Super Admin's guide, its HTML and its PDF — files and nothing else.
  PlatformGuideController_html: { files: ['text/html'] },
  PlatformGuideController_pdf: { files: ['application/pdf'] },
  // P19.6-T1 (ADR-0218 §14): *Tampilan KPM*, the template's images, the public sign-in read and the files.
  BrandingSettingsController_read: { type: BrandingSettingsDto },
  BrandingSettingsController_save: { type: BrandingSettingsDto },
  BrandingSettingsController_preview: { type: BrandingPreviewAnswerDto },
  BrandingSettingsController_reset: { type: BrandingSettingsDto },
  BrandingSettingsController_upload: { type: SignedUploadDto },
  BrandingSettingsController_confirm: { type: ConfirmedBrandingImageDto },
  TemplateBrandingController_upload: { type: SignedUploadDto },
  TemplateBrandingController_confirm: { type: ConfirmedBrandingImageDto },
  TemplateBrandingController_preview: { type: BrandingPreviewAnswerDto },
  PublicBrandingController_read: { type: PublicBrandingDto },
  PublicBrandingController_file: { files: ['image/png', 'image/webp'] },
  ProposalController_list: { type: ProposalPageDto },
  ProposalController_catalog: { type: ProposalCatalogDto },
  ProposalController_read: { type: ProposalResponseDto },
  ProposalController_create: { type: ProposalResponseDto },
  ProposalController_update: { type: ProposalPatchedDto },
  ProposalController_addItem: { type: ProposalResponseDto },
  ProposalController_updateItem: { type: ProposalResponseDto },
  ProposalController_removeItem: { type: ProposalResponseDto },
  ProposalController_done: { type: ProposalResponseDto },
  ProposalController_duplicate: { type: ProposalDuplicatedDto },
  // 204: a soft delete answers nothing; the entry is the table's placeholder.
  ProposalController_remove: { type: StatusAckDto },
  // P13.2-T6: a company's named templates (ADR-0115).
  NamedTemplateController_list: { type: NamedTemplateDto, isArray: true },
  NamedTemplateController_create: { type: NamedTemplateDto },
  NamedTemplateController_update: { type: NamedTemplateDto },
  NamedTemplateController_archive: { type: NamedTemplateDto },
  // ADR-0185: *Terbitkan semua*, and the offices behind the checklist's count.
  NamedTemplateController_publishAll: { type: PublishAllDto },
  NamedTemplateController_offices: { type: TemplateOfficeStandingDto, isArray: true },
  // ADR-0208: the push to the offices made from a template, and its Training section's material.
  NamedTemplateController_apply: { type: ApplyTemplateResultDto },
  NamedTemplateController_requestMaterialUpload: { type: SignedUploadDto },
  NamedTemplateController_confirmMaterialUpload: { type: ConfirmedUploadDto },
  NamedTemplateController_materialFileUrl: { type: SignedUrlDto },
  NamedTemplateController_saveModuleMaterial: { type: CompanyTemplateDto },
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
  // ADR-0220 §4: *Sinkron dari template* — what the KPM's names would take from its template, and taking them.
  TemplateSyncController_read: { type: TemplateSyncViewDto },
  TemplateSyncController_apply: { type: TemplateSyncResultDto },
  // P18.2-T1, T4: the learner's training — the offered catalog with a member's statuses, a module, an open, a status.
  TrainingProgressController_read: { type: TrainingProgressDto },
  TrainingProgressController_module: { type: TrainingModulePageDto },
  TrainingProgressController_open: { type: TrainingOpenDto },
  TrainingProgressController_setStatus: { type: TrainingModulePageDto },
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
  // 204 (P19.4-T4, ADR-0209 §10): a soft delete answers nothing; the entry is the table's placeholder.
  ProductController_remove: { type: StatusAckDto },

  // What an office decides about its company's products (P5-T5).
  KpmProductController_list: { type: KpmProductDto, isArray: true },
  KpmProductController_setActive: { type: KpmProductDto },
  KpmProductController_saveOverrides: { type: KpmProductDto },
  KpmProductController_resetOverride: { type: KpmProductDto },
  KpmProductController_setDocument: { type: KpmProductDto },
  KpmProductController_resetDocument: { type: KpmProductDto },
  KpmProductController_documentUrl: { type: ProductSignedUrlDto },
  // P17-T9: the signed upload an office's own product document is attached from.
  KpmProductController_requestUpload: { type: SignedUploadDto },
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

  // Phase 17: recruitment tools — the agents' plan and pitch, the office's pitch settings, the company's playbook.
  RecruitmentController_attackPlan: { type: RecruitmentAttackPlanDto },
  RecruitmentController_pitchMaterials: { type: PitchMaterialsDto },
  RecruitmentController_pitchDocumentUrl: { type: PitchDocumentUrlDto },
  RecruitmentPitchController_requestUpload: { type: SignedUploadDto },
  RecruitmentPitchController_attach: { type: PitchSlotDto },
  RecruitmentPitchController_setConfirmation: { type: PitchSlotDto },

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
  // P18.2-T5, T6: the roll call, the picker's people and the Feedback Summary, the office's administration's.
  EventController_invitees: { type: EventInviteeListDto },
  EventController_rollCall: { type: RollCallDto },
  EventController_saveRollCall: { type: RollCallDto },
  EventController_feedbackSummary: { type: FeedbackSummaryDto },
  // P18.2-T5, T6: the agent's *KPM Events* — the list, the modal, RSVP, the claim and the answer.
  EventGuestController_list: { type: GuestEventListDto },
  EventGuestController_read: { type: GuestEventDto },
  EventGuestController_rsvp: { type: GuestEventDto },
  EventGuestController_cancelRsvp: { type: GuestEventDto },
  // UI V1 (Phase 18.11 T13, UI-108): *Tidak ikut* after *Ikut*, the RSVP back to none.
  EventGuestController_withdrawRsvp: { type: GuestEventDto },
  EventGuestController_claim: { type: GuestEventDto },
  EventGuestController_submitFeedback: { type: GuestEventDto },

  // Campaigns, and the carrier rules an office is measured against (P5-T7).
  MetricRegistryController_list: { type: MetricDefinitionDto, isArray: true },
  CampaignController_listRules: { type: QualificationRuleDto, isArray: true },
  CampaignController_list: { type: CampaignDto, isArray: true },
  CampaignController_create: { type: CampaignDto },
  CampaignController_update: { type: CampaignDto },
  CampaignController_archive: { type: CampaignDto },
  CampaignController_restore: { type: CampaignDto },
  // P18.3-T2: the override of a final standing, set and cleared.
  CampaignController_override: { type: StandingOverrideResultDto },
  CampaignController_clearOverride: { type: StandingOverrideResultDto },
  // Phase 18.2: the agent's campaigns — the list, one campaign with its progress, the chase, and whose chases.
  CampaignAgentController_list: { type: CampaignListDto },
  CampaignAgentController_chasing: { type: ChasingDto },
  CampaignAgentController_detail: { type: CampaignDetailDto },
  CampaignAgentController_chase: { type: CampaignCardDto },
  CampaignAgentController_unchase: { type: CampaignCardDto },

  // The office's capability catalog (P5-T8). No delete route, by design.
  CapabilityController_read: { type: CapabilityCatalogDto },
  CapabilityController_rename: { type: CapabilityCatalogDto },
  CapabilityController_setStatus: { type: CapabilityCatalogDto },
  CapabilityController_add: { type: CapabilityCatalogDto },
  CapabilityController_reorder: { type: CapabilityCatalogDto },
  OrgController_myTeam: { type: TeamMemberDto, isArray: true },
  // UI V1 (2026-10-30): *Search agent* (UI-012, D-14), and a leader saving an agent's WhatsApp number (UI-081, D-22).
  OrgController_search: { type: MemberSearchResultDto },
  MemberPhoneController_set: { type: MemberPhoneDto },
  OrgController_changeRole: { type: TeamMemberDto, isArray: true },
  OrgController_remove: { type: TeamMemberDto, isArray: true },
  OrgController_roleLog: { type: RoleChangeEntryDto, isArray: true },
  // ADR-0157: a leader past the office's limit, asked about and decided.
  OrgController_leaderLimitRequests: { type: LeaderLimitRequestRowDto, isArray: true },
  OrgController_cancelLeaderLimitRequest: { type: LeaderLimitRequestRowDto, isArray: true },
  OrgController_requestPastLeaderLimit: { type: LeaderLimitRequestRowDto },
  LeaderLimitRequestAdminController_queue: { type: LeaderLimitRequestRowDto, isArray: true },
  LeaderLimitRequestAdminController_approve: { type: LeaderLimitRequestRowDto, isArray: true },
  LeaderLimitRequestAdminController_decline: { type: LeaderLimitRequestRowDto, isArray: true },
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
  OrgController_setCoreLeader: { type: MemberTagsDto },
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
  // P19-T3 (ADR-0191): removing a request, the owner picker, the code check, moving and deleting an office.
  AdminController_deleteKpmRequest: { type: KpmRequestRowDto, isArray: true },
  AdminController_searchAccounts: { type: AccountChoiceDto, isArray: true },
  AdminController_codeAvailability: { type: CodeAvailabilityDto },
  AdminController_moveCompany: { type: KpmAdminViewDto },
  AdminController_tenantContents: { type: KpmContentsDto },
  AdminController_deleteTenant: { type: KpmDeletedDto },
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
  AdminController_deleteOrgLevel: { type: OrgLevelRowDto, isArray: true },
  // P13.2-T3: the Super Admin's rows carry the subscription, Leaders used and the ended state.
  AdminController_listTenants: { type: KpmListRowDto, isArray: true },
  AdminController_createTenant: { type: KpmCreatedDto },
  AdminController_readTenant: { type: KpmProfileDto },
  AdminController_assignOwner: { type: KpmAdminViewDto },
  AdminController_resendOwnerInvitation: { type: KpmAdminViewDto },
  AdminController_setStatus: { type: KpmAdminViewDto },
  AdminController_updateSubscription: { type: KpmAdminViewDto },
  // ADR-0184: `format=csv` and `format=xlsx` answer the file itself.
  AdminController_rosterTemplate: { type: RosterTemplateDto, files: ['text/csv', XLSX_MIME_TYPE] },
  AdminController_previewRoster: { type: RosterPreviewDto },
  AdminController_importRoster: { type: RosterCommitDto },
  // ADR-0184: the roster as a file, a workbook or a CSV — the same answers as the paste's.
  AdminController_previewRosterFile: { type: RosterPreviewDto },
  AdminController_importRosterFile: { type: RosterCommitDto },
  AdminController_readAudit: { type: AuditPageDto },
  AdminController_impersonate: { type: ImpersonationSessionDto },
  AdminController_endImpersonation: { type: StatusAckDto },
  // P13.2-T2: the quote tool's price table, the Super Admin's alone (ADR-0111).
  BillingController_prices: { type: BillingPricesDto },
  // P19.4-T3 (ADR-0211 §3, §5): the list of KPMs, and a quote sent to one KPM's Owner.
  KpmBillingController_list: { type: BillingKpmRowDto, isArray: true },
  KpmBillingController_sendQuote: { type: QuoteSentDto },
};

/**
 * Shapes no operation names whole but a client pairs by name: the adoption every row of *Cross-platform analytics*
 * extends (Phase 18), so the frontend's contract spec can pair its `Adoption` with one schema.
 */
const SHARED_SHAPES: Type<unknown>[] = [
  AdoptionDto,
  // Phase 18.1: a scorecard cell, which a row's `cells` names by reference rather than nesting a class.
  ...LEADER_FORUM_SHARED_SHAPES,
];

/** Every class the table names, so Swagger emits a schema for each. */
export const RESPONSE_MODELS: Type<unknown>[] = [
  ...new Set([
    ...Object.values(RESPONSE_SHAPES).flatMap((s) => [...(s.type ? [s.type] : []), ...(s.or ? [s.or] : [])]),
    ...SHARED_SHAPES,
  ]),
];
