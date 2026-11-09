import { Body, Controller, Delete, Get, Param, Post, Put, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { Ctx, RequirePermission } from '@/common/auth/auth.decorators';
import { RequestContext } from '@/common/context/request-context';
import { TrainingService } from './training.service';
import {
  ConfirmUploadDto, RequestUploadDto, SaveModuleContentDto,
} from './training.dto';
import {
  ModuleContentDto, SignedUploadDto, SignedUrlDto,
} from './training.response.dto';

/**
 * An office's training taxonomy, as the settings screens read it (P5-T1).
 *
 * **The taxonomy is read only here.** Every taxonomy write goes through the staged batch,
 * `POST /kpm/settings/changes`, like the rest of an office's configuration — validated whole
 * before anything is written, and published to agents as one snapshot.
 *
 * **A module's content is not part of that snapshot, and has its own routes** (P5-T2). It is
 * files rather than rows: the bytes go straight from the browser to storage, and the office
 * either uses the company's material or replaces it for itself (ADR-0032). Staging a file
 * upload inside a batch of taxonomy edits would mean holding bytes in a form.
 */
@ApiTags('tenant configuration')
@ApiBearerAuth()
@Controller('kpm/settings/training')
export class TrainingController {
  constructor(private readonly training: TrainingService) {}

  /*
   * **The three reads are `training_settings:read`, the Owner's and the Admins'** (P18.2-T1 AC-8). They sat on
   * `tenant_config:read`, which every member holds, and answer drafts, archived rows and a draft module's files —
   * so an agent could read what the office has not offered. The learner reads `/training`, which checks *offered*.
   */
  @Get()
  @RequirePermission('training_settings:read')
  @ApiOperation({
    summary: 'The office\'s training taxonomy',
    description:
      'Categories, each with its skills, each with its modules, in display order. **Drafts '
      + 'are included**: this is the office\'s configuration, not what agents are offered, '
      + 'which is `GET /kpm/config`. `includeArchived=true` is the settings screen\'s, so an '
      + 'Owner can bring a row back.',
  })
  async list(@Ctx() ctx: RequestContext, @Query('includeArchived') includeArchived?: string) {
    return this.training.list(ctx, includeArchived === 'true');
  }

  // ---------------------------------------------------------- a module's content (P5-T2)

  @Post('uploads')
  @RequirePermission('tenant_config:write')
  @ApiOperation({
    summary: 'A signed upload for training material',
    description:
      'The bytes go straight from the browser to storage, so they never transit this API. The '
      + 'limits are checked **before** a signature is issued: rejecting after an upload has '
      + 'finished spends somebody\'s data allowance to say no.',
  })
  @ApiResponse({ status: 201, type: SignedUploadDto })
  async requestUpload(@Ctx() ctx: RequestContext, @Body() dto: RequestUploadDto) {
    return this.training.requestContentUpload(ctx, dto);
  }

  @Post('uploads/confirm')
  @RequirePermission('tenant_config:write')
  @ApiOperation({
    summary: 'Confirm the bytes arrived',
    description:
      'Asks storage what actually landed and records **that** — not what the browser claimed '
      + 'before it sent anything (ADR-0040). Until this succeeds the file is not attachable and '
      + 'not deliverable.',
  })
  @ApiResponse({ status: 201, type: ModuleContentDto })
  async confirmUpload(@Ctx() ctx: RequestContext, @Body() dto: ConfirmUploadDto) {
    return this.training.confirmContentUpload(ctx, dto.storageKey);
  }

  @Get('modules/:code/content')
  @RequirePermission('training_settings:read')
  @ApiOperation({
    summary: 'What this office shows for a module, and what the company gave it',
    description:
      'Both halves. A screen offering *"use the company\'s material again"* has to say what that '
      + 'restores, and an Owner replacing something needs to see what they are replacing.',
  })
  @ApiResponse({ status: 200, type: ModuleContentDto })
  async readContent(@Ctx() ctx: RequestContext, @Param('code') code: string) {
    return this.training.readContent(ctx, code);
  }

  @Put('modules/:code/content')
  @RequirePermission('tenant_config:write')
  @ApiOperation({
    summary: 'Replace this office\'s content for a module',
    description:
      'The whole document, not a patch — every edit is held until Save and sent together, which '
      + 'is what makes Cancel mean something. It lands on the office\'s half; the company\'s row '
      + 'is never touched, so no other office changes.',
  })
  @ApiResponse({ status: 200, type: ModuleContentDto })
  async saveContent(
    @Ctx() ctx: RequestContext,
    @Param('code') code: string,
    @Body() dto: SaveModuleContentDto,
  ) {
    return this.training.saveContent(ctx, code, dto);
  }

  @Delete('modules/:code/content')
  @RequirePermission('tenant_config:write')
  @ApiOperation({
    summary: 'Use the company\'s material again',
    description:
      'Removes this office\'s replacement and falls back to the company\'s material. The office\'s '
      + 'own uploads are released, never deleted — somebody may put them back, and deleting a '
      + 'file because it stopped being referenced is a decision nobody made.',
  })
  @ApiResponse({ status: 200, type: ModuleContentDto })
  async resetContent(@Ctx() ctx: RequestContext, @Param('code') code: string) {
    return this.training.resetContent(ctx, code);
  }

  @Get('modules/:code/content/url')
  @RequirePermission('training_settings:read')
  @ApiOperation({
    summary: 'A short-lived URL for one item',
    description:
      'Signed and expiring in 300 seconds; nothing here is publicly readable. Which registry '
      + 'answers depends on which half of the module the item is in, never on what the caller '
      + 'says — a key in neither half is a 404, so knowing one buys nothing.',
  })
  @ApiResponse({ status: 200, type: SignedUrlDto })
  async contentUrl(
    @Ctx() ctx: RequestContext,
    @Param('code') code: string,
    @Query('storageKey') storageKey: string,
  ) {
    return { url: await this.training.contentUrl(ctx, code, storageKey) };
  }
}
