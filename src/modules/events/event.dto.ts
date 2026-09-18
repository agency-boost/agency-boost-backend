import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { EVENT_AUDIENCE_SCOPES, EVENT_ISSUERS } from '@/domain/constants';

/**
 * Declared for OpenAPI; the rules live in `event-input.ts` beside the data they describe, and
 * collect every violation before refusing (ADR-0030).
 */
export class SaveEventTypeDto {
  @ApiPropertyOptional({ example: 'TRAINING' })
  code?: string;

  @ApiPropertyOptional({ example: 'Training' })
  label?: string;

  @ApiPropertyOptional({ nullable: true })
  description?: string | null;

  @ApiPropertyOptional({ example: '📚', description: 'The poster is an emoji on a colour.' })
  emoji?: string | null;

  @ApiPropertyOptional({ example: '#2D9CDB' })
  color?: string | null;
}

export class EventAudienceDto {
  @ApiProperty({ enum: EVENT_ISSUERS })
  issuer!: string;

  @ApiProperty({
    enum: EVENT_AUDIENCE_SCOPES,
    description:
      '`leaders` is the **graph’s** definition — somebody with at least one active direct report '
      + '— never the role enum.',
  })
  scope!: string;

  @ApiPropertyOptional({
    type: [String],
    description: 'Membership ids, for a `select` scope only. Any other scope takes no list.',
  })
  inviteeMembershipIds?: string[];
}

export class SaveEventDto {
  @ApiPropertyOptional({ example: 'KICKOFF_2026' })
  code?: string;

  @ApiPropertyOptional({ example: 'TRAINING' })
  typeCode?: string;

  @ApiPropertyOptional()
  title?: string;

  @ApiPropertyOptional()
  blurb?: string;

  @ApiPropertyOptional()
  description?: string;

  @ApiPropertyOptional({ format: 'date-time', description: 'Stored UTC.' })
  startsAt?: string;

  @ApiPropertyOptional({
    format: 'date-time',
    description: 'Required on create, and after `startsAt`.',
  })
  endsAt?: string;

  @ApiPropertyOptional()
  location?: string;

  @ApiPropertyOptional({ nullable: true })
  locationUrl?: string | null;

  @ApiPropertyOptional({ type: EventAudienceDto })
  audience?: EventAudienceDto;
}
