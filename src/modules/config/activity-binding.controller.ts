import { Body, Controller, Get, Param, Put } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { Ctx, RequirePermission } from '@/common/auth/auth.decorators';
import { RequestContext } from '@/common/context/request-context';
import { ActivityBindingService } from './activity-binding.service';
import { UpdateActivityBindingDto } from './activity-binding.dto';

/**
 * **One office's activity binding, kept by the Super Admin** (ADR-0163 §3): which activity types each cascade role
 * counts — *Set appointment*, *Sales meeting*, *Submission polis*. The card on `/admin/tenants/[kpmId]`.
 *
 * Its own controller under `/admin`, beside the console's, because it reads and writes office configuration
 * through `ActivityBindingService`'s named cross-tenant methods and nothing of the console's.
 */
@ApiTags('admin (Super Admin)')
@ApiBearerAuth()
@Controller('admin')
export class ActivityBindingAdminController {
  constructor(private readonly bindings: ActivityBindingService) {}

  @Get('tenants/:kpmId/activity-binding')
  @RequirePermission('activity_binding:read')
  @ApiOperation({
    summary: 'Read an office’s activity binding',
    description:
      'Which of the office’s activity types each cascade role counts — `leads` (*Set appointment*), '
      + '`appointments` (*Sales meeting*), `closings` (*Submission polis*) — with its version, and every '
      + 'activity type the office holds, archived ones included, that a role may name. A version of 0 is an '
      + 'office with no binding yet, which counts the default binding. Super Admin only, read through a named '
      + 'cross-tenant method that reads configuration alone. An unknown office is 404.',
  })
  async read(@Ctx() ctx: RequestContext, @Param('kpmId') kpmId: string) {
    return this.bindings.readForOffice(ctx, kpmId);
  }

  @Put('tenants/:kpmId/activity-binding')
  @RequirePermission('activity_binding:write')
  @ApiOperation({
    summary: 'Set an office’s activity binding',
    description:
      'The whole binding, every time: each role a list of the office’s activity type codes, summed — '
      + 'replacing an activity is `[A]` → `[A, B]`, so the old code’s history keeps counting and the new one '
      + 'counts from now. Every code must be one of that office’s activity types (archived allowed, its history '
      + 'counts); an unknown code, an empty role or a code in two roles is 400 VALIDATION_FAILED. A stale '
      + '`expectedVersion` is 409 VERSION_CONFLICT. Takes effect when saved: the summary, the pace, the Unit '
      + 'Dashboard, coaching, the measured rates and the campaigns read it from then. A goal’s stored '
      + '`cascadeMapping` and coaching snapshots are not changed. Super Admin only; audited '
      + '`activity_binding.updated` with the binding before and after. An unknown office is 404.',
  })
  async update(
    @Ctx() ctx: RequestContext,
    @Param('kpmId') kpmId: string,
    @Body() dto: UpdateActivityBindingDto,
  ) {
    return this.bindings.updateForOffice(ctx, kpmId, dto as unknown as Record<string, unknown>);
  }
}

/** **The office's own binding, read by its Owner and Admin** on their activity types screen (ADR-0163 §3). */
@ApiTags('tenant configuration')
@ApiBearerAuth()
@Controller('kpm/settings')
export class ActivityBindingReadController {
  constructor(private readonly bindings: ActivityBindingService) {}

  @Get('activity-binding')
  @RequirePermission('activity_binding:read')
  @ApiOperation({
    summary: 'The office’s activity binding',
    description:
      'Which of this office’s activity types each cascade role counts — `leads` (*Set appointment*), '
      + '`appointments` (*Sales meeting*), `closings` (*Submission polis*) — read-only here: the Super Admin '
      + 'keeps it. A bound type cannot be archived (409 ACTIVITY_TYPE_BOUND). Version 0 is an office with no '
      + 'binding yet, which counts the default binding.',
  })
  async read(@Ctx() ctx: RequestContext) {
    return this.bindings.readOwn(ctx);
  }
}
