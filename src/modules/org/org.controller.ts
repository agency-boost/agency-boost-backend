import { Body, Controller, Get, Param, Patch, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { Ctx, RequirePermission } from '@/common/auth/auth.decorators';
import { RequestContext } from '@/common/context/request-context';
import { DirectoryService } from './directory.service';
import { ChangeRoleDto, DirectoryQueryDto } from './org.dto';
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
  @RequirePermission('member:read_profile')
  @ApiOperation({
    summary: 'The role change log',
    description:
      'Read from the append-only membership history, which is the only place the ' +
      'before-and-after of a role survives.',
  })
  async roleLog(@Ctx() ctx: RequestContext) {
    return this.roles.log(ctx);
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
