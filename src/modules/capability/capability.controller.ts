import { Body, Controller, Get, Patch, Post } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { Ctx, RequirePermission } from '@/common/auth/auth.decorators';
import { RequestContext } from '@/common/context/request-context';
import {
  AddCapabilityDto, RenameCapabilityDto, ReorderCapabilityDto, SetCapabilityStatusDto,
} from './capability.dto';
import { CapabilityCatalogDto } from './capability.response.dto';
import { CapabilityService, type CapabilityPart } from './capability.service';

/**
 * The office's capability catalog (P5-T8, ADR-0025, ADR-0036).
 *
 * **The Owner and the Admin edit it; leaders assess against it.** One catalog per office is what
 * makes two leaders' assessments comparable — a grid each leader could extend is a grid nobody can
 * roll up. **There is no delete route**, and there will not be one.
 */
@ApiTags('tenant configuration')
@ApiBearerAuth()
@Controller('kpm/settings/capability-mapping')
export class CapabilityController {
  constructor(private readonly capability: CapabilityService) {}

  @Get()
  @RequirePermission('tenant_config:read')
  @ApiOperation({
    summary: 'The office’s capability catalog',
    description:
      'Four stages, their milestones and the four skill grids, each item carrying a **code**. An '
      + 'office provisioned before this existed reads the defaults, unsaved, until its first edit.',
  })
  @ApiResponse({ status: 200, type: CapabilityCatalogDto })
  async read(@Ctx() ctx: RequestContext) {
    return this.capability.read(ctx);
  }

  @Patch('label')
  @RequirePermission('tenant_config:write')
  @ApiOperation({
    summary: 'Rename anything',
    description: 'The **code never moves**, so no tick is re-pointed by a correction to the wording.',
  })
  @ApiResponse({ status: 200, type: CapabilityCatalogDto })
  async rename(@Ctx() ctx: RequestContext, @Body() dto: RenameCapabilityDto) {
    return this.capability.rename(
      ctx, dto.part as CapabilityPart, dto.code, dto.label, dto.gridCode,
    );
  }

  @Patch('status')
  @RequirePermission('tenant_config:write')
  @ApiOperation({
    summary: 'Archive or restore',
    description:
      'There is no delete. An archived item stays readable on assessments that already reference '
      + 'it and takes no new ones. **Archiving a milestone takes it out of every stage that requires it** '
      + '(ADR-0274), and restoring it puts it back — refused only when a stage would be left requiring nothing.',
  })
  @ApiResponse({ status: 200, type: CapabilityCatalogDto })
  async setStatus(@Ctx() ctx: RequestContext, @Body() dto: SetCapabilityStatusDto) {
    return this.capability.setStatus(
      ctx, dto.part as CapabilityPart, dto.code, dto.status as 'active' | 'archived', dto.gridCode,
    );
  }

  @Post('items')
  @RequirePermission('tenant_config:write')
  @ApiOperation({
    summary: 'Add a stage, a milestone, a group or a skill',
    description:
      'The code is chosen once and refused when it is already used **anywhere in the catalog, '
      + 'archived rows included** — a tick names a code, so a reused one would re-point every '
      + 'assessment that held it. **Absent, the server makes one from the label**. A milestone with '
      + '`stageCode` is required by that stage and every stage above it; a stage comes with its `firstMilestone`; a '
      + 'group (`grid`) starts empty. No automatic rule anywhere: leaders tick by hand.',
  })
  @ApiResponse({ status: 201, type: CapabilityCatalogDto })
  async add(@Ctx() ctx: RequestContext, @Body() dto: AddCapabilityDto) {
    return this.capability.add(
      ctx, dto.part as CapabilityPart, dto.code, dto.label, dto.gridCode,
      { stageCode: dto.stageCode, firstMilestone: dto.firstMilestone },
    );
  }

  @Patch('order')
  @RequirePermission('tenant_config:write')
  @ApiOperation({
    summary: 'Reorder a list',
    description:
      'Position on screen only. It **never touches `stageOrder`**, so tidying the ladder cannot '
      + 'move anybody’s stage — which is exactly what the prototype’s array index does.',
  })
  @ApiResponse({ status: 200, type: CapabilityCatalogDto })
  async reorder(@Ctx() ctx: RequestContext, @Body() dto: ReorderCapabilityDto) {
    return this.capability.reorder(ctx, dto.part as CapabilityPart, dto.codes, dto.gridCode);
  }
}
