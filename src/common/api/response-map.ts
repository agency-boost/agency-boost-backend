import { AvatarDto, ProfileFactsDto } from '@/modules/users/profile.dto';
import { SummaryDto } from '@/modules/summary/summary.response.dto';
import { MemberPerformanceDto } from '@/modules/summary/member-performance.response.dto';
import { Type } from '@nestjs/common';
import {
  BoxPreviewDto, IllustrationListDto, IllustrationViewDto, IntakeDetailDto, IntakeFileLinkDto, IntakeItemViewDto,
  IntakeListDto, IntakeViewDto,
} from '@/modules/product-data/intake.response.dto';
import {
  AdminAdvancedAnalyticsSectionDto, AdvancedAnalyticsShellDto, DemographicsDto, DemographicsFileDto,
  DemographicsUploadDto as DemographicsUploadResultDto, EventsNpsDto, MapaDto, QuantDto, SubgroupDto, SubgroupSheetDto,
} from '@/modules/reporting/advanced-analytics/advanced-analytics.response.dto';
import { EventFeedbackDto, KehadiranDto } from '@/modules/events/event-analytics.dto';
import { XLSX_MIME_TYPE } from '@/domain/constants';
import {
  BrandingPreviewAnswerDto, BrandingSettingsDto, ConfirmedBrandingImageDto, PublicBrandingDto,
} from '@/modules/branding/branding.response.dto';
import {
  AccessTokenDto, EmailChangedDto, ImpersonationSessionDto, ImpersonationWindowDto, MeDto, ReadinessDto,
  RedeemedInviteDto, RegisterAnswerDto, SessionDto, StatusAckDto,
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
  DelegatedAdminDto, DirectoryMemberDto, DirectoryPageDto, InvitePreviewDto,
  JoinStateDto, KpmDirectoryEntryDto, LeaderChoiceDto, LeaderLimitRequestRowDto, MemberTagsDto,
  MyLeaderCodeDto, OrgTreeDto, PendingRequestDto, RoleChangeEntryDto, RoutingChoiceDto, TeamMemberDto,
  UntaggedMemberDto, MemberPhoneDto, MemberSearchResultDto, WaitingRequestCountDto,
} from '@/modules/org/org.response.dto';
import { CancelledTransferDto, LeaderMoveChoiceDto, PendingMoveDto } from '@/modules/org/leader-change.response.dto';
import { InformalGroupCreatedDto, InformalGroupsViewDto } from '@/modules/org/informal-groups.dto';
import { AbGroupTargetsViewDto } from '@/modules/reporting/ab-group-targets/ab-group-targets.dto';
import { MemberPersonalCompletedDto } from '@/modules/org/member-personal.dto';
import { KpmStewardsDto, PeopleHistoryEntryDto, RosterImportViewDto } from '@/modules/org/people.response.dto';
import { KpmOwnerListDto } from '@/modules/tenants/kpm-owners.response.dto';
import {
  CodeAvailabilityDto, KpmAdminViewDto, KpmListRowDto, KpmProfileDto, KpmContentsDto, KpmCreatedDto, KpmDeletedDto, KpmRequestRowDto, KpmViewDto,
  MyKpmRequestStateDto, OrgLevelRowDto, PlatformAdminRowDto, PlatformOverviewDto, RosterCommitDto, RosterPreviewDto,
  RosterTemplateDto,
} from '@/modules/tenants/tenant.response.dto';
import { CompanyResponseDto, PublicCompanyDto, SetUpCompanyResultDto } from '@/modules/tenants/platform.response.dto';
import { GroupMembersAddedDto } from '@/modules/org/group-members.dto';
import { AuditPageDto } from '@/modules/audit/audit.response.dto';
// P19.23-T6 (ADR-0279): the console's *Platform* sections.
import { SuperAdminRowDto } from '@/modules/platform-team/platform-team.response.dto';
import { WaitingPageDto } from '@/modules/reporting/platform/anggota-waiting.controller';
import { PlatformSettingsDto } from '@/modules/platform-settings/platform-settings.response.dto';
import { AnnouncementDto, AnnouncementPreviewDto } from '@/modules/announcements/announcements.response.dto';
import {
  ActivityCategoryDto, ActivityTypeDto, LeadPipelineDto, LeadStatusDto, RatioDefinitionDto,
  ActivityBindingDto, CompanyTemplateDto, NamedTemplateDto, OfficeActivityBindingDto, PublishAllDto, PublishStateDto,
  SavedOfficeTemplateDto, TemplateOfficeStandingDto, TenantConfigDto,
  ApplyTemplateResultDto, ConfirmedUploadDto,
} from '@/modules/config/config.response.dto';
import { SettingsOverviewDto } from '@/modules/config/settings-overview.response.dto';
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
import { ProductDraftDto, ProductResponseDto } from '@/modules/products/product.response.dto';
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
  CampaignDto, MetricDefinitionDto, StandingOverrideResultDto,
} from '@/modules/campaigns/campaign.response.dto';
import {
  CampaignCardDto, CampaignDetailDto, CampaignListDto, ChasingDto,
} from '@/modules/campaigns/campaign-agent.response.dto';
import { CapabilityCatalogDto } from '@/modules/capability/capability.response.dto';
import { BillingKpmListDto, BillingKpmRowDto, BillingPricesDto } from '@/modules/billing/billing.response.dto';
import {
  AcceptedInviteDto, AddAgentResultDto, InviteBannerDto, InviteListDto, RequestedTransferDto, SharedInviteDto,
  TransferDto,
} from '@/modules/org/invites.response.dto';
import {
  OwnerInviteAcceptedDto, OwnerInviteBannerDto, OwnerWhatsAppInvitationDto,
} from '@/modules/tenants/owner-invites.response.dto';
import {
  AddUserOptionsDto, UserInvitationCancelledDto, UserInvitationResentDto, UserInviteAcceptedDto, UserInviteBannerDto,
  UserInvitedDto, UserPlacedDto,
} from '@/modules/tenants/add-user.response.dto';

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
  KpmOverviewDto, OverviewPerformanceDto, ReviewedDto,
} from '@/modules/reporting/reporting.response.dto';
import { ComplianceViewDto } from '@/modules/reporting/compliance/compliance.response.dto';
import {
  CompanyKpmsDto, PlatformAccountsPageDto, PlatformMemberDetailDto, PlatformMembersPageDto, TestAccountSetDto,
} from '@/modules/reporting/platform/platform-reads.response.dto';
import { ConsoleDashboardDto, ConsoleKpmPeopleDto } from '@/modules/reporting/platform/platform-console.response.dto';
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
  AgendaItemDto, AgendaItemSavedDto, LeaderActionItemDto, MeetingCardDto, MeetingListViewDto, MeetingViewDto, ShareLinkDto,
} from '@/modules/leader-meetings/leader-meetings.response.dto';

