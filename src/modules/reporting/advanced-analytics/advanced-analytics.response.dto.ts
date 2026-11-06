import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { QUANT_METRICS } from '@/domain/constants';
import { ROW_KEYS } from '@/modules/leader-meetings/scorecard/scorecard.types';

/**
 * **The KPM's *Advanced analytics* page, declared for OpenAPI** (P19.5-T3; `functional/advanced-analytics.md`, *Data
 * contract*). The wire shapes are `advanced-analytics.service.ts`'s and `quant-runs.service.ts`'s, as
 * `frontend/src/lib/advanced-analytics-page.ts` reads them. **No shape names a respondent, and none carries another
 * KPM's figure, name or id** (ADR-0215 §4, §5).
 */

class SectionRefDto {
  @ApiProperty({ enum: ['DEMOGRAPHICS', 'MAPA', 'NPS', 'QUANT', 'QUAL', 'SUBGROUP', 'EVENTS'] }) kode!: string;
  @ApiProperty({ example: 'demographics' }) slug!: string;
}

export class AdvancedAnalyticsShellDto {
  @ApiProperty({ nullable: true, type: String, example: 'Prudential standar' }) templateName!: string | null;
  @ApiProperty({ example: 1 }) version!: number;
  @ApiProperty({ type: [SectionRefDto], description: 'The template’s sections that are on, in its order — NPS and *Kualitatif* also while a run of them is open — then *Event*.' })
  sections!: SectionRefDto[];
  @ApiProperty({ description: 'The targets may be typed: the Owner and the Admins, never a view-as session or the Super Admin.' }) canWrite!: boolean;
  @ApiProperty({ description: '*Unggah data*, the empty state’s next step.' }) canUpload!: boolean;
}

class AbOptionDto {
  @ApiProperty() membershipId!: string;
  @ApiProperty({ example: 'Agus Prasetyo' }) name!: string;
}

class DimensionCountDto {
  @ApiProperty({ example: 'gen_y', description: '`unset` is *Belum diisi*.' }) key!: string;
  @ApiProperty({ example: 12 }) count!: number;
  @ApiPropertyOptional({ nullable: true, type: Number, description: 'A band’s lower bound in years.' }) from?: number | null;
  @ApiPropertyOptional({ nullable: true, type: Number, description: 'A band’s upper bound in years; `null` is open.' }) to?: number | null;
  @ApiPropertyOptional({ description: '`role`: the rung’s label on the company’s ladder.' }) label?: string;
}

export class DemographicsDto {
  @ApiProperty({ example: '2026-11' }) month!: string;
  @ApiProperty({ type: AbOptionDto, nullable: true }) ab!: AbOptionDto | null;
  @ApiProperty({ type: [AbOptionDto] }) abs!: AbOptionDto[];
  @ApiProperty({ example: 28, description: '`OFFICE_HEADCOUNT` on the month’s last day: what every dimension sums to.' }) manpower!: number;
  @ApiProperty({ type: [DimensionCountDto] }) role!: DimensionCountDto[];
  @ApiProperty({ type: [DimensionCountDto] }) workStatus!: DimensionCountDto[];
  @ApiProperty({ type: [DimensionCountDto] }) gender!: DimensionCountDto[];
  @ApiProperty({ type: [DimensionCountDto] }) ageBand!: DimensionCountDto[];
  @ApiProperty({ type: [DimensionCountDto] }) tenureBand!: DimensionCountDto[];
}

class EventsPeriodDto {
  @ApiProperty({ enum: ['ytd', 'month'] }) kind!: string;
  @ApiProperty({ example: '2026-01-01' }) from!: string;
  @ApiProperty({ example: '2026-11-06' }) to!: string;
}

class EventNpsFigureDto {
  @ApiProperty({ nullable: true, type: Number, example: 43 }) nps!: number | null;
  @ApiProperty({ nullable: true, type: Number, example: 8.4 }) average!: number | null;
  @ApiProperty({ example: 7 }) n!: number;
}

class EventNpsRowDto extends EventNpsFigureDto {
  @ApiProperty() eventId!: string;
  @ApiProperty({ example: 'Town Hall Q3' }) title!: string;
  @ApiProperty({ example: '2026-09-12' }) startsOn!: string;
}

