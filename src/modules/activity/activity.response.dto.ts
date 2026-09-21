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
