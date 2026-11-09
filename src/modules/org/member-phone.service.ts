import { HttpStatus, Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { RequestContext } from '@/common/context/request-context';
import { DomainException } from '@/common/errors/domain.exception';
import { ErrorCode } from '@/common/errors/error-codes';
import { AuditService } from '@/modules/audit/audit.service';
import { User, UserDocument } from '@/modules/users/user.schema';
import { CoachResolver } from './coach-resolver';
import { MembershipRepository } from './membership.repository';
import { ORG_REFUSALS } from './org.messages';

/** What `PUT /members/:membershipId/phone` answers: whose number, and the number as stored. */
export interface MemberPhone {
  membershipId: string;
  phone: string;
}

/**
 * **A leader saves an agent's WhatsApp number** (UI V1, 2026-10-30; UI-081, UI-101, the owner's D-22: *a leader may
 * set it for their agents*). The *Isi nomor WhatsApp* sheet on a person's row — the Home team list, the Unit
 * Dashboard, New Hires — when the person has none yet.
 *
 * - **Who**: `member:update_phone`, the AB's and the AAB's at `own-downline`, resolved by `COACH` (`CoachResolver.subject`):
 *   somebody they coach now, active, in this office. Anybody else — a peer's agent, another office's member, somebody who
 *   has left — is `404`, never `403`. A leader naming themselves fills their own missing number, as `PATCH /auth/me` would.
 * - **What**: `users.phone`, the person's account (identity is global, ADR-0002), as `+62` and its digits — the DTO has
 *   already read what was typed (`phoneFromBody`). The same number the person sees on *Profil saya*.
 * - **Only a missing number** (the Phase 18.11 exit review, M1): a number already on file is `409 MEMBER_PHONE_ON_FILE`
 *   and stays as it is — changing it is the person's own act, on *Profil saya* (`PATCH /auth/me`). The empty-number
 *   condition is in the update's filter, not a read before it, so two leaders saving at once cannot overwrite each
 *   other: the second write matches nothing and is refused the same way.
 * - **Recorded**: one `member.phone_updated` entry naming the person, and **never the number**: an audit trail that
 *   copied it would be a second place a personal datum lives (PDP, UU 27/2022).
 */
@Injectable()
export class MemberPhoneService {
  constructor(
    private readonly coach: CoachResolver,
    private readonly members: MembershipRepository,
    @InjectModel(User.name) private readonly users: Model<UserDocument>,
    private readonly audit: AuditService,
  ) {}

  async set(ctx: RequestContext, membershipId: string, phone: string): Promise<MemberPhone> {
    const subject = await this.coach.subject(ctx, membershipId, 'member:update_phone');
    // `subject` resolved the membership in this office, so the read cannot miss.
    const member = (await this.members.findById(ctx, subject.membershipId))!;
    // `$in: [null, '']` matches a field that is null, absent or empty, and nothing else: the write and its condition are
    // one operation, so a number saved by somebody else a moment ago makes this match nothing.
    const written = await this.users
      .updateOne({ _id: member.userId, phone: { $in: [null, ''] } }, { $set: { phone } })
      .exec();
    if (written.matchedCount === 0) {
      throw new DomainException(
        ErrorCode.MEMBER_PHONE_ON_FILE,
        ORG_REFUSALS.MEMBER_PHONE_ON_FILE.onFile,
        HttpStatus.CONFLICT,
        { membershipId: subject.membershipId },
      );
    }
    await this.audit.record(ctx, {
      action: 'member.phone_updated',
      targetCollection: 'users',
      targetId: member.userId,
      targetMembershipId: subject.membershipId,
      before: { hadPhone: false },
      after: { hadPhone: true, self: subject.self },
    });
    return { membershipId: subject.membershipId, phone };
  }
}
