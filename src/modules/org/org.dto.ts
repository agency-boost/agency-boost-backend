import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform, Type } from 'class-transformer';
import { IsEnum, IsInt, IsOptional, IsString, Max, MaxLength, Min } from 'class-validator';

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
