import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  ArrayMaxSize, ArrayMinSize, IsArray, IsIn, IsInt, IsObject, IsOptional, IsString,
  Min, ValidateNested,
} from 'class-validator';
import { Type } from 'class-transformer';

/**
 * Every intent the settings screens can stage.
 *
 * **Stated, never inferred.** A whole-payload PUT would have to work out what changed, and
 * the ambiguity that kills it is archive-by-omission: a code missing from the payload means
 * both *"I archived it"* and *"my client is an older build"*, and the second silently
 * archives an office's configuration. An op says which.
 */
export const CHANGE_OPS = [
  'category.create', 'category.update', 'category.archive', 'category.restore',
  'type.create', 'type.update', 'type.archive', 'type.restore',
  'ratio.create', 'ratio.update', 'ratio.archive', 'ratio.restore',
  // The training taxonomy (P5-T1): three levels, the same four intents each.
  'trainingCategory.create', 'trainingCategory.update', 'trainingCategory.archive', 'trainingCategory.restore',
  'trainingSkill.create', 'trainingSkill.update', 'trainingSkill.archive', 'trainingSkill.restore',
  'trainingModule.create', 'trainingModule.update', 'trainingModule.archive', 'trainingModule.restore',
] as const;
export type ChangeOp = (typeof CHANGE_OPS)[number];

export class ConfigChangeDto {
  @ApiProperty({ enum: CHANGE_OPS })
  @IsIn(CHANGE_OPS as unknown as string[])
  op!: ChangeOp;

  @ApiPropertyOptional({ description: 'The row this op addresses. Absent on a `create`.' })
  @IsOptional()
  @IsString()
  id?: string;

  /**
   * The `version` the screen read.
   *
   * Required on anything that changes an existing row. A row that has moved on refuses the
   * **whole batch**, naming what changed — without it, the second of two admins editing at
   * once silently erases the first, and neither of them ever finds out.
   */
  @ApiPropertyOptional({ minimum: 1 })
  @IsOptional()
  @IsInt()
  @Min(1)
  expectedVersion?: number;

  @ApiPropertyOptional({
    type: Object,
    description:
      'The op’s own fields — the same shape its single-row route takes. Validated by the '
      + 'service that applies it, not here: one rule, one place.',
  })
  @IsOptional()
  @IsObject()
  body?: Record<string, unknown>;
}

export class ApplyConfigChangesDto {
  @ApiProperty({
    type: [ConfigChangeDto],
    description:
      'Applied in order. **Validated entirely before anything is written**, so an op that '
      + 'refuses leaves the office exactly as it was — and so `type.create` can name a '
      + 'category `category.create` makes earlier in the same batch.',
  })
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(200)
  @ValidateNested({ each: true })
  @Type(() => ConfigChangeDto)
  ops!: ConfigChangeDto[];
}
