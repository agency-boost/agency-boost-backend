import {
  Body, Controller, Get, HttpCode, HttpStatus, Patch, Post, Req, Res, Delete, Optional, Param, Inject,
} from '@nestjs/common';
import { ApiBearerAuth, ApiBody, ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { ConfigService } from '@nestjs/config';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import type { CookieOptions, Request, Response } from 'express';
import {
  AllowTemporaryPassword, AllowWhileReadOnly, Ctx, Public, RefuseInSupportSession,
} from '@/common/auth/auth.decorators';
import { RequestContext } from '@/common/context/request-context';
import { DomainException } from '@/common/errors/domain.exception';
import { ErrorCode } from '@/common/errors/error-codes';
import { AUTH_REFUSALS } from './auth.messages';
import { readerOfRequest } from '@/common/i18n/reader';
import { ApiErrorEnvelope } from '@/common/errors/error-envelope.dto';
import { isLanguage, languageOf, REGISTRATION } from '@/domain/constants';
import { corsOriginsOf } from '@/config/cors-origins';
import { initialsOf, User, UserDocument } from '@/modules/users/user.schema';
import { preferredNameOf } from '@/modules/users/display-name';
import { MembershipRepository } from '@/modules/org/membership.repository';
import {
  LINKED_REFRESH_COOKIE, REFRESH_COOKIE, REFRESH_COOKIE_MAX_AGE_MS, refreshCookieOptions,
} from '@/modules/auth/refresh-cookie';
import { isForeignOrigin, ownOriginOf } from '@/modules/auth/request-origin';
import { AccessTokenDto } from '@/modules/auth/session.response.dto';
import { can, PERMISSIONS, Permission } from '@/modules/rbac/permissions';
import { ActivationNav, activationNavFor } from '@/modules/activation/activation-nav.port';
import { ProfileLineReader, profileLineFor } from '@/modules/org/profile-line';
import { InvitesService } from '@/modules/org/invites.service';
import { LeaderCodeService } from '@/modules/org/leader-code.service';
import { AvatarLinks } from '@/modules/users/avatar.service';
import { BrandingReader } from '@/modules/branding/branding-reader';
import { AuthService } from './auth.service';
import { AccountLinksService } from './account-links.service';
import { RateLimiter } from './rate-limiter';
import {
  ChangeEmailDto, ChangePasswordDto, ForgotPasswordDto, LoginDto, RefreshDto, RegisterDto,
  ResetPasswordDto, TokenDto, UpdateProfileDto,
} from './auth.dto';

/**
 * The refresh token travels as an httpOnly cookie, never in the response body.
 *
 * A body value has to be stored somewhere JavaScript can read, which makes any XSS a
 * full account takeover. The cookie is unreachable from script, and `SameSite=Lax`
 * keeps it off cross-site requests. This is what
 * docs/02-specs/api/auth-and-sessions.md specifies.
 *
 * Swagger still works: the browser holds the cookie, so /auth/refresh and /auth/logout
 * succeed from the UI without pasting anything.
 *
 * Its name, and the linked login's beside it (ADR-0199 §4), live in `refresh-cookie.ts` with their attributes.
 */

const LOGIN_WINDOW_SECONDS = 15 * 60;
const FORGOT_LIMIT = 3;
const FORGOT_WINDOW_SECONDS = 60 * 60;
const RESEND_LIMIT = 3;
const RESEND_WINDOW_SECONDS = 60 * 60;

/**
 * Email changes asked for, per account, per hour (UI-111, ADR-0181 §2). A person changes their address once and maybe
 * corrects a typo; five is far above that and far below what probing whether addresses have accounts would need — the
 * `409` says so, behind the session and the password.
 */
const EMAIL_CHANGE_LIMIT = 5;
const EMAIL_CHANGE_WINDOW_SECONDS = 60 * 60;

/**
 * Refreshing, per session, **per minute** (P4-T13; *changed 2026-11-04*, P19-T5 AC-3, UI-125).
 *
 * A refresh rotates the token, and a healthy client asks about four times an hour on a fifteen-minute access token —
 * **plus once for every page the browser loads in full**: the access token lives in memory only, so typing an address,
 * reloading, or opening a link in a new tab costs a refresh. It was sixty an hour, and that was production's 429s: a
 * Super Admin walking the console by address at four window sizes spent the hour's sixty, every refresh after was
 * `429` for the rest of the hour, and the app read each as *no session* and sent them to sign in (the phase file's
 * *Progress*, AC-3). Thirty a minute is a page load every two seconds, sustained, and still far below a client stuck in
 * a loop, which asks many times a second; and a refusal now lasts a minute at most, which the client waits out
 * (`retryAfterSeconds`, `api-client.ts`) without signing anybody out.
 */
export const REFRESH_LIMIT = 30;
export const REFRESH_WINDOW_SECONDS = 60;

/** What `/auth/refresh` and `/auth/logout` answer a page on a foreign origin (P18.4-T1), as Swagger shows it. */
const ORIGIN_REFUSED_RESPONSE = {
  status: HttpStatus.FORBIDDEN,
  description:
    '`AUTH_ORIGIN_REFUSED`: the refresh cookie arrived with an `Origin` that is neither one `CORS_ORIGINS` '
    + 'lists nor the API\'s own. A request with no `Origin` is not refused.',
  type: ApiErrorEnvelope,
};

/**
 * What `/auth/refresh` answers when it cannot refresh (ADR-0168 §1), in its description rather than as a declared
 * `401`: a public route declares none (`openapi.spec.ts`, AC-3), as `/auth/login` declares none for a wrong password.
 * Two codes, because the browser tells a reader whose session ended from one who never had one by them, and nothing
 * more.
 */
const REFRESH_REFUSED =
  'A refusal is `401`. `AUTH_TOKEN_INVALID`: no refresh token at all, in the cookie or the body — there is no '
  + 'session to refresh. `AUTH_SESSION_ENDED`: a refresh token was presented and no longer works — unknown or '
  + 'malformed, expired, revoked or already rotated away; which of them is not said.';

/** The limiter's key for sign-ups from one client address (`REGISTRATION`; the P18.8 exit review, L2). */
export const registrationLimitKey = (ip: string): string => `register:ip:${ip}`;

/** What `/auth/login` answers a page on a foreign origin (P18.4-T1), cookie or not. */
const LOGIN_ORIGIN_REFUSED_RESPONSE = {
  status: HttpStatus.FORBIDDEN,
  description:
    '`AUTH_ORIGIN_REFUSED`: an `Origin` that is neither one `CORS_ORIGINS` lists nor the API\'s own, with or '
    + 'without a cookie. A request with no `Origin` is not refused.',
  type: ApiErrorEnvelope,
};

@ApiTags('auth')
@Controller('auth')
export class AuthController {
  constructor(
    private readonly auth: AuthService,
    private readonly limiter: RateLimiter,
    private readonly config: ConfigService,
    @InjectModel(User.name) private readonly users: Model<UserDocument>,
    /** Work status is the membership's (ADR-0158 §1), so `/auth/me` reads and writes it there. */
    private readonly members: MembershipRepository,
    /*
     * P13-T7 AC-5: the *New agent* section's two facts, served with the session. A port, so the auth
     * module does not depend on activation; optional, so a harness without it answers *nothing to show*.
     */
    @Optional() @Inject(ActivationNav) private readonly activationNav: ActivationNav | null = null,
    /*
     * P18.5-T6 AC-1: the groups and the office on the sidebar's profile line (ADR-0159 §5). Optional by its token,
     * as the port above, so a harness without it answers the role alone.
     */
    @Optional() @Inject(ProfileLineReader) private readonly profileLine: ProfileLineReader | null = null,
    /*
     * P18.8-T3 AC-4: registration on a leader's invite joins the office. By its token, as the ports above, so a
     * harness that never registers on an invite builds this without the org module's graph.
     */
    @Optional() @Inject(InvitesService) private readonly invites: InvitesService | null = null,
    /*
     * P19.10-T1 AC-1 (ADR-0236 §1): registration on a leader's link joins the code's leader's unit. By its token, as
     * the invite above.
     */
    @Optional() @Inject(LeaderCodeService) private readonly leaderCodes: LeaderCodeService | null = null,
    /*
     * **The photo's signed link** (UI V1, UI-111): `users.avatarUrl` holds the photo's storage key and the bucket is
     * private, so `/auth/me` signs a link for the title row and the *Lainnya* sheet. Optional, as the readers above are:
     * a spec that builds this controller for something else reads no photo, `null`, and the initials are drawn.
     */
    @Optional() @Inject(AvatarLinks) private readonly avatarLinks: AvatarLinks | null = null,
    /*
     * **The linked login** (UI-169 item 5; ADR-0199 §3): `GET /auth/me`'s `linkedLogin`. Optional, as the readers above
     * are: a harness that builds this controller for something else answers `null`, no link.
     */
    @Optional() @Inject(AccountLinksService) private readonly accountLinks: AccountLinksService | null = null,
    /*
     * **The KPM's branding** (P19.6-T1 AC-12; ADR-0218 §8): `GET /auth/me`'s `branding`, so the colours arrive with the
     * session and no second call is made. Optional, as the readers above: a harness without it answers `null`.
     */
    @Optional() @Inject(BrandingReader) private readonly branding: BrandingReader | null = null,
  ) {}

  /**
   * The login limit, **read from the environment**.
   *
   * `RATE_LIMIT_LOGIN_PER_15M` has been validated at boot since Phase 1 and read by
   * nothing: `LOGIN_LIMIT` was a literal here, so changing the variable did nothing and
   * an operator tightening it under attack would have had no effect and no clue why.
   */
  private get loginLimit(): number {
    return this.config.get<number>('RATE_LIMIT_LOGIN_PER_15M') ?? 5;
  }

  private refreshCookieOptions(): CookieOptions {
    return refreshCookieOptions({
      // Compared to `true` rather than tested for truthiness: validateEnv hands back a
      // real boolean, and anything else reaching here is a misconfiguration that must not
      // be read as "loosen the cookie".
      crossSite: this.config.get<boolean>('COOKIE_CROSS_SITE') === true,
      nodeEnv: this.config.get<string>('NODE_ENV') ?? 'development',
    });
  }

  private setRefreshCookie(res: Response, token: string): void {
    res.cookie(REFRESH_COOKIE, token, {
      ...this.refreshCookieOptions(),
      maxAge: REFRESH_COOKIE_MAX_AGE_MS,
    });
  }

  private clearRefreshCookie(res: Response): void {
    res.clearCookie(REFRESH_COOKIE, this.refreshCookieOptions());
  }

  /** The linked login's parked session (ADR-0199 §4), cleared with the same attributes it was set with. */
  private clearLinkedRefreshCookie(res: Response): void {
    res.clearCookie(LINKED_REFRESH_COOKIE, this.refreshCookieOptions());
  }

  /**
   * Cookie first; an explicit body value is accepted for non-browser clients.
   *
   * **No token at all is `AUTH_TOKEN_INVALID`, and only that** (ADR-0168 §1): there was no session to refresh — a
   * browser that never signed in, or one whose cookie a sign-out cleared. Any token that *is* presented goes on to
   * `AuthService.refresh`, malformed or not, and a refusal there is `AUTH_SESSION_ENDED`: this browser had a
   * session, and it ended.
   */
  private refreshTokenFrom(req: Request, body?: RefreshDto): string {
    const fromCookie = (req.cookies as Record<string, string> | undefined)?.[REFRESH_COOKIE];
    const token = fromCookie ?? body?.refreshToken;
    if (!token) {
      throw new DomainException(
        ErrorCode.AUTH_TOKEN_INVALID,
        AUTH_REFUSALS.AUTH_TOKEN_INVALID.noSession,
        HttpStatus.UNAUTHORIZED,
      );
    }
    return token;
  }

  /**
   * **A page on another origin may not set, spend or end this browser's session** (P18.4-T1, ADR-0152).
   *
   * Allowed: the origins `CORS_ORIGINS` lists, and the API's own (Swagger UI at `/api/docs` posts to the
   * API it is served from). Refused: any other `Origin`. No `Origin` at all is not a page and is let
   * through. See `request-origin.ts` for why the four hosts make this necessary.
   *
   * Every route that sets or spends the refresh cookie calls it first, before anything is read or written:
   * - **`login`, always.** A `<form>` on a sibling host needs no preflight, and the cookie its answer sets
   *   is kept, because the hosts are same-site: the browser would be signed in to somebody else's account.
   * - **`refresh` and `logout`, when the cookie is there.** The harm is the browser sending somebody's
   *   session on a page's behalf; a request without the cookie has none to send, and is answered as before.
   */
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

  /** `refuseForeignOrigin`, for a route that is refused only when it carries the refresh cookie. */
  private refuseForeignOriginWithCookie(req: Request): void {
    if (this.refreshTokenFromOrNull(req)) this.refuseForeignOrigin(req);
  }

  /** The presented refresh token, or nothing — for a route that works either way. */
  private refreshTokenFromOrNull(req: Request): string | null {
    return (req.cookies as Record<string, string> | undefined)?.[REFRESH_COOKIE] ?? null;
  }

  private limit(key: string, limit: number, windowSeconds: number): void {
    const retryAfter = this.limiter.check(key, limit, windowSeconds);
    if (retryAfter !== null) {
      throw new DomainException(
        ErrorCode.AUTH_RATE_LIMITED,
        AUTH_REFUSALS.AUTH_RATE_LIMITED.tooMany({ minutes: Math.ceil(retryAfter / 60) }),
        HttpStatus.TOO_MANY_REQUESTS,
        { retryAfterSeconds: retryAfter },
      );
    }
  }

  @Public()
  @Post('register')
  @ApiOperation({
    summary: 'Create an account',
    description:
      'Always succeeds in shape, even for an address that already exists — confirming ' +
      'that would let anyone enumerate accounts. A verification email follows. Rate limited per client address, ' +
      `${REGISTRATION.MAX_PER_ADDRESS} attempts an hour, refused or not.`,
  })
  @ApiResponse({ status: 201, description: 'Account created; verification sent.' })
  @ApiResponse({
    status: HttpStatus.NOT_FOUND,
    description:
      '`NOT_FOUND` — with `inviteToken`, a link that opens nothing (unknown, cancelled, used or expired), said in plain '
      + 'words, before any account is made — answered as a link into another office is.',
    type: ApiErrorEnvelope,
  })
  @ApiResponse({
    status: HttpStatus.GONE,
    description:
      '`ORG_INVITE_EXPIRED` — with `leaderCode`, a code that opens nothing (nobody holds it, its owner has left, or the '
      + 'office has stopped), answered alike, before any account is made.',
    type: ApiErrorEnvelope,
  })
  @ApiResponse({
    status: HttpStatus.TOO_MANY_REQUESTS,
    description: '`AUTH_RATE_LIMITED` — too many sign-ups from this address in the hour; `details.retryAfterSeconds`.',
    type: ApiErrorEnvelope,
  })
  async register(@Body() dto: RegisterDto, @Req() req: Request) {
    // Per client address, before anything is read (the P18.8 exit review, L2): a script making accounts, or walking
    // agent codes against `AGENT_CODE_TAKEN`, is stopped here, as an invite link's banner stops one walking tokens.
    this.limit(registrationLimitKey(req.ip ?? 'unknown'), REGISTRATION.MAX_PER_ADDRESS, REGISTRATION.WINDOW_SECONDS);
    const { inviteToken, leaderCode, ...input } = dto;
    if (!inviteToken && leaderCode && this.leaderCodes) {
      /*
       * **On a leader's link** (ADR-0236 §1, P19.10-T1 AC-1): the code's office's insurer, and the membership made at
       * once under the code's leader — the code was the approval — for an account made here and now. A code that opens
       * nothing is refused before any account is made; an address that already exists answers as it always has and
       * joins nobody, as on an invite.
       */
      const held = await this.leaderCodes.forRegistration(leaderCode);
      const { user, created } = await this.auth.registerAccount({ ...input, ...held }, readerOfRequest(req));
      if (created) await this.leaderCodes.joinNewAccount(leaderCode, String(user._id));
      return { status: 'verification_sent' };
    }
    if (!inviteToken || !this.invites) {
      // The verification email in the language of the page that asked (P18.10-T5 AC-5).
      await this.auth.register(input, readerOfRequest(req));
      return { status: 'verification_sent' };
    }
    /*
     * **On a leader's invite** (ADR-0170 §3, P18.8-T3 AC-4): the invite's insurer and code, whatever the form sent,
     * and the membership made at once under the leader — for an account made here and now. An address that already
     * exists answers as it always has, and joins nobody to anything: that would let anybody holding a link attach
     * somebody else's account to an office.
     */
    const held = await this.invites.forRegistration(inviteToken);
    const { user, created } = await this.auth.registerAccount({ ...input, ...held }, readerOfRequest(req));
    if (created) await this.invites.acceptForNewAccount(inviteToken, String(user._id));
    return { status: 'verification_sent' };
  }

  @Public()
  @Post('login')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Sign in',
    description:
      'Rate limited per IP **and** per email — an attacker rotating IPs against one ' +
      'account still burns the per-email budget.',
  })
  // Stated because a failure is: Swagger drops the success it would infer once any response is declared.
  @ApiResponse({ status: HttpStatus.OK, description: '', type: AccessTokenDto })
  @ApiResponse(LOGIN_ORIGIN_REFUSED_RESPONSE)
  async login(
    @Body() dto: LoginDto,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ) {
    // Before the limiter: a forged sign-in spends nobody's budget.
    this.refuseForeignOrigin(req);
    const ip = req.ip ?? 'unknown';
    this.limit(`login:ip:${ip}`, this.loginLimit, LOGIN_WINDOW_SECONDS);
    this.limit(
      `login:email:${dto.email.toLowerCase()}`,
      this.loginLimit,
      LOGIN_WINDOW_SECONDS,
    );

    const pair = await this.auth.login(dto.email, dto.password, {
      ip,
      userAgent: req.headers['user-agent'] ?? null,
    });

    // A successful sign-in should not spend the budget a typo already dented.
    this.limiter.reset(`login:ip:${ip}`);
    this.limiter.reset(`login:email:${dto.email.toLowerCase()}`);

    this.setRefreshCookie(res, pair.refreshToken);
    return { accessToken: pair.accessToken, expiresIn: pair.expiresIn };
  }

  @Public()
  /**
   * The body is **optional**: the refresh token normally arrives in the
   * `agencyboost_refresh` cookie, and `RefreshDto` is the fallback for a client that
   * cannot hold one. `dto?:` is erased before Swagger sees it, so the document said
   * required until P3.1-T11 — a generated client would have refused to call it without a
   * body it does not have.
   */
  @ApiBody({ type: RefreshDto, required: false })
  @Post('refresh')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Rotate the refresh token',
    description:
      'Presenting a token that was already rotated revokes the whole family — the ' +
      `standard signal that a refresh token was stolen. ${REFRESH_REFUSED}`,
  })
  // Stated because a failure is: Swagger drops the success it would infer once any response is declared.
  @ApiResponse({ status: HttpStatus.OK, description: '', type: AccessTokenDto })
  @ApiResponse(ORIGIN_REFUSED_RESPONSE)
  async refresh(
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
    @Body() dto?: RefreshDto,
  ) {
    this.refuseForeignOriginWithCookie(req);
    /*
     * Per session, not per IP (P4-T13). A shared office IP would otherwise ration
     * everybody together, and the thing worth catching — a client stuck in a refresh loop
     * — is one session asking over and over.
     */
    const presented = this.refreshTokenFrom(req, dto);
    /*
     * A token that names no family — unknown, malformed, spent — is rationed **per address**, not in one bucket
     * shared by every browser with a dead cookie: since ADR-0168 each of those is told *Your session ended*, and one
     * caller posting garbage would otherwise have them all answered 429 for the hour (the permission review,
     * 2026-10-27).
     */
    const family = await this.auth.familyOf(presented);
    this.limit(
      family ? `refresh:${family}` : `refresh:unknown:${req.ip ?? 'unknown'}`,
      REFRESH_LIMIT,
      REFRESH_WINDOW_SECONDS,
    );

    const pair = await this.auth.refresh(presented, {
      ip: req.ip ?? null,
      userAgent: req.headers['user-agent'] ?? null,
    });
    this.setRefreshCookie(res, pair.refreshToken);
    return { accessToken: pair.accessToken, expiresIn: pair.expiresIn };
  }

  @Public()
  /**
   * The body is **optional**: the refresh token normally arrives in the
   * `agencyboost_refresh` cookie, and `RefreshDto` is the fallback for a client that
   * cannot hold one. `dto?:` is erased before Swagger sees it, so the document said
   * required until P3.1-T11 — a generated client would have refused to call it without a
   * body it does not have.
   */
  @ApiBody({ type: RefreshDto, required: false })
  // The three routes somebody on a generated password may reach: see who they are,
  // replace it, or leave (P3.2-T4).
  @AllowTemporaryPassword()
  @Post('logout')
  // Signing out is always available, support session or not.
  @AllowWhileReadOnly()
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({
    summary: 'End this session',
    description:
      '**Ends both sessions this browser holds** where a linked login is signed in on it too (`agencyboost_refresh_linked`): '
      + 'leaving is leaving. Both cookies are cleared.',
  })
  @ApiResponse({ status: HttpStatus.NO_CONTENT, description: '' })
  @ApiResponse(ORIGIN_REFUSED_RESPONSE)
  async logout(
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
    @Body() dto?: RefreshDto,
  ) {
    const cookies = req.cookies as Record<string, string> | undefined;
    const linked = cookies?.[LINKED_REFRESH_COOKIE];
    // A page on another origin may end neither session (P18.4-T1): the parked one is this browser's as much.
    if (linked) this.refuseForeignOrigin(req);
    else this.refuseForeignOriginWithCookie(req);
    const fromCookie = cookies?.[REFRESH_COOKIE];
    const token = fromCookie ?? dto?.refreshToken;
    if (token) await this.auth.logout(token);
    /*
     * ***Keluar* ends both** (UI-169 item 5; ADR-0199 §4): the linked login's session parked here is revoked as the
     * active one is, and both cookies go. *Sign out everywhere* and a password change end one login's sessions only.
     */
    if (linked) await this.auth.logout(linked);
    this.clearRefreshCookie(res);
    if (linked) this.clearLinkedRefreshCookie(res);
  }

  @Public()
  @Post('verify-email')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Verify an address with its link\'s token',
    description:
      'ADR-0190 (UI-163). Sent when *Verifikasi email saya* is pressed on `/verify-email/[token]`, never when the '
      + 'page loads, so a mail scanner that opens the link spends nothing. `200 { status: \'verified\' }` verifies the '
      + 'address — and answers the same for **an address already verified**, whatever state its link is in (pressed '
      + 'again, an older mail, after a reset). A token that names nobody, or one that expired or was spent before the '
      + 'address was verified, is `400 AUTH_TOKEN_INVALID`.',
  })
  async verifyEmail(@Body() dto: TokenDto) {
    await this.auth.verifyEmail(dto.token);
    return { status: 'verified' };
  }

  @Public()
  @Post('verify-email-change')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Open an email change\'s link: the account moves to the new address',
    description:
      'UI V1 (UI-111, ADR-0181). The token from the link sent to the new address, single-use, valid as long as a '
      + 'verification link. Moves `users.email` to the pending address, marks it verified, audits '
      + '`user.email_changed` and answers the new address. Sessions stay signed in. An unknown, used, replaced or '
      + 'expired link is `400 AUTH_TOKEN_INVALID`, as `verify-email` answers; an address taken since the request is '
      + '`409 AUTH_EMAIL_TAKEN`.',
  })
  async verifyEmailChange(@Body() dto: TokenDto) {
    const { email } = await this.auth.confirmEmailChange(dto.token);
    return { status: 'changed', email };
  }

  @Public()
  @Post('forgot-password')
  @HttpCode(HttpStatus.ACCEPTED)
  @ApiOperation({
    summary: 'Request a password reset',
    description: 'Always 202, whether or not the address exists.',
  })
  async forgotPassword(@Body() dto: ForgotPasswordDto, @Req() req: Request) {
    this.limit(`forgot:${dto.email.toLowerCase()}`, FORGOT_LIMIT, FORGOT_WINDOW_SECONDS);
    // The reset email in the language of the page that asked, for a person who has saved none (P18.10-T5 AC-5).
    await this.auth.forgotPassword(dto.email, readerOfRequest(req));
    return { status: 'accepted' };
  }

  @Public()
  @Post('reset-password')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Set a new password with a reset token',
    description:
      'Revokes every existing session. Marks the address verified where it was not — the link proved the mailbox — and '
      + 'emails *Kata sandi Anda diubah* to it (ADR-0190 §3, §5).',
  })
  async resetPassword(@Body() dto: ResetPasswordDto, @Req() req: Request) {
    // The password-changed mail in the language of the page that asked, for a person who has saved none.
    await this.auth.resetPassword(dto.token, dto.newPassword, readerOfRequest(req));
    return { status: 'reset' };
  }

  @Public()
  @Post('resend-verification')
  @HttpCode(HttpStatus.ACCEPTED)
  @ApiOperation({
    summary: 'Send the verification email again',
    description:
      'Always `202`, whether or not the address exists or is already verified — anything '
      + 'else is an account-enumeration oracle, the same reason `forgot-password` answers '
      + 'this way. `agent/01-getting-started.md` told readers to request another before this '
      + 'route existed.',
  })
  async resendVerification(@Body() dto: ForgotPasswordDto, @Req() req: Request) {
    const email = dto.email.toLowerCase().trim();
    this.limit(`resend:${email}`, RESEND_LIMIT, RESEND_WINDOW_SECONDS);
    // Deliberately not awaited into a different answer: the reply is the same either way.
    await this.auth.resendVerification(email, readerOfRequest(req));
    return { status: 'accepted' };
  }

  @ApiBearerAuth()
  @Post('logout-all')
  // Signs the member out of their own devices: theirs to do, never a support session's (ADR-0162 §4).
  @RefuseInSupportSession()
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({
    summary: 'Sign out everywhere',
    description:
      'Revokes every refresh session for this account, this one included. What somebody '
      + 'does when they think a device was lost. Refused `403 PERM_DENIED` in any support session.',
  })
  async logoutAll(@Ctx() ctx: RequestContext, @Res({ passthrough: true }) res: Response) {
    await this.auth.logoutAll(ctx.userId, 'signed out everywhere');
    this.clearRefreshCookie(res);
  }

  @ApiBearerAuth()
  @Get('sessions')
  @ApiOperation({
    summary: 'Where this account is signed in',
    description:
      'One row per session, not per token: a refresh rotates on every use, so a fortnight '
      + '-old session has a few hundred rows behind it and a person wants to know about '
      + 'their phone and their laptop. `current` marks the one they are reading from.',
  })
  async sessions(@Ctx() ctx: RequestContext, @Req() req: Request) {
    const presented = this.refreshTokenFromOrNull(req);
    const family = presented ? await this.auth.familyOf(presented) : null;
    return this.auth.sessions(ctx.userId, family);
  }

  @ApiBearerAuth()
  @Delete('sessions/:sessionId')
  @RefuseInSupportSession()
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({
    summary: 'Sign out one device',
    description:
      'Revokes the whole token family — revoking only its newest token would leave an '
      + 'attacker holding an older one that still rotates. `404` for a session that is not '
      + 'this account\'s. Refused `403 PERM_DENIED` in any support session.',
  })
  async revokeSession(@Ctx() ctx: RequestContext, @Param('sessionId') sessionId: string) {
    await this.auth.revokeSession(ctx.userId, sessionId);
  }

  @ApiBearerAuth()
  // The three routes somebody on a generated password may reach: see who they are,
  // replace it, or leave (P3.2-T4).
  @AllowTemporaryPassword()
  @Post('change-password')
  @RefuseInSupportSession()
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Change your password',
    description:
      'Revokes your other sessions, and emails *Kata sandi Anda diubah* to your address (ADR-0190 §5). Refused '
      + '`403 PERM_DENIED` in any support session.',
  })
  async changePassword(@Ctx() ctx: RequestContext, @Body() dto: ChangePasswordDto, @Req() req: Request) {
    await this.auth.changePassword(ctx.userId, dto.currentPassword, dto.newPassword, readerOfRequest(req));
    return { status: 'changed' };
  }

  @ApiBearerAuth()
  @Post('me/email')
  // The person's login is theirs to change, never a support session's (ADR-0162 §4, ADR-0181 §1).
  @RefuseInSupportSession()
  @HttpCode(HttpStatus.ACCEPTED)
  @ApiOperation({
    summary: 'Ask to change your email address',
    description:
      'UI V1 (UI-111, ADR-0181). `{ newEmail, currentPassword }`. The password is checked again (`401 '
      + 'AUTH_INVALID_CREDENTIALS`, as `change-password`); the address is lower-cased and trimmed as registration '
      + 'does; your own address is `400 VALIDATION_FAILED`, another account\'s `409 AUTH_EMAIL_TAKEN`, each with '
      + '`details.field: newEmail`. **Nothing on the account changes yet**: a link is sent to the new address '
      + '(`POST /auth/verify-email-change` applies it) and a notice with no link to the current one. A newer request '
      + 'replaces the pending one. 5 per hour per account (`429 AUTH_RATE_LIMITED`). Refused `403 PERM_DENIED` in any '
      + 'support session.',
  })
  async requestEmailChange(@Ctx() ctx: RequestContext, @Body() dto: ChangeEmailDto, @Req() req: Request) {
    this.limit(`email-change:${ctx.userId}`, EMAIL_CHANGE_LIMIT, EMAIL_CHANGE_WINDOW_SECONDS);
    // Both emails in the language of the page that asked, for a person who has saved none (P18.10-T5 AC-5).
    await this.auth.requestEmailChange(ctx.userId, dto.newEmail, dto.currentPassword, readerOfRequest(req));
    return { status: 'accepted' };
  }

  @ApiBearerAuth()
  // The three routes somebody on a generated password may reach: see who they are,
  // replace it, or leave (P3.2-T4).
  @AllowTemporaryPassword()
  @Get('me')
  @ApiOperation({
    summary: 'Who am I, and what may I do',
    description:
      'The resolved context: identity, membership, and the permissions held right now. ' +
      'Resolved per request, so a revoked grant disappears immediately.',
  })
  async me(@Ctx() ctx: RequestContext) {
    const user = await this.users.findOne({ _id: ctx.userId }).exec();
    const permissions = (Object.keys(PERMISSIONS) as Permission[]).filter((p) => can(ctx, p));
    // ADR-0158 §1: how they work is their membership's; until an office has them, what they registered with.
    const membership = ctx.membershipId ? await this.members.findById(ctx, ctx.membershipId) : null;
    const nav = await activationNavFor(this.activationNav, ctx);
    const line = await profileLineFor(this.profileLine, ctx, membership?.groupIds ?? []);

    return {
      user: {
        id: ctx.userId,
        email: user?.email,
        fullName: user?.fullName,
        preferredName: preferredNameOf(user?.preferredName),
        pronoun: user?.pronoun,
        // UI V1 (UI-081, D-22): the number *Isi nomor WhatsApp* saves, or one an invite or a leader gave them.
        phone: user?.phone ?? null,
        // UI V1 (UI-111): their photo as a signed link, or `null` — the avatar then draws the initials.
        avatarUrl: this.avatarLinks ? await this.avatarLinks.linkFor(user?.avatarUrl) : null,
        initials: initialsOf(user?.fullName ?? ''),
        platformRole: ctx.platformRole,
        /*
         * **Whether the address is verified** (P19-T1 AC-4; UI-163, ADR-0190 §4): an account signs in before it is, and
         * every shell says *"Verifikasi email Anda · Kirim ulang"* while this is `false`.
         */
        emailVerified: Boolean(user?.emailVerifiedAt),
        // What a person records (ADR-0158): `null` is *Not recorded* — somebody who arrived before it was asked.
        dateOfBirth: user?.dateOfBirth ?? null,
        gender: user?.gender ?? null,
        companyJoinMonth: user?.companyJoinMonth ?? null,
        workStatus: ctx.membershipId ? (membership?.workStatus ?? null) : (user?.registeredWorkStatus ?? null),
        /*
         * **The language in force, and whether it was chosen** (ADR-0179 §2; P18.10-T2 AC-1, AC-5). `locale` is never
         * `null`: a person who has chosen nothing reads Bahasa Indonesia (`languageOf`). `localeChosen` says which it
         * is, because the app treats the two apart at sign-in — a saved choice wins over the browser's cookie and
         * rewrites it, and an account with none keeps the language the browser already had, writing nothing.
         */
        locale: languageOf(user?.locale),
        localeChosen: isLanguage(user?.locale),
      },
      /*
       * The context's membership — its `isCoreLeader` the effective flag, the tag on a leader rung (ADR-0159 §4) — and
       * what the sidebar's profile line says after the role (§5, P18.5-T6): the member's live tag groups, A to Z, and
       * their office's code and branch.
       */
      membership: ctx.membership
        ? { ...ctx.membership, isCoreLeader: ctx.isCoreLeader, groups: line.groups, office: line.office }
        : null,
      isImpersonating: ctx.isImpersonating,
      // `true` in every session (P4-T10; ADR-0206 §4): the banner says it only looks. The setup session's purpose and
      // write scope are gone from here with it (P19.4-T2).
      impersonationReadOnly: ctx.impersonationReadOnly,
      impersonatedBy: ctx.impersonatorUserId,
      /*
       * The reason every other route is answering 403 (P3.2-T4).
       *
       * `/auth/me` is one of the three routes a temporary password may reach, so it is
       * the only place the client can learn what state it is in. Carried here rather than
       * inferred from a 403 on some other call: one screen redirects on it, and inferring
       * it would mean every screen guessing separately.
       */
      mustChangePassword: ctx.mustChangePassword,
      permissions,
      /*
       * The *New agent* section (P13-T7 AC-5): the reader's own activation — `null` when they have none,
       * `open` false once it is complete or past its six months — and whether they reach anybody's open
       * one. Read once, here, so no page reads them again; every route still refuses on its own.
       */
      activation: nav.activation,
      newHires: nav.newHires,
      /*
       * **The caller's other login** (UI-169 item 5; ADR-0199 §3): its address, its name and its views, for the account
       * menu's switcher — `null` with no link, and always in a support session (§7).
       */
      linkedLogin: this.accountLinks ? await this.accountLinks.linkedLoginFor(ctx) : null,
      /*
       * **What the session's KPM shows** (P19.6-T1 AC-12; ADR-0218 §8): its version, its palette (`null`: AgencyBoost's
       * colours), the logo's size, which images and poses it has, and a lesson's colours (ADR-0217 §5) — for the KPM the
       * session is in, a view-as session's included (AC-17); `null` with no KPM.
       */
      branding: this.branding ? await this.branding.forSession(ctx) : null,
    };
  }

  @ApiBearerAuth()
  @Patch('me')
  @RefuseInSupportSession()
  @ApiOperation({
    summary: 'Update your own account',
    description:
      'Your name, preferred name and pronoun; your date of birth, gender, company join month and work '
      + 'status (ADR-0158); the language you read AgencyBoost in, `locale` (`id` or `en`, ADR-0179); and your '
      + 'WhatsApp number, `phone` (UI V1: stored as `+62` and 9 to 13 digits, else `400 VALIDATION_FAILED`; '
      + 'empty or `null` clears it) — each optional, none of the others clearable. A birth date must be in the '
      + 'past and at least 18 years ago and a join month not in the future, else `400 VALIDATION_FAILED` naming the field; a `locale` that is not `id` or `en`, `null` '
      + 'included, is `400 VALIDATION_FAILED` with `details.violations`. Work status is written on your membership '
      + 'in your office, and on your account until you have one. **Refused in any support session**, '
      + '`403 IMPERSONATION_READ_ONLY` as every write of one is (ADR-0206 §4): a person\'s own account, their language '
      + 'included, is theirs to change.',
  })
  async updateMe(@Ctx() ctx: RequestContext, @Body() dto: UpdateProfileDto) {
    const { workStatus, ...account } = dto;
    /*
     * **The person's own word, in no session's hands** (P18.5-T4 AC-6, ADR-0162 §4): `@RefuseInSupportSession`
     * refuses the whole route in any session, so a birth date, a gender or a work status — and the name and
     * pronoun beside them — are never recorded in their name. It refused the four fields alone until ADR-0162.
     */
    this.auth.refusePersonalData(dto);

    // The account's own fields, the language among them (`users.locale`, ADR-0179 §2): the person's, never an office's.
    await this.users.updateOne({ _id: ctx.userId }, { $set: { ...account } }).exec();
    if (workStatus !== undefined) {
      if (ctx.membershipId) {
        await this.members.updateById(ctx, ctx.membershipId, { $set: { workStatus } });
      } else {
        // Nobody's member yet: kept for the membership they are given (`HierarchyService`).
        await this.users.updateOne({ _id: ctx.userId }, { $set: { registeredWorkStatus: workStatus } }).exec();
      }
    }
    return this.me(ctx);
  }
}
