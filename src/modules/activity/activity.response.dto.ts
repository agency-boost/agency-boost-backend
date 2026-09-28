import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

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

export class ActivitySummaryDto {
  @ApiProperty({ example: '2026-03-05' }) from!: string;
  @ApiProperty({ example: '2026-03-11' }) to!: string;

  @ApiProperty({ type: [ActivitySummaryTotalDto], description: 'Every active code, zeros included.' })
  totals!: ActivitySummaryTotalDto[];

  @ApiProperty({ example: 5, description: 'Days with an entry — the compliance denominator.' })
  daysLogged!: number;

  @ApiProperty({ example: 31 }) totalCount!: number;
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

export class ActivityComplianceDto {
  @ApiProperty() membershipId!: string;

  @ApiProperty({ description: '`ACTIVITY_COMPLIANCE_7D`. Logged or Missed, with no partial state.' })
  compliant7d!: boolean;

  @ApiProperty({ description: '`ACTIVITY_COMPLIANCE_MONTH`, over the calendar month.' })
  compliantMonth!: boolean;

  @ApiPropertyOptional({
    nullable: true,
    example: '2026-03-09',
    description: 'Null when they have never logged — *Never logged*, not *0 days ago*.',
  })
  lastLoggedOn!: string | null;

  @ApiProperty({ example: 7, description: 'The office’s own compliance window.' })
  windowDays!: number;
}
