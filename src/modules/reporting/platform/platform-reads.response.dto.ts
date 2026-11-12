import { ApiProperty } from '@nestjs/swagger';
import { MoneyDto, RateDto } from '../reporting.response.dto';
import type {
  CompanyKpmRow, CompanyKpmsView, CompanyRef, KpmComparisonPage, KpmComparisonRow, KpmDataMonth, KpmDataUpload,
  KpmDataView, PlatformAccountRow, PlatformAccountsPage, PlatformMemberRow, PlatformMembersPage,
} from './platform-reads.service';

/*
 * **The Super Admin's reads across KPMs, as the API answers them** (ADR-0207 §2; P19.4-T3). Each class `implements` the
 * service's interface, so neither can grow a field the other lacks — and a field added is a change to ADR-0207's table.
 */

class CompanyRefDto implements CompanyRef {
  @ApiProperty() id!: string;
  @ApiProperty({ example: 'Prudential' }) name!: string;
}

class MemberKpmDto {
  @ApiProperty() id!: string;
  @ApiProperty({ example: '0417' }) code!: string;
  @ApiProperty({ example: 'Bandung' }) branch!: string;
}

class MemberRoleDto {
  @ApiProperty({ example: 'AB', description: 'The rung’s code on the company’s ladder.' }) code!: string;
  @ApiProperty({ example: 'Agency Builder', description: 'The rung’s label; the code where the rung is gone.' }) label!: string;
  @ApiProperty({ description: 'The KPM’s Owner: the *Owner* badge.' }) isOwner!: boolean;
  @ApiProperty({ description: 'A delegated KPM Admin: the *Admin* badge.' }) isAdmin!: boolean;
}

class MemberLeaderDto {
  @ApiProperty() fullName!: string;
}

export class PlatformMemberRowDto implements PlatformMemberRow {
  @ApiProperty({ description: 'The row’s key. Used by no other Super Admin route.' }) membershipId!: string;
  @ApiProperty() fullName!: string;
  @ApiProperty({ example: '70045001' }) agentCode!: string;
  @ApiProperty({ type: CompanyRefDto }) company!: CompanyRefDto;
  @ApiProperty({ type: MemberKpmDto }) kpm!: MemberKpmDto;
  @ApiProperty({ type: MemberRoleDto }) role!: MemberRoleDto;
  @ApiProperty({ type: MemberLeaderDto, nullable: true, description: 'The direct upline now; `null`, *"—"*.' })
  leader!: MemberLeaderDto | null;
  @ApiProperty({ enum: ['active', 'pending', 'removed'] }) status!: 'active' | 'pending' | 'removed';
  @ApiProperty({
    enum: ['invited', 'not_invited', 'signed_in'],
    description: '*Diundang* (an invitation went, never signed in), *Belum diundang*, or signed in (ADR-0212 §2).',
  })
  invitation!: 'invited' | 'not_invited' | 'signed_in';
  @ApiProperty({ type: String, nullable: true, example: '2024-03-01', description: 'The KPM join date (ADR-0169).' })
  joinedOn!: string | null;
  @ApiProperty({
    type: String, nullable: true, example: '2026-11-03',
    description: 'The last day the member logged an activity (the Overview’s `lastLoggedOn`); `null`, *"Belum pernah"*.',
  })
  lastActiveOn!: string | null;
}

export class PlatformMembersPageDto implements PlatformMembersPage {
  @ApiProperty({ type: [PlatformMemberRowDto] }) rows!: PlatformMemberRowDto[];
  @ApiProperty({ example: 1 }) page!: number;
  @ApiProperty({ example: 50 }) pageSize!: number;
  @ApiProperty({ description: 'Every row the filters match, across the pages.' }) total!: number;
}

