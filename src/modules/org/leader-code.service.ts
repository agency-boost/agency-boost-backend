import { HttpStatus, Injectable, Optional, Inject } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { Clock } from '@/common/clock/clock.port';
import { RequestContext } from '@/common/context/request-context';
import { DomainException, NotFoundException } from '@/common/errors/domain.exception';
import { ErrorCode } from '@/common/errors/error-codes';
import { readerOf, type Reader } from '@/common/i18n/reader';
import { render } from '@/common/i18n/sentence';
import { AuditService } from '@/modules/audit/audit.service';
import { NotificationService } from '@/modules/notifications/notification.service';
import { NotificationTemplate } from '@/modules/notifications/notification.types';
import { Company, CompanyDocument } from '@/modules/tenants/company.schema';
import { Kpm, KpmDocument } from '@/modules/tenants/kpm.schema';
import { isEnded } from '@/modules/tenants/subscription';
import { User, UserDocument } from '@/modules/users/user.schema';
import { ActivationStarter, startActivation } from './activation-starter.port';
import { HierarchyService } from './hierarchy.service';
import { JoinRequestRepository } from './org.repositories';
import { leaderCodeUrl } from './leader-code';
import { MembershipRepository } from './membership.repository';
import { MembershipDocument } from './membership.schema';
import { ONBOARDING_MESSAGES, ONBOARDING_REFUSALS } from './onboarding.messages';
import { ORG_MESSAGES } from './org.messages';

/** A leader's own code, in the three forms the prototype shows it. */
export interface MyLeaderCode {
  code: string;
  /** The shareable form. The QR encodes exactly this string. */
  url: string;
}

export interface InvitePreview {
  code: string;
  kpmLabel: string;
  leaderName: string;
}

/**
 * The leader code: read it, show it, redeem it.
 *
 * **This was `InviteService`, and it could issue, list and revoke.** None of that had a
 * counterpart in any prototype — the only `Revoke` in `prototype/` is for KPM Admin
 * access, and the invite card is three *copyable* artefacts over a code that already
 * exists (`Overall.html:3578-3596`, `User_Management_Section.html:446-454`). We had built
 * a lifecycle nobody asked for, and it was in no row of the parity register.
 *
 * So there is one code per membership, generated with it by `HierarchyService` and never
 * reissued. A code that cannot be reissued must not be revocable either: withdrawing one
 * would leave that leader permanently unable to invite anybody.
 *
 * What that removes, and what it does not: `maxUses`, `useCount`, `expiresAt`, `revokedAt`
 * and `label` are gone, because each existed only to bound a credential somebody could
 * mint again. The lookup and the refusals stay, and so does the reason they are shaped the
 * way they are — presenting a code puts a stranger into somebody's unit with nobody
 * approving it.
 */
@Injectable()
export class LeaderCodeService {
  constructor(
    private readonly members: MembershipRepository,
    private readonly hierarchy: HierarchyService,
    private readonly requests: JoinRequestRepository,
    @InjectModel(Kpm.name) private readonly kpms: Model<KpmDocument>,
    @InjectModel(Company.name) private readonly companies: Model<CompanyDocument>,
    @InjectModel(User.name) private readonly users: Model<UserDocument>,
    private readonly audit: AuditService,
    private readonly notifications: NotificationService,
    private readonly clock: Clock,
    /** OD-119, P13-T1 AC-1: a code places its joiner under a leader, at the Agent rung — a hire. */
    @Optional() @Inject(ActivationStarter) private readonly activations: ActivationStarter | null = null,
  ) {}

  /**
   * The caller's own code, for the panel that shares it.
   *
   * `appOrigin` arrives from the controller rather than being injected here: the link
   * points at the **app**, not the API, and the controller is the layer that knows which
   * deployment it is answering for.
   */
  async mine(ctx: RequestContext, appOrigin: string): Promise<MyLeaderCode> {
    if (!ctx.kpmId || !ctx.membershipId) throw new NotFoundException('Membership');
    const me = await this.members.findById(ctx, ctx.membershipId);
    if (!me) throw new NotFoundException('Membership');
    return { code: me.leaderCode, url: leaderCodeUrl(appOrigin, me.leaderCode) };
  }

