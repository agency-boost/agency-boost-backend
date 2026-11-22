import { Controller, Get, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiProperty, ApiPropertyOptional, ApiResponse, ApiTags } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsIn, IsInt, IsMongoId, IsOptional, IsString, MaxLength, Min } from 'class-validator';
import { Ctx, RequirePermission } from '@/common/auth/auth.decorators';
import { RequestContext } from '@/common/context/request-context';
import { ApiErrorEnvelope } from '@/common/errors/error-envelope.dto';
import { field } from '@/common/validation/violations';
import {
  PLATFORM_MEMBER_ROLES, PLATFORM_MEMBER_TEST_FILTERS, PLATFORM_READ,
  type PlatformMemberRole, type PlatformMemberTestFilter,
} from '@/domain/constants';
import { AnggotaWaiting, type WaitingPage, type WaitingRow } from './anggota-waiting';
import { PLATFORM_READS_REFUSALS } from './platform-reads.messages';
import { AnggotaChipsDto } from './platform-reads.response.dto';

const SAY = PLATFORM_READS_REFUSALS.VALIDATION_FAILED;
const refusal = (status: number, description: string) => ({ status, description, type: ApiErrorEnvelope });

/** `GET /admin/waiting-members`: *Menunggu*'s filters — Anggota's own, the status set by the route. */
export class WaitingMembersQueryDto {
  @ApiPropertyOptional({ description: 'One company’s KPMs, and its accounts in no KPM.' })
  @IsOptional() @IsString() @IsMongoId({ message: field(SAY.idShape) })
  companyId?: string;

  @ApiPropertyOptional({ description: 'One KPM. Accounts in no KPM are left out.' })
  @IsOptional() @IsString() @IsMongoId({ message: field(SAY.idShape) })
  kpmId?: string;

  @ApiPropertyOptional({ enum: PLATFORM_MEMBER_ROLES, description: 'An invitation’s class. Nobody unplaced has one.' })
  @IsOptional() @IsIn(PLATFORM_MEMBER_ROLES, { message: field(SAY.roleShape) })
  role?: PlatformMemberRole;

  @ApiPropertyOptional({ minLength: 2, maxLength: 100, description: 'A name, a phone number or an email, in part.' })
  @IsOptional() @IsString() @MaxLength(100)
  q?: string;

  @ApiPropertyOptional({ minimum: 1, default: 1 })
  @IsOptional() @Type(() => Number) @IsInt({ message: field(SAY.pageShape) }) @Min(1, { message: field(SAY.pageShape) })
  page?: number;

  @ApiPropertyOptional({ enum: PLATFORM_MEMBER_TEST_FILTERS, description: '`include`: *Tampilkan akun tes*.' })
  @IsOptional() @IsIn(PLATFORM_MEMBER_TEST_FILTERS, { message: field(SAY.testAccountShape) })
  testAccount?: PlatformMemberTestFilter;
}

class WaitingKpmDto {
  @ApiProperty() id!: string;
  @ApiProperty({ example: '0417' }) code!: string;
  @ApiProperty({ example: 'BSD City Branch' }) branch!: string;
}

class WaitingCompanyDto {
  @ApiProperty() id!: string;
  @ApiProperty({ example: 'Prudential' }) name!: string;
}

class WaitingRoleDto {
  @ApiProperty({ example: 'AGENT' }) code!: string;
  @ApiProperty({ example: 'Agent' }) label!: string;
  @ApiProperty({ enum: ['ab', 'aab', 'agent'] }) class!: 'ab' | 'aab' | 'agent';
}

