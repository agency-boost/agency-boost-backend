import { Controller, Get, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiPropertyOptional, ApiResponse, ApiTags } from '@nestjs/swagger';
import { IsOptional, IsString, Matches, MaxLength } from 'class-validator';
import { Ctx, RequirePermission } from '@/common/auth/auth.decorators';
import { RequestContext } from '@/common/context/request-context';
import { ApiErrorEnvelope } from '@/common/errors/error-envelope.dto';
import { SummaryDto } from './summary.response.dto';
import { SummaryService } from './summary.service';

/**
 * **`for`** (P11-T4): whose Summary; **`month` or `year`** (P18.8-T11, ADR-0161 §4): which period. The validation
 * pipe refuses a parameter of any other name by name — a `membershipId` included — rather than ignoring it, and
 * a malformed month or year. Which months and years there are is the service's to decide (`summaryPeriod`).
 */
export class SummaryQueryDto {
  @ApiPropertyOptional({
    maxLength: 64,
    description:
      'The **membership** whose Summary to read. Omitted, or your own, it is yours. Anybody else is '
      + 'read as far as your grant reaches: the people you coach, or the whole agency for its owner and '
      + 'its administrators. Every read of somebody else’s is recorded.',
  })
  @IsOptional() @IsString() @MaxLength(64)
  for?: string;

  @ApiPropertyOptional({
    pattern: '^\\d{4}-(0[1-9]|1[0-2])$',
    example: '2026-08',
    description:
      'A month to look back on, `YYYY-MM`, read **whole**: *Monthly* is that month, *Yearly* its year. From the '
      + 'office’s first month to this one; the future, or a month before the office, is `400`. Omitted, it is '
      + 'this month. Not with `year`.',
  })
  @IsOptional() @IsString() @Matches(/^\d{4}-(0[1-9]|1[0-2])$/, { message: 'month must be a month, YYYY-MM' })
  month?: string;

  @ApiPropertyOptional({
    pattern: '^\\d{4}$',
    example: '2025',
    description:
      'A year to look back on, `YYYY`, read **whole**: *Yearly* is that year, *Monthly* its December — or, for '
      + 'this year, this month. From the office’s first year to this one; the future, or a year before the '
      + 'office, is `400`. Not with `month`.',
  })
  @IsOptional() @IsString() @Matches(/^\d{4}$/, { message: 'year must be a year, YYYY' })
  year?: string;
}

/** The Personal Summary (P10), and a leader's copy of a coachee's (P11-T4). */
@ApiTags('summary')
@ApiBearerAuth()
@Controller('summary')
export class SummaryController {
  constructor(private readonly summary: SummaryService) {}

  @Get()
  @RequirePermission('personal_summary:read')
  @ApiOperation({
    summary: 'A Personal Summary: yours, or somebody’s you may read',
    description:
      'Your goal against what you produced, this month and this year, the gap, and the pace — read from '
      + 'your goal, the office’s production and your own log. With `month` or `year`, an earlier month or year, '
      + 'read whole, with no pace (ADR-0161). With `for`, the same page **computed for '
      + 'that person**: their goal, their production and whose figure it is, their log, their leads, their '
      + 'compliance, and their rung for the sections and the ratios. A read of somebody else’s writes '
      + 'one entry to the audit log; your own writes none.',
  })
  @ApiResponse({ status: 200, type: SummaryDto })
  /*
   * A path parameter is what makes `openapi.ts` derive a 404, and this route has none: the subject is a
   * query field. So the refusal is written here, worded as every 404 in the document is.
   */
  @ApiResponse({
    status: 404,
    description:
      '`NOT_FOUND` — `for` names nobody you may read, **or** somebody in another office. The two are '
      + 'deliberately indistinguishable: a `403` here would confirm the id exists.',
    type: ApiErrorEnvelope,
  })
  @ApiResponse({
    status: 400,
    description:
      '`VALIDATION_FAILED` — a parameter other than `for`, `month` and `year`; a malformed `month` or `year`; both '
      + 'together; or one in the future or before the office’s first month, with `details.field`, `earliest` and '
      + '`latest`.',
    type: ApiErrorEnvelope,
  })
  async read(@Ctx() ctx: RequestContext, @Query() query: SummaryQueryDto) {
    return this.summary.read(ctx, query.for, { month: query.month, year: query.year });
  }
}
