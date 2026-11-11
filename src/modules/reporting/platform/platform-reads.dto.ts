import { ApiPropertyOptional } from '@nestjs/swagger';
import { Transform, Type } from 'class-transformer';
import { IsIn, IsInt, IsMongoId, IsOptional, IsString, Matches, MaxLength, Min } from 'class-validator';
import { field } from '@/common/validation/violations';
import {
  KPM_COMPARISON_SORTS, PLATFORM_ACCOUNT_KPM_FILTERS, PLATFORM_MEMBER_ROLES, PLATFORM_MEMBER_STATUSES,
  type PlatformAccountKpmFilter, type PlatformMemberRole, type PlatformMemberStatus,
} from '@/domain/constants';
import { PLATFORM_READS_REFUSALS } from './platform-reads.messages';

const SAY = PLATFORM_READS_REFUSALS.VALIDATION_FAILED;

/** `GET /admin/members` (ADR-0207 §2): every filter on the server, 50 a page. */
export class PlatformMembersQueryDto {
  @ApiPropertyOptional({ description: 'One company’s KPMs.' })
  @IsOptional()
  @IsString()
  @IsMongoId({ message: field(SAY.idShape) })
  companyId?: string;

  @ApiPropertyOptional({ description: 'One KPM — the *Anggota* tab of `/admin/tenants/[kpmId]`.' })
  @IsOptional()
  @IsString()
  @IsMongoId({ message: field(SAY.idShape) })
  kpmId?: string;

  @ApiPropertyOptional({
    enum: PLATFORM_MEMBER_ROLES,
    description: 'A class of the ladder — `ab` the *Senior Leader* rungs, `aab` the *Associate Leader*, `agent` the rest '
      + '(ADR-0156), whatever each company calls them. Upper case is read as lower (`?role=AB`).',
  })
  @IsOptional()
  @Transform(({ value }) => (typeof value === 'string' ? value.toLowerCase() : value))
  @IsIn(PLATFORM_MEMBER_ROLES, { message: field(SAY.roleShape) })
  role?: PlatformMemberRole;

  @ApiPropertyOptional({ enum: PLATFORM_MEMBER_STATUSES, description: 'Every status when absent.' })
  @IsOptional()
  @IsIn(PLATFORM_MEMBER_STATUSES, { message: field(SAY.statusShape) })
  status?: PlatformMemberStatus;

  @ApiPropertyOptional({
    minLength: 2, maxLength: 100,
    description: 'A name, a phone number or an email address, matched in part. **Neither the phone nor the email is '
      + 'returned**: the row says only who and where. Shorter than two characters is `400`.',
  })
  @IsOptional()
  @IsString()
  @MaxLength(100)
  q?: string;

  @ApiPropertyOptional({ minimum: 1, default: 1 })
  @IsOptional()
  @Type(() => Number)
  @IsInt({ message: field(SAY.pageShape) })
  @Min(1, { message: field(SAY.pageShape) })
  page?: number;
}

/**
 * `GET /admin/users` (ADR-0245 §1): every registered account, a KPM or none — searched by a name or an email, filtered by
 * whether it holds a KPM, 50 a page, on the server.
 */
export class PlatformAccountsQueryDto {
  @ApiPropertyOptional({
    minLength: 2, maxLength: 100,
    description: 'A name or an email address, matched in part. Shorter than two characters is `400`.',
  })
  @IsOptional()
  @IsString()
  @MaxLength(100)
  q?: string;

  @ApiPropertyOptional({
    enum: PLATFORM_ACCOUNT_KPM_FILTERS,
    description: '`none`, *Tanpa KPM*: no active or pending membership in any KPM (a membership that ended counts as '
      + 'none). `some`, *Punya KPM*: at least one. Every account when absent.',
  })
  @IsOptional()
  @IsIn(PLATFORM_ACCOUNT_KPM_FILTERS, { message: field(SAY.kpmShape) })
  kpm?: PlatformAccountKpmFilter;

  @ApiPropertyOptional({ minimum: 1, default: 1 })
  @IsOptional()
  @Type(() => Number)
  @IsInt({ message: field(SAY.pageShape) })
  @Min(1, { message: field(SAY.pageShape) })
  page?: number;
}

/** `GET /admin/analytics/kpms` (ADR-0207 §2, §7): filterable by company, sortable, no benchmark. */
export class KpmComparisonQueryDto {
  @ApiPropertyOptional({ description: 'One company’s KPMs.' })
  @IsOptional()
  @IsString()
  @IsMongoId({ message: field(SAY.idShape) })
  companyId?: string;

  @ApiPropertyOptional({
    example: '-production',
    description: `A column — ${KPM_COMPARISON_SORTS.join(', ')} — ascending, or after \`-\` descending. A KPM with no `
      + 'figure for the column is last either way. `kpm` when absent.',
  })
  @IsOptional()
  @IsString()
  @MaxLength(40)
  sort?: string;

  @ApiPropertyOptional({ minimum: 1, default: 1 })
  @IsOptional()
  @Type(() => Number)
  @IsInt({ message: field(SAY.pageShape) })
  @Min(1, { message: field(SAY.pageShape) })
  page?: number;
}

/** `GET /admin/companies/:companyId/kpms` (ADR-0207 §2): the month, the latest held when absent. */
export class CompanyKpmsQueryDto {
  @ApiPropertyOptional({ example: '2026-10', description: 'The month, `YYYY-MM`; the latest any KPM uploaded when absent.' })
  @IsOptional()
  @IsString()
  @Matches(/^\d{4}-(0[1-9]|1[0-2])$/, { message: field(SAY.monthShape) })
  month?: string;
}

/** `GET /admin/tenants/:id/data`: no parameter. */
export class KpmDataQueryDto {}
