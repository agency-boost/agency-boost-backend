import {
  Body, Controller, Get, Header, HttpCode, HttpStatus, Param, Post, Put, Query, Req, Res,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import type { Request, Response } from 'express';
import { Ctx, Public, RequirePermission } from '@/common/auth/auth.decorators';
import { RequestContext } from '@/common/context/request-context';
import { DomainException, NotFoundException } from '@/common/errors/domain.exception';
import { ErrorCode } from '@/common/errors/error-codes';
import { BRANDING } from '@/domain/constants/branding';
import { RateLimiter } from '@/modules/auth/rate-limiter';
import {
  BrandingPreviewDto, ConfirmBrandingUploadDto, RequestBrandingUploadDto, ResetBrandingDto, SaveBrandingDto,
} from './branding.dto';
import { BRANDING_REFUSALS } from './branding.messages';
import { BrandingService } from './branding.service';

/**
 * ***Pengaturan → Tampilan KPM*** (P19.6-T1 AC-2 to AC-17; ADR-0218 §1, §14). Read under `tenant_config:read`, written
 * under `tenant_config:write` — the Owner's and the Admins'. Every route is the request's own KPM's; a view-as session
 * reads it and every write is refused, as every view-as write is (ADR-0206 §1).
 */
@ApiTags('KPM branding')
@ApiBearerAuth()
@Controller('kpm/settings/branding')
export class BrandingSettingsController {
  constructor(private readonly branding: BrandingService) {}

  @Get()
  @RequirePermission('tenant_config:read')
  @ApiOperation({
    summary: 'The KPM’s branding: its own, its template’s, and what it shows',
    description: 'Each image with a 300-second preview link. `version` is what *Simpan* and *Kembalikan ke default* send '
      + 'back as `expectedVersion`; `canWrite` is false in a view-as session (AC-17).',
  })
  async read(@Ctx() ctx: RequestContext) {
    return this.branding.settings(ctx);
  }

  @Put()
  @RequirePermission('tenant_config:write')
  @ApiOperation({
    summary: '*Simpan*: the logos, the two colours and the mascot',
    description: 'Each group whole or `null` (the KPM then shows its template’s, else AgencyBoost’s). Every `#rrggbb` '
      + 'colour is accepted: one no words read 4.5:1 on is painted as its nearest readable shade, and the colour chosen '
      + 'is kept. A stale `expectedVersion` is `409 VERSION_CONFLICT`; an image folder not this KPM’s `400 '
      + 'VALIDATION_FAILED`. Audited `kpm_branding.updated`, old → new, each colour with its fill.',
  })
  async save(@Ctx() ctx: RequestContext, @Body() dto: SaveBrandingDto) {
    return this.branding.save(ctx, dto as never);
  }

  @Post('preview')
  @HttpCode(HttpStatus.OK)
  @RequirePermission('tenant_config:write')
  @ApiOperation({
    summary: 'The palette of two colours, for the live preview',
    description: 'Writes nothing. Each colour’s words, their ratio and its `fill`, `adjusted` when the fill is not the '
      + 'colour chosen.',
  })
  preview(@Body() dto: BrandingPreviewDto) {
    return this.branding.preview(dto.primary, dto.secondary);
  }

  @Post('reset')
  @HttpCode(HttpStatus.OK)
  @RequirePermission('tenant_config:write')
  @ApiOperation({
    summary: '*Kembalikan ke default* (acceptance 3)',
    description: 'Soft-deletes the KPM’s own branding: it shows its template’s *Tampilan*, else AgencyBoost’s. Audited '
      + '`kpm_branding.reset`.',
  })
  async reset(@Ctx() ctx: RequestContext, @Body() dto: ResetBrandingDto) {
    return this.branding.reset(ctx, dto.expectedVersion);
  }

  @Post('uploads')
  @RequirePermission('tenant_config:write')
  @ApiOperation({
    summary: 'A signed form for a logo, a square logo or a mascot picture',
    description: 'At most 1 MB, `413 ASSET_TOO_LARGE`; the kind’s types only, `415 ASSET_TYPE_NOT_ALLOWED`; 30 an hour '
      + 'per KPM, `429 AUTH_RATE_LIMITED`.',
  })
  async upload(@Ctx() ctx: RequestContext, @Body() dto: RequestBrandingUploadDto) {
    return this.branding.requestUpload({ kind: 'kpm', kpmId: ctx.kpmId! }, dto);
  }

  @Post('uploads/confirm')
  @HttpCode(HttpStatus.OK)
  @RequirePermission('tenant_config:write')
  @ApiOperation({
    summary: 'Confirm a picture: checked, and made into its sizes',
    description: '`422 BRANDING_IMAGE_REFUSED` (`dimensions`, `no_alpha`, `svg_unsafe`, `unreadable`); type and size as '
      + 'every upload. Answers the `storageKey` *Simpan* names.',
  })
  async confirm(@Ctx() ctx: RequestContext, @Body() dto: ConfirmBrandingUploadDto) {
    return this.branding.confirmUpload({ kind: 'kpm', kpmId: ctx.kpmId! }, dto);
  }
}

/**
 * **A template's *Tampilan* images** (P19.6-T1 AC-11; ADR-0218 §3): uploaded into the company's folder under
 * `company_template:write`. The section itself is read, drafted and published at `…/template/branding?templateId=` like
 * every kind.
 */
@ApiTags('KPM branding')
@ApiBearerAuth()
@Controller('admin/companies/:companyId/templates/:templateId/branding')
export class TemplateBrandingController {
  constructor(private readonly branding: BrandingService) {}

  @Post('uploads')
  @RequirePermission('company_template:write')
  @ApiOperation({ summary: 'A signed form for a template’s logo, square logo or mascot picture' })
  async upload(@Param('companyId') companyId: string, @Param('templateId') templateId: string, @Body() dto: RequestBrandingUploadDto) {
    await this.branding.requireTemplate(companyId, templateId);
    return this.branding.requestUpload({ kind: 'company', companyId }, dto);
  }

  @Post('preview')
  @HttpCode(HttpStatus.OK)
  @RequirePermission('company_template:write')
  @ApiOperation({
    summary: 'The palette of a template’s two colours, for its editor’s preview',
    description: 'Writes nothing. Each colour’s words, their ratio and its `fill`, as the KPM’s preview answers.',
  })
  async preview(@Param('companyId') companyId: string, @Param('templateId') templateId: string, @Body() dto: BrandingPreviewDto) {
    await this.branding.requireTemplate(companyId, templateId);
    return this.branding.preview(dto.primary, dto.secondary);
  }

  @Post('uploads/confirm')
  @HttpCode(HttpStatus.OK)
  @RequirePermission('company_template:write')
  @ApiOperation({ summary: 'Confirm a template’s picture: checked, and made into its sizes' })
  async confirm(@Param('companyId') companyId: string, @Param('templateId') templateId: string, @Body() dto: ConfirmBrandingUploadDto) {
    await this.branding.requireTemplate(companyId, templateId);
    return this.branding.confirmUpload({ kind: 'company', companyId }, dto);
  }
}

/**
 * **A KPM's marks, without a session** (P19.6-T1 AC-13, AC-16; ADR-0218 §4, §9): the sign-in page's name, colours and
 * logo by the KPM's id — never by its code — and the sizes made from its images, read from the private bucket. Nothing
 * here is personal data.
 */
@ApiTags('KPM branding')
@Controller('kpm-branding')
export class PublicBrandingController {
  constructor(private readonly branding: BrandingService, private readonly limiter: RateLimiter) {}

  @Public()
  @Get(':kpmId')
  @Header('Cache-Control', 'public, max-age=300')
  @ApiOperation({
    summary: 'A KPM’s name, colours and logo size, for its sign-in page',
    description: 'All `null` for an id that names no live KPM — unknown, malformed, suspended, archived or deleted alike. '
      + '60 a minute per address, `429 AUTH_RATE_LIMITED`.',
  })
  async read(@Param('kpmId') kpmId: string, @Req() req: Request) {
    const retry = this.limiter.check(`kpm-branding:${req.ip ?? 'unknown'}`, BRANDING.PUBLIC_READS_PER_WINDOW, BRANDING.PUBLIC_READ_WINDOW_SECONDS);
    if (retry !== null) {
      throw new DomainException(ErrorCode.AUTH_RATE_LIMITED, BRANDING_REFUSALS.AUTH_RATE_LIMITED.tooMany, HttpStatus.TOO_MANY_REQUESTS, { retryAfterSeconds: retry });
    }
    return this.branding.publicRead(kpmId);
  }

  @Public()
  @Get(':kpmId/files/:file')
  @ApiOperation({
    summary: 'One size of a KPM’s logo, icon or mascot',
    description: 'Cached for a year with the current `v`, five minutes without it. `404` for a file the KPM does not show. '
      + 'Only the sizes made from an upload are served, never the original.',
  })
  async file(@Param('kpmId') kpmId: string, @Param('file') name: string, @Query('v') v: string | undefined, @Res() res: Response) {
    const found = await this.branding.file(kpmId, name);
    if (!found) throw new NotFoundException('Asset');
    res.setHeader('Content-Type', found.mimeType);
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Cache-Control', v === found.version
      ? `public, max-age=${BRANDING.FILE_MAX_AGE_SECONDS}, immutable`
      : `public, max-age=${BRANDING.FILE_UNVERSIONED_MAX_AGE_SECONDS}`);
    res.send(found.body);
  }
}
