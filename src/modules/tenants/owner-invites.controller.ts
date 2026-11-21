import { Controller, Get, HttpCode, HttpStatus, Param, Post, Req } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ApiBearerAuth, ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import type { Request } from 'express';
import { Ctx, Public, RequirePermission } from '@/common/auth/auth.decorators';
import { RequestContext } from '@/common/context/request-context';
import { DomainException } from '@/common/errors/domain.exception';
import { ErrorCode } from '@/common/errors/error-codes';
import { ApiErrorEnvelope } from '@/common/errors/error-envelope.dto';
import { RateLimiter } from '@/modules/auth/rate-limiter';
import { OWNER_CLAIM_REFUSALS } from './owner-claims.messages';
import { OwnerClaims } from './owner-claims.service';

const OK = { status: HttpStatus.OK, description: '' };
const refusal = (status: number, description: string) => ({ status, description, type: ApiErrorEnvelope });

/** How many claim-link openings one address may make an hour — an invite link's sixty (`InviteLinkController`). */
const BANNER_PER_HOUR = 60;
/** How many accepts one account may try an hour — an invite's twenty. */
const ACCEPT_PER_HOUR = 20;

/** Where the link points: the app's origin, not the API's — a person opens a page (`invites.controller.ts`). */
const appOriginOf = (config: ConfigService) => config.get<string>('APP_ORIGIN') ?? 'http://localhost:3000';

/**
 * ***Kirim undangan* by WhatsApp** (P19.23-T2 AC-3; ADR-0277; OD-420): the Super Admin asks for the KPM Owner's one-time
 * link, and their own WhatsApp opens with it (`wa.me`, OD-359). `kpm:assign_owner`, the Super Admin's alone.
 */
@ApiTags('admin (Super Admin)')
@ApiBearerAuth()
@Controller('admin')
export class OwnerWhatsAppInvitationController {
  constructor(
    private readonly claims: OwnerClaims,
    private readonly config: ConfigService,
  ) {}

  @Post('tenants/:id/owner/whatsapp-invitation')
  @RequirePermission('kpm:assign_owner')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'A one-time link to invite the KPM Owner by WhatsApp',
    description:
      '*Kirim undangan* (OD-420): nothing is sent — the answer is the link the Super Admin\'s own '
      + 'WhatsApp sends (`wa.me`, OD-359). For an Owner named with no email (`pendingOwner`), `kind: claim` — '
      + '`<app>/owner-invite/<token>`, single use, alive `ROSTER_INVITATION.TTL_DAYS`, a new one replacing the last; the '
      + 'person signs in or signs up and accepts it (`POST /owner-invites/:token/accept`). For an Owner whose account '
      + 'never signed in, `kind: password` — the email invitation\'s link to choose a password (`/reset-password/<token>`), '
      + 'the account\'s older links revoked, `memberships.invitedAt` stamped. Audited `kpm.owner_invited` with `channel: '
      + 'whatsapp`. The token is in this answer and nowhere else.',
  })
  @ApiResponse(OK)
  @ApiResponse(refusal(404, '`NOT_FOUND` — no KPM with that id: indistinguishable from another office’s.'))
  @ApiResponse(refusal(409, '`TENANT_OWNER_NOT_INVITABLE` — `details.reason` `no_owner` (nobody named) or `signed_in` '
    + '(the Owner has signed in already).'))
  @ApiResponse(refusal(429, '`AUTH_RATE_LIMITED` — more than ten links for this KPM within the hour.'))
  async invite(@Ctx() ctx: RequestContext, @Param('id') id: string) {
    return this.claims.invite(ctx, id, appOriginOf(this.config));
  }
}

/**
 * **The claim link the KPM's Owner opens** (P19.23-T2 AC-3; OD-420): its banner, public, and accepting it, signed in.
 * The token is a credential to own a KPM: redacted from every log line (`redact-url.ts`).
 */
@ApiTags('joining an office')
@Controller('owner-invites')
export class OwnerInvitesController {
  constructor(
    private readonly claims: OwnerClaims,
    private readonly limiter: RateLimiter,
  ) {}

  /** Rate limited as the other public links are: `max` an hour against one key. */
  private limit(key: string, max: number): void {
    const retryAfter = this.limiter.check(key, max, 60 * 60);
    if (retryAfter === null) return;
    throw new DomainException(
      ErrorCode.AUTH_RATE_LIMITED,
      OWNER_CLAIM_REFUSALS.AUTH_RATE_LIMITED.tooMany({ minutes: Math.ceil(retryAfter / 60) }),
      HttpStatus.TOO_MANY_REQUESTS,
      { retryAfterSeconds: retryAfter },
    );
  }

  @Public()
  @Get(':token')
  @ApiOperation({
    summary: 'What an owner invitation link is for',
    description:
      'The banner `/owner-invite/<token>` shows: the KPM\'s name and code, its company and the person named as its '
      + 'Owner, and when the link stops working. **Public** — the person may have no account yet — and rate limited per '
      + 'address, sixty an hour. A link that opens nothing — unknown, replaced, used, expired, or a KPM archived or '
      + 'already owned — is `404 NOT_FOUND`, its sentence saying which.',
  })
  @ApiResponse(OK)
  @ApiResponse(refusal(404, '`NOT_FOUND` — the link opens nothing, said in plain words — answered as a link into another '
    + 'office is.'))
  @ApiResponse(refusal(429, '`AUTH_RATE_LIMITED` — too many link openings from this address.'))
  async banner(@Param('token') token: string, @Req() req: Request) {
    this.limit(`owner-invite-link:ip:${req.ip ?? 'unknown'}`, BANNER_PER_HOUR);
    return this.claims.banner(token);
  }

  @ApiBearerAuth()
  @Post(':token/accept')
  @RequirePermission('join_via_code_link_qr')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Accept an owner invitation, signed in',
    description:
      'The signed-in account becomes the KPM\'s Owner — its root AB — through the checks every Owner meets, asked '
      + '**before** the link is spent: the KPM\'s company and an agent code, and a verified address. Then the link is '
      + 'used (single use), the Owner written only while the KPM has none, `pendingOwner` cleared, and the claim audited '
      + 'in the KPM\'s log as `kpm.owner_assigned` (`via: whatsapp_claim`). Refused in a support session, which only '
      + 'looks. Rate limited per account, twenty an hour.',
  })
  @ApiResponse(OK)
  @ApiResponse(refusal(404, '`NOT_FOUND` — the link opens nothing (unknown, replaced, used, expired), or the KPM got its '
    + 'Owner meanwhile — answered as a link into another office is.'))
  @ApiResponse(refusal(409, '`TENANT_COMPANY_MISMATCH` — the account is of another company, or has no agent code. '
    + '`AUTH_EMAIL_NOT_VERIFIED` — verify the address first. `LEADER_LIMIT_REACHED` — the KPM has no leader seat left.'))
  @ApiResponse(refusal(429, '`AUTH_RATE_LIMITED` — too many attempts from this account.'))
  async accept(@Ctx() ctx: RequestContext, @Param('token') token: string) {
    this.limit(`owner-invite-accept:${ctx.userId}`, ACCEPT_PER_HOUR);
    return this.claims.accept(ctx, token);
  }
}