export class PlatformAccountRowDto implements PlatformAccountRow {
  @ApiProperty({ description: 'The account’s id. Used by no other Super Admin route.' }) userId!: string;
  @ApiProperty({ example: 'Hadi Santoso' }) fullName!: string;
  @ApiProperty({
    example: 'hadi@example.com',
    description: 'The address the account signs in with: the one address a platform read returns (ADR-0245 §2).',
  })
  email!: string;
  @ApiProperty({ type: CompanyRefDto, nullable: true, description: 'The insurer it registered with; `null` with none.' })
  company!: CompanyRefDto | null;
  @ApiProperty({ example: '2026-11-11', description: 'The day the account was made, in `Asia/Jakarta`.' })
  registeredOn!: string;
  @ApiProperty({ description: '*Terverifikasi* or *Belum diverifikasi*: whether the address was confirmed.' })
  emailVerified!: boolean;
  @ApiProperty({
    type: String, nullable: true, example: '2026-11-11',
    description: 'The day of the last sign-in, in `Asia/Jakarta`; `null`, *"Belum pernah"*.',
  })
  lastSignInOn!: string | null;
  @ApiProperty({
    example: 0,
    description: 'Its active or pending memberships, in any KPM. `0` is *Belum punya KPM*; a membership that ended is none.',
  })
  kpmCount!: number;
}

export class PlatformAccountsPageDto implements PlatformAccountsPage {
  @ApiProperty({ type: [PlatformAccountRowDto] }) rows!: PlatformAccountRowDto[];
  @ApiProperty({ example: 1 }) page!: number;
  @ApiProperty({ example: 50 }) pageSize!: number;
  @ApiProperty({ description: 'Every account the filters match, across the pages.' }) total!: number;
}

class ComparisonActiveDto {
  @ApiProperty({ type: Number, nullable: true, description: '`null` while the month is not uploaded.' }) count!: number | null;
  @ApiProperty() of!: number;
  @ApiProperty({ type: Number, nullable: true }) pct!: number | null;
  @ApiProperty({ example: '2026-11' }) month!: string;
}

class ComparisonUsersDto {
  @ApiProperty() logged!: number;
  @ApiProperty() notLogged!: number;
  @ApiProperty({ type: Number, nullable: true }) pct!: number | null;
}

class ComparisonCoachedDto {
  @ApiProperty({ type: RateDto }) d7!: RateDto;
  @ApiProperty({ type: RateDto }) d30!: RateDto;
}

class ComparisonRecruitmentDto {
  @ApiProperty({ description: 'The pipeline now: candidates by stage, counted.' }) pipeline!: number;
  @ApiProperty({ type: Number, nullable: true, description: 'The month’s target, `null` with none set.' })
  target!: number | null;
}

export class KpmComparisonRowDto implements KpmComparisonRow {
  @ApiProperty() kpmId!: string;
  @ApiProperty({ example: '0417' }) code!: string;
  @ApiProperty({ example: 'Bandung' }) branch!: string;
  @ApiProperty({ type: CompanyRefDto }) company!: CompanyRefDto;
  @ApiProperty({ description: '*Total members*: the Overview’s `composition.total`.' }) members!: number;
  @ApiProperty({ type: ComparisonActiveDto, description: '*Aktif bulan ini*: the Overview’s `engagement.activeThisMonth`.' })
  activeThisMonth!: ComparisonActiveDto;
  @ApiProperty({ type: ComparisonUsersDto, description: '*Pengguna aktif*: the Overview’s `engagement.loggedThisWeek`.' })
  activeUsers!: ComparisonUsersDto;
  @ApiProperty({ type: ComparisonCoachedDto, description: '*Coached 7 hari · 30 hari*: the Overview’s coverage.' })
  coached!: ComparisonCoachedDto;
  @ApiProperty({ type: MoneyDto, description: '*Production this year* against target: the Overview’s `production.ytd`.' })
  production!: MoneyDto;
  @ApiProperty({ type: ComparisonRecruitmentDto }) recruitment!: ComparisonRecruitmentDto;
}

