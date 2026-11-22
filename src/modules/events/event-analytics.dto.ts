import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsOptional, Matches } from 'class-validator';
import { field } from '@/common/validation/violations';
import { EVENTS_REFUSALS } from './events.messages';

/** Advanced analytics › *Event*'s one filter: a calendar month, or the year to date. */
export class EventAnalyticsQueryDto {
  @ApiPropertyOptional({ example: '2026-10', description: 'A month, `YYYY-MM`, no later than this one; the year to date without it.' })
  @IsOptional()
  @Matches(/^\d{4}-(0[1-9]|1[0-2])$/, { message: field(EVENTS_REFUSALS.VALIDATION_FAILED.monthShape) })
  month?: string;
}

// ------------------------------------------------------------------------------------------------ shared shapes

class EventPeriodDto {
  @ApiProperty({ enum: ['ytd', 'month'] }) kind!: string;
  @ApiProperty({ type: String, nullable: true, example: '2026-10' }) month!: string | null;
  @ApiProperty({ example: '2026-01-01' }) from!: string;
  @ApiProperty({ example: '2026-11-20' }) to!: string;
}

class EventTypeRefDto {
  @ApiProperty({ example: 'TRAINING' }) code!: string;
  @ApiProperty({ example: 'Pelatihan' }) label!: string;
}

class EventPersonRefDto {
  @ApiProperty() membershipId!: string;
  @ApiProperty({ example: 'Wilson Tanoto' }) name!: string;
  @ApiProperty({ type: String, nullable: true, description: 'A signed link to their photo; `null` draws initials.' }) photoUrl!: string | null;
  @ApiProperty({ example: 'ab', description: '`ab`, `aab` or `agent`: the orange label before the name.' }) role!: string;
}

class KehadiranFigureDto {
  @ApiProperty({ type: Number, nullable: true, example: 7.1, description: 'Hadir per event, averaged (a count over one event).' }) hadir!: number | null;
  @ApiProperty({ type: Number, nullable: true, example: 10, description: 'Expected per event, averaged.' }) expected!: number | null;
  @ApiProperty({ type: Number, nullable: true, example: 71, description: '`Σ hadir / Σ expected`, a whole percent.' }) pct!: number | null;
  @ApiProperty({ enum: ['green', 'yellow', 'red'], nullable: true, description: 'Green from 80%, yellow from 50%, red below.' }) tone!: string | null;
  @ApiProperty({ example: 15 }) events!: number;
}

class EventRefDto {
  @ApiProperty() eventId!: string;
  @ApiProperty({ example: 'September Town Hall' }) title!: string;
  @ApiProperty({ type: EventTypeRefDto }) type!: EventTypeRefDto;
  @ApiProperty({ example: '2026-09-23' }) startsOn!: string;
}

// ------------------------------------------------------------------------------------------------ Kehadiran

class PastEventRowDto extends EventRefDto {
  @ApiProperty({ description: 'Its roll call has been taken. Until then it is in no average and reads *Belum dicatat*.' }) recorded!: boolean;
  @ApiProperty({ type: KehadiranFigureDto, nullable: true }) figure!: KehadiranFigureDto | null;
}

class DeclinedAnswerDto {
  @ApiProperty() membershipId!: string;
  @ApiProperty({ type: String, nullable: true, example: 'Ada janji nasabah' }) reason!: string | null;
}

class UpcomingEventRowDto extends EventRefDto {
  @ApiProperty({ example: '2026-11-21T02:00:00.000Z' }) startsAt!: string;
  @ApiProperty({ example: 1, description: 'Office days to its start: 0 today or running, 1 *Besok*, n *n hari lagi*.' }) daysUntil!: number;
  @ApiProperty() running!: boolean;
  @ApiProperty({ type: [String], description: '*Akan ikut*.' }) going!: string[];
  @ApiProperty({ type: [DeclinedAnswerDto], description: '*Tidak ikut*, each with the reason given.' }) declined!: DeclinedAnswerDto[];
  @ApiProperty({ type: [String], description: '*Belum jawab*: in its audience, no answer yet.' }) pending!: string[];
}

class KehadiranPersonDto extends EventPersonRefDto {
  @ApiProperty({ type: String, nullable: true }) phone!: string | null;
  @ApiProperty({ description: 'Still a member: listed in *Per orang*.' }) current!: boolean;
  @ApiProperty({ example: '10.1?0', description: 'One mark per `past` event, in its order: 1 hadir, 0 tidak hadir, . not expected, ? not recorded.' }) marks!: string;
  @ApiProperty({ example: 2 }) attended!: number;
  @ApiProperty({ example: 12 }) expected!: number;
  @ApiProperty({ type: Number, nullable: true }) pct!: number | null;
  @ApiProperty({ enum: ['green', 'yellow', 'red'], nullable: true }) tone!: string | null;
  @ApiProperty() recentAttended!: number;
  @ApiProperty() recentExpected!: number;
  @ApiProperty({ type: String, nullable: true }) lastEventId!: string | null;
  @ApiProperty({ description: '*Terakhir hadir* in red: more than three events they were expected at since.' }) stale!: boolean;
  @ApiProperty({ description: 'Came to under half: WhatsApp is offered.' }) underHalf!: boolean;
}

class KehadiranAbGroupDto {
  @ApiProperty({ type: EventPersonRefDto }) ab!: EventPersonRefDto;
  @ApiProperty() people!: number;
  @ApiProperty({ type: KehadiranFigureDto }) period!: KehadiranFigureDto;
  @ApiProperty({ type: KehadiranFigureDto }) recent!: KehadiranFigureDto;
  @ApiProperty({ type: [KehadiranFigureDto], description: 'One per `past` event; `null` for one not recorded.' }) byEvent!: (KehadiranFigureDto | null)[];
}

