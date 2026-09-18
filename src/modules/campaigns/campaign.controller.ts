import { Body, Controller, Get, Param, Patch, Post, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { Ctx, RequirePermission } from '@/common/auth/auth.decorators';
import { RequestContext } from '@/common/context/request-context';
import { SaveCampaignDto } from './campaign.dto';
import { CampaignDto, QualificationRuleDto } from './campaign.response.dto';
import { CampaignService } from './campaign.service';

/**
 * An office's campaigns, and the carrier rules it is measured against (P5-T7, ADR-0026).
 *
 * **The tiers have no write route at all.** Not a permission that refuses one — no route. A
 * production club tier is the insurer's recognition programme, and a branch manager cannot delete
 * Chairman's Club any more than they can retag their office to another company.
 */
@ApiTags('tenant configuration')
@ApiBearerAuth()
@Controller('kpm/settings/campaigns')
export class CampaignController {
  constructor(private readonly campaigns: CampaignService) {}

  @Get('rules')
  @RequirePermission('tenant_config:read')
  @ApiOperation({
    summary: 'The carrier rules this office is measured against',
    description:
      'MOC and the production club tiers, the insurer’s. **Read only for every office role** — '
      + 'there is no write route here at all. A rule waiting on a metric this product does not '
      + 'compute yet says so, rather than being shown as an ordinary rule nobody can ever pass.',
  })
  @ApiResponse({ status: 200, type: QualificationRuleDto, isArray: true })
  async listRules(@Ctx() ctx: RequestContext, @Query('kind') kind?: string) {
    return this.campaigns.listRules(ctx, kind);
  }

  @Get()
  @RequirePermission('tenant_config:read')
  @ApiOperation({
    summary: 'The office’s own campaigns',
    description:
      'Newest first, each with its phase **derived now** — upcoming, running or ended. The '
      + 'prototype labels one campaign *Running* in the list while its own data says `past`.',
  })
  @ApiResponse({ status: 200, type: CampaignDto, isArray: true })
  async list(@Ctx() ctx: RequestContext, @Query('includeArchived') archived?: string) {
    return this.campaigns.list(ctx, archived === 'true');
  }

  @Post()
  @RequirePermission('tenant_config:write')
  @ApiOperation({
    summary: 'Add a campaign',
    description:
      'A requirement is a **metric, a comparator and a number**. A metric this product does not '
      + 'measure is refused by name; one that arrives in a later phase is refused saying which '
      + 'phase brings it, because a campaign asking for it could never qualify anybody.',
  })
  @ApiResponse({ status: 201, type: CampaignDto })
  async create(@Ctx() ctx: RequestContext, @Body() dto: SaveCampaignDto) {
    this.campaigns.refuseCompanyScope((dto as { scope?: unknown }).scope);
    return this.campaigns.create(ctx, dto);
  }

  @Patch(':id')
  @RequirePermission('tenant_config:write')
  @ApiOperation({ summary: 'Change a campaign', description: 'Never the code.' })
  @ApiResponse({ status: 200, type: CampaignDto })
  async update(@Ctx() ctx: RequestContext, @Param('id') id: string, @Body() dto: SaveCampaignDto) {
    this.campaigns.refuseCompanyScope((dto as { scope?: unknown }).scope);
    return this.campaigns.update(ctx, id, dto);
  }

  @Post(':id/archive')
  @RequirePermission('tenant_config:write')
  @ApiOperation({ summary: 'Archive a campaign' })
  @ApiResponse({ status: 201, type: CampaignDto })
  async archive(@Ctx() ctx: RequestContext, @Param('id') id: string) {
    return this.campaigns.archive(ctx, id);
  }

  @Post(':id/restore')
  @RequirePermission('tenant_config:write')
  @ApiOperation({ summary: 'Bring a campaign back' })
  @ApiResponse({ status: 201, type: CampaignDto })
  async restore(@Ctx() ctx: RequestContext, @Param('id') id: string) {
    return this.campaigns.restore(ctx, id);
  }
}
