import { Injectable } from '@nestjs/common';
import { RequestContext } from '@/common/context/request-context';
import {
  InvalidRequestException, NotFoundException, PermissionDeniedException,
} from '@/common/errors/domain.exception';
import { TRAINING_FILE_MIME_TYPES } from '@/domain/constants';
import { AssetService } from '@/modules/assets/asset.service';
import { AuditService } from '@/modules/audit/audit.service';
import { can } from '@/modules/rbac/permissions';
import { checkTrainingContent, storageKeysOf, type CheckedContent } from '@/modules/training/training-content';
import type { TrainingTaxonomyPayload } from '@/modules/training/training-payload';
import { NamedTemplateService } from './named-template.service';
import type { NamedTemplateDocument } from './named-template.schema';
import { TemplateService, type TemplateView } from './template.service';
import { TEMPLATE_PUSH_REFUSALS } from './template-push.messages';
import { TEMPLATE_REFUSALS } from './template.messages';

const SAY = TEMPLATE_PUSH_REFUSALS.VALIDATION_FAILED;

/**
 * **The template's training material** (ADR-0208 §1; the 11-03 handover's §B6 *Expected 1*): files, videos and links
 * on each module of a template's *Training* section, written by the Super Admin, as part of the section's draft.
 *
 * - **The files are company assets** (ADR-0032): `companyId`, no `kpmId`, under the company's folder, each recording the
 *   template it was uploaded into (`assets.templateId`). Signed and confirmed exactly as an office's upload is
 *   (ADR-0040), by the same `AssetService`.
 * - **The material is the draft's**: `PUT …/training/modules/:code/content` writes the module's `content` into the
 *   section's draft through `TemplateService.saveDraft` — pinned to the revision the editor read, as every draft save
 *   — and it goes live with *Terbitkan*. A published version and its files never change.
 * - **A new office has it on day one** (§2): provisioning copies each module's `content` into `companyContent`, by
 *   reference.
 *
 * `company_template:write`, the Super Admin's alone — asked here as well as on the route. `404` for a company or a
 * template that is not the company's; `400` for an archived template.
 */
@Injectable()
export class TemplateMaterialService {
  constructor(
    private readonly named: NamedTemplateService,
    private readonly kinds: TemplateService,
    private readonly assets: AssetService,
    private readonly audit: AuditService,
  ) {}

  /** A signed upload for the material, in the company's folder, recorded as this template's (ADR-0040). */
  async requestUpload(
    ctx: RequestContext,
    companyId: string,
    templateId: string,
    params: { filename: string; mimeType: string; bytes: number },
  ) {
    const template = await this.writable(ctx, companyId, templateId);
    const id = String(template._id);
    // The training file's list, HTML lessons included (P19.6-T2, ADR-0217 §1).
    const signed = await this.assets.requestCompanyUpload(
      companyId, { folder: `templates/${id}/training`, ...params }, id, TRAINING_FILE_MIME_TYPES,
    );
    await this.audit.record(ctx, {
      action: 'company_template.material_upload_requested',
      targetCollection: 'assets',
      targetId: signed.storageKey,
      after: { companyId, templateId: id, filename: params.filename, mimeType: params.mimeType, bytes: params.bytes },
    });
    return signed;
  }

  /**
   * Ask storage what landed, and record that (ADR-0040). A file this template did not ask for — another template's,
   * another company's, or none — is a 404, so knowing a key buys nothing.
   */
  async confirmUpload(ctx: RequestContext, companyId: string, templateId: string, storageKey: string) {
    const template = await this.writable(ctx, companyId, templateId);
    const id = String(template._id);
    const asset = await this.assets.companyAsset(companyId, storageKey);
    if (!asset || asset.templateId !== id) throw new NotFoundException('Asset');
    const confirmed = await this.assets.confirmCompanyUpload(companyId, storageKey, TRAINING_FILE_MIME_TYPES);
    await this.audit.record(ctx, {
      action: 'company_template.material_uploaded',
      targetCollection: 'assets',
      targetId: storageKey,
      after: { companyId, templateId: id, mimeType: confirmed.mimeType, bytes: confirmed.bytes },
    });
    return { storageKey: confirmed.storageKey, mimeType: confirmed.mimeType, bytes: confirmed.bytes };
  }

