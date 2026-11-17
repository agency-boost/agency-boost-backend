import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  Allow, ArrayMaxSize, ArrayMinSize, IsArray, IsBoolean, IsIn, IsInt, IsObject, IsOptional, IsString, Max, MaxLength, Min,
  ValidateNested,
} from 'class-validator';
import {
  LEAD_GENDERS, PRODUCT_DATA, PROPOSAL_PAY_FREQUENCIES, RATE_COLUMN_ROLES, type ProposalPayFrequency,
} from '@/domain/constants';

/**
 * **The Proposal tab's request shapes** (P19.15-T1, T4 AC-1; ADR-0258; `functional/proposal.md`, *Proposal data per
 * insurer*). The pipe checks the shape; the services check the rest against what is stored — a rule against the
 * catalogue's own rules (`checkProposalSettings`), a column against the file kept with the draft.
 */

/** `GET …/rate-tables/template`. */
export class RateTableTemplateQueryDto {
  @ApiPropertyOptional({ enum: ['xlsx', 'csv'], default: 'xlsx', description: 'Excel, with its *Ketentuan* sheet; or the CSV header only.' })
  @IsOptional()
  @IsIn(['xlsx', 'csv'])
  format?: 'xlsx' | 'csv';
}

/** The form fields beside the file in `POST …/rate-tables` (multipart). */
export class UploadRateTableDto {
  @ApiProperty({ type: String, example: '2026-12-01', description: '*Berlaku mulai*, `YYYY-MM-DD`: in force from 00:00 Asia/Jakarta.' })
  @IsOptional()
  @IsString()
  @MaxLength(10)
  effectiveFrom?: string;

  @ApiPropertyOptional({ type: String, example: '2027-11-30', description: '*Berlaku sampai*, `YYYY-MM-DD`, the last day; empty for open-ended.' })
  @IsOptional()
  @IsString()
  @MaxLength(10)
  effectiveTo?: string;
}

/** `PATCH …/rate-tables/:rateTableId`: a draft's columns, dates, rules or factors. */
export class UpdateRateTableDto {
  @ApiPropertyOptional({
    type: 'object', additionalProperties: { type: 'string', enum: [...RATE_COLUMN_ROLES] },
    description: '*Cocokkan kolom*: each column of the file → what it means. Confirms the columns; the rows are read again.',
  })
  @IsOptional()
  @IsObject()
  columnMap?: Record<string, string>;

  @ApiPropertyOptional({ type: String, example: '2026-12-01' })
  @IsOptional()
  @IsString()
  @MaxLength(10)
  effectiveFrom?: string;

  @ApiPropertyOptional({ type: String, nullable: true, example: '2027-11-30' })
  @IsOptional()
  @Allow()
  effectiveTo?: string | null;

  @ApiPropertyOptional({
    type: 'object', additionalProperties: true,
    description: 'The version\'s rules: `upStep`, `upMin`, `upMax`, `premiumMin`, `premiumMax` (minor units; premium per year), '
      + '`entryAgeMin`, `entryAgeMax`, `payTermMaxAge` (`{ [payTermKey]: age }`), each `null` for none. Saving confirms them.',
  })
  @IsOptional()
  @IsObject()
  rules?: Record<string, unknown>;

  @ApiPropertyOptional({
    type: 'object', additionalProperties: true, description: '*Cara bayar* factors against the annual premium: `monthly`, `quarterly`, `semiannual`, `annual`, each a decimal above 0 and at most 1.5, or `null`.',
  })
  @IsOptional()
  @IsObject()
  frequencies?: Record<string, unknown>;
}

/** One of *Uji 3 contoh*'s profiles. */
export class RateTestCaseDto {
  @ApiProperty({ type: Number, minimum: 0, maximum: 120 }) @IsInt() @Min(0) @Max(120) age!: number;
  @ApiProperty({ enum: LEAD_GENDERS }) @IsIn(LEAD_GENDERS as unknown as string[]) gender!: 'male' | 'female';
  @ApiPropertyOptional({ type: Boolean, nullable: true }) @IsOptional() @IsBoolean() smoker?: boolean | null;
  @ApiPropertyOptional({ type: String, nullable: true, maxLength: 60 }) @IsOptional() @IsString() @MaxLength(60) plan?: string | null;
  @ApiPropertyOptional({ type: String, nullable: true, maxLength: 40 }) @IsOptional() @IsString() @MaxLength(40) payTerm?: string | null;
  @ApiProperty({ enum: PROPOSAL_PAY_FREQUENCIES }) @IsIn(PROPOSAL_PAY_FREQUENCIES as unknown as string[]) payFrequency!: ProposalPayFrequency;
  @ApiProperty({ type: Number, description: 'The UP, the goal or the premium typed, minor units — what the product calculates from.' })
  @IsInt() @Min(0) amountMinor!: number;
  @ApiProperty({ type: Number, description: 'The premium the official illustration prints (the benefit, for `premium_benefit`), minor units.' })
  @IsInt() @Min(0) expectedMinor!: number;
}

