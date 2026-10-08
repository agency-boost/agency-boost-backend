import { Body, Controller, Get, Param, Patch, Post, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { Ctx, RequirePermission } from '@/common/auth/auth.decorators';
import { RequestContext } from '@/common/context/request-context';
import { EventDto, EventTypeDto } from './event.response.dto';
import { EventService } from './event.service';
import { SaveEventDto, SaveEventTypeDto } from './event.dto';

/**
 * The events an office runs (P5-T6, ADR-0034).
 *
 * **Nothing per-person is here.** RSVP, attendance and feedback are each their own per-member
 * record in Phase 18.5 (P18.5-T5, P18.5-T6; were P14-T3, P14-T4); this is the office deciding what
 * is happening and who is invited.
 */
@ApiTags('tenant configuration')
@ApiBearerAuth()
@Controller('kpm/settings/events')
export class EventController {
  constructor(private readonly events: EventService) {}

  @Get('types')
  @RequirePermission('tenant_config:read')
  @ApiOperation({
    summary: 'The office’s event types',
    description: 'Each with how many events name it, so *Archive* can say what it affects.',
  })
  @ApiResponse({ status: 200, type: EventTypeDto, isArray: true })
  async listTypes(@Ctx() ctx: RequestContext, @Query('includeArchived') archived?: string) {
    return this.events.listTypes(ctx, archived === 'true');
  }

  @Post('types')
  @RequirePermission('tenant_config:write')
  @ApiOperation({ summary: 'Add an event type' })
  @ApiResponse({ status: 201, type: EventTypeDto })
  async createType(@Ctx() ctx: RequestContext, @Body() dto: SaveEventTypeDto) {
    return this.events.createType(ctx, dto);
  }

  @Patch('types/:id')
  @RequirePermission('tenant_config:write')
  @ApiOperation({
    summary: 'Change an event type',
    description: 'Never the code: an event that already happened points at it.',
  })
  @ApiResponse({ status: 200, type: EventTypeDto })
  async updateType(
    @Ctx() ctx: RequestContext, @Param('id') id: string, @Body() dto: SaveEventTypeDto,
  ) {
    return this.events.updateType(ctx, id, dto);
  }

  @Post('types/:id/archive')
  @RequirePermission('tenant_config:write')
  @ApiOperation({
    summary: 'Archive an event type',
    description:
      'The prototype’s control is a red **Delete**. An event that already happened renders the '
      + 'type it was, and a type that vanished would leave every one of those events describing '
      + 'nothing. Archiving keeps it readable and stops new events being filed under it.',
  })
  @ApiResponse({ status: 201, type: EventTypeDto })
  async archiveType(@Ctx() ctx: RequestContext, @Param('id') id: string) {
    return this.events.archiveType(ctx, id);
  }

  @Post('types/:id/restore')
  @RequirePermission('tenant_config:write')
  @ApiOperation({ summary: 'Bring an event type back' })
  @ApiResponse({ status: 201, type: EventTypeDto })
  async restoreType(@Ctx() ctx: RequestContext, @Param('id') id: string) {
    return this.events.restoreType(ctx, id);
  }

  @Get()
  @RequirePermission('tenant_config:read')
  @ApiOperation({
    summary: 'The office’s events',
    description:
      'In start order, each with its phase **derived now** — upcoming, running or past — and the '
      + 'calendar day in the office’s own timezone, so no browser re-derives it in its own.',
  })
  @ApiResponse({ status: 200, type: EventDto, isArray: true })
  async list(@Ctx() ctx: RequestContext, @Query('includeArchived') archived?: string) {
    return this.events.list(ctx, archived === 'true');
  }

  @Post()
  @RequirePermission('tenant_config:write')
  @ApiOperation({
    summary: 'Add an event',
    description:
      '`endsAt` is required and must be after `startsAt`: without an end, *"is it running now?"* '
      + 'has no answer and a status has to be typed in by hand, which is the prototype’s defect.',
  })
  @ApiResponse({ status: 201, type: EventDto })
  async create(@Ctx() ctx: RequestContext, @Body() dto: SaveEventDto) {
    return this.events.create(ctx, dto);
  }

  @Patch(':id')
  @RequirePermission('tenant_config:write')
  @ApiOperation({ summary: 'Change an event' })
  @ApiResponse({ status: 200, type: EventDto })
  async update(@Ctx() ctx: RequestContext, @Param('id') id: string, @Body() dto: SaveEventDto) {
    return this.events.update(ctx, id, dto);
  }

  @Post(':id/archive')
  @RequirePermission('tenant_config:write')
  @ApiOperation({ summary: 'Archive an event' })
  @ApiResponse({ status: 201, type: EventDto })
  async archive(@Ctx() ctx: RequestContext, @Param('id') id: string) {
    return this.events.archive(ctx, id);
  }

  @Post(':id/restore')
  @RequirePermission('tenant_config:write')
  @ApiOperation({ summary: 'Bring an event back' })
  @ApiResponse({ status: 201, type: EventDto })
  async restore(@Ctx() ctx: RequestContext, @Param('id') id: string) {
    return this.events.restore(ctx, id);
  }
}
