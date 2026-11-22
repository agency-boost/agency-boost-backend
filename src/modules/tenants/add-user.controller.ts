import { Body, Controller, Delete, Get, HttpCode, HttpStatus, Param, Post, Query, Req } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ApiBearerAuth, ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import type { Request } from 'express';
import { Ctx, Public, RequirePermission } from '@/common/auth/auth.decorators';
import { RequestContext } from '@/common/context/request-context';
import { DomainException } from '@/common/errors/domain.exception';
import { ErrorCode } from '@/common/errors/error-codes';
import { ApiErrorEnvelope } from '@/common/errors/error-envelope.dto';
import { RateLimiter } from '@/modules/auth/rate-limiter';
import { AddUserDto, AddUserOptionsQueryDto, PlaceUserDto } from './add-user.dto';
import { ADD_USER_REFUSALS } from './add-user.messages';
import { AddUserService, USER_INVITATION_RESEND_LIMIT } from './add-user.service';

const OK = { status: HttpStatus.OK, description: '' };
const refusal = (status: number, description: string) => ({ status, description, type: ApiErrorEnvelope });
/** Where a link points: the app's origin, not the API's — a person opens a page (`invites.controller.ts`). */
const appOriginOf = (config: ConfigService) => config.get<string>('APP_ORIGIN') ?? 'http://localhost:3000';

/** How many link openings one address may make an hour — an invite link's sixty (`InviteLinkController`). */
const BANNER_PER_HOUR = 60;
/** How many accepts one account may try an hour — an invite's twenty. */
const ACCEPT_PER_HOUR = 20;

function limited(limiter: RateLimiter, key: string, max: number): void {
  const retryAfter = limiter.check(key, max, 60 * 60);
  if (retryAfter === null) return;
  throw new DomainException(
    ErrorCode.AUTH_RATE_LIMITED,
    ADD_USER_REFUSALS.AUTH_RATE_LIMITED.tooMany({ minutes: Math.ceil(retryAfter / 60) }),
    HttpStatus.TOO_MANY_REQUESTS,
    { retryAfterSeconds: retryAfter },
  );
}

const WHERE =
  'The Super Admin names any KPM (`kpmId`, or the KPM they work inside); an Owner or a KPM Admin adds to their own, '
  + 'and naming another is `404`, exactly as a KPM that is not there.';

const ADD_REFUSALS = [
  refusal(400, '`VALIDATION_FAILED` — a field’s shape; a number that is not 9 to 13 digits after `+62`; no KPM; both a '
    + 'KPM and a new one; no role; a leader for an AB, or none for anybody else.'),
  refusal(403, '`PERM_DENIED` — an AB, an AAB, an Agent or a support session; `newKpm` by anybody but the Super Admin; '
    + '`makeOwner` by a KPM Admin.'),
  refusal(404, '`NOT_FOUND` — the KPM is archived or not there, or the company is not; answered as another office’s KPM is.'),
  refusal(409, '`ORG_LEVEL_NOT_ON_LADDER` — a role the company does not publish. '
    + '`ORG_AGENT_ALREADY_TAGGED` — the number or email belongs to somebody already *Aktif* in this KPM or '
    + 'another (named to the Super Admin alone), or to the AgencyBoost team. `ORG_INVITE_PENDING` — an invitation for the '
    + 'number already waits in this KPM. `TENANT_COMPANY_MISMATCH` (placement) — the account is of another company, or has '
    + 'no agent code. `LEADER_LIMIT_REACHED` — the KPM has no leader seat left.'),
  refusal(422, '`ORG_LEADER_NOT_IN_KPM` — the leader is not an active AB or AAB of the KPM.'),
];

/**
 * ***Tambah user*** (P19.28-T1; ADR-0286; F-1 (21 Nov)): the shared sheet's invitation, its choices, *Kirim ulang* and
 * *Batalkan*. `member:add` — the Super Admin in any KPM, an Owner or a KPM Admin in their own.
 */
@ApiTags('people (add & place)')
@ApiBearerAuth()
@Controller('user-invitations')
export class AddUserController {
  constructor(
    private readonly service: AddUserService,
    private readonly config: ConfigService,
    private readonly limiter: RateLimiter,
  ) {}

  @Get('options')
  @RequirePermission('member:add')
  @ApiOperation({
    summary: 'Who a person can be in a KPM',
    description:
      '*Pilih KPM*’s next step on the sheet: the KPM’s company ladder for *Peran* (junior rung first), its active ABs and '
      + 'AABs for *Leader* (ABs first; test accounts never), and whether the reader may switch *Jadikan KPM Owner* and '
      + 'choose *＋ KPM baru*. With `companyId` alone — *＋ KPM baru*, the Super Admin’s — the company’s ladder. ' + WHERE,
  })
  @ApiResponse(OK)
  @ApiResponse(refusal(403, '`PERM_DENIED` — an AB, an AAB or an Agent; `companyId` alone by anybody but the Super Admin.'))
  @ApiResponse(refusal(404, '`NOT_FOUND` — an archived KPM or none, or a company that is not there; answered as another office’s KPM is.'))
  async options(@Ctx() ctx: RequestContext, @Query() query: AddUserOptionsQueryDto) {
    return this.service.options(ctx, query);
  }