export class KpmComparisonPageDto implements KpmComparisonPage {
  @ApiProperty({ type: [KpmComparisonRowDto] }) rows!: KpmComparisonRowDto[];
  @ApiProperty() page!: number;
  @ApiProperty() pageSize!: number;
  @ApiProperty() total!: number;
  @ApiProperty({ example: '-production', description: 'The order read: a column, `-` before it descending.' }) sort!: string;
}

class KpmDataMonthDto implements KpmDataMonth {
  @ApiProperty({ example: '2026-10' }) month!: string;
  @ApiProperty({ enum: ['complete', 'missing', 'none'], description: '*Lengkap · Belum · —* (before the KPM).' })
  status!: 'complete' | 'missing' | 'none';
}

class KpmDataNoteDto {
  @ApiProperty({ enum: ['committed', 'reverting', 'reverted'] }) status!: 'committed' | 'reverting' | 'reverted';
  @ApiProperty({ type: String, nullable: true, description: 'The day a running month’s upload named (*per <tanggal>*).' })
  asOf!: string | null;
}

class KpmDataUploadDto implements KpmDataUpload {
  @ApiProperty({ example: '2026-10' }) month!: string;
  @ApiProperty({ type: String, nullable: true, description: 'Who uploaded it, by name.' }) by!: string | null;
  @ApiProperty({ type: String, nullable: true }) at!: string | null;
  @ApiProperty({ description: 'The agents’ rows it wrote.' }) agents!: number;
  @ApiProperty({ type: KpmDataNoteDto }) note!: KpmDataNoteDto;
}

export class KpmDataDto implements KpmDataView {
  @ApiProperty() kpmId!: string;
  @ApiProperty({ type: [KpmDataMonthDto], description: 'Twelve months, ending with the KPM’s current month.' })
  months!: KpmDataMonthDto[];
  @ApiProperty({ type: [KpmDataUploadDto], description: 'The uploads of those months, newest first.' })
  uploads!: KpmDataUploadDto[];
}

class CompanyKpmPeersDto {
  @ApiProperty({ enum: ['enough', 'not_enough', 'not_counted'] }) status!: 'enough' | 'not_enough' | 'not_counted';
  @ApiProperty({ description: 'Other KPMs of the company complete for the month.' }) count!: number;
  @ApiProperty({ example: 3 }) needed!: number;
}

class CompanyKpmRowDto implements CompanyKpmRow {
  @ApiProperty() kpmId!: string;
  @ApiProperty() code!: string;
  @ApiProperty() branch!: string;
  @ApiProperty() manpower!: number;
  @ApiProperty({ type: Number, nullable: true }) maa!: number | null;
  @ApiProperty({ type: Number, nullable: true, description: 'IDR minor units.' }) apeYtdMinor!: number | null;
  @ApiProperty({ type: Number, nullable: true }) recruitmentYtd!: number | null;
  @ApiProperty({ enum: ['complete', 'missing'] }) data!: 'complete' | 'missing';
  @ApiProperty({ type: CompanyKpmPeersDto }) peers!: CompanyKpmPeersDto;
}

class CompanyKpmTilesDto {
  @ApiProperty() kpms!: number;
  @ApiProperty({ description: 'Owners who have signed in.' }) activeOwners!: number;
  @ApiProperty({ description: 'Live members, active or pending.' }) members!: number;
  @ApiProperty({ description: 'Of them, accounts that have never signed in.' }) notSignedIn!: number;
  @ApiProperty({ description: 'KPMs whose month is complete.' }) complete!: number;
  @ApiProperty({ example: 3 }) needed!: number;
}

export class CompanyKpmsDto implements CompanyKpmsView {
  @ApiProperty({ type: CompanyRefDto }) company!: CompanyRefDto;
  @ApiProperty({ example: '2026-10' }) month!: string;
  @ApiProperty({ type: CompanyKpmTilesDto }) tiles!: CompanyKpmTilesDto;
  @ApiProperty({ type: [CompanyKpmRowDto] }) rows!: CompanyKpmRowDto[];
}
