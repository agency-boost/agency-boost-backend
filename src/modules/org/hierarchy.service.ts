import { HttpStatus, Inject, Injectable, Optional } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { Clock } from '@/common/clock/clock.port';
import { RequestContext } from '@/common/context/request-context';
import { DomainException, NotFoundException } from '@/common/errors/domain.exception';
import { ErrorCode } from '@/common/errors/error-codes';
import { refuseWith } from '@/common/validation/fields';
import type { LocalDate } from '@/common/time/local-day';
import {
  DEFAULT_TENANT_TIMEZONE, isLeaderClass, joinDateViolation, joinedAsFor, roleClassOf, tierOfRung, type JoinedAs, type LeaderTier,
} from '@/domain/constants';
import { Kpm, KpmDocument } from '@/modules/tenants/kpm.schema';
import { User, UserDocument } from '@/modules/users/user.schema';
import { EdgeEvent, MembershipHistory } from './membership-history.schema';
import { MembershipHistoryRepository } from './org.repositories';
import { MembershipRepository } from './membership.repository';
import { OrgLevelService } from '@/modules/tenants/org-level.service';
import { generateLeaderCode } from './leader-code';
import { withLeaderSeat, type ApprovedPastLimit, type LeaderSeatOptions } from './leader-limit';
import { DirectCounts, HierarchyRole, MembershipDocument } from './membership.schema';
import { ORG_REFUSALS } from './org.messages';
import { HeldRowsPort, signalCodeRegistered } from './held-rows.port';
import type { WorkStatus } from '@/domain/constants';

export interface CreateMembershipInput {
  userId: string;
  /**
   * The rung's code, any case — a lookup key on the company's ladder, never the class stored (ADR-0156): the
   * default ladder's `ab`, `aab` or `agent`, or a rung the company added, which a roster row may name.
   */
  role: string;
  leaderId?: string | null;
  status?: 'active' | 'pending';
  recruitedByMembershipId?: string | null;
  sourceLeadId?: string | null;
  /**
   * Full-time or part-time in this office (ADR-0158 §1). The roster import names it; every other
   * join leaves it out, and the person's answer at registration is copied instead (`insert`).
   */
  workStatus?: WorkStatus | null;
  /**
   * **The join date and who it makes them** (ADR-0169), for a membership made active here. Omitted, the office's
   * today and the classification it gives — a leader's code. A roster import and an Owner name `existing_agent`.
   * Ignored for a pending membership: nobody has let them in yet.
   */
  joining?: JoiningInput;
}

/**
 * What a placement says about a person's join (ADR-0169, P18.8-T2): the date a leader gave, and — for a path that
 * is never a new hire's — the classification it forces.
 */
export interface JoiningInput {
  /** An office date `YYYY-MM-DD`, checked: a real day, not after the office's today, not before 1980. Omitted: today. */
  joinDate?: string;
  /** Forced, for a roster import and an Owner (ADR-0169 §6, ADR-0103). Omitted: from the date, once. */
  joinedAs?: JoinedAs;
}

/** The two fields a membership made active is written with (ADR-0169 §1, §3). */
export interface JoiningFields {
  joinDate: LocalDate;
  joinedAs: JoinedAs;
}

/**
 * The hierarchy: who reports to whom, and everything derived from it.
 *
 * The parent reference keeps writes cheap; the materialised `ancestorIds` makes the
 * descendant query — the most common in the product, behind every rollup, every
 * coaching permission and every compliance tree — a single indexed lookup.
 *
 * Both are maintained here and nowhere else. A caller that sets `leaderId` directly
 * would leave the materialisation stale, so nothing outside this service writes it.
 */
@Injectable()
export class HierarchyService {
  constructor(
    private readonly members: MembershipRepository,
    @InjectModel(Kpm.name) private readonly kpms: Model<KpmDocument>,
    @InjectModel(User.name) private readonly users: Model<UserDocument>,
    private readonly history: MembershipHistoryRepository,
    private readonly clock: Clock,
    // No cycle: OrgLevelService knows nothing about the hierarchy.
    private readonly orgLevels: OrgLevelService,
    /**
     * P19.5-T2 (ADR-0214 §8): a code made active in the KPM takes the Data upload's *Belum terdaftar* months held for it.
     * A port the production module answers; optional, so the specs built before it keep their constructor.
     */
    @Optional() @Inject(HeldRowsPort) private readonly heldRows: HeldRowsPort | null = null,
  ) {}