  @Post()
  @RequirePermission('member:add')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Tambah user — invite a person to a KPM',
    description:
      'The sheet’s *Tambah & kirim undangan WhatsApp*: an invitation carrying the KPM, the rung, the leader and *Jadikan '
      + 'KPM Owner*, and its one-time link — `<app>/user-invite/<token>`, alive `INVITES.EXPIRY_DAYS` — which the reader’s '
      + 'own WhatsApp sends (`wa.me`, OD-359; nothing is sent from the server). The person reads *Diundang · hari ini* in '
      + 'Anggota’s *Menunggu* until they accept, then is *Aktif*. **`newKpm`** (the Super Admin’s): the KPM is made from '
      + 'its company’s template with an automatic code, and the invitation is to its senior rung as its first owner — '
      + 'in one step; a failure discards the KPM. ' + WHERE + ' Audited `user_invitation.created` in the KPM’s log.',
  })
  @ApiResponse(OK)
  @ApiResponse(ADD_REFUSALS[0])
  @ApiResponse(ADD_REFUSALS[1])
  @ApiResponse(ADD_REFUSALS[2])
  @ApiResponse(ADD_REFUSALS[3])
  @ApiResponse(ADD_REFUSALS[4])
  async add(@Ctx() ctx: RequestContext, @Body() dto: AddUserDto) {
    return this.service.add(ctx, dto, appOriginOf(this.config));
  }

  @Post(':invitationId/resend')
  @RequirePermission('member:add')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Kirim ulang — a new link for an invitation',
    description:
      'A new link and `INVITES.EXPIRY_DAYS` more; the old link opens nothing now, and the row reads *Diundang · hari ini*. '
      + 'An expired invitation is revived. Answers the link once. ' + WHERE + ' Audited `user_invitation.resent`.',
  })
  @ApiResponse(OK)
  @ApiResponse(refusal(404, '`NOT_FOUND` — no such invitation, or one in another office, answered alike.'))
  @ApiResponse(refusal(409, '`ORG_REQUEST_ALREADY_DECIDED` — it was accepted or cancelled.'))
  @ApiResponse(refusal(429, `\`AUTH_RATE_LIMITED\` — more than ${USER_INVITATION_RESEND_LIMIT} new links for it within the hour.`))
  async resend(@Ctx() ctx: RequestContext, @Param('invitationId') invitationId: string) {
    return this.service.resend(
      ctx, invitationId, appOriginOf(this.config), (key) => limited(this.limiter, key, USER_INVITATION_RESEND_LIMIT),
    );
  }

  @Delete(':invitationId')
  @RequirePermission('member:add')
  @ApiOperation({
    summary: 'Batalkan — cancel an invitation',
    description:
      'Its link opens nothing from now on. The row stays, cancelled, as the record of who invited whom; it never '
      + 'counted. ' + WHERE + ' Audited `user_invitation.cancelled`.',
  })
  @ApiResponse(OK)
  @ApiResponse(refusal(404, '`NOT_FOUND` — no such invitation, or one in another office, answered alike.'))
  @ApiResponse(refusal(409, '`ORG_REQUEST_ALREADY_DECIDED` — it was accepted or cancelled already.'))
  async cancel(@Ctx() ctx: RequestContext, @Param('invitationId') invitationId: string) {
    return this.service.cancel(ctx, invitationId);
  }
}

/**
 * ***Masukkan ke KPM*** (P19.28-T1 AC-2; ADR-0286 §3): an account registered and not placed, placed now. `member:place`,
 * the Super Admin's alone.
 */
@ApiTags('admin (Super Admin)')
@ApiBearerAuth()
@Controller('admin')
export class PlacementController {
  constructor(
    private readonly service: AddUserService,
    private readonly config: ConfigService,
  ) {}

