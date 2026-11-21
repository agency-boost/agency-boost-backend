import { Body, Controller, Delete, Get, Param, Patch, Post, Put, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { Ctx, RequirePermission } from '@/common/auth/auth.decorators';
import { RequestContext } from '@/common/context/request-context';
import { DirectoryColumns } from '@/modules/reporting/directory-columns';
import { DirectoryService } from './directory.service';
import { AdminDelegationService } from './admin-delegation.service';
import { GroupService } from './group.service';
import { AddGroupMembersDto } from './group-members.dto';
import { CreateGroupDto, RenameGroupDto, SetAbGroupDto } from './informal-groups.dto';
import { OrgTreeService } from './org-tree.service';
import {
  ChangeRoleDto, CreateLeaderLimitRequestDto, DirectoryQueryDto, MemberSearchQueryDto, OrgTreeQueryDto,
  RemoveMemberDto, SetCoreLeaderDto, TagMemberDto,
} from './org.dto';
import { LeaderLimitRequestService } from './leader-limit-request.service';
import { RemovalService } from './removal.service';
import { RoleChangeService } from './role-change.service';

/**
 * The office roster and the hierarchy behind it.
 *
 * Every route is tenant-scoped through the repository, and narrowed again by what the
 * requester leads: a tenant admin sees the whole office, everyone else sees themselves
 * and their downline. A peer's unit is never reachable, and the narrowing is enforced
 * here rather than in a screen.
 */
@ApiTags('organisation')
@ApiBearerAuth()
@Controller('members')
export class OrgController {
  constructor(
    private readonly directory: DirectoryService,
    private readonly roles: RoleChangeService,
    private readonly removals: RemovalService,
    private readonly tree: OrgTreeService,
    private readonly groups: GroupService,
    private readonly admins: AdminDelegationService,
    // Phase 18 (D-directory): the roster's *Last activity* and *Last coached*, and the read entries they write.
    private readonly columns: DirectoryColumns,
    // ADR-0157: a leader past the office's limit, asked about instead of refused.
    private readonly leaderLimit: LeaderLimitRequestService,
  ) {}

  @Get('my-team')
  @RequirePermission('member:read_profile')
  @ApiOperation({
    summary: 'The people who report to you',
    description:
      'Each row carries whether you may change that person\'s role. The rule is a ' +
      'server rule, and sending the answer stops the screen keeping a second copy of ' +
      'it that can drift out of step.',
  })
  async myTeam(@Ctx() ctx: RequestContext) {
    return this.roles.team(ctx);
  }

  /*
   * Before `GET :membershipId`, or that route would read `search` as somebody's id: Nest matches in the order the
   * handlers are declared.
   */
  @Get('search')
  @RequirePermission('member:read_profile')
  @ApiOperation({
    summary: 'Search agent: the people you may see, by name or agent code',
    description:
      'UI V1 (UI-012, UI-059, D-14): the picker that opens a person\'s page. Part of a name (full or preferred) or an '
      + 'agent code, case-insensitive; empty or absent lists the first people. Narrowed exactly as the roster is — '
      + 'the office for its Owner and Admins, an AB\'s downline, an AAB\'s own unit — **never yourself**, so an Agent '
      + 'finds nobody. Active members only, A to Z by name, the first `limit` (10, at most 20). Names and codes only: '
      + 'nothing is recorded as read, as the tree records nothing.',
  })
  async search(@Ctx() ctx: RequestContext, @Query() query: MemberSearchQueryDto) {
    return { members: await this.directory.search(ctx, query) };
  }

  @Patch(':membershipId/role')
  @RequirePermission('member:change_role')
  @ApiOperation({
    summary: 'Change somebody\'s role',
    description:
      'Agent ⇄ AAB is the direct leader\'s call. Anything involving AB is the Owner\'s ' +
      'or an Admin\'s. Nobody moves: a role change is a statement about a person, not a ' +
      'reorganisation. Demoting somebody who still leads people is refused with the ' +
      'count, so the caller knows what has to happen first.',
  })
  async changeRole(
    @Ctx() ctx: RequestContext,
    @Param('membershipId') membershipId: string,
    @Body() dto: ChangeRoleDto,
  ) {
    return this.roles.change(ctx, membershipId, dto.toRole, dto.reason);
  }

  @Get('role-changes')
  @RequirePermission('member:read_role_change_log')
  @ApiOperation({
    summary: 'The role change log',
    description:
      'Read from the append-only membership history, which is the only place the ' +
      'before-and-after of a role survives.',
  })
  async roleLog(@Ctx() ctx: RequestContext) {
    return this.roles.log(ctx);
  }

  /*
   * **A leader past the office's limit waits for AgencyBoost** (ADR-0157). Declared before `:membershipId`, so
   * `leader-limit-requests` is never read as a member's id.
   */
  @Get('leader-limit-requests')
  @RequirePermission('leader_limit_request:read')
  @ApiOperation({
    summary: 'The office\u2019s requests to make a leader past its limit',
    description:
      'Every request of the office for its Owner and an Admin; for an AB or AAB, the ones they asked. Pending ' +
      'first. Each carries the office\u2019s limit and Leaders used now.',
  })
  async leaderLimitRequests(@Ctx() ctx: RequestContext) {
    return this.leaderLimit.list(ctx);
  }

  @Delete('leader-limit-requests/:requestId')
  @RequirePermission('leader_limit_request:create')
  @ApiOperation({
    summary: 'Cancel a request to make a leader past the limit',
    description:
      'Whoever asked, or the Owner or an Admin, may withdraw an open one; nothing about the member changes. ' +
      'Another office\u2019s request is 404. One already decided or cancelled is 409 LEADER_LIMIT_REQUEST_DECIDED.',
  })
  async cancelLeaderLimitRequest(@Ctx() ctx: RequestContext, @Param('requestId') requestId: string) {
    return this.leaderLimit.cancel(ctx, requestId);
  }

  @Post(':membershipId/leader-limit-request')
  @RequirePermission('leader_limit_request:create')
  @ApiOperation({
    summary: 'Ask AgencyBoost to approve one leader past the office\u2019s limit',
    description:
      'For the write the limit refused with LEADER_LIMIT_REACHED and canRequest: a role change onto a leader ' +
      'rung (`promote`, naming the rung and the reason), or letting in a pending member who stands on one ' +
      '(`activate`). Refused wherever that write would be, in its words; a change that makes no new leader is ' +
      '400. One open request per member: a second is 409 LEADER_LIMIT_REQUEST_OPEN. Nothing about the member ' +
      'changes while it waits.',
  })
  async requestPastLeaderLimit(
    @Ctx() ctx: RequestContext,
    @Param('membershipId') membershipId: string,
    @Body() dto: CreateLeaderLimitRequestDto,
  ) {
    return this.leaderLimit.create(ctx, membershipId, dto);
  }

  @Delete(':membershipId')
  @RequirePermission('member:remove_from_team')
  @ApiOperation({
    summary: 'Remove somebody from the office',
    description:
      'Requires the literal word REMOVE in the body — the screen\'s gate is a ' +
      'convenience, this is the control. Nothing is deleted: the row, the agent code ' +
      'and every history event stay with the office. If they still have reports, the ' +
      'body must say where those reports go; there is no default, because a default ' +
      'here silently reorganises somebody else\'s unit.',
  })
  async remove(
    @Ctx() ctx: RequestContext,
    @Param('membershipId') membershipId: string,
    @Body() dto: RemoveMemberDto,
  ) {
    return this.removals.remove(ctx, membershipId, {
      confirmation: dto.confirmation,
      reason: dto.reason,
      subtree: dto.subtree
        ? dto.subtree.action === 'reassign'
          ? { action: 'reassign', toMembershipId: dto.subtree.toMembershipId as string }
          : { action: 'orphan' }
        : undefined,
    });
  }

  @Get('tree')
  @RequirePermission('org_tree:read')
  @ApiOperation({
    summary: 'The hierarchy, as a graph',
    description:
      'A flat node list plus the ids of its roots. Narrowed exactly as the roster is: a ' +
      'tenant admin sees the office, everybody else sees themselves and their downline. ' +
      'The answer is a **forest** — a root is any visible node whose leader is not also ' +
      'visible, which is the office root plus anybody orphaned by a removal or not yet ' +
      'tagged. Your own leader comes back separately and is not a node, so it cannot be ' +
      'given a layer. Refuses rather than truncates above the cap: a page of a tree is ' +
      'not a tree. With `for`, one leader’s tree as that leader sees it, read-only — the ' +
      'leader as layer 1 and their own leader as the card above: for the Owner and an Admin ' +
      'any active member of the office, for an AB or an AAB anybody in their downline, `404` ' +
      'outside that or in another office, and `403` for an Agent.',
  })
  async orgTree(@Ctx() ctx: RequestContext, @Query() query: OrgTreeQueryDto) {
    // ADR-0268 §1: `view=kpm` is the KPM's Org tree — a core leader's whole KPM, their downline openable.
    return this.tree.read(ctx, query.for, query.view);
  }

  @Get('admins')
  @RequirePermission('kpm_admin:list')
  @ApiOperation({
    summary: 'Who administers this office',
    description:
      'Readable by the Owner and by Admins — knowing who else administers the office ' +
      'is not a power, and hiding it would make the nav lie. Each row says whether the ' +
      'reader may revoke it.',
  })
  async listAdmins(@Ctx() ctx: RequestContext) {
    return this.admins.list(ctx);
  }

  @Post(':membershipId/admin')
  @RequirePermission('kpm_admin:grant')
  @ApiOperation({
    summary: 'Give somebody admin access',
    description:
      'Owner only. An Admin attempting it is refused with PERM_OWNER_ONLY rather than ' +
      'a flat PERM_DENIED — they are told the Owner reserved it. Admin rights are ' +
      'orthogonal to hierarchy role: an AB with a unit of forty can hold them.',
  })
  async grantAdmin(@Ctx() ctx: RequestContext, @Param('membershipId') membershipId: string) {
    return this.admins.grant(ctx, membershipId);
  }

  @Delete(':membershipId/admin')
  @RequirePermission('kpm_admin:revoke')
  @ApiOperation({
    summary: 'Take admin access away',
    description:
      'Owner only. The Owner’s own access comes from being the Owner, not from a ' +
      'grant, and cannot be revoked — transferring the office is the operation for that.',
  })
  async revokeAdmin(@Ctx() ctx: RequestContext, @Param('membershipId') membershipId: string) {
    return this.admins.revoke(ctx, membershipId);
  }

  /*
   * **Informal groups** (P19.17-T4; ADR-0270): only an AB carries one, their AABs and agents follow; a group has any
   * number of Group Leaders, ABs in it. The Super Admin in the KPM, the Owner, an Admin and a core leader — the route's
   * permission, and `requireOfficeSteward` in the service. A group is a label, never access: nobody sees more for it.
   */
  @Get('groups')
  @RequirePermission('member:read_tags')
  @ApiOperation({
    summary: 'The KPM\u2019s informal groups: each with its Group Leaders, its ABs and its counts, then Tanpa group',
    description:
      'The live groups A to Z, each with its Group Leaders (ABs, any number, while they hold), its ABs A to Z — each with '
      + 'the size of their AB group (*n orang di grupnya*) — and *n leader · n orang · n AB group*; then *Tanpa group*: '
      + 'the ABs with none. Test accounts are not counted. `canWrite` false in a view-as session.',
  })
  async listGroups(@Ctx() ctx: RequestContext) {
    return this.groups.list(ctx);
  }

  @Post('groups')
  @RequirePermission('group_informal:create')
  @ApiOperation({
    summary: 'Group baru: a name only',
    description:
      'No Group Leader: they are appointed later. With `abMembershipId` — the AB whose picker made it — that AB and their '
      + 'team move into it at once (an AAB or an agent `422 ORG_GROUP_AB_ONLY`). A live name taken `409 '
      + 'ORG_GROUP_NAME_TAKEN`. Audited `group.created`, and `member.tagged` for the AB. Answers the group and the groups.',
  })
  async createGroup(@Ctx() ctx: RequestContext, @Body() dto: CreateGroupDto) {
    return this.groups.create(ctx, dto);
  }

  @Put('groups/:groupId')
  @RequirePermission('group_informal:update')
  @ApiOperation({
    summary: 'Ubah nama: rename a group',
    description: 'Its ABs carry the group\u2019s id, so they follow. Audited `group.updated`, before and after.',
  })
  async updateGroup(@Ctx() ctx: RequestContext, @Param('groupId') groupId: string, @Body() dto: RenameGroupDto) {
    return this.groups.rename(ctx, groupId, dto);
  }

  @Delete('groups/:groupId')
  @RequirePermission('group_informal:archive')
  @ApiOperation({
    summary: 'Hapus group: archive it, its ABs to Tanpa group',
    description:
      'Archived, never deleted; its Group Leaders cleared and **every row carrying it untagged**, so its ABs and their '
      + 'teams read *Tanpa group*. One `member.tagged` entry per row, then `group.archived` with the leaders it had.',
  })
  async archiveGroup(@Ctx() ctx: RequestContext, @Param('groupId') groupId: string) {
    return this.groups.archive(ctx, groupId);
  }

  @Put('groups/:groupId/leaders/:membershipId')
  @RequirePermission('group_informal:update')
  @ApiOperation({
    summary: 'Jadikan group leader: add an AB of the group to its Group Leaders',
    description:
      'Adds, never replaces: a group has any number of Group Leaders. An active AB in this group; an AB elsewhere `422 '
      + 'ORG_GROUP_LEADER_NOT_IN_GROUP`, an AAB or an agent `422 ORG_GROUP_AB_ONLY`, nobody here `404`. Already one writes '
      + 'nothing. Audited `group.updated` with the leaders before and after.',
  })
  async appointGroupLeader(
    @Ctx() ctx: RequestContext, @Param('groupId') groupId: string, @Param('membershipId') membershipId: string,
  ) {
    return this.groups.addLeader(ctx, groupId, membershipId);
  }

  @Delete('groups/:groupId/leaders/:membershipId')
  @RequirePermission('group_informal:update')
  @ApiOperation({
    summary: 'Hapus sebagai group leader',
    description: 'The AB stays in the group. Somebody not among its leaders writes nothing. Audited `group.updated`.',
  })
  async removeGroupLeader(
    @Ctx() ctx: RequestContext, @Param('groupId') groupId: string, @Param('membershipId') membershipId: string,
  ) {
    return this.groups.removeLeader(ctx, groupId, membershipId);
  }

  @Post('groups/:groupId/members')
  @RequirePermission('member:tag_group')
  @ApiOperation({
    summary: '+ Tambah ke grup: move several ABs into one group at once, each with their team',
    description:
      'The Unit Dashboard\u2019s *Grup informal* sheet. Every id must be an active member of this KPM (`404` otherwise) '
      + 'and an AB (`422 ORG_GROUP_AB_ONLY`), and the group a live one of it (`404`) — or nothing moves. An AB already in '
      + 'the group is not counted again. One `member.tagged` audit entry per AB moved.',
  })
  async addGroupMembers(
    @Ctx() ctx: RequestContext,
    @Param('groupId') groupId: string,
    @Body() dto: AddGroupMembersDto,
  ) {
    return this.groups.addMembers(ctx, groupId, dto.membershipIds);
  }

  @Put(':membershipId/group')
  @RequirePermission('member:tag_group')
  @ApiOperation({
    summary: 'An AB\u2019s informal group: the group chip and the Group dialog',
    description:
      'An active AB of this KPM into a live group, or `null` for *Tanpa group*; **the whole team follows** — they are '
      + 'derived, nothing is copied. An AAB or an agent `422 ORG_GROUP_AB_ONLY` (they follow their AB); nobody here or a '
      + 'group not live `404`. Leaving a group they led takes them off its leaders. Audited `member.tagged`.',
  })
  async setAbGroup(@Ctx() ctx: RequestContext, @Param('membershipId') membershipId: string, @Body() dto: SetAbGroupDto) {
    return this.groups.setAbGroup(ctx, membershipId, dto.groupId);
  }

  @Get(':membershipId/tags')
  @RequirePermission('member:tag_group')
  @ApiOperation({
    summary: 'What this person is tagged with',
    description: 'An AB\u2019s group, the Core Leader tag, and — for an AAB or an agent — the group they follow from their AB.',
  })
  async readTags(@Ctx() ctx: RequestContext, @Param('membershipId') membershipId: string) {
    return this.groups.tagsFor(ctx, membershipId);
  }

  @Put(':membershipId/tags')
  @RequirePermission('member:tag_group')
  @ApiOperation({
    summary: 'Set an AB\u2019s group and this person\u2019s Core Leader flag',
    description:
      'An AB\u2019s one group or none (`400 ORG_GROUP_ONE_PER_LEADER` for two); a group on an AAB or an agent `422 ' +
      'ORG_GROUP_AB_ONLY` (ADR-0270 §1). Core Leader (ADR-0159, ADR-0268) is **a leader\u2019s only**: a change to it is ' +
      'checked against `member:tag_core_leader`, and setting it on a member whose rung is not a leader rung is refused ' +
      '`400 CORE_LEADER_NOT_A_LEADER`; an unchanged flag is not asked about. A group is a label, not a rule.',
  })
  async tagMember(
    @Ctx() ctx: RequestContext,
    @Param('membershipId') membershipId: string,
    @Body() dto: TagMemberDto,
  ) {
    return this.groups.tag(ctx, membershipId, dto);
  }

  @Put(':membershipId/core-leader')
  @RequirePermission('member:tag_core_leader')
  @ApiOperation({
    summary: 'Tag or untag this person Core Leader',
    description:
      'The directory row’s control (ADR-0159 §1): the Core Leader flag alone, the person’s groups untouched. ' +
      'A leader’s only — `400 CORE_LEADER_NOT_A_LEADER` for a member whose rung is not a leader rung. Audited ' +
      'as `member.tagged`, before and after; the same value again writes nothing. Answers the person’s tags.',
  })
  async setCoreLeader(
    @Ctx() ctx: RequestContext,
    @Param('membershipId') membershipId: string,
    @Body() dto: SetCoreLeaderDto,
  ) {
    return this.groups.setCoreLeader(ctx, membershipId, dto.isCoreLeader);
  }

  @Get()
  @RequirePermission('member:read_profile')
  @ApiOperation({
    summary: 'The office roster',
    description:
      'Cursor-paginated by agent code. Filter by role and status, or search by name, ' +
      'email or agent code. Removed members are excluded unless asked for. Each **active** row carries ' +
      'the member\'s latest day logged and the days since their last 1:1, and every active member on the ' +
      'page other than you is recorded as read; a pending or removed row carries neither and is not.',
  })
  async list(@Ctx() ctx: RequestContext, @Query() query: DirectoryQueryDto) {
    return this.columns.decorate(ctx, await this.directory.list(ctx, query));
  }

  @Get(':membershipId')
  @RequirePermission('member:read_profile')
  @ApiOperation({
    summary: 'One member',
    description: 'Someone outside your scope reads as 404 — a 403 would confirm they exist.',
  })
  async read(@Ctx() ctx: RequestContext, @Param('membershipId') membershipId: string) {
    return this.directory.read(ctx, membershipId);
  }

  @Get(':membershipId/reports')
  @RequirePermission('member:read_profile')
  @ApiOperation({
    summary: 'Direct reports',
    description: 'One level down. The whole downline is the tree endpoint, not this one.',
  })
  async reports(@Ctx() ctx: RequestContext, @Param('membershipId') membershipId: string) {
    // The visibility narrowing is applied to the parent, so asking for a peer's reports
    // 404s on the peer rather than answering about their unit.
    return this.directory.reportsOf(ctx, membershipId);
  }
}
