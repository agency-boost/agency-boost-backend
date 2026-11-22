import { HttpStatus, Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { randomBytes } from 'node:crypto';
import { isValidObjectId, Model } from 'mongoose';
import { Clock } from '@/common/clock/clock.port';
import { RequestContext } from '@/common/context/request-context';
import { DomainException, NotFoundException, PermissionDeniedException } from '@/common/errors/domain.exception';
import { ErrorCode } from '@/common/errors/error-codes';
import type { Sentence } from '@/common/i18n/sentence';
import { ROSTER_INVITATION } from '@/domain/constants';
import { AuditService } from '@/modules/audit/audit.service';
import { AuthToken, type AuthTokenDocument } from '@/modules/auth/auth-token.schema';
import { PasswordService } from '@/modules/auth/password.service';
import { RateLimiter } from '@/modules/auth/rate-limiter';
import { MembershipRepository } from '@/modules/org/membership.repository';
import { can } from '@/modules/rbac/permissions';
import { User, type UserDocument } from '@/modules/users/user.schema';
import { Company, type CompanyDocument } from './company.schema';
import { Kpm, type KpmDocument } from './kpm.schema';
import { OWNER_CLAIM_REFUSALS } from './owner-claims.messages';
import { TenantService } from './tenant.service';
import { TENANTS_REFUSALS } from './tenants.messages';

/**
 * How many WhatsApp invitations one KPM's Owner may be given an hour (P19.23-T2 AC-3). Each press mints a new link and
 * kills the last, so this only stops a runaway button; a Super Admin sending the first and correcting a wrong number is
 * well inside it.
 */
export const OWNER_WHATSAPP_LIMIT = 10;
export const OWNER_WHATSAPP_WINDOW_SECONDS = 60 * 60;

/** What *Kirim undangan* answers the Super Admin's screen, which opens their own WhatsApp with it (`wa.me`, OD-359). */
export interface OwnerWhatsAppInvitation {
  /**
   * `claim` — the person named with no account opens the link, signs in or signs up, and accepts it; `password` — an
   * Owner whose account never signed in opens the link to choose their password (the email invitation's link).
   */
  kind: 'claim' | 'password';
  /** The one-time link, in this answer and nowhere else; never logged, never stored raw. */
  link: string;
  ownerName: string;
  /** The number WhatsApp opens to, `+62…`, or `null` when the account has none on file. */
  ownerPhone: string | null;
  kpmName: string;
  kpmCode: string;
  companyName: string;
  expiresAt: string;
}

/** The claim link's banner (`GET /owner-invites/:token`): which KPM, of which company, for whom. Nothing else. */
export interface OwnerInviteBanner {
  kpmName: string;
  kpmCode: string;
  companyName: string;
  ownerName: string;
  expiresAt: string;
}

/** What accepting answers: the KPM the person now owns. */
export interface OwnerInviteAccepted {
  kpmId: string;
  kpmName: string;
}

/**
 * **The KPM Owner, invited by WhatsApp** (P19.23-T2 AC-3; ADR-0277; OD-420; the Super Admin spec of 20 November §5
 * *"owner invited by WhatsApp"*). The product sends nothing by WhatsApp: the Super Admin's own WhatsApp opens with the
 * Owner's number and a message carrying a one-time link (`wa.me`, OD-359's default). Two kinds of link:
 *
 * - **A claim link, for an Owner named with no email** (`kpms.pendingOwner`): there is no account to send a password to
 *   — an account is an email (ADR-0010) — so the link lets the person make one, or use theirs, and **claim the KPM**:
 *   signed in, they accept, and become its Owner through the checks every Owner meets (`TenantService.refuseOwner`: the
 *   KPM's company, an agent code, a verified address). The token is `<kpmId>.<secret>` (192 random bits), stored only as
 *   its sha256 on the KPM (`pendingOwner.invite`), alive `ROSTER_INVITATION.TTL_DAYS`, **single use**, and a new one
 *   replaces the last.
 * - **The password link, for an Owner whose account never signed in**: the email invitation's own link
 *   (`/reset-password/<token>`, a `password_reset` token, the account's older links revoked), here handed to the Super
 *   Admin instead of emailed. ADR-0212 §4 kept that link out of every chat; OD-420's default supersedes it for this one
 *   case, as a member's invite link already travels by WhatsApp (`inviteWhatsAppLink`) — the same risk, the same answer.
 *
 * Every send is audited `kpm.owner_invited` with `channel: 'whatsapp'`; the claim is audited in the KPM's log as
 * `kpm.owner_assigned`, its actor the person who claimed. An Owner who has signed in is invited to nothing (`409
 * TENANT_OWNER_NOT_INVITABLE`, `signed_in`), and a KPM with no Owner named has nobody to invite (`no_owner`).
 */
@Injectable()
export class OwnerClaims {
  constructor(
    @InjectModel(Kpm.name) private readonly kpms: Model<KpmDocument>,
    @InjectModel(Company.name) private readonly companies: Model<CompanyDocument>,
    @InjectModel(User.name) private readonly users: Model<UserDocument>,
    @InjectModel(AuthToken.name) private readonly tokens: Model<AuthTokenDocument>,
    private readonly passwords: PasswordService,
    private readonly memberships: MembershipRepository,
    private readonly tenants: TenantService,
    private readonly limiter: RateLimiter,
    private readonly audit: AuditService,
    private readonly clock: Clock,
  ) {}

  /**
   * ***Kirim undangan* by WhatsApp** (`POST /admin/tenants/:id/owner/whatsapp-invitation`): a fresh link for the KPM's
   * Owner — the claim link for one named with no email, the password link for an account never signed in — and what the
   * screen needs to write the message. Refused before anything is written: `404` for an unknown KPM, `409
   * TENANT_OWNER_NOT_INVITABLE` for no Owner or one who has signed in, `429` past `OWNER_WHATSAPP_LIMIT` an hour.
   */
  async invite(ctx: RequestContext, kpmId: string, appOrigin: string): Promise<OwnerWhatsAppInvitation> {
    if (!can(ctx, 'kpm:assign_owner')) throw new PermissionDeniedException('kpm:assign_owner');
    const kpm = isValidObjectId(kpmId) ? await this.kpms.findOne({ _id: kpmId, deletedAt: null }).exec() : null;
    if (!kpm) throw new NotFoundException('KPM');

    const say = TENANTS_REFUSALS.TENANT_OWNER_NOT_INVITABLE;
    const refusal = (reason: 'no_owner' | 'signed_in', sentence: Sentence<typeof ErrorCode.TENANT_OWNER_NOT_INVITABLE>) =>
      new DomainException(ErrorCode.TENANT_OWNER_NOT_INVITABLE, sentence, HttpStatus.CONFLICT, { reason, kpmId });
    const owner = kpm.ownerUserId && isValidObjectId(kpm.ownerUserId)
      ? await this.users.findOne({ _id: kpm.ownerUserId, deletedAt: null }).exec()
      : null;
    if (!owner && !kpm.pendingOwner) throw refusal('no_owner', say.noOwner);
    if (owner?.lastLoginAt) throw refusal('signed_in', say.signedIn({ name: owner.fullName }));
    this.limit(`owner-whatsapp:${kpmId}`, OWNER_WHATSAPP_LIMIT, OWNER_WHATSAPP_WINDOW_SECONDS);

    const origin = appOrigin.replace(/\/+$/, '');
    const now = this.clock.now();
    const expiresAt = new Date(now.getTime() + ROSTER_INVITATION.TTL_DAYS * 24 * 60 * 60_000);
    const company = await this.companies.findOne({ _id: kpm.companyId }).select('name').lean().exec() as { name?: string } | null;
    const about = { kpmName: kpm.branchName, kpmCode: kpm.code, companyName: company?.name ?? '' };

    if (owner) {
      // The email invitation's link (`OwnerInvitations.send`), minted the same way and handed over instead of emailed.
      const userId = String(owner._id);
      await this.tokens.updateMany(
        { userId, kind: 'password_reset', usedAt: null, revokedAt: null },
        { $set: { revokedAt: now, revokedReason: 'owner_invitation_resent' } },
      ).exec();
      const raw = this.passwords.generateToken();
      await this.tokens.create({ userId, kind: 'password_reset', tokenHash: this.passwords.hashToken(raw), expiresAt });
      // *Diundang*: the Owner's membership in this KPM, through the scoped repository with the office named.
      await this.memberships.updateMany(
        RequestContext.superAdminInTenant(ctx.auditActors.actorUserId, kpmId),
        { userId, status: { $in: ['active', 'pending'] } },
        { $set: { invitedAt: now } },
      );
      await this.audit.record(ctx, {
        action: 'kpm.owner_invited',
        targetCollection: 'kpms',
        targetId: kpmId,
        after: { userId, email: owner.email, channel: 'whatsapp', kind: 'password' },
      });
      return {
        kind: 'password', link: `${origin}/reset-password/${raw}`, ownerName: owner.fullName,
        ownerPhone: owner.phone ?? null, ...about, expiresAt: expiresAt.toISOString(),
      };
    }

    const pending = kpm.pendingOwner!;
    const token = `${kpmId}.${randomBytes(24).toString('base64url')}`;
    // Only the latest link works: the new hash replaces the last one on the KPM.
    await this.kpms.updateOne(
      { _id: kpmId },
      { $set: { 'pendingOwner.invite': { tokenHash: this.passwords.hashToken(token), invitedAt: now, expiresAt, usedAt: null } } },
    ).exec();
    await this.audit.record(ctx, {
      action: 'kpm.owner_invited',
      targetCollection: 'kpms',
      targetId: kpmId,
      after: { fullName: pending.fullName, channel: 'whatsapp', kind: 'claim', resent: Boolean(pending.invite) },
    });
    return {
      kind: 'claim', link: `${origin}/owner-invite/${token}`, ownerName: pending.fullName, ownerPhone: pending.phone,
      ...about, expiresAt: expiresAt.toISOString(),
    };
  }

  /** **The claim link's banner** — public: the person opening it has no account yet, perhaps. A dead link is `404`. */
  async banner(token: string): Promise<OwnerInviteBanner> {
    const { kpm } = await this.open(token);
    const company = await this.companies.findOne({ _id: kpm.companyId }).select('name').lean().exec() as { name?: string } | null;
    return {
      kpmName: kpm.branchName,
      kpmCode: kpm.code,
      companyName: company?.name ?? '',
      ownerName: kpm.pendingOwner!.fullName,
      expiresAt: kpm.pendingOwner!.invite!.expiresAt.toISOString(),
    };
  }

  /**
   * **The signed-in account claims the KPM** (`POST /owner-invites/:token/accept`): checked as every Owner is — the KPM's
   * company and an agent code (`409 TENANT_COMPANY_MISMATCH`), a verified address (`409 AUTH_EMAIL_NOT_VERIFIED`) —
   * **before the link is spent**, so a refusal leaves it working for when the person has put it right. Then the link is
   * taken (single use: a second tap, or a second person, meets `404` *already used*) and the Owner written; a refusal
   * there (the leader limit) gives the link back.
   */
  async accept(ctx: RequestContext, token: string): Promise<OwnerInviteAccepted> {
    const { kpm, hash } = await this.open(token);
    const user = isValidObjectId(ctx.userId) ? await this.users.findOne({ _id: ctx.userId, deletedAt: null }).exec() : null;
    if (!user) throw new NotFoundException('User');
    await this.tenants.refuseOwner(user, kpm.companyId, { requireVerified: true });

    const now = this.clock.now();
    const kpmId = String(kpm._id);
    const taken = await this.kpms.updateOne(
      { _id: kpmId, deletedAt: null, ownerUserId: null, 'pendingOwner.invite.tokenHash': hash, 'pendingOwner.invite.usedAt': null },
      { $set: { 'pendingOwner.invite.usedAt': now } },
    ).exec();
    if (taken.modifiedCount === 0) throw this.dead(OWNER_CLAIM_REFUSALS.NOT_FOUND.alreadyUsed);

    try {
      const installed = await this.tenants.installClaimedOwner(ctx, kpm, user);
      if (!installed) throw this.dead(OWNER_CLAIM_REFUSALS.NOT_FOUND.alreadyUsed);
    } catch (err) {
      await this.kpms.updateOne(
        { _id: kpmId, ownerUserId: null, 'pendingOwner.invite.tokenHash': hash },
        { $set: { 'pendingOwner.invite.usedAt': null } },
      ).exec();
      throw err;
    }
    return { kpmId, kpmName: kpm.branchName };
  }

  /** The KPM a live claim link opens, or the plain-words `404` that says why it opens nothing. */
  private async open(token: string): Promise<{ kpm: KpmDocument; hash: string }> {
    const [kpmId, secret] = (token ?? '').split('.');
    if (!secret || !isValidObjectId(kpmId)) throw this.dead(OWNER_CLAIM_REFUSALS.NOT_FOUND.linkNotValid);
    const kpm = await this.kpms.findOne({ _id: kpmId, deletedAt: null }).exec();
    // An archived KPM is nobody's to own, and to the person holding the link it reads as no KPM at all.
    if (!kpm || kpm.status === 'archived') throw this.dead(OWNER_CLAIM_REFUSALS.NOT_FOUND.linkNotValid);
    const hash = this.passwords.hashToken(token);
    const invite = kpm.pendingOwner?.invite;
    if (!invite || kpm.ownerUserId) {
      // The KPM has its Owner now (this link used, or another way): say so, rather than *not valid*.
      throw this.dead(kpm.ownerUserId ? OWNER_CLAIM_REFUSALS.NOT_FOUND.alreadyUsed : OWNER_CLAIM_REFUSALS.NOT_FOUND.linkNotValid);
    }
    if (!this.passwords.tokensMatch(invite.tokenHash, hash)) throw this.dead(OWNER_CLAIM_REFUSALS.NOT_FOUND.linkNotValid);
    if (invite.usedAt) throw this.dead(OWNER_CLAIM_REFUSALS.NOT_FOUND.alreadyUsed);
    if (new Date(invite.expiresAt).getTime() <= this.clock.now().getTime()) throw this.dead(OWNER_CLAIM_REFUSALS.NOT_FOUND.expired);
    return { kpm, hash };
  }

  private dead(sentence: Sentence<'NOT_FOUND'>): DomainException {
    return new DomainException(ErrorCode.NOT_FOUND, sentence, HttpStatus.NOT_FOUND);
  }

  private limit(key: string, max: number, windowSeconds: number): void {
    const retryAfter = this.limiter.check(key, max, windowSeconds);
    if (retryAfter === null) return;
    throw new DomainException(
      ErrorCode.AUTH_RATE_LIMITED,
      OWNER_CLAIM_REFUSALS.AUTH_RATE_LIMITED.tooMany({ minutes: Math.ceil(retryAfter / 60) }),
      HttpStatus.TOO_MANY_REQUESTS,
      { retryAfterSeconds: retryAfter },
    );
  }
}
