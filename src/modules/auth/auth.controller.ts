import {
  Body, Controller, Get, HttpCode, HttpStatus, Patch, Post, Req, Res,
} from '@nestjs/common';
import { ApiBearerAuth, ApiBody, ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import type { Request, Response } from 'express';
import { AllowTemporaryPassword, Ctx, Public } from '@/common/auth/auth.decorators';
import { RequestContext } from '@/common/context/request-context';
import { DomainException } from '@/common/errors/domain.exception';
import { ErrorCode } from '@/common/errors/error-codes';
import { initialsOf, User, UserDocument } from '@/modules/users/user.schema';
import { can, PERMISSIONS, Permission } from '@/modules/rbac/permissions';
import { AuthService } from './auth.service';
import { RateLimiter } from './rate-limiter';
import {
  ChangePasswordDto, ForgotPasswordDto, LoginDto, RefreshDto, RegisterDto,
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
 */
const REFRESH_COOKIE = 'agencyboost_refresh';
const REFRESH_COOKIE_MAX_AGE_MS = 30 * 86_400_000;

const LOGIN_LIMIT = 5;
const LOGIN_WINDOW_SECONDS = 15 * 60;
const FORGOT_LIMIT = 3;
const FORGOT_WINDOW_SECONDS = 60 * 60;

@ApiTags('auth')
@Controller('auth')
export class AuthController {
  constructor(
    private readonly auth: AuthService,
    private readonly limiter: RateLimiter,
    @InjectModel(User.name) private readonly users: Model<UserDocument>,
  ) {}

  private setRefreshCookie(res: Response, token: string): void {
    res.cookie(REFRESH_COOKIE, token, {
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      sameSite: 'lax',
      path: '/api/v1/auth',
      maxAge: REFRESH_COOKIE_MAX_AGE_MS,
    });
  }

  private clearRefreshCookie(res: Response): void {
    res.clearCookie(REFRESH_COOKIE, { path: '/api/v1/auth' });
  }

  /** Cookie first; an explicit body value is accepted for non-browser clients. */
  private refreshTokenFrom(req: Request, body?: RefreshDto): string {
    const fromCookie = (req.cookies as Record<string, string> | undefined)?.[REFRESH_COOKIE];
    const token = fromCookie ?? body?.refreshToken;
    if (!token) {
      throw new DomainException(
        ErrorCode.AUTH_TOKEN_INVALID,
        'No session to refresh. Sign in again.',
        HttpStatus.UNAUTHORIZED,
      );
    }
    return token;
  }

  private limit(key: string, limit: number, windowSeconds: number): void {
    const retryAfter = this.limiter.check(key, limit, windowSeconds);
    if (retryAfter !== null) {
      throw new DomainException(
        ErrorCode.AUTH_RATE_LIMITED,
        `Too many attempts. Try again in ${Math.ceil(retryAfter / 60)} minute(s).`,
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
      'that would let anyone enumerate accounts. A verification email follows.',
  })
  @ApiResponse({ status: 201, description: 'Account created; verification sent.' })
  async register(@Body() dto: RegisterDto) {
    await this.auth.register(dto);
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
  async login(
    @Body() dto: LoginDto,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ) {
    const ip = req.ip ?? 'unknown';
    this.limit(`login:ip:${ip}`, LOGIN_LIMIT, LOGIN_WINDOW_SECONDS);
    this.limit(`login:email:${dto.email.toLowerCase()}`, LOGIN_LIMIT, LOGIN_WINDOW_SECONDS);

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
   * required until P3.5-T11 — a generated client would have refused to call it without a
   * body it does not have.
   */
  @ApiBody({ type: RefreshDto, required: false })
  @Post('refresh')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Rotate the refresh token',
    description:
      'Presenting a token that was already rotated revokes the whole family — the ' +
      'standard signal that a refresh token was stolen.',
  })
  async refresh(
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
    @Body() dto?: RefreshDto,
  ) {
    const pair = await this.auth.refresh(this.refreshTokenFrom(req, dto), {
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
   * required until P3.5-T11 — a generated client would have refused to call it without a
   * body it does not have.
   */
  @ApiBody({ type: RefreshDto, required: false })
  // The three routes somebody on a generated password may reach: see who they are,
  // replace it, or leave (P3.6-T4).
  @AllowTemporaryPassword()
  @Post('logout')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'End this session' })
  async logout(
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
    @Body() dto?: RefreshDto,
  ) {
    const fromCookie = (req.cookies as Record<string, string> | undefined)?.[REFRESH_COOKIE];
    const token = fromCookie ?? dto?.refreshToken;
    if (token) await this.auth.logout(token);
    this.clearRefreshCookie(res);
  }

  @Public()
  @Post('verify-email')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Consume a verification token' })
  async verifyEmail(@Body() dto: TokenDto) {
    await this.auth.verifyEmail(dto.token);
    return { status: 'verified' };
  }

  @Public()
  @Post('forgot-password')
  @HttpCode(HttpStatus.ACCEPTED)
  @ApiOperation({
    summary: 'Request a password reset',
    description: 'Always 202, whether or not the address exists.',
  })
  async forgotPassword(@Body() dto: ForgotPasswordDto) {
    this.limit(`forgot:${dto.email.toLowerCase()}`, FORGOT_LIMIT, FORGOT_WINDOW_SECONDS);
    await this.auth.forgotPassword(dto.email);
    return { status: 'accepted' };
  }

  @Public()
  @Post('reset-password')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Set a new password with a reset token',
    description: 'Revokes every existing session.',
  })
  async resetPassword(@Body() dto: ResetPasswordDto) {
    await this.auth.resetPassword(dto.token, dto.newPassword);
    return { status: 'reset' };
  }

  @ApiBearerAuth()
  // The three routes somebody on a generated password may reach: see who they are,
  // replace it, or leave (P3.6-T4).
  @AllowTemporaryPassword()
  @Post('change-password')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Change your password', description: 'Revokes your other sessions.' })
  async changePassword(@Ctx() ctx: RequestContext, @Body() dto: ChangePasswordDto) {
    await this.auth.changePassword(ctx.userId, dto.currentPassword, dto.newPassword);
    return { status: 'changed' };
  }

  @ApiBearerAuth()
  // The three routes somebody on a generated password may reach: see who they are,
  // replace it, or leave (P3.6-T4).
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

    return {
      user: {
        id: ctx.userId,
        email: user?.email,
        fullName: user?.fullName,
        preferredName: user?.preferredName,
        pronoun: user?.pronoun,
        initials: initialsOf(user?.fullName ?? ''),
        platformRole: ctx.platformRole,
      },
      membership: ctx.membership,
      isImpersonating: ctx.isImpersonating,
      impersonatedBy: ctx.impersonatorUserId,
      /*
       * The reason every other route is answering 403 (P3.6-T4).
       *
       * `/auth/me` is one of the three routes a temporary password may reach, so it is
       * the only place the client can learn what state it is in. Carried here rather than
       * inferred from a 403 on some other call: one screen redirects on it, and inferring
       * it would mean every screen guessing separately.
       */
      mustChangePassword: ctx.mustChangePassword,
      permissions,
    };
  }

  @ApiBearerAuth()
  @Patch('me')
  @ApiOperation({ summary: 'Update your own account' })
  async updateMe(@Ctx() ctx: RequestContext, @Body() dto: UpdateProfileDto) {
    await this.users.updateOne({ _id: ctx.userId }, { $set: { ...dto } }).exec();
    return this.me(ctx);
  }
}
