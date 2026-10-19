import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { SectionChipDto } from '@/modules/summary/summary.response.dto';
import type { ActivityWindowTargetView } from './activity.service';

/** Declared for OpenAPI. The wire shapes live on `ActivityService`'s view types. */

export class ActivityCountDto {
  @ApiProperty() activityTypeId!: string;

  @ApiProperty({ example: 'SELL_SUBMISSION', description: 'What a formula binds to, never a position.' })
  activityTypeCode!: string;

  @ApiProperty({ example: 'Submission polis', description: 'The office’s own wording.' })
  label!: string;

  @ApiProperty({ example: 3 }) count!: number;
}

export class ActivityDayDto {
  @ApiProperty() membershipId!: string;

  @ApiProperty({ example: '2026-03-11', description: 'A calendar day in the office’s timezone.' })
  localDate!: string;

  @ApiProperty({ type: [ActivityCountDto], description: 'Every active type, zeros included.' })
  entries!: ActivityCountDto[];

  @ApiProperty({ example: 7 }) totalCount!: number;

  @ApiProperty({ example: 2, description: 'Bumped on every save. 0 when the day has no entry.' })
  version!: number;

  @ApiPropertyOptional({
    nullable: true,
    description: 'Null while the day is still freely editable; set when its window closed.',
  })
  frozenAt!: string | null;

  @ApiProperty({ description: 'Whether **this** caller may write this day. The Save button.' })
  editable!: boolean;

  @ApiProperty({ example: 0, description: 'How many times this day was corrected after freezing.' })
  correctionCount!: number;
}

export class ActivitySummaryTotalDto {
  @ApiProperty() activityTypeCode!: string;
  @ApiProperty() label!: string;
  @ApiProperty() count!: number;
}

export class ActivityWindowTargetDto implements ActivityWindowTargetView {
  @ApiProperty({ enum: ['leads', 'appointments', 'closings'] }) key!: 'leads' | 'appointments' | 'closings';

  @ApiProperty({ example: 'LEADS_CONTACTED', description: 'The goal’s own code for this count, never an item number.' })
  code!: string;

  @ApiProperty({ example: 14, description: 'Every entry against the code in the window, archived types included.' })
  logged!: number;

  @ApiProperty({
    type: Number,
    nullable: true,
    example: 16,
    description:
      '`SUB_PERIOD_ACTIVITY_TARGET`: this month’s activity target pro-rated to the last 7 days (7 ÷ 30.44, '
      + 'rounded; closings at least 1 when the month asks for any), and labelled *pro-rated* wherever it is '
      + 'shown. `null` without an APE target, and for any period but `ROLLING_7D` or a custom range. 0 is a '
      + 'month that needs nothing more.',
  })
  target!: number | null;
}

export class ActivitySummaryDto {
  @ApiProperty({ example: '2026-03-05' }) from!: string;
  @ApiProperty({ example: '2026-03-11' }) to!: string;

  @ApiProperty({ type: [ActivitySummaryTotalDto], description: 'Every active code, zeros included.' })
  totals!: ActivitySummaryTotalDto[];

  @ApiProperty({ example: 5, description: 'Days with an entry — the compliance denominator.' })
  daysLogged!: number;

  @ApiProperty({ example: 31 }) totalCount!: number;

  @ApiProperty({
    type: [ActivityWindowTargetDto],
    description: 'The goal’s three cascade codes — leads contacted, appointments, closings, in that order — '
      + 'logged in the window against their pro-rated targets.',
  })
  targets!: ActivityWindowTargetDto[];

  @ApiProperty({
    type: [SectionChipDto],
    description: 'The subject’s summary tiles over the window, grouped as `GET /summary`’s '
      + '`activity.sections` are (ADR-0064): the tiles holding none of the three cascade codes, on the '
      + 'subject’s rung. The drill’s category breakdown.',
  })
  sections!: SectionChipDto[];
}

const STANDINGS = ['shown', 'archived', 'not_shown'];

export class DashboardBucketDto {
  @ApiProperty({ example: '2026-09-22' }) from!: string;
  @ApiProperty({ example: '2026-09-28' }) to!: string;
  @ApiProperty({ example: 7 }) days!: number;

  @ApiProperty({
    enum: ['day', 'week', 'remainder'],
    description: '`week` is a 7-day block counted back from the range’s end — *Week 1* is the most '
      + 'recent seven days, not a calendar week. `remainder` is what is left at the old end.',
  })
  kind!: 'day' | 'week' | 'remainder';
}

export class DashboardTypeDto {
  @ApiProperty({ example: 'SELL_SUBMISSION' }) code!: string;
  @ApiProperty({ example: 'Submission polis' }) label!: string;
  @ApiProperty({ type: String, nullable: true }) description!: string | null;
  @ApiProperty({ example: 6, description: 'Display order — the number beside it, never an identity.' })
  displayOrder!: number;

  @ApiProperty({
    enum: STANDINGS,
    description: '`shown` is a type this rung logs against today. `archived` and `not_shown` are history '
      + 'kept on the table so the totals add up.',
  })
  standing!: 'shown' | 'archived' | 'not_shown';

  @ApiProperty() total!: number;
  @ApiProperty({ type: [Number], description: 'One per bucket, in the buckets’ order.' }) counts!: number[];
}

