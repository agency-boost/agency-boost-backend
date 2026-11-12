import { HttpStatus, Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { RequestContext } from '@/common/context/request-context';
import { DomainException, NotFoundException } from '@/common/errors/domain.exception';
import { ErrorCode } from '@/common/errors/error-codes';
import type { Gender, WorkStatus } from '@/domain/constants';
import { AuditService } from '@/modules/audit/audit.service';
import { TenantDay } from '@/modules/tenants/tenant-day.service';
import { birthDateProblem, joinMonthProblem } from '@/modules/users/personal-data';
import { User, UserDocument } from '@/modules/users/user.schema';
import { DirectoryService, type MemberPersonal } from './directory.service';
import { MEMBER_PERSONAL_REFUSALS } from './member-personal.messages';
import { MembershipRepository } from './membership.repository';

/** The five the office may fill, by their API names, in the order the dialog shows them. */
export const PERSONAL_FIELDS = ['dateOfBirth', 'gender', 'companyJoinMonth', 'workStatus', 'phone'] as const;
export type PersonalField = (typeof PERSONAL_FIELDS)[number];

/** The four that live on the person's account (`users`); `workStatus` is the membership's (ADR-0158 §1). */
const ACCOUNT_FIELDS = ['dateOfBirth', 'gender', 'companyJoinMonth', 'phone'] as const satisfies readonly PersonalField[];
type AccountField = (typeof ACCOUNT_FIELDS)[number];

/** What *Lengkapi data* sends: each of the five optional, at least one of them (the DTO has read their shapes). */
export interface CompletePersonalInput {
  dateOfBirth?: string;
  gender?: Gender;
  companyJoinMonth?: string;
  workStatus?: WorkStatus;
  /** As stored, `+62…` — the DTO has already read what was typed (`phoneFromBody`). */
  phone?: string;
}

/** What `PATCH /members/:membershipId/personal` answers: what was filled, and what *Data pribadi* now shows. */
export interface MemberPersonalCompleted {
  membershipId: string;
  filled: PersonalField[];
  personal: MemberPersonal;
}

/** Blank on file: absent, `null`, or an empty string (an empty number is no number, as `MemberPhoneService` reads it). */
const BLANK = { $in: [null, ''] };
const isBlank = (value: unknown) => value === undefined || value === null || value === '';

/**
 * **The Owner and the Admins fill a member's blank personal data** (P19.12-T5 AC-3; ADR-0248 §3, amending ADR-0158 §3;
 * the client's TI-2, OD-315's default) — *Lengkapi data* on the member page, for a member imported with gaps.
 *
 * - **Who**: `member:complete_personal`, the Owner's and the Admins' at `own-kpm`; any member of this office who has not
 *   left. Another office's member, somebody removed, or an id that is none is `404`, never `403`.
 * - **What**: a birth date, a gender, a company join month and a WhatsApp number on the person's account (identity is
 *   global, ADR-0002 — the values they see on their own profile), and a work status on the membership.
 * - **Checked as the profile checks them**: the shapes by the DTO in the profile's sentences; a birth date in the past and
 *   at least 18 years ago, and a join month not in the future, against **today in the office's calendar** (`TenantDay`,
 *   invariant §9) — `personal-data.ts`, so the import, registration, `/profile` and this refuse alike.
 * - **Blanks only**: a field already on file is `409 MEMBER_DETAIL_ON_FILE`, its name in `details.fields`, and nothing
 *   is written — correcting a recorded value is the person's own act, on `PATCH /auth/me`. The read before the write
 *   names the fields; **each write also carries the condition**, so of two saves at once the second matches nothing and
 *   is refused the same way. The account's fields are one write and the membership's another, each conditional.
 * - **Recorded**: one `member.personal_completed` entry naming the person and **the fields, never their values** — an
 *   audit trail that copied a birth date would be a second place it lives (PDP, UU 27/2022).
 */
@Injectable()
export class MemberPersonalService {
  constructor(
    private readonly members: MembershipRepository,
    @InjectModel(User.name) private readonly users: Model<UserDocument>,
    private readonly directory: DirectoryService,
    private readonly day: TenantDay,
    private readonly audit: AuditService,
  ) {}

  async complete(ctx: RequestContext, membershipId: string, input: CompletePersonalInput): Promise<MemberPersonalCompleted> {
    const given = PERSONAL_FIELDS.filter((f) => input[f] !== undefined);
    if (given.length === 0) {
      throw new DomainException(
        ErrorCode.VALIDATION_FAILED, MEMBER_PERSONAL_REFUSALS.VALIDATION_FAILED.nothingToFill, HttpStatus.BAD_REQUEST,
      );
    }

    // In this office (the repository's `kpmId`) and not gone: a removed member's record is history, not a form.
    const member = await this.members.findOne(ctx, { _id: membershipId, status: { $ne: 'removed' } });
    if (!member) throw new NotFoundException('Membership');

    const { today } = await this.day.for(ctx);
    const checks = [
      ['dateOfBirth', input.dateOfBirth === undefined ? null : birthDateProblem(input.dateOfBirth, today)],
      ['companyJoinMonth', input.companyJoinMonth === undefined ? null : joinMonthProblem(input.companyJoinMonth, today)],
    ] as const;
    for (const [field, problem] of checks) {
      if (problem) throw new DomainException(ErrorCode.VALIDATION_FAILED, problem, HttpStatus.BAD_REQUEST, { field });
    }

    const accountGiven = ACCOUNT_FIELDS.filter((f) => input[f] !== undefined);
    const user = await this.users.findOne({ _id: member.userId }).select(ACCOUNT_FIELDS.join(' ')).lean().exec();
    const onFile: PersonalField[] = [
      ...accountGiven.filter((f) => !isBlank((user as Partial<Record<AccountField, unknown>> | null)?.[f])),
      ...(input.workStatus !== undefined && !isBlank(member.workStatus) ? (['workStatus'] as const) : []),
    ];
    if (onFile.length > 0) throw this.onFile(membershipId, onFile);

    if (accountGiven.length > 0) {
      const written = await this.users.updateOne(
        { _id: member.userId, ...Object.fromEntries(accountGiven.map((f) => [f, BLANK])) },
        { $set: Object.fromEntries(accountGiven.map((f) => [f, input[f]])) },
      ).exec();
      if (written.matchedCount === 0) throw this.onFile(membershipId, accountGiven);
    }
    if (input.workStatus !== undefined) {
      const written = await this.members.updateMany(
        ctx, { _id: membershipId, workStatus: BLANK }, { $set: { workStatus: input.workStatus } },
      );
      if (written === 0) throw this.onFile(membershipId, ['workStatus']);
    }

    await this.audit.record(ctx, {
      action: 'member.personal_completed',
      targetCollection: 'memberships',
      targetId: membershipId,
      targetMembershipId: membershipId,
      after: { fields: given },
    });
    const now = await this.members.findById(ctx, membershipId);
    return { membershipId, filled: given, personal: await this.directory.personalOf(ctx, now ?? member) };
  }

  private onFile(membershipId: string, fields: readonly PersonalField[]): DomainException {
    return new DomainException(
      ErrorCode.MEMBER_DETAIL_ON_FILE,
      MEMBER_PERSONAL_REFUSALS.MEMBER_DETAIL_ON_FILE.onFile,
      HttpStatus.CONFLICT,
      { membershipId, fields },
    );
  }
}
