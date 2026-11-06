import { Body, Controller, Get, HttpCode, Post } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { Ctx, RequirePermission } from '@/common/auth/auth.decorators';
import { RequestContext } from '@/common/context/request-context';
import { ApplyTemplateSyncDto, TemplateSyncResultDto, TemplateSyncViewDto } from './template-sync.dto';
import { TemplateSyncService } from './template-sync.service';

/**
 * ***Sinkron dari template*** (P19.6-T4, ADR-0220 §4; OD-270, UI-161) — beside `TrainingController` under the same
 * prefix, its own class because it reads the Company template, which is this module's.
 */
@ApiTags('tenant configuration')
@ApiBearerAuth()
@Controller('kpm/settings/training/template-sync')
export class TemplateSyncController {
  constructor(private readonly sync: TemplateSyncService) {}

  @Get()
  @RequirePermission('training_settings:read')
  @ApiOperation({
    summary: 'What this KPM’s training names would take from its template',
    description:
      'By code: the names and descriptions of categories, skills and modules against the template’s newest published '
      + '`training_taxonomy`, and capability items’ names against its `capability_ladder`, on items found in both. '
      + 'Empty for a KPM made from no template. Read-only, so a view-as session reads it.',
  })
  @ApiResponse({ status: 200, type: TemplateSyncViewDto })
  async read(@Ctx() ctx: RequestContext) {
    return this.sync.read(ctx);
  }

  @Post()
  @HttpCode(200)
  @RequirePermission('tenant_config:write')
  @ApiOperation({
    summary: 'Take the template’s names and descriptions',
    description:
      'Pinned to the template versions and the KPM `revision` the preview read (`409 VERSION_CONFLICT` if either moved). '
      + 'Writes names and descriptions only — no code, material, order, archived state or progress — and publishes as a '
      + 'template push does: a new version with origin `template_sync` when nothing of the KPM’s waited, else they wait '
      + 'together. Audited as `training.template_synced`. Refused in a view-as session.',
  })
  @ApiResponse({ status: 200, type: TemplateSyncResultDto })
  async apply(@Ctx() ctx: RequestContext, @Body() dto: ApplyTemplateSyncDto) {
    return this.sync.apply(ctx, dto);
  }
}