class KehadiranGroupRefDto {
  @ApiProperty() groupId!: string;
  @ApiProperty({ example: 'Top Producers 2026' }) name!: string;
}

class KehadiranGroupCardDto {
  @ApiProperty({ description: 'The group’s id, or `none` for *Tanpa group*.' }) key!: string;
  @ApiProperty({ type: KehadiranGroupRefDto, nullable: true }) group!: KehadiranGroupRefDto | null;
  @ApiProperty({ type: [EventPersonRefDto] }) leaders!: EventPersonRefDto[];
  @ApiProperty() people!: number;
  @ApiProperty({ type: [KehadiranAbGroupDto] }) abGroups!: KehadiranAbGroupDto[];
  @ApiProperty({ type: KehadiranFigureDto }) period!: KehadiranFigureDto;
  @ApiProperty({ type: KehadiranFigureDto }) recent!: KehadiranFigureDto;
  @ApiProperty({ type: [KehadiranFigureDto] }) byEvent!: (KehadiranFigureDto | null)[];
}

export class KehadiranDto {
  @ApiProperty({ type: EventPeriodDto }) period!: EventPeriodDto;
  @ApiProperty({ example: '2026-11' }) currentMonth!: string;
  @ApiProperty({ example: 30, description: 'The office’s members now; test accounts never counted.' }) members!: number;
  @ApiProperty({ example: 15 }) recordedEvents!: number;
  @ApiProperty({ example: 15 }) recentEvents!: number;
  @ApiProperty({ type: KehadiranFigureDto }) summary!: KehadiranFigureDto;
  @ApiProperty({ type: [PastEventRowDto], description: 'Newest first.' }) past!: PastEventRowDto[];
  @ApiProperty({ type: [UpcomingEventRowDto], description: 'Not yet ended, soonest first.' }) upcoming!: UpcomingEventRowDto[];
  @ApiProperty({ type: [KehadiranGroupCardDto] }) groups!: KehadiranGroupCardDto[];
  @ApiProperty({ type: [KehadiranPersonDto] }) people!: KehadiranPersonDto[];
  @ApiProperty({ description: 'May the reader take the roll call (`event_attendance:confirm`).' }) canRecord!: boolean;
}

// ------------------------------------------------------------------------------------------------ Feedback

class FeedbackSharesDto {
  @ApiProperty({ example: 45 }) promoter!: number;
  @ApiProperty({ example: 42 }) passive!: number;
  @ApiProperty({ example: 13 }) detractor!: number;
}

class FeedbackQuoteDto {
  @ApiProperty({ enum: ['leader', 'agent'] }) role!: string;
  @ApiProperty({ example: 'Materinya bagus, tapi terlalu lama.' }) text!: string;
}

class FeedbackFigureDto {
  @ApiProperty({ type: Number, nullable: true, example: 32 }) nps!: number | null;
  @ApiProperty({ type: Number, nullable: true, example: 8.1 }) average!: number | null;
  @ApiProperty({ example: 121 }) answers!: number;
  @ApiProperty({ type: FeedbackSharesDto, nullable: true }) shares!: FeedbackSharesDto | null;
  @ApiProperty({ enum: ['green', 'yellow', 'red'], nullable: true, description: 'Green from +30, yellow from 0, red below.' }) tone!: string | null;
  @ApiProperty({ description: '*sedikit jawaban*: under three answers.' }) few!: boolean;
}

class FeedbackSummaryFigureDto extends FeedbackFigureDto {
  @ApiProperty({ example: 206, description: 'People hadir across the period’s recorded events.' }) hadir!: number;
  @ApiProperty({ type: Number, nullable: true, example: 59 }) share!: number | null;
}

class FeedbackEventRowDto extends FeedbackFigureDto {
  @ApiProperty() eventId!: string;
  @ApiProperty() title!: string;
  @ApiProperty({ type: EventTypeRefDto }) type!: EventTypeRefDto;
  @ApiProperty() startsOn!: string;
  @ApiProperty() recorded!: boolean;
  @ApiProperty({ type: [FeedbackQuoteDto], description: '*Kenapa memberi nilai ini* — never named.' }) why!: FeedbackQuoteDto[];
  @ApiProperty({ type: [FeedbackQuoteDto], description: '*Yang bisa diperbaiki* — never named.' }) improve!: FeedbackQuoteDto[];
}

class NpsScaleDto {
  @ApiProperty({ example: 0 }) scaleMin!: number;
  @ApiProperty({ example: 10 }) scaleMax!: number;
  @ApiProperty({ example: 9 }) promoterMin!: number;
  @ApiProperty({ example: 6 }) detractorMax!: number;
}

export class EventFeedbackDto {
  @ApiProperty({ type: EventPeriodDto }) period!: EventPeriodDto;
  @ApiProperty() currentMonth!: string;
  @ApiProperty({ example: 15 }) events!: number;
  @ApiProperty({ type: FeedbackSummaryFigureDto }) summary!: FeedbackSummaryFigureDto;
  @ApiProperty({ type: [FeedbackEventRowDto], description: 'Lowest NPS first; an event with none last.' }) rows!: FeedbackEventRowDto[];
  @ApiProperty({ type: NpsScaleDto, description: 'The NPS scale, for the legend.' }) constants!: NpsScaleDto;
}