  /**
   * The membership a code names, or a refusal that says nothing useful to a prober.
   *
   * Unknown and belonging-to-somebody-who-has-left answer alike. Codes are six characters
   * and the reward for guessing one is joining somebody's unit uninvited, so telling a
   * prober *which* of the two they hit hands them an oracle. There is no longer a third
   * or fourth case — nothing expires and nothing is withdrawn.
   */
  private async resolve(code: string): Promise<{ leader: MembershipDocument; kpm: KpmDocument }> {
    const refuse = () =>
      new DomainException(
        ErrorCode.ORG_INVITE_EXPIRED,
        ONBOARDING_REFUSALS.ORG_INVITE_EXPIRED.codeNotValid,
        HttpStatus.GONE,
      );

    const leader = await this.members.findByLeaderCode(code.trim().toUpperCase());
    // Refused rather than dropping the joiner into an office with a leader who has gone.
    if (!leader || leader.status !== 'active') throw refuse();

    const kpm = await this.kpms.findOne({ _id: leader.kpmId, deletedAt: null }).exec();
    // A suspended office refuses its own members; it must not admit new ones either. Nor
    // does an office whose subscription has ended (ADR-0112 §3): to an outsider it reads as
    // a suspended one, the same refusal and nothing that says why.
    if (!kpm || kpm.status !== 'active' || isEnded(kpm, this.clock)) throw refuse();

    return { leader, kpm };
  }

  /**
   * What the joiner sees before committing: whose unit, and which office.
   *
   * **Authenticated**, deliberately. A code space of 32⁶ and a preview that names an
   * office and a real person is a directory anybody could walk; requiring a session means
   * a prober needs an account first, and an account is auditable. Settled 2026-09-09.
   *
   * `reader`: the request's, for the words written where a name is missing (P18.98-T5 AC-4).
   */
  async preview(code: string, reader: Reader = readerOf()): Promise<InvitePreview> {
    const { leader, kpm } = await this.resolve(code);
    const company = await this.companies.findOne({ _id: kpm.companyId }).exec();
    const leaderUser = await this.users.findOne({ _id: leader.userId }).exec();

    return {
      code: leader.leaderCode,
      kpmLabel: `${company?.name ?? render(ORG_MESSAGES.unknownName, reader)} — KPM ${kpm.code} · ${kpm.branchName}`,
      leaderName: leaderUser?.fullName ?? render(ONBOARDING_MESSAGES.aLeader, reader),
    };
  }

  /**
   * Redeem: register and get tagged in one step, with no approval.
   *
   * This is the whole difference from Flow A. The joiner ends `active` under the leader
   * whose code they used, and **no join request is created** — a request would sit in that
   * leader's inbox asking them to approve something that already happened.
   */
  async redeem(ctx: RequestContext, code: string): Promise<{ kpmId: string; leaderName: string }> {
    if (ctx.membership) {
      throw new DomainException(
        ErrorCode.ORG_AGENT_ALREADY_TAGGED,
        ONBOARDING_REFUSALS.ORG_AGENT_ALREADY_TAGGED.alreadyRegistered,
        HttpStatus.CONFLICT,
        { kpmId: ctx.kpmId },
      );
    }

    const { leader, kpm } = await this.resolve(code);
    const scoped = RequestContext.joiningTenant(ctx, String(kpm._id));

    const membership = await this.hierarchy.create(scoped, {
      userId: ctx.userId,
      // Flow C forces the ladder's lowest rung that leads nobody (`AGENT` on the default ladder, ADR-0156): a
      // code is a way into somebody's unit, not a way to choose your own rank on the way in.
      role: await this.hierarchy.entryRungCode(String(kpm._id), 'joiner'),
      leaderId: String(leader._id),
      status: 'active',
      recruitedByMembershipId: String(leader._id),
    });

    // Any request they had open is moot — they are in, and by another door.
    await this.requests.updateMany(
      scoped,
      { membershipId: String(membership._id), status: 'pending' },
      { $set: { status: 'cancelled', decidedAt: this.clock.now() } },
    );

    const joiner = await this.users.findOne({ _id: ctx.userId }).exec();
    await this.notifications.send({
      userId: leader.userId,
      kpmId: String(kpm._id),
      templateId: NotificationTemplate.MEMBER_TAGGED_BY_LEADER,
      payload: {
        // No name, no word: the inbox writes its own for a notice with none, in its reader's language (P18.98-T5 AC-4).
        joinerName: joiner?.fullName ?? null,
        via: 'leader-code',
        code: leader.leaderCode,
      },
    });

    await this.audit.record(scoped, {
      action: 'leader_code.redeemed',
      targetCollection: 'memberships',
      targetId: String(membership._id),
      after: { code: leader.leaderCode, leaderMembershipId: String(leader._id) },
    });

    // Their activation starts in the same call that placed them (OD-119), failing open.
    await startActivation(this.activations, scoped, String(membership._id));

    const leaderUser = await this.users.findOne({ _id: leader.userId }).exec();
    return {
      kpmId: String(kpm._id),
      leaderName: leaderUser?.fullName ?? render(ONBOARDING_MESSAGES.yourLeader, ctx.reader),
    };
  }
}
