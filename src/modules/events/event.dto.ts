import { Allow } from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { EVENT_AUDIENCE_SCOPES, EVENT_ISSUERS } from '@/domain/constants';

/**
 * Declared for OpenAPI; the rules live in `event-input.ts` beside the data they describe, and
 * collect every violation before refusing (ADR-0030).
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
export class SaveEventTypeDto {
  @ApiPropertyOptional({ example: 'TRAINING' })
  @Allow()
  code?: string;

  @ApiPropertyOptional({ example: 'Training' })
  @Allow()
  label?: string;

  @ApiPropertyOptional({ nullable: true })
  @Allow()
  description?: string | null;

  @ApiPropertyOptional({ example: '📚', description: 'The poster is an emoji on a colour.' })
  @Allow()
  emoji?: string | null;

  @ApiPropertyOptional({ example: '#2D9CDB' })
  @Allow()
  color?: string | null;
}

export class EventAudienceDto {
  @ApiProperty({ enum: EVENT_ISSUERS })
  @Allow()
  issuer!: string;

  @ApiProperty({
    enum: EVENT_AUDIENCE_SCOPES,
    description:
      '`leaders` is the **graph’s** definition — somebody with at least one active direct report '
      + '— never the role enum.',
  })
  @Allow()
  scope!: string;

  @ApiPropertyOptional({
    type: [String],
    description: 'Membership ids, for a `select` scope only. Any other scope takes no list.',
  })
  @Allow()
  inviteeMembershipIds?: string[];
}

export class SaveEventDto {
  @ApiPropertyOptional({ example: 'KICKOFF_2026' })
  @Allow()
  code?: string;

  @ApiPropertyOptional({ example: 'TRAINING' })
  @Allow()
  typeCode?: string;

  @ApiPropertyOptional()
  @Allow()
  title?: string;

  @ApiPropertyOptional()
  @Allow()
  blurb?: string;

  @ApiPropertyOptional()
  @Allow()
  description?: string;

  @ApiPropertyOptional({ format: 'date-time', description: 'Stored UTC.' })
  @Allow()
  startsAt?: string;

  @ApiPropertyOptional({
    format: 'date-time',
    description: 'Required on create, and after `startsAt`.',
  })
  @Allow()
  endsAt?: string;

  @ApiPropertyOptional()
  @Allow()
  location?: string;

  @ApiPropertyOptional({ nullable: true })
  @Allow()
  locationUrl?: string | null;

  @ApiPropertyOptional({ type: EventAudienceDto })
  @Allow()
  audience?: EventAudienceDto;
}
