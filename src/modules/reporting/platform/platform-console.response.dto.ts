import { ApiProperty } from '@nestjs/swagger';
import { KPM_ISSUES, type KpmIssue } from '@/domain/constants';
import type {
  ConsoleDashboard, ConsoleKpm, ConsoleKpmPeople, ConsolePerson, FunnelStep, PersonClass, UsageCounts,
} from './platform-console.service';

/*
 * **The Super Admin console's reads, as the API answers them** (P19.23-T1, T2; ADR-0277). Each class `implements` the
 * service's interface, so neither can grow a field the other lacks.
 */

class UsageCountsDto implements UsageCounts {
  @ApiProperty({ description: 'Counted members of the class: active, test accounts never (ADR-0267 §1).' }) members!: number;
  @ApiProperty({ description: '*Pernah pakai*: ever logged an activity.' }) everUsed!: number;
  @ApiProperty({ description: '*Pakai 14 hari terakhir*: logged within `USAGE.RECENT_MAX_DAYS`.' }) used14!: number;
  @ApiProperty({ description: '*Power user*: logged on `USAGE.POWER_USER_MIN_DAYS` of the last 30 days.' }) powerUsers!: number;
}

class KpmUsageDto {
  @ApiProperty({ type: UsageCountsDto, description: '*Leader*: the AB and AAB classes.' }) leader!: UsageCounts;
  @ApiProperty({ type: UsageCountsDto, description: '*Agent*.' }) agent!: UsageCounts;
}

class ConsoleKpmDto implements ConsoleKpm {
  @ApiProperty() kpmId!: string;
  @ApiProperty({ example: 'BSD City Branch' }) name!: string;
  @ApiProperty({ example: '0417', description: 'Small, under the name: never the KPM’s only name (AC-3).' }) code!: string;
  @ApiProperty() companyId!: string;
  @ApiProperty({ example: 'Prudential' }) companyName!: string;
  @ApiProperty({ enum: ['active', 'suspended', 'archived'] }) status!: 'active' | 'suspended' | 'archived';
  @ApiProperty({ description: 'Active, its subscription not ended: in *KPM aktif* and *Adopsi per KPM*.' }) active!: boolean;
  @ApiProperty({ type: String, nullable: true, description: 'The Owner, or the named Owner who waits; `null`: none.' })
  ownerName!: string | null;
  @ApiProperty({ enum: ['none', 'not_invited', 'invited', 'active'] }) ownerState!: ConsoleKpm['ownerState'];
  @ApiProperty() createdAt!: string;
  @ApiProperty({ type: KpmUsageDto }) usage!: ConsoleKpm['usage'];
  @ApiProperty({
    enum: KPM_ISSUES, isArray: true,
    description: 'In `KPM_ISSUES`’ order. `suspended` and `archived` stand alone; the other four are *Perlu tindakan*.',
  })
  issues!: KpmIssue[];
  @ApiProperty({ type: String, nullable: true, example: '2026-10', description: '`data_missing`’s month.' })
  missingMonth!: string | null;
}

class FunnelStepDto implements FunnelStep {
  @ApiProperty() count!: number;
  @ApiProperty({ description: 'Of the funnel’s members, whole, rounded half up.' }) pct!: number;
  @ApiProperty({ description: 'The same count as of `comparedWith`, over the same people.' }) previousCount!: number;
  @ApiProperty() previousPct!: number;
}

class FunnelDto {
  @ApiProperty({ description: '*Anggota*: the active KPMs’ counted members.' }) members!: number;
  @ApiProperty({ type: FunnelStepDto }) everUsed!: FunnelStep;
  @ApiProperty({ type: FunnelStepDto }) used14!: FunnelStep;
  @ApiProperty({ type: FunnelStepDto }) powerUsers!: FunnelStep;
}

class OverallDto {
  @ApiProperty({ description: '*KPM*: every live KPM but an archived one.' }) kpms!: number;
  @ApiProperty({ description: '*+n bulan ini*: made this calendar month.' }) kpmsNewThisMonth!: number;
  @ApiProperty({ description: '*Perusahaan*: the insurers.' }) companies!: number;
  @ApiProperty({ description: '*KPM aktif dari n*.' }) activeKpms!: number;
  @ApiProperty() leaders!: number;
  @ApiProperty() agents!: number;
}

