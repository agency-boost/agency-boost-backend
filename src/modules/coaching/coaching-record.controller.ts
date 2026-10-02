import { Controller, Get, Param } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { Ctx, RequirePermission } from '@/common/auth/auth.decorators';
import { RequestContext } from '@/common/context/request-context';
import { ApiErrorEnvelope } from '@/common/errors/error-envelope.dto';
import { MySessionsDto, SessionPrintDto } from './coaching-record.response.dto';
import { CoachingRecordService } from './coaching-record.service';

/**
 * **The record after the meeting** (`functional/coaching.md`, *Archive*, *`/coaching/me`*, *Exports*, and
 * the Data contract): a finalized session's print, and the reader's own coaching.
 *
 * Beside `CoachingController` rather than in it, under the same prefix. Neither path can shadow, or be
 * shadowed by, a route with a parameter there: `me/sessions` is two literal segments, and
 * `sessions/:sessionId/print` ends on one.
 */
@ApiTags('coaching')
@ApiBearerAuth()
@Controller('coaching')
export class CoachingRecordController {
  constructor(private readonly record: CoachingRecordService) {}

  @Get('me/sessions')
  @RequirePermission('coaching_session:read')
  @ApiOperation({
    summary: 'Your own coaching',
    description:
      'The finalized sessions about you, newest first, each with who led it, how many action items it '
      + 'agreed and how many of them the next session ticked done — a session being corrected as its latest '
      + 'finalized version, and never a draft. Read-only. Beside them, the finalized sessions you led with '
      + 'somebody you no longer coach, each with who it was about: yours to read, never to change. Your own '
      + 'record, so the read is not recorded. Not paginated.',
  })
  @ApiResponse({ status: 200, type: MySessionsDto })
  async mine(@Ctx() ctx: RequestContext) {
    return this.record.mine(ctx);
  }

  @Get('sessions/:sessionId/print')
  @RequirePermission('coaching_session:export_pdf')
  @ApiOperation({
    summary: 'Print a coaching session',
    description:
      '*⬇ Download as PDF*: the latest finalized version of a session, as the print holds it — last week’s '
      + 'items with their ticks, the goal as the 1:1 saw it, the coaching tips and the next actions with '
      + 'their leads. From what was frozen when it was finalized, so a goal, a lead or a day changed since '
      + 'does not reach it, and dated the day it was held. Nothing a leader keeps to themselves is in it. '
      + 'Read by the same people who read the session; a session being corrected prints the version the '
      + 'correction will replace. Every print is recorded, and a print by anybody but the person it is '
      + 'about is recorded as a read of their data as well.',
  })
  @ApiResponse({ status: 200, type: SessionPrintDto })
  @ApiResponse({
    status: 409,
    description:
      '`COACHING_SESSION_NOT_FINALIZED` — your draft has not been finalized yet, so there is nothing to '
      + 'print (`details.status`).',
    type: ApiErrorEnvelope,
  })
  async print(@Ctx() ctx: RequestContext, @Param('sessionId') sessionId: string) {
    return this.record.print(ctx, sessionId);
  }
}
