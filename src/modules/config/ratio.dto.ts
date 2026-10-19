import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import {
  ArrayMaxSize, ArrayMinSize, IsArray, IsIn, IsNumber, IsOptional, IsString, Matches, Max,
  MaxLength, Min, MinLength,
} from 'class-validator';
import { RATIO_DISPLAY_UNITS, type RatioDisplayUnit } from '@/domain/constants';
import { RATIO_COMPARISONS, type RatioComparison } from './ratio-definition.schema';

import { CODE_MESSAGE, CODE_PATTERN, CONFIG_BOUNDS } from './config-input';

const { ratioLabel, formulaTerms, rungs } = CONFIG_BOUNDS;
const trim = Transform(({ value }: { value: unknown }) =>
  (typeof value === 'string' ? value.trim() : value));

/** A benchmark's range — why it is 0–1000 is written beside the number, in `config-input.ts`. */
const BENCHMARK = CONFIG_BOUNDS.benchmark;

export class CreateRatioDto {
  @ApiProperty({ example: 'SELLING_SUCCESS_RATE' })
  @IsString()
  @Matches(CODE_PATTERN, { message: CODE_MESSAGE })
  @trim
  code!: string;

  @ApiProperty({ example: 'Selling success rate', minLength: ratioLabel.min, maxLength: ratioLabel.max })
  @IsString()
  @MinLength(ratioLabel.min)
  @MaxLength(ratioLabel.max)
  @trim
  label!: string;

  @ApiProperty({
    type: [String],
    example: ['SELL_SUBMISSION'],
    description: 'Activity type codes, summed. Codes — never the prototype\'s item numbers.',
  })
  @IsArray()
  @ArrayMinSize(formulaTerms.min)
  @ArrayMaxSize(formulaTerms.max)
  @IsString({ each: true })
  numerator!: string[];

  @ApiProperty({ type: [String], example: ['SELL_PRESENTATION', 'SELL_FOLLOWUP'] })
  @IsArray()
  @ArrayMinSize(formulaTerms.min)
  @ArrayMaxSize(formulaTerms.max)
  @IsString({ each: true })
  denominator!: string[];

  @ApiProperty({ example: 0.15, minimum: BENCHMARK.min, maximum: BENCHMARK.max })
  @IsNumber()
  @Min(BENCHMARK.min)
  @Max(BENCHMARK.max)
  benchmark!: number;

  @ApiProperty({
    enum: RATIO_COMPARISONS,
    description:
      '`gte` is at or above the benchmark. `band` is the balance rule, '
      + '`abs(sellingPct − 50) × 2 ≤ benchmark` — a different shape, which is why this is '
      + 'a named rule rather than an operator.',
  })
  @IsIn(RATIO_COMPARISONS as unknown as string[])
  comparison!: RatioComparison;

  @ApiPropertyOptional({
    enum: RATIO_DISPLAY_UNITS,
    description:
      'How the benchmark is written: `percent` (0.15 as 15.0%), `decimal` (0.30 as 0.30) or '
      + '`points` (30 as ±30 points). A `band` ratio is always `points` and a `gte` ratio '
      + 'never is; omitted, a `gte` ratio keeps what it had, or starts as `decimal`.',
  })
  @IsOptional()
  @IsIn(RATIO_DISPLAY_UNITS as unknown as string[])
  displayUnit?: RatioDisplayUnit;

  @ApiPropertyOptional({
    type: [String],
    example: ['AB', 'AAB'],
    description:
      'Ladder rung codes this ratio applies to. **Empty means every rung.** A member whose '
      + 'rung is absent does not see the ratio at all \u2014 hidden, never shown as failed.',
  })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(rungs.max)
  @IsString({ each: true })
  appliesToOrgLevelCodes?: string[];
}

/**
 * No `code`. Everything computed from this ratio holds it.
 *
 * `numerator` and `denominator` are accepted here and refused by the service on a
 * `platform` ratio (ADR-0021). Deliberately not split into two DTOs: the shape of the
 * request does not depend on which row it addresses, and two DTOs would put the rule in
 * the routing table where a reader of the service cannot see it.
 */
export class UpdateRatioDto {
  @ApiPropertyOptional({ minLength: ratioLabel.min, maxLength: ratioLabel.max })
  @IsOptional()
  @IsString()
  @MinLength(ratioLabel.min)
  @MaxLength(ratioLabel.max)
  @trim
  label?: string;

  @ApiPropertyOptional({ type: [String] })
  @IsOptional()
  @IsArray()
  @ArrayMinSize(formulaTerms.min)
  @ArrayMaxSize(formulaTerms.max)
  @IsString({ each: true })
  numerator?: string[];

  @ApiPropertyOptional({ type: [String] })
  @IsOptional()
  @IsArray()
  @ArrayMinSize(formulaTerms.min)
  @ArrayMaxSize(formulaTerms.max)
  @IsString({ each: true })
  denominator?: string[];

  @ApiPropertyOptional({ example: 0.2, minimum: BENCHMARK.min, maximum: BENCHMARK.max })
  @IsOptional()
  @IsNumber()
  @Min(BENCHMARK.min)
  @Max(BENCHMARK.max)
  benchmark?: number;

  @ApiPropertyOptional({ enum: RATIO_COMPARISONS })
  @IsOptional()
  @IsIn(RATIO_COMPARISONS as unknown as string[])
  comparison?: RatioComparison;

  @ApiPropertyOptional({
    enum: RATIO_DISPLAY_UNITS,
    description:
      'How the benchmark is written: `percent` (0.15 as 15.0%), `decimal` (0.30 as 0.30) or '
      + '`points` (30 as ±30 points). A `band` ratio is always `points` and a `gte` ratio '
      + 'never is; omitted, a `gte` ratio keeps what it had, or starts as `decimal`.',
  })
  @IsOptional()
  @IsIn(RATIO_DISPLAY_UNITS as unknown as string[])
  displayUnit?: RatioDisplayUnit;

  @ApiPropertyOptional({
    type: [String],
    example: ['AB', 'AAB'],
    description:
      'Ladder rung codes this ratio applies to. **Empty means every rung.** A member whose '
      + 'rung is absent does not see the ratio at all \u2014 hidden, never shown as failed.',
  })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(rungs.max)
  @IsString({ each: true })
  appliesToOrgLevelCodes?: string[];
}
