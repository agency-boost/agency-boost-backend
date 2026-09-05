import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import { IsEmail, IsEnum, IsOptional, IsString, Matches, MinLength } from 'class-validator';

export class CreateCompanyDto {
  @ApiProperty({ example: 'Prudential' })
  @IsString()
  @MinLength(2)
  name!: string;

  @ApiProperty({ example: 'prudential' })
  @IsString()
  @Matches(/^[a-z0-9-]+$/, { message: 'slug must be lower-case letters, digits and hyphens' })
  slug!: string;
}

export class CreateKpmDto {
  @ApiProperty({ description: 'Company id from GET /admin/companies' })
  @IsString()
  companyId!: string;

  @ApiProperty({ example: '0417', description: 'Unique within the company. Prefixes agent codes.' })
  @IsString()
  @Matches(/^[A-Za-z0-9-]{2,16}$/)
  code!: string;

  @ApiProperty({ example: 'BSD City Branch' })
  @IsString()
  @MinLength(2)
  branchName!: string;

  @ApiPropertyOptional({ example: 'Jl. Raya Serpong, Tangerang' })
  @IsOptional()
  @IsString()
  address?: string;

  @ApiPropertyOptional({ example: '+622112345678' })
  @IsOptional()
  @IsString()
  contactPhone?: string;

  @ApiPropertyOptional({
    example: 'Asia/Jakarta',
    description: 'Canonical for every day boundary in this office. Inherited from the company if omitted.',
  })
  @IsOptional()
  @IsString()
  timezone?: string;
}

export class AssignOwnerDto {
  @ApiPropertyOptional({
    example: 'owner@kpm0417.test',
    description:
      'The account to make Owner. It must already exist — create one at /register or ' +
      'with POST /auth/register. Email is what a Super Admin normally knows.',
  })
  @IsOptional()
  // Trimmed before validation, not after. The service normalises too, but @IsEmail
  // runs first and rejects a pasted address with surrounding whitespace — so the
  // service's own trim never got the chance, and a service test passed against a
  // contract HTTP did not honour.
  @Transform(({ value }) => (typeof value === 'string' ? value.trim() : value))
  @IsEmail()
  email?: string;

  @ApiPropertyOptional({
    description: 'Alternative to email, for when you already have the id.',
  })
  @IsOptional()
  @IsString()
  userId?: string;
}

export class SetStatusDto {
  @ApiProperty({ enum: ['active', 'suspended', 'archived'] })
  @IsEnum(['active', 'suspended', 'archived'])
  status!: 'active' | 'suspended' | 'archived';

  @ApiPropertyOptional({ example: 'unpaid invoice' })
  @IsOptional()
  @IsString()
  reason?: string;
}

export class AuditQueryDto {
  @ApiPropertyOptional({
    description:
      'Super Admin only: narrow the log to one office. Omitted reads the platform-level ' +
      'log. Ignored for anyone else, who always reads their own office.',
  })
  @IsOptional()
  @IsString()
  kpmId?: string;
}
