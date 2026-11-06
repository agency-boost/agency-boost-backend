import { Body, Controller, Param, Put } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiProperty, ApiResponse, ApiTags } from '@nestjs/swagger';
import { IsBoolean } from 'class-validator';
import { Ctx, RefuseInSupportSession, RequirePermission } from '@/common/auth/auth.decorators';
import { RequestContext } from '@/common/context/request-context';
import { ApiErrorEnvelope } from '@/common/errors/error-envelope.dto';
import { CoachingActionDone, type CoachingItemDoneView } from './coaching-action-done.service';

/** *Selesai* or *Urungkan*: the whole state, every time. */
export class CoachingItemDoneDto {
  @ApiProperty({ type: Boolean, description: '`true` ticks the item done; `false` takes the tick back (*Urungkan*).' })
  @IsBoolean()
  done!: boolean;
}

export class CoachingItemDoneResponseDto implements CoachingItemDoneView {
  @ApiProperty()
  sessionId!: string;

  @ApiProperty()
  itemId!: string;

  @ApiProperty({ description: 'Where the item stands now.' })
  done!: boolean;
}

/**
 * **A coachee's tick on an action item** (UI V1, UI-104 point 4; `functional/coaching.md`, *UI V1*). Its own controller
 * beside `CoachingController`: the calendar's *Tugas* is its one caller, and the session's own routes stay the coach's.
 * Held to `calendar_entry:update` — the coachee's write on their own calendar, `own` for an AB, an AAB and an Agent —
 * and **refused in every support session, an elevated one included** (the Phase 18.11 exit review, L3): ticking an item
 * done is the coachee's own declaration that they did it, as `training_progress:update` and `event:rsvp` are, and
 * nobody acting as them makes it.
 */
@ApiTags('coaching')
@ApiBearerAuth()
@Controller('coaching')
export class CoachingActionDoneController {
  constructor(private readonly done: CoachingActionDone) {}

  @Put('sessions/:sessionId/action-items/:itemId/done')
  @RequirePermission('calendar_entry:update')
  @RefuseInSupportSession()
  @ApiOperation({
    summary: 'Tick one of your coaching action items done, or take the tick back',
    description:
      'Your own action item — one a finalized session you were coached in agreed — ticked done from your Calendar, or '
      + 'the tick taken back. It leaves your Calendar while ticked, and the next session with you starts with it ticked '
      + 'in its review. Nothing that was agreed changes and no version moves. Sending what is stored changes nothing. '
      + '**Refused in any support session**, `403 IMPERSONATION_READ_ONLY` as every write of one is (ADR-0206): the tick '
      + 'is the coachee’s own.',
  })
  @ApiResponse({
    status: 404,
    type: ApiErrorEnvelope,
    description:
      '`NOT_FOUND` — not a finalized session you were coached in, or no such item in it: a session of somebody else’s '
      + '(your coachee’s included), a draft, another office’s, or nobody’s id.',
  })
  @ApiResponse({ status: 200, type: CoachingItemDoneResponseDto })
  async set(
    @Ctx() ctx: RequestContext,
    @Param('sessionId') sessionId: string,
    @Param('itemId') itemId: string,
    @Body() body: CoachingItemDoneDto,
  ) {
    return this.done.set(ctx, sessionId, itemId, body.done);
  }
}
