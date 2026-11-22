import { HttpStatus, Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { requireManageableMember } from '@/common/auth/office-steward';
import { RequestContext } from '@/common/context/request-context';
import { DomainException, NotFoundException } from '@/common/errors/domain.exception';
import { ErrorCode } from '@/common/errors/error-codes';
import { joinDateViolation, type Gender, type WorkStatus } from '@/domain/constants';
import { AuditService } from '@/modules/audit/audit.service';
import { AUTH_REFUSALS } from '@/modules/auth/auth.messages';
import { TenantDay } from '@/modules/tenants/tenant-day.service';
import { birthDateProblem, joinMonthProblem } from '@/modules/users/personal-data';
import { User, UserDocument } from '@/modules/users/user.schema';
import { DirectoryService, type DirectoryMember, type MemberPersonal } from './directory.service';
import { MEMBER_PERSONAL_REFUSALS } from './member-personal.messages';
import { MembershipRepository } from './membership.repository';

/**
 * **What the member sheet edits** (P19.20-T2 AC-1, AC-2; ADR-0273 §3), by their API names, in the sheet's order —
 * *Profil*: bergabung di KPM, bergabung di perusahaan, waktu, kode agen; *Demografi*: tanggal lahir (umur), jenis
 * kelamin, No. WhatsApp, email. *Peran* and *Leader* are their own writes (`PATCH …/role`, `PUT …/leader`), a group an
 * AB's (`PUT …/group`), and *Unit* is counted from the tree, never typed.
 */
export const PERSONAL_FIELDS = [
  'joinDate', 'companyJoinMonth', 'workStatus', 'agentCode', 'dateOfBirth', 'gender', 'phone', 'email',
] as const;
export type PersonalField = (typeof PERSONAL_FIELDS)[number];

/** The ones on the person's account (`users`, global — ADR-0002); `joinDate` and `workStatus` are the membership's. */
const ACCOUNT_FIELDS = ['companyJoinMonth', 'agentCode', 'dateOfBirth', 'gender', 'phone', 'email'] as const satisfies readonly PersonalField[];
type AccountField = (typeof ACCOUNT_FIELDS)[number];
/** On the membership: the join date and the work status, and the copy of the agent code the roster searches. */
const MEMBERSHIP_FIELDS = ['joinDate', 'workStatus'] as const satisfies readonly PersonalField[];

/** What the sheet sends: each field optional, at least one of them (the DTO has read their shapes). */
export interface CompletePersonalInput {
  joinDate?: string;
  companyJoinMonth?: string;
  workStatus?: WorkStatus;
  /** Digits, as the insurer issued it (`AGENT_CODE_PATTERN`); stored upper-cased and trimmed. */
  agentCode?: string;
  dateOfBirth?: string;
  gender?: Gender;
  /** As stored, `+62…` — the DTO has already read what was typed (`phoneFromBody`). */
  phone?: string;
  /** Lower-cased and trimmed by the DTO. */
  email?: string;
}

/** What `PATCH /members/:membershipId/personal` answers: what changed, *Data pribadi* now, and the member as now read. */
export interface MemberPersonalCompleted {
  membershipId: string;
  /** The fields this request changed — a value sent equal to the stored one is not among them. */
  filled: PersonalField[];
  personal: MemberPersonal;
  /** The member as the sheet reads them now (`GET /members/:membershipId`). */
  member: DirectoryMember;
}

type Stored = Partial<Record<PersonalField, string | null>>;

/**
 * **The member sheet: the Owner, the Admins and a core leader change any field of a member** (P19.20-T2 AC-2; ADR-0273
 * §3, amending ADR-0248 §3 — *the office fills blanks only* — and ADR-0158 §3; `PERMISSIONS.md`, *Edit a member's data in
 * the detail sheet*).
 *
 * - **Who**: `member:complete_personal` — the Owner and the Admins `own-kpm`, a core leader **strictly below them**
 *   (`requireManageableMember`, ADR-0268 §1), the Super Admin inside the KPM as its Owner. Another office's member,
 *   somebody removed, a member outside a core leader's downline, or an id that is none: `404`, never `403`.
 * - **What**: a join date and a work status on the membership; a company join month, a birth date, a gender, a WhatsApp
 *   number, an agent code and an email on the person's account (identity is global, ADR-0002 — the values they see on
 *   their own profile). **Any value, not only a blank** (ADR-0273 §3); none is clearable.
 * - **Checked as everywhere else**: a birth date in the past and at least 18 years ago, a join month not in the future,
 *   a join date not after today and not before the earliest — **today in the office's calendar** (`TenantDay`,
 *   invariant §9); an agent code free at the insurer (`409 AGENT_CODE_TAKEN`, the registration's words) and an address
 *   free (`409 AUTH_EMAIL_TAKEN`).
 * - **The address somebody signs in with is theirs** (OD-400): an email is corrected only for a person who has never
 *   signed in — their invitation's address — else `409 MEMBER_EMAIL_SIGNED_IN`, nothing written.
 * - **The agent code moves in both places it lives**: the account's, unique at the insurer, and this office's copy on
 *   the membership (one live membership per person, v1). Production already uploaded stays with the member — its key is
 *   the membership (`monthly-agent-data.schema.ts`); the next upload matches the new code.
 * - **Every change logged** (`PERMISSIONS.md`: *who, when, what*; the Super Admin spec §1: *before → after*): one
 *   `member.details_edited` audit entry naming the fields, **before and after** (ADR-0273 §3; OD-401).
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
    // A core leader changes somebody below them only (ADR-0268 §1); anybody else in the KPM is not confirmed.
    requireManageableMember(ctx, { membershipId: String(member._id), ancestorIds: member.ancestorIds }, 'Membership');

    const { today } = await this.day.for(ctx);
    const checks = [
      ['dateOfBirth', input.dateOfBirth === undefined ? null : birthDateProblem(input.dateOfBirth, today)],
      ['companyJoinMonth', input.companyJoinMonth === undefined ? null : joinMonthProblem(input.companyJoinMonth, today)],
      ['joinDate', input.joinDate === undefined ? null : joinDateViolation(input.joinDate, today)],
    ] as const;
    for (const [field, problem] of checks) {
      if (problem) throw new DomainException(ErrorCode.VALIDATION_FAILED, problem, HttpStatus.BAD_REQUEST, { field });
    }

    const user = await this.users
      .findOne({ _id: member.userId })
      .select('companyJoinMonth agentCode dateOfBirth gender phone email companyId lastLoginAt')
      .lean<Stored & { companyId?: string | null; lastLoginAt?: Date | null }>()
      .exec();
    const before: Stored = {
      ...Object.fromEntries(ACCOUNT_FIELDS.map((f) => [f, (user?.[f] as string | null | undefined) || null])),
      joinDate: member.joinDate ?? null,
      workStatus: member.workStatus ?? null,
    };
    // A value sent as it is stored changes nothing, and is neither written nor logged.
    const changed = given.filter((f) => (before[f] ?? null) !== input[f]);

    if (changed.includes('email')) {
      if (user?.lastLoginAt) {
        throw new DomainException(
          ErrorCode.MEMBER_EMAIL_SIGNED_IN, MEMBER_PERSONAL_REFUSALS.MEMBER_EMAIL_SIGNED_IN.signedIn, HttpStatus.CONFLICT,
          { membershipId, field: 'email' },
        );
      }
      const holder = await this.users.exists({ email: input.email, _id: { $ne: member.userId } }).exec();
      if (holder) {
        throw new DomainException(
          ErrorCode.AUTH_EMAIL_TAKEN, AUTH_REFUSALS.AUTH_EMAIL_TAKEN.belongsToAnother, HttpStatus.CONFLICT, { field: 'email' },
        );
      }
    }
    if (changed.includes('agentCode')) {
      const holder = user?.companyId
        ? await this.users
          .exists({ companyId: user.companyId, agentCode: input.agentCode, _id: { $ne: member.userId }, deletedAt: null })
          .exec()
        : null;
      if (holder) {
        const company = (await this.directory.personalOf(ctx, member)).companyName ?? '';
        throw new DomainException(
          ErrorCode.AGENT_CODE_TAKEN,
          AUTH_REFUSALS.AGENT_CODE_TAKEN.registered({ agentCode: input.agentCode as string, company }),
          HttpStatus.CONFLICT,
          { field: 'agentCode', agentCode: input.agentCode },
        );
      }
    }

    const account = ACCOUNT_FIELDS.filter((f): f is AccountField => changed.includes(f));
    if (account.length > 0) {
      await this.users.updateOne({ _id: member.userId }, { $set: Object.fromEntries(account.map((f) => [f, input[f]])) }).exec();
    }
    const onMembership: Record<string, unknown> = Object.fromEntries(
      MEMBERSHIP_FIELDS.filter((f) => changed.includes(f)).map((f) => [f, input[f]]),
    );
    // The roster searches this office's copy of the code (`memberships.agentCode`, ADR-0017).
    if (changed.includes('agentCode')) onMembership.agentCode = input.agentCode;
    if (Object.keys(onMembership).length > 0) {
      await this.members.updateMany(ctx, { _id: membershipId }, { $set: onMembership });
    }

    if (changed.length > 0) {
      await this.audit.record(ctx, {
        action: 'member.details_edited',
        targetCollection: 'memberships',
        targetId: membershipId,
        targetMembershipId: membershipId,
        before: Object.fromEntries(changed.map((f) => [f, before[f] ?? null])),
        after: Object.fromEntries(changed.map((f) => [f, input[f] ?? null])),
      });
    }
    const now = (await this.members.findById(ctx, membershipId)) ?? member;
    const [personal, read] = await Promise.all([
      this.directory.personalOf(ctx, now),
      this.directory.read(ctx, membershipId),
    ]);
    return { membershipId, filled: changed, personal, member: read };
  }
}
