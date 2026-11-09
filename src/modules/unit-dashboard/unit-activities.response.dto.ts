import { ApiProperty } from '@nestjs/swagger';
import type { ActivityRatioView, RatioTermView } from '@/modules/activity/activity-ratio-readings';
import type {
  ActivitiesPerson, ActivitiesSection, ActivitiesType, CodeCount, PersonRatios, ScopeTotals, UnitActivitiesView,
} from './unit-activities.service';
import { ACTIVITY_SPANS, type ActivityPeriod, type ActivitySpan } from './unit-figures';

/** Declared for OpenAPI. The wire shapes live on `UnitActivitiesService`'s view types. */

/*
 * **A ratio, as `GET /activity/ratios` answers it** (`ActivityRatioReadings`, the one builder): declared here again for
 * the document rather than imported from `activity.response.dto.ts`, which reaches the activity service and through it
 * training — which nothing on the Unit Dashboard may reach (P15-T1 AC-11, `unit-dashboard.imports.spec.ts`). The same
 * fields, one for one; `contract.spec.ts` reads both against the screen's `ActivityRatio`.
 */
class UnitRatioTermDto implements RatioTermView {
  @ApiProperty({ example: 'SELL_SUBMISSION' }) code!: string;
  @ApiProperty({ example: 'Submission polis' }) label!: string;
  @ApiProperty({ example: 6, description: 'Display order — the number the log screen shows. 0 when the code is unknown.' })
  displayOrder!: number;
}

class UnitRatioTagDto {
  @ApiProperty({ type: String, nullable: true, example: 'SELLING' }) code!: string | null;
  @ApiProperty({ example: 'Selling' }) label!: string;
}

class UnitRatioSidesDto {
  @ApiProperty({ type: String, nullable: true, example: 'Selling' }) numerator!: string | null;
  @ApiProperty({ type: String, nullable: true, example: 'Recruitment' }) denominator!: string | null;
}

class UnitRatioDto implements ActivityRatioView {
  @ApiProperty({ example: 'SELLING_SUCCESS_RATE' }) code!: string;
  @ApiProperty({ example: 'Selling success rate', description: 'As the agency named it.' }) label!: string;
  @ApiProperty({ enum: ['gte', 'band'] }) comparison!: 'gte' | 'band';
  @ApiProperty({ enum: ['percent', 'decimal', 'points'] }) displayUnit!: 'percent' | 'decimal' | 'points';
  @ApiProperty({ example: 0.3, description: 'The agency’s own benchmark.' }) benchmark!: number;
  @ApiProperty({ type: UnitRatioTagDto, nullable: true }) tag!: UnitRatioTagDto | null;
  @ApiProperty({ type: UnitRatioSidesDto, nullable: true, description: 'The balance’s two ends; `null` for a rate.' })
  sides!: UnitRatioSidesDto | null;
  @ApiProperty({ type: [UnitRatioTermDto] }) numerator!: UnitRatioTermDto[];
  @ApiProperty({ type: [UnitRatioTermDto] }) denominator!: UnitRatioTermDto[];
  @ApiProperty({ type: String, nullable: true }) purpose!: string | null;
  @ApiProperty() divergesFromStandard!: boolean;
  @ApiProperty({
    type: Number, nullable: true,
    description: 'A rate’s proportion, or the balance’s lean in points. **`null` is not enough data**, never 0.',
  }) value!: number | null;
  @ApiProperty({ type: Number, nullable: true, description: 'Balance only: the numerator side’s share, in percent.' })
  share!: number | null;
  @ApiProperty({ description: 'The set’s numerator codes summed.' }) numeratorCount!: number;
  @ApiProperty({ description: 'The set’s denominator codes summed.' }) denominatorCount!: number;
  @ApiProperty({ enum: ['success', 'alert', 'neutral'], description: 'Judged on the unrounded value.' })
  status!: 'success' | 'alert' | 'neutral';
}

class CodeCountDto implements CodeCount {
  @ApiProperty({ example: 'SELL_SUBMISSION', description: 'The activity type’s stable code.' }) code!: string;
  @ApiProperty({ example: 3 }) count!: number;
}

class ActivityPeriodDto implements ActivityPeriod {
  @ApiProperty({ enum: ACTIVITY_SPANS }) span!: ActivitySpan;
  @ApiProperty({ example: '2026-10-26', description: 'The week’s Monday, or the month’s first day.' }) from!: string;
  @ApiProperty({ example: '2026-11-01', description: 'The week’s Sunday, or the month’s last day.' }) to!: string;
  @ApiProperty({ description: 'The period holds the agency’s today: › goes nowhere.' }) current!: boolean;
  @ApiProperty({ example: '2026-10-25', description: 'A day in the period before: ‹ reads it.' }) previous!: string;
  @ApiProperty({ type: String, nullable: true, description: 'A day in the period after; `null` on the current one.' })
  next!: string | null;
}

