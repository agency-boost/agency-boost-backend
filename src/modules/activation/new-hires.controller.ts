import { Body, Controller, Get, Param, Put } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { Ctx, RequirePermission } from '@/common/auth/auth.decorators';
import { RequestContext } from '@/common/context/request-context';
import { ApiErrorEnvelope } from '@/common/errors/error-envelope.dto';
import {
  CorrectActivationStartDto, SaveActivationNoteDto, TickHireActivationItemDto,
} from './activation-progress.dto';
import {
  ActivationNoteSavedDto, ActivationViewDto, NewHiresRosterDto,
} from './activation-progress.response.dto';
import { NewHiresService } from './new-hires.service';

/** A refusal the derived descriptions cannot know, in the shared envelope. */
const refusal = (status: number, description: string) => ({ status, description, type: ApiErrorEnvelope });

const NOT_REACHED =
  '`NOT_FOUND` — nobody you coach with an activation: a peer’s hire, somebody in another team, a member who '
  + 'has left, yourself, or an id that is nobody’s — deliberately indistinguishable from one in another '
  + 'office: a `403` would confirm that somebody exists.';

const CLOSED = '`ACTIVATION_CLOSED` — the activation is complete, or its six months are over: nothing on it changes.';

/**
 * **A leader's new hires** (`functional/activation.md`, the Data contract; roles §3.8): the roster, one
 * hire's activation — which the coaching *Activation* tab reads too — a leader's tick, the start date's
 * correction and the coaching note. **Every route reaches only the hires the reader coaches now**
 * (`COACH`), and every read of a hire's activation is recorded.
 */
@ApiTags('activation')
@ApiBearerAuth()
@Controller('new-hires')
export class NewHiresController {
  constructor(private readonly hires: NewHiresService) {}

  @Get()
  @RequirePermission('new_hires:read_roster')
  @ApiOperation({
    summary: 'Your new hires',
    description:
      'The open activations of everybody you coach, at any depth: your direct unit first, then a card per '
      + 'leader below you, each hire under the nearest AAB above them. Rows by day, highest first, with the '
      + 'start date, the percentage, the day against the office’s window, and whether the first case is '
      + 'closed. Each hire shown is a recorded read.',
  })
  @ApiResponse(refusal(
    404,
    '`NOT_FOUND` — you coach nobody with an open activation, so there is no roster to show. Answered exactly '
    + 'as a record in another office is.',
  ))
  @ApiResponse({ status: 200, type: NewHiresRosterDto })
  async roster(@Ctx() ctx: RequestContext) {
    return this.hires.roster(ctx);
  }

  @Get(':membershipId')
  @RequirePermission('activation:read')
  @ApiOperation({
    summary: 'One hire’s activation',
    description:
      'As the hire reads it, in any state — without their own note and date on each item. The detail page, '
      + 'and a coaching page’s Activation tab. A recorded read.',
  })
  @ApiResponse(refusal(404, NOT_REACHED))
  @ApiResponse({ status: 200, type: ActivationViewDto })
  async detail(@Ctx() ctx: RequestContext, @Param('membershipId') membershipId: string) {
    return this.hires.detail(ctx, membershipId);
  }

  @Put(':membershipId/items/:code')
  @RequirePermission('activation:update_manual_item')
  @ApiOperation({
    summary: 'Tick or untick a hire’s item',
    description:
      'Sets one manual item of a hire you coach done or not, in your name. An item that completes on its own '
      + 'is never ticked by hand.',
  })
  @ApiResponse(refusal(404, `${NOT_REACHED} Or their checklist has no item with that code.`))
  @ApiResponse(refusal(409, `\`ACTIVATION_ITEM_AUTOMATIC\` — the item completes on its own. ${CLOSED}`))
  @ApiResponse({ status: 200, type: ActivationViewDto })
  async tick(
    @Ctx() ctx: RequestContext,
    @Param('membershipId') membershipId: string,
    @Param('code') code: string,
    @Body() body: TickHireActivationItemDto,
  ) {
    return this.hires.tick(ctx, membershipId, code, body.done);
  }

  @Put(':membershipId/start-date')
  @RequirePermission('activation:set_start_date')
  @ApiOperation({
    summary: 'Correct a hire’s start date',
    description:
      'The day their activation started, when it was not the day they joined here. The day and the end are '
      + 'recomputed; who corrected it and when are kept, and the old and new dates recorded.',
  })
  @ApiResponse(refusal(
    400,
    '`VALIDATION_FAILED` — not a day, a day after the office’s today, or more than 365 days before it.',
  ))
  @ApiResponse(refusal(404, NOT_REACHED))
  @ApiResponse(refusal(409, CLOSED))
  @ApiResponse({ status: 200, type: ActivationViewDto })
  async correctStart(
    @Ctx() ctx: RequestContext, @Param('membershipId') membershipId: string, @Body() body: CorrectActivationStartDto,
  ) {
    return this.hires.correctStart(ctx, membershipId, body.startDate);
  }

  @Put(':membershipId/note')
  @RequirePermission('activation_note:write')
  @ApiOperation({
    summary: 'Save your coaching note to a hire',
    description:
      'One note per hire, replacing the one before it, kept with who wrote it and when — and read by the hire '
      + 'on their own activation page.',
  })
  @ApiResponse(refusal(400, '`VALIDATION_FAILED` — empty once trimmed, or longer than 1,000 characters.'))
  @ApiResponse(refusal(404, NOT_REACHED))
  @ApiResponse(refusal(409, CLOSED))
  @ApiResponse({ status: 200, type: ActivationNoteSavedDto })
  async saveNote(
    @Ctx() ctx: RequestContext, @Param('membershipId') membershipId: string, @Body() body: SaveActivationNoteDto,
  ) {
    return this.hires.saveNote(ctx, membershipId, body.text);
  }
}
