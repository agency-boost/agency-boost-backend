import { Body, Controller, Get, HttpCode, HttpStatus, Param, Post, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { Ctx, RequirePermission } from '@/common/auth/auth.decorators';
import { RequestContext } from '@/common/context/request-context';
import { ApiErrorEnvelope } from '@/common/errors/error-envelope.dto';
import { CompanyPublicationService } from './company-publication.service';
import { PublicationQuery, PublishToKpmsDto } from './company-publication.dto';
import { PublishToKpmsResultDto } from './company-publication.response.dto';

/**
 * ***Terbitkan ke KPM*** (P19.23-T4 AC-5; ADR-0278 §5–§7): a company's changes and its KPMs, and the one write that
 * publishes the changes chosen to the KPMs chosen. Nothing is published automatically, nothing pre-selected.
 *
 * The Super Admin's alone: `company_template:read` to read, `company_template:write` and `product_catalog:crud` to
 * publish — none held by any tenant role.
 */
@ApiTags('admin (Super Admin)')
@ApiBearerAuth()
@Controller('admin/companies/:companyId/publication')
export class CompanyPublicationController {
  constructor(private readonly publication: CompanyPublicationService) {}

  @Get()
  @RequirePermission('company_template:read')
  @ApiOperation({
    summary: 'What waits to be published, and to which KPMs it could go',
    description:
      'Step 1, `changes`: per row of *Pengaturan template* — `setting:activity_types`, `…lead_statuses`, '
      + '`…activation_checklist`, `…training`, `…capability_mapping`, `…events` (copied into each KPM: `reach: chosen`, '
      + '`overwrites`), `…campaigns`, `…recruitment` (read live: `reach: all`) — while a draft waits (`draft`, with '
      + '`added`, `changed`, `removed` counted against the newest published version) or a KPM lacks its newest version '
      + '(`missing`); then per product, `product:<id>` — `product_new` while a KPM lacks it (`reach: chosen`, it only '
      + 'adds), `product_change` while its draft waits (`reach: all`: every KPM that has it). Step 2, `kpms`: the KPMs '
      + 'the company’s default template answers for, each with `ownEdits` (changes it made its own version of, which '
      + 'publishing to it would overwrite — *akan tertimpa*) and `upToDate`. `?summary=true`: `{ changes, templateEmpty, '
      + 'kpms }` alone, for a company’s card, reading no KPM’s settings. 404 for a company that does not exist.',
  })
  async read(
    @Ctx() ctx: RequestContext,
    @Param('companyId') companyId: string,
    @Query() query: PublicationQuery,
  ) {
    return query.summary === 'true'
      ? this.publication.summary(ctx, companyId)
      : this.publication.read(ctx, companyId);
  }

  @Post()
  @HttpCode(HttpStatus.OK)
  @RequirePermission('company_template:write')
  @ApiOperation({
    summary: 'Publish the changes chosen to the KPMs chosen',
    description:
      'Each setting chosen that waits as a draft is published; the copied settings are then pushed to `kpmIds` '
      + '(ADR-0208 §5: matched by code, a KPM’s own items archived); a product’s draft is published for every KPM '
      + 'that has it; a new product is added to `kpmIds`, their settings untouched. A KPM chosen that changed a chosen '
      + 'setting itself needs `overwriteConfirmed: true`, worked out again here — else `409 TEMPLATE_APPLY_UNCONFIRMED` '
      + 'naming the KPMs, and nothing is written. `results` per change: `published`, or `refused` with the reason (that '
      + 'change alone stays a draft); `offices` what the push did per KPM and kind. Audited by every write it makes and '
      + 'once as `company_template.published_to_kpms`. 400 for nothing chosen, a change that is not waiting, no KPM for '
      + 'a change that needs them, or the Default template; 404 for a company, or a KPM that is not the company’s.',
  })
  @ApiResponse({ status: 200, type: PublishToKpmsResultDto })
  @ApiResponse({ status: 409, type: ApiErrorEnvelope, description: '`TEMPLATE_APPLY_UNCONFIRMED` — the tick is missing.' })
  async publish(
    @Ctx() ctx: RequestContext,
    @Param('companyId') companyId: string,
    @Body() dto: PublishToKpmsDto,
  ) {
    return this.publication.publish(ctx, companyId, dto);
  }
}