class ActivitiesHeadDto {
  @ApiProperty() membershipId!: string;
  @ApiProperty({ example: 'Agus Prasetyo' }) name!: string;
  @ApiProperty({ description: 'The unit is the reader’s own.' }) isReader!: boolean;
}

class ActivitiesTypeDto implements ActivitiesType {
  @ApiProperty({ example: 'SELL_SUBMISSION' }) code!: string;
  @ApiProperty({ example: 'Submission polis', description: 'As the agency named it — content, never translated.' }) label!: string;
  @ApiProperty({
    type: String, nullable: true, example: 'Submission polis',
    description: 'ADR-0229 §5: the agency’s *Nama singkat*, the table’s one line; `null` for none — the row then '
      + 'shows `label` on up to two lines.',
  }) shortLabel!: string | null;
  @ApiProperty({ enum: ['active', 'archived'] }) status!: 'active' | 'archived';
}

class ActivitiesSectionDto implements ActivitiesSection {
  @ApiProperty({ example: 'SELLING' }) code!: string;
  @ApiProperty({ example: 'Penjualan', description: 'As the agency named it.' }) label!: string;
  @ApiProperty({ enum: ['active', 'archived'] }) status!: 'active' | 'archived';
  @ApiProperty({
    type: [ActivitiesTypeDto],
    description: 'Its active types in the agency’s order, and an archived one only while the period counts it.',
  })
  types!: ActivitiesSection['types'];
}

class ActivitiesPersonDto implements ActivitiesPerson {
  @ApiProperty() membershipId!: string;
  @ApiProperty({ example: 'Indah Permatasari' }) name!: string;
  @ApiProperty() isReader!: boolean;
  @ApiProperty({ description: 'In the *Unit*: the head and their direct agents who lead nobody. Everybody is in the *Group*.' })
  inUnit!: boolean;
  @ApiProperty({ type: String, nullable: true, description: 'UI V1 (UI-111): their profile photo, signed, when they have one; the column draws initials otherwise.' })
  photoUrl!: string | null;
  @ApiProperty({ type: [CodeCountDto], description: 'Their counts in the period, codes above zero.' }) counts!: CodeCount[];
  @ApiProperty({ description: 'Their counts summed.' }) total!: number;
}

class ScopeTotalsDto implements ScopeTotals {
  @ApiProperty({ type: [CodeCountDto], description: 'Each code summed over the scope’s people.' }) counts!: CodeCount[];
  @ApiProperty({ description: 'Every count of the scope’s people summed.' }) total!: number;
}

class ActivitiesTotalsDto {
  @ApiProperty({ type: ScopeTotalsDto }) unit!: ScopeTotals;
  @ApiProperty({ type: ScopeTotalsDto }) group!: ScopeTotals;
}

class PersonRatiosDto implements PersonRatios {
  @ApiProperty({ description: 'The member `ratioFor` named.' }) membershipId!: string;
  @ApiProperty({
    type: [UnitRatioDto],
    description: 'The Ratio page’s ratios over their own counts, the same 30 days, on their own rung.',
  }) ratios!: UnitRatioDto[];
}

class ActivitiesRatiosDto {
  @ApiProperty({ example: '2026-10-01' }) from!: string;
  @ApiProperty({ example: '2026-10-30' }) to!: string;
  @ApiProperty({ example: 30, description: '`ROLLING_30D`, fixed: the ratios never follow the period.' }) days!: number;
  @ApiProperty({
    type: [UnitRatioDto],
    description: 'The Ratio page’s ratios over the *Unit*’s counts summed, on the head’s rung.',
  }) unit!: UnitRatioDto[];
  @ApiProperty({ type: [UnitRatioDto], description: 'The same over the *Group*’s.' }) group!: UnitRatioDto[];
  @ApiProperty({
    type: PersonRatiosDto, nullable: true,
    description: 'ADR-0229 §7: one member’s own, when `ratioFor` names them; `null` otherwise.',
  }) person!: PersonRatiosDto | null;
}

export class UnitActivitiesDto implements UnitActivitiesView {
  @ApiProperty({ example: '2026-10-30', description: 'The agency’s today.' }) today!: string;
  @ApiProperty({ type: ActivityPeriodDto }) period!: ActivityPeriod;
  @ApiProperty({ type: ActivitiesHeadDto }) head!: UnitActivitiesView['head'];
  @ApiProperty({ description: 'The head leads nobody: no columns.' }) empty!: boolean;
  @ApiProperty({ type: [ActivitiesSectionDto] }) sections!: ActivitiesSection[];
  @ApiProperty({
    type: [ActivitiesPersonDto],
    description: 'One column per person, in the roster’s order: the head, their direct agents, then each unit below.',
  }) people!: ActivitiesPerson[];
  @ApiProperty({ type: ActivitiesTotalsDto }) totals!: UnitActivitiesView['totals'];
  @ApiProperty({ type: ActivitiesRatiosDto }) ratios!: UnitActivitiesView['ratios'];
}
