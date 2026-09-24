import {
  Body, Controller, Delete, Get, HttpStatus, Param, Patch, Post, Query, Res,
} from '@nestjs/common';
import type { Response } from 'express';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { Ctx, RequirePermission } from '@/common/auth/auth.decorators';
import { RequestContext } from '@/common/context/request-context';
import { ActivityConfigService } from './activity.service';
import { LeadStatusService } from './lead-status.service';
import { RatioService } from './ratio.service';
import { TenantService } from '@/modules/tenants/tenant.service';
import { TenantConfigService } from './tenant-config.service';

import { UpdateBranchInfoDto } from '@/modules/tenants/tenant.dto';
import { CreateRatioDto, UpdateRatioDto } from './ratio.dto';
import {
  CreateLeadStatusDto, RenameLeadStatusDto, ReorderLeadStatusesDto, SetLateStageDto,
} from './lead-status.dto';
import {
  CreateActivityCategoryDto,
  CreateActivityTypeDto,
  ReorderActivityTypesDto,
  UpdateActivityCategoryDto,
  UpdateActivityTypeDto,
} from './activity.dto';
import { ApplyConfigChangesDto } from './changes.dto';
import { ConfigChangeService } from './changes.service';

/**
 * The office's own configuration (P4-T1).
 *
 * **Not the company template.** Super Admin edits that at
 * `/admin/companies/:companyId/template` (ADR-0018, `P4-T8`), and the two are different
 * documents on purpose: an office is seeded from the template once and then owns its copy,
 * so an office that has diverged keeps its divergence.
 */
@ApiTags('tenant configuration')
@ApiBearerAuth()
@Controller('kpm/settings')
export class TenantConfigController {
  constructor(
    private readonly activity: ActivityConfigService,
    private readonly leadStatuses: LeadStatusService,
    private readonly ratios: RatioService,
    private readonly tenants: TenantService,
    private readonly config: TenantConfigService,
    private readonly changes: ConfigChangeService,
  ) {}

  @Get('activity-types')
  @RequirePermission('tenant_config:read')
  @ApiOperation({
    summary: 'The office\'s activity taxonomy',
    description:
      'Categories with their types, in the order the Owner arranged them. '
      + '`includeArchived=true` is what the settings screen asks for and the capture '
      + 'screen does not: an agent logging today should not be offered a retired type, '
      + 'and an Owner needs to see one in order to bring it back.',
  })
  async listActivityTypes(
    @Ctx() ctx: RequestContext,
    @Query('includeArchived') includeArchived?: string,
  ) {
    return this.activity.list(ctx, includeArchived === 'true');
  }

  @Post('changes')
  @RequirePermission('tenant_config:write')
  @ApiOperation({
    summary: 'Apply a batch of staged changes, or none of them',
    description:
      'The settings screens stage every edit and send one request. **Validated entirely '
      + 'before anything is written**, so a refusal leaves the office exactly as it was, '
      + 'and so a `type.create` can name a section a `category.create` makes earlier in '
      + 'the same batch. Every change to an existing row carries the `version` the screen '
      + 'read: a row that moved on refuses the whole batch with `409 VERSION_CONFLICT`, '
      + 'naming what changed, rather than letting the second of two admins erase the '
      + 'first. Returns the working copy as it now stands — publishing is still a '
      + 'separate act.',
  })
  async applyChanges(@Ctx() ctx: RequestContext, @Body() dto: ApplyConfigChangesDto) {
    return this.changes.apply(ctx, dto.ops);
  }

  @Post('activity-categories')
  @RequirePermission('tenant_config:write')
  @ApiOperation({ summary: 'Add a category' })
  async createCategory(@Ctx() ctx: RequestContext, @Body() dto: CreateActivityCategoryDto) {
    return this.activity.createCategory(ctx, dto);
  }

  @Patch('activity-categories/reorder')
  @RequirePermission('tenant_config:write')
  @ApiOperation({
    summary: 'Reorder the categories',
    description:
      'Send every id, once each, in the order you want. Declared **above** '
      + '`activity-categories/:id`, or Nest reads "reorder" as an id. Bumps no version: '
      + 'position is presentation, and nothing reads it back.',
  })
  async reorderCategories(@Ctx() ctx: RequestContext, @Body() dto: ReorderActivityTypesDto) {
    return this.activity.reorderCategories(ctx, dto.ids);
  }

  @Patch('activity-categories/:id')
  @RequirePermission('tenant_config:write')
  @ApiOperation({
    summary: 'Edit a category',
    description:
      'Label, description and the rungs it applies to. **Never the code** — that is the '
      + 'identity every type under it holds. Narrowing the rungs is refused when a ratio '
      + 'counting this section still applies to a rung the section would lose.',
  })
  async updateCategory(
    @Ctx() ctx: RequestContext,
    @Param('id') id: string,
    @Body() dto: UpdateActivityCategoryDto,
  ) {
    return this.activity.updateCategory(ctx, id, dto);
  }

