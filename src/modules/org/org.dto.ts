import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform, Type } from 'class-transformer';
import {
  IsArray, IsBoolean, IsEnum, IsInt, IsNotEmpty, IsOptional, IsString, Max, MaxLength,
  Min, MinLength, ValidateIf, ValidateNested,
} from 'class-validator';

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
  @IsString()
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

export class IssueInviteDto {
  @ApiPropertyOptional({
    example: 'Hiring push, September',
    description: 'A note for you. Never shown to whoever redeems it.',
  })
  @IsOptional()
  @Transform(({ value }) => (typeof value === 'string' ? value.trim() : value))
  @IsString()
  @MaxLength(120)
  label?: string;

  @ApiPropertyOptional({
    minimum: 1,
    maximum: 500,
    description: 'How many people may use it. Omitted means no ceiling.',
  })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(500)
  maxUses?: number;

  @ApiPropertyOptional({
    minimum: 1,
    maximum: 365,
    description: 'Days until it stops working. Omitted means it runs until revoked.',
  })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(365)
  expiresInDays?: number;
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

export class ChangeRoleDto {
  @ApiProperty({ enum: ['ab', 'aab', 'agent'] })
  @IsEnum(['ab', 'aab', 'agent'])
  toRole!: 'ab' | 'aab' | 'agent';

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
  @IsString({ each: true })
  groupIds!: string[];

  @ApiProperty({
    description:
      'Gates Strategic Leader Forum co-editing (Phase 14) and nothing else. It grants ' +
      'no hierarchy and no data scope.',
  })
  @IsBoolean()
  isCoreLeader!: boolean;
}
