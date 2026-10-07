import { Body, Controller, Param, Post } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { Ctx, RequirePermission } from '@/common/auth/auth.decorators';
import { RequestContext } from '@/common/context/request-context';
import { SaveOfficeTemplateDto } from './named-template.dto';
import { TemplateCopyService } from './template-copy.service';

/**
 * **Save this office's settings as a template** (ADR-0115 §5, P13.2-T7), from `/admin/tenants/[kpmId]`.
 *
 * The Super Admin's alone, under `company_template:write`, which no tenant role holds and a support
 * session — acting as the member it impersonates — does not either. The office's settings are read
 * through the named cross-tenant read (`OfficeSettingsSource`), never its business data.
 */
@ApiTags('admin (Super Admin)')
@ApiBearerAuth()
@Controller('admin/tenants/:kpmId/template')
export class OfficeTemplateController {
  constructor(private readonly copies: TemplateCopyService) {}

  @Post()
  @RequirePermission('company_template:write')
  @ApiOperation({
    summary: 'Save an office’s settings as a template',
    description:
      'What the office’s agents read — its newest published configuration snapshot (activity '
      + 'types, ratios, both lead pipelines, the training agents are offered, event types and the '
      + 'capability ladder without archived rows), its newest published activation checklist, and each '
      + 'offered module’s content — becomes a new template of `companyId`: the office’s own company or '
      + 'another. Never the Owner’s unpublished draft, anything archived, or any member, log or lead. '
      + 'What archiving left behind is dropped and listed in `dropped`, never refused: an archived '
      + 'activity type out of a ratio (the ratio left out if a side counts nothing else), a stage’s '
      + 'archived milestones (the stage left out if it requires nothing else), a checklist item’s link to '
      + 'a module no longer offered (kept as a manual item). Each kind it holds '
      + 'is published as version 1; a kind it holds nothing of is left empty. The office’s own '
      + 'training files are duplicated into the company’s assets, and into another company every '
      + 'file is; links are copied as links. 400 when the settings would produce a broken office; 409 '
      + 'TEMPLATE_RUNG_UNKNOWN `{ codes }` into another company whose ladder lacks a rung they name; 409 '
      + 'TEMPLATE_NAME_TAKEN; 409 ASSET_NOT_CONFIRMED for a file that never finished uploading; 404 for '
      + 'an unknown office or company; 403 PERM_DENIED, here and in the service, to anybody without '
      + '`company_template:write`. Every check runs before any write. Audited once, naming the office, '
      + 'the destination and what was dropped.',
  })
  async save(
    @Ctx() ctx: RequestContext,
    @Param('kpmId') kpmId: string,
    @Body() dto: SaveOfficeTemplateDto,
  ) {
    return this.copies.saveOffice(ctx, kpmId, dto);
  }
}