  @Delete('activity-categories/:id')
  @RequirePermission('tenant_config:write')
  @ApiOperation({
    summary: 'Archive a category, and everything in it',
    description:
      'Archiving, never deleting (invariant §3) — and it cascades to the section\u2019s '
      + 'types, because a live type inside a retired section would still be loggable from '
      + 'nowhere. A ratio naming an archived type keeps computing over its history.',
  })
  async archiveCategory(@Ctx() ctx: RequestContext, @Param('id') id: string) {
    return this.activity.archiveCategory(ctx, id);
  }

  @Post('activity-categories/:id/restore')
  @RequirePermission('tenant_config:write')
  @ApiOperation({
    summary: 'Bring a category back',
    description: 'The section returns; its types stay archived until restored one by one.',
  })
  async restoreCategory(@Ctx() ctx: RequestContext, @Param('id') id: string) {
    return this.activity.restoreCategory(ctx, id);
  }

  @Post('activity-types')
  @RequirePermission('tenant_config:write')
  @ApiOperation({ summary: 'Add an activity type' })
  async createType(@Ctx() ctx: RequestContext, @Body() dto: CreateActivityTypeDto) {
    return this.activity.createType(ctx, dto);
  }

  @Patch('activity-types/reorder')
  @RequirePermission('tenant_config:write')
  @ApiOperation({
    summary: 'Reorder the activity types',
    description:
      'Send every id, once each, in the order you want. Declared **above** '
      + '`activity-types/:id`, or Nest reads "reorder" as an id.',
  })
  async reorderTypes(@Ctx() ctx: RequestContext, @Body() dto: ReorderActivityTypesDto) {
    return this.activity.reorderTypes(ctx, dto.ids);
  }

  @Patch('activity-types/:id')
  @RequirePermission('tenant_config:write')
  @ApiOperation({
    summary: 'Change what an activity type says',
    description:
      'Label, description and category. **Not the code** — a published code is what every '
      + 'activity log, ratio formula and goal target holds, and changing it would point '
      + 'all of them at nothing.',
  })
  async updateType(
    @Ctx() ctx: RequestContext,
    @Param('id') id: string,
    @Body() dto: UpdateActivityTypeDto,
  ) {
    return this.activity.updateType(ctx, id, dto);
  }

  @Delete('activity-types/:id')
  @RequirePermission('tenant_config:write')
  @ApiOperation({
    summary: 'Archive an activity type',
    description:
      'Archived, not deleted (invariant §3). It leaves the capture screen and stays '
      + 'readable wherever a historical activity log names it.',
  })
  async archiveType(@Ctx() ctx: RequestContext, @Param('id') id: string) {
    return this.activity.archiveType(ctx, id);
  }

  @Post('activity-types/:id/restore')
  @RequirePermission('tenant_config:write')
  @ApiOperation({ summary: 'Bring an archived activity type back' })
  async restoreType(@Ctx() ctx: RequestContext, @Param('id') id: string) {
    return this.activity.restoreType(ctx, id);
  }

  // ---- The two lead pipelines (P4-T3). ----

  @Get('lead-statuses')
  @RequirePermission('tenant_config:read')
  @ApiOperation({
    summary: 'The office\'s two lead pipelines',
    description:
      'Sales and recruitment, each in rank order. A lead holds a **code**, never a label '
      + '— renaming a stage must not orphan every lead sitting on it.',
  })
  async listLeadStatuses(
    @Ctx() ctx: RequestContext,
    @Query('includeArchived') includeArchived?: string,
  ) {
    return this.leadStatuses.list(ctx, includeArchived === 'true');
  }

  @Post('lead-statuses')
  @RequirePermission('tenant_config:write')
  @ApiOperation({
    summary: 'Add a stage',
    description:
      'Appended to its pipeline, and never terminal: a pipeline has exactly one stage '
      + 'that closes it, and it already has one.',
  })
  async createLeadStatus(@Ctx() ctx: RequestContext, @Body() dto: CreateLeadStatusDto) {
    return this.leadStatuses.create(ctx, dto);
  }

  @Patch('lead-statuses/reorder')
  @RequirePermission('tenant_config:write')
  @ApiOperation({
    summary: 'Reorder one pipeline',
    description: 'Every id of that pipeline, once each. Declared above `:id`.',
  })
  async reorderLeadStatuses(@Ctx() ctx: RequestContext, @Body() dto: ReorderLeadStatusesDto) {
    return this.leadStatuses.reorder(ctx, dto.pipeline, dto.ids);
  }

