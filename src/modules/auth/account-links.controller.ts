import { Body, Controller, Delete, HttpCode, HttpStatus, Param, Post, Req, Res } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ApiBearerAuth, ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import type { CookieOptions, Request, Response } from 'express';
import { Ctx, Public, RefuseInSupportSession, RequirePermission } from '@/common/auth/auth.decorators';
import { RequestContext } from '@/common/context/request-context';
import { DomainException } from '@/common/errors/domain.exception';
import { ApiErrorEnvelope } from '@/common/errors/error-envelope.dto';
import { ErrorCode } from '@/common/errors/error-codes';
import { readerOfRequest } from '@/common/i18n/reader';
import { corsOriginsOf } from '@/config/cors-origins';
import { AccountLinksService } from './account-links.service';
import { AccessTokenDto, StatusAckDto } from './session.response.dto';
import { AUTH_REFUSALS } from './auth.messages';
import { ConfirmLinkDto, StartLinkDto, SwitchLinkDto } from './auth.dto';
import {
  LINKED_REFRESH_COOKIE, REFRESH_COOKIE, REFRESH_COOKIE_MAX_AGE_MS, refreshCookieOptions,
} from './refresh-cookie';
import { isForeignOrigin, ownOriginOf } from './request-origin';

const envelope = (status: number, description: string) => ({ status, description, type: ApiErrorEnvelope });

/*
 * Each success is stated because a failure is: Swagger drops the success it would infer once any response is declared,
 * as `AuthController` notes on sign-in.
 */

/** What every route that sets or swaps a session cookie answers a page on another origin (P18.4-T1). */
const ORIGIN_REFUSED = envelope(
  HttpStatus.FORBIDDEN,
  '`AUTH_ORIGIN_REFUSED`: an `Origin` that is neither one `CORS_ORIGINS` lists nor the API\'s own. A request with no '
    + '`Origin` is not refused.',
);

/**
 * **Linked logins** (UI-169 item 5; [ADR-0199](../../../../docs/04-adr/0199-a-second-login-is-linked-through-its-own-mailbox-and-password.md)):
 * *Tambah akun*, the link's page, the switch between the two logins and *Hapus tautan*.
 *
 * **Two cookies, one session each.** The active login's refresh token is `agencyboost_refresh`, as it has always been;
 * the other login's, when it is signed in on this browser too, is `agencyboost_refresh_linked`, with the same attributes.
 * A switch swaps them and answers the other login's access token; nothing here makes a session for one login out of the
 * other's. Every route that sets a cookie refuses a page on another origin first, as sign-in and refresh do, and every
 * route but the link's own page is refused in any support session (ADR-0199 §7).
 */
@ApiTags('auth')
@Controller('auth/links')
export class AccountLinksController {
  constructor(
    private readonly links: AccountLinksService,
    private readonly config: ConfigService,
  ) {}

  @ApiBearerAuth()
  @Post()
  @RequirePermission('account_link:create')
  @RefuseInSupportSession()
  @HttpCode(HttpStatus.ACCEPTED)
  @ApiOperation({
    summary: 'Link another login: send a link to its address',
    description:
      '*Tambah akun* (ADR-0199 §2). `{ email, currentPassword }`. Your password is checked first (`401 '
      + 'AUTH_INVALID_CREDENTIALS`, as `change-password`); your own address is `400 VALIDATION_FAILED` with '
      + '`details.field: email`; a login already linked is `409 AUTH_LINK_EXISTS`; your address unverified is `409 '
      + 'AUTH_EMAIL_NOT_VERIFIED`. **Then `202` whatever the other address is**: a link goes to it only when it is a live, '
      + 'active and unlinked login of a KPM Owner, a KPM Admin or a Super Admin, with a notice to your own address; for '
      + 'anything else nothing is sent, and the answer is the same. A newer start replaces the pending one, and so does a '
      + 'password change. 5 per hour per account (`429 AUTH_RATE_LIMITED`). Refused `403 PERM_DENIED` in any support '
      + 'session.',
  })
  @ApiResponse({ status: HttpStatus.ACCEPTED, description: '', type: StatusAckDto })
  @ApiResponse(envelope(HttpStatus.UNAUTHORIZED, '`AUTH_INVALID_CREDENTIALS` — your current password is not correct.'))
  @ApiResponse(envelope(HttpStatus.CONFLICT, '`AUTH_LINK_EXISTS` or `AUTH_EMAIL_NOT_VERIFIED`, about your own login.'))
  @ApiResponse(envelope(HttpStatus.TOO_MANY_REQUESTS, '`AUTH_RATE_LIMITED`; `details.retryAfterSeconds`.'))
  async start(@Ctx() ctx: RequestContext, @Body() dto: StartLinkDto, @Req() req: Request) {
    await this.links.start(ctx, dto.email, dto.currentPassword, readerOfRequest(req));
    return { status: 'accepted' };
  }

