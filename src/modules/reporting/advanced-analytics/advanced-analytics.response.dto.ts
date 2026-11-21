import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { QUANT_METRICS } from '@/domain/constants';
import { MAPA_ROW_KEYS } from '@/domain/metrics/mapa';

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
  @ApiProperty({ type: [SectionRefDto], description: 'The template’s sections that are on, in the fixed order *Demografi · MAPA driver · NPS · Kuantitatif · Kualitatif · Informal group* — NPS and *Kualitatif* also while a run of them is open — then *Event* (ADR-0275 §1).' })
  sections!: SectionRefDto[];
  @ApiProperty({ description: 'Targets and groups may be changed here: a steward of the KPM, never a view-as session or a platform read.' }) canWrite!: boolean;
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

class DemographicsSummaryDto {
  @ApiProperty({ example: 30 }) manpower!: number;
  @ApiProperty({ example: 12, description: '`DEMOGRAPHIC_DATA_COMPLETE`: *Status kerja*, *Tanggal lahir* and *Tanggal bergabung* on file.' }) complete!: number;
  @ApiProperty({ example: 18, description: '*Perlu melengkapi*.' }) incomplete!: number;
  @ApiProperty({ nullable: true, type: Number, example: 40 }) completePct!: number | null;
  @ApiProperty({ nullable: true, type: Number, example: 60 }) incompletePct!: number | null;
}

class FieldCompletenessDto {
  @ApiProperty({ enum: ['workStatus', 'dateOfBirth', 'joinDate'] }) field!: string;
  @ApiProperty({ example: 23 }) filled!: number;
  @ApiProperty({ example: 30 }) of!: number;
  @ApiProperty({ nullable: true, type: Number, example: 77 }) pct!: number | null;
  @ApiProperty({ nullable: true, type: Number, description: 'Over the leaders (AB, AAB).' }) leaderPct!: number | null;
  @ApiProperty({ nullable: true, type: Number, description: 'Over the agents.' }) agentPct!: number | null;
}

class DemographicsMemberDto {
  @ApiProperty() membershipId!: string;
  @ApiProperty({ example: 'Dewi Lestari' }) name!: string;
  @ApiProperty({ nullable: true, type: String }) photoUrl!: string | null;
  @ApiProperty({ enum: ['ab', 'aab', 'agent'] }) role!: string;
  @ApiProperty({ nullable: true, type: String }) agentCode!: string | null;
  @ApiProperty({ nullable: true, type: String }) uplineName!: string | null;
  @ApiProperty({ enum: ['full_time', 'part_time'], nullable: true, type: String }) workStatus!: string | null;
  @ApiProperty({ enum: ['gen_z', 'gen_y', 'gen_x'], nullable: true, type: String, description: 'The band, never the birth date.' }) ageBand!: string | null;
  @ApiProperty({ nullable: true, type: String }) joinDate!: string | null;
  @ApiProperty({ type: [String], description: 'The required fields not on file.' }) missing!: string[];
  @ApiProperty({ nullable: true, type: String, description: 'For *Kirim pengingat* (`wa.me`).' }) phone!: string | null;
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
  @ApiProperty({ example: '2026-11-19', description: '*Data dari profil anggota · {day}*.' }) asOf!: string;
  @ApiProperty({ type: DemographicsSummaryDto }) summary!: DemographicsSummaryDto;
  @ApiProperty({ type: [FieldCompletenessDto] }) completeness!: FieldCompletenessDto[];
  @ApiProperty({ type: [DemographicsMemberDto], description: 'Every member counted, the incomplete first. Test accounts never.' }) members!: DemographicsMemberDto[];
  @ApiProperty({ example: 2, description: '*n berhenti*: members who left from January to the month’s end.' }) left!: number;
  @ApiProperty() canUpload!: boolean;
}

export class DemographicsFileDto {
  @ApiProperty({ example: '0417-demografi-2026-11-19.csv' }) filename!: string;
  @ApiProperty({ description: 'The CSV: *Kode agen, Nama, Peran, Upline, Status kerja, Tanggal lahir, Tanggal bergabung*.' }) file!: string;
}