export class EventsNpsDto {
  @ApiProperty({ type: EventsPeriodDto }) period!: EventsPeriodDto;
  @ApiProperty({ type: AbOptionDto, nullable: true }) ab!: AbOptionDto | null;
  @ApiProperty({ type: [AbOptionDto] }) abs!: AbOptionDto[];
  @ApiProperty({ type: EventNpsFigureDto, description: '`EVENT_NPS_FOR_PERIOD`.' }) kpm!: EventNpsFigureDto;
  @ApiProperty({ type: [EventNpsRowDto], description: 'Each event with counted feedback in the period. No respondent is named.' })
  events!: EventNpsRowDto[];
}

class MapaCellDto {
  @ApiProperty({ enum: ['figure', 'pending', 'none', 'blocked', 'not_uploaded', 'future'] }) kind!: string;
  @ApiPropertyOptional({ description: 'A `figure`’s value in the row’s unit — IDR minor units for money.' }) value?: number;
}

class MapaMonthDto {
  @ApiProperty({ example: '2026-03' }) month!: string;
  @ApiProperty({ type: MapaCellDto }) value!: MapaCellDto;
  @ApiProperty({ type: MapaCellDto }) lastYear!: MapaCellDto;
  @ApiProperty({ nullable: true, type: Number, description: 'The KPM’s typed target; `null` is *TBD*.' }) target!: number | null;
  @ApiPropertyOptional({ description: '`flc` only: the members who joined as new hires that month, where it differs from the upload (D2’s ⓘ).' })
  joined?: number;
}

class MapaRowDto {
  @ApiProperty({ enum: ROW_KEYS }) row!: string;
  @ApiProperty({ enum: ['idr_minor', 'count', 'percentage', 'ratio'] }) unit!: string;
  @ApiProperty({ description: 'Tracked month by month; otherwise *Not tracked* in a month, as the forum.' }) monthly!: boolean;
  @ApiProperty() targetable!: boolean;
  @ApiProperty({ type: [MapaMonthDto] }) months!: MapaMonthDto[];
  @ApiProperty({ type: MapaCellDto }) ytd!: MapaCellDto;
  @ApiProperty({ type: MapaCellDto }) ytdLastYear!: MapaCellDto;
}

export class MapaDto {
  @ApiProperty({ example: '2026' }) year!: string;
  @ApiProperty({ example: '2026-11' }) through!: string;
  @ApiProperty({ type: [String], description: '*Belum lengkap · <Bul> belum diunggah*: the months of *YTD {Y}* not complete.' })
  ytdMissingMonths!: string[];
  @ApiProperty({ type: [String] }) ytdLastYearMissingMonths!: string[];
  @ApiProperty({ type: [MapaRowDto] }) rows!: MapaRowDto[];
  @ApiProperty() canWrite!: boolean;
}

class QuantMetricDto {
  @ApiProperty({ enum: QUANT_METRICS.map((m) => m.code) }) code!: string;
  @ApiProperty({ enum: QUANT_METRICS.map((m) => m.metric) }) metric!: string;
  @ApiProperty({ nullable: true, type: Number }) value!: number | null;
  @ApiProperty() complete!: boolean;
  @ApiProperty({ type: [String] }) missingMonths!: string[];
  @ApiProperty({ enum: ['no_leader', 'not_enough_data'], nullable: true, type: String }) reason!: string | null;
  @ApiProperty({ nullable: true, type: Number, description: '`QUANT_PEER_MEDIAN`: a median of the company’s other KPMs, never one KPM’s figure.' })
  median!: number | null;
  @ApiProperty({ description: 'How many peers held it complete — *"(n dari 3)"*.' }) peers!: number;
  @ApiProperty({ enum: ['above', 'in_line', 'below'], nullable: true, type: String }) status!: string | null;
}

class QuantBandsDto {
  @ApiProperty({ example: 5 }) peerBandPct!: number;
  @ApiProperty({ example: 2 }) diffBand!: number;
}

