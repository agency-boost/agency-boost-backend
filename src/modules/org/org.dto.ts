import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform, Type } from 'class-transformer';
import { IsEnum, IsInt, IsOptional, IsString, Max, MaxLength, Min, MinLength } from 'class-validator';

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