  @Patch('lead-statuses/:id')
  @RequirePermission('tenant_config:write')
  @ApiOperation({ summary: 'Rename a stage', description: 'The label only.' })
  async renameLeadStatus(
    @Ctx() ctx: RequestContext,
    @Param('id') id: string,
    @Body() dto: RenameLeadStatusDto,
  ) {
    return this.leadStatuses.rename(ctx, id, dto.label);
  }

  @Post('lead-statuses/:id/terminal')
  @RequirePermission('tenant_config:write')
  @ApiOperation({
    summary: 'Make this the stage that closes its pipeline',
    description:
      'Exactly one per pipeline. **Marking a lead successful is gated on it** — which is '
      + 'why it is a property of the stage rather than "the last one in the list", where '
      + 'adding a stage after it would silently move the gate.',
  })
  async setTerminal(@Ctx() ctx: RequestContext, @Param('id') id: string) {
    return this.leadStatuses.setTerminal(ctx, id);
  }

  @Patch('lead-statuses/:id/late-stage')
  @RequirePermission('tenant_config:write')
  @ApiOperation({
    summary: 'Flag a stage as one a lead is expected to convert from',
    description:
      'What the KPM Overview counts as **Expected to close** (ADR-0043). Not exclusive: '
      + 'flag as many stages as the ladder warrants. Refused on the stage that closes the '
      + 'pipeline — a lead sitting there has already closed.',
  })
  async setLateStage(
    @Ctx() ctx: RequestContext,
    @Param('id') id: string,
    @Body() dto: SetLateStageDto,
  ) {
    return this.leadStatuses.setLateStage(ctx, id, dto.isLateStage);
  }

  @Delete('lead-statuses/:id')
  @RequirePermission('tenant_config:write')
  @ApiOperation({
    summary: 'Archive a stage',
    description:
      'Refused for the stage that closes the pipeline: archiving it would leave leads with '
      + 'no way to be marked successful, and nothing on the leads screen would say why.',
  })
  async archiveLeadStatus(@Ctx() ctx: RequestContext, @Param('id') id: string) {
    return this.leadStatuses.archive(ctx, id);
  }

  @Post('lead-statuses/:id/restore')
  @RequirePermission('tenant_config:write')
  @ApiOperation({ summary: 'Bring an archived stage back' })
  async restoreLeadStatus(@Ctx() ctx: RequestContext, @Param('id') id: string) {
    return this.leadStatuses.restore(ctx, id);
  }

  // ---- Ratio definitions (P4-T2). ----

  @Get('ratio-benchmarks')
  @RequirePermission('tenant_config:read')
  @ApiOperation({
    summary: 'The office\'s ratio definitions',
    description:
      'Each with the activity **codes** it is computed from, its benchmark and how the '
      + 'value is judged.',
  })
  async listRatios(
    @Ctx() ctx: RequestContext,
    @Query('includeArchived') includeArchived?: string,
  ) {
    return this.ratios.list(ctx, includeArchived === 'true');
  }

  @Post('ratio-benchmarks')
  @RequirePermission('tenant_config:write')
  @ApiOperation({
    summary: 'Add a ratio',
    description:
      'Both code lists are checked against this office\'s **active** activity types, and '
      + 'an unknown code is named in the refusal. A ratio dividing by something nobody '
      + 'logs reads as 0.0% on every agent\'s screen and looks like an agent problem.',
  })
  async createRatio(@Ctx() ctx: RequestContext, @Body() dto: CreateRatioDto) {
    return this.ratios.create(ctx, dto);
  }

  @Patch('ratio-benchmarks/:id')
  @RequirePermission('tenant_config:write')
  @ApiOperation({
    summary: 'Change a ratio',
    description: 'Label, benchmark, comparison and either code list. **Not the code**.',
  })
  async updateRatio(
    @Ctx() ctx: RequestContext,
    @Param('id') id: string,
    @Body() dto: UpdateRatioDto,
  ) {
    return this.ratios.update(ctx, id, dto);
  }

  @Delete('ratio-benchmarks/:id')
  @RequirePermission('tenant_config:write')
  @ApiOperation({ summary: 'Archive a ratio' })
  async archiveRatio(@Ctx() ctx: RequestContext, @Param('id') id: string) {
    return this.ratios.archive(ctx, id);
  }

  @Post('ratio-benchmarks/:id/restore')
  @RequirePermission('tenant_config:write')
  @ApiOperation({ summary: 'Bring an archived ratio back' })
  async restoreRatio(@Ctx() ctx: RequestContext, @Param('id') id: string) {
    return this.ratios.restore(ctx, id);
  }

  // ---- Publishing (P4-T6). ----

