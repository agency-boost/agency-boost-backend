import { Body, Controller, Delete, Get, HttpStatus, Param, Post, Put, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { Ctx, RequirePermission } from '@/common/auth/auth.decorators';
import { RequestContext } from '@/common/context/request-context';
import { ApiErrorEnvelope } from '@/common/errors/error-envelope.dto';
import { ChangeLeaderDto, LeaderChoicesQueryDto } from './leader-change.dto';
import { LeaderChangeService } from './leader-change.service';

/** The success, stated: Swagger drops the one it would infer once any response is declared. */
const OK = { status: HttpStatus.OK, description: '' };
const CREATED = { status: HttpStatus.CREATED, description: '' };

/** A refusal the derived descriptions cannot know, in the shared envelope. */
const refusal = (status: number, description: string) => ({ status, description, type: ApiErrorEnvelope });

const WHO =
  '`NOT_FOUND` — somebody in another office, or outside your downline as a leader, answered alike. ';
const WHO_409 =
  '`ORG_ALREADY_REMOVED` — they have left the office. `ORG_MEMBER_NOT_ACTIVE` — they have not joined yet. ';
const WHO_403 =
  '`PERM_DENIED` — the caller does not hold the permission. `ORG_LEADER_CHANGE_NOT_PERMITTED` — the office’s owner, '
  + 'whom only the platform moves; or, as a leader, somebody who is not your direct report.';

/**
 * **Changing who somebody reports to** (ADR-0247; the client's message of 11 November 2026, item 8): the picker's
 * leaders, a move made at once, a leader's request to the office for a move outside their tree, and withdrawing one.
 *
 * Its own controller, beside `OrgController` under `/members` and `TransferRequestsController` under
 * `/transfer-requests`: none of its paths is a single segment after the prefix, so none can be read as another route's
 * `:membershipId` or `:transferId`.
 */
@ApiTags('organisation')
@ApiBearerAuth()
@Controller()
export class LeaderChangeController {
  constructor(private readonly leaders: LeaderChangeService) {}

  @Get('members/:membershipId/leader-choices')
  @RequirePermission('member:reassign_leader')
  @ApiOperation({
    summary: 'The leaders somebody may be moved under',
    description:
      'By part of a name or an agent code (`q`). Never the person, anybody below them, their leader now, or anybody who '
      + 'cannot hold a unit (an Agent who leads nobody). The Owner and an Admin: the office, every one `direct`. An AB or '
      + 'an AAB, for a direct report: their own tree `direct` (moved at once), and the office’s ABs and AABs outside it '
      + '`direct: false` (asked of the Owner or an Admin). Moved-at-once first, then by name; at most 50.',
  })
  @ApiResponse(OK)
  @ApiResponse(refusal(404, WHO))
  @ApiResponse(refusal(409, WHO_409))
  @ApiResponse(refusal(403, WHO_403))
  async choices(
    @Ctx() ctx: RequestContext,
    @Param('membershipId') membershipId: string,
    @Query() query: LeaderChoicesQueryDto,
  ) {
    return this.leaders.choices(ctx, membershipId, query.q);
  }

  @Put('members/:membershipId/leader')
  @RequirePermission('member:reassign_leader')
  @ApiOperation({
    summary: 'Move somebody to another leader, now',
    description:
      'With everybody under them and their history: their open edge closes and a `re_parented` one opens at the same '
      + 'instant, every descendant’s path is re-spliced, and every leader above the old and the new position is '
      + 'recounted. The Owner and an Admin: anybody active but the office’s owner, under anybody who can hold a unit. An '
      + 'AB or an AAB: a direct report, under themselves or anybody below them — elsewhere is `403` with '
      + '`details.canRequest`, and `POST …/transfer-request` asks instead. The same leader again writes nothing. A '
      + 'transfer request still waiting for them is closed, and whoever asked is told. The person, the leader they left '
      + 'and the leader they joined are told. Answers the member as they now stand. Audited `member.leader_changed`.',
  })
  @ApiResponse(OK)
  @ApiResponse(refusal(400, '`VALIDATION_FAILED` — `leaderMembershipId` is not an id, or the reason is over 300 characters.'))
  @ApiResponse(refusal(404, WHO))
  @ApiResponse(refusal(
    409,
    `${WHO_409}\`ORG_CYCLE_DETECTED\` — the new leader is the person or somebody below them. \`VERSION_CONFLICT\` — `
    + 'the office’s tree has been busy for longer than a lease; try again.',
  ))
  @ApiResponse(refusal(
    403,
    `${WHO_403} \`ORG_LEADER_CHANGE_NOT_PERMITTED\` with \`details.canRequest\` — as a leader, a new leader outside `
    + 'your own tree.',
  ))
  @ApiResponse(refusal(
    422,
    '`ORG_LEADER_NOT_IN_KPM` — the new leader is not an active member of the office. `ORG_LEADER_CANNOT_LEAD` — an '
    + 'Agent who leads nobody.',
  ))
  async move(@Ctx() ctx: RequestContext, @Param('membershipId') membershipId: string, @Body() dto: ChangeLeaderDto) {
    return this.leaders.move(ctx, membershipId, dto.leaderMembershipId, dto.reason);
  }

  @Post('members/:membershipId/transfer-request')
  @RequirePermission('member:transfer_request')
  @ApiOperation({
    summary: 'Ask the office to move one of your people to a leader outside your tree',
    description:
      'An AB or an AAB, for a direct report. The person keeps reporting to you until the Owner or an Admin approves it '
      + 'on *All Members* › *Pending*; they are told, with where to and your note. Answers the move as it waits. Audited.',
  })
  @ApiResponse(CREATED)
  @ApiResponse(refusal(
    400,
    '`VALIDATION_FAILED` — the new leader is in your own tree (move them directly), or a field’s shape.',
  ))
  @ApiResponse(refusal(404, WHO))
  @ApiResponse(refusal(
    409,
    `${WHO_409}\`ORG_CYCLE_DETECTED\` — the new leader is the person or somebody below them. \`ORG_TRANSFER_PENDING\` — `
    + 'a transfer for them is already waiting.',
  ))
  @ApiResponse(refusal(403, WHO_403))
  @ApiResponse(refusal(
    422,
    '`ORG_LEADER_NOT_IN_KPM` — the new leader is not an active member of the office. `ORG_LEADER_CANNOT_LEAD` — an '
    + 'Agent who leads nobody.',
  ))
  async requestMove(
    @Ctx() ctx: RequestContext,
    @Param('membershipId') membershipId: string,
    @Body() dto: ChangeLeaderDto,
  ) {
    return this.leaders.requestMove(ctx, membershipId, dto.leaderMembershipId, dto.reason);
  }

  @Delete('transfer-requests/:transferId')
  @RequirePermission('member:transfer_request')
  @ApiOperation({
    summary: 'Withdraw a transfer request you asked for',
    description:
      'Nothing about the person changes; the request stays, cancelled. Only whoever asked: anybody else’s, and another '
      + 'office’s, is 404. Audited.',
  })
  @ApiResponse(OK)
  @ApiResponse(refusal(404, '`NOT_FOUND` — no request of yours with that id: somebody else’s, or one in another office, answered alike.'))
  @ApiResponse(refusal(409, '`ORG_REQUEST_ALREADY_DECIDED` — it was decided or withdrawn already, which way said.'))
  async cancel(@Ctx() ctx: RequestContext, @Param('transferId') transferId: string) {
    return this.leaders.cancelRequest(ctx, transferId);
  }
}
