import { Controller, Get, Param } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { Ctx, RequirePermission } from '@/common/auth/auth.decorators';
import { RequestContext } from '@/common/context/request-context';
import { MemberPerformanceDto } from './member-performance.response.dto';
import { MemberPerformanceService } from './member-performance.service';

/**
 * **A member's four tiles** (ADR-0205 §1–§2; `functional/org-hierarchy.md`, *The member page*). Its own controller on
 * the roster's prefix, beside `OrgController`: the figures are the Summary's, the Unit Dashboard's and coaching's, so the
 * service lives with the Summary, which reads all three already. A literal last segment, so `GET /members/:membershipId`
 * does not swallow it.
 */
@ApiTags('organisation')
@ApiBearerAuth()
@Controller('members')
export class MemberPerformanceController {
  constructor(private readonly performance: MemberPerformanceService) {}

  @Get(':membershipId/performance')
  @RequirePermission('member:read_performance')
  @ApiOperation({
    summary: 'How a member is doing: the four tiles of their page',
    description:
      'The member page’s tiles, each the figure another screen shows for the same person: *Aktivitas 7 hari* (what '
      + 'they logged over the last 7 days, as their coaching session’s Activity card counts it); *Produksi tahun ini* '
      + 'against their goal — **the office’s figure only, never the member’s own estimate**, and `null` while none is '
      + 'uploaded; *1:1 terakhir*, their latest finalized 1:1 as coachee; and *Leads* with *n closing*, this month, as '
      + 'their row on the Unit Dashboard reads. Served to the agency’s owner and its administrators for anybody in it, '
      + 'and to a leader for the people they coach. An Agent is refused (`403`). A read of somebody else’s writes one '
      + 'entry to the audit log.',
  })
  @ApiResponse({ status: 200, type: MemberPerformanceDto })
  async read(@Ctx() ctx: RequestContext, @Param('membershipId') membershipId: string) {
    return this.performance.read(ctx, membershipId);
  }
}
