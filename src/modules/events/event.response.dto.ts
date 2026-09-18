import { ApiProperty } from '@nestjs/swagger';
import { EVENT_PHASES } from '@/domain/constants';
import { EventAudienceDto } from './event.dto';

export class EventTypeDto {
  @ApiProperty({ type: String })
  id!: string;

  @ApiProperty({ type: String })
  code!: string;

  @ApiProperty({ type: String })
  label!: string;

  @ApiProperty({ type: String, nullable: true })
  description!: string | null;

  @ApiProperty({ type: String, nullable: true })
  emoji!: string | null;

  @ApiProperty({ type: String, nullable: true })
  color!: string | null;

  @ApiProperty({ type: Number })
  displayOrder!: number;

  @ApiProperty({ enum: ['active', 'archived'] })
  status!: string;

  @ApiProperty({ type: Number, description: 'How many events name it — what *Archive* affects.' })
  events!: number;
}

export class EventDto {
  @ApiProperty({ type: String })
  id!: string;

  @ApiProperty({ type: String })
  code!: string;

  @ApiProperty({ type: String })
  typeCode!: string;

  @ApiProperty({ type: String })
  title!: string;

  @ApiProperty({ type: String })
  blurb!: string;

  @ApiProperty({ type: String })
  description!: string;

  @ApiProperty({ type: String, format: 'date-time' })
  startsAt!: string;

  @ApiProperty({ type: String, format: 'date-time' })
  endsAt!: string;

  @ApiProperty({
    type: String,
    example: '2026-09-18',
    description: 'The calendar day in the **office’s** timezone, so no browser re-derives it in its own.',
  })
  startsOn!: string;

  @ApiProperty({ type: String })
  location!: string;

  @ApiProperty({ type: String, nullable: true })
  locationUrl!: string | null;

  @ApiProperty({ type: EventAudienceDto })
  audience!: EventAudienceDto;

  @ApiProperty({
    enum: EVENT_PHASES,
    description: 'Derived on every read from the instants, never stored (P5-T6 AC-3).',
  })
  phase!: string;

  @ApiProperty({ enum: ['active', 'archived'] })
  status!: string;

  @ApiProperty({ type: Number })
  version!: number;
}
