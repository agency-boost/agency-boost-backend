import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsArray, IsOptional, IsString, MaxLength } from 'class-validator';
import { ILLUSTRATION, INTAKE } from '@/domain/constants';

/** `POST /product-data/intakes/:intakeId/items/:itemId/answers`: one question card answered. */
export class AnswerIntakeQuestionDto {
  @ApiProperty({ type: String, description: 'The question’s `id`, as the card names it.' })
  @IsString() @MaxLength(40)
  questionId!: string;

  @ApiProperty({
    type: String,
    description: 'One of the question’s `choices[].value`; for `date` a day `YYYY-MM-DD`; for `type_number` the number '
      + 'exactly as the file shows it (`0,123`, `1.250.000`); for `text` a short text.',
  })
  @IsString() @MaxLength(INTAKE.ANSWER_MAX_LENGTH)
  answer!: string;
}

/** `POST /product-data/companies/:companyId/products/:productId/illustrations`: the PDF (`file`), its date and plan. */
export class UploadIllustrationDto {
  @ApiProperty({ type: String, example: '2026-11-01', description: 'The illustration’s own date, today or earlier.' })
  @IsString() @MaxLength(10)
  illustrationDate!: string;

  @ApiPropertyOptional({ type: String, nullable: true, description: 'The plan it illustrates, when it is one plan’s.' })
  @IsOptional() @IsString() @MaxLength(ILLUSTRATION.PLAN_MAX_LENGTH)
  plan?: string | null;
}

/**
 * `PATCH /product-data/companies/:companyId/illustrations/:illustrationId`: the blocks as edited. Each `{ block, rows }`,
 * a kind once; each row `{ id, label, note, formula, text }` — `id` the row it was (its evidence kept) or `null` for a
 * new one. Checked whole by the service: `400 VALIDATION_FAILED` naming the first field that breaks a rule.
 */
export class UpdateIllustrationDto {
  @ApiProperty({ type: 'array', items: { type: 'object' } })
  @IsArray()
  blocks!: unknown[];
}
