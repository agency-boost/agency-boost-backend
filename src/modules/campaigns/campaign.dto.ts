import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { METRIC_REGISTRY, REQUIREMENT_COMPARATORS } from '@/domain/constants';

export class RequirementDto {
  @ApiProperty({
    enum: METRIC_REGISTRY.map((m) => m.key),
    description: 'A key from the metric registry. Anything else is refused at write time, by name.',
  })
  metricKey!: string;

  @ApiProperty({ enum: REQUIREMENT_COMPARATORS })
  comparator!: string;

  @ApiProperty({
    type: Number,
    description: '**Integer IDR minor units** where the metric is money — never a float, and never '
      + 'a display string like "Rp 600 juta".',
  })
  value!: number;
}

/**
 * Declared for OpenAPI; the rules live in `campaign-input.ts` beside the data, and collect every
 * violation before refusing (ADR-0030).
 */
export class SaveCampaignDto {
  @ApiPropertyOptional({ example: 'YEAR_END_DRIVE' })
  code?: string;

  @ApiPropertyOptional()
  title?: string;

  @ApiPropertyOptional()
  description?: string;

  @ApiPropertyOptional({ format: 'date-time' })
  startsAt?: string;

  @ApiPropertyOptional({ format: 'date-time', description: 'After `startsAt`.' })
  endsAt?: string;

  @ApiPropertyOptional({ type: [RequirementDto] })
  requirements?: RequirementDto[];

  @ApiPropertyOptional({ description: 'What qualifying wins. Text: a reward is a promise.' })
  reward?: string;
}
