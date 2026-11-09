import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  ArrayMaxSize, ArrayMinSize, IsArray, IsOptional, IsString, Matches, MaxLength, MinLength,
  ValidateNested,
} from 'class-validator';
import { Type } from 'class-transformer';
import { CODE_PATTERN } from '@/common/validation/fields';
import { VALIDATION_REFUSALS } from '@/common/validation/validation.messages';
import { field } from '@/common/validation/violations';
import { ACTIVATION_BOUNDS } from './activation-input';

/** `code: A code is 3–40 characters…` — the shared sentence, naming the field, in both languages (P18.10-T5 AC-3). */
const CODE_FIELD_MESSAGE = field(VALIDATION_REFUSALS.VALIDATION_FAILED.fieldCodeShape({ field: 'code' }));

/**
 * The bounds are the checker's (ADR-0030) — these decorators exist for the pipe's whitelist and for
 * OpenAPI, and read their numbers from the same module, so the two cannot drift.
 */
export class ActivationItemDraftDto {
  @ApiProperty({ example: 'GOAL_SETTING', description: 'Permanent. A hire\'s progress names it.' })
  @Matches(CODE_PATTERN, { message: CODE_FIELD_MESSAGE })
  code!: string;

  @ApiProperty({ example: 'Goal setting: APE & activity targets' })
  @IsString()
  @MinLength(ACTIVATION_BOUNDS.itemLabel.min)
  @MaxLength(ACTIVATION_BOUNDS.itemLabel.max)
  label!: string;

  @ApiPropertyOptional({
    type: String,
    nullable: true,
    example: 'feature:goals',
    description:
      'What completes it on its own: `feature:goals`, `feature:leads`, `feature:activity`, '
      + '`training:<module code>`, or `null` for an item a leader ticks.',
  })
  @IsOptional()
  @IsString()
  autoLink?: string | null;
}

export class ActivationAspectDraftDto {
  @ApiProperty({ example: 'INITIAL_SETUP' })
  @Matches(CODE_PATTERN, { message: CODE_FIELD_MESSAGE })
  code!: string;

  @ApiProperty({ example: '2. Initial Setup' })
  @IsString()
  @MinLength(ACTIVATION_BOUNDS.aspectLabel.min)
  @MaxLength(ACTIVATION_BOUNDS.aspectLabel.max)
  label!: string;

  @ApiProperty({ type: [ActivationItemDraftDto] })
  @IsArray()
  @ArrayMinSize(ACTIVATION_BOUNDS.items.min)
  @ArrayMaxSize(ACTIVATION_BOUNDS.items.max)
  @ValidateNested({ each: true })
  @Type(() => ActivationItemDraftDto)
  items!: ActivationItemDraftDto[];
}

/**
 * The whole checklist, not a patch.
 *
 * A checklist is one document with an ordered shape, and its order is the order of these lists:
 * `displayOrder` is taken from position, which is what makes a reorder an ordinary save.
 */
export class SaveActivationChecklistDto {
  @ApiProperty({ type: [ActivationAspectDraftDto] })
  @IsArray()
  @ArrayMinSize(ACTIVATION_BOUNDS.aspects.min)
  @ArrayMaxSize(ACTIVATION_BOUNDS.aspects.max)
  @ValidateNested({ each: true })
  @Type(() => ActivationAspectDraftDto)
  aspects!: ActivationAspectDraftDto[];
}
