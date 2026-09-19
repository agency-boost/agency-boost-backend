import { Allow } from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { METRIC_REGISTRY, REQUIREMENT_COMPARATORS } from '@/domain/constants';

export class RequirementDto {
  @ApiProperty({
    enum: METRIC_REGISTRY.map((m) => m.key),
    description: 'A key from the metric registry. Anything else is refused at write time, by name.',
  })
  @Allow()
  metricKey!: string;

  @ApiProperty({ enum: REQUIREMENT_COMPARATORS })
  @Allow()
  comparator!: string;

  @ApiProperty({
    type: Number,
    description: '**Integer IDR minor units** where the metric is money — never a float, and never '
      + 'a display string like "Rp 600 juta".',
  })
  @Allow()
  value!: number;
}

/**
 * Declared for OpenAPI; the rules live in `campaign-input.ts` beside the data, and collect every
 * violation before refusing (ADR-0030).
 *
 * **`@Allow()` on every property, and it is load-bearing.**
 *
 * The global pipe runs `whitelist: true, forbidNonWhitelisted: true` (`bootstrap.ts`), and
 * class-validator's whitelist keeps only properties carrying at least one of its decorators.
 * `@ApiProperty` is Swagger's, not class-validator's — so a class documented for OpenAPI and
 * validated elsewhere was stripped whole, and every request to these routes came back
 * *"property code should not exist"* for every field it sent. Creating an event or a campaign
 * over HTTP could not succeed at all.
 *
 * `@Allow()` registers the property with the whitelist and asserts nothing about it, which is
 * exactly the intent here: the rules stay in `*-input.ts` beside the data, collecting every
 * violation before refusing (ADR-0030). Real validators here would be a second, thinner copy of
 * them — which is the duplication ADR-0030 exists to prevent.
 */
export class SaveCampaignDto {
  @ApiPropertyOptional({ example: 'YEAR_END_DRIVE' })
  @Allow()
  code?: string;

  @ApiPropertyOptional()
  @Allow()
  title?: string;

  @ApiPropertyOptional()
  @Allow()
  description?: string;

  @ApiPropertyOptional({ format: 'date-time' })
  @Allow()
  startsAt?: string;

  @ApiPropertyOptional({ format: 'date-time', description: 'After `startsAt`.' })
  @Allow()
  endsAt?: string;

  @ApiPropertyOptional({ type: [RequirementDto] })
  @Allow()
  requirements?: RequirementDto[];

  @ApiPropertyOptional({ description: 'What qualifying wins. Text: a reward is a promise.' })
  @Allow()
  reward?: string;
}
