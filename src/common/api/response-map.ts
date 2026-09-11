import { Type } from '@nestjs/common';
import {
  AccessTokenDto, ImpersonationSessionDto, MeDto, MyKpmRequestDto, ReadinessDto,
  RedeemedInviteDto, StatusAckDto,
} from '@/modules/auth/session.response.dto';
import { InboxDto, InboxItemDto } from '@/modules/notifications/notification.response.dto';
import {
  DelegatedAdminDto, DirectoryMemberDto, DirectoryPageDto, GroupSummaryDto, InvitePreviewDto,
  JoinStateDto, KpmDirectoryEntryDto, LeaderChoiceDto, MemberTagsDto,
  MyLeaderCodeDto, OrgTreeDto, PendingRequestDto, RoleChangeEntryDto, RoutingChoiceDto, TeamMemberDto,
  UntaggedMemberDto,
} from '@/modules/org/org.response.dto';
import {
  KpmRequestRowDto, KpmViewDto, OrgLevelRowDto, PlatformAdminRowDto, PlatformOverviewDto,
  RosterCommitDto, RosterPreviewDto, RosterTemplateDto,
} from '@/modules/tenants/tenant.response.dto';
import {
  AuditEntryResponseDto, CompanyResponseDto, PublicCompanyDto,
} from '@/modules/tenants/platform.response.dto';
import {
  ActivityCategoryDto, ActivityTypeDto, LeadPipelineDto, LeadStatusDto, RatioDefinitionDto,
  PlatformTemplateDto, PublishStateDto, TenantConfigDto,
} from '@/modules/config/config.response.dto';

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
export const RESPONSE_SHAPES: Readonly<Record<string, ResponseShape>> = {
  HealthController_live: { type: StatusAckDto },
  HealthController_ready: { type: ReadinessDto },

  AuthController_register: { type: StatusAckDto },
  AuthController_login: { type: AccessTokenDto },
  AuthController_refresh: { type: AccessTokenDto },
  AuthController_logout: { type: StatusAckDto },
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
  TenantConfigController_renameCategory: { type: ActivityCategoryDto },
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
  TenantConfigController_archiveLeadStatus: { type: LeadStatusDto },
  TenantConfigController_restoreLeadStatus: { type: LeadStatusDto },
  AdminController_readTemplate: { type: PlatformTemplateDto },
  AdminController_templateHistory: { type: PlatformTemplateDto, isArray: true },
  AdminController_saveTemplateDraft: { type: PlatformTemplateDto },
  AdminController_publishTemplate: { type: PlatformTemplateDto },
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

  NotificationController_inbox: { type: InboxDto },
  NotificationController_readAll: { type: InboxDto },
  NotificationController_read: { type: InboxItemDto },

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
  AdminController_listOrgLevels: { type: OrgLevelRowDto, isArray: true },
  AdminController_createOrgLevel: { type: OrgLevelRowDto, isArray: true },
  AdminController_updateOrgLevel: { type: OrgLevelRowDto, isArray: true },
  AdminController_listTenants: { type: KpmViewDto, isArray: true },
  AdminController_createTenant: { type: KpmViewDto },
  AdminController_readTenant: { type: KpmViewDto },
  AdminController_assignOwner: { type: KpmViewDto },
  AdminController_setStatus: { type: KpmViewDto },
  AdminController_rosterTemplate: { type: RosterTemplateDto },
  AdminController_previewRoster: { type: RosterPreviewDto },
  AdminController_importRoster: { type: RosterCommitDto },
  AdminController_readAudit: { type: AuditEntryResponseDto, isArray: true },
  AdminController_impersonate: { type: ImpersonationSessionDto },
  AdminController_endImpersonation: { type: StatusAckDto },
};

/** Every class the table names, so Swagger emits a schema for each. */
export const RESPONSE_MODELS: Type<unknown>[] = [
  ...new Set(Object.values(RESPONSE_SHAPES).map((s) => s.type)),
];
