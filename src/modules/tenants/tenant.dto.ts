import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import {
  IsBoolean, IsEmail, IsEnum, IsIn, IsInt, IsMongoId, IsOptional, IsString, Matches, Max,
  MaxLength, Min, MinLength,
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

  /**
   * Start this company from the platform's presets, or from nothing.
   *
   * **Default true, and absent means true** — a company created before this field existed,
   * and every caller that does not care, gets what they always got.
   */
  @ApiPropertyOptional({
    default: true,
    description:
      'True gives the company the platform\'s activity taxonomy, ratios, lead ladders, '
      + 'training tree, activation checklist, capability ladder, event types, carrier rules '
      + 'and product catalog to edit. False leaves every one of them empty, for a company '
      + 'whose presets are being authored from scratch. The role ladder is seeded either '
      + 'way: an office whose company has none is one nobody can join.',
  })
  @IsOptional()
  @IsBoolean()
  usesPlatformDefaults?: boolean;
}

/** Renaming a company. The slug is separate from the name and both are optional. */
export class UpdateCompanyDto {
  @ApiPropertyOptional({ example: 'Prudential Indonesia', minLength: 2, maxLength: 120 })
  @IsOptional()
  @IsString()
  @MinLength(2)
  @MaxLength(120)
  name?: string;

  @ApiPropertyOptional({
    example: 'prudential-id',
    maxLength: 64,
    pattern: '^[a-z0-9]+(?:-[a-z0-9]+)*$',
    description:
      'Changeable: nothing stores it. Every office points at the company by id, and the '
      + 'slug is a label. A clash is refused with COMPANY_SLUG_TAKEN.',
  })
  @IsOptional()
  @IsString()
  @MaxLength(64)
  @Matches(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, {
    message: 'slug must be lower-case letters and digits, separated by single hyphens',
  })
  slug?: string;
}

/** Suspending a company, or bringing it back. */
export class SetCompanyStatusDto {
  @ApiProperty({ enum: ['active', 'suspended'] })
  @IsIn(['active', 'suspended'])
  status!: 'active' | 'suspended';
}

/**
 * A rung on a company's ladder.
 *
 * `code` is write-once by construction: it is on the create DTO and deliberately absent
 * from the update one. Invariant 3 — a published code never changes, because it is the
 * identity every membership and every history row holds.
 */
export class CreateOrgLevelDto {
  @ApiProperty({ description: 'Company id from GET /admin/companies' })
  @IsMongoId()
  companyId!: string;

  @ApiProperty({
    example: 'AAB',
    description: 'Stable and semantic. Upper-cased on the way in, and never changed afterwards.',
    pattern: '^[A-Z][A-Z0-9_]{1,31}$',
  })
  @IsString()
  @Matches(/^[A-Za-z][A-Za-z0-9_]{1,31}$/, {
    message: 'code must be letters, digits and underscores, starting with a letter',
  })
  code!: string;

  @ApiProperty({ example: 'Associate Agency Business', minLength: 1, maxLength: 60 })
  @IsString()
  @MinLength(1)
  @MaxLength(60)
  label!: string;

  @ApiProperty({ example: 2, description: 'Junior first. Presentation only — nothing references it.' })
  @IsInt()
  @Min(1)
  @Max(99)
  displayOrder!: number;
}

/** No `code`. Renaming is what `label` is for; a different rung is a different level. */
export class UpdateOrgLevelDto {
  @ApiPropertyOptional({ example: 'Associate Agency Business', maxLength: 60 })
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(60)
  label?: string;

  @ApiPropertyOptional({ example: 2 })
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(99)
  displayOrder?: number;

  @ApiPropertyOptional({
    enum: ['active', 'archived'],
    description: 'Archiving retires a rung without deleting it. Nothing is ever deleted here.',
  })
  @IsOptional()
  @IsEnum(['active', 'archived'])
  status?: 'active' | 'archived';
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

/**
 * The roster, as text.
 *
 * Named `rows` rather than `csv` because it is not always CSV: the screen sends a
 * downloaded file's contents, or the **tab-separated** text a spreadsheet puts on the
 * clipboard when somebody copies cells. One field, because the parser decides the
 * delimiter from the first line and neither the caller nor the reader gains from saying
 * which it is.
 *
 * Sent as JSON rather than `multipart/form-data`: the payload is a few kilobytes, the
 * screen has already read it to show a preview, and multipart would mean a second parser,
 * a size limit of its own, and a different shape for preview and commit — and no shape at
 * all for a paste, which is not a file. The cap is 512 KB, which is a roster of tens of
 * thousands and far past the 500-member office ceiling `performance-and-scale.md` sets.
 */
export class RosterRowsDto {
  @ApiProperty({
    description:
      'The rows, as text. Comma-separated from a file, tab-separated from a spreadsheet '
      + 'paste. The header row is optional.',
    maxLength: 512_000,
  })
  @IsString()
  @MaxLength(512_000)
  rows!: string;
}


/**
 * The office's own identity (P4-T5, `KPM_Owner.html:1807-1812`).
 *
 * **No company and no owner.** The prototype disables both fields and labels the first
 * *"tagged by Superadmin"* — that is where the platform-owned boundary was first written
 * down, and `kpm:update_company_tag` is Super Admin's alone.
 *
 * **No locale, timezone or currency.** ADR-0016 fixes all three for v1 and no screen
 * offers them.
 */
export class UpdateBranchInfoDto {
  @ApiPropertyOptional({ example: 'BSD City Branch', minLength: 2, maxLength: 120 })
  @IsOptional()
  @IsString()
  @MinLength(2)
  @MaxLength(120)
  branchName?: string;

  @ApiPropertyOptional({ example: 'Jl. BSD Grand Boulevard No. 1, Tangerang', maxLength: 400 })
  @IsOptional()
  @IsString()
  @MaxLength(400)
  address?: string;

  @ApiPropertyOptional({ example: '+62 21 5555 0417', maxLength: 40 })
  @IsOptional()
  @IsString()
  @MaxLength(40)
  contactPhone?: string;

  @ApiPropertyOptional({
    example: 1,
    minimum: 1,
    maximum: 12,
    description: 'The month the financial year starts. Read by Phase 14, stored now.',
  })
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(12)
  fiscalYearStartMonth?: number;
}