class WaitingRowDto implements WaitingRow {
  @ApiProperty({ enum: ['invited', 'unplaced'], description: '*Diundang · <date>* or *Belum ada KPM*.' })
  kind!: 'invited' | 'unplaced';
  @ApiProperty({ type: String, nullable: true, description: '`invited`: what *Kirim ulang* and *Batalkan* write.' })
  invitationId!: string | null;
  @ApiProperty({ type: String, nullable: true, description: '`unplaced`: what *Masukkan* places.' }) userId!: string | null;
  @ApiProperty({ type: String, nullable: true, description: 'The pending membership of somebody registered to a KPM.' })
  membershipId!: string | null;
  @ApiProperty() fullName!: string;
  @ApiProperty({ type: String, nullable: true }) avatarUrl!: string | null;
  @ApiProperty({ type: String, nullable: true, description: '`unplaced` alone: the account’s email (ADR-0286 §5).' })
  email!: string | null;
  @ApiProperty({ type: WaitingCompanyDto, nullable: true }) company!: WaitingCompanyDto | null;
  @ApiProperty({
    type: WaitingKpmDto, nullable: true,
    description: '`invited`: the KPM invited to. `unplaced`: the KPM they registered to — *Masukkan* prefills it (OD-441) — '
      + 'or `null`.',
  })
  kpm!: WaitingKpmDto | null;
  @ApiProperty({ type: WaitingRoleDto, nullable: true }) role!: WaitingRoleDto | null;
  @ApiProperty({ example: '2026-11-22', description: 'When the invitation went, or the account registered (an office day).' })
  since!: string;
  @ApiProperty({ description: 'An invitation past its days: still *Diundang*; *Kirim ulang* revives it.' }) expired!: boolean;
  @ApiProperty() testAccount!: boolean;
  @ApiProperty({
    description: 'Whether there is a WhatsApp number to write to — never the number. An invitation always has one; an '
      + 'account, when its own number reads as one. The screen opens WhatsApp in the tap only when it is `true`; *Masukkan* '
      + 'answers the number.',
  })
  hasPhone!: boolean;
}

export class WaitingPageDto implements WaitingPage {
  @ApiProperty({ type: [WaitingRowDto] }) rows!: WaitingRowDto[];
  @ApiProperty({ example: 1 }) page!: number;
  @ApiProperty({ example: 50 }) pageSize!: number;
  @ApiProperty() total!: number;
  @ApiProperty({ type: AnggotaChipsDto }) chips!: AnggotaChipsDto;
}

/**
 * ***Menunggu*** (P19.28-T1 AC-5, T3; UI-209 (21 Nov); ADR-0286 §5): Anggota's second chip — the people who are not
 * *Aktif* yet, across KPMs. The Super Admin's alone, audited per read.
 */
@ApiTags('admin (Super Admin)')
@ApiBearerAuth()
@Controller('admin')
export class AnggotaWaitingController {
  constructor(private readonly waiting: AnggotaWaiting) {}

  @Get('waiting-members')
  @RequirePermission('platform_members:read')
  @ApiOperation({
    summary: 'Menunggu — who is not Aktif yet',
    description:
      `Anggota › *Menunggu*, ${PLATFORM_READ.PAGE_SIZE} a page, by name: **Diundang** — an invitation of *Tambah user* not `
      + 'accepted (its KPM, its rung and the day it went; ⋯ *Kirim ulang · Batalkan*) — and **Belum ada KPM** — an account '
      + 'registered and not placed, waiting in a KPM nobody placed them in or in none (its email, and the KPM it registered '
      + 'to, which *Masukkan* prefills, OD-441). One person once; somebody who left is under *Keluar*. With the three chips. '
      + '**Audited per read** as `platform_read.members_waiting` (ADR-0207 §5), in the platform’s log and each KPM’s whose '
      + 'rows it returned; a failure to write it fails the read.',
  })
  @ApiResponse({ status: 200, type: WaitingPageDto })
  @ApiResponse(refusal(400, '`VALIDATION_FAILED` — `q` shorter than two characters, an unknown `role`, a bad `page` or id.'))
  @ApiResponse(refusal(403, '`PERM_DENIED` — every tenant role, and a support session.'))
  @ApiResponse(refusal(500, '`INTERNAL_ERROR` — the read’s audit entries could not be written, so it is not served.'))
  async list(@Ctx() ctx: RequestContext, @Query() query: WaitingMembersQueryDto) {
    return this.waiting.page(ctx, query);
  }
}