  @Public()
  @Post('confirm')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Confirm a link with the other login\'s password',
    description:
      'Sent when the link page\'s button is pressed, never when it loads (ADR-0199 §2). `{ token, password }` — the token '
      + 'from the email, and the password of the login it was sent to. `200 { status: \'linked\' }` links the two logins, '
      + 'marks that address verified and tells both addresses; where this browser holds the starting login\'s session, the '
      + 'other login is signed in here too (`agencyboost_refresh_linked`). Refusals: `400 AUTH_TOKEN_INVALID` — unknown, '
      + 'spent, replaced or expired; `401 AUTH_INVALID_CREDENTIALS` — that password is wrong, counted by the sign-in limiter '
      + 'for the address and the client; `409 AUTH_LINK_EXISTS` — either login linked since; `403 AUTH_ACCOUNT_DEACTIVATED` '
      + '— either deactivated since; `403 PERM_DENIED` — either no longer a KPM Owner\'s, a KPM Admin\'s or a Super '
      + 'Admin\'s; `429 AUTH_RATE_LIMITED`.',
  })
  @ApiResponse({ status: HttpStatus.OK, description: '', type: StatusAckDto })
  @ApiResponse(ORIGIN_REFUSED)
  @ApiResponse(envelope(HttpStatus.CONFLICT, '`AUTH_LINK_EXISTS` — one of the two logins was linked since.'))
  async confirm(@Body() dto: ConfirmLinkDto, @Req() req: Request, @Res({ passthrough: true }) res: Response) {
    // Before anything is read: the answer may set a cookie on this browser.
    this.refuseForeignOrigin(req);
    const confirmed = await this.links.confirm(dto.token, dto.password, this.cookie(req, REFRESH_COOKIE), this.meta(req));
    if (confirmed.linkedRefreshToken) this.setCookie(res, LINKED_REFRESH_COOKIE, confirmed.linkedRefreshToken);
    return { status: 'linked' };
  }

  @ApiBearerAuth()
  @Post('switch')
  @RequirePermission('account_link:manage_self')
  @RefuseInSupportSession()
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Switch to your linked login',
    description:
      'ADR-0199 §4. `{ userId, password? }`. Answers the linked login\'s access token, and the two refresh cookies change '
      + 'places: yours, unchanged, becomes `agencyboost_refresh_linked`; the linked login\'s, rotated, becomes '
      + '`agencyboost_refresh`. **No session is ever made from yours**: this browser must hold the linked login\'s own live '
      + 'session — else `409 AUTH_LINK_SIGN_IN_REQUIRED`, and the same call with its `password` signs it in here, by the '
      + 'sign-in limiter (`401 AUTH_INVALID_CREDENTIALS` for a wrong one). `404` for a login not linked to yours, a removed '
      + 'link or a deleted login; `403 AUTH_ACCOUNT_DEACTIVATED` for a deactivated one. 30 a minute without a password. '
      + 'Refused `403 PERM_DENIED` in any support session.',
  })
  @ApiResponse({ status: HttpStatus.OK, description: '', type: AccessTokenDto })
  @ApiResponse(ORIGIN_REFUSED)
  @ApiResponse(envelope(
    HttpStatus.NOT_FOUND,
    '`NOT_FOUND` — no login linked to yours by that id: never linked, removed or deleted, or a login of another office. '
      + 'The cases are deliberately indistinguishable.',
  ))
  @ApiResponse(envelope(HttpStatus.CONFLICT, '`AUTH_LINK_SIGN_IN_REQUIRED` — send that login\'s `password`.'))
  @ApiResponse(envelope(HttpStatus.TOO_MANY_REQUESTS, '`AUTH_RATE_LIMITED`; `details.retryAfterSeconds`.'))
  async switchLogin(
    @Ctx() ctx: RequestContext,
    @Body() dto: SwitchLinkDto,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ) {
    this.refuseForeignOrigin(req);
    const { pair, parked } = await this.links.switchTo(
      ctx, dto.userId, dto.password, this.cookie(req, LINKED_REFRESH_COOKIE), this.cookie(req, REFRESH_COOKIE), this.meta(req),
    );
    this.setCookie(res, REFRESH_COOKIE, pair.refreshToken);
    if (parked) this.setCookie(res, LINKED_REFRESH_COOKIE, parked);
    else res.clearCookie(LINKED_REFRESH_COOKIE, this.cookieOptions());
    return { accessToken: pair.accessToken, expiresIn: pair.expiresIn };
  }

  @ApiBearerAuth()
  @Delete(':linkId')
  @RequirePermission('account_link:manage_self')
  @RefuseInSupportSession()
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({
    summary: 'Remove the link to your other login',
    description:
      '*Hapus tautan* (ADR-0199 §5), by either login of the pair, with no password: removing reaches nothing. The link is '
      + 'soft-deleted, the linked login\'s session parked on this browser is let go (`agencyboost_refresh_linked` cleared) '
      + 'and it leaves the account menu at once; its own sessions elsewhere are its own. Refused `403 PERM_DENIED` in any '
      + 'support session.',
  })
  @ApiResponse({ status: HttpStatus.NO_CONTENT, description: '' })
  async remove(@Ctx() ctx: RequestContext, @Param('linkId') linkId: string, @Res({ passthrough: true }) res: Response) {
    await this.links.remove(ctx, linkId);
    res.clearCookie(LINKED_REFRESH_COOKIE, this.cookieOptions());
  }

  // --------------------------------------------------------------------------- cookies

  private cookieOptions(): CookieOptions {
    return refreshCookieOptions({
      // Compared to `true`, as `AuthController` does: anything else is a misconfiguration, never "loosen the cookie".
      crossSite: this.config.get<boolean>('COOKIE_CROSS_SITE') === true,
      nodeEnv: this.config.get<string>('NODE_ENV') ?? 'development',
    });
  }

  private setCookie(res: Response, name: string, token: string): void {
    res.cookie(name, token, { ...this.cookieOptions(), maxAge: REFRESH_COOKIE_MAX_AGE_MS });
  }

  private cookie(req: Request, name: string): string | null {
    return (req.cookies as Record<string, string> | undefined)?.[name] ?? null;
  }

  private meta(req: Request): { ip: string | null; userAgent: string | null } {
    return { ip: req.ip ?? null, userAgent: req.headers['user-agent'] ?? null };
  }

  /** `AuthController.refuseForeignOrigin`: a page on another origin may not set, spend or swap this browser's session. */
  private refuseForeignOrigin(req: Request): void {
    const own = ownOriginOf(req);
    const allowed = [...corsOriginsOf(this.config.get<string>('CORS_ORIGINS')), ...(own ? [own] : [])];
    if (!isForeignOrigin(req.headers.origin, allowed)) return;
    throw new DomainException(
      ErrorCode.AUTH_ORIGIN_REFUSED,
      AUTH_REFUSALS.AUTH_ORIGIN_REFUSED.foreignSite,
      HttpStatus.FORBIDDEN,
    );
  }
}
