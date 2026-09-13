import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import {
  ArrayMaxSize, ArrayMinSize, IsArray, IsMongoId, IsOptional, IsString, Matches, MaxLength,
  MinLength,
} from 'class-validator';

const CODE_EXAMPLE = 'SELL_SUBMISSION';
const CODE_PATTERN = /^[A-Za-z][A-Za-z0-9_]{2,39}$/;
const CODE_MESSAGE =
  'A code is 3–40 characters of A–Z, 0–9 and underscore, starting with a letter.';

/** Trim before validating, so a pasted value with a stray space is accepted rather than refused. */
const trim = Transform(({ value }: { value: unknown }) =>
  (typeof value === 'string' ? value.trim() : value));

export class CreateActivityCategoryDto {
  @ApiProperty({ example: 'SELLING', description: 'Permanent once saved. Never reused.' })
  @IsString()
  @Matches(CODE_PATTERN, { message: CODE_MESSAGE })
  @trim
  code!: string;

  @ApiProperty({ example: 'Selling', minLength: 1, maxLength: 80 })
  @IsString()
  @MinLength(1)
  @MaxLength(80)
  @trim
  label!: string;

  @ApiPropertyOptional({ maxLength: 200, example: 'What the office sells, and to whom' })
  @IsOptional()
  @IsString()
  @MaxLength(200)
  @trim
  description?: string;

  @ApiPropertyOptional({
    type: [String],
    example: ['AB', 'AAB'],
    description:
      'The ladder rungs this section is a question for. **Empty means every rung**, and it '
      + 'cascades to every activity type inside it.',
  })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(20)
  @IsString({ each: true })
  appliesToOrgLevelCodes?: string[];
}


/** No `code`: every activity, ratio and goal points at it (ADR-0006). */
export class UpdateActivityCategoryDto {
  @ApiPropertyOptional({ example: 'Penjualan', minLength: 1, maxLength: 80 })
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(80)
  @trim
  label?: string;

  @ApiPropertyOptional({ maxLength: 200, example: 'What the office sells, and to whom' })
  @IsOptional()
  @IsString()
  @MaxLength(200)
  @trim
  description?: string;

  @ApiPropertyOptional({
    type: [String],
    example: ['AB', 'AAB'],
    description:
      'The ladder rungs this section is a question for. **Empty means every rung**, and it '
      + 'cascades to every activity type inside it.',
  })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(20)
  @IsString({ each: true })
  appliesToOrgLevelCodes?: string[];
}


export class CreateActivityTypeDto {
  @ApiProperty({ example: CODE_EXAMPLE, description: 'Permanent once saved. Never reused.' })
  @IsString()
  @Matches(CODE_PATTERN, { message: CODE_MESSAGE })
  @trim
  code!: string;

  @ApiProperty({ example: 'SELLING', description: 'An active category of this office, by code.' })
  @IsString()
  @Matches(CODE_PATTERN, { message: CODE_MESSAGE })
  @trim
  categoryCode!: string;

  @ApiProperty({ example: 'Submission polis', minLength: 1, maxLength: 200 })
  @IsString()
  @MinLength(1)
  @MaxLength(200)
  @trim
  label!: string;

  @ApiPropertyOptional({ example: 'telepon, WhatsApp, tatap muka, dll', maxLength: 200 })
  @IsOptional()
  @IsString()
  @MaxLength(200)
  @trim
  description?: string;
}

/** No `code`. A published code is the identity every log and formula holds — see the service. */
export class UpdateActivityTypeDto {
  @ApiPropertyOptional({ example: 'Submission polis', minLength: 1, maxLength: 200 })
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(200)
  @trim
  label?: string;

  @ApiPropertyOptional({ example: 'secara mandiri atau melalui BOP', maxLength: 200 })
  @IsOptional()
  @IsString()
  @MaxLength(200)
  @trim
  description?: string;

  @ApiPropertyOptional({ example: 'RECRUITMENT' })
  @IsOptional()
  @IsString()
  @Matches(CODE_PATTERN, { message: CODE_MESSAGE })
  @trim
  categoryCode?: string;
}

/**
 * Every id, once each, in the order wanted.
 *
 * A partial "move this to position 4" would leave the server inferring what happened to
 * the rest, and two people dragging at once would interleave into an order neither asked
 * for.
 */
export class ReorderActivityTypesDto {
  @ApiProperty({ type: [String], example: ['66f0…a1', '66f0…a2'] })
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(200)
  @IsMongoId({ each: true })
  ids!: string[];
}
