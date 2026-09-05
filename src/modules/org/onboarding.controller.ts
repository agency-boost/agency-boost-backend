import { Body, Controller, Delete, Get, HttpCode, HttpStatus, Post, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { Ctx, RequirePermission } from '@/common/auth/auth.decorators';
import { RequestContext } from '@/common/context/request-context';
import { OnboardingService } from './onboarding.service';
import { KpmSearchDto, LeaderSearchDto, RegisterKpmDto, RequestLeaderDto } from './org.dto';

/**
 * Joining an office, from the joiner's side.
 *
 * The prototype gates these as a chain — the leader panel is *"locked entirely until a
 * KPM exists"*. So does this, but by state rather than by a hidden card: without a
 * membership there is no office to scope a leader search to, and the endpoint says so.
 */
@ApiTags('joining an office')
@ApiBearerAuth()
@Controller('join')
export class OnboardingController {
  constructor(private readonly onboarding: OnboardingService) {}

  @Get('me')
  @ApiOperation({
    summary: 'Where you stand',
    description:
      'Office, leader and any outstanding request. Answers for somebody in no office ' +
      'too — that is a valid state, not an error.',
  })
  async me(@Ctx() ctx: RequestContext) {
    return this.onboarding.myState(ctx);
  }

  @Get('kpms')
  @RequirePermission('kpm:read_directory')
  @ApiOperation({
    summary: 'Search the office directory',
    description:
      'The only cross-tenant read a non-Super-Admin has, and the reason it exists is ' +
      'that otherwise nobody could join. Projection-limited to code, branch name, ' +
      'company and city: no member counts, no production, no owner name.',
  })
  async kpms(@Query() query: KpmSearchDto) {
    return this.onboarding.searchKpms(query.q);
  }

  @Post('kpm')
  @RequirePermission('kpm_registration:create')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Register yourself to an office',
    description:
      'Creates a pending membership with no leader — inside the office, in the untagged ' +
      'pool, with no unit-scoped grants at all. A leader still has to take you on.',
  })
  async register(@Ctx() ctx: RequestContext, @Body() dto: RegisterKpmDto) {
    return this.onboarding.registerKpm(ctx, dto.kpmId);
  }

  @Get('leaders')
  @RequirePermission('leader:search_directory')
  @ApiOperation({
    summary: 'Leaders you can ask',
    description:
      'Everyone in your office holding AB or AAB. By role rather than by the graph: ' +
      'this asks who may take you on, and a new AAB has to be askable to ever get a ' +
      'first report.',
  })
  async leaders(@Ctx() ctx: RequestContext, @Query() query: LeaderSearchDto) {
    return this.onboarding.leaders(ctx, query.q);
  }

  @Post('leader-request')
  @RequirePermission('leader_request:create')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Ask a leader to take you',
    description:
      'Notifies them; they decide. Asking somebody else replaces the outstanding ask ' +
      'rather than adding a second — two open rows would let two approvers both say yes.',
  })
  async request(@Ctx() ctx: RequestContext, @Body() dto: RequestLeaderDto) {
    return this.onboarding.requestLeader(ctx, dto.leaderMembershipId);
  }

  @Delete('leader-request')
  @RequirePermission('leader_request:cancel')
  @ApiOperation({ summary: 'Withdraw your request' })
  async cancel(@Ctx() ctx: RequestContext) {
    return this.onboarding.cancelRequest(ctx);
  }
}