export class DashboardSectionDto {
  @ApiProperty({ example: 'SELLING' }) code!: string;
  @ApiProperty({ example: 'Selling' }) label!: string;
  @ApiProperty({ enum: STANDINGS }) standing!: 'shown' | 'archived' | 'not_shown';
  @ApiProperty() total!: number;
  @ApiProperty({ type: [Number] }) counts!: number[];
  @ApiProperty({ type: [DashboardTypeDto] }) types!: DashboardTypeDto[];
}

export class ActivityDashboardDto {
  @ApiProperty({ enum: ['ROLLING_7D', 'ROLLING_30D', 'CUSTOM'] }) range!: 'ROLLING_7D' | 'ROLLING_30D' | 'CUSTOM';
  @ApiProperty({ example: '2026-09-22' }) from!: string;
  @ApiProperty({ example: '2026-09-28' }) to!: string;
  @ApiProperty({ example: 7 }) days!: number;
  @ApiProperty({ example: '2026-09-28', description: 'Today in the office’s timezone.' }) today!: string;
  @ApiProperty({ type: [DashboardBucketDto], description: 'Most recent first.' }) buckets!: DashboardBucketDto[];

  @ApiProperty({
    type: [DashboardSectionDto],
    description: 'The sections this rung is shown, in the office’s order, then any archived or no-longer-'
      + 'shown one that holds counts in the range.',
  })
  sections!: DashboardSectionDto[];

  @ApiProperty() total!: number;
  @ApiProperty({ type: [Number] }) counts!: number[];
  @ApiProperty({ description: 'Days with an entry, zeroes included (ADR-0042).' }) daysLogged!: number;

  @ApiProperty({ description: 'Days in the range corrected after they closed, counted at their current figures.' })
  correctedDays!: number;
}

export class RatioTermDto {
  @ApiProperty({ example: 'SELL_SUBMISSION' }) code!: string;
  @ApiProperty({ example: 'Submission polis' }) label!: string;
  @ApiProperty({ example: 6, description: 'Display order — the number the log screen shows. 0 when the code is unknown.' })
  displayOrder!: number;
}

export class RatioTagDto {
  @ApiProperty({ type: String, nullable: true, example: 'SELLING' }) code!: string | null;
  @ApiProperty({ example: 'Selling' }) label!: string;
}

export class RatioSidesDto {
  @ApiProperty({ type: String, nullable: true, example: 'Selling' }) numerator!: string | null;
  @ApiProperty({ type: String, nullable: true, example: 'Recruitment' }) denominator!: string | null;
}

export class ActivityRatioDto {
  @ApiProperty({ example: 'SELLING_SUCCESS_RATE' }) code!: string;
  @ApiProperty({ example: 'Selling success rate' }) label!: string;
  @ApiProperty({ enum: ['gte', 'band'] }) comparison!: 'gte' | 'band';
  @ApiProperty({ enum: ['percent', 'decimal', 'points'] }) displayUnit!: 'percent' | 'decimal' | 'points';

  @ApiProperty({ example: 0.15, description: 'The office’s own — a proportion for a rate, points either side of an even split for the balance.' })
  benchmark!: number;

  @ApiProperty({
    type: RatioTagDto, nullable: true,
    description: 'The section the ratio measures, from its denominator, or *Balance*. `null` when the denominator spans sections.',
  })
  tag!: RatioTagDto | null;

  @ApiProperty({
    type: RatioSidesDto, nullable: true,
    description: 'The balance’s two ends, by the section each side counts. `null` for a rate.',
  })
  sides!: RatioSidesDto | null;

  @ApiProperty({ type: [RatioTermDto] }) numerator!: RatioTermDto[];
  @ApiProperty({ type: [RatioTermDto] }) denominator!: RatioTermDto[];

  @ApiProperty({
    type: String, nullable: true,
    description: 'What a platform ratio measures, in the prototype’s words. `null` for an office’s own formula, or one it changed.',
  })
  purpose!: string | null;

  @ApiProperty() divergesFromStandard!: boolean;

  @ApiProperty({
    type: Number, nullable: true,
    description: 'A rate’s proportion, or the balance’s lean in points (positive toward the numerator). '
      + '**`null` is not enough data** — a zero denominator — never 0.',
  })
  value!: number | null;

  @ApiProperty({ type: Number, nullable: true, description: 'Balance only: the numerator side’s share of both, in percent.' })
  share!: number | null;

  @ApiProperty() numeratorCount!: number;
  @ApiProperty() denominatorCount!: number;

  @ApiProperty({ enum: ['success', 'alert', 'neutral'], description: '*On track*, *Below benchmark*, *Not enough data*.' })
  status!: 'success' | 'alert' | 'neutral';
}

export class ActivityRatiosDto {
  @ApiProperty() membershipId!: string;
  @ApiProperty({ example: '2026-08-30' }) from!: string;
  @ApiProperty({ example: '2026-09-28' }) to!: string;
  @ApiProperty({ example: 30, description: '`ROLLING_30D` — fixed (ADR-0022).' }) days!: number;

  @ApiProperty({
    type: [ActivityRatioDto],
    description: 'The office’s active ratios **that apply to the subject’s rung** (ADR-0020), in its order. One that does not apply is absent, never failed.',
  })
  ratios!: ActivityRatioDto[];
}
