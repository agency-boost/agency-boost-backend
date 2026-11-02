import { Body, Controller, Get, HttpCode, HttpStatus, Param, Post, Put } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { Ctx, RequirePermission } from '@/common/auth/auth.decorators';
import { RequestContext } from '@/common/context/request-context';
import { ApiErrorEnvelope } from '@/common/errors/error-envelope.dto';
import { TickOwnActivationItemDto } from './activation-progress.dto';
import { ActivationClosingsDto, ActivationViewDto } from './activation-progress.response.dto';
import { ActivationProgressService } from './activation-progress.service';
import { ActivationItemRecords } from './activation-records.service';

/** A refusal the derived descriptions cannot know, in the shared envelope. */
const refusal = (status: number, description: string) => ({ status, description, type: ApiErrorEnvelope });

const NO_ACTIVATION =
  '`NOT_FOUND` — you have no activation: one starts when you join an office as an Agent under a leader. '
  + 'Answered exactly as a record in another office is.';

/**
 * **The hire's own 90-day activation** (`functional/activation.md`, the Data contract; roles §3.8): read it,
 * tick a manual item with a note and a date, and mark it complete. Every route is the reader's own; there
 * is no subject to name. A leader's side is `/new-hires`.
 */
@ApiTags('activation')
@ApiBearerAuth()
@Controller('activation')
export class ActivationProgressController {
  constructor(
    private readonly activation: ActivationProgressService,
    // P18.96-T4 AC-3: a tick of a data-backed item, with its record.
    private readonly records: ActivationItemRecords,
  ) {}

  @Get('me')
  @RequirePermission('activation:read')
  @ApiOperation({
    summary: 'Your 90-day activation',
    description:
      'Your checklist as it was published when you started, with what is done, when and by whom, your own '
      + 'note and date on each item, your start date, the office’s today, your day and window, each '
      + 'aspect’s status and the percentage — computed by the server, never in the browser — and your '
      + 'leader’s coaching note. Answered in any state: open, complete, or past its six months.',
  })
  @ApiResponse(refusal(404, NO_ACTIVATION))
  @ApiResponse({ status: 200, type: ActivationViewDto })
  async mine(@Ctx() ctx: RequestContext) {
    return this.activation.mine(ctx);
  }

  @Get('me/closings')
  @RequirePermission('activation:read')
  @ApiOperation({
    summary: 'Your closings',
    description:
      'Your sales leads that reached Paid and issued, newest first, with the day each first did: what *Which case?* '
      + 'offers when you tick *Close first case independently* or *Reach Independent Agent milestone* by hand.',
  })
  @ApiResponse(refusal(404, NO_ACTIVATION))
  @ApiResponse({ status: 200, type: ActivationClosingsDto })
  async closings(@Ctx() ctx: RequestContext) {
    return this.records.myClosings(ctx);
  }

  @Put('me/items/:code')
  @RequirePermission('activation:update_manual_item')
  @ApiOperation({
    summary: 'Tick or untick one of your items',
    description:
      'Sets one manual item done or not, with your optional note and date. An item that completes on its '
      + 'own — a goal, a lead, four weeks of activity — is never ticked by hand. **An item that completes from sales '
      + 'or coaching data is ticked with its record** (`record`): the closing it names — one of yours, or a new one '
      + 'logged in your leads — or your 1:1, its day and a note on the item. The tick and the record are saved together, '
      + 'and the tick reads *waiting for data* until the data confirms it.',
  })
  @ApiResponse(refusal(
    400,
    '`VALIDATION_FAILED` — a record on an item that takes none, a record of the wrong kind, or its day outside your '
    + 'join date to today; a new closing without a name, or a 1:1 without a note.',
  ))
  @ApiResponse(refusal(
    422,
    '`ACTIVATION_RECORD_REQUIRED` — a tick of an item that completes from sales or coaching data, sent without its '
    + 'record. `details.form` says which: `closing` or `one_on_one`.',
  ))
  @ApiResponse(refusal(
    404,
    '`NOT_FOUND` — you have no activation, or your checklist has no item with that code. Answered exactly as '
    + 'a record in another office is.',
  ))
  @ApiResponse(refusal(
    409,
    '`ACTIVATION_ITEM_AUTOMATIC` — the item completes on its own. `ACTIVATION_CLOSED` — your activation is '
    + 'complete, or its six months are over: nothing on it changes.',
  ))
  @ApiResponse({ status: 200, type: ActivationViewDto })
  async tick(
    @Ctx() ctx: RequestContext, @Param('code') code: string, @Body() body: TickOwnActivationItemDto,
  ) {
    return this.records.tickMine(ctx, code, body);
  }

  @Post('me/graduate')
  @HttpCode(HttpStatus.OK)
  @RequirePermission('activation:graduate')
  @ApiOperation({
    summary: 'Mark your checklist complete',
    description:
      'At 100% — every item done, the ones that complete on their own included. Who and when are kept. Your own '
      + 'declaration, so refused in a support session.',
  })
  @ApiResponse(refusal(404, NO_ACTIVATION))
  @ApiResponse(refusal(
    409,
    '`ACTIVATION_INCOMPLETE` — not every item is done yet; `details` says how many are. `ACTIVATION_CLOSED` — '
    + 'it is complete already, or its six months are over. `VERSION_CONFLICT` — an item was unticked and '
    + 'ticked again while it was being marked complete: read it again.',
  ))
  @ApiResponse({ status: 200, type: ActivationViewDto })
  async graduate(@Ctx() ctx: RequestContext) {
    return this.activation.graduate(ctx);
  }
}
