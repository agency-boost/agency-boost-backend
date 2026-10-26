import { HttpStatus, Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { Clock } from '@/common/clock/clock.port';
import { RequestContext } from '@/common/context/request-context';
import { DomainException, NotFoundException } from '@/common/errors/domain.exception';
import { ErrorCode } from '@/common/errors/error-codes';
import { AuditService } from '@/modules/audit/audit.service';
import { can, SETUP_SESSION_WRITE_SCOPE } from '@/modules/rbac/permissions';
import { Kpm, KpmDocument } from '@/modules/tenants/kpm.schema';
import { User, UserDocument } from '@/modules/users/user.schema';
import {
  ImpersonationPurpose, ImpersonationSession, ImpersonationSessionDocument,
} from './impersonation-session.schema';
import { MembershipRepository } from '@/modules/org/membership.repository';
import { NotificationService } from '@/modules/notifications/notification.service';
import { NotificationTemplate } from '@/modules/notifications/notification.types';
import { PasswordService } from './password.service';
import { TokenSigner } from './token-signer';

export const IMPERSONATION_MAX_MINUTES = 60;

/**
 * Support impersonation, time-boxed and dually attributed.
 *
 * The whole feature is defensible only because every action it produces records both
 * the real Super Admin and the person they acted as. That is why impersonating another
 * Super Admin is forbidden to everyone: it would erase exactly that distinction.
 */
@Injectable()
export class ImpersonationService {
  constructor(
    @InjectModel(User.name) private readonly users: Model<UserDocument>,
    @InjectModel(Kpm.name) private readonly kpms: Model<KpmDocument>,
    @InjectModel(ImpersonationSession.name)
    private readonly sessions: Model<ImpersonationSessionDocument>,
    private readonly memberships: MembershipRepository,
    private readonly notifications: NotificationService,
    private readonly signer: TokenSigner,
    private readonly passwords: PasswordService,
    private readonly audit: AuditService,
    private readonly clock: Clock,
  ) {}

  async start(
    ctx: RequestContext,
    targetUserId: string,
    reason: string,
    durationMinutes = IMPERSONATION_MAX_MINUTES,
    /** `setup` may write the office's setup and nothing else (ADR-0162); `support` only looks. */
    purpose: ImpersonationPurpose = 'support',
  ): Promise<{
    accessToken: string; expiresAt: Date; sessionId: string; readOnly: boolean;
    purpose: ImpersonationPurpose; writeScope: string[];
  }> {
    /*
     * **This one first, and the order is the point.**
     *
     * `impersonation:start` is on P4-T10's hard-blocked list, so `can()` already refuses
     * it inside a session — which made this check unreachable and its message
     * unreachable with it. A Super Admin who is mid-session and tries again deserves
     * *"end that session first"*, not a flat "only a Super Admin can do this", which is
     * both unhelpful and untrue of them.
     */
    if (ctx.isImpersonating) {
      throw new DomainException(
        ErrorCode.PERM_DENIED,
        'You are already impersonating. End that session first.',
        HttpStatus.FORBIDDEN,
      );
    }
    if (!can(ctx, 'impersonation:start')) {
      throw new DomainException(
        ErrorCode.PERM_DENIED,
        'Only a Super Admin can impersonate a user.',
        HttpStatus.FORBIDDEN,
        { permission: 'impersonation:start' },
      );
    }
    if (!reason?.trim()) {
      throw new DomainException(
        ErrorCode.VALIDATION_FAILED,
        'A reason is required to impersonate a user.',
        HttpStatus.BAD_REQUEST,
        { field: 'reason' },
      );
    }

    const target = await this.users
      .findOne({ _id: targetUserId, deletedAt: null })
      .exec()
      // A malformed id is "not here", not a 500: these arrive from a URL, and an
      // uncaught CastError renders as INTERNAL_ERROR and is logged as unhandled.
      .catch(() => null);
    if (!target) throw new NotFoundException('User');

    if (target.platformRole === 'super_admin') {
      // Granted to nobody, deliberately — see the denial row in the permission matrix.
      throw new DomainException(
        ErrorCode.PERM_DENIED,
        'A Super Admin cannot be impersonated.',
        HttpStatus.FORBIDDEN,
        { permission: 'impersonation:target_super_admin' },
      );
    }
    if (String(target._id) === ctx.userId) {
      throw new DomainException(
        ErrorCode.PERM_DENIED,
        'You cannot impersonate yourself.',
        HttpStatus.FORBIDDEN,
      );
    }

    /*
     * Impersonating a tenant admin is **permitted and separately granted** (§3.13).
     *
     * Refusing it outright would make the highest-value support cases unsupportable —
     * tenant admins are exactly the people whose screens break. So it is its own
     * permission rather than a blanket no, and `start()` checked only for another Super
     * Admin until now: the row existed in the matrix and was referenced nowhere.
     */
    const membership = await this.memberships.liveForUserAnywhere(targetUserId);
    const ownedByTarget = await this.kpms
      .findOne({ ownerUserId: targetUserId, deletedAt: null }).exec();
    const targetIsAdmin = Boolean(ownedByTarget) || Boolean(membership?.adminAccess?.isKpmAdmin);

    if (targetIsAdmin && !can(ctx, 'impersonation:target_kpm_admin_or_owner')) {
      throw new DomainException(
        ErrorCode.PERM_DENIED,
        'Impersonating an office\'s Owner or Admin needs its own grant.',
        HttpStatus.FORBIDDEN,
        { permission: 'impersonation:target_kpm_admin_or_owner' },
      );
    }

    const owned = ownedByTarget;

    /*
     * **In the target's tenant, not the platform's** (P4-T10).
     *
     * `impersonation.started` was written with the platform context, so it landed with
     * `kpmId: null` while `impersonation.ended` landed in the tenant's log — an Owner saw
     * a session end that they never saw begin, which is the worst possible half of that
     * pair to be missing.
     */
    const kpmId = membership?.kpmId ?? (owned ? String(owned._id) : null);
    /*
     * The office the target is **in**, and its Owner — not an office the target happens to
     * own.
     *
     * `ownedByTarget` answers "are they an admin", which is a different question. Reading
     * the Owner off it notified nobody for the ordinary case: an agent in somebody else's
     * office, which is most support cases. A test caught it.
     */
    const office = membership?.kpmId
      ? await this.kpms.findOne({ _id: membership.kpmId, deletedAt: null }).exec()
      : owned;

    /*
     * **An office nobody can use is refused here, whoever in it is named** (P13.2 exit review).
     *
     * `ContextResolver` refuses every request of a suspended or archived office's member, a support
     * session's included, so a session started there could do nothing — and its first request, the
     * session's own `/auth/me`, replaced the Super Admin's console with the member's *office
     * unavailable* page. This used to look only at an office the target **owns**, and only under
     * `TENANT_SUSPENDED`, the member's own code, which the app treats as *your office*. Now it reads the
     * office the target is in, as well, and refuses under its own code: a `409` the support screen shows
     * as an error, naming the office and why. An ended subscription is not refused: support may look
     * into an ended office (ADR-0112 §3).
     */
    for (const unavailable of [office, owned]) {
      if (unavailable && unavailable.status !== 'active') {
        const reason = unavailable.status === 'archived' ? 'archived' : 'suspended';
        throw new DomainException(
          ErrorCode.IMPERSONATION_OFFICE_UNAVAILABLE,
          `KPM ${unavailable.code} · ${unavailable.branchName} is ${reason}, so nobody can act as `
            + 'its members until it is reactivated.',
          HttpStatus.CONFLICT,
          { kpmCode: unavailable.code, branch: unavailable.branchName, reason },
        );
      }
    }

    /*
     * **A setup session acts as somebody who configures an office** (ADR-0162 §1): its Owner, or one of its
     * Admins, in an office the loop above has found active. Anybody else has no settings to change, so the
     * session would be a support session that says otherwise. Refused before anything is written.
     */
    const setsUpTheOffice = Boolean(ownedByTarget)
      || (membership?.status === 'active' && Boolean(membership.adminAccess?.isKpmAdmin));
    if (purpose === 'setup' && !setsUpTheOffice) {
      throw new DomainException(
        ErrorCode.IMPERSONATION_SETUP_TARGET,
        'A setup session acts as an office\'s Owner or one of its Admins, and this person is neither. '
          + 'Start a support session to look at their screens.',
        HttpStatus.CONFLICT,
        { purpose },
      );
    }
    const writeScope = purpose === 'setup' ? [...SETUP_SESSION_WRITE_SCOPE] : [];

    const minutes = Math.min(Math.max(1, Math.floor(durationMinutes)), IMPERSONATION_MAX_MINUTES);
    const ttlSeconds = minutes * 60;
    const inTenant = kpmId
      ? RequestContext.superAdminInTenant(ctx.userId, kpmId)
      : ctx;

    // `sid` records who is really acting, so the resolved context can carry both.
    const accessToken = this.signer.sign({ sub: targetUserId, sid: `imp:${ctx.userId}` }, ttlSeconds);
    const expiresAt = new Date(this.clock.now().getTime() + ttlSeconds * 1000);

    /**
     * **The session, so that ending it can mean something.**
     *
     * The access token is a stateless JWT: nothing about presenting it consults the
     * database, which is what makes every other request cheap. It also meant `end()` had
     * nothing to revoke — it wrote an audit row and the token stayed valid for the rest
     * of its hour. Anyone holding a copy kept acting as the target.
     *
     * The row is keyed by the token's own hash, like every other credential here, so the
     * guard can ask one indexed question and only for the rare request that carries an
     * `imp:` session.
     */
    /*
     * **A double start is refused, not crashed** (ADR-0168 §4). Two starts by one Super Admin as the same person
     * within one second sign the same token (`iat` is in seconds), so this row's `tokenHash` meets the first's
     * unique index. Only that collision is answered `409`; anything else is still thrown as it was. The row comes
     * before the audit entry and the notices, so a refused start has written nothing.
     */
    let session: ImpersonationSessionDocument;
    try {
      session = await this.sessions.create({
        realActorUserId: ctx.userId,
        effectiveUserId: targetUserId,
        kpmId,
        tokenHash: this.passwords.hashToken(accessToken),
        // Read-only until a *second* Super Admin says otherwise. The operator who wants to
        // write is not the one who decides they may — except the setup screens' own
        // permissions, which a setup session names here (ADR-0162 §2).
        readOnly: true,
        purpose,
        writeScope,
        elevatedByUserId: null,
        elevatedAt: null,
        reason: reason.trim(),
        elevationReason: null,
        startedAt: this.clock.now(),
        expiresAt,
        endedAt: null,
        deletedAt: null,
      });
    } catch (err) {
      if (isDuplicateTokenHash(err)) {
        throw new DomainException(
          ErrorCode.IMPERSONATION_JUST_STARTED,
          'A session as this person started a moment ago. Use that one, or wait a second and start again.',
          HttpStatus.CONFLICT,
        );
      }
      throw err;
    }

    const sessionId = String(session._id);
    /*
     * **After the row, so the entry names it** (ADR-0162 §3): the Owner's log can then tie the start to the
     * session's elevation and its end. The purpose and the scope are the trust extended, recorded where an
     * Owner reads them.
     */
    await this.audit.record(inTenant, {
      action: 'impersonation.started',
      targetCollection: 'users',
      targetId: targetUserId,
      after: { reason: reason.trim(), minutes, readOnly: true, purpose, sessionId, writeScope },
    });

    await this.announce(targetUserId, kpmId, office?.ownerUserId ?? null, reason.trim(), purpose);

    return { accessToken, expiresAt, sessionId, readOnly: true, purpose, writeScope };
  }

  /**
   * End the session, and mean it.
   *
   * Every open impersonation row for this person is revoked, not just the token that made
   * this request: an operator who somehow holds two should lose both, and the caller
   * cannot present a token it does not have. The guard refuses a revoked session from the
   * next request onward.
   */
  async end(ctx: RequestContext): Promise<void> {
    if (!ctx.isImpersonating) return;

    await this.sessions
      .updateMany(
        { effectiveUserId: ctx.userId, endedAt: null },
        { $set: { endedAt: this.clock.now() } },
      )
      .exec();

    await this.audit.record(ctx, {
      action: 'impersonation.ended',
      targetCollection: 'users',
      targetId: ctx.userId,
    });
  }

  /**
   * Is this impersonation token still live?
   *
   * Called by `AuthGuard`, and **only** for a token carrying an `imp:` session — a
   * refresh-token round trip on every ordinary request would be the wrong trade. A
   * session with no row is refused too: a token minted before this existed, or one whose
   * row was pruned, is not something to trust.
   */
  async liveSession(rawToken: string): Promise<ImpersonationSessionDocument | null> {
    const row = await this.sessions
      .findOne({ tokenHash: this.passwords.hashToken(rawToken), deletedAt: null })
      .exec();
    if (!row || row.endedAt) return null;
    return row.expiresAt.getTime() > this.clock.now().getTime() ? row : null;
  }

  /**
   * Let a session write — approved by a **different** Super Admin (§3.13).
   *
   * The two-person rule is the whole control. An admin session can rewrite the
   * configuration every member of an office depends on, and the operator best placed to
   * notice that is a bad idea is somebody other than the one having the idea. So the
   * approver is checked against the session's own starter, not merely against "is a Super
   * Admin" — otherwise the rule reads as two people and means one.
   */
  async elevate(ctx: RequestContext, sessionId: string, reason: string): Promise<void> {
    if (!can(ctx, 'impersonation:elevate_to_write')) {
      throw new DomainException(
        ErrorCode.PERM_DENIED,
        'Only a Super Admin can approve writing in a support session.',
        HttpStatus.FORBIDDEN,
        { permission: 'impersonation:elevate_to_write' },
      );
    }
    if (ctx.isImpersonating) {
      // Otherwise a session could approve itself by impersonating another Super Admin —
      // which `impersonation:target_super_admin` already forbids, but defence in depth
      // costs one line here and the alternative is a hole nobody can see from one file.
      throw new DomainException(
        ErrorCode.PERM_DENIED,
        'End your own support session before approving one.',
        HttpStatus.FORBIDDEN,
      );
    }
    if (!reason?.trim()) {
      throw new DomainException(
        ErrorCode.VALIDATION_FAILED,
        'Say why this session needs to write. The office\'s Owner reads it.',
        HttpStatus.BAD_REQUEST,
        { field: 'reason' },
      );
    }

    const session = await this.sessions
      .findOne({ _id: sessionId, deletedAt: null }).exec()
      .catch(() => null);
    if (!session || session.endedAt) throw new NotFoundException('Support session');
    if (session.expiresAt.getTime() <= this.clock.now().getTime()) {
      throw new NotFoundException('Support session');
    }

    if (session.realActorUserId === ctx.userId) {
      throw new DomainException(
        ErrorCode.PERM_DENIED,
        'A second Super Admin has to approve this — not the one running the session.',
        HttpStatus.FORBIDDEN,
      );
    }

    session.readOnly = false;
    session.elevatedByUserId = ctx.userId;
    session.elevatedAt = this.clock.now();
    session.elevationReason = reason.trim();
    await session.save();

    const inTenant = session.kpmId
      ? RequestContext.superAdminInTenant(ctx.userId, session.kpmId)
      : ctx;
    await this.audit.record(inTenant, {
      action: 'impersonation.elevated',
      targetCollection: 'users',
      targetId: session.effectiveUserId,
      after: {
        sessionId,
        approvedBy: ctx.userId,
        startedBy: session.realActorUserId,
        reason: reason.trim(),
      },
    });

    await this.notifications.send({
      userId: session.effectiveUserId,
      kpmId: session.kpmId,
      templateId: NotificationTemplate.IMPERSONATION_ELEVATED,
      payload: { reason: reason.trim() },
    });
  }

  /**
   * Tell the office a session has begun — **the person and their Owner, always** (§3.13).
   *
   * Not a per-office setting. Somebody being acted as has a right to know, and the Owner
   * is who they would ask about it; making either one optional would make the notice
   * something an office could be configured out of.
   *
   * A failure here does not fail the session: `NotificationService` records a failed
   * channel and carries on, and a support case that cannot start because a mail server is
   * down helps nobody.
   */
  private async announce(
    targetUserId: string,
    kpmId: string | null,
    ownerUserId: string | null,
    reason: string,
    purpose: ImpersonationPurpose,
  ): Promise<void> {
    const told = new Set<string>();
    for (const userId of [targetUserId, ownerUserId]) {
      if (!userId || told.has(userId)) continue;
      told.add(userId);
      await this.notifications.send({
        userId,
        kpmId,
        templateId: NotificationTemplate.IMPERSONATION_STARTED,
        // The notice says which kind of session it is (ADR-0162 §3): a setup one changes things.
        payload: { reason, isSubject: userId === targetUserId, purpose },
      });
    }
  }
}

/**
 * Mongo's duplicate-key error (`E11000`) on the session's `tokenHash` index, and nothing else: another index, or any
 * other failure, is not a start that collided with one a moment ago.
 */
function isDuplicateTokenHash(err: unknown): boolean {
  const e = err as { code?: number; keyPattern?: Record<string, unknown>; keyValue?: Record<string, unknown> } | null;
  if (e?.code !== 11000) return false;
  return Boolean(e.keyPattern && 'tokenHash' in e.keyPattern) || Boolean(e.keyValue && 'tokenHash' in e.keyValue);
}
