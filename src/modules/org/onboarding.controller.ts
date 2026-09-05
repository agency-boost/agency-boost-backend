import { Body, Controller, Delete, Get, HttpCode, HttpStatus, Param, Post, Query } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { Ctx, RequirePermission } from '@/common/auth/auth.decorators';
import { RequestContext } from '@/common/context/request-context';
import { OnboardingService } from './onboarding.service';
import {
  InviteCodeQueryDto,
  IssueInviteDto,
  KpmSearchDto,
  LeaderSearchDto,
  RedeemInviteDto,
  RegisterKpmDto,
  RequestLeaderDto,
} from './org.dto';
import { InviteService } from './invite.service';

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
  constructor(
    private readonly onboarding: OnboardingService,
    private readonly invites: InviteService,
    private readonly config: ConfigService,
  ) {}

  /**
   * Where a shared link points.
   *
   * The app's origin, not the API's — a joiner opens a page, not an endpoint. It comes
   * from configuration because it differs per environment, and falls back to the local
   * dev server so the link is never a broken string.
   */
  private get appOrigin(): string {
    return this.config.get<string>('APP_ORIGIN') ?? 'http://localhost:3000';
  }

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

  // ---- Invites: one artefact, three presentations. ----

  @Get('invites')
  @RequirePermission('member:invite')
  @ApiOperation({
    summary: 'The invites you have issued',
    description:
      'Revoked and spent ones stay in the list, so you can see what has been out there ' +
      'rather than only what still works.',
  })
  async listInvites(@Ctx() ctx: RequestContext) {
    return this.invites.mine(ctx, this.appOrigin);
  }

  @Post('invites')
  @RequirePermission('member:invite')
  @ApiOperation({
    summary: 'Issue an invite',
    description:
      'Returns the code and the link; a QR is that link rendered. Anyone who redeems it ' +
      'joins your office tagged to you, with no approval — which is why it can carry a ' +
      'use limit and an expiry, and can be revoked.',
  })
  async issueInvite(@Ctx() ctx: RequestContext, @Body() dto: IssueInviteDto) {
    return this.invites.issue(ctx, dto, this.appOrigin);
  }

  @Delete('invites/:inviteId')
  @RequirePermission('member:revoke_invite')
  @ApiOperation({
    summary: 'Revoke an invite',
    description: 'Kills the code, the link and the QR at once — they are one artefact.',
  })
  async revokeInvite(@Ctx() ctx: RequestContext, @Param('inviteId') inviteId: string) {
    return this.invites.revoke(ctx, inviteId);
  }

  @Get('invite')
  @ApiOperation({
    summary: 'What an invite is for',
    description:
      'Whose unit and which office, so somebody can see what they are accepting before ' +
      'they accept it. Unknown, revoked and expired all answer alike.',
  })
  async previewInvite(@Query() query: InviteCodeQueryDto) {
    return this.invites.preview(query.code);
  }

  @Post('redeem')
  @RequirePermission('join_via_code_link_qr')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Redeem an invite',
    description:
      'Registers you and tags you to the issuer in one step, with no approval — that is ' +
      'the whole difference from asking a leader. No join request is created: one would ' +
      'sit in their inbox asking them to approve something that already happened.',
  })
  async redeem(@Ctx() ctx: RequestContext, @Body() dto: RedeemInviteDto) {
    return this.invites.redeem(ctx, dto.code);
  }
}