  @Post('accounts/:userId/placement')
  @RequirePermission('member:place')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Masukkan — place an account that has no KPM',
    description:
      'Anggota › *Menunggu* › *Belum ada KPM* › **Masukkan**: the account — registered, and in no KPM or only waiting in '
      + 'one nobody placed them in — gets an *Aktif* membership in the KPM now, on the rung and under the leader chosen, an '
      + 'existing agent (no activation starts), and an owner when *Jadikan KPM Owner* is on. The membership they waited in '
      + 'is ended and soft-deleted, its open join requests cancelled. **`newKpm`**: the KPM is made from its company’s '
      + 'template and the person is its senior rung and first owner, in one step. **Nothing is left on a failure**: every '
      + 'write is undone and a KPM made here discarded. The person is told in the app (OD-442); the WhatsApp half is the '
      + 'screen’s own link. Audited `member.placed` in the KPM’s log, before → after.',
  })
  @ApiResponse(OK)
  @ApiResponse(refusal(400, '`VALIDATION_FAILED` — no KPM, both a KPM and a new one, no role, a leader for an AB or none '
    + 'for anybody else.'))
  @ApiResponse(refusal(403, '`PERM_DENIED` — anybody but the Super Admin, a support session included.'))
  @ApiResponse(refusal(404, '`NOT_FOUND` — no such account, KPM or company: another office is never the reason.'))
  @ApiResponse(refusal(409, '`ORG_LEVEL_NOT_ON_LADDER` — a role the company does not publish. '
    + '`ORG_AGENT_ALREADY_TAGGED` — the account is *Aktif* in a KPM already, or is the AgencyBoost '
    + 'team’s. `TENANT_COMPANY_MISMATCH` — the account is of another company, or has no agent code. '
    + '`LEADER_LIMIT_REACHED` — no leader seat left.'))
  @ApiResponse(refusal(422, '`ORG_LEADER_NOT_IN_KPM` — the leader is not an active AB or AAB of the KPM.'))
  async place(@Ctx() ctx: RequestContext, @Param('userId') userId: string, @Body() dto: PlaceUserDto) {
    return this.service.place(ctx, userId, dto, appOriginOf(this.config));
  }
}

/**
 * **The invitation link** (`/user-invite/<token>`; P19.28-T1 AC-4): its banner, public, and accepting it, signed in. The
 * token is a credential to join a KPM: redacted from every log line (`redact-url.ts`).
 */
@ApiTags('joining an office')
@Controller('user-invites')
export class UserInviteLinkController {
  constructor(
    private readonly service: AddUserService,
    private readonly limiter: RateLimiter,
  ) {}

  @Public()
  @Get(':token')
  @ApiOperation({
    summary: 'What a Tambah user invitation link is for',
    description:
      'The banner `/user-invite/<token>` shows: the KPM’s name and code, its company, the name the inviter typed, the '
      + 'role, whether it makes them an owner, and when the link stops working. **Public** — the person may have no '
      + `account yet — and rate limited per address, ${BANNER_PER_HOUR} an hour. A link that opens nothing — unknown, `
      + 'used, cancelled, expired, or a KPM archived or ended — is `404 NOT_FOUND`, its sentence saying which.',
  })
  @ApiResponse(OK)
  @ApiResponse(refusal(404, '`NOT_FOUND` — the link opens nothing, said in plain words — answered as a link into another office is.'))
  @ApiResponse(refusal(429, '`AUTH_RATE_LIMITED` — too many link openings from this address.'))
  async banner(@Param('token') token: string, @Req() req: Request) {
    limited(this.limiter, `user-invite-link:ip:${req.ip ?? 'unknown'}`, BANNER_PER_HOUR);
    return this.service.banner(token);
  }

  @ApiBearerAuth()
  @Post(':token/accept')
  @RequirePermission('join_via_code_link_qr')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Accept a Tambah user invitation, signed in',
    description:
      'The signed-in account becomes an *Aktif* member of the KPM on the invitation’s rung, under its leader — and an '
      + 'owner when it says so — checked **before** the link is spent: the account it was sent to (if one), the KPM’s '
      + 'company and an agent code, no active membership anywhere, the leader still a member. A membership the account '
      + `waited in elsewhere is ended. Single use. Rate limited per account, ${ACCEPT_PER_HOUR} an hour. Audited `
      + '`user_invitation.accepted`.',
  })
  @ApiResponse(OK)
  @ApiResponse(refusal(404, '`NOT_FOUND` — the link opens nothing (unknown, used, cancelled, expired), or it is for '
    + 'another account — answered as a link into another office is.'))
  @ApiResponse(refusal(409, '`ORG_AGENT_ALREADY_TAGGED` — you are already a member of a KPM. `TENANT_COMPANY_MISMATCH` — '
    + 'your account is of another company or has no agent code. `LEADER_LIMIT_REACHED` — no leader seat left.'))
  @ApiResponse(refusal(422, '`ORG_LEADER_NOT_IN_KPM` — the leader who was chosen has left the KPM.'))
  @ApiResponse(refusal(429, '`AUTH_RATE_LIMITED` — too many attempts from this account.'))
  async accept(@Ctx() ctx: RequestContext, @Param('token') token: string) {
    limited(this.limiter, `user-invite-accept:${ctx.userId}`, ACCEPT_PER_HOUR);
    return this.service.accept(ctx, token);
  }
}
