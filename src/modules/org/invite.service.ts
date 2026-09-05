import { HttpStatus, Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { randomInt } from 'node:crypto';
import { Clock } from '@/common/clock/clock.port';
import { RequestContext } from '@/common/context/request-context';
import { DomainException, NotFoundException } from '@/common/errors/domain.exception';
import { ErrorCode } from '@/common/errors/error-codes';
import { AuditService } from '@/modules/audit/audit.service';
import { NotificationService } from '@/modules/notifications/notification.service';
import { NotificationTemplate } from '@/modules/notifications/notification.types';
import { Company, CompanyDocument } from '@/modules/tenants/company.schema';
import { Kpm, KpmDocument } from '@/modules/tenants/kpm.schema';
import { User, UserDocument } from '@/modules/users/user.schema';
import { HierarchyService } from './hierarchy.service';
import { InviteCode, InviteCodeDocument } from './invite-code.schema';
import { JoinRequest, JoinRequestDocument } from './join-request.schema';
import { MembershipRepository } from './membership.repository';

export interface IssuedInvite {
  inviteId: string;
  code: string;
  /** The shareable form. The QR encodes exactly this string. */
  url: string;
  label: string | null;
  autoApprove: boolean;
  maxUses: number | null;
  useCount: number;
  expiresAt: string | null;
  revokedAt: string | null;
  /** Derived, because "why can nobody use this" needs one answer, not three fields. */
  state: 'active' | 'revoked' | 'expired' | 'exhausted';
}

export interface InvitePreview {
  code: string;
  kpmLabel: string;
  leaderName: string;
}

/**
 * Alphabet without `0`, `O`, `1`, `I` — a code gets read aloud and written on paper, and
 * those four are the pairs people get wrong.
 */
const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const CODE_LENGTH = 6;

@Injectable()
export class InviteService {
  constructor(
    private readonly members: MembershipRepository,
    private readonly hierarchy: HierarchyService,
    @InjectModel(InviteCode.name) private readonly invites: Model<InviteCodeDocument>,
    @InjectModel(JoinRequest.name) private readonly requests: Model<JoinRequestDocument>,
    @InjectModel(Kpm.name) private readonly kpms: Model<KpmDocument>,
    @InjectModel(Company.name) private readonly companies: Model<CompanyDocument>,
    @InjectModel(User.name) private readonly users: Model<UserDocument>,
    private readonly audit: AuditService,
    private readonly notifications: NotificationService,
    private readonly clock: Clock,
  ) {}

  private generateCode(): string {
    let code = '';
    // randomInt, not Math.random: this is a credential that tags a stranger to a unit
    // without anybody approving it, and a predictable one is a way into somebody's team.
    for (let i = 0; i < CODE_LENGTH; i += 1) {
      code += CODE_ALPHABET[randomInt(CODE_ALPHABET.length)];
    }
    return code;
  }

  private state(invite: InviteCodeDocument): IssuedInvite['state'] {
    if (invite.revokedAt) return 'revoked';
    if (invite.expiresAt && invite.expiresAt <= this.clock.now()) return 'expired';
    if (invite.maxUses !== null && invite.useCount >= invite.maxUses) return 'exhausted';
    return 'active';
  }

  private present(invite: InviteCodeDocument, baseUrl: string): IssuedInvite {
    return {
      inviteId: String(invite._id),
      code: invite.code,
      url: `${baseUrl}/join?code=${invite.code}`,
      label: invite.label,
      autoApprove: invite.autoApprove,
      maxUses: invite.maxUses,
      useCount: invite.useCount,
      expiresAt: invite.expiresAt?.toISOString() ?? null,
      revokedAt: invite.revokedAt?.toISOString() ?? null,
      state: this.state(invite),
    };
  }

  async issue(
    ctx: RequestContext,
    input: { label?: string; maxUses?: number; expiresInDays?: number },
    baseUrl: string,
  ): Promise<IssuedInvite> {
    if (!ctx.kpmId || !ctx.membershipId) {
      throw new DomainException(
        ErrorCode.TENANT_NO_MEMBERSHIP,
        'You are not in an office.',
        HttpStatus.FORBIDDEN,
      );
    }

    // Retry on collision rather than trusting 32^6: the unique index is the real
    // guarantee, and an office with a lot of invites will eventually collide.
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const code = this.generateCode();
      const clash = await this.invites.findOne({ kpmId: ctx.kpmId, code }).exec();
      if (clash) continue;

      const invite = await this.invites.create({
        kpmId: ctx.kpmId,
        code,
        issuedByMembershipId: ctx.membershipId,
        autoApprove: true,
        maxUses: input.maxUses ?? null,
        expiresAt: input.expiresInDays
          ? new Date(this.clock.now().getTime() + input.expiresInDays * 86_400_000)
          : null,
        label: input.label?.trim() || null,
        createdBy: ctx.membershipId,
      });

      await this.audit.record(ctx, {
        action: 'invite.issued',
        targetCollection: 'inviteCodes',
        targetId: String(invite._id),
        after: { maxUses: invite.maxUses, expiresAt: invite.expiresAt },
      });

      return this.present(invite, baseUrl);
    }

    throw new DomainException(
      ErrorCode.INTERNAL_ERROR,
      'Could not allocate an invite code. Try again.',
      HttpStatus.INTERNAL_SERVER_ERROR,
    );
  }

  /** A leader's own invites. Revoked and spent ones stay, so the history is readable. */
  async mine(ctx: RequestContext, baseUrl: string): Promise<IssuedInvite[]> {
    if (!ctx.kpmId || !ctx.membershipId) return [];
    const rows = await this.invites
      .find({ kpmId: ctx.kpmId, issuedByMembershipId: ctx.membershipId, deletedAt: null })
      .sort({ createdAt: -1 })
      .exec();
    return rows.map((r) => this.present(r, baseUrl));
  }

  async revoke(ctx: RequestContext, inviteId: string): Promise<IssuedInvite> {
    if (!ctx.kpmId || !ctx.membershipId) throw new NotFoundException('Invite');

    const invite = await this.invites
      .findOne({ _id: inviteId, kpmId: ctx.kpmId, deletedAt: null })
      .exec();
    // Someone else's invite reads the same as one that does not exist.
    if (!invite || invite.issuedByMembershipId !== ctx.membershipId) {
      throw new NotFoundException('Invite');
    }

    if (!invite.revokedAt) {
      invite.revokedAt = this.clock.now();
      invite.revokedByMembershipId = ctx.membershipId;
      await invite.save();
      await this.audit.record(ctx, {
        action: 'invite.revoked',
        targetCollection: 'inviteCodes',
        targetId: inviteId,
      });
    }
    return this.present(invite, '');
  }

  /**
   * Resolve a code, or refuse it the same way whatever the reason.
   *
   * Unknown, revoked, expired and exhausted all answer alike. Codes are six characters
   * and the reward for guessing one is joining somebody's unit uninvited, so telling a
   * prober *which* of the four they hit hands them a working oracle. The message covers
   * all of them honestly rather than naming one.
   */
  private async resolve(code: string): Promise<InviteCodeDocument> {
    const invite = await this.invites
      .findOne({ code: code.trim().toUpperCase(), deletedAt: null })
      .exec();

    const refuse = () =>
      new DomainException(
        ErrorCode.ORG_INVITE_EXPIRED,
        'That invite is not valid. It may be mistyped, withdrawn, or no longer in use — ask whoever sent it for a new one.',
        HttpStatus.GONE,
      );

    if (!invite) throw refuse();
    const state = this.state(invite);
    if (state === 'exhausted') {
      throw new DomainException(
        ErrorCode.ORG_INVITE_EXHAUSTED,
        'That invite has been used as many times as it was meant for.',
        HttpStatus.CONFLICT,
      );
    }
    if (state !== 'active') throw refuse();

    const kpm = await this.kpms.findOne({ _id: invite.kpmId, deletedAt: null }).exec();
    // A suspended office refuses its own members; it must not admit new ones either.
    if (!kpm || kpm.status !== 'active') throw refuse();

    return invite;
  }

  /** What the joiner sees before committing: whose unit, and which office. */
  async preview(code: string): Promise<InvitePreview> {
    const invite = await this.resolve(code);
    const kpm = await this.kpms.findOne({ _id: invite.kpmId }).exec();
    const company = kpm ? await this.companies.findOne({ _id: kpm.companyId }).exec() : null;

    const scoped = RequestContext.superAdminInTenant('invite-preview', invite.kpmId);
    const leader = await this.members.findById(scoped, invite.issuedByMembershipId);
    const leaderUser = leader ? await this.users.findOne({ _id: leader.userId }).exec() : null;

    return {
      code: invite.code,
      kpmLabel: kpm ? `${company?.name ?? 'Unknown'} — KPM ${kpm.code} · ${kpm.branchName}` : 'Unknown',
      leaderName: leaderUser?.fullName ?? 'a leader',
    };
  }

  /**
   * Redeem: register and get tagged in one step, with no approval.
   *
   * This is the whole difference from Flow A. The joiner ends `active` under the issuing
   * leader, and **no join request is created** — a request would sit in that leader's
   * inbox asking them to approve something that already happened.
   */
  async redeem(ctx: RequestContext, code: string): Promise<{ kpmId: string; leaderName: string }> {
    if (ctx.membership) {
      throw new DomainException(
        ErrorCode.ORG_AGENT_ALREADY_TAGGED,
        'You are already registered to an office.',
        HttpStatus.CONFLICT,
        { kpmId: ctx.kpmId },
      );
    }

    const invite = await this.resolve(code);
    const scoped = RequestContext.superAdminInTenant(ctx.userId, invite.kpmId);

    const leader = await this.members.findById(scoped, invite.issuedByMembershipId);
    if (!leader || leader.status !== 'active') {
      // The invite outlived the person who issued it. Refused as invalid rather than
      // dropping the joiner into the office with no leader.
      throw new DomainException(
        ErrorCode.ORG_INVITE_EXPIRED,
        'The person who sent this invite is no longer in that office. Ask them for a new one.',
        HttpStatus.GONE,
      );
    }

    const membership = await this.hierarchy.create(scoped, {
      userId: ctx.userId,
      // Flow C forces AGENT: an invite is a way into somebody's unit, not a way to
      // choose your own rank on the way in.
      role: 'agent',
      leaderId: String(leader._id),
      status: 'active',
      recruitedByMembershipId: String(leader._id),
    });

    // Count the use only once the membership exists, so a failed join does not spend it.
    await this.invites.updateOne({ _id: invite._id }, { $inc: { useCount: 1 } }).exec();

    // Any request they had open is moot — they are in, and by another door.
    await this.requests
      .updateMany(
        { membershipId: String(membership._id), status: 'pending' },
        { $set: { status: 'cancelled', decidedAt: this.clock.now() } },
      )
      .exec();

    const joiner = await this.users.findOne({ _id: ctx.userId }).exec();
    await this.notifications.send({
      userId: leader.userId,
      kpmId: invite.kpmId,
      templateId: NotificationTemplate.MEMBER_TAGGED_BY_LEADER,
      payload: {
        joinerName: joiner?.fullName ?? 'Somebody',
        via: 'invite',
        code: invite.code,
      },
    });

    await this.audit.record(scoped, {
      action: 'invite.redeemed',
      targetCollection: 'memberships',
      targetId: String(membership._id),
      after: { inviteId: String(invite._id), code: invite.code, leaderMembershipId: String(leader._id) },
    });

    const leaderUser = await this.users.findOne({ _id: leader.userId }).exec();
    return { kpmId: invite.kpmId, leaderName: leaderUser?.fullName ?? 'your leader' };
  }
}
