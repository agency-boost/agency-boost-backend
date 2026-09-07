import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import {
  IsEmail, IsEnum, IsIn, IsMongoId, IsOptional, IsString, Matches, MaxLength, MinLength,
} from 'class-validator';
import { DEFAULT_TENANT_TIMEZONE } from '@/domain/constants';

export class CreateCompanyDto {
  @ApiProperty({ example: 'Prudential', minLength: 2, maxLength: 120 })
  @IsString()
  @MinLength(2)
  @MaxLength(120)
  name!: string;

  /**
   * The console derives this from the name and lets it be edited, so the pattern is
   * tighter than "the characters we allow": it is the shape derivation actually
   * produces. `-`, `--a--` and `---` all passed the old `/^[a-z0-9-]+$/` and none of
   * them can come out of the deriver, which made a hand-typed slug expressible in ways
   * a derived one never is.
   */
  @ApiProperty({
    example: 'prudential',
    maxLength: 64,
    pattern: '^[a-z0-9]+(?:-[a-z0-9]+)*$',
    description:
      'Derived from the name by the console and editable there. Unique among companies ' +
      'that have not been deleted; a clash is refused with COMPANY_SLUG_TAKEN.',
  })
  @IsString()
  @MaxLength(64)
  @Matches(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, {
    message: 'slug must be lower-case letters and digits, separated by single hyphens',
  })
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

  /**
   * v1 is single-timezone (ADR-0016), so this accepts exactly one value.
   *
   * The field is kept rather than deleted for two reasons. `forbidNonWhitelisted` is on,
   * so removing it would turn a request that works today into a 400 for anybody still
   * sending it — including a reader copying the example out of Swagger. And the OpenAPI
   * document is where an integrator learns the constraint: `enum: ["Asia/Jakarta"]`
   * teaches that a zone exists and is fixed, where an absent field teaches nothing.
   *
   * Before this, `@IsString()` meant `{"timezone":"banana"}` returned 201 and every day
   * boundary in that office resolved to an Invalid DateTime, for ever, with nothing
   * raised at creation.
   */
  @ApiPropertyOptional({
    example: DEFAULT_TENANT_TIMEZONE,
    enum: [DEFAULT_TENANT_TIMEZONE],
    description:
      'v1 runs on a single time zone. Asia/Jakarta is the only accepted value; omit it ' +
      'and the office inherits the same value from its company (ADR-0016).',
  })
  @IsOptional()
  @IsIn([DEFAULT_TENANT_TIMEZONE], {
    message: `timezone must be ${DEFAULT_TENANT_TIMEZONE} — v1 runs on a single time zone`,
  })
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

/**
 * The office code, supplied by the platform when a request is approved.
 *
 * Not by the requester: it must be unique within the company, and nobody outside the
 * platform can know what is free. The prototype's `KPM name` column is a branch name for
 * exactly that reason.
 */
export class ApproveKpmRequestDto {
  @ApiProperty({ example: '0629', description: 'Unique within the company.' })
  @IsString()
  @Matches(/^\d{4}$/, { message: 'code must be four digits' })
  code!: string;
}

export class DeclineKpmRequestDto {
  @ApiPropertyOptional({
    example: 'This branch already trades under KPM 0417.',
    description: 'Kept, and sent back to whoever asked. A refusal with nothing to act on is not an answer.',
  })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  reason?: string;
}

/** Somebody with no office asking for one. */
export class CreateKpmRequestDto {
  @ApiProperty({ example: '65b1f0c2a4d3e5f6a7b8c9d0' })
  @IsMongoId()
  companyId!: string;

  @ApiProperty({ example: 'Surabaya Branch' })
  @IsString()
  @MaxLength(120)
  branchName!: string;

  @ApiPropertyOptional({ example: 'We have twelve agents already working this area.' })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  note?: string;
}
