import { Allow } from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  CAMPAIGN_KINDS, CAMPAIGN_LIMITS, CAMPAIGN_METRICS, CAMPAIGN_POSTER_COLORS, CAMPAIGN_SUBTYPES, CAMPAIGN_WINDOWS,
  REQUIREMENT_COMPARATORS,
} from '@/domain/constants';

export class RequirementDto {
  @ApiProperty({
    enum: CAMPAIGN_METRICS.map((m) => m.key),
    description: 'A key a campaign may name — `campaign: true` in `GET /metrics`. Anything '
      + 'else is refused at write time, by name.',
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

  @ApiPropertyOptional({
    format: 'date-time', nullable: true,
    description: 'After `startsAt`. Required for a seasonal campaign; `null` for a structural one with no end. Where a '
      + 'requirement reads the monthly file, the dates are whole office months: from 00:00 on a 1st to 23:59 on a '
      + 'month\'s last day, Asia/Jakarta.',
  })
  @Allow()
  endsAt?: string | null;

  @ApiPropertyOptional({ enum: CAMPAIGN_KINDS, description: 'Seasonal (default) or structural.' })
  @Allow()
  kind?: string;

  @ApiPropertyOptional({ enum: CAMPAIGN_SUBTYPES, nullable: true, description: 'A structural campaign\'s section.' })
  @Allow()
  subtype?: string | null;

  @ApiPropertyOptional({
    enum: CAMPAIGN_WINDOWS,
    description: 'Seasonal: `campaign_dates`. Structural: `calendar_year` or `rolling_12m` (D-windows).',
  })
  @Allow()
  window?: string;

  @ApiPropertyOptional({ type: [String], description: 'The rungs that may chase it, by code. Empty means everybody.' })
  @Allow()
  appliesToOrgLevelCodes?: string[];

  @ApiPropertyOptional({
    description: `The card's poster: \`{ emoji, color }\`, the colour one of ${CAMPAIGN_POSTER_COLORS.join(', ')}.`,
    example: { emoji: '🚀', color: 'amber' },
  })
  @Allow()
  poster?: { emoji: string; color: string };

  @ApiPropertyOptional({ maxLength: CAMPAIGN_LIMITS.BLURB_MAX, description: 'The card\'s one line. Plain text.' })
  @Allow()
  blurb?: string;

  @ApiPropertyOptional({ type: [RequirementDto] })
  @Allow()
  requirements?: RequirementDto[];

  @ApiPropertyOptional({ description: 'What qualifying wins. Text: a reward is a promise.' })
  @Allow()
  reward?: string;
}

/**
 * `PUT /kpm/settings/campaigns/:code/standings/:membershipId/override` (P18.3-T2 AC-5, D-override). Declared for
 * OpenAPI; the rules are `checkStandingOverride`'s (ADR-0030), so every property carries `@Allow()` — see
 * `SaveCampaignDto`.
 */
export class OverrideStandingDto {
  @ApiProperty({ enum: ['qualified', 'not_met'], description: '*Achieved* or *Not achieved*. Not the status it already reads.' })
  @Allow()
  status!: string;

  @ApiProperty({ minLength: 1, maxLength: 500, description: 'Why the result is corrected. Required; trimmed, 1–500 characters. Plain text.' })
  @Allow()
  reason!: string;
}

/** `DELETE /kpm/settings/campaigns/:code/standings/:membershipId/override`: clearing needs a reason too. */
export class ClearStandingOverrideDto {
  @ApiProperty({ minLength: 1, maxLength: 500, description: 'Why the override is cleared. Required; trimmed, 1–500 characters.' })
  @Allow()
  reason!: string;
}
