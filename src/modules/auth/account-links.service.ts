import { HttpStatus, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { Clock } from '@/common/clock/clock.port';
import { RequestContext } from '@/common/context/request-context';
import { DomainException, NotFoundException } from '@/common/errors/domain.exception';
import { ErrorCode } from '@/common/errors/error-codes';
import type { Reader } from '@/common/i18n/reader';
import { AuditService } from '@/modules/audit/audit.service';
import { NotificationService } from '@/modules/notifications/notification.service';
import { NotificationTemplate } from '@/modules/notifications/notification.types';
import { MembershipRepository } from '@/modules/org/membership.repository';
import { Kpm, KpmDocument } from '@/modules/tenants/kpm.schema';
import { User, UserDocument } from '@/modules/users/user.schema';
import { AccountLink, AccountLinkDocument, linkPair } from './account-link.schema';
import { AuthToken, AuthTokenDocument } from './auth-token.schema';
import { AUTH_REFUSALS } from './auth.messages';
import { AuthService, normalisedEmail, VERIFICATION_TTL_HOURS, type TokenPair } from './auth.service';
import { PasswordService } from './password.service';
import { RateLimiter } from './rate-limiter';

/**
 * The views one login has, named as ADR-0198 §1 names them (ADR-0199 §3): `self` (*Akun saya*), `kpm_owner` or
 * `kpm_admin` with the office's name, and `super_admin` (*Superadmin*). The frontend's `ViewKind` is the same four.
 */
export type LinkedViewKind = 'self' | 'kpm_owner' | 'kpm_admin' | 'super_admin';

export interface LinkedView {
  kind: LinkedViewKind;
  /** The office as it typed its name — its branch, else its code — for the office entry; `null` on the others. */
  officeName: string | null;
}

/** What `GET /auth/me` carries as `linkedLogin` (ADR-0199 §3), or `null`. */
export interface LinkedLogin {
  linkId: string;
  userId: string;
  email: string;
  fullName: string;
  views: LinkedView[];
}

interface Meta {
  ip?: string | null;
  userAgent?: string | null;
}

/** What the confirm hands the controller: the link, and a session of B's for this browser when it held A's. */
export interface LinkConfirmed {
  linkId: string;
  /** B's new refresh token, for `agencyboost_refresh_linked` — only when the confirming browser held A's live session. */
  linkedRefreshToken: string | null;
}

/** What a switch hands the controller: the other login's session, and the active one's token to park. */
export interface LinkSwitched {
  pair: TokenPair;
  /** The active login's refresh token, unchanged, for `agencyboost_refresh_linked` — `null` when it was not a live one. */
  parked: string | null;
}

/** The login limits (`AuthController.loginLimit`'s variable), applied to a linked login's password (ADR-0199 §2, §4). */
const LOGIN_WINDOW_SECONDS = 15 * 60;

/** Starts per account per hour — the email change's limit (ADR-0181 §2), which ADR-0199 §2 reuses. */
export const LINK_START_LIMIT = 5;
export const LINK_START_WINDOW_SECONDS = 60 * 60;

/** Switches without a password, per login per minute — as refreshing is limited (`REFRESH_LIMIT`, ADR-0199 §4). */
export const LINK_SWITCH_LIMIT = 30;
export const LINK_SWITCH_WINDOW_SECONDS = 60;

/**
 * **Linked logins** (UI-169 item 5; P19.2-T1 AC-8;
 * [ADR-0199](../../../../docs/04-adr/0199-a-second-login-is-linked-through-its-own-mailbox-and-password.md)): one
 * person's two logins — the owner's case is a field login and a Super Admin login — linked so the avatar menu lists
 * both logins' views.
 *
 * **A link is proven by both factors of both logins, and grants nothing.**
 * - **Start** (`start`): the starting login's password again, its address verified, five an hour. The answer is the same
 *   `202` whatever the other address is — no account, deleted, deactivated, already linked, or not an Owner's, an
 *   Admin's or a Super Admin's — and nothing is sent for any of those: saying so would be the oracle (§2).
 * - **Confirm** (`confirm`): the other login's own mailbox (the token) and its own password, by the sign-in limiter.
 * - **Switch** (`switchTo`): never a session for one login made out of the other's. The other login's own session on
 *   this browser is rotated, or its password is asked for and a new one made (§4).
 *
 * **Global, as logins are** (invariant 2): no `kpmId`, every audit row in the platform's scope. The other login's office
 * is read through one named method, `MembershipRepository.officeRoleOfLoginAcrossTenants`, registered with its reason in
 * `named-cross-tenant-reads.tenancy.spec.ts`; nothing else of any office is read here.
 */
@Injectable()
export class AccountLinksService {
  private readonly logger = new Logger(AccountLinksService.name);

  constructor(
    @InjectModel(AccountLink.name) private readonly links: Model<AccountLinkDocument>,
    @InjectModel(User.name) private readonly users: Model<UserDocument>,
    @InjectModel(AuthToken.name) private readonly tokens: Model<AuthTokenDocument>,
    @InjectModel(Kpm.name) private readonly kpms: Model<KpmDocument>,
    private readonly members: MembershipRepository,
    private readonly auth: AuthService,
    private readonly passwords: PasswordService,
    private readonly notifications: NotificationService,
    private readonly audit: AuditService,
    private readonly limiter: RateLimiter,
    private readonly config: ConfigService,
    private readonly clock: Clock,
  ) {}

  // ---------------------------------------------------------------------------- reads

  /**
   * **The caller's other login, for `GET /auth/me`** (ADR-0199 §3) — `null` with no live link, and **always `null` in a
   * support session** (§7): a session's `me` is the member's, and the switcher offers no linked login there. A link
   * whose other login was deleted reads as none.
   */
  async linkedLoginFor(ctx: RequestContext): Promise<LinkedLogin | null> {
    if (ctx.isImpersonating) return null;
    const link = await this.liveLinkOf(ctx.userId);
    if (!link) return null;
    const otherId = link.userIds.find((id) => id !== ctx.userId);
    if (!otherId) return null;
    const other = await this.users.findOne({ _id: otherId, deletedAt: null }).lean().exec();
    if (!other) return null;
    return {
      linkId: String(link._id),
      userId: otherId,
      email: other.email,
      fullName: other.fullName,
      views: await this.viewsOf(otherId, other.platformRole),
    };
  }

  /**
   * **A login's views, in the switcher's order** (ADR-0198 §1): a Super Admin login has *Superadmin* alone; an active
   * Owner *Akun saya* and *KPM Owner*; an active Admin who is not the Owner *Akun saya* and *KPM Admin*; anybody else
   * *Akun saya* alone. The frontend's `viewKindsOf` answers the same for the login that is signed in.
   */
  private async viewsOf(userId: string, platformRole: string): Promise<LinkedView[]> {
    if (platformRole === 'super_admin') return [{ kind: 'super_admin', officeName: null }];
    const role = await this.officeRoleOf(userId);
    const self: LinkedView = { kind: 'self', officeName: null };
    if (!role || role.status !== 'active' || !role.kind) return [self];
    return [self, { kind: role.kind, officeName: role.officeName }];
  }

  /**
   * **One login's office, and what it is there** — through the one named cross-office read (ADR-0199 §3). The office's
   * Owner is the office's `ownerUserId` (the single writer), an Admin is the membership's flag; somebody who is both is
   * the Owner, as the console's chip names them.
   */
  private async officeRoleOf(userId: string): Promise<{
    status: 'active' | 'pending'; kind: 'kpm_owner' | 'kpm_admin' | null; officeName: string;
  } | null> {
    const membership = await this.members.officeRoleOfLoginAcrossTenants(userId);
    if (!membership) return null;
    const kpm = await this.kpms
      .findOne({ _id: membership.kpmId, deletedAt: null }, { code: 1, branchName: 1, ownerUserId: 1 })
      .lean()
      .exec();
    if (!kpm) return null;
    const kind = kpm.ownerUserId === userId ? 'kpm_owner' : membership.isKpmAdmin ? 'kpm_admin' : null;
    return { status: membership.status, kind, officeName: kpm.branchName?.trim() || kpm.code };
  }

  /** **Who may be linked**: an Owner's, an Admin's or a Super Admin's login, checked when a link is made (§1). */
  private async isLinkable(user: { _id: unknown; platformRole: string }): Promise<boolean> {
    if (user.platformRole === 'super_admin') return true;
    const role = await this.officeRoleOf(String(user._id));
    return Boolean(role && role.status === 'active' && role.kind);
  }

  /**
   * The login's live link, or `null`. **A link whose other login was deleted is gone with it** (§5, *deleting a login
   * soft-deletes its link*): it is soft-deleted here, the first time a write asks, so the login can be linked again.
   */
  private async liveLinkOf(userId: string, tidy = false): Promise<AccountLinkDocument | null> {
    const link = await this.links.findOne({ userIds: userId, deletedAt: null }).exec();
    if (!link || !tidy) return link;
    const otherId = link.userIds.find((id) => id !== userId);
    if (otherId && (await this.users.exists({ _id: otherId, deletedAt: null }).exec())) return link;
    await this.links
      .updateOne({ _id: link._id, deletedAt: null }, { $set: { deletedAt: this.clock.now(), deletedBy: null } })
      .exec();
    return null;
  }

  // ---------------------------------------------------------------------------- start

  /**
   * **`POST /auth/links`** `{ email, currentPassword }` → `202` (ADR-0199 §2). The caller's password first, so a session
   * alone — stolen or left open — starts nothing; then the address; then the caller's own state. **Then the same answer
   * whatever the other address is**: a link is sent only to a live, active, unlinked Owner's, Admin's or Super Admin's
   * login, with a notice to the caller's address, and for anything else nothing is sent at all.
   */
  async start(ctx: RequestContext, emailRaw: string, currentPassword: string, reader?: Reader): Promise<void> {
    this.limit(`account-link:${ctx.userId}`, LINK_START_LIMIT, LINK_START_WINDOW_SECONDS);
    const me = await this.users.findOne({ _id: ctx.userId, deletedAt: null }).select('+passwordHash').exec();
    if (!me || !(await this.passwords.verify(me.passwordHash, currentPassword))) {
      throw new DomainException(
        ErrorCode.AUTH_INVALID_CREDENTIALS,
        AUTH_REFUSALS.AUTH_INVALID_CREDENTIALS.wrongCurrentPassword,
        HttpStatus.UNAUTHORIZED,
      );
    }

    const email = normalisedEmail(emailRaw);
    if (email === me.email) {
      // A login is never linked to itself (§1).
      throw new DomainException(
        ErrorCode.VALIDATION_FAILED,
        AUTH_REFUSALS.VALIDATION_FAILED.linkOwnAddress,
        HttpStatus.BAD_REQUEST,
        { field: 'email' },
      );
    }
    if (await this.liveLinkOf(ctx.userId, true)) {
      throw new DomainException(ErrorCode.AUTH_LINK_EXISTS, AUTH_REFUSALS.AUTH_LINK_EXISTS.youAreLinked, HttpStatus.CONFLICT);
    }
    if (!me.emailVerifiedAt) {
      // What still needs a proven address asks for one (ADR-0190 §4): the link names this address to the other mailbox.
      throw new DomainException(
        ErrorCode.AUTH_EMAIL_NOT_VERIFIED,
        AUTH_REFUSALS.AUTH_EMAIL_NOT_VERIFIED.linkNeedsVerifiedAddress,
        HttpStatus.CONFLICT,
      );
    }

    // One pending link per login: the one before this stops working, whatever this one turns out to be.
    await this.auth.cancelPendingLink(ctx.userId, 'replaced by a newer link');

    const other = await this.users.findOne({ email, deletedAt: null }).exec();
    const eligible = other !== null
      && other.status !== 'deactivated'
      && !(await this.liveLinkOf(String(other._id), true))
      && (await this.isLinkable(other));

    if (other && eligible) {
      const raw = this.passwords.generateToken();
      await this.tokens.create({
        userId: ctx.userId,
        kind: 'account_link',
        tokenHash: this.passwords.hashToken(raw),
        linkUserId: String(other._id),
        expiresAt: new Date(this.clock.now().getTime() + VERIFICATION_TTL_HOURS * 3_600_000),
      });
      // The link to the other login's mailbox, naming who asked; the notice, with no link, to the caller's own.
      await this.notifications.send({
        userId: String(other._id),
        templateId: NotificationTemplate.ACCOUNT_LINK_REQUEST,
        payload: { token: raw, fullName: other.fullName, requesterName: me.fullName, requesterEmail: me.email },
      });
      await this.notifications.send({
        userId: ctx.userId,
        templateId: NotificationTemplate.ACCOUNT_LINK_REQUESTED,
        payload: { fullName: me.fullName, linkEmail: other.email },
        reader,
      });
    } else {
      // Logged, never answered: the reply is the same either way (§2, the oracle).
      this.logger.log({ userId: ctx.userId }, 'a link was started for an address that cannot be linked; nothing sent');
    }

    await this.audit.record(new RequestContext(ctx.userId, me.platformRole, null), {
      action: 'account_link.requested',
      targetCollection: 'users',
      targetId: ctx.userId,
      after: { linkUserId: other && eligible ? String(other._id) : null },
    });
  }

  // -------------------------------------------------------------------------- confirm

  /**
   * **`POST /auth/links/confirm`** `{ token, password }` → `200` (ADR-0199 §2): the other login's mailbox and password.
   *
   * The token is spent only on success — a wrong password leaves it for a second try, counted by the sign-in limiter for
   * B's address and the client's. Each login's state is read again: deactivated since, linked since, or no longer an
   * Owner's, an Admin's or a Super Admin's is refused and links nothing. On success the link is written, B's address is
   * marked verified (the link proved the mailbox), both addresses are told, and — when this browser holds A's live
   * session (`activeRefresh`) — B is signed in here too, its session handed back to be parked beside A's.
   */
  async confirm(
    rawToken: string, password: string, activeRefresh: string | null, meta: Meta = {},
  ): Promise<LinkConfirmed> {
    const ip = meta.ip ?? 'unknown';
    this.limit(`login:ip:${ip}`, this.loginLimit, LOGIN_WINDOW_SECONDS);

    const pending = await this.pendingLink(rawToken);
    const a = await this.users.findOne({ _id: pending.userId, deletedAt: null }).exec();
    const b = await this.users.findOne({ _id: pending.linkUserId, deletedAt: null }).select('+passwordHash').exec();
    if (!a || !b) throw linkInvalid();

    this.limit(`login:email:${b.email}`, this.loginLimit, LOGIN_WINDOW_SECONDS);
    if (!(await this.passwords.verify(b.passwordHash, password))) {
      throw new DomainException(
        ErrorCode.AUTH_INVALID_CREDENTIALS,
        AUTH_REFUSALS.AUTH_INVALID_CREDENTIALS.wrongLinkedPassword,
        HttpStatus.UNAUTHORIZED,
      );
    }
    this.limiter.reset(`login:ip:${ip}`);
    this.limiter.reset(`login:email:${b.email}`);

    if (a.status === 'deactivated' || b.status === 'deactivated') {
      throw new DomainException(
        ErrorCode.AUTH_ACCOUNT_DEACTIVATED,
        AUTH_REFUSALS.AUTH_ACCOUNT_DEACTIVATED.deactivated,
        HttpStatus.FORBIDDEN,
      );
    }
    if (!(await this.isLinkable(a)) || !(await this.isLinkable(b))) {
      throw new DomainException(ErrorCode.PERM_DENIED, AUTH_REFUSALS.PERM_DENIED.linkRolesOnly, HttpStatus.FORBIDDEN);
    }
    const aId = String(a._id);
    const bId = String(b._id);
    if ((await this.liveLinkOf(aId, true)) || (await this.liveLinkOf(bId, true))) {
      throw linkedSince();
    }

    // Spent once, atomically: two presses at once link once, and the second reads the link as spent.
    const spent = await this.tokens
      .findOneAndUpdate(
        { _id: pending._id, usedAt: null, revokedAt: null },
        { $set: { usedAt: this.clock.now() } },
        { new: true },
      )
      .exec();
    if (!spent) throw linkInvalid();

    let link: AccountLinkDocument;
    try {
      link = await this.links.create({ userIds: linkPair(aId, bId), requestedBy: aId, deletedAt: null, deletedBy: null });
    } catch (err) {
      // Linked in the moment between the check and the write: the unique index is the last word.
      if ((err as { code?: number } | null)?.code === 11000) throw linkedSince();
      throw err;
    }
    const linkId = String(link._id);

    // The link proved B's mailbox, as a reset link does (ADR-0190 §3).
    await this.auth.markVerified(bId);

    // Both told, each naming the other login: *if this was not you, remove the link and change your password*.
    for (const [to, otherEmail] of [[a, b.email], [b, a.email]] as const) {
      try {
        await this.notifications.send({
          userId: String(to._id),
          templateId: NotificationTemplate.ACCOUNT_LINKED,
          payload: { fullName: to.fullName, otherEmail },
        });
      } catch (err) {
        // The link is made; a notice that failed to send is logged, never a refusal that says otherwise.
        this.logger.error({ err, userId: String(to._id) }, 'could not send the linked-login notice');
      }
    }

    await this.audit.record(new RequestContext(bId, b.platformRole, null), {
      action: 'account_link.created',
      targetCollection: 'accountLinks',
      targetId: linkId,
      after: { linkId, userIds: linkPair(aId, bId), requestedBy: aId },
    });

    // The browser that confirms holds A's session: B's password was just given, so B is signed in here too (§2).
    const holdsA = await this.auth.liveSessionOf(activeRefresh, aId);
    const linked = holdsA ? await this.auth.signInProven(bId, meta) : null;
    return { linkId, linkedRefreshToken: linked?.refreshToken ?? null };
  }

  /** The pending link a token names, live — or `400 AUTH_TOKEN_INVALID`, unknown, spent, replaced or expired alike. */
  private async pendingLink(rawToken: string): Promise<AuthTokenDocument & { linkUserId: string }> {
    const record = await this.tokens
      .findOne({ tokenHash: this.passwords.hashToken(rawToken), kind: 'account_link' })
      .exec();
    if (!record || record.usedAt || record.revokedAt || !record.linkUserId) throw linkInvalid();
    if (record.expiresAt.getTime() <= this.clock.now().getTime()) throw linkInvalid();
    return record as AuthTokenDocument & { linkUserId: string };
  }

  // --------------------------------------------------------------------------- switch

  /**
   * **`POST /auth/links/switch`** `{ userId, password? }` (ADR-0199 §4): **never a session for one login made out of the
   * other's.** On every switch: a live link between the caller and `userId` (else `404`, so another person's link is
   * never usable and a removed one is gone), the other login live (`404` deleted) and active (`403` deactivated), and
   * the other login's **own** session on this browser — `linkedRefresh`, rotated as every refresh is. With none, or a
   * dead one, and no password: `409 AUTH_LINK_SIGN_IN_REQUIRED`. With a password: a sign-in for that login, by the
   * sign-in limiter. The active login's own token is handed back, unchanged, to be parked.
   */
  async switchTo(
    ctx: RequestContext,
    targetUserId: string,
    password: string | undefined,
    linkedRefresh: string | null,
    activeRefresh: string | null,
    meta: Meta = {},
  ): Promise<LinkSwitched> {
    if (!password) this.limit(`account-link-switch:${ctx.userId}`, LINK_SWITCH_LIMIT, LINK_SWITCH_WINDOW_SECONDS);

    const link = await this.links
      .findOne({ userIds: { $all: linkPair(ctx.userId, targetUserId) }, deletedAt: null })
      .exec()
      .catch(() => null);
    if (!link || targetUserId === ctx.userId) throw new NotFoundException('Linked login');
    const target = await this.users.findOne({ _id: targetUserId, deletedAt: null }).select('+passwordHash').exec();
    if (!target) throw new NotFoundException('Linked login');
    if (target.status === 'deactivated') {
      throw new DomainException(
        ErrorCode.AUTH_ACCOUNT_DEACTIVATED,
        AUTH_REFUSALS.AUTH_ACCOUNT_DEACTIVATED.deactivated,
        HttpStatus.FORBIDDEN,
      );
    }

    let pair = await this.auth.refreshOwnedBy(linkedRefresh, targetUserId, meta);
    const passwordAsked = pair === null;
    if (!pair) {
      if (!password) {
        throw new DomainException(
          ErrorCode.AUTH_LINK_SIGN_IN_REQUIRED,
          AUTH_REFUSALS.AUTH_LINK_SIGN_IN_REQUIRED.signInFirst,
          HttpStatus.CONFLICT,
        );
      }
      // A sign-in for that login: the sign-in limiter, per client address and per that login's address.
      const ip = meta.ip ?? 'unknown';
      this.limit(`login:ip:${ip}`, this.loginLimit, LOGIN_WINDOW_SECONDS);
      this.limit(`login:email:${target.email}`, this.loginLimit, LOGIN_WINDOW_SECONDS);
      if (!(await this.passwords.verify(target.passwordHash, password))) {
        throw new DomainException(
          ErrorCode.AUTH_INVALID_CREDENTIALS,
          AUTH_REFUSALS.AUTH_INVALID_CREDENTIALS.wrongLinkedPassword,
          HttpStatus.UNAUTHORIZED,
        );
      }
      this.limiter.reset(`login:ip:${ip}`);
      this.limiter.reset(`login:email:${target.email}`);
      pair = await this.auth.signInProven(targetUserId, meta);
    }

    // The active login's own session, parked unchanged — only when it is one, live, of the caller's.
    const parked = (await this.auth.liveSessionOf(activeRefresh, ctx.userId)) ? activeRefresh : null;

    const actor = await this.users.findOne({ _id: ctx.userId }, { platformRole: 1 }).lean().exec();
    await this.audit.record(new RequestContext(ctx.userId, actor?.platformRole ?? 'none', null), {
      action: 'account_link.switched',
      targetCollection: 'accountLinks',
      targetId: String(link._id),
      after: { userId: targetUserId, linkId: String(link._id), passwordAsked },
    });
    return { pair, parked };
  }

  // --------------------------------------------------------------------------- remove

  /**
   * **`DELETE /auth/links/:linkId`** → `204` (ADR-0199 §5), by either login of the pair, with no password: removing
   * reaches nothing. Soft-deleted (invariant 6). Another person's link, or one already removed, is `404`. The other
   * login's sessions are not revoked: they are that login's own.
   */
  async remove(ctx: RequestContext, linkId: string): Promise<void> {
    const link = await this.links
      .findOne({ _id: linkId, userIds: ctx.userId, deletedAt: null })
      .exec()
      .catch(() => null);
    if (!link) throw new NotFoundException('Linked login');
    const { modifiedCount } = await this.links
      .updateOne(
        { _id: link._id, deletedAt: null },
        { $set: { deletedAt: this.clock.now(), deletedBy: ctx.userId } },
      )
      .exec();
    if (modifiedCount === 0) throw new NotFoundException('Linked login');

    const actor = await this.users.findOne({ _id: ctx.userId }, { platformRole: 1 }).lean().exec();
    await this.audit.record(new RequestContext(ctx.userId, actor?.platformRole ?? 'none', null), {
      action: 'account_link.removed',
      targetCollection: 'accountLinks',
      targetId: linkId,
      after: { userId: link.userIds.find((id) => id !== ctx.userId) ?? null, linkId },
    });
  }

  // ---------------------------------------------------------------------------- limits

  /** `RATE_LIMIT_LOGIN_PER_15M`, as sign-in reads it. */
  private get loginLimit(): number {
    return this.config.get<number>('RATE_LIMIT_LOGIN_PER_15M') ?? 5;
  }

  private limit(key: string, limit: number, windowSeconds: number): void {
    const retryAfter = this.limiter.check(key, limit, windowSeconds);
    if (retryAfter === null) return;
    throw new DomainException(
      ErrorCode.AUTH_RATE_LIMITED,
      AUTH_REFUSALS.AUTH_RATE_LIMITED.tooMany({ minutes: Math.ceil(retryAfter / 60) }),
      HttpStatus.TOO_MANY_REQUESTS,
      { retryAfterSeconds: retryAfter },
    );
  }
}

/** A link's token that does not work: `verify-email`'s answer, the same code and sentence. */
function linkInvalid(): DomainException {
  return new DomainException(
    ErrorCode.AUTH_TOKEN_INVALID,
    AUTH_REFUSALS.AUTH_TOKEN_INVALID.linkInvalid,
    HttpStatus.BAD_REQUEST,
  );
}

function linkedSince(): DomainException {
  return new DomainException(ErrorCode.AUTH_LINK_EXISTS, AUTH_REFUSALS.AUTH_LINK_EXISTS.linkedSince, HttpStatus.CONFLICT);
}
