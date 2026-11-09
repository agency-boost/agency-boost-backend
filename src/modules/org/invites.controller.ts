import { Body, Controller, Delete, Get, HttpCode, HttpStatus, Param, Post, Req } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ApiBearerAuth, ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import type { Request } from 'express';
import { Ctx, Public, RequirePermission } from '@/common/auth/auth.decorators';
import { RequestContext } from '@/common/context/request-context';
import { DomainException } from '@/common/errors/domain.exception';
import { ErrorCode } from '@/common/errors/error-codes';
import { ApiErrorEnvelope } from '@/common/errors/error-envelope.dto';
import { readerOfRequest } from '@/common/i18n/reader';
import { RateLimiter } from '@/modules/auth/rate-limiter';
import { AddAgentDto, DeclineTransferDto } from './invites.dto';
import { InvitesService } from './invites.service';
import { ONBOARDING_REFUSALS } from './onboarding.messages';
import { TransfersService } from './transfers.service';

/**
 * The success, stated: Swagger drops the one it would infer once any response is declared, and `openapi.ts` fills its
 * body from the response table.
 */
const OK = { status: HttpStatus.OK, description: '' };

/** A refusal the derived descriptions cannot know, in the shared envelope. */
const refusal = (status: number, description: string) => ({ status, description, type: ApiErrorEnvelope });

const OUTSIDE =
  '`NOT_FOUND` — an invite outside your reach: another leader’s unit for an AB or an AAB, an id that is nobody’s, '
  + 'or one in another office, which is answered exactly alike.';

/**
 * Where a shared link points: the app's origin, not the API's — a person opens a page, not an endpoint. From
 * configuration because it differs per environment, falling back to the local dev server.
 */
function appOriginOf(config: ConfigService): string {
  return config.get<string>('APP_ORIGIN') ?? 'http://localhost:3000';
}

/**
 * **+ Add agent, on `/new-hires`** (ADR-0170 §1–§4, P18.8-T3 AC-1 to AC-3): the one form's entry point, the invites it
 * makes and the transfers it asks for. Every route is `member:invite` — an AB's or AAB's own unit, the Owner's and an
 * Admin's office — and reaches nothing outside it (404).
 *
 * **Registered before `NewHiresController`** (`app.module.ts`), whose `GET /new-hires/:membershipId` would otherwise
 * read `invites` and `transfers` as a membership id; `app.module.int.spec.ts` pins the order.
 */
@ApiTags('joining an office')
@ApiBearerAuth()
@Controller('new-hires')
export class NewHireAgentsController {
  constructor(
    private readonly invites: InvitesService,
    private readonly transfers: TransfersService,
    private readonly config: ConfigService,
  ) {}