  /**
   * Take the next join-order number for an office.
   *
   * **This used to mint the agent code too.** It does not any more (ADR-0017): the code
   * belongs to the person, issued by their insurer and entered when they registered. What
   * survives is the sequence, because the directory cursor is a `$gt` on it and seven
   * services sort by it — none of which has anything to do with who issues a code.
   *
   * `findOneAndUpdate` with `$inc` so the read and the increment are one atomic
   * operation. A read-then-write would hand two concurrent joins the same number, and the
   * sort index would then hold two rows the cursor cannot separate — one of which the
   * roster would skip.
   */
  private async nextMemberSeq(kpmId: string): Promise<{ agentSeq: number }> {
    const kpm = await this.kpms
      .findOneAndUpdate(
        { _id: kpmId, deletedAt: null },
        { $inc: { 'counters.nextMemberSeq': 1 } },
        { new: false },
      )
      .exec();
    if (!kpm) throw new NotFoundException('KPM');
    return { agentSeq: kpm.counters?.nextMemberSeq ?? 1 };
  }

  /**
   * A leader code nobody else holds.
   *
   * Unique across every office and generated rather than derived, so a collision is
   * possible and has to be handled: probe, and try again. Five attempts against a space
   * of 32⁶ is not a real limit — it is a way of failing loudly if the generator ever
   * stops being random, rather than looping until the request times out.
   *
   * The probe is deliberately **unscoped**. The uniqueness is global, and asking within
   * one office would hand two offices the same code.
   */
  private async freshLeaderCode(): Promise<string> {
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const code = generateLeaderCode();
      const taken = await this.members.existsWithLeaderCode(code);
      if (!taken) return code;
    }
    throw new DomainException(
      ErrorCode.INTERNAL_ERROR,
      ORG_REFUSALS.INTERNAL_ERROR.leaderCode,
      HttpStatus.INTERNAL_SERVER_ERROR,
    );
  }

  /**
   * The rung code an office's Owner, or somebody joining it, is placed on (ADR-0156): the ladder's own, so a company
   * whose rungs are not called `AB` and `AGENT` can still be given an Owner and be joined.
   */
  async entryRungCode(kpmId: string, purpose: 'owner' | 'joiner'): Promise<string> {
    return this.orgLevels.entryRungCode(await this.companyOf(kpmId), purpose);
  }

  /** The insurer an office belongs to. The ladder and the agent code both hang off it. */
  private async companyOf(kpmId: string): Promise<string> {
    const kpm = await this.kpms.findOne({ _id: kpmId, deletedAt: null }).exec();
    if (!kpm) throw new NotFoundException('KPM');
    return kpm.companyId;
  }

  /**
   * The agent code this person carries, checked against the office they are joining.
   *
   * The code is the insurer's, so an office may only admit somebody the insurer issued a
   * code for — and only its own insurer's. A user whose company differs from the office's
   * reads as **not found**, the same answer as an office that does not exist, because
   * confirming otherwise would let anybody map which insurer runs which office.
   */
  private async agentCodeOf(userId: string, companyId: string): Promise<string> {
    const user = await this.users.findOne({ _id: userId, deletedAt: null }).exec();
    if (!user) throw new NotFoundException('User');
    if (!user.agentCode || user.companyId !== companyId) {
      throw new NotFoundException('KPM');
    }
    return user.agentCode;
  }

  /**
   * **Full-time or part-time, as the person said when they registered** (ADR-0158 §1, P18.5-T4).
   *
   * Work status is the membership's, but a person registers before any office has them, so their
   * answer waits on the account (`users.registeredWorkStatus`) and is carried onto the membership they
   * are given here — through a leader's code, an office's approval, or being made its Owner alike.
   * `null` for anybody who registered before it was asked.
   */
  private async registeredWorkStatusOf(userId: string): Promise<WorkStatus | null> {
    const user = await this.users.findOne({ _id: userId }).select('registeredWorkStatus').exec();
    return user?.registeredWorkStatus ?? null;
  }

  /**
   * The first edge. A membership that did not exist a moment ago has nothing open to close, so
   * this is the one edge written without `MembershipHistoryRepository.openEdge`; every later one
   * goes through it, and it closes whatever is open first (P11-T3).
   */
  private async recordJoined(
    ctx: RequestContext,
    membershipId: string,
    fields: Partial<MembershipHistory>,
  ): Promise<void> {
    await this.history.create(ctx, {
      membershipId,
      eventType: 'joined',
      validFrom: this.clock.now(),
      validTo: null,
      actorMembershipId: ctx.membershipId,
      actorUserId: ctx.auditActors.actorUserId,
      ...fields,
    });
  }

  /**
   * Move somebody to a different rung.
   *
   * Here rather than in `RoleChangeService` for the same reason `leaderId` is: **both
   * fields are written in one place or they drift.** A caller doing
   * `$set: { role: toRole }` on its own would leave `orgLevelId` pointing at the rung
   * they left, and nothing would notice — the enum would answer every question correctly
   * while the reference, which is the stored truth, said something else.
   *
   * Returns the rung, so the caller can record it in history.
   */
  /**
   * Is this membership the one that owns the office?
   *
   * Ownership lives on `kpms.ownerUserId`, not on the membership — `ContextResolver`
   * derives `isKpmOwner` by comparing the two — so anything that needs the answer has to
   * make the same join. Here because this service already holds the Kpm model, and
   * because both callers that need it already depend on it.
   */
  async ownsTheOffice(ctx: RequestContext, membership: { userId: string }): Promise<boolean> {
    if (!ctx.kpmId) return false;
    const kpm = await this.kpms.findOne({ _id: ctx.kpmId, deletedAt: null }).exec();
    return Boolean(kpm?.ownerUserId) && kpm!.ownerUserId === membership.userId;
  }

  /**
   * **The rung a code names on the caller's office's ladder, and the class it gives** (ADR-0156 §2): `senior` →
   * `ab`, `associate` → `aab`, none → `agent`. Every placement takes its `role` from here — never from the code
   * it was asked for — so the class always follows the rung, whatever the company called it.
   */
  async rungFor(
    ctx: RequestContext,
    code: string,
  ): Promise<{ level: Awaited<ReturnType<OrgLevelService['resolveByCode']>>; role: HierarchyRole }> {
    const kpmId = ctx.kpmId;
    if (!kpmId) {
      throw new DomainException(
        ErrorCode.TENANT_NO_MEMBERSHIP,
        ORG_REFUSALS.TENANT_NO_MEMBERSHIP.notInOffice,
        HttpStatus.FORBIDDEN,
      );
    }
    const kpm = await this.kpms.findOne({ _id: kpmId, deletedAt: null }).exec();
    if (!kpm) throw new NotFoundException('KPM');
    const level = await this.orgLevels.resolveByCode(kpm.companyId, code);
    return { level, role: classOfRung(level) };
  }

  /**
   * The class each active rung of an office's company gives, by code — for a caller that must count the leaders
   * a batch would add before it places anybody (the roster import, ADR-0113 §2).
   */
  async rungClassesOf(kpmId: string): Promise<Map<string, HierarchyRole>> {
    return this.orgLevels.classesByCode(await this.companyOf(kpmId));
  }

  async setLevel(
    ctx: RequestContext,
    membershipId: string,
    // A rung's code, any case: the default ladder's `ab`, `aab`, `agent`, or a rung the company added (`SM`).
    toRole: string,
    pastLimit?: ApprovedPastLimit,
  ): Promise<{ orgLevelId: string; role: HierarchyRole }> {
    // `toRole` is the rung's code, lower-cased — a lookup key. The class written is the rung's tier's (ADR-0156).
    const { level, role } = await this.rungFor(ctx, toRole);
    const write = async () => {
      await this.members.updateById(ctx, membershipId, {
        // All three together, always. `role` — the class, from the rung's tier — is what a
        // permission grant reads since ADR-0156, and `orgLevelCode` what the badge and the
        // ladder-bound config read; writing one without the others is how somebody comes to
        // hold rights their badge does not show (P4-T9).
        $set: { orgLevelId: String(level._id), orgLevelCode: level.code, role },
      });
      return { orgLevelId: String(level._id), role };
    };

    /*
     * **The leader limit** (ADR-0113 §2, P13.2-T4): a move from a rung the limit does not count to
     * one it does — an Agent to AAB or AB — adds a leader, and is refused when the office has none
     * to add. AB to AAB, and anything downward, changes nothing and is never refused.
     *
     * A pending member is held to it here too, although a pending member is not counted: it costs
     * nothing, and it refuses a promotion that could never be approved. The approval itself is what
     * holds them to it ({@link activate}) — promoting two pending members at one below the limit
     * passes both here, and only the first approval takes the seat (P13.2 exit review).
     *
     * **The member is read with the lease held** (exit review): two promotions of one Agent at once
     * both read *Agent* before it, and the second was counted as a second leader. A move to Agent never
     * adds one, so it takes no lease at all.
     *
     * **By class, since ADR-0156**: a move onto any rung of a leader tier, whatever its code, from a rung of
     * none, adds a leader; a move between two leader tiers adds nobody.
     */
    if (!isLeaderClass(role)) return write();
    /*
     * A role change refused here may be asked about instead (ADR-0157 §1, `canRequest`), and an approved ask
     * comes back through `pastLimit`, carried out with the lease held and never counted (§3).
     */
    return withLeaderSeat(this.leaderLimit(), ctx, write, async () => {
      const member = await this.members.findById(ctx, membershipId);
      return member !== null && member.status !== 'removed' && !isLeaderClass(member.role);
    }, { requestable: true, pastLimit });
  }

  /**
   * **The join date and the classification a membership made active now is written with** (ADR-0169, P18.8-T2).
   *
   * The date is the one given — a leader's, on an approval or a tag — or the **office's today** in `kpms.timezone`,
   * read through the injected clock (invariant §9). A given date is refused `400 VALIDATION_FAILED` naming
   * `joinDate` when it is not a real day, is after the office's today, or is before 1980; an existing agent may have
   * joined decades ago, so there is no other lower bound. `joinedAs` is the forced one where a path names it, else
   * `new_hire` when the date is no more than 90 days before today and `existing_agent` otherwise — computed here,
   * once, and written beside the date; nothing recomputes it.
   *
   * Asked **before anything is written**, so a refused date leaves the membership, the request and the counter as
   * they were.
   */
  async joining(ctx: RequestContext, given: JoiningInput = {}): Promise<JoiningFields> {
    const today = await this.officeToday(ctx);
    if (given.joinDate !== undefined) {
      // A sentence in both languages (`joining.messages.ts`), refused in the shared envelope (P18.10-T5 AC-3).
      const violation = joinDateViolation(given.joinDate, today);
      if (violation) refuseWith([violation]);
    }
    const joinDate = given.joinDate ?? today;
    return { joinDate, joinedAs: given.joinedAs ?? joinedAsFor(joinDate, today) };
  }

  /** The office's today, in its own zone. A row that names none reads the platform's (ADR-0016). */
  private async officeToday(ctx: RequestContext): Promise<LocalDate> {
    const kpm = ctx.kpmId ? await this.kpms.findOne({ _id: ctx.kpmId, deletedAt: null }).exec() : null;
    return this.clock.localDateFor(kpm?.timezone ?? DEFAULT_TENANT_TIMEZONE);
  }

  /**
   * **Make a member who is not active, active** — an approval, a tag, an Owner assigned who had
   * registered — under the leader limit (ADR-0113 §2, P13.2 exit review).
   *
   * *Leaders used* counts active members only, so a pending member promoted to AB or AAB was not
   * counted, and the activation that made them count asked nobody: two pending members promoted at
   * one below the limit, then approved, made it one over. The activation is the write that adds the
   * leader, so it is the one that takes the seat — refused `409 LEADER_LIMIT_REACHED` with nothing
   * written, and served as it always was for an Agent, whom the limit never counts.
   *
   * Whether it adds one is read with the lease held: the row as it stands at the write, not as the
   * caller read it.
   */
  async activate(
    ctx: RequestContext,
    membershipId: string,
    fields: Record<string, unknown>,
    options: LeaderSeatOptions = {},
  ): Promise<void> {
    const write = () => this.members.updateById(ctx, membershipId, { $set: { ...fields, status: 'active' } });
    // `options`: an approval refused here may be asked about, and comes back approved (ADR-0157 §1, §3).
    // Assigning an Owner passes none: it cannot wait.
    const written = await withLeaderSeat(this.leaderLimit(), ctx, write, async () => {
      const member = await this.members.findById(ctx, membershipId);
      return member !== null && member.status !== 'active' && isLeaderClass(member.role);
    }, options);
    // P19.5-T2 (ADR-0214 §8): their code is registered in the KPM now; its held months move onto them.
    const code = (written as { agentCode?: string } | null)?.agentCode
      ?? ((await this.members.findById(ctx, membershipId)) as { agentCode?: string } | null)?.agentCode;
    await signalCodeRegistered(this.heldRows, ctx, membershipId, code);
  }

  /** What the leader limit's check reads and holds (`leader-limit.ts`). */
  private leaderLimit() {
    return { kpms: this.kpms, members: this.members, clock: this.clock };
  }

  async create(ctx: RequestContext, input: CreateMembershipInput): Promise<MembershipDocument> {
    const { leader, agentCode, level, status, joining } = await this.admission(ctx, input, input.userId);

    /*
     * **The leader limit** (ADR-0113 §2, P13.2-T4): an **active** member made at AB or AAB adds a
     * leader — a roster row's role column, or an Owner assigned who was not yet a member — and is
     * refused when the office has none to add, before a number or a code is spent on them. Every
     * join path makes a pending or active Agent, so none of them is ever refused here.
     */
    // `admission` read the agent code, since the account exists: it is never null here.
    const write = () => this.insert(ctx, input, { leader, agentCode: agentCode as string, level, status, joining });
    if (status !== 'active' || !isLeaderClass(classOfRung(level))) return write();
    return withLeaderSeat(this.leaderLimit(), ctx, write);
  }

  /**
   * `create`, for somebody whose **account is made in the same step** — a roster row (P13.2 exit
   * review).
   *
   * The roster import made the account and then the membership, and the leader limit refused the
   * membership: the account stayed, a person with no office, and its email refused the same row when
   * the file was imported again. Here the account is made by `makeAccount` only once the refusals that
   * do not need it have been met — the leader, the rung, and the limit, **with the lease held** — so a
   * row past the limit leaves nothing behind.
   */
  async createWithAccount(
    ctx: RequestContext,
    input: Omit<CreateMembershipInput, 'userId'>,
    makeAccount: () => Promise<string>,
  ): Promise<MembershipDocument> {
    const { leader, companyId, level, status, joining } = await this.admission(ctx, input, null);
    const write = async () => {
      const userId = await makeAccount();
      const agentCode = await this.agentCodeOf(userId, companyId);
      return this.insert(ctx, { ...input, userId }, { leader, agentCode, level, status, joining });
    };
    if (status !== 'active' || !isLeaderClass(classOfRung(level))) return write();
    return withLeaderSeat(this.leaderLimit(), ctx, write);
  }

  /**
   * What `create` and `createWithAccount` both settle before their write: the office, the leader, the
   * person's agent code when their account exists already (`userId`), and the rung.
   */
  private async admission(
    ctx: RequestContext,
    input: Omit<CreateMembershipInput, 'userId'>,
    userId: string | null,
  ): Promise<{
    leader: MembershipDocument | null;
    companyId: string;
    agentCode: string | null;
    level: Awaited<ReturnType<OrgLevelService['resolveByCode']>>;
    status: 'active' | 'pending';
    joining: JoiningFields | null;
  }> {
    const kpmId = ctx.kpmId;
    if (!kpmId) {
      throw new DomainException(
        ErrorCode.TENANT_NO_MEMBERSHIP,
        ORG_REFUSALS.TENANT_NO_MEMBERSHIP.notInOffice,
        HttpStatus.FORBIDDEN,
      );
    }

    const leader = input.leaderId ? await this.requireLeader(ctx, input.leaderId) : null;

    // **The refusal comes before the increment.** `nextMemberSeq` is a `$inc`, and a
    // rejected join that had already taken a number would leave a gap in the office's
    // ordering for somebody who never arrived.
    const companyId = await this.companyOf(kpmId);
    const agentCode = userId === null ? null : await this.agentCodeOf(userId, companyId);

    // **The level is resolved first, and `role` is taken from what came back.**
    //
    // `input.role` is a lookup key, not the value stored: writing the caller's role
    // beside a level resolved from it is how the two come to disagree. Taking the class
    // off the resolved rung's tier means they cannot — there is only one source, and it
    // is the ladder (ADR-0012, ADR-0156).
    //
    // Before the increment now, because the leader limit's refusal reads it (P13.2-T4).
    const level = await this.orgLevels.resolveByCode(companyId, input.role);
    const status = input.status ?? 'pending';
    // ADR-0169: an active membership is given its join date and classification here, before the increment, so a
    // refused date spends nothing. A pending one waits for whoever lets them in.
    const joining = status === 'active' ? await this.joining(ctx, input.joining) : null;
    return { leader, companyId, agentCode, level, status, joining };
  }

  /** `create`'s write, once every refusal it can meet has been met. */
  private async insert(
    ctx: RequestContext,
    input: CreateMembershipInput,
    resolved: {
      leader: MembershipDocument | null;
      agentCode: string;
      level: { _id: unknown; code: string; leaderTier?: LeaderTier | null };
      status: 'active' | 'pending';
      joining: JoiningFields | null;
    },
  ): Promise<MembershipDocument> {
    const { leader, agentCode, level, status, joining } = resolved;
    const { agentSeq } = await this.nextMemberSeq(ctx.kpmId as string);
    const leaderCode = await this.freshLeaderCode();
    const role = classOfRung(level);

    const membership = await this.members.create(ctx, {
      userId: input.userId,
      agentCode,
      agentSeq,
      leaderCode,
      orgLevelId: String(level._id),
      orgLevelCode: level.code,
      role,
      leaderId: leader ? String(leader._id) : null,
      ancestorIds: leader ? [...leader.ancestorIds, String(leader._id)] : [],
      depth: leader ? leader.depth + 1 : 0,
      status,
      joinedAt: status === 'active' ? this.clock.now() : null,
      joinDate: joining?.joinDate ?? null,
      joinedAs: joining?.joinedAs ?? null,
      recruitedByMembershipId: input.recruitedByMembershipId ?? null,
      sourceLeadId: input.sourceLeadId ?? null,
      // ADR-0158 §1: what the caller names (a roster row), else what they said when they registered.
      workStatus: input.workStatus ?? (await this.registeredWorkStatusOf(input.userId)),
    });

    await this.recordJoined(ctx, String(membership._id), {
      toRole: role,
      toOrgLevelId: String(level._id),
      toLeaderId: membership.leaderId,
    });

    if (membership.status === 'active') await this.refreshCounts(ctx, membership.leaderId);
    // P19.5-T2 (ADR-0214 §8): an active member's code registers in the KPM; its *Belum terdaftar* months move onto them.
    if (membership.status === 'active') await signalCodeRegistered(this.heldRows, ctx, String(membership._id), agentCode);
    return membership;
  }

  /** A leader must exist, be live, and be in this office. The repository enforces the last. */
  private async requireLeader(ctx: RequestContext, leaderId: string): Promise<MembershipDocument> {
    const leader = await this.members.findById(ctx, leaderId);
    if (!leader || leader.status === 'removed') {
      throw new DomainException(
        ErrorCode.ORG_LEADER_NOT_IN_KPM,
        ORG_REFUSALS.ORG_LEADER_NOT_IN_KPM.notAMember,
        HttpStatus.UNPROCESSABLE_ENTITY,
        { leaderId },
      );
    }
    return leader;
  }

  /**
   * Move someone, and their whole subtree, under a new leader.
   *
   * The subtree moves with them because `ancestorIds` is materialised: every descendant
   * carries the moved member's old ancestors and must carry the new ones instead. This
   * is the price of making the descendant query one lookup, and it is paid here.
   */
  /**
   * Move a member under a new leader, correctly: cycle check, subtree re-splice, and
   * `refreshCounts` on **both** the leader they left and the one they joined.
   *
   * Extracted because `ApprovalsService.attach` had its own copy of the move — a bare
   * `$set` of `leaderId`, `ancestorIds` and `depth` — and did none of those three. So
   * approving a request or tagging somebody who already led a unit left every descendant
   * carrying the old ancestry: the previous leader kept read reach over a unit that had
   * gone, the new leader could not see the unit they now owned, and the old leader's
   * counts were never refreshed. Two ways of doing one thing is how the wrong one gets
   * called.
   *
   * The history row is the caller's to write, because the *meaning* differs: joining an
   * office for the first time is not the same event as being moved between leaders.
   *
   * Returns the leader they had before, or `undefined` when nothing moved.
   */
  /**
   * Would this move be refused? Asked **before** anything is written.
   *
   * `moveUnder` checks the same thing, and keeps checking it — it is the one place the
   * graph changes and it does not get to assume its callers were careful. This exists so
   * a caller that must write something *else* first can find out beforehand.
   *
   * `ApprovalsService.attach` is that caller. It has to set `status: 'active'` before the
   * move, because `refreshCounts` counts active members — so a refusal inside `moveUnder`
   * used to leave the joiner active with no leader and a `recruitedByMembershipId` naming
   * a leader who never took them on, with their request still pending. There are no
   * transactions here (ADR-0002, and MongoDB sessions are not configured), so the only
   * way to avoid a half-write is not to start one.
   */
  async assertCanMoveUnder(
    ctx: RequestContext,
    membershipId: string,
    newLeaderId: string,
  ): Promise<void> {
    // No member read and no nullable leader: the only caller has both in hand already,
    // and `moveUnder` re-reads and re-checks regardless. Accepting shapes nobody passes
    // would be two branches no test could reach except by inventing a caller for them.
    this.refuseCycle(membershipId, newLeaderId, await this.requireLeader(ctx, newLeaderId));
  }

  /** A cycle would make the subtree query infinite and the member their own ancestor. */
  private refuseCycle(
    membershipId: string,
    newLeaderId: string,
    leader: MembershipDocument,
  ): void {
    const wouldCycle =
      String(leader._id) === membershipId || leader.ancestorIds.includes(membershipId);
    if (wouldCycle) {
      throw new DomainException(
        ErrorCode.ORG_CYCLE_DETECTED,
        ORG_REFUSALS.ORG_CYCLE_DETECTED.ownLeader,
        HttpStatus.CONFLICT,
        { membershipId, leaderId: newLeaderId },
      );
    }
  }

  async moveUnder(
    ctx: RequestContext,
    membershipId: string,
    newLeaderId: string | null,
  ): Promise<{ previousLeaderId: string | null; moved: boolean }> {
    const member = await this.members.findById(ctx, membershipId);
    if (!member) throw new NotFoundException('Membership');

    const leader = newLeaderId ? await this.requireLeader(ctx, newLeaderId) : null;

    if (leader) this.refuseCycle(membershipId, newLeaderId as string, leader);

    const previousLeaderId = member.leaderId;
    const target = leader ? String(leader._id) : null;
    if (previousLeaderId === target) return { previousLeaderId, moved: false };

    const oldPath = [...member.ancestorIds, membershipId];
    const newAncestors = leader ? [...leader.ancestorIds, String(leader._id)] : [];
    const newDepth = newAncestors.length;

    await this.members.updateById(ctx, membershipId, {
      $set: { leaderId: target, ancestorIds: newAncestors, depth: newDepth },
    });

    // Every descendant carries the old path as a prefix, so the whole subtree is one
    // splice rather than a walk — and one round trip rather than one per member.
    await this.members.respliceSubtree(
      ctx, membershipId, newAncestors, oldPath.length, newDepth - member.depth,
    );

    await this.refreshCounts(ctx, previousLeaderId);
    await this.refreshCounts(ctx, target);
    return { previousLeaderId, moved: true };
  }

  async reparent(
    ctx: RequestContext,
    membershipId: string,
    newLeaderId: string | null,
    reason?: string,
  ): Promise<MembershipDocument> {
    const { previousLeaderId, moved } = await this.moveUnder(ctx, membershipId, newLeaderId);
    const member = await this.members.findById(ctx, membershipId);
    if (!member) throw new NotFoundException('Membership');
    if (!moved) return member;

    // Every open edge closes, not only an earlier re-parent: this closed `re_parented` rows
    // alone, so a member's first move left the edge they joined on open beside the new one
    // (P11-T3). The row carries the rung they keep, so the open edge says all of where they
    // stand.
    await this.history.openEdge(ctx, this.clock.now(), {
      membershipId,
      eventType: 're_parented',
      fromLeaderId: previousLeaderId,
      toLeaderId: member.leaderId,
      toRole: member.role,
      toOrgLevelId: member.orgLevelId,
      reason: reason ?? null,
    });
    return member;
  }

  /**
   * Recompute one leader's caches.
   *
   * `directCounts.total` is what makes someone a leader (OD-23), so it is derived from
   * live rows rather than incremented — an increment that drifts would silently grant or
   * remove access to the unit dashboard and the coaching roster.
   */
  async refreshCounts(ctx: RequestContext, leaderId: string | null): Promise<void> {
    if (!leaderId) return;
    const directs = await this.members.find(ctx, { leaderId, status: 'active' });
    /*
     * Counted by **ladder code**, and built from what is actually there (P4-T9).
     *
     * It was three fixed keys seeded to zero, which counts nothing for a rung a second
     * insurer publishes — a leader with four reports on a new rung would have read as
     * leading nobody on every screen that groups by role, while `total` said four.
     */
    /*
     * Seeded from the **company's own ladder**, so a rung nobody stands on reads `0`
     * rather than being absent. That is what the old three fixed keys bought, and losing
     * it would turn "no AABs yet" into "this screen has no idea".
     */
    const kpm = await this.kpms.findOne({ _id: ctx.kpmId, deletedAt: null }).exec();
    const ladder = kpm ? await this.orgLevels.activeCodesFor(kpm.companyId) : [];
    const counts: DirectCounts = { total: directs.length };
    for (const code of ladder) counts[code] = 0;
    for (const d of directs) {
      counts[d.orgLevelCode] = (counts[d.orgLevelCode] ?? 0) + 1;
    }

    const subtreeCount = await this.members.count(ctx, {
      ancestorIds: leaderId,
      status: 'active',
    });

    await this.members.updateById(ctx, leaderId, {
      $set: { directCounts: counts, subtreeCount },
    });
  }

  /** Everyone below X, in one indexed query — never a recursive walk. */
  async descendantsOf(ctx: RequestContext, membershipId: string): Promise<MembershipDocument[]> {
    return this.members.find(ctx, { ancestorIds: membershipId, status: { $ne: 'removed' } });
  }

  async directReportsOf(ctx: RequestContext, membershipId: string): Promise<MembershipDocument[]> {
    return this.members.find(
      ctx,
      { leaderId: membershipId, status: { $ne: 'removed' } },
      { sort: { agentSeq: 1 } },
    );
  }

  /**
   * The hierarchy as it stood on a date (P3-T2 AC-5).
   *
   * Read from history, not from the current rows: the point is to answer what was true
   * then, which the current `leaderId` cannot.
   *
   * **The latest event by that date that set the leader**, rather than the edge still open
   * then (P11-T3). Every edge now closes when the next one opens, a promotion included, so the
   * edge open on a date can be a role change. One written since carries the leader it kept; one
   * written before does not, and sits beside the edge it should have closed. Joining, a
   * re-parent, a removal and a reinstatement are the events that set the leader, and each
   * names the one it leaves them with: a removal and a reinstatement, none.
   */
  async leaderAsOf(ctx: RequestContext, membershipId: string, at: Date): Promise<string | null> {
    const latest = await this.history.find(
      ctx,
      { membershipId, eventType: { $in: LEADER_EVENTS }, validFrom: { $lte: at } },
      // Two events in one instant are told apart by the order they were written in.
      { sort: { validFrom: -1, _id: -1 }, limit: 1 },
    );
    return latest[0]?.toLeaderId ?? null;
  }
}

/** The edge events that set who the member reports to. A role change keeps the leader it found. */
const LEADER_EVENTS: EdgeEvent[] = ['joined', 're_parented', 'removed', 'reinstated'];

/**
 * **The class a rung gives whoever stands on it** (ADR-0156 §2): its tier's — `senior` → `ab`, `associate` → `aab`,
 * none → `agent` — never its code lower-cased, which is what it was until P18.5-T1 and what made a rung a company
 * named itself work for nothing.
 */
function classOfRung(level: { code: string; leaderTier?: LeaderTier | null }): HierarchyRole {
  return roleClassOf(tierOfRung(level));
}