  /**
   * **One module's material, in the section's draft** (ADR-0208 §1): the whole document — files, videos, links — checked
   * by the checker an office's own save meets (`checkTrainingContent`), every file a confirmed upload of **this
   * company**. A copy of a template references the files of the template it was copied from (*Salin dari…*), so a file
   * is the company's, not necessarily this template's. Empty material takes `content` off the module.
   *
   * `expectedRevision` pins the save to the revision the editor read (`409 VERSION_CONFLICT` past it, nothing written).
   * Answers the section's draft as it now stands, as a draft save does.
   */
  async saveModuleContent(
    ctx: RequestContext,
    companyId: string,
    templateId: string,
    code: string,
    body: unknown,
    expectedRevision?: number,
  ): Promise<TemplateView> {
    const template = await this.writable(ctx, companyId, templateId);
    const id = String(template._id);
    const raw = (body ?? {}) as Record<string, unknown>;
    const { expectedRevision: _pin, ...rest } = raw;
    const content = checkTrainingContent(rest);
    await this.requireCompanyFiles(companyId, content);

    const current = await this.kinds.read(companyId, 'training_taxonomy', id, ctx.reader);
    const payload = structuredClone(current.payload) as unknown as Partial<TrainingTaxonomyPayload>;
    const modules = payload.modules ?? [];
    const wanted = code.trim().toUpperCase();
    const module = modules.find((m) => String(m.code).trim().toUpperCase() === wanted);
    if (!module) throw new InvalidRequestException(SAY.moduleNotInTemplate({ code: wanted }));

    const holds = content.files.length + content.videos.length + content.links.length > 0;
    if (holds) module.content = content;
    else delete module.content;
    const pinned = expectedRevision ?? current.revision;
    const saved = await this.kinds.saveDraft(
      ctx, companyId, 'training_taxonomy', payload as unknown as Record<string, unknown>, id, pinned,
    );

    // A file a template names is held: the orphan sweep reports only what nothing names (P13.2-T7 AC-5).
    const before = new Set(storageKeysOf(asChecked(current.payload, wanted)));
    const added = storageKeysOf(content).filter((key) => !before.has(key));
    await this.assets.retainCompanyCopies(companyId, added);

    await this.audit.record(ctx, {
      action: 'company_template.material_saved',
      targetCollection: 'companyTemplates',
      targetId: saved.id,
      after: {
        companyId, templateId: id, moduleCode: wanted,
        files: content.files.length, videos: content.videos.length, links: content.links.length,
      },
    });
    return saved;
  }

  /**
   * **A link to one of the template's training files, for the editor's preview** (P19.6-T2, ADR-0217 §4): the Super
   * Admin opens an HTML lesson in the sandboxed window before it reaches any office. Signed for 300 seconds on the
   * storage host, as every company file is (`AssetService.companyUrlFor`).
   *
   * `company_template:read`. The file must be the company's **and this template's**: uploaded into it
   * (`assets.templateId`), or named by its *Training* section as it now stands — a copy made with *Salin dari…* names its
   * source's files. Anything else — another template's upload, another company's, a stranger key — is a 404, so knowing
   * a key buys nothing; an unconfirmed one is `409 ASSET_NOT_CONFIRMED`.
   */
  async fileUrl(ctx: RequestContext, companyId: string, templateId: string, storageKey: string): Promise<{ url: string }> {
    if (!can(ctx, 'company_template:read')) throw new PermissionDeniedException('company_template:read');
    await this.named.checkCompany(companyId);
    const template = await this.named.findOf(companyId, templateId);
    const id = String(template._id);
    const asset = typeof storageKey === 'string' && storageKey ? await this.assets.companyAsset(companyId, storageKey) : null;
    if (!asset) throw new NotFoundException('Asset');
    if (asset.templateId !== id) {
      const current = await this.kinds.read(companyId, 'training_taxonomy', id, ctx.reader).catch(() => null);
      const modules = ((current?.payload as { modules?: { content?: Partial<CheckedContent> }[] } | undefined)?.modules ?? []);
      const named = modules.some((m) => [...(m.content?.files ?? []), ...(m.content?.videos ?? [])]
        .some((f) => f.storageKey === storageKey));
      if (!named) throw new NotFoundException('Asset');
    }
    return { url: await this.assets.companyUrlFor(companyId, storageKey) };
  }

  /** The template, the caller allowed to write it, and the template active: an archived one is kept, not edited. */
  private async writable(ctx: RequestContext, companyId: string, templateId: string): Promise<NamedTemplateDocument> {
    if (!can(ctx, 'company_template:write')) throw new PermissionDeniedException('company_template:write');
    await this.named.checkCompany(companyId);
    const template = await this.named.findOf(companyId, templateId);
    if (template.status === 'archived') {
      throw new InvalidRequestException(TEMPLATE_REFUSALS.VALIDATION_FAILED.editArchived({ name: template.name }));
    }
    return template;
  }

  /** Every file a module's material names is a confirmed upload of this company — never another's, never a stranger's. */
  private async requireCompanyFiles(companyId: string, content: CheckedContent): Promise<void> {
    for (const file of [...content.files, ...content.videos]) {
      const asset = await this.assets.companyAsset(companyId, file.storageKey);
      if (!asset) throw new InvalidRequestException(SAY.notThisCompanysFile({ label: file.label }));
      // Confirmed, or refused `409 ASSET_NOT_CONFIRMED`: the same check delivery makes.
      await this.assets.companyUrlFor(companyId, file.storageKey);
    }
  }
}

/** One module's material in a template payload, as the checker's shape, or nothing. */
function asChecked(payload: Record<string, unknown>, code: string): CheckedContent {
  const module = ((payload.modules ?? []) as { code: string; content?: Partial<CheckedContent> }[])
    .find((m) => String(m.code).trim().toUpperCase() === code);
  return {
    files: [...(module?.content?.files ?? [])],
    videos: [...(module?.content?.videos ?? [])],
    links: [...(module?.content?.links ?? [])],
  };
}
