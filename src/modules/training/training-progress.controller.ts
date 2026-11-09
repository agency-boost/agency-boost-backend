import { Body, Controller, Get, HttpCode, HttpStatus, Param, Post, Put, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { AllowWhileReadOnly, Ctx, RequirePermission } from '@/common/auth/auth.decorators';
import { RequestContext } from '@/common/context/request-context';
import { ApiErrorEnvelope } from '@/common/errors/error-envelope.dto';
import {
  OpenTrainingItemDto, SetTrainingStatusDto, TrainingModuleQueryDto, TrainingProgressQueryDto,
} from './training-progress.dto';
import { TrainingModulePageDto, TrainingOpenDto, TrainingProgressDto } from './training-progress.response.dto';
import { TrainingProgressService } from './training-progress.service';

/** A refusal the derived descriptions cannot know, in the shared envelope. */
const refusal = (status: number, description: string) => ({ status, description, type: ApiErrorEnvelope });

const NOT_OFFERED =
  '`NOT_FOUND` — the module is not offered to you: a draft, withdrawn since the office last published, not yet '
  + 'published by the office, or no such module here. Answered exactly as a module in another office is.';

/**
 * **The learner's training** (P18.2-T1, T2, T4; `functional/training.md`, the Data contract; roles §3.7): the
 * catalog the office offers with the reader's statuses — or, with `for`, a coachee's — one module's page, an item
 * opened, and the status set.
 *
 * **No route takes a subject on a write**: nobody sets another person's status (roles §3.7; the coach's tab is
 * read-only). The office's own configuration of the catalog is `/kpm/settings/training`, the Owner's and the
 * Admins' (`training_settings:read`).
 */
@ApiTags('training')
@ApiBearerAuth()
@Controller('training')
export class TrainingProgressController {
  constructor(private readonly progress: TrainingProgressService) {}

  @Get('progress')
  @RequirePermission('training_progress:read')
  @ApiOperation({
    summary: 'The training offered, with your status on each module — or a coachee’s',
    description:
      'Every category the office offers, in order, each with its skills and their published modules, your status '
      + 'and the counts at every level (`TRAINING_COMPLETION_PCT`: offered modules only, *Done* only). With `for`, '
      + 'the same for somebody your grant reaches — the people you coach, or the office for its Owner and Admins — '
      + 'with the modules they did that are no longer offered; a read of somebody else’s writes one entry to the '
      + 'audit log, your own none.',
  })
  @ApiResponse(refusal(
    404,
    '`NOT_FOUND` — `for` names nobody your grant reaches: a peer’s agent for a leader, anybody else for an agent, '
    + 'or somebody in another office. The cases are deliberately indistinguishable. Your own membership reads your own.',
  ))
  @ApiResponse({ status: 200, type: TrainingProgressDto })
  async read(@Ctx() ctx: RequestContext, @Query() query: TrainingProgressQueryDto) {
    return this.progress.progress(ctx, query.for);
  }

  @Get('modules/:code')
  @RequirePermission('training_progress:read')
  @ApiOperation({
    summary: 'One module, as offered to you',
    description:
      'Its title, category and skill, its items — files, videos, links — your status, and the items you have opened. '
      + 'Content is what the office shows now; a title waits for the office’s publish.',
  })
  @ApiResponse(refusal(400, '`VALIDATION_FAILED` — a query parameter: the route takes none.'))
  @ApiResponse(refusal(404, NOT_OFFERED))
  @ApiResponse({ status: 200, type: TrainingModulePageDto })
  async module(
    @Ctx() ctx: RequestContext, @Param('code') code: string, @Query() _query: TrainingModuleQueryDto,
  ) {
    return this.progress.module(ctx, code);
  }

  /*
   * **A read by its permission, reachable by a read-only support session** (D-support): the session is answered
   * the address, as its member would be, and records nothing — the service writes the first open only for a
   * reader holding `training_progress:update`, which `can()` refuses in every support session.
   */
  @Post('modules/:code/items/:itemId/open')
  @HttpCode(HttpStatus.OK)
  @AllowWhileReadOnly()
  @RequirePermission('training_progress:read')
  @ApiOperation({
    summary: 'Open one item of a module',
    description:
      'A file or a video is answered an address signed for 300 seconds; a link, its own address. The first open is '
      + 'recorded, so the *Opened* mark survives a reload. Nothing is recorded in a support session.',
  })
  @ApiResponse(refusal(404, `${NOT_OFFERED} Or the item is not one of the module’s now.`))
  @ApiResponse(refusal(409, '`ASSET_NOT_CONFIRMED` — the file has not finished uploading.'))
  @ApiResponse({ status: 200, type: TrainingOpenDto })
  async open(
    @Ctx() ctx: RequestContext,
    @Param('code') code: string,
    @Param('itemId') itemId: string,
    @Body() _body: OpenTrainingItemDto,
  ) {
    return this.progress.open(ctx, code, itemId);
  }

  @Put('modules/:code/progress')
  @RequirePermission('training_progress:update')
  @ApiOperation({
    summary: 'Set your status on a module',
    description:
      '*Not started*, *In progress* or *Done* — set, never toggled, and your own word (nothing verifies it). *Done* '
      + 'back to *Not started* is allowed. A change is audited; marking a module *Done* completes an activation '
      + 'item bound to it. Refused in a support session.',
  })
  @ApiResponse(refusal(404, NOT_OFFERED))
  @ApiResponse({ status: 200, type: TrainingModulePageDto })
  async setStatus(
    @Ctx() ctx: RequestContext, @Param('code') code: string, @Body() body: SetTrainingStatusDto,
  ) {
    return this.progress.setStatus(ctx, code, body.status);
  }
}
