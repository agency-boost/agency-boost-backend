import { Controller, Get, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiPropertyOptional, ApiResponse, ApiTags } from '@nestjs/swagger';
import { IsOptional, IsString, MaxLength } from 'class-validator';
import { Ctx, RequirePermission } from '@/common/auth/auth.decorators';
import { RequestContext } from '@/common/context/request-context';
import { ApiErrorEnvelope } from '@/common/errors/error-envelope.dto';
import { SummaryDto } from './summary.response.dto';
import { SummaryService } from './summary.service';

/**
 * **`for`, and nothing else** (P11-T4): whose Summary. The validation pipe refuses a parameter of any
 * other name by name — a `membershipId` included — rather than ignoring it.
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
      + 'your goal, the office’s production and your own log. With `for`, the same page **computed for '
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
  async read(@Ctx() ctx: RequestContext, @Query() query: SummaryQueryDto) {
    return this.summary.read(ctx, query.for);
  }
}
