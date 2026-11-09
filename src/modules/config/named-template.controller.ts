import {
  Body, Controller, Get, HttpCode, HttpStatus, Param, Patch, Post, Put, Query,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { Ctx, RequirePermission } from '@/common/auth/auth.decorators';
import { RequestContext } from '@/common/context/request-context';
import { NamedTemplateService } from './named-template.service';
import { TemplateCopyService } from './template-copy.service';
import { TemplateService } from './template.service';
import { CreateTemplateDto, ImportTemplateDto, UpdateTemplateDto } from './named-template.dto';
import { ConfirmUploadDto, RequestUploadDto } from '@/modules/training/training.dto';
import { TemplateMaterialService } from './template-material.service';
import { TemplatePushService } from './template-push.service';
import { ApplyTemplateDto, SaveTemplateModuleContentDto, TemplateOfficesQuery } from './template-push.dto';

/**
 * **A company's named templates** (ADR-0115 §3, §5, §7; P13.2-T6) — and, since P13.2-T7, a copy of one
 * (`POST` with `from: { templateId }`) and an import from another company (`POST …/import`).
 *
 * The Super Admin's alone: `company_template:read` and `company_template:write`, which no tenant role
 * holds and a support session — acting as the member it impersonates — does not either. Each kind of a
 * template is still read, drafted and published at `…/template/:kind` with `?templateId=`; since ADR-0185,
 * every kind with a draft is published at once (`POST …/:templateId/publish`), and the offices the template
 * answers for are listed with what each is behind on (`GET …/:templateId/offices`).
 */
@ApiTags('admin (Super Admin)')
@ApiBearerAuth()
@Controller('admin/companies/:companyId/templates')
export class NamedTemplateController {
  constructor(
    private readonly templates: NamedTemplateService,
    /** The copies across an owner boundary (P13.2-T7): *Import from another company*. */
    private readonly copies: TemplateCopyService,
    /** A template's kinds, published together (ADR-0185 §3): *Terbitkan semua*. */
    private readonly kinds: TemplateService,
    /** ADR-0208: the *Training* section's material, and the push to the KPMs made from the template. */
    private readonly material: TemplateMaterialService,
    private readonly push: TemplatePushService,
  ) {}

  @Get()
  @RequirePermission('company_template:read')
  @ApiOperation({
    summary: 'A company’s templates',
    description:
      'Every named template of the company, the default first: its name, whether it is the default, '
      + 'active or archived, where it came from, the newest published version of each of its seven '
      + 'kinds (null where none is, which an office made from it gets empty), `sections` — each kind\u2019s '
      + 'newest published version and whether a draft waits (ADR-0185 §3), for the template\u2019s card and '
      + 'its checklist — and how many live offices it answers for. Archived templates are listed — offices '
      + 'record that they started from one — and are not offered as *Start from*. 404 for a company that '
      + 'does not exist.',
  })
  async list(@Param('companyId') companyId: string) {
    return this.templates.list(companyId);
  }

  @Post()
  @RequirePermission('company_template:write')
  @ApiOperation({
    summary: 'New template',
    description:
      '`from: "empty"` holds nothing, so an office made from it starts empty but for the three '
      + 'cascade activity types; `from: "defaults"` publishes each of the seven kinds as version 1 of '
      + 'the AgencyBoost defaults; `from: { templateId }` copies one of this company\u2019s templates — '
      + 'each kind\u2019s newest published version becomes the copy\u2019s version 1, a draft is not copied, '
      + 'codes are kept and training files referenced; 404 for a template that is not the '
      + 'company\u2019s. Never the default when made. 409 TEMPLATE_NAME_TAKEN when an active '
      + 'template of the company already has the name (compared ignoring case). Audited once, naming the '
      + 'source of a copy.',
  })
  async create(
    @Ctx() ctx: RequestContext,
    @Param('companyId') companyId: string,
    @Body() dto: CreateTemplateDto,
  ) {
    return this.templates.create(ctx, companyId, dto);
  }

  @Post('import')
  @RequirePermission('company_template:write')
  @ApiOperation({
    summary: 'Import a template from another company',
    description:
      'One template of `fromCompanyId` becomes a new template of this company (ADR-0115 §5): '
      + 'each kind\u2019s newest published version as version 1, drafts not copied, codes kept. Every '
      + 'training file is **duplicated** into this company\u2019s assets; links are copied as links. '
      + 'Nothing links back: later edits on either side never reach the other. 409 '
      + 'TEMPLATE_RUNG_UNKNOWN `{ codes }` when a ratio or an activity section names a rung this '
      + 'company\u2019s ladder lacks; 409 TEMPLATE_NAME_TAKEN; 409 ASSET_NOT_CONFIRMED for a file that '
      + 'never finished uploading; 400 for this company as its own source; 404 for an unknown company or a '
      + 'template that is not the source company\u2019s. Every check runs before any write, and the '
      + 'template is written after its files. Audited once, naming both companies.',
  })
  async importFrom(
    @Ctx() ctx: RequestContext,
    @Param('companyId') companyId: string,
    @Body() dto: ImportTemplateDto,
  ) {
    return this.copies.importFrom(ctx, companyId, dto);
  }

  @Patch(':templateId')
  @RequirePermission('company_template:write')
  @ApiOperation({
    summary: 'Rename a template, or make it the default',
    description:
      '`name` renames it (409 TEMPLATE_NAME_TAKEN as above). `isDefault: true` makes it the company’s '
      + 'default, moving it from the template that was; refused (400) for an archived template. '
      + '`isDefault: false` on the default is 409 TEMPLATE_IS_DEFAULT — another is made the default '
      + 'instead. Every refusal comes before any write. 409 VERSION_CONFLICT when the company\u2019s '
      + 'default changed while this was being made the default — nothing is changed, and the old default '
      + 'stands. Each change audited. 404 for a template that is not the company\u2019s.',
  })
  async update(
    @Ctx() ctx: RequestContext,
    @Param('companyId') companyId: string,
    @Param('templateId') templateId: string,
    @Body() dto: UpdateTemplateDto,
  ) {
    return this.templates.update(ctx, companyId, templateId, dto);
  }

  @Post(':templateId/publish')
  @HttpCode(HttpStatus.OK)
  @RequirePermission('company_template:write')
  @ApiOperation({
    summary: 'Publish every section of a template that has changes',
    description:
      '*Terbitkan semua* (ADR-0185 §3): every kind of the template holding a draft is published, in the '
      + 'order `activity_taxonomy`, `ratio_set`, `lead_pipeline`, `training_taxonomy`, '
      + '`activation_checklist`, `capability_ladder`, `event_types` — each exactly as '
      + '`POST …/template/:kind/publish` would, the same checks and the same audit row. A refusal stops only '
      + 'its own kind: `results` says, per kind, `published` (with the new `version`), `skipped` '
      + '(`reason: no_changes`, nothing waited) or `refused` (`error.code` and `error.message`, in the '
      + 'reader\u2019s language; still a draft). `template` is the template as it now stands. **Reaches no '
      + 'office that already exists.** 400 for an archived template; 404 for a template that is not the '
      + 'company\u2019s.',
  })
  async publishAll(
    @Ctx() ctx: RequestContext,
    @Param('companyId') companyId: string,
    @Param('templateId') templateId: string,
  ) {
    return this.kinds.publishAll(ctx, companyId, templateId);
  }

  @Get(':templateId/offices')
  @RequirePermission('company_template:read')
  @ApiOperation({
    summary: 'The offices a template answers for, and where each stands',
    description:
      'Every live office started from the template — and, for the template each company was given when '
      + 'templates were named, the offices created before then — by code, with `behind`, the kinds the '
      + 'template has since published a newer version of than the office was built from, and `unrecorded`, '
      + 'the kinds the office has no record of (ADR-0185 §4). **With `?kind=`** (one kind, or several separated by '
      + 'commas) each office also says where it stands on them (ADR-0208 §4): `state` and, per kind, `unchanged`, '
      + '`changed` — it differs, by code, on the fields an Owner edits, from the version of this template it was last '
      + 'given, with what it added, removed or changed — or `current`, already on the newest version; for training, '
      + '`ownMaterialModules`, the modules showing the office\u2019s own material. What the publish dialog lists. 400 for '
      + 'a kind that is not one; 404 for a template that is not the company\u2019s.',
  })
  async offices(
    @Ctx() ctx: RequestContext,
    @Param('companyId') companyId: string,
    @Param('templateId') templateId: string,
    @Query() query: TemplateOfficesQuery,
  ) {
    if (query.kind) return this.push.standings(ctx, companyId, templateId, [query.kind]);
    return this.templates.offices(ctx, companyId, templateId);
  }

  @Post(':templateId/apply')
  @HttpCode(HttpStatus.OK)
  @RequirePermission('company_template:write')
  @ApiOperation({
    summary: 'Apply the template to offices that already exist',
    description:
      '*Terapkan juga ke KPM yang sudah ada* (ADR-0208 §4, §5): each of `kinds`, as the template\u2019s newest published '
      + 'version, written into each of `kpmIds` — every one an office made from this template, of its own company. '
      + 'Items are matched by code: written as the template has them, an item only the office has archived, an item '
      + 'new to it added; codes, and agents\u2019 progress by code, kept. A training module\u2019s company material '
      + 'becomes the template\u2019s; the office\u2019s own is kept unless the office is in `replaceChanged`, when it '
      + 'moves to the module\u2019s history. The server works out again which offices changed a section themselves: '
      + 'one not in `replaceChanged` is refused `TEMPLATE_APPLY_UNCONFIRMED` and nothing is written for it, the others '
      + 'go ahead. Each office then publishes a new version, its origin the push — unless it had changes of its own '
      + 'waiting (`awaitingPublish`). Per office and kind: `applied`, `skipped` (already current) or `refused`. Audited '
      + 'per office and kind in its own log and once in the platform\u2019s; the Owner and the Admins are told in the '
      + 'app. 409 TEMPLATE_APPLY_UNCONFIRMED when every office was refused that way and nothing was written; 400 for '
      + 'no kind or no office, a kind the template has published nothing of, an archived template, or a built-in one; '
      + '404 for a template that is not the company\u2019s, or an office that is not one of its.',
  })
  async apply(
    @Ctx() ctx: RequestContext,
    @Param('companyId') companyId: string,
    @Param('templateId') templateId: string,
    @Body() dto: ApplyTemplateDto,
  ) {
    return this.push.apply(ctx, companyId, templateId, dto);
  }

  @Post(':templateId/training/uploads')
  @RequirePermission('company_template:write')
  @ApiOperation({
    summary: 'A signed upload for a template\u2019s training material',
    description:
      'The *Training* section\u2019s material (ADR-0208 §1): `.pdf .png .jpg .jpeg .webp .csv .xlsx .html` up to 25 '
      + 'MB, or a `.mp4` video. An HTML lesson is confirmed by its first bytes and drawn only in a sandboxed frame '
      + '(ADR-0217). The file is the company\u2019s — stored under its folder, recorded as this template\u2019s '
      + 'upload — and its bytes go straight from the browser to storage. The limits are checked before a signature is '
      + 'issued. Audited. 400 for an archived template; 404 for a template that is not the company\u2019s.',
  })
  async requestMaterialUpload(
    @Ctx() ctx: RequestContext,
    @Param('companyId') companyId: string,
    @Param('templateId') templateId: string,
    @Body() dto: RequestUploadDto,
  ) {
    return this.material.requestUpload(ctx, companyId, templateId, dto);
  }

  @Post(':templateId/training/uploads/confirm')
  @HttpCode(HttpStatus.OK)
  @RequirePermission('company_template:write')
  @ApiOperation({
    summary: 'Confirm a template\u2019s material arrived',
    description:
      'Asks storage what landed and records that, not what the browser claimed (ADR-0040). Audited. 409 '
      + 'ASSET_NOT_UPLOADED when nothing arrived; 404 for a key this template did not ask for — another '
      + 'template\u2019s, another company\u2019s, or none.',
  })
  async confirmMaterialUpload(
    @Ctx() ctx: RequestContext,
    @Param('companyId') companyId: string,
    @Param('templateId') templateId: string,
    @Body() dto: ConfirmUploadDto,
  ) {
    return this.material.confirmUpload(ctx, companyId, templateId, dto.storageKey);
  }

  @Get(':templateId/training/files/url')
  @RequirePermission('company_template:read')
  @ApiOperation({
    summary: 'A short-lived link to one of a template\u2019s training files, for the editor\u2019s preview',
    description:
      'ADR-0217 §4: the Super Admin previews an HTML lesson in the sandboxed frame before it reaches any office. '
      + 'Signed for 300 seconds on the storage host, never the app\u2019s. The file must be the company\u2019s and this '
      + 'template\u2019s — uploaded into it, or named by its *Training* section as it now stands; anything else is 404, so '
      + 'knowing a key buys nothing. 409 ASSET_NOT_CONFIRMED for an upload not yet confirmed.',
  })
  async materialFileUrl(
    @Ctx() ctx: RequestContext,
    @Param('companyId') companyId: string,
    @Param('templateId') templateId: string,
    @Query('storageKey') storageKey: string,
  ) {
    return this.material.fileUrl(ctx, companyId, templateId, storageKey);
  }

  @Put(':templateId/training/modules/:code/content')
  @RequirePermission('company_template:write')
  @ApiOperation({
    summary: 'A module\u2019s material, in the template\u2019s draft',
    description:
      'The whole material of one module of the *Training* section — files, videos, links — written into the '
      + 'section\u2019s draft, which goes live with *Terbitkan* (ADR-0208 §1). By module **code**. Every file a '
      + 'confirmed upload of this company; links `https` only. `expectedRevision` pins it to the draft the editor '
      + 'read: 409 VERSION_CONFLICT past it, nothing written. Answers the section\u2019s draft as it now stands. '
      + 'Audited. 400 for a module the section does not hold, an archived template, or a file that is not the '
      + 'company\u2019s; 404 for a template that is not the company\u2019s.',
  })
  async saveModuleMaterial(
    @Ctx() ctx: RequestContext,
    @Param('companyId') companyId: string,
    @Param('templateId') templateId: string,
    @Param('code') code: string,
    @Body() dto: SaveTemplateModuleContentDto,
  ) {
    return this.material.saveModuleContent(ctx, companyId, templateId, code, dto, dto.expectedRevision);
  }

  @Post(':templateId/archive')
  @HttpCode(HttpStatus.OK)
  @RequirePermission('company_template:write')
  @ApiOperation({
    summary: 'Archive a template',
    description:
      'Archived, never deleted: it stays readable, because offices record that they started from it, '
      + 'and it is no longer offered. 409 TEMPLATE_IS_DEFAULT for the company’s default — make '
      + 'another the default first; also when it was made the default while this was being archived. '
      + 'Archiving an archived template changes nothing. Audited.',
  })
  async archive(
    @Ctx() ctx: RequestContext,
    @Param('companyId') companyId: string,
    @Param('templateId') templateId: string,
  ) {
    return this.templates.archive(ctx, companyId, templateId);
  }
}