  @Get('publish-state')
  @RequirePermission('tenant_config:read')
  @ApiOperation({
    summary: 'Whether there is anything to publish',
    description:
      'What agents are working against, and whether the office has edited anything since. '
      + 'Compared by version rather than by timestamp: clocks and edit ordering are a '
      + 'worse comparison than a counter.',
  })
  async publishState(@Ctx() ctx: RequestContext) {
    return this.config.state(ctx);
  }

  @Post('publish')
  @RequirePermission('tenant_config:write')
  @ApiOperation({
    summary: 'Publish the working copy to this office\'s agents',
    description:
      'Renders the live rows into one document. Until this is pressed, agents keep seeing '
      + 'the previous copy — an Owner restructuring a taxonomy does it in steps, and '
      + 'between them a ratio can name a type archived a minute ago that nobody can log '
      + 'against any more.',
  })
  async publish(@Ctx() ctx: RequestContext) {
    return this.config.publish(ctx);
  }

  // ---- Branch info (P4-T5). ----

  @Get('branch-info')
  @RequirePermission('kpm:read_profile')
  @ApiOperation({
    summary: 'The office\'s own identity',
    description:
      'The same view the console reads. Company and Owner come back so the screen can show '
      + 'them the way the prototype does — disabled, and labelled *tagged by Superadmin*.',
  })
  async readBranchInfo(@Ctx() ctx: RequestContext) {
    // The caller's own office, from the session. No id in the URL means no id to get wrong.
    return this.tenants.readProfile(ctx, ctx.kpmId ?? '');
  }

  @Patch('branch-info')
  @RequirePermission('tenant_config:write')
  @ApiOperation({
    summary: 'Change the office\'s identity',
    description:
      'Branch name, address, contact phone and the fiscal year start month. **The Owner\'s '
      + 'and the Admin\'s**, under the same permission as every other page under Settings '
      + '(ADR-0027). Not company, not owner, and not locale, timezone or currency (ADR-0016).',
  })
  async updateBranchInfo(@Ctx() ctx: RequestContext, @Body() dto: UpdateBranchInfoDto) {
    return this.tenants.updateIdentity(ctx, ctx.kpmId ?? '', dto);
  }
}

/**
 * The office's configuration, as one read (P4-T7).
 *
 * Separate from the settings controller because its path is `/kpm/config`, and because the
 * two have genuinely different readers: an Owner writes settings, every agent reads this.
 */
@ApiTags('tenant configuration')
@ApiBearerAuth()
@Controller('kpm')
export class TenantConfigReadController {
  constructor(private readonly config: TenantConfigService) {}

  /**
   * Everything an agent surface needs, in one round trip (P4-T7).
   *
   * Its own controller on `/kpm`, because the path is `/kpm/config` and not
   * `/kpm/settings/config`: the settings routes are what an Owner writes, and this is what
   * every agent reads. Nest resolves a controller prefix literally — `'../config'` is a
   * route segment called `..`, not a way out of one.
   */
  @Get('org-levels')
  @RequirePermission('org_level:read')
  @ApiOperation({
    summary: 'The ladder this office\'s company promotes people along',
    description:
      'Junior first, active rungs only. Every member reads it because every member\'s own '
      + 'badge is drawn from it — before `P4-T9` the labels and colours were five '
      + 'hard-coded maps in the frontend, which is a second definition of a company\'s own '
      + 'vocabulary and cannot describe a rung a second insurer publishes.',
  })
  async orgLevels(@Ctx() ctx: RequestContext) {
    return this.config.ladderFor(ctx);
  }

  @Get('config')
  @RequirePermission('tenant_config:read')
  @ApiOperation({
    summary: 'The whole of this office\'s configuration',
    description:
      'The taxonomy, the ratios and both lead pipelines, active rows only. Carries a '
      + 'strong `ETag`; send it back as `If-None-Match` and a repeat read answers `304`. '
      + 'The agent daily loop has to work on a mid-range Android over 4G, and three '
      + 'requests to render one screen is how that budget is spent before anything is drawn.',
  })
  async readConfig(@Ctx() ctx: RequestContext, @Res({ passthrough: true }) res: Response) {
    const config = await this.config.readPublished(ctx);
    const etag = this.config.etag(config);
    res.setHeader('ETag', etag);
    // Revalidate every time rather than trusting a max-age: configuration changes rarely
    // and unpredictably, and an agent looking at a taxonomy their Owner edited an hour ago
    // is a worse failure than one conditional request.
    res.setHeader('Cache-Control', 'private, no-cache');

    if (res.req.headers['if-none-match'] === etag) {
      res.status(HttpStatus.NOT_MODIFIED);
      return undefined;
    }
    return config;
  }
}
