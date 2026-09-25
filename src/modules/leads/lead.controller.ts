import { Body, Controller, Delete, Get, Param, Patch, Post, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { Ctx, RequirePermission } from '@/common/auth/auth.decorators';
import { RequestContext } from '@/common/context/request-context';
import {
  CreateLeadDto, ListLeadsQueryDto, SetLeadOutcomeDto, SetLeadStatusDto, UpdateLeadDto,
} from './lead.dto';
import { DeletedLeadDto, LeadPageDto, LeadResponseDto } from './lead.response.dto';
import { LeadService } from './lead.service';

/**
 * One person an agent is working (P7-T2, P7-T3).
 *
 * **Six routes, one screen.** Everything here is called by `/leads`; nothing is an endpoint
 * waiting for a consumer, which is the rule `check-api-consumers.py` enforces and the reason
 * P7-T1 shipped with none at all.
 *
 * **Moving and closing are separate routes on separate permissions**, because they are separate
 * acts: a status says where somebody is, an outcome says the work stopped and how it ended. The
 * prototype puts them side by side as a dropdown and two buttons, which is the same distinction
 * drawn in pixels.
 */
@ApiTags('leads')
@ApiBearerAuth()
@Controller('leads')
export class LeadController {
  constructor(private readonly leads: LeadService) {}

  @Get()
  @RequirePermission('lead:read')
  @ApiOperation({
    summary: 'Your leads',
    description:
      'Search over the name and the remarks, filter by ladder, stage, outcome and attention '
      + 'state, sort on one key, and page. The prototype has none of these on the screen with the '
      + 'most rows. **Your own leads**: a leader reading a downline’s is P7-T7.',
  })
  @ApiResponse({ status: 200, type: LeadPageDto })
  async list(@Ctx() ctx: RequestContext, @Query() query: ListLeadsQueryDto) {
    return this.leads.list(ctx, query);
  }

  @Get(':id')
  @RequirePermission('lead:read')
  @ApiOperation({ summary: 'One lead', description: '**404, not 403**, for another office’s.' })
  @ApiResponse({ status: 200, type: LeadResponseDto })
  async read(@Ctx() ctx: RequestContext, @Param('id') id: string) {
    return this.leads.read(ctx, id);
  }

  @Post()
  @RequirePermission('lead:create')
  @ApiOperation({
    summary: 'Add a lead',
    description:
      'A name is enough. **Contact details need a recorded lawful basis** (UU 27/2022) — '
      + '`LEAD_CONSENT_REQUIRED`. The lead starts on no stage: the first one is a move.',
  })
  @ApiResponse({ status: 201, type: LeadResponseDto })
  async create(@Ctx() ctx: RequestContext, @Body() body: CreateLeadDto) {
    return this.leads.create(ctx, body);
  }

  @Patch(':id')
  @RequirePermission('lead:update')
  @ApiOperation({
    summary: 'Change a lead',
    description:
      'Any of the fields creation takes, one or several. **Not the stage** — that is its own '
      + 'route. Clearing the lawful basis on a lead that still holds contact details is refused, '
      + 'because it is the same act as adding them without one.',
  })
  @ApiResponse({ status: 200, type: LeadResponseDto })
  async update(@Ctx() ctx: RequestContext, @Param('id') id: string, @Body() body: UpdateLeadDto) {
    return this.leads.update(ctx, id, body);
  }

  @Patch(':id/status')
  @RequirePermission('lead:update')
  @ApiOperation({
    summary: 'Move a lead along its ladder',
    description:
      'Any **active** stage of its own pipeline, at any time (ADR-0045): `rank` is presentation '
      + 'and reorderable, so a forward-only rule would let a drag on the Owner’s settings screen '
      + 'change which moves their agents may make. Refused for the other ladder '
      + '(`LEAD_STATUS_WRONG_PIPELINE`), for a retired stage (`CONFIG_ARCHIVED`), and for a lead '
      + 'that is already closed (`LEAD_ALREADY_CLOSED`). Every move is appended to the history.',
  })
  @ApiResponse({ status: 200, type: LeadResponseDto })
  async setStatus(
    @Ctx() ctx: RequestContext, @Param('id') id: string, @Body() body: SetLeadStatusDto,
  ) {
    return this.leads.setStatus(ctx, id, body.statusCode);
  }

  @Patch(':id/outcome')
  @RequirePermission('lead:mark_outcome')
  @ApiOperation({
    summary: 'Close a lead, or reopen it',
    description:
      '`won` needs the stage that closes the pipeline (`LEAD_STATUS_NOT_FINAL` otherwise); '
      + '`lost` is allowed at any stage; `null` reopens. The two prototype screens disagree about '
      + 'the second and the stricter reading of each half is taken (§3.7).',
  })
  @ApiResponse({ status: 200, type: LeadResponseDto })
  async setOutcome(
    @Ctx() ctx: RequestContext, @Param('id') id: string, @Body() body: SetLeadOutcomeDto,
  ) {
    return this.leads.setOutcome(ctx, id, body.outcome);
  }

  @Delete(':id')
  @RequirePermission('lead:delete')
  @ApiOperation({
    summary: 'Remove a lead',
    description:
      '**Soft**, and the owner’s alone (§3.7). Nothing is removed; erasure under PDP is a '
      + 'deliberate, audited, cascading operation and not this button.',
  })
  @ApiResponse({ status: 200, type: DeletedLeadDto })
  async remove(@Ctx() ctx: RequestContext, @Param('id') id: string) {
    return this.leads.remove(ctx, id);
  }
}