/** `PUT …/rate-tables/:rateTableId/tests`: exactly three. */
export class RateTestsDto {
  @ApiProperty({ type: [RateTestCaseDto], minItems: PRODUCT_DATA.TEST_PROFILES, maxItems: PRODUCT_DATA.TEST_PROFILES })
  @IsArray()
  @ArrayMinSize(PRODUCT_DATA.TEST_PROFILES)
  @ArrayMaxSize(PRODUCT_DATA.TEST_PROFILES)
  @ValidateNested({ each: true })
  @Type(() => RateTestCaseDto)
  cases!: RateTestCaseDto[];
}

/** `POST …/rate-tables/:rateTableId/activate`. */
export class ActivateRateTableDto {
  @ApiPropertyOptional({
    type: String, nullable: true, maxLength: PRODUCT_DATA.OVERRIDE_REASON_MAX,
    description: 'Required when the three profiles do not all match within Rp1 (*"Ilustrasi pakai tarif lama"*).',
  })
  @IsOptional()
  @IsString()
  @MaxLength(PRODUCT_DATA.OVERRIDE_REASON_MAX)
  overrideReason?: string | null;
}

/**
 * `PATCH …/products/:productId/rules`: *Isian*. Each key read whole by the catalogue's own rules
 * (`checkProposalSettings`), which refuse the first broken one with its path.
 */
export class ProductRulesDto {
  @ApiProperty({ type: Number, minimum: 1, description: 'The product\'s `version` as read; a stale one is `409 VERSION_CONFLICT`.' })
  @IsInt()
  @Min(1)
  expectedVersion!: number;

  @ApiPropertyOptional({ description: 'The fields, in order (ADR-0225 §1).' }) @Allow() proposalFields?: unknown;
  @ApiPropertyOptional({ description: '*Lihat semua plan*\'s cards.' }) @Allow() planOptions?: unknown;
  @ApiPropertyOptional({ type: String, nullable: true }) @Allow() syariahName?: unknown;
  @ApiPropertyOptional({ type: String, nullable: true }) @Allow() defaultInsured?: unknown;
  @ApiPropertyOptional({ type: String, nullable: true }) @Allow() proposalTypeLabel?: unknown;
  @ApiPropertyOptional({ type: [String], description: '*Mata uang*: `IDR`, `USD` or both.' }) @Allow() currencies?: unknown;
  @ApiPropertyOptional({ enum: ['up_premium', 'goal', 'premium_benefit', 'plan_priced', 'manual'] }) @Allow() calcType?: unknown;
  @ApiPropertyOptional({ nullable: true, description: '`{ min, max }`, *Usia masuk*.' }) @Allow() entryAge?: unknown;
  @ApiPropertyOptional({ description: '*Masa bayar*, each with its maximum entry age.' }) @Allow() payTerms?: unknown;
  @ApiPropertyOptional({ description: '*Cara bayar* allowed.' }) @Allow() frequencies?: unknown;
  @ApiPropertyOptional({ type: Boolean, description: '*Merokok berpengaruh?*' }) @Allow() smokerRated?: unknown;
  @ApiPropertyOptional({ nullable: true, description: '*Aturan plan otomatis*.' }) @Allow() planRule?: unknown;
  @ApiPropertyOptional({ type: Number, nullable: true }) @Allow() upStep?: unknown;
  @ApiPropertyOptional({ type: Number, nullable: true }) @Allow() upMin?: unknown;
  @ApiPropertyOptional({ type: Number, nullable: true }) @Allow() upMax?: unknown;
  @ApiPropertyOptional({ type: Number, nullable: true, description: 'Per year.' }) @Allow() premiumMin?: unknown;
  @ApiPropertyOptional({ type: Number, nullable: true, description: 'Per year.' }) @Allow() premiumMax?: unknown;
  @ApiPropertyOptional({ type: String, nullable: true, description: '*Kebutuhan*.' }) @Allow() needTag?: unknown;
}

/** `POST …/products/:productId/try`: *Uji coba*. */
export class TryProductDto {
  @ApiProperty({ type: Number, minimum: 1, maximum: 100, description: 'The client\'s age at the next birthday.' })
  @IsInt() @Min(1) @Max(100) age!: number;

  @ApiProperty({ enum: LEAD_GENDERS }) @IsIn(LEAD_GENDERS as unknown as string[]) gender!: 'male' | 'female';

  @ApiPropertyOptional({ type: String, nullable: true, description: 'Try this version (a draft too); else the one in force.' })
  @IsOptional() @IsString() @MaxLength(64) rateTableId?: string | null;

  @ApiPropertyOptional({ type: String, nullable: true, example: '2026-12-01', description: 'The day whose version is in force; today by default.' })
  @IsOptional() @IsString() @MaxLength(10) onDate?: string | null;

  @ApiPropertyOptional({ description: 'The card as the last answer left it: `fieldValues`, `smoker`, `payTerm`, `payFrequency`, `up`, `premium`, `fixedField`.' })
  @IsOptional() @IsObject() state?: Record<string, unknown> | null;

  @ApiPropertyOptional({ description: 'The change, as the item\'s `PATCH` takes it.' })
  @IsOptional() @IsObject() patch?: Record<string, unknown> | null;
}
