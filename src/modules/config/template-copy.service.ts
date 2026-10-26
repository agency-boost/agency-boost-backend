import { BadRequestException, HttpStatus, Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { RequestContext } from '@/common/context/request-context';
import { DomainException, NotFoundException } from '@/common/errors/domain.exception';
import { ErrorCode } from '@/common/errors/error-codes';
import { AuditService } from '@/modules/audit/audit.service';
import { AssetService } from '@/modules/assets/asset.service';
import { can } from '@/modules/rbac/permissions';
import type { StoredObject } from '@/modules/assets/storage.port';
import { Kpm, KpmDocument } from '@/modules/tenants/kpm.schema';
import { OrgLevelService } from '@/modules/tenants/org-level.service';
import { NamedTemplateService, type NamedTemplateView, type PublishedKinds } from './named-template.service';
import type { NamedTemplateDocument, TemplateOrigin } from './named-template.schema';
import { OfficeSettingsSource } from './office-settings.source';
import {
  filesOfTraining, templateKindsFromOffice, withCopiedFiles,
  type DroppedSetting, type TemplateFile, type TemplateKinds,
} from './office-template';
import { ProvisioningService } from './provisioning.service';
import { refuseUnknownRungs } from './template-rungs';

/**
 * *Save as template*'s answer: the template as made, and **what the office held that it left out or
 * changed**, and why (exit review of P13.2, finding 2) — empty when nothing was.
 */
export interface SavedOfficeTemplateView extends NamedTemplateView {
  dropped: DroppedSetting[];
}

/** A file about to be duplicated, with what its source asset row says it was called. */
interface FileToCopy extends TemplateFile {
  originalFilename: string | null;
}

/**
 * **What a new company copies from the Template library** (ADR-0164 §4): its default template's kinds as
 * published now, and every training file they name, known to have arrived — read and checked **before the
 * company exists**, so a refusal leaves no company behind.
 */
export interface LibraryCopy {
  /** The Template library's company id. */
  companyId: string;
  templateId: string;
  templateName: string;
  kinds: TemplateKinds;
  versions: PublishedKinds['versions'];
  files: FileToCopy[];
}

/**
 * **The copies that cross an owner boundary** (ADR-0115 §5, §6; P13.2-T7): an office's published
 * settings saved as a template, and another company's template imported. A copy within one company is
 * `NamedTemplateService.create`'s.
 *
 * **Copies, never links.** Whatever is read is written into the destination as new rows with its codes
 * kept, and nothing written points back at the source but `templates.origin`, which nothing reads.
 *
 * **In this order, so nothing is ever half-made** (AC-5): every check before any write — the office or
 * the template, the destination and its name, each kind (an office's settings meet the same whole-source
 * check provisioning makes), every rung on the destination's ladder, every file known to have arrived;
 * then the files, each duplicated into the destination company's assets and registered referenced by
 * nothing; then the template's kinds and, last, the template; then the files retained. A failure part-way
 * leaves no template, and any file already copied stays at `refCount: 0` — what the orphan sweep reports.
 *
 * **The Super Admin's alone** (`company_template:write`): every tenant role and a support session are
 * refused by the guard before this is reached, and by this service again before it reads anything — the
 * `require`/`can` pattern `TenantService` uses (exit review of P13.2, N3). Each copy writes **one** audit
 * row, naming its source and its destination.
 */
@Injectable()
export class TemplateCopyService {
  constructor(
    private readonly templates: NamedTemplateService,
    private readonly office: OfficeSettingsSource,
    private readonly assets: AssetService,
    private readonly orgLevels: OrgLevelService,
    private readonly provisioning: ProvisioningService,
    @InjectModel(Kpm.name) private readonly kpms: Model<KpmDocument>,
    private readonly audit: AuditService,
  ) {}

  /**
   * **Save this office's settings as a template** (ADR-0115 §5): what its agents read, into a new
   * template of its own company or of another.
   *
   * Within its own company, the company's training material is referenced and only the office's own
   * replacement files are duplicated (they are the office's, and a template is the company's). Into
   * another company everything is duplicated, and every rung the settings name must be on that
   * company's ladder (`409 TEMPLATE_RUNG_UNKNOWN`).
   *
   * **What archiving left behind is dropped, not refused** (exit review, finding 2): a ratio's archived
   * activity type, a stage whose milestones are archived, a checklist link to a module no longer offered —
   * each listed in `dropped`, in the answer and in the audit row. The whole-source check still runs after,
   * so a template saved here can never hold what an office made from it would be refused.
   */
  async saveOffice(
    ctx: RequestContext,
    kpmId: string,
    input: { name: string; companyId: string },
  ): Promise<SavedOfficeTemplateView> {
    this.require(ctx);
    const kpm = await this.kpms.findOne({ _id: kpmId, deletedAt: null }).exec().catch(() => null);
    if (!kpm) throw new NotFoundException('KPM');
    const destination = input.companyId;
    const name = await this.templates.checkNewName(destination, input.name);

    const { kinds, files, dropped } = templateKindsFromOffice(await this.office.publishedSettingsOf(ctx, kpmId));
    this.provisioning.checkSource(`KPM ${kpm.code}’s published settings`, kinds);

    const crossing = destination !== kpm.companyId;
    if (crossing) await this.refuseUnknownRungs(destination, kinds);
    const toCopy = await this.knownFiles(ctx, files.filter((f) => f.owner === 'office' || crossing), {
      kpmId, companyId: kpm.companyId,
    });

    const copies = await this.duplicate(destination, toCopy);
    const written = await this.write(ctx, destination, name, {
      kind: 'office', kpmId, companyId: kpm.companyId,
    }, kinds, copies);

    await this.audit.record(ctx, {
      action: 'template.created',
      targetCollection: 'templates',
      targetId: String(written._id),
      after: {
        companyId: destination, name, from: 'office', isDefault: false,
        source: { kpmId, kpmCode: kpm.code, companyId: kpm.companyId, kinds: Object.keys(kinds) },
        filesDuplicated: copies.size,
        dropped,
      },
    });
    return { ...(await this.templates.viewOf(destination, written)), dropped };
  }

  /**
   * **Import from another company** (ADR-0115 §5): one template of `fromCompanyId` becomes a new
   * template of `companyId` — each kind's newest published version as version 1, every training file
   * duplicated into this company's assets, every rung checked against this company's ladder.
   */
  async importFrom(
    ctx: RequestContext,
    companyId: string,
    input: { fromCompanyId: string; templateId: string; name: string },
  ): Promise<NamedTemplateView> {
    this.require(ctx);
    if (input.fromCompanyId === companyId) {
      throw new BadRequestException(
        'That template is already this company’s. Use New template and copy it instead.',
      );
    }
    const name = await this.templates.checkNewName(companyId, input.name);
    // The source company's template, by its company and its id: another company's is a 404.
    await this.templates.checkCompany(input.fromCompanyId);
    const source = await this.templates.findOf(input.fromCompanyId, input.templateId);
    const { kinds, versions } = await this.templates.publishedKindsOf(input.fromCompanyId, String(source._id));

    await this.refuseUnknownRungs(companyId, kinds);
    const toCopy = await this.knownFiles(ctx, filesOfTraining(kinds.training_taxonomy), {
      kpmId: null, companyId: input.fromCompanyId,
    });

    const copies = await this.duplicate(companyId, toCopy);
    const written = await this.write(ctx, companyId, name, {
      kind: 'import', templateId: String(source._id), companyId: input.fromCompanyId,
    }, kinds, copies);

    await this.audit.record(ctx, {
      action: 'template.created',
      targetCollection: 'templates',
      targetId: String(written._id),
      after: {
        companyId, name, from: 'import', isDefault: false,
        source: { companyId: input.fromCompanyId, templateId: String(source._id), name: source.name, versions },
        filesDuplicated: copies.size,
      },
    });
    return this.templates.viewOf(companyId, written);
  }

  /**
   * **The Template library's default template, read for a new company** (ADR-0164 §4): each kind's newest
   * published version and every training file it names, checked to have arrived. `null` where there is no
   * Template library — a database migration `0037` has not run on — and the company is then given the
   * AgencyBoost defaults as before. Called by `TenantService.createCompany` before it writes the company, under
   * `company:crud`, which it checks.
   */
  async libraryCopy(ctx: RequestContext): Promise<LibraryCopy | null> {
    const library = await this.templates.library();
    if (!library) return null;
    const templateId = String(library.template._id);
    const { kinds, versions } = await this.templates.publishedKindsOf(library.companyId, templateId);
    const files = await this.knownFiles(ctx, filesOfTraining(kinds.training_taxonomy), {
      kpmId: null, companyId: library.companyId,
    });
    return { companyId: library.companyId, templateId, templateName: library.template.name, kinds, versions, files };
  }

  /**
   * **A new company's first template, its default, copied from the Template library** (ADR-0164 §4): named
   * *"{Company name} template"*, as every company's first is, each kind the library published a published
   * version 1, and each training file duplicated into the new company's assets — the library's files are the
   * library's. Its origin names the source. No rung check: the company's ladder is copied from the same
   * library first. One audit row, naming the source.
   */
  async writeFirstFromLibrary(
    ctx: RequestContext, company: { _id: unknown; name: string }, from: LibraryCopy,
  ): Promise<NamedTemplateDocument> {
    const companyId = String(company._id);
    const name = `${company.name} template`;
    const copies = await this.duplicate(companyId, from.files);
    const written = await this.write(ctx, companyId, name, {
      kind: 'copy', templateId: from.templateId, companyId: from.companyId,
    }, from.kinds, copies, true);
    await this.audit.record(ctx, {
      action: 'template.created',
      targetCollection: 'templates',
      targetId: String(written._id),
      after: {
        companyId, name, from: 'copy', isDefault: true,
        source: { companyId: from.companyId, templateId: from.templateId, name: from.templateName, versions: from.versions },
        filesDuplicated: copies.size,
      },
    });
    return written;
  }

  // -------------------------------------------------------------------- internals

  /** `company_template:write`, or `403 PERM_DENIED` — before anything is read. */
  private require(ctx: RequestContext): void {
    if (!can(ctx, 'company_template:write')) {
      throw new DomainException(
        ErrorCode.PERM_DENIED,
        'You do not have permission to perform this action.',
        HttpStatus.FORBIDDEN,
        { permission: 'company_template:write' },
      );
    }
  }

  /**
   * **Every rung the kinds name, on the destination's ladder** (ADR-0115 §6): one refusal naming every
   * code missing, before anything is written or copied. The check is `template-rungs.ts`'s, shared with an
   * office started from the Template library (ADR-0164 §5).
   */
  private async refuseUnknownRungs(companyId: string, kinds: TemplateKinds): Promise<void> {
    await refuseUnknownRungs(kinds, () => this.orgLevels.activeCodesFor(companyId));
  }

  /**
   * **Every file about to be duplicated, known to be its owner's and to have arrived** — before a byte
   * is copied. An office's own file is read through the named office read; a company's through the
   * company's named read. A file the registry does not hold, or holds unconfirmed, refuses the copy:
   * agents are never shown such a file, and a template must not promise one.
   */
  private async knownFiles(
    ctx: RequestContext,
    files: TemplateFile[],
    owners: { kpmId: string | null; companyId: string },
  ): Promise<FileToCopy[]> {
    const unique = [...new Map(files.map((f) => [f.storageKey, f])).values()];
    const officeKeys = unique.filter((f) => f.owner === 'office').map((f) => f.storageKey);
    const officeRows = owners.kpmId ? await this.office.officeFiles(ctx, owners.kpmId, officeKeys) : [];

    const known: FileToCopy[] = [];
    for (const file of unique) {
      const row = file.owner === 'office'
        ? officeRows.find((r) => r.storageKey === file.storageKey) ?? null
        : await this.assets.companyAsset(owners.companyId, file.storageKey);
      if (!row || row.uploadState !== 'confirmed') {
        throw new DomainException(
          ErrorCode.ASSET_NOT_CONFIRMED,
          `The file “${file.label}” in training module ${file.moduleCode} never finished `
            + 'uploading, so it cannot be copied and nothing was. Have it uploaded again, or removed, '
            + 'and try again.',
          HttpStatus.CONFLICT,
          { moduleCode: file.moduleCode, label: file.label },
        );
      }
      known.push({ ...file, originalFilename: row.originalFilename ?? null });
    }
    return known;
  }

  /** Each file duplicated into the destination company's assets, in turn. Old key → the copy. */
  private async duplicate(companyId: string, files: FileToCopy[]): Promise<Map<string, StoredObject>> {
    const copies = new Map<string, StoredObject>();
    for (const file of files) {
      copies.set(file.storageKey, await this.assets.duplicateIntoCompany(companyId, {
        storageKey: file.storageKey, originalFilename: file.originalFilename,
      }));
    }
    return copies;
  }

  /** The template, written after its files and pointing at their copies; then the copies retained. */
  private async write(
    ctx: RequestContext,
    companyId: string,
    name: string,
    origin: TemplateOrigin,
    kinds: TemplateKinds,
    copies: Map<string, StoredObject>,
    /** Only a company's first template is its default, made with it. */
    isDefault = false,
  ): Promise<NamedTemplateDocument> {
    const final: TemplateKinds = { ...kinds };
    if (final.training_taxonomy && copies.size) {
      final.training_taxonomy = withCopiedFiles(final.training_taxonomy, copies);
    }
    const written = await this.templates.writeTemplate(ctx, companyId, name, origin, final, isDefault);
    await this.assets.retainCompanyCopies(companyId, [...copies.values()].map((c) => c.storageKey));
    return written;
  }
}
