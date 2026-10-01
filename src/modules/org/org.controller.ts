import { Body, Controller, Delete, Get, Param, Patch, Post, Put, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { Ctx, RequirePermission } from '@/common/auth/auth.decorators';
import { RequestContext } from '@/common/context/request-context';
import { DirectoryService } from './directory.service';
import { AdminDelegationService } from './admin-delegation.service';
import { GroupService } from './group.service';
import { OrgTreeService } from './org-tree.service';
import { ChangeRoleDto, DirectoryQueryDto, GroupDto, RemoveMemberDto, TagMemberDto } from './org.dto';
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
      'not a tree.',
  })
  async orgTree(@Ctx() ctx: RequestContext) {
    return this.tree.read(ctx);
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

  @Get('groups')
  @RequirePermission('group_informal:create')
  @ApiOperation({
    summary: 'The office’s informal groups',
    description:
      'Tags this office defines for its own organising — a mentoring circle, a task ' +
      'force. Never hierarchy and never access: nothing in scope resolution reads them.',
  })
  async listGroups(@Ctx() ctx: RequestContext) {
    return this.groups.list(ctx);
  }

  @Post('groups')
  @RequirePermission('group_informal:create')
  @ApiOperation({ summary: 'Create a group' })
  async createGroup(@Ctx() ctx: RequestContext, @Body() dto: GroupDto) {
    return this.groups.create(ctx, dto);
  }

  @Put('groups/:groupId')
  @RequirePermission('group_informal:update')
  @ApiOperation({ summary: 'Rename a group, or hand it to a different owner' })
  async updateGroup(
    @Ctx() ctx: RequestContext,
    @Param('groupId') groupId: string,
    @Body() dto: GroupDto,
  ) {
    return this.groups.rename(ctx, groupId, dto);
  }

  @Delete('groups/:groupId')
  @RequirePermission('group_informal:archive')
  @ApiOperation({
    summary: 'Retire a group',
    description:
      'Archived, never deleted, and the tags on the people who were in it stay. The ' +
      'prototype splices the row and strips everybody’s tags in the same breath, so the ' +
      'record that a cohort existed is gone.',
  })
  async archiveGroup(@Ctx() ctx: RequestContext, @Param('groupId') groupId: string) {
    return this.groups.archive(ctx, groupId);
  }

  @Get(':membershipId/tags')
  @RequirePermission('member:tag_group')
  @ApiOperation({ summary: 'What this person is tagged with' })
  async readTags(@Ctx() ctx: RequestContext, @Param('membershipId') membershipId: string) {
    return this.groups.tagsFor(ctx, membershipId);
  }

  @Put(':membershipId/tags')
  @RequirePermission('member:tag_group')
  @ApiOperation({
    summary: 'Set this person’s groups and Core Leader flag',
    description:
      'Core Leader is for Strategic Leader Forum co-editing, which is not built yet, and nothing ' +
      'else — no hierarchy, no data scope. A group is the same: a label, not a rule.',
  })
  async tagMember(
    @Ctx() ctx: RequestContext,
    @Param('membershipId') membershipId: string,
    @Body() dto: TagMemberDto,
  ) {
    return this.groups.tag(ctx, membershipId, dto);
  }

  @Get()
  @RequirePermission('member:read_profile')
  @ApiOperation({
    summary: 'The office roster',
    description:
      'Cursor-paginated by agent code. Filter by role and status, or search by name, ' +
      'email or agent code. Removed members are excluded unless asked for.',
  })
  async list(@Ctx() ctx: RequestContext, @Query() query: DirectoryQueryDto) {
    return this.directory.list(ctx, query);
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