  @Post('agents')
  @RequirePermission('member:invite')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Add an agent',
    description:
      'The one form: agent code, name, WhatsApp number and join date. Decided by the code, within the office’s '
      + 'company: nobody holds it → an invite, with its link (`invited`); an account with no leader here → placed under '
      + 'the leader now, with the join date (`linked`); an account reporting to another leader here → a transfer request '
      + 'for the Owner and the Admins (`transfer_requested`), answered with the name you typed and never the account’s '
      + 'own or its leader; an account with no membership here → an invite they accept '
      + 'signed in (`invited`). Your own unit as an AB or AAB; any active member’s unit, as `leaderMembershipId`, for the '
      + 'Owner or an Admin. Audited.',
  })
  @ApiResponse(OK)
  @ApiResponse(refusal(400, '`VALIDATION_FAILED` — a field’s shape, or a join date after the office’s today or before 1980.'))
  @ApiResponse(refusal(404, '`NOT_FOUND` — naming another leader’s unit as an AB or an AAB, or a member who is nobody’s, or in another office — answered alike.'))
  @ApiResponse(refusal(
    409,
    '`ORG_CYCLE_DETECTED` — your own code, or a move that would make a loop. `ORG_AGENT_ALREADY_TAGGED` — they already '
    + 'report to that leader. `ORG_INVITE_PENDING` — the code already has an invite waiting in the company. '
    + '`ORG_TRANSFER_PENDING` — a transfer for them is already waiting.',
  ))
  @ApiResponse(refusal(
    403,
    '`PERM_DENIED` — the caller does not hold `member:invite`. `ORG_NOT_PERMITTED_TO_TAG` — the office’s root or its '
    + 'owner, whom nobody adds to a unit, or an orphan who leads a unit, for anybody but the office.',
  ))
  @ApiResponse(refusal(422, '`ORG_LEADER_NOT_IN_KPM` — the unit named is not an active member’s.'))
  async add(@Ctx() ctx: RequestContext, @Body() dto: AddAgentDto) {
    return this.invites.addAgent(ctx, dto, appOriginOf(this.config));
  }

  @Get('invites')
  @RequirePermission('member:invite')
  @ApiOperation({
    summary: 'Your invites, waiting to join',
    description:
      'Pending and expired invites into your unit — the office’s, for the Owner or an Admin — newest first, with the '
      + 'office’s today. Never a link: only a token’s hash is kept, so *Resend* makes a new one. An invite counts in '
      + 'nothing until it is accepted.',
  })
  async list(@Ctx() ctx: RequestContext) {
    return this.invites.list(ctx);
  }

  @Post('invites/:inviteId/resend')
  @RequirePermission('member:invite')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Resend an invite',
    description: 'A new link and 14 days more; the old link opens nothing now. Answers the link, once. Audited.',
  })
  @ApiResponse(OK)
  @ApiResponse(refusal(404, OUTSIDE))
  @ApiResponse(refusal(
    409,
    '`ORG_REQUEST_ALREADY_DECIDED` — it was accepted or cancelled. `ORG_INVITE_PENDING` — an expired invite whose code '
    + 'has another invite waiting since.',
  ))
  async resend(@Ctx() ctx: RequestContext, @Param('inviteId') inviteId: string) {
    return this.invites.resend(ctx, inviteId, appOriginOf(this.config));
  }

  @Delete('invites/:inviteId')
  @RequirePermission('member:invite')
  @ApiOperation({
    summary: 'Cancel an invite',
    description:
      'Its link opens nothing from now on, and it leaves nothing behind in any count — it never counted. The row stays, '
      + 'cancelled, as the record of who invited whom. Answers your invites as they now stand. Audited.',
  })
  @ApiResponse(OK)
  @ApiResponse(refusal(404, OUTSIDE))
  @ApiResponse(refusal(409, '`ORG_REQUEST_ALREADY_DECIDED` — it was accepted or cancelled already.'))
  async cancel(@Ctx() ctx: RequestContext, @Param('inviteId') inviteId: string) {
    return this.invites.cancel(ctx, inviteId);
  }

  @Get('transfers')
  @RequirePermission('member:invite')
  @ApiOperation({
    summary: 'Your transfer requests, waiting',
    description:
      'The transfers you asked for that the office has not decided: *Transfer requested* on `/new-hires`. The member '
      + 'stays with their leader until the Owner or an Admin approves. Each as you asked for it — the name you typed, '
      + 'the agent code and the unit — and never the account’s own name or the leader they report to.',
  })
  async myTransfers(@Ctx() ctx: RequestContext) {
    return this.transfers.mine(ctx);
  }
}

/**
 * **An invite's link** (ADR-0170 §3, P18.8-T3 AC-4): what it opens before anybody is signed in, and accepting it as a
 * signed-in account the code belongs to. Registration on the link is `POST /auth/register` with `inviteToken`.
 */
@ApiTags('joining an office')
@Controller('invites')
export class InviteLinkController {
  constructor(
    private readonly invites: InvitesService,
    private readonly limiter: RateLimiter,
  ) {}

  /** Rate limited as the other public routes are (`AuthController.limit`): `max` an hour against one key. */
  private limit(key: string, max: number): void {
    const retryAfter = this.limiter.check(key, max, 60 * 60);
    if (retryAfter !== null) {
      throw new DomainException(
        ErrorCode.AUTH_RATE_LIMITED,
        ONBOARDING_REFUSALS.AUTH_RATE_LIMITED.tooMany({ minutes: Math.ceil(retryAfter / 60) }),
        HttpStatus.TOO_MANY_REQUESTS,
        { retryAfterSeconds: retryAfter },
      );
    }
  }

  @Public()
  @Get(':token')
  @ApiOperation({
    summary: 'What an invite link is for',
    description:
      'The banner the sign-up page shows: the leader’s name, the office, the insurer, the agent code and join date '
      + '(read-only on the form) and the invitee’s name. **Public** — the person opening it has no account yet — and '
      + 'rate limited per address, sixty an hour. A link that opens nothing — unknown, cancelled, used or expired — is '
      + '`404 NOT_FOUND`, its sentence saying which in plain words: a token is 192 random bits, so its holder learns '
      + 'nothing a prober could use. The token is redacted from every log line.',
  })
  @ApiResponse(OK)
  @ApiResponse(refusal(404, '`NOT_FOUND` — the link opens nothing: unknown, cancelled, used, expired, or an office that has stopped — answered as a link into another office is.'))
  @ApiResponse(refusal(429, '`AUTH_RATE_LIMITED` — too many link openings from this address.'))
  async banner(@Param('token') token: string, @Req() req: Request) {
    this.limit(`invite-link:ip:${req.ip ?? 'unknown'}`, 60);
    // A public route has no context, and still a reader: the one `AuthGuard` read off the request's header.
    return this.invites.banner(token, readerOfRequest(req));
  }

