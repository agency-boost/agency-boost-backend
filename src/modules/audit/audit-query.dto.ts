import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsMongoId, IsOptional, IsString, Matches, MaxLength } from 'class-validator';
import { field } from '@/common/validation/violations';
import { AUDIT_LOG } from '@/domain/constants';
import { AUDIT_REFUSALS } from './audit.messages';

const SAY = AUDIT_REFUSALS.VALIDATION_FAILED;

/** A day on the office's calendar. */
const DAY = /^\d{4}-\d{2}-\d{2}$/;

/** An action's dotted name, as `AuditService.record` writes it: `company.created`, `company_template.draft_saved`. */
const ACTION = /^[a-z][a-z0-9_]*(\.[a-z0-9_]+)+$/;

/** The cursor's alphabet: base64url, which `encodeCursor` writes. */
const CURSOR = /^[A-Za-z0-9_-]+$/;

/**
 * **The audit page's query** (P19.2-T2 AC-6; UI-132, its Appendix D row; `metrics-and-definitions.md` §B.32): the reach,
 * the filters and the cursor, and nothing else — a parameter of any other name is refused by name, and every field is a
 * string, so an operator smuggled into one (`?kpmId[$ne]=…`) is `400` before a query is built.
 *
 * Every filter narrows **within the reach**: a Super Admin's chosen scope, or an Owner's or an Admin's own office whatever
 * they pass. The filters combine; each one absent narrows nothing.
 */
export class AuditQueryDto {
  @ApiPropertyOptional({
    description:
      'Super Admin only: the scope — one office. Omitted reads the platform-level log (provisioning, companies, '
      + 'templates, products, support sessions). Ignored for anyone else, who always reads their own office.',
  })
  @IsOptional()
  @IsString()
  @IsMongoId()
  kpmId?: string;

  @ApiPropertyOptional({
    description:
      'Rows of one company, within the scope: a row in one of its offices, a row whose target is the company, or a row '
      + 'whose change names it (`after.companyId` or `before.companyId` — its products, templates and ladder).',
  })
  @IsOptional()
  @IsString()
  @IsMongoId()
  companyId?: string;

  @ApiPropertyOptional({ example: 'company_template.draft_saved', maxLength: 80, description: 'One action, by its name.' })
  @IsOptional()
  @IsString()
  @MaxLength(80)
  @Matches(ACTION, { message: field(SAY.actionShape) })
  action?: string;

  @ApiPropertyOptional({
    description: 'One actor: the account that acted (the real one; in a support session, the Super Admin).',
  })
  @IsOptional()
  @IsString()
  @IsMongoId()
  actorUserId?: string;

  @ApiPropertyOptional({
    example: '2026-11-01',
    description: 'The first day to read, on the office’s calendar (Asia/Jakarta in v1), inclusive.',
  })
  @IsOptional()
  @IsString()
  @Matches(DAY, { message: field(SAY.dateShape) })
  from?: string;

  @ApiPropertyOptional({
    example: '2026-11-02',
    description: 'The last day to read, on the office’s calendar, inclusive. On or after `from`, or `400`.',
  })
  @IsOptional()
  @IsString()
  @Matches(DAY, { message: field(SAY.dateShape) })
  to?: string;

  @ApiPropertyOptional({
    maxLength: 200,
    description:
      `The \`nextCursor\` the previous page returned. Omitted, the newest ${AUDIT_LOG.PAGE_SIZE} groups. It names the `
      + 'last row that page read, by its time and id, so rows written while somebody reads never move a page they have '
      + 'not opened yet. Anything else is `400`.',
  })
  @IsOptional()
  @IsString()
  @MaxLength(200)
  @Matches(CURSOR, { message: field(SAY.cursorShape) })
  cursor?: string;
}
