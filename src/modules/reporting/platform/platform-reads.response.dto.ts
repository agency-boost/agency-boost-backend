import { ApiProperty } from '@nestjs/swagger';
import type {
  CompanyKpmRow, CompanyKpmsView, CompanyRef, PlatformAccountRow, PlatformAccountsPage, PlatformMemberDetail,
  PlatformMemberRow, PlatformMembersPage,
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
  @ApiProperty({
    enum: ['ab', 'aab', 'agent'],
    description: 'The rung’s class (ADR-0156): `ab` and `aab` draw *Anggota*’s orange label, `agent` none.',
  })
  class!: 'ab' | 'aab' | 'agent';
  @ApiProperty({ description: 'The KPM’s Owner: the *Owner* badge.' }) isOwner!: boolean;
  @ApiProperty({ description: 'A delegated KPM Admin: the *Admin* badge.' }) isAdmin!: boolean;
}

class MemberLeaderDto {
  @ApiProperty() fullName!: string;
}

/** *Terakhir pakai* as the server reads it (P19.23-T3 AC-1; ADR-0267 §4). */
class MemberLastActiveDto {
  @ApiProperty({ type: Number, nullable: true, example: 3, description: 'Whole days to the KPM’s today; `null`, never.' })
  days!: number | null;
  @ApiProperty({
    enum: ['recent', 'lapsed', 'never'],
    description: '`recent` within `USAGE.RECENT_MAX_DAYS` (14), `lapsed` past it, `never` — the pill’s colour.',
  })
  status!: 'recent' | 'lapsed' | 'never';
}

export class PlatformMemberRowDto implements PlatformMemberRow {
  @ApiProperty({ description: 'The row’s key: `GET /admin/members/:membershipId` reads its detail.' })
  membershipId!: string;
  @ApiProperty({ description: 'The person: what `PATCH /admin/users/:userId/test-account` writes.' })
  userId!: string;
  @ApiProperty() fullName!: string;
  @ApiProperty({
    type: String, nullable: true,
    description: 'Their photo as a signed link; `null`, the initials are drawn.',
  })
  avatarUrl!: string | null;
  @ApiProperty({
    description: '`users.testAccount` (ADR-0267 §1): `true` only on a `testAccount=only` page — test accounts are in no '
      + 'other row or count (OD-421).',
  })
  testAccount!: boolean;
  @ApiProperty({ example: '70045001' }) agentCode!: string;
  @ApiProperty({ type: CompanyRefDto }) company!: CompanyRefDto;
  @ApiProperty({ type: MemberKpmDto }) kpm!: MemberKpmDto;
  @ApiProperty({ type: MemberRoleDto }) role!: MemberRoleDto;
  @ApiProperty({ type: MemberLeaderDto, nullable: true, description: 'The direct upline now; `null`, *"—"*.' })
  leader!: MemberLeaderDto | null;
  @ApiProperty({ enum: ['active', 'pending', 'removed'] }) status!: 'active' | 'pending' | 'removed';
  @ApiProperty({
    enum: ['invited', 'not_invited', 'signed_in'],
    description: '*Diundang* (an invitation went, the account not theirs yet), *Belum diundang*, or `signed_in` — the account '
      + 'is theirs: signed in, or its address proven (ADR-0212 §2; OD-475).',
  })
  invitation!: 'invited' | 'not_invited' | 'signed_in';
  @ApiProperty({ type: String, nullable: true, example: '2024-03-01', description: 'The KPM join date (ADR-0169).' })
  joinedOn!: string | null;
  @ApiProperty({
    type: String, nullable: true, example: '2026-11-03',
    description: 'The last day the member logged an activity (the Overview’s `lastLoggedOn`); `null`, *"Belum pernah"*.',
  })
  lastActiveOn!: string | null;
  @ApiProperty({ type: MemberLastActiveDto, description: '*Terakhir pakai*: the days and the bucket.' })
  lastActive!: MemberLastActiveDto;
  @ApiProperty({
    type: String, nullable: true, example: '2026-09-14',
    description: '*Keluar <Mon YYYY>*: the office day the membership ended; `null` while it has not.',
  })
  leftOn!: string | null;
}

/** *Aktif n · Menunggu n · Keluar n* (P19.28-T3 AC-4; UI-209; ADR-0286 §5), over the scope asked, test accounts never. */
export class AnggotaChipsDto {
  @ApiProperty({ example: 50, description: '*Aktif*: the counted member (ADR-0284 §1).' }) active!: number;
  @ApiProperty({ example: 2, description: '*Menunggu*: *Diundang* and *Belum ada KPM* (`GET /admin/waiting-members`).' })
  pending!: number;
  @ApiProperty({ example: 3, description: '*Keluar*: memberships that ended.' }) removed!: number;
}

/** *Anggota* (`COUNTED_MEMBERS`): active, never a test account, in a KPM that is not archived. */
class CountedMembersDto {
  @ApiProperty({ example: 55, description: 'The counted members the scope holds.' }) members!: number;
  @ApiProperty({ example: 8, description: 'The KPMs they are in.' }) kpms!: number;
}

export class PlatformMembersPageDto implements PlatformMembersPage {
  @ApiProperty({ type: [PlatformMemberRowDto] }) rows!: PlatformMemberRowDto[];
  @ApiProperty({ type: AnggotaChipsDto, description: 'The three chips, whatever status is listed.' })
  chips!: AnggotaChipsDto;
  @ApiProperty({ example: 1 }) page!: number;
  @ApiProperty({ example: 50 }) pageSize!: number;
  @ApiProperty({ description: 'Every row the filters match, across the pages.' }) total!: number;
  @ApiProperty({ example: 8, description: 'The KPMs those rows are in.' })
  kpmCount!: number;
  @ApiProperty({
    type: CountedMembersDto,
    description: '*"n anggota di m KPM"* and *Aktif n* (ADR-0284 §1): the scope’s counted members, whatever status is listed.',
  })
  counted!: CountedMembersDto;
}

/** *Anggota*'s detail (P19.23-T3 AC-1; ADR-0277): the row, and the person's WhatsApp number and email. */
export class PlatformMemberDetailDto extends PlatformMemberRowDto implements PlatformMemberDetail {
  @ApiProperty({ type: String, nullable: true, example: '+6281234567890', description: '`users.phone`; `null` with none.' })
  phone!: string | null;
  @ApiProperty({ example: 'wilson@example.com', description: 'The address the account signs in with.' })
  email!: string;
}

/** What the test-account switch answers (P19.23-T3 AC-1; ADR-0267 §1). */
export class TestAccountSetDto {
  @ApiProperty() userId!: string;
  @ApiProperty() testAccount!: boolean;
  @ApiProperty({ description: 'The person’s memberships the copy was written on, in every KPM.' }) memberships!: number;
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
  @ApiProperty({ description: '*Anggota*: the counted members (`COUNTED_MEMBERS`; ADR-0284 §1).' }) members!: number;
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
