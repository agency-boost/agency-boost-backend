import { Body, Controller, Delete, Get, HttpCode, HttpStatus, Param, Post, Query } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { RateLimiter } from '@/modules/auth/rate-limiter';
import { DomainException } from '@/common/errors/domain.exception';
import { ErrorCode } from '@/common/errors/error-codes';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { Ctx, RequirePermission } from '@/common/auth/auth.decorators';
import { RequestContext } from '@/common/context/request-context';
import { ONBOARDING_REFUSALS } from './onboarding.messages';
import { OnboardingService } from './onboarding.service';
import {
  ApproveRequestDto,
  DeclineRequestDto,
  InviteCodeQueryDto,
  KpmSearchDto,
  LeaderSearchDto,
  RedeemInviteDto,
  RegisterKpmDto,
  RequestLeaderDto,
  TagUntaggedDto,
  UntaggedSearchDto,
} from './org.dto';
import { LeaderCodeService } from './leader-code.service';
import { ApprovalsService } from './approvals.service';
import { KpmRequestService } from '@/modules/tenants/kpm-request.service';
import { CreateKpmRequestDto } from '@/modules/tenants/tenant.dto';

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
    private readonly leaderCodes: LeaderCodeService,
    private readonly approvals: ApprovalsService,
    private readonly kpmRequests: KpmRequestService,
    private readonly config: ConfigService,
    private readonly limiter: RateLimiter,
  ) {}

  /**
   * The leader-code routes, rate limited per caller (P4-T13).
   *
   * The code space is 32⁶ and the reward for guessing is joining a stranger's unit — and
   * the preview hands back the office and the leader's real name for any valid code.
   * Both routes are authenticated, so a prober needs an account first; this makes the
   * account they need expensive to use.
   *
   * Twenty an hour. Somebody typing a code off a WhatsApp message gets it wrong twice,
   * not twenty times.
   */
  private limitCodeAttempts(ctx: RequestContext): void {
    const retryAfter = this.limiter.check(`join-code:${ctx.userId}`, 20, 60 * 60);
    if (retryAfter !== null) {
      throw new DomainException(
        ErrorCode.AUTH_RATE_LIMITED,
        ONBOARDING_REFUSALS.AUTH_RATE_LIMITED.tooManyCodes({ minutes: Math.ceil(retryAfter / 60) }),
        HttpStatus.TOO_MANY_REQUESTS,
        { retryAfterSeconds: retryAfter },
      );
    }
  }

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
  async kpms(@Ctx() ctx: RequestContext, @Query() query: KpmSearchDto) {
    return this.onboarding.searchKpms(query.q, ctx.reader);
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

  @Get('kpm-request')
  @ApiOperation({
    summary: 'The office you asked for, if you asked for one',
    description:
      '`{ request: null }` when you have not. Wrapped rather than returned bare, because a bare ' +
      '`null` leaves the wire as an empty body and a client cannot tell it from a response that ' +
      'failed to serialise. The screen reads this before offering the form, so somebody who has ' +
      'already asked is told where it stands instead of being invited to ask again.',
  })
  async myKpmRequest(@Ctx() ctx: RequestContext) {
    return { request: await this.kpmRequests.mine(ctx) };
  }

  @Post('kpm-request')
  @RequirePermission('kpm_request:create')
  @ApiOperation({
    summary: 'Ask for an office that does not exist yet',
    description:
      'For somebody whose branch has never been provisioned: they search the directory, find ' +
      'nothing, and until now the product had no answer for them (ADR-0011). Refused to anybody ' +
      'already in an office.',
  })
  async askForKpm(@Ctx() ctx: RequestContext, @Body() dto: CreateKpmRequestDto) {
    return this.kpmRequests.create(ctx, dto);
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

  // ---- The leader code: one artefact, three presentations. ----

  @Get('my-code')
  @ApiOperation({
    summary: 'Your leader code, and the link that carries it',
    description:
      'One code, generated with your membership and never reissued. It replaced ' +
      'GET/POST/DELETE /join/invites: no prototype has ever had a control ' +
      'that creates or withdraws one, and a code that cannot be reissued must not be ' +
      'revocable — withdrawing it would leave you unable to invite anybody.',
  })
  async myLeaderCode(@Ctx() ctx: RequestContext) {
    return this.leaderCodes.mine(ctx, this.appOrigin);
  }

  @Get('invite')
  @ApiOperation({
    summary: 'What a code is for',
    description:
      'Whose unit and which office, so somebody can see what they are accepting before ' +
      'they accept it. Authenticated, deliberately: the code space is 32^6 and this ' +
      'names a real office and a real person, so a prober needs an account first. ' +
      'A code nobody holds and one whose leader has left answer alike.',
  })
  async previewInvite(@Ctx() ctx: RequestContext, @Query() query: InviteCodeQueryDto) {
    this.limitCodeAttempts(ctx);
    return this.leaderCodes.preview(query.code, ctx.reader);
  }

  // ---- The leader's side: deciding, and pulling somebody in. ----

  @Get('requests')
  @RequirePermission('leader_request:read_inbox')
  @ApiOperation({
    summary: 'Requests waiting on you',
    description:
      'Includes anything routed to you by somebody above — an AB may send an agent into ' +
      'one of their AABs\' units, and that AAB is then the one who decides.',
  })
  async inbox(@Ctx() ctx: RequestContext) {
    return this.approvals.inbox(ctx);
  }

  @Get('requests/routing')
  @RequirePermission('leader_request:read_inbox')
  @ApiOperation({
    summary: 'Units you may send somebody into',
    description:
      'Your own direct AABs, and only those. Empty for an AAB — their reports are ' +
      'agents, so there is no sub-unit below them.',
  })
  async routing(@Ctx() ctx: RequestContext) {
    return this.approvals.routingChoices(ctx);
  }

  @Post('requests/:requestId/approve')
  @RequirePermission('leader_request:approve')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Approve a request',
    description:
      'Returns the inbox as it now stands. Deciding one that was already decided is a ' +
      '409 naming which way it went — two leaders can have this open at once. `joinDate` ' +
      'is the day they joined (today when omitted); a date after today or before 1980 is ' +
      'refused 400 `VALIDATION_FAILED` before anything is written.',
  })
  async approve(
    @Ctx() ctx: RequestContext,
    @Param('requestId') requestId: string,
    @Body() dto: ApproveRequestDto,
  ) {
    return this.approvals.approve(ctx, requestId, dto.routeToMembershipId, dto.joinDate);
  }

  @Post('requests/:requestId/decline')
  @RequirePermission('leader_request:approve')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Decline a request',
    description:
      'They stay registered to the office and may ask somebody else. Declining is not ' +
      'removal, and the reason is sent to them.',
  })
  async decline(
    @Ctx() ctx: RequestContext,
    @Param('requestId') requestId: string,
    @Body() dto: DeclineRequestDto,
  ) {
    return this.approvals.decline(ctx, requestId, dto.reason);
  }

  @Get('untagged')
  @RequirePermission('member:search_untagged_pool')
  @ApiOperation({
    summary: 'People in this office with no leader',
    description:
      'Office-wide, because somebody untagged belongs to nobody yet and so cannot be ' +
      'found by looking down anybody\'s tree.',
  })
  async untagged(@Ctx() ctx: RequestContext, @Query() query: UntaggedSearchDto) {
    return this.approvals.untagged(ctx, query.q);
  }

  @Post('untagged/:membershipId')
  @RequirePermission('member:add_untagged_to_unit')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Add an untagged person to your unit',
    description:
      'No approval from them — the office already admitted them, and being placed under ' +
      'a leader is not a change they have standing to refuse. Somebody who already ' +
      'reports to another leader is refused: moving them is a different operation. ' +
      '`joinDate` as approving a request takes it.',
  })
  async tag(
    @Ctx() ctx: RequestContext,
    @Param('membershipId') membershipId: string,
    @Body() dto: TagUntaggedDto,
  ) {
    return this.approvals.tag(ctx, membershipId, dto.joinDate);
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
    this.limitCodeAttempts(ctx);
    return this.leaderCodes.redeem(ctx, dto.code);
  }
}
