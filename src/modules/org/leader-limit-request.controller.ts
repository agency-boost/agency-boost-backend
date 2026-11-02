import { Body, Controller, Get, HttpCode, HttpStatus, Param, Post } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { Ctx, RequirePermission } from '@/common/auth/auth.decorators';
import { RequestContext } from '@/common/context/request-context';
import { DeclineLeaderLimitRequestDto } from './org.dto';
import { LeaderLimitRequestService } from './leader-limit-request.service';

/**
 * **The Super Admin's queue of leaders past an office's limit** (ADR-0157 §3), modelled on the KPM request
 * queue. The office asks under `/members`; AgencyBoost decides here. Approving carries the act out past the
 * limit, in the request's office and no other; declining changes nothing about the member.
 */
@ApiTags('admin (Super Admin)')
@ApiBearerAuth()
@Controller('admin/leader-limit-requests')
export class LeaderLimitRequestAdminController {
  constructor(private readonly requests: LeaderLimitRequestService) {}

  @Get()
  @RequirePermission('leader_limit_request:read')
  @ApiOperation({
    summary: 'Leaders waiting past their office’s limit',
    description:
      'Every office’s requests, pending first, each with the office’s limit and Leaders used now. The ' +
      'Super Admin’s alone: an office’s own Owner reads their office’s at /members/leader-limit-requests.',
  })
  async queue(@Ctx() ctx: RequestContext) {
    return this.requests.queue(ctx);
  }

  @Post(':requestId/approve')
  @HttpCode(HttpStatus.OK)
  @RequirePermission('leader_limit_request:decide')
  @ApiOperation({
    summary: 'Approve a leader past the office’s limit',
    description:
      'Re-checks that the act still applies — the member live and on the rung they stood on, still pending ' +
      'for an activation — and carries it out past the limit, under the office’s leader lease; the limit ' +
      'does not move. A request that no longer applies is 409 LEADER_LIMIT_REQUEST_STALE and is closed as ' +
      'declined. One already decided is 409 LEADER_LIMIT_REQUEST_DECIDED. Whoever asked is notified.',
  })
  async approve(@Ctx() ctx: RequestContext, @Param('requestId') requestId: string) {
    return this.requests.approve(ctx, requestId);
  }

  @Post(':requestId/decline')
  @HttpCode(HttpStatus.OK)
  @RequirePermission('leader_limit_request:decide')
  @ApiOperation({
    summary: 'Decline a leader past the office’s limit',
    description: 'Nothing about the member changes. The reason is required, and is sent to whoever asked.',
  })
  async decline(
    @Ctx() ctx: RequestContext,
    @Param('requestId') requestId: string,
    @Body() dto: DeclineLeaderLimitRequestDto,
  ) {
    return this.requests.decline(ctx, requestId, dto);
  }
}