  @ApiBearerAuth()
  @Post(':token/accept')
  @RequirePermission('join_via_code_link_qr')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Accept an invite, signed in',
    description:
      'For an account the invite’s agent code belongs to: joins the office under the leader at once, with the invite’s '
      + 'join date, and tells the leader. An invite for another code is 404. Somebody already in an office is refused '
      + '`409 ORG_AGENT_ALREADY_TAGGED`. Rate limited per account, as a leader’s code is.',
  })
  @ApiResponse(OK)
  @ApiResponse(refusal(404, '`NOT_FOUND` — the link opens nothing, or it is for another agent code — answered as a link into another office is.'))
  @ApiResponse(refusal(
    409,
    '`ORG_AGENT_ALREADY_TAGGED` — you already belong to an office. `AGENT_CODE_TAKEN` — somebody else holds the code. '
    + '`ORG_REQUEST_ALREADY_DECIDED` — the invite was accepted a moment ago, by a second tap or another tab.',
  ))
  @ApiResponse(refusal(422, '`ORG_LEADER_NOT_IN_KPM` — the leader who invited you has left the office.'))
  @ApiResponse(refusal(429, '`AUTH_RATE_LIMITED` — too many attempts from this account.'))
  async accept(@Ctx() ctx: RequestContext, @Param('token') token: string) {
    this.limit(`invite-accept:${ctx.userId}`, 20);
    return this.invites.acceptSignedIn(ctx, token);
  }
}

/**
 * **Transfer requests, decided by the office** (ADR-0170 §4, P18.8-T3 AC-3): the Owner's and an Admin's queue on
 * *All Members* › *Pending*, and the decision. `member:transfer_approve`, `own-kpm`; another office's request is 404.
 */
@ApiTags('joining an office')
@ApiBearerAuth()
@Controller('transfer-requests')
export class TransferRequestsController {
  constructor(private readonly transfers: TransfersService) {}

  @Get()
  @RequirePermission('member:transfer_approve')
  @ApiOperation({
    summary: 'Transfer requests waiting on the office',
    description: 'Every transfer a leader asked for that nobody has decided, oldest first.',
  })
  async queue(@Ctx() ctx: RequestContext) {
    return this.transfers.queue(ctx);
  }

  @Post(':transferId/approve')
  @RequirePermission('member:transfer_approve')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Approve a transfer',
    description:
      'Moves the member, and everybody under them, to the new leader: their open edge closes and a `re_parented` one '
      + 'opens (history kept), both leaders’ counts are refreshed, and the member, the leader they left and whoever '
      + 'asked are told. A move that fails leaves the request waiting. Answers the queue as it now stands. Audited.',
  })
  @ApiResponse(OK)
  @ApiResponse(refusal(404, '`NOT_FOUND` — no such request in this office, answered exactly as one in another office.'))
  @ApiResponse(refusal(
    409,
    '`ORG_REQUEST_ALREADY_DECIDED` — decided already, which way said. `ORG_CYCLE_DETECTED` — the move would make a loop. '
    + '`ORG_ALREADY_REMOVED` — they have left; the request is closed. `ORG_TRANSFER_STALE` — they report to somebody '
    + 'else since it was asked; the request is closed.',
  ))
  @ApiResponse(refusal(403, '`ORG_NOT_PERMITTED_TO_TAG` — they own the office now; moving its owner is the platform’s.'))
  @ApiResponse(refusal(422, '`ORG_LEADER_NOT_IN_KPM` — the new leader has left the office.'))
  async approve(@Ctx() ctx: RequestContext, @Param('transferId') transferId: string) {
    return this.transfers.approve(ctx, transferId);
  }

  @Post(':transferId/decline')
  @RequirePermission('member:transfer_approve')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Decline a transfer',
    description: 'Nothing about the member changes. Whoever asked is told, with the reason. Answers the queue. Audited.',
  })
  @ApiResponse(OK)
  @ApiResponse(refusal(404, '`NOT_FOUND` — no such request in this office, answered exactly as one in another office.'))
  @ApiResponse(refusal(409, '`ORG_REQUEST_ALREADY_DECIDED` — decided already, which way said.'))
  async decline(@Ctx() ctx: RequestContext, @Param('transferId') transferId: string, @Body() dto: DeclineTransferDto) {
    return this.transfers.decline(ctx, transferId, dto.reason);
  }
}