import { AnalyticsCodeCheckDto, AnalyticsOpenRunsDto } from '@/modules/config/analytics-template.response.dto';
import {
  CoachingSurveyDto, SurveyAnswerSavedDto, SurveyFormDto, SurveyListDto, SurveyPendingDto, SurveyResultsDto, SurveyRunDto,
  SurveySubmittedDto, SurveyPeopleDto, SurveyPersonAnswersDto,
} from '@/modules/surveys/surveys.response.dto';
import {
  CompanyPublicationDto, PublicationSummaryDto, PublishToKpmsResultDto,
} from '@/modules/config/company-publication.response.dto';

import {
  ProductDataChangesPageDto, ProductDataGrantRevokedDto, ProductDataGrantRowDto, ReadableCompaniesDto,
} from '@/modules/product-data/product-data-grant.response.dto';
import {
  ProductDataDetailDto, ProductDataOverviewDto, ProductTryDto, RateTableViewDto,
} from '@/modules/product-data/product-data.response.dto';
import { KpmReportLinkViewDto } from '@/modules/kpm-report/kpm-report.response.dto';

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
  // Phase 18: the Owner's reporting — since P19.19 (ADR-0272) the Overview's second version and its *Performa vs target*;
  // the first version's not-logged list and recruitment target, and KPM analytics, are gone.
  KpmOverviewController_read: { type: KpmOverviewDto },
  KpmOverviewController_performance: { type: OverviewPerformanceDto },
  // P19.3-T2 (UI-149): *Sudah sesuai* on a settings page, the setup card's reviewed flag.
  KpmSetupController_markReviewed: { type: ReviewedDto },
  // P18.3-T1, since P19.19-T3 the KPM Overview's: the seven compliance cards, the pickers and the card opened.
  ComplianceController_read: { type: ComplianceViewDto },
  // P19.4-T3 (ADR-0207 §2): the Super Admin's reads across KPMs.
  PlatformReadsController_members: { type: PlatformMembersPageDto },
  // P19.23-T3 (ADR-0277): *Anggota*'s detail and its *Akun tes* switch.
  PlatformPeopleController_detail: { type: PlatformMemberDetailDto },
  PlatformPeopleController_setTestAccount: { type: TestAccountSetDto },
  // P19.23-T1, T2 (ADR-0277): the console's Dashboard and a KPM page's people.
  PlatformConsoleController_dashboard: { type: ConsoleDashboardDto },
  PlatformConsoleController_people: { type: ConsoleKpmPeopleDto },
  // P19.12-T2 (ADR-0245 §1): *Akun terdaftar*.
  PlatformReadsController_accounts: { type: PlatformAccountsPageDto },
  PlatformReadsController_companyKpms: { type: CompanyKpmsDto },
  // ADR-0286 §5: *Anggota* › *Menunggu* — invited and unplaced, across KPMs.
  AnggotaWaitingController_list: { type: WaitingPageDto },
  // Phase 18.1, P19.22-T8: the Strategic Leader Forum — the forums, their agenda and action items, and their links.
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
  LeaderMeetingsController_saveActionItem: { type: LeaderActionItemDto },
  LeaderMeetingsController_removeActionItem: { type: StatusAckDto },
  LeaderMeetingsController_share: { type: ShareLinkDto },
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

  // P19.12-T2 (ADR-0245 §3): an account made is signed in.
  AuthController_register: { type: RegisterAnswerDto },
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
  // P19.23-T2 AC-3 (OD-420): the KPM Owner invited by WhatsApp, the claim link's banner and its accept.
  OwnerWhatsAppInvitationController_invite: { type: OwnerWhatsAppInvitationDto },
  // P19.27 (ADR-0285): *Jadikan owner* · *Hapus sebagai owner*, each answering *KPM Owner · n*.
  KpmOwnersController_add: { type: KpmOwnerListDto },
  KpmOwnersController_remove: { type: KpmOwnerListDto },
  OwnerInvitesController_banner: { type: OwnerInviteBannerDto },
  OwnerInvitesController_accept: { type: OwnerInviteAcceptedDto },
  // P19.28 (ADR-0286): *Tambah user*, its choices, *Kirim ulang* and *Batalkan*; *Masukkan*; the invitation link.
  AddUserController_options: { type: AddUserOptionsDto },
  AddUserController_add: { type: UserInvitedDto },
  AddUserController_resend: { type: UserInvitationResentDto },
  AddUserController_cancel: { type: UserInvitationCancelledDto },
  PlacementController_place: { type: UserPlacedDto },
  UserInviteLinkController_banner: { type: UserInviteBannerDto },
  UserInviteLinkController_accept: { type: UserInviteAcceptedDto },

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
  // *Kembalikan ke angka dari file* (ADR-0274): the cell put back, answered as a correction is.
  ProductionController_restore: { type: CorrectionResultDto },
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
  // *Terbitkan ke KPM* (ADR-0278 §5–§7): the changes and the KPMs — or, with `?summary=true`, the card's line — and the
  // publish's outcomes.
  CompanyPublicationController_read: { type: CompanyPublicationDto, or: PublicationSummaryDto },
  CompanyPublicationController_publish: { type: PublishToKpmsResultDto },
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
  // *Analisa kualitatif › Per orang* (ADR-0276 §5): a run's invitees, and one person's answers.
  SurveyRunsController_qualPeople: { type: SurveyPeopleDto },
  SurveyRunsController_qualPerson: { type: SurveyPersonAnswersDto },
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
  EventAnalyticsController_attendance: { type: KehadiranDto },
  EventAnalyticsController_feedback: { type: EventFeedbackDto },
  // P19.22 (ADR-0275): *Demografi*'s list and upload, and *Informal group*'s sheets; the typed MAPA target is gone.
  AdvancedAnalyticsController_demographicsFile: { type: DemographicsFileDto },
  AdvancedAnalyticsController_uploadDemographics: { type: DemographicsUploadResultDto },
  AdvancedAnalyticsController_subgroupPeople: { type: SubgroupSheetDto },
  AdminAdvancedAnalyticsController_shell: { type: AdvancedAnalyticsShellDto },
  AdminAdvancedAnalyticsController_section: { type: AdminAdvancedAnalyticsSectionDto },
  // P19.7-T2 (ADR-0221): the simple proposal. P19.7-T3 (ADR-0222): its PDF, a file and nothing else.
  ProposalController_pdf: { files: ['application/pdf'] },
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
  // P19.21-T2 (ADR-0274 §6): the Pengaturan hub.
  SettingsOverviewController_read: { type: SettingsOverviewDto },
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
  // A product's draft and release (ADR-0278 §4): a new product is the product; every draft route answers its draft view.
  ProductDraftController_list: { type: ProductDraftDto, isArray: true },
  ProductDraftController_create: { type: ProductResponseDto },
  ProductDraftController_save: { type: ProductDraftDto },
  ProductDraftController_discard: { type: ProductDraftDto },

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
  RecruitmentPitchController_setLink: { type: PitchSlotDto },

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
  // `CampaignController_listRules` retired with the *Production club tiers* tab (P19.25-T5, ADR-0282 §6).
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
  // ADR-0273 §3 (amending ADR-0248 §3): the member sheet changes any field of a member's details.
  MemberPersonalController_complete: { type: MemberPersonalCompletedDto },
  // P19.20 (ADR-0273): People's Riwayat, KPM admins' tiles, Pilih leader, Riwayat unggah.
  PeopleController_history: { type: PeopleHistoryEntryDto, isArray: true },
  PeopleController_stewards: { type: KpmStewardsDto },
  PeopleController_imports: { type: RosterImportViewDto, isArray: true },
  PeopleController_place: { type: DirectoryMemberDto },
  OrgController_changeRole: { type: TeamMemberDto, isArray: true },
  // ADR-0247: changing who somebody reports to.
  LeaderChangeController_choices: { type: LeaderMoveChoiceDto, isArray: true },
  LeaderChangeController_move: { type: DirectoryMemberDto },
  LeaderChangeController_requestMove: { type: PendingMoveDto },
  LeaderChangeController_cancel: { type: CancelledTransferDto },
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
  // P19.17-T4 (ADR-0270): informal groups on ABs — the groups, Group baru, Ubah nama, Hapus group, an AB's group, the
  // Group Leaders. Every write answers the groups as they now stand.
  OrgController_listGroups: { type: InformalGroupsViewDto },
  OrgController_createGroup: { type: InformalGroupCreatedDto },
  OrgController_updateGroup: { type: InformalGroupsViewDto },
  OrgController_archiveGroup: { type: InformalGroupsViewDto },
  OrgController_setAbGroup: { type: InformalGroupsViewDto },
  OrgController_appointGroupLeader: { type: InformalGroupsViewDto },
  OrgController_removeGroupLeader: { type: InformalGroupsViewDto },
  // P19.17-T4 (ADR-0270 §4): the monthly targets per AB group — the month, and a save answering it.
  AbGroupTargetsController_read: { type: AbGroupTargetsViewDto },
  AbGroupTargetsController_set: { type: AbGroupTargetsViewDto },
  // P19.12-T6 (ADR-0249 §4): *+ Tambah ke grup*.
  OrgController_addGroupMembers: { type: GroupMembersAddedDto },
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
  // P19.15-T4 (ADR-0260): *Kelola data produk*, *Perubahan oleh pengelola*, and *Data produk*'s companies.
  ProductDataGrantController_list: { type: ProductDataGrantRowDto, isArray: true },
  ProductDataGrantController_changes: { type: ProductDataChangesPageDto },
  ProductDataGrantController_set: { type: ProductDataGrantRowDto },
  ProductDataGrantController_revoke: { type: ProductDataGrantRevokedDto },
  ProductDataCompaniesController_readable: { type: ReadableCompaniesDto },
  // P19.15-T2, T3 (ADR-0259): *Unggah file* and *Ilustrasi*.
  // P19.15-T1, T4 AC-1 (ADR-0258): the Proposal tab — the overview, a product, Isian, the premium tables, Uji coba.
  ProductDataController_overview: { type: ProductDataOverviewDto },
  ProductDataController_detail: { type: ProductDataDetailDto },
  ProductDataController_saveRules: { type: ProductDataDetailDto },
  ProductDataController_template: { files: [XLSX_MIME_TYPE, 'text/csv'] },
  ProductDataController_upload: { type: RateTableViewDto },
  ProductDataController_tryIt: { type: ProductTryDto },
  ProductDataController_readTable: { type: RateTableViewDto },
  ProductDataController_updateTable: { type: RateTableViewDto },
  ProductDataController_tests: { type: RateTableViewDto },
  ProductDataController_activate: { type: RateTableViewDto },
  ProductDataController_turnOff: { type: RateTableViewDto },
  ProductDataController_remove: { type: StatusAckDto },
  IntakeController_listAll: { type: IntakeListDto },
  IntakeController_uploadAny: { type: IntakeViewDto },
  IntakeController_list: { type: IntakeListDto },
  IntakeController_upload: { type: IntakeViewDto },
  IntakeController_read: { type: IntakeDetailDto },
  IntakeController_file: { type: IntakeFileLinkDto },
  IntakeController_answer: { type: IntakeItemViewDto },
  IntakeController_confirm: { type: IntakeItemViewDto },
  IntakeController_reject: { type: IntakeItemViewDto },
  IllustrationController_list: { type: IllustrationListDto },
  IllustrationController_upload: { type: IllustrationViewDto },
  IllustrationController_read: { type: IllustrationViewDto },
  IllustrationController_update: { type: IllustrationViewDto },
  IllustrationController_preview: { type: BoxPreviewDto },
  IllustrationController_previewPdf: { files: ['application/pdf'] },
  IllustrationController_file: { type: IntakeFileLinkDto },
  IllustrationController_publish: { type: IllustrationViewDto },
  AdminController_kpmRequests: { type: KpmRequestRowDto, isArray: true },
  AdminController_approveKpmRequest: { type: KpmRequestRowDto, isArray: true },
  AdminController_declineKpmRequest: { type: KpmRequestRowDto, isArray: true },
  // P19-T3 (ADR-0191): removing a request, the owner picker, the code check, moving and deleting an office.
  AdminController_deleteKpmRequest: { type: KpmRequestRowDto, isArray: true },
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
  // *Perusahaan baru* (ADR-0278 §3): the company, with the default template it was given.
  CompanySetupController_create: { type: SetUpCompanyResultDto },
  AdminController_listOrgLevels: { type: OrgLevelRowDto, isArray: true },
  AdminController_createOrgLevel: { type: OrgLevelRowDto, isArray: true },
  AdminController_updateOrgLevel: { type: OrgLevelRowDto, isArray: true },
  AdminController_deleteOrgLevel: { type: OrgLevelRowDto, isArray: true },
  // P13.2-T3: the Super Admin's rows carry the subscription, Leaders used and the ended state.
  AdminController_listTenants: { type: KpmListRowDto, isArray: true },
  AdminController_createTenant: { type: KpmCreatedDto },
  AdminController_readTenant: { type: KpmProfileDto },
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
  // P19.23-T6 (ADR-0279): *Tim Super Admin*, *Pengaturan platform* and *Pengumuman*; each team write answers the team.
  PlatformTeamController_list: { type: SuperAdminRowDto, isArray: true },
  PlatformTeamController_add: { type: SuperAdminRowDto, isArray: true },
  PlatformTeamController_revoke: { type: SuperAdminRowDto, isArray: true },
  PlatformSettingsController_read: { type: PlatformSettingsDto },
  PlatformSettingsController_update: { type: PlatformSettingsDto },
  AnnouncementsController_list: { type: AnnouncementDto, isArray: true },
  AnnouncementsController_preview: { type: AnnouncementPreviewDto },
  AnnouncementsController_send: { type: AnnouncementDto },
  // `handoff: true` answers a code for the new window in place of a token (ADR-0277); the window redeems it for one.
  AdminController_impersonate: { type: ImpersonationSessionDto, or: ImpersonationWindowDto },
  AdminController_redeemImpersonationHandoff: { type: ImpersonationSessionDto },
  AdminController_endImpersonation: { type: StatusAckDto },
  // P13.2-T2: the quote tool's price table, the Super Admin's alone (ADR-0111).
  BillingController_prices: { type: BillingPricesDto },
  // P19.23-T5 (ADR-0279 §3, §6, §7): Langganan per KPM, Konfirmasi paket, and the offer's PDF.
  KpmBillingController_list: { type: BillingKpmListDto },
  KpmBillingController_confirmPackage: { type: BillingKpmRowDto },
  KpmBillingController_offerPdf: { files: ['application/pdf'] },
  // P19.24 (ADR-0280): *Laporan KPM* — the PDF, *Kirim ke owner*'s link, and the link opened.
  AdminKpmReportController_pdf: { files: ['application/pdf'] },
  AdminKpmReportController_link: { type: KpmReportLinkViewDto },
  KpmReportLinkController_open: { files: ['application/pdf'] },
};

/**
 * Shapes no operation names whole but a client pairs by name. *Cross-platform analytics*' `AdoptionDto` was the one until
 * P19.23 retired the page (ADR-0277 §1).
 */
const SHARED_SHAPES: Type<unknown>[] = [];

/** Every class the table names, so Swagger emits a schema for each. */
export const RESPONSE_MODELS: Type<unknown>[] = [
  ...new Set([
    ...Object.values(RESPONSE_SHAPES).flatMap((s) => [...(s.type ? [s.type] : []), ...(s.or ? [s.or] : [])]),
    ...SHARED_SHAPES,
  ]),
];