class ScaleDto {
  @ApiProperty({ example: 80 }) greenFromPct!: number;
  @ApiProperty({ example: 50 }) yellowFromPct!: number;
}

class CompanyItemDto {
  @ApiProperty() companyId!: string;
  @ApiProperty() name!: string;
}

export class ConsoleDashboardDto implements ConsoleDashboard {
  @ApiProperty({ example: '2026-11-20' }) asOf!: string;
  @ApiProperty({ example: '2026-10-20' }) comparedWith!: string;
  @ApiProperty({ type: ScaleDto, description: '`CONSOLE.SCALE`: the colour scale the pills are drawn on.' })
  scale!: ConsoleDashboard['scale'];
  @ApiProperty({ type: OverallDto }) overall!: ConsoleDashboard['overall'];
  @ApiProperty({ type: FunnelDto }) funnel!: ConsoleDashboard['funnel'];
  @ApiProperty({ description: 'KPM registrations and leaders past the limit, waiting.' }) approvalsPending!: number;
  @ApiProperty({ type: CompanyItemDto, isArray: true }) companies!: ConsoleDashboard['companies'];
  @ApiProperty({ type: ConsoleKpmDto, isArray: true }) kpms!: ConsoleKpm[];
}

class ConsolePersonDto implements ConsolePerson {
  @ApiProperty() membershipId!: string;
  @ApiProperty({ description: 'What *Lihat sebagai* starts a session for.' }) userId!: string;
  @ApiProperty() fullName!: string;
  @ApiProperty({ enum: ['ab', 'aab', 'agent'] }) class!: PersonClass;
}

class FirstMemberDto extends ConsolePersonDto {
  @ApiProperty({ type: String, nullable: true, description: 'Their informal group; `null`: *Tanpa group*.' })
  groupName!: string | null;
  @ApiProperty({ type: Number, nullable: true, description: 'Days since they last logged; `null`: never.' })
  lastUsedDays!: number | null;
  @ApiProperty({ enum: ['recent', 'lapsed', 'never'], description: 'The pill: `recent` within 14 days, `lapsed` past it.' })
  lastUsedStatus!: 'recent' | 'lapsed' | 'never';
}

class PeopleKpmDto {
  @ApiProperty() kpmId!: string;
  @ApiProperty() name!: string;
  @ApiProperty() code!: string;
  @ApiProperty() companyId!: string;
  @ApiProperty() companyName!: string;
  @ApiProperty({ enum: ['active', 'suspended', 'archived'] }) status!: 'active' | 'suspended' | 'archived';
}

class PeopleOwnerDto {
  @ApiProperty({ enum: ['none', 'not_invited', 'invited', 'active'] }) state!: ConsoleKpmPeople['owner']['state'];
  @ApiProperty({ type: ConsolePersonDto, nullable: true }) person!: ConsolePerson | null;
  @ApiProperty({ type: String, nullable: true }) pendingName!: string | null;
}

class PeopleMembersDto {
  @ApiProperty() total!: number;
  @ApiProperty() leaders!: number;
  @ApiProperty() agents!: number;
  @ApiProperty({ type: FirstMemberDto, isArray: true }) first!: ConsoleKpmPeople['members']['first'];
}

class ViewAsDto {
  @ApiProperty({ type: ConsolePersonDto, isArray: true }) owner!: ConsolePerson[];
  @ApiProperty({ type: ConsolePersonDto, isArray: true }) admin!: ConsolePerson[];
  @ApiProperty({ type: ConsolePersonDto, isArray: true }) ab!: ConsolePerson[];
  @ApiProperty({ type: ConsolePersonDto, isArray: true }) agent!: ConsolePerson[];
}

export class ConsoleKpmPeopleDto implements ConsoleKpmPeople {
  @ApiProperty({ type: PeopleKpmDto }) kpm!: ConsoleKpmPeople['kpm'];
  @ApiProperty({ type: PeopleOwnerDto }) owner!: ConsoleKpmPeople['owner'];
  @ApiProperty({ type: ConsolePersonDto, isArray: true }) admins!: ConsolePerson[];
  @ApiProperty({ type: ConsolePersonDto, isArray: true }) coreLeaders!: ConsolePerson[];
  @ApiProperty({ type: PeopleMembersDto }) members!: ConsoleKpmPeople['members'];
  @ApiProperty({ type: ViewAsDto }) viewAs!: ConsoleKpmPeople['viewAs'];
}
