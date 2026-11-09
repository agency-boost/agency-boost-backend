import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform, Type } from 'class-transformer';
import {
  IsArray, IsBoolean, IsEnum, IsInt, IsMongoId, IsNotEmpty, IsOptional, IsString, Matches, Max,
  MaxLength, Min, MinLength, ValidateIf, ValidateNested,
} from 'class-validator';
import { field } from '@/common/validation/violations';
import { JOINING_REFUSALS } from '@/domain/constants/joining.messages';
import { ORG_REFUSALS } from './org.messages';
import { PHONE_FIELD_SHAPE, phoneFromBody } from '@/modules/users/phone-input';
import { MEMBER_SEARCH_DEFAULT, MEMBER_SEARCH_MAX } from './directory.service';

export class DirectoryQueryDto {
  @ApiPropertyOptional({ description: 'Name, email or agent code. Case-insensitive.' })
  @IsOptional()
  @Transform(({ value }) => (typeof value === 'string' ? value.trim() : value))
  @IsString()
  @MaxLength(120)
  q?: string;

  @ApiPropertyOptional({ enum: ['ab', 'aab', 'agent'] })
  @IsOptional()
  @IsEnum(['ab', 'aab', 'agent'])
  role?: 'ab' | 'aab' | 'agent';

  @ApiPropertyOptional({
    enum: ['active', 'pending', 'removed'],
    description: 'Omitted excludes removed members — the roster asks who is here now.',
  })
  @IsOptional()
  @IsEnum(['active', 'pending', 'removed'])
  status?: 'active' | 'pending' | 'removed';

  @ApiPropertyOptional({ description: 'The `nextCursor` of the previous page — an agent code.' })
  @IsOptional()
  @IsString()
  cursor?: string;