export class QuantDto {
  @ApiProperty({ nullable: true, type: String, example: '2026-06' }) periodEnd!: string | null;
  @ApiProperty({ type: [String] }) runs!: string[];
  @ApiProperty({ nullable: true, type: String }) freezesAt!: string | null;
  @ApiProperty({ nullable: true, type: String }) frozenAt!: string | null;
  @ApiProperty({ nullable: true, type: String, description: '*"Data diunggah setelah periode dikunci"*.' }) lateWriteAt!: string | null;
  @ApiProperty({ example: 3 }) needed!: number;
  @ApiProperty({ type: QuantBandsDto }) bands!: QuantBandsDto;
  @ApiProperty({ type: [QuantMetricDto] }) metrics!: QuantMetricDto[];
}

class SubgroupMaaDto {
  @ApiProperty({ nullable: true, type: Number }) baseline!: number | null;
  @ApiProperty({ nullable: true, type: Number }) lastMonth!: number | null;
  @ApiProperty({ nullable: true, type: Number }) mtd!: number | null;
  @ApiProperty({ nullable: true, type: String, description: 'This month’s upload’s *as of* day (D8).' }) asOf!: string | null;
}

class SubgroupTargetsDto {
  @ApiProperty() aa!: number;
  @ApiProperty() rec!: number;
  @ApiProperty({ description: 'The template’s defaults, not set for this head yet.' }) isDefault!: boolean;
}

class SubgroupAdoptionDto {
  @ApiProperty() headDays!: number;
  @ApiProperty({ nullable: true, type: Number }) downlinePct!: number | null;
}

class SubgroupRecruitmentDto {
  @ApiProperty({ nullable: true, type: Number }) baseline!: number | null;
  @ApiProperty({ nullable: true, type: Number }) ytd!: number | null;
  @ApiProperty({ type: [String] }) missingMonths!: string[];
}

class SubgroupAttainmentDto {
  @ApiProperty({ nullable: true, type: Number }) aaPct!: number | null;
  @ApiProperty({ nullable: true, type: Boolean }) aaOk!: boolean | null;
  @ApiProperty({ nullable: true, type: Number }) recPct!: number | null;
  @ApiProperty({ nullable: true, type: Boolean }) recOk!: boolean | null;
}

class SubgroupRowDto {
  @ApiProperty({ type: AbOptionDto }) head!: AbOptionDto;
  @ApiProperty() manpower!: number;
  @ApiProperty() leaders!: number;
  @ApiProperty({ type: SubgroupMaaDto }) maa!: SubgroupMaaDto;
  @ApiProperty({ type: SubgroupTargetsDto }) targets!: SubgroupTargetsDto;
  @ApiProperty({ type: SubgroupAdoptionDto }) adoption!: SubgroupAdoptionDto;
  @ApiProperty() powerUsers!: number;
  @ApiProperty() oneOnOnesPerWeek!: number;
  @ApiProperty() weeklyActivityTarget!: number;
  @ApiProperty({ type: SubgroupRecruitmentDto }) recruitment!: SubgroupRecruitmentDto;
  @ApiProperty({ type: SubgroupAttainmentDto }) attainment!: SubgroupAttainmentDto;
}

class SubgroupThresholdsDto {
  @ApiProperty({ example: 80 }) okPct!: number;
  @ApiProperty({ example: 10 }) powerUserDays!: number;
  @ApiProperty({ example: 30 }) powerUserWindow!: number;
}

export class SubgroupDto {
  @ApiProperty({ example: '2026-11' }) month!: string;
  @ApiProperty({ type: SubgroupThresholdsDto }) thresholds!: SubgroupThresholdsDto;
  @ApiProperty({ type: [SubgroupRowDto] }) rows!: SubgroupRowDto[];
  @ApiProperty() canWrite!: boolean;
}

export class MapaTargetDto {
  @ApiProperty() month!: string;
  @ApiProperty() row!: string;
  @ApiProperty({ nullable: true, type: Number }) value!: number | null;
}

export class SubgroupTargetDto {
  @ApiProperty() headMembershipId!: string;
  @ApiProperty() aaTarget!: number;
  @ApiProperty() recTarget!: number;
}

/** The Super Admin's read of one section: that section's own shape, as the KPM's Owner reads it. */
export class AdminAdvancedAnalyticsSectionDto {
  @ApiPropertyOptional({ description: 'One of the shapes above — the section named in the path — or the surveys’ `SurveyResultsDto` as a summary.' })
  section?: string;
}
