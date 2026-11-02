import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  ArrayNotEmpty, IsArray, IsBoolean, IsIn, IsInt, IsNumber, IsOptional, IsString, Matches, Max,
  MaxLength, Min, ValidateNested,
} from 'class-validator';
import {
  PRODUCT_AGE_BANDS, PRODUCT_BUDGET_BANDS, PRODUCT_CATEGORIES, PRODUCT_CHANNELS, PRODUCT_NEEDS,
  PRODUCT_TAGLINE_MAX_LENGTH,
} from '@/domain/constants';
import { field } from '@/common/validation/violations';
import { PRODUCTS_REFUSALS } from './products.messages';

const AGE_BAND_MAX = PRODUCT_AGE_BANDS.length;
const BUDGET_BAND_MAX = PRODUCT_BUDGET_BANDS.length;

export class AttackPlanDto {
  @ApiProperty({ description: '0 · Good fit for', example: 'Young families with a first mortgage' })
  @IsString() @MaxLength(400)
  goodFit!: string;

  @ApiProperty({ description: '1 · Opening line' })
  @IsString() @MaxLength(1000)
  opening!: string;

  @ApiProperty({ type: [String], description: '2 · Lead with these benefits' })
  @IsArray() @IsString({ each: true }) @MaxLength(400, { each: true })
  benefits!: string[];

  @ApiProperty({ description: '3 · Full script' })
  @IsString() @MaxLength(4000)
  fullScript!: string;

  @ApiProperty({ description: '4a · If they push back — they say' })
  @IsString() @MaxLength(1000)
  objectionTheySay!: string;

  @ApiProperty({ description: '4b · If they push back — you say' })
  @IsString() @MaxLength(1000)
  objectionYouSay!: string;

  @ApiProperty({ description: '5 · Next action' })
  @IsString() @MaxLength(1000)
  nextAction!: string;
}

export class CommissionYearDto {
  @ApiProperty({ example: 1, minimum: 1, maximum: 50, description: 'Policy year, from 1; at most 50 years.' })
  @IsInt() @Min(1) @Max(50)
  year!: number;

  @ApiProperty({
    example: 0.4,
    description: 'A proportion, not a percentage: `0.4` is 40%. The company states it; nothing here invents one (parity F-15).',
  })
  @IsNumber() @Min(0) @Max(1)
  rate!: number;
}

/** Everything a product carries except its identity and its lifecycle. */
export class ProductFieldsDto {
  @ApiPropertyOptional({ example: 'PRUMapan' })
  @IsOptional() @IsString() @MaxLength(200)
  name?: string;

  @ApiPropertyOptional({ example: 'Proteksi jiwa dengan premi tetap' })
  @IsOptional() @IsString() @MaxLength(PRODUCT_TAGLINE_MAX_LENGTH)
  tagline?: string;

  @ApiPropertyOptional({ enum: PRODUCT_CHANNELS })
  @IsOptional() @IsIn(PRODUCT_CHANNELS as unknown as string[])
  channel?: string;

  @ApiPropertyOptional({ enum: PRODUCT_CATEGORIES })
  @IsOptional() @IsIn(PRODUCT_CATEGORIES as unknown as string[])
  category?: string;

  @ApiPropertyOptional({
    enum: PRODUCT_NEEDS,
    isArray: true,
    description: '`accident` is a need, not a category — accident products sit under `health`.',
  })
  @IsOptional() @IsArray() @IsIn(PRODUCT_NEEDS as unknown as string[], { each: true })
  primaryNeeds?: string[];

  @ApiPropertyOptional({ type: [Number], description: `Band numbers, 1–${AGE_BAND_MAX}.` })
  @IsOptional() @IsArray() @IsInt({ each: true })
  @Min(1, { each: true }) @Max(AGE_BAND_MAX, { each: true })
  eligibleAgeBands?: number[];

  @ApiPropertyOptional({
    type: [Number],
    description: `Band numbers, 1–${BUDGET_BAND_MAX}. The seven-band scale of the prototype's `
      + '`Overall.html` copy, which the ERD records; `Sales_Attack_Plan.html` scores the same '
      + 'products on five.',
  })
  @IsOptional() @IsArray() @IsInt({ each: true })
  @Min(1, { each: true }) @Max(BUDGET_BAND_MAX, { each: true })
  eligibleBudgetBands?: number[];

  @ApiPropertyOptional({ type: [String] })
  @IsOptional() @IsArray() @IsString({ each: true }) @MaxLength(400, { each: true })
  benefits?: string[];

  @ApiPropertyOptional()
  @IsOptional() @IsString() @MaxLength(1000)
  differentiator?: string;

  @ApiPropertyOptional()
  @IsOptional() @IsString() @MaxLength(1000)
  bestFor?: string;

  @ApiPropertyOptional({ type: AttackPlanDto })
  @IsOptional() @ValidateNested() @Type(() => AttackPlanDto)
  defaultAttackPlan?: AttackPlanDto;

  @ApiPropertyOptional({
    type: [CommissionYearDto],
    description: 'Empty until the company states one. An empty list is shown as "not set", never as a default. '
      + 'A rate per policy year from year 1, none missing and none twice (OD-135, ADR-0119); the '
      + 'whole schedule is sent, and stored in year order.',
  })
  @IsOptional() @IsArray() @ValidateNested({ each: true }) @Type(() => CommissionYearDto)
  commissionSchedule?: CommissionYearDto[];

  @ApiPropertyOptional({
    description: 'What an office sells before its Owner has an opinion about the product (ADR-0033).',
  })
  @IsOptional() @IsBoolean()
  activeByDefault?: boolean;
}

export class CreateProductDto extends ProductFieldsDto {
  /**
   * The identity, typed once. Immutable afterwards and never reused, because a policy, a lead and
   * a plan's address (`/attack-plan?product=…`) all point at it (ADR-0006).
   */
  @ApiProperty({ example: 'PRUMAPAN', description: 'Upper case, letters, digits and `_`. Immutable once created.' })
  @IsString() @MaxLength(60)
  @Matches(/^[A-Za-z][A-Za-z0-9_]*$/, {
    // The DTO's own sentence, in both languages (P18.98-T5 AC-3).
    message: field(PRODUCTS_REFUSALS.VALIDATION_FAILED.productCodeShape),
  })
  code!: string;

  @ApiProperty({ example: 'PRUMapan' })
  @IsString() @MaxLength(200)
  declare name: string;

  @ApiProperty({ enum: PRODUCT_CHANNELS })
  @IsIn(PRODUCT_CHANNELS as unknown as string[])
  declare channel: string;

  @ApiProperty({ enum: PRODUCT_CATEGORIES })
  @IsIn(PRODUCT_CATEGORIES as unknown as string[])
  declare category: string;
}

/** No `code` and no `lifecycle`: the first never changes, the second moves through its own routes. */
export class UpdateProductDto extends ProductFieldsDto {}

export class CloseToNewBusinessDto {
  @ApiPropertyOptional({
    description: 'The successor, where there is one — a product of the same company. The prototype’s `legacy` boolean could not say.',
  })
  @IsOptional() @IsString() @MaxLength(64)
  replacedByProductId?: string;
}

export class ReorderProductsDto {
  /** The whole shelf, so two people reordering at once cannot interleave into a new order. */
  @ApiProperty({ type: [String], description: 'Every product of the company, once each, in the order wanted.' })
  @IsArray() @ArrayNotEmpty() @IsString({ each: true })
  productIds!: string[];
}