class DemographicsUploadRowDto {
  @ApiProperty() line!: number;
  @ApiProperty() agentCode!: string;
  @ApiProperty({ nullable: true, type: String }) name!: string | null;
  @ApiProperty({ enum: ['updated', 'unchanged', 'not_found', 'not_yours', 'invalid'] }) status!: string;
  @ApiProperty({ type: [String] }) fields!: string[];
  @ApiProperty({ description: 'The cells that could not be read: `{ field, value }`.' }) problems!: { field: string; value: string }[];
}

export class DemographicsUploadDto {
  @ApiProperty() updated!: number;
  @ApiProperty() unchanged!: number;
  @ApiProperty() skipped!: number;
  @ApiProperty({ type: [DemographicsUploadRowDto] }) rows!: DemographicsUploadRowDto[];
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

class MapaChangeDto {
  @ApiProperty({ nullable: true, type: Number, example: 35 }) value!: number | null;
  @ApiProperty({ enum: ['pct', 'points'], description: '`points` for a percentage row: *poin*.' }) kind!: string;
}

class MapaRowDto {
  @ApiProperty({ enum: MAPA_ROW_KEYS }) key!: string;
  @ApiProperty({ enum: ['ape', 'manpower', 'activation', 'productivity', 'case_size'] }) group!: string;
  @ApiProperty({ enum: ['idr_minor', 'count', 'percentage', 'ratio'] }) unit!: string;
  @ApiProperty({ nullable: true, type: Number, description: 'APE: the year’s total; every other row: the average per month.' }) ytdLastYear!: number | null;
  @ApiProperty({ nullable: true, type: Number }) ytd!: number | null;
  @ApiProperty({ type: MapaChangeDto }) ytdChange!: MapaChangeDto;
  @ApiProperty({ nullable: true, type: Number }) sameMonthLastYear!: number | null;
  @ApiProperty({ nullable: true, type: Number }) lastMonth!: number | null;
  @ApiProperty({ nullable: true, type: Number }) thisMonth!: number | null;
  @ApiProperty({ type: MapaChangeDto }) changeVsSameMonth!: MapaChangeDto;
  @ApiProperty({ type: MapaChangeDto }) changeVsLastMonth!: MapaChangeDto;
  @ApiProperty({ nullable: true, type: Number, description: '*Target bulanan*, read-only: APE (minor units), Active Agent, Rekrut.' }) target!: number | null;
}

class MapaHeadlineDto {
  @ApiProperty({ nullable: true, type: Number }) value!: number | null;
  @ApiProperty({ nullable: true, type: Number }) target!: number | null;
  @ApiProperty({ nullable: true, type: Number }) pct!: number | null;
  @ApiProperty({ enum: ['green', 'yellow', 'red'], nullable: true, type: String }) tone!: string | null;
}

class MapaHeadlinesDto {
  @ApiProperty({ type: MapaHeadlineDto }) ape!: MapaHeadlineDto;
  @ApiProperty({ type: MapaHeadlineDto }) activeAgent!: MapaHeadlineDto;
  @ApiProperty({ type: MapaHeadlineDto }) rekrut!: MapaHeadlineDto;
}

export class MapaDto {
  @ApiProperty({ example: '2026-10' }) month!: string;
  @ApiProperty({ example: '2026-11' }) currentMonth!: string;
  @ApiProperty({ example: '2025-01' }) earliestMonth!: string;
  @ApiProperty({ nullable: true, type: String, description: '*Diperbarui {day}*.' }) asOf!: string | null;
  @ApiProperty({ nullable: true, type: String, description: '*data sampai {Bul}*.' }) dataThrough!: string | null;
  @ApiProperty({ type: MapaHeadlinesDto, description: '*Bulan ini vs target*.' }) headline!: MapaHeadlinesDto;
  @ApiProperty({ type: [MapaRowDto] }) rows!: MapaRowDto[];
}

class QuantLeaderDto {
  @ApiProperty() membershipId!: string;
  @ApiProperty({ enum: ['ab', 'aab'] }) role!: string;
  @ApiProperty({ example: 'Satria Nugraha' }) name!: string;
  @ApiProperty({ nullable: true, type: String }) photoUrl!: string | null;
  @ApiProperty({ example: 1.7, description: 'The metric over the leader’s own unit.' }) value!: number;
}

class QuantDistributionDto {
  @ApiProperty({ type: [QuantLeaderDto], description: 'High to low.' }) leaders!: QuantLeaderDto[];
  @ApiProperty({ nullable: true, type: Number, description: '`QUANT_LEADER_MEDIAN` — *Median KPM*.' }) median!: number | null;
  @ApiProperty({ description: '*x dari y leader di atau di atas median*.' }) atOrAbove!: number;
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
  @ApiProperty({ nullable: true, type: Number, description: '*Semester lalu*: the run six months before, over as many months.' }) previous!: number | null;
  @ApiProperty({ type: QuantDistributionDto }) distribution!: QuantDistributionDto;
}

class QuantRunRefDto {
  @ApiProperty({ example: '2026-06' }) periodEnd!: string;
  @ApiProperty({ example: '2026-01', description: 'January or July; January for a December run frozen before the half-years.' }) fromMonth!: string;
}

class QuantBandsDto {
  @ApiProperty({ example: 5 }) peerBandPct!: number;
  @ApiProperty({ example: 2 }) diffBand!: number;
}

export class QuantDto {
  @ApiProperty({ nullable: true, type: String, example: '2026-06' }) periodEnd!: string | null;
  @ApiProperty({ nullable: true, type: String, example: '2026-01' }) fromMonth!: string | null;
  @ApiProperty({ type: [QuantRunRefDto] }) runs!: QuantRunRefDto[];
  @ApiProperty({ example: 'Prudential', description: '*KPM {company} lain*.' }) companyName!: string;
  @ApiProperty({ nullable: true, type: String }) freezesAt!: string | null;
  @ApiProperty({ nullable: true, type: String }) frozenAt!: string | null;
  @ApiProperty({ nullable: true, type: String, description: '*"Data diunggah setelah periode dikunci"*.' }) lateWriteAt!: string | null;
  @ApiProperty({ example: 3 }) needed!: number;
  @ApiProperty({ type: QuantBandsDto }) bands!: QuantBandsDto;
  @ApiProperty({ type: [QuantMetricDto] }) metrics!: QuantMetricDto[];
}

class DriverFigureDto {
  @ApiProperty({ nullable: true, type: Number }) value!: number | null;
  @ApiProperty({ nullable: true, type: Number }) target!: number | null;
  @ApiProperty({ nullable: true, type: Number }) pct!: number | null;
  @ApiProperty({ enum: ['green', 'yellow', 'red'], nullable: true, type: String }) tone!: string | null;
}

class UsageFigureDto {
  @ApiProperty({ nullable: true, type: Number }) downlinePct!: number | null;
  @ApiProperty({ nullable: true, type: Number }) leaderPct!: number | null;
  @ApiProperty({ enum: ['green', 'yellow', 'red'], nullable: true, type: String }) tone!: string | null;
}

class InformalDriversDto {
  @ApiProperty({ type: DriverFigureDto, description: 'Monthly Active Agent, MTD vs the Active Agent target.' }) maa!: DriverFigureDto;
  @ApiProperty({ type: UsageFigureDto, description: 'Pemakaian AgencyBoost, 30 days.' }) usage!: UsageFigureDto;
  @ApiProperty({ type: DriverFigureDto, description: '1-on-1 per minggu: sessions in 30 days ÷ 4,35 vs 2 × the AA target.' }) oneOnOne!: DriverFigureDto;
  @ApiProperty({ type: DriverFigureDto, description: 'Rekrut YTD vs the Rekrut targets January to the month.' }) rekrut!: DriverFigureDto;
}

class InformalAbDto {
  @ApiProperty() membershipId!: string;
  @ApiProperty() name!: string;
  @ApiProperty({ nullable: true, type: String }) photoUrl!: string | null;
  @ApiProperty({ enum: ['ab'] }) role!: string;
  @ApiProperty({ nullable: true, type: String }) agentCode!: string | null;
  @ApiProperty() isGroupLeader!: boolean;
  @ApiProperty() isCoreLeader!: boolean;
}

class InformalAbGroupDto {
  @ApiProperty({ type: InformalAbDto }) ab!: InformalAbDto;
  @ApiProperty({ description: '*n orang di grupnya*.' }) people!: number;
  @ApiProperty() leaders!: number;
  @ApiProperty({ type: InformalDriversDto }) drivers!: InformalDriversDto;
}

class SubgroupGroupDto {
  @ApiProperty() groupId!: string;
  @ApiProperty({ example: 'Top Producers 2026' }) name!: string;
}

class GroupLeaderDto {
  @ApiProperty() membershipId!: string;
  @ApiProperty() name!: string;
  @ApiProperty({ nullable: true, type: String }) photoUrl!: string | null;
}

class CountsDto {
  @ApiProperty() leaders!: number;
  @ApiProperty() people!: number;
  @ApiProperty() abGroups!: number;
}

class InformalGroupCardDto {
  @ApiProperty({ type: SubgroupGroupDto, nullable: true, description: '`null`: *Tanpa group*.' }) group!: SubgroupGroupDto | null;
  @ApiProperty({ type: [GroupLeaderDto] }) leaders!: GroupLeaderDto[];
  @ApiProperty({ type: CountsDto }) counts!: CountsDto;
  @ApiProperty({ type: InformalDriversDto }) drivers!: InformalDriversDto;
  @ApiProperty({ type: [InformalAbGroupDto] }) abGroups!: InformalAbGroupDto[];
}

class SubgroupTotalDto {
  @ApiProperty() groups!: number;
  @ApiProperty() leaders!: number;
  @ApiProperty() people!: number;
  @ApiProperty({ type: InformalDriversDto }) drivers!: InformalDriversDto;
}

export class SubgroupDto {
  @ApiProperty({ example: '2026-10' }) month!: string;
  @ApiProperty({ example: '2026-11' }) currentMonth!: string;
  @ApiProperty({ example: '2024-01' }) earliestMonth!: string;
  @ApiProperty({ type: SubgroupTotalDto, description: '*Total KPM*.' }) total!: SubgroupTotalDto;
  @ApiProperty({ type: [InformalGroupCardDto] }) groups!: InformalGroupCardDto[];
  @ApiProperty() canWrite!: boolean;
}

export class SubgroupSheetDto {
  @ApiProperty({ enum: ['maa', 'usage', 'coaching', 'rekrut'] }) driver!: string;
  @ApiProperty() month!: string;
  @ApiProperty({ description: 'The AB: name, photo, role and WhatsApp number.' }) ab!: Record<string, unknown>;
  @ApiProperty({ type: InformalDriversDto }) drivers!: InformalDriversDto;
  @ApiPropertyOptional({ description: '`maa`: `{ active: [{ person, apeMinor, policies }], notYet: [{ person, potensi, lastActiveMonth }] }`.' }) maa?: Record<string, unknown>;
  @ApiPropertyOptional({ description: '`usage`: `{ notUsed: [{ person, lastLoggedOn, daysSince }], used: [{ person, powerUser, daysLogged, daysSince }] }`.' }) usage?: Record<string, unknown>;
  @ApiPropertyOptional({ description: '`coaching`: `[{ person, status, daysSince }]`.' }) coaching?: Record<string, unknown>[];
  @ApiPropertyOptional({ description: '`rekrut`: `{ joined: [{ person, joinDate, recruiter }], potential }`.' }) rekrut?: Record<string, unknown>;
}

/** The Super Admin's read of one section: that section's own shape, as the KPM's Owner reads it. */
export class AdminAdvancedAnalyticsSectionDto {
  @ApiPropertyOptional({ description: 'One of the shapes above — the section named in the path — or the surveys’ `SurveyResultsDto` as a summary.' })
  section?: string;
}