  // Query strings arrive as strings, so this field opts in to conversion explicitly.
  // Implicit conversion is off globally, because with it on @IsString() would pass for
  // a number and body validation would become decorative.
  @ApiPropertyOptional({ minimum: 1, maximum: 100, default: 25 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  limit?: number;
}

/**
 * **Search agent** (UI V1, 2026-10-30; UI-012, UI-059, the owner's D-14): who the picker offers, by name or agent code.
 */
export class MemberSearchQueryDto {
  @ApiPropertyOptional({
    description: 'Part of a name or an agent code, case-insensitive. Empty or absent lists the first people A to Z.',
  })
  @IsOptional()
  @Transform(({ value }) => (typeof value === 'string' ? value.trim() : value))
  @IsString()
  @MaxLength(120)
  q?: string;

  @ApiPropertyOptional({ minimum: 1, maximum: MEMBER_SEARCH_MAX, default: MEMBER_SEARCH_DEFAULT })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(MEMBER_SEARCH_MAX)
  limit?: number;
}

/**
 * **A leader saves an agent's WhatsApp number** (UI V1, 2026-10-30; UI-081, UI-101, the owner's D-22): *Isi nomor
 * WhatsApp* on a person they coach. Required here — clearing a number is the person's own, on `PATCH /auth/me`.
 */
/**
 * **`GET /members/tree`'s `for`, and nothing else** (P19.3-T3; `/group-tree/[membershipId]`): the membership whose tree to
 * read, as that leader sees it. Any other parameter is refused by name.
 */
export class OrgTreeQueryDto {
  @ApiPropertyOptional({
    maxLength: 64,
    description:
      'The **membership** whose Group Tree to read, read-only: for the Owner and an Admin any active member of the '
      + 'office, for an AB or an AAB anybody in their downline. Omitted, your own.',
  })
  @IsOptional()
  @IsString()
  @MaxLength(64)
  for?: string;
}

export class SetMemberPhoneDto {
  @ApiProperty({
    type: String,
    example: '0812-1100-2200',
    description: 'Spaces, dashes, dots and brackets go, and a leading `+62`, `62` or `0`; what is left must be 9 to 13 '
      + 'digits, stored as `+62…`, else `400 VALIDATION_FAILED` naming `phone`.',
  })
  @Transform(({ value }) => phoneFromBody(value))
  @Matches(PHONE_FIELD_SHAPE, { message: field(ORG_REFUSALS.VALIDATION_FAILED.phoneShape) })
  phone!: string;
}

export class KpmSearchDto {
  @ApiPropertyOptional({ description: 'Office code or branch name. Case-insensitive substring.' })
  @IsOptional()
  @Transform(({ value }) => (typeof value === 'string' ? value.trim() : value))
  @IsString()
  @MaxLength(120)
  q?: string;
}

export class RegisterKpmDto {
  @ApiProperty({ description: 'From GET /join/kpms.' })
  @IsMongoId()
  kpmId!: string;
}

export class LeaderSearchDto {
  @ApiPropertyOptional({ description: 'Name only, as the prototype searches it.' })
  @IsOptional()
  @Transform(({ value }) => (typeof value === 'string' ? value.trim() : value))
  @IsString()
  @MaxLength(120)
  q?: string;
}

export class RequestLeaderDto {
  @ApiProperty({ description: 'From GET /join/leaders.' })
  @IsString()
  leaderMembershipId!: string;
}

export class RedeemInviteDto {
  @ApiProperty({ example: 'JOR417', description: 'From a link, a QR, or read aloud.' })
  @Transform(({ value }) => (typeof value === 'string' ? value.trim().toUpperCase() : value))
  @IsString()
  @MinLength(4)
  @MaxLength(16)
  code!: string;
}

export class InviteCodeQueryDto {
  @ApiProperty({ example: 'JOR417' })
  @Transform(({ value }) => (typeof value === 'string' ? value.trim().toUpperCase() : value))
  @IsString()
  @MinLength(4)
  @MaxLength(16)
  code!: string;
}

/** An office date, as every date field in a body is written. Whether it is a real day is the service's check. */
const DATE_SHAPE = /^\d{4}-\d{2}-\d{2}$/;
/**
 * The pipe's refusal of a join date's shape: the same sentence the service refuses a date that is no real day with
 * (`joinDateViolation`), both languages (`field`, P18.10-T5 AC-3).
 */
const JOIN_DATE_MESSAGE = field(JOINING_REFUSALS.VALIDATION_FAILED.notADate);

/** The join date a leader gives when letting somebody in (ADR-0169, P18.8-T2), on an approval and on a tag. */
const JOIN_DATE_PROPERTY = {
  type: String,
  format: 'date',
  example: '2026-10-27',
  description:
    'The day they joined, an office date: the office\u2019s today at the latest, and not before 1980 \u2014 an existing '
    + 'agent may have joined years ago. Omitted, the office\u2019s today. It decides once whether they are a new hire '
    + '(no more than 90 days back) or an existing agent, and a new hire\u2019s activation starts on it. Ignored for '
    + 'somebody who already has a join date in this office.',
} as const;

export class ApproveRequestDto {
  @ApiPropertyOptional({
    description:
      'One of your own AABs, from GET /join/requests/routing. Omitted adds them to ' +
      'your own unit. Ignored for an AB or AAB requester — a leader is not placed in a ' +
      'unit, they are tagged to you directly.',
  })
  @IsOptional()
  @IsString()
  routeToMembershipId?: string;

  @ApiPropertyOptional(JOIN_DATE_PROPERTY)
  @IsOptional()
  @IsString()
  @Matches(DATE_SHAPE, { message: JOIN_DATE_MESSAGE })
  joinDate?: string;
}

export class TagUntaggedDto {
  @ApiPropertyOptional(JOIN_DATE_PROPERTY)
  @IsOptional()
  @IsString()
  @Matches(DATE_SHAPE, { message: JOIN_DATE_MESSAGE })
  joinDate?: string;
}

export class DeclineRequestDto {
  @ApiPropertyOptional({
    example: 'Not in my patch — try Sari',
    description: 'Sent to them. The prototype captures none, which leaves a decline unexplainable.',
  })
  @IsOptional()
  @Transform(({ value }) => (typeof value === 'string' ? value.trim() : value))
  @IsString()
  @MaxLength(300)
  reason?: string;
}

export class UntaggedSearchDto {
  @ApiPropertyOptional({ description: 'Name. Case-insensitive substring.' })
  @IsOptional()
  @Transform(({ value }) => (typeof value === 'string' ? value.trim() : value))
  @IsString()
  @MaxLength(120)
  q?: string;
}

/** A rung's code as the company's ladder writes it: letters, digits and underscores, starting with a letter. */
const RUNG_CODE = /^[A-Za-z][A-Za-z0-9_]{1,31}$/;

export class ChangeRoleDto {
  @ApiProperty({
    example: 'aab',
    description:
      'The rung, by its code on the company\u2019s ladder, in any case: `ab`, `aab`, `agent`, or a rung the company '
      + 'added. What the member is given — AB, AAB or Agent rights — follows the rung\u2019s leader tier. A code that '
      + 'is no active rung is refused `409 ORG_LEVEL_NOT_ON_LADDER`.',
  })
  @IsString()
  @Matches(RUNG_CODE, { message: field(ORG_REFUSALS.VALIDATION_FAILED.toRoleShape) })
  toRole!: string;

  @ApiPropertyOptional({
    example: 'Ready to bring on their own agents',
    description: 'Kept in the role change log, which is the only place this can be read back.',
  })
  @IsOptional()
  @Transform(({ value }) => (typeof value === 'string' ? value.trim() : value))
  @IsString()
  @MaxLength(300)
  reason?: string;
}

export class SubtreeDispositionDto {
  @ApiProperty({
    enum: ['reassign', 'orphan'],
    description:
      'Where the reports of the person being removed go. There is no default: leaving ' +
      'it to the server would be a silent reorganisation of somebody else’s unit.',
  })
  @IsEnum(['reassign', 'orphan'])
  action!: 'reassign' | 'orphan';

  @ApiPropertyOptional({
    description: 'Required when action is `reassign`. The membership their reports move to.',
  })
  @ValidateIf((o: SubtreeDispositionDto) => o.action === 'reassign')
  @IsString()
  @IsNotEmpty()
  toMembershipId?: string;
}

export class RemoveMemberDto {
  @ApiProperty({
    example: 'REMOVE',
    description:
      'The literal word REMOVE, trimmed and case-insensitive. Checked here as well as ' +
      'in the screen — a confirmation only the screen enforces is not a confirmation.',
  })
  @IsString()
  confirmation!: string;

  @ApiPropertyOptional({
    example: 'Left the industry',
    description: 'Kept on the removal history event, and sent to them.',
  })
  @IsOptional()
  @Transform(({ value }) => (typeof value === 'string' ? value.trim() : value))
  @IsString()
  @MaxLength(300)
  reason?: string;

  @ApiPropertyOptional({
    type: SubtreeDispositionDto,
    description: 'Required when they still have direct reports; refused otherwise.',
  })
  @IsOptional()
  @ValidateNested()
  @Type(() => SubtreeDispositionDto)
  subtree?: SubtreeDispositionDto;
}

export class GroupDto {
  @ApiProperty({ example: 'New Agent Mentoring Circle' })
  @Transform(({ value }) => (typeof value === 'string' ? value.trim() : value))
  @IsString()
  @MinLength(1)
  @MaxLength(80)
  name!: string;

  @ApiProperty({
    description:
      'The membership that owns it. Never a name — the prototype stores `ownerName`, ' +
      'which breaks the moment anybody is renamed or two people share one.',
  })
  @IsString()
  @IsNotEmpty()
  ownerMembershipId!: string;
}

export class TagMemberDto {
  @ApiProperty({
    type: [String],
    description:
      'Every live group this person should be in. Absent ids are removed; tags on ' +
      'retired groups are kept, because they are the record that a cohort existed.',
  })
  @IsArray()
  @IsMongoId({ each: true })
  groupIds!: string[];

  @ApiProperty({
    description:
      'Core Leader (ADR-0159): who, besides the Owner and the Admins, opens and writes in the Strategic Leader ' +
      'Forum’s meetings and reads the office’s KPM analytics. A leader’s only: setting it on a member whose rung ' +
      'is not a leader rung is refused `400 CORE_LEADER_NOT_A_LEADER`, and changing it needs ' +
      '`member:tag_core_leader`. It grants no hierarchy.',
  })
  @IsBoolean()
  isCoreLeader!: boolean;
}

/** `PUT /members/:membershipId/core-leader` — the directory row's control (ADR-0159 §1). */
export class SetCoreLeaderDto {
  @ApiProperty({
    description:
      'Tag (`true`) or untag (`false`) this member *Core Leader*. Their groups are untouched. Setting it on a ' +
      'member whose rung is not a leader rung is refused `400 CORE_LEADER_NOT_A_LEADER`.',
  })
  @IsBoolean()
  isCoreLeader!: boolean;
}

/** Asking AgencyBoost to approve one leader past the office's limit (ADR-0157 §1). */
export class CreateLeaderLimitRequestDto {
  @ApiProperty({
    enum: ['promote', 'activate'],
    description:
      '`promote`: the role change the limit refused, onto the rung named. `activate`: letting in a pending member '
      + 'who stands on a leader rung — approving their join request, or tagging them into your unit.',
  })
  @IsEnum(['promote', 'activate'])
  action!: 'promote' | 'activate';

  @ApiPropertyOptional({ example: 'AAB', description: 'For `promote`: the rung, by its code on the company\u2019s ladder.' })
  @IsOptional()
  @IsString()
  @Matches(RUNG_CODE, { message: field(ORG_REFUSALS.VALIDATION_FAILED.orgLevelCodeShape) })
  orgLevelCode?: string;

  @ApiPropertyOptional({
    example: 'Ready to bring on their own agents',
    description: 'For `promote`: kept in the role change log when AgencyBoost approves it.',
  })
  @IsOptional()
  @Transform(({ value }) => (typeof value === 'string' ? value.trim() : value))
  @IsString()
  @MaxLength(300)
  reason?: string;
}

/** Declining a leader-limit request: the reason is required, and travels back to whoever asked. */
export class DeclineLeaderLimitRequestDto {
  @ApiProperty({ example: 'Raise the limit at renewal instead.', maxLength: 500 })
  @Transform(({ value }) => (typeof value === 'string' ? value.trim() : value))
  @IsString()
  @MinLength(1)
  @MaxLength(500)
  reason!: string;
}
