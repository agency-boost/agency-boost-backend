import { Body, Controller, Delete, Get, Param, Patch, Post, Put, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { Ctx, RequirePermission } from '@/common/auth/auth.decorators';
import { RequestContext } from '@/common/context/request-context';
import { ApiErrorEnvelope } from '@/common/errors/error-envelope.dto';
import { ClearStandingOverrideDto, OverrideStandingDto, SaveCampaignDto } from './campaign.dto';
import { CampaignDto, StandingOverrideResultDto } from './campaign.response.dto';
import { CampaignService } from './campaign.service';
import { CampaignStandingOverrides } from './campaign-standing-overrides';

/** A refusal the derived descriptions cannot know, in the shared envelope. */
const refusal = (status: number, description: string) => ({ status, description, type: ApiErrorEnvelope });

/**
 * An office's campaigns (P5-T7, ADR-0026).
 *
 * **The tiers have no write route at all.** Not a permission that refuses one — no route. A
 * production club tier is the insurer's recognition programme, and a branch manager cannot delete
 * Chairman's Club any more than they can retag their office to another company.
 *
 * *Changed 2026-11-20 (P19.25-T5 AC-1, ADR-0282 §6):* **and no read route either, for now.** `GET …/campaigns/rules`
 * served the *Production club tiers* tab — the tiers and MOC — which the owner took off every screen (*"MOC / Club: not
 * shown anywhere for now"*). The rules stay stored, untouched and unarchived (`CampaignService.listRules` still reads
 * them); a screen that shows them again brings its route back with it.
 */
@ApiTags('tenant configuration')
@ApiBearerAuth()
@Controller('kpm/settings/campaigns')
export class CampaignController {
  constructor(
    private readonly campaigns: CampaignService,
    private readonly overrides: CampaignStandingOverrides,
  ) {}

  @Get()
  @RequirePermission('campaign_settings:read')
  @ApiOperation({
    summary: 'The office’s own campaigns',
    description:
      'Newest first, each with its phase **derived now** — upcoming, running or ended. The '
      + 'prototype labels one campaign *Running* in the list while its own data says `past`. The agency’s owner and '
      + 'its administrators: a member reads the active campaigns at `GET /campaigns`.',
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
      + 'measure is refused by name; one it does not measure yet is refused saying so, because a '
      + 'campaign asking for it could never qualify anybody.',
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

  // ---------------------------------------------------------------- Phase 18.3 (P18.3-T2): the override

  @Put(':code/standings/:membershipId/override')
  @RequirePermission('campaign_qualification:override')
  @ApiOperation({
    summary: 'Override a final campaign result',
    description:
      'Set a member’s final result in a campaign to *Achieved* (`qualified`) or *Not achieved* (`not_met`), with a '
      + 'reason — the correction of a result the evaluation could not see. Only once the campaign’s result is final, '
      + 'and only for a member who was chasing it when it ended (a stored standing). The frozen result is kept beside '
      + 'the override, so clearing it restores that result. Audited with before, after, the reason and the previous '
      + 'result. The member’s own campaign dialog does not change. Nobody overrides their own result: an Admin '
      + 'corrects the Owner’s, the Owner an Admin’s.',
  })
  @ApiResponse({ status: 200, type: StandingOverrideResultDto })
  @ApiResponse(refusal(
    409,
    '`CAMPAIGN_STANDING_NOT_FINAL` — the campaign’s result is not final yet. `VERSION_CONFLICT` — somebody changed the '
    + 'result at the same moment; read it again. Nothing is written.',
  ))
  @ApiResponse(refusal(
    404,
    '`NOT_FOUND` — the campaign is unknown, archived or another office’s; the member is not this office’s; or the '
    + 'member has no final result to correct (they were not chasing it when it ended). Indistinguishable from another '
    + 'office’s.',
  ))
  @ApiResponse(refusal(
    400,
    '`VALIDATION_FAILED` — a blank or over-long reason, another status, or the result it already reads (`details.status`). '
    + '`CAMPAIGN_OVERRIDE_SELF` — your own result (`details.membershipId`). Nothing is written.',
  ))
  async override(
    @Ctx() ctx: RequestContext, @Param('code') code: string, @Param('membershipId') membershipId: string,
    @Body() body: OverrideStandingDto,
  ) {
    return this.overrides.override(ctx, code, membershipId, body);
  }

  @Delete(':code/standings/:membershipId/override')
  @RequirePermission('campaign_qualification:override')
  @ApiOperation({
    summary: 'Clear an override of a final campaign result',
    description:
      'Remove the override, with a reason: the result reads what was frozen when the campaign’s result became final. '
      + 'Audited with before, after, the reason and the previous result.',
  })
  @ApiResponse({ status: 200, type: StandingOverrideResultDto })
  @ApiResponse(refusal(
    409,
    '`CAMPAIGN_STANDING_NOT_FINAL` — the campaign’s result is not final yet. `VERSION_CONFLICT` — somebody changed the '
    + 'result at the same moment; read it again.',
  ))
  @ApiResponse(refusal(
    404,
    '`NOT_FOUND` — as for setting one (another office’s campaign or member, or no final result), and a result with '
    + 'no override to clear.',
  ))
  @ApiResponse(refusal(
    400,
    '`VALIDATION_FAILED` — a blank or over-long reason, or any other field. `CAMPAIGN_OVERRIDE_SELF` — your own result '
    + '(`details.membershipId`). Nothing is written.',
  ))
  async clearOverride(
    @Ctx() ctx: RequestContext, @Param('code') code: string, @Param('membershipId') membershipId: string,
    @Body() body: ClearStandingOverrideDto,
  ) {
    return this.overrides.clear(ctx, code, membershipId, body);
  }
}
