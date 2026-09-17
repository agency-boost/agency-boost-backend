import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import {
  ArrayMaxSize, ArrayMinSize, IsArray, IsMongoId, IsOptional, IsString, Matches, MaxLength,
  MinLength,
} from 'class-validator';

import { CODE_MESSAGE, CODE_PATTERN, CONFIG_BOUNDS } from './config-input';

const CODE_EXAMPLE = 'SELL_SUBMISSION';
const { categoryLabel, typeLabel, description, rungs } = CONFIG_BOUNDS;

/** Trim before validating, so a pasted value with a stray space is accepted rather than refused. */
const trim = Transform(({ value }: { value: unknown }) =>
  (typeof value === 'string' ? value.trim() : value));

export class CreateActivityCategoryDto {
  @ApiProperty({ example: 'SELLING', description: 'Permanent once saved. Never reused.' })
  @IsString()
  @Matches(CODE_PATTERN, { message: CODE_MESSAGE })
  @trim
  code!: string;

  @ApiProperty({ example: 'Selling', minLength: categoryLabel.min, maxLength: categoryLabel.max })
  @IsString()
  @MinLength(categoryLabel.min)
  @MaxLength(categoryLabel.max)
  @trim
  label!: string;

  @ApiPropertyOptional({ maxLength: description.max, example: 'What the office sells, and to whom' })
  @IsOptional()
  @IsString()
  @MaxLength(description.max)
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
  @ArrayMaxSize(rungs.max)
  @IsString({ each: true })
  appliesToOrgLevelCodes?: string[];
}


/** No `code`: every activity, ratio and goal points at it (ADR-0006). */
export class UpdateActivityCategoryDto {
  @ApiPropertyOptional({ example: 'Penjualan', minLength: categoryLabel.min, maxLength: categoryLabel.max })
  @IsOptional()
  @IsString()
  @MinLength(categoryLabel.min)
  @MaxLength(categoryLabel.max)
  @trim
  label?: string;

  @ApiPropertyOptional({ maxLength: description.max, example: 'What the office sells, and to whom' })
  @IsOptional()
  @IsString()
  @MaxLength(description.max)
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
  @ArrayMaxSize(rungs.max)
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

  @ApiProperty({ example: 'Submission polis', minLength: typeLabel.min, maxLength: typeLabel.max })
  @IsString()
  @MinLength(typeLabel.min)
  @MaxLength(typeLabel.max)
  @trim
  label!: string;

  @ApiPropertyOptional({ example: 'telepon, WhatsApp, tatap muka, dll', maxLength: description.max })
  @IsOptional()
  @IsString()
  @MaxLength(description.max)
  @trim
  description?: string;
}

/** No `code`. A published code is the identity every log and formula holds — see the service. */
export class UpdateActivityTypeDto {
  @ApiPropertyOptional({ example: 'Submission polis', minLength: typeLabel.min, maxLength: typeLabel.max })
  @IsOptional()
  @IsString()
  @MinLength(typeLabel.min)
  @MaxLength(typeLabel.max)
  @trim
  label?: string;

  @ApiPropertyOptional({ example: 'secara mandiri atau melalui BOP', maxLength: description.max })
  @IsOptional()
  @IsString()
  @MaxLength(description.max)
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
