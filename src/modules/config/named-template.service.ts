import { HttpStatus, Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';
import { Clock } from '@/common/clock/clock.port';
import { RequestContext } from '@/common/context/request-context';
import {
  DomainException, InvalidRequestException, NotFoundException, PermissionDeniedException,
} from '@/common/errors/domain.exception';
import { ErrorCode } from '@/common/errors/error-codes';
import type { Sentence } from '@/common/i18n/sentence';
import { AuditService } from '@/modules/audit/audit.service';
import { can } from '@/modules/rbac/permissions';
import { Company, CompanyDocument } from '@/modules/tenants/company.schema';
import { CompanyTemplate, CompanyTemplateDocument } from './company-template.schema';
import {
  NamedTemplate, NamedTemplateDocument, type TemplateOrigin,
} from './named-template.schema';
import { OfficeCounter, standingOf, type TemplateScope } from './office-counter.port';
import type { TemplateKinds } from './office-template';
import {
  OFFICE_TEMPLATE_KINDS, platformDefaultPayload, type OfficeTemplateKind,
} from './template-defaults';
import { TEMPLATE_REFUSALS } from './template.messages';

/**
 * How a new template starts (ADR-0115 §5): empty, the AgencyBoost defaults, or **a copy of one of the
 * company's templates** (P13.2-T7).
 */
export type NewTemplateFrom = 'empty' | 'defaults' | { templateId: string };

/** One template's kinds as published now, and which version of each that was. */
export interface PublishedKinds {
  kinds: TemplateKinds;
  versions: Partial<Record<OfficeTemplateKind, number>>;
}

/**
 * **Where one kind of a template stands** (ADR-0185 §3): what the template card's *x/6 bagian terbit* and *n perubahan
 * belum terbit*, and the checklist's *Terbit vN · Draf · Kosong*, are read from.
 */
export interface TemplateSectionState {
  /** The newest published version, `null` where none is — which an office made from the template gets empty. */
  publishedVersion: number | null;
  /** A draft is waiting: saved, not published. */
  hasDraft: boolean;
}

/**
 * **One office the template answers for, and the kinds it is behind on** (ADR-0185 §4): the list behind the checklist's
 * *N KPM memakai versi lama*. `behind` and `unrecorded` are counted apart, as `standing` counts them (P5-T12).
 */
export interface TemplateOfficeView {
  id: string;
  code: string;
  branchName: string;
  /** Kinds this template has published a newer version of than the office was built from, or held none of then. */
  behind: OfficeTemplateKind[];
  /** Kinds the office has no record of — created before provisioning recorded them, so not known. */
  unrecorded: OfficeTemplateKind[];
}

/** One named template as the console reads it. */
export interface NamedTemplateView {
  id: string;
  companyId: string;
  name: string;
  isDefault: boolean;
  status: 'active' | 'archived';
  archivedAt: string | null;
  origin: TemplateOrigin;
  /**
   * The newest published version of each of its seven kinds, `null` where it has published none —
   * which an office made from it gets **empty** (ADR-0115 §3).
   */
  publishedVersions: Record<OfficeTemplateKind, number | null>;
  /**
   * **Each of its seven kinds: its newest published version and whether a draft waits** (ADR-0185 §3), for the
   * template's card and its checklist — one read for the list, never one per kind.
   */
  sections: Record<OfficeTemplateKind, TemplateSectionState>;
  /** The live offices it answers for: started from it, and for the migration's, those before 13.2. */
  officeCount: number;
  createdAt: string;
  updatedAt: string;
}

/** The case-folded comparison the unique index makes. */
const NAME_COLLATION = { locale: 'en', strength: 2 } as const;

/**
 * **A company's named templates** (ADR-0115 §3, §5, §7; P13.2-T6).
 *
 * A company holds several, exactly one its **default**. Each is a name over the seven per-office kinds,
 * whose rows stay in `companyTemplates` and are drafted and published per kind by `TemplateService`.
 * Every write here is the Super Admin's (`company_template:write`), and every one is audited.
 *
 * **Archived, never deleted** (invariant §3): an archived template is still read — offices record that
 * they started from it — and is not offered. The default is never archived: another is made the
 * default first.
 *
 * **Checked here as well as at the guard** (exit review of P13.2, N3): `create`, `update` and `archive`
 * refuse anybody without `company_template:write`, the `require`/`can` pattern `TenantService` uses.
 * `createFirst` is made with a company, under `company:crud`, which its caller checks.
 */
@Injectable()
export class NamedTemplateService {
  constructor(
    @InjectModel(NamedTemplate.name) private readonly named: Model<NamedTemplateDocument>,
    @InjectModel(CompanyTemplate.name) private readonly rows: Model<CompanyTemplateDocument>,
    @InjectModel(Company.name) private readonly companies: Model<CompanyDocument>,
    private readonly officesOf: OfficeCounter,
    private readonly audit: AuditService,
    private readonly clock: Clock,
  ) {}

  /** Every template of the company, archived ones too — the default first, then by name. */
  async list(companyId: string): Promise<NamedTemplateView[]> {
    await this.requireCompany(companyId);
    const templates = await this.named
      .find({ companyId, deletedAt: null })
      .collation(NAME_COLLATION)
      .sort({ isDefault: -1, status: 1, name: 1 })
      .exec();
    return this.views(companyId, templates);
  }

  /**
   * **New template**: empty, the AgencyBoost defaults with each kind a published version 1, or **a
   * copy** of one of this company's templates (P13.2-T7 AC-1).
   *
   * *Empty* holds nothing at all, and an office made from it starts empty but for the three cascade
   * types (ADR-0115 §1, §2). The empty-publish refusal stays: leaving a kind unpublished is how a
   * template says *empty*.
   */
  async create(
    ctx: RequestContext,
    companyId: string,
    input: { name: string; from: NewTemplateFrom },
  ): Promise<NamedTemplateView> {
    this.require(ctx);
    const name = await this.checkNewName(companyId, input.name);
    if (typeof input.from === 'object') return this.copy(ctx, companyId, name, input.from.templateId);

    // Its kinds first, the template last, as every copy writes it (exit review, finding 5).
    const template = await this.writeTemplate(
      ctx, companyId, name, { kind: input.from }, input.from === 'defaults' ? defaultKinds() : {},
    );

    await this.audit.record(ctx, {
      action: 'template.created',
      targetCollection: 'templates',
      targetId: String(template._id),
      after: { companyId, name, from: input.from, isDefault: false },
    });
    return (await this.views(companyId, [template]))[0];
  }

  /**
   * **A copy within the company** (ADR-0115 §5, §6; P13.2-T7 AC-1): each kind's newest **published**
   * version becomes the copy's published version 1; a draft is not copied, codes are kept, and a
   * training file is **referenced**, as provisioning references it — the company's material, never
   * duplicated within its own company (ADR-0032). The copy and its source share nothing afterwards: a
   * later draft and publish on either side is a new row of that side's alone.
   *
   * Any of the company's templates may be copied, an archived one too — it stays readable, and a copy
   * is how it comes back into use. One audit row names the source and the copy.
   */
  private async copy(
    ctx: RequestContext, companyId: string, name: string, sourceId: string,
  ): Promise<NamedTemplateView> {
    const source = await this.find(companyId, sourceId);
    const { kinds, versions } = await this.publishedKindsOf(companyId, String(source._id));
    const template = await this.writeTemplate(
      ctx, companyId, name, { kind: 'copy', templateId: String(source._id) }, kinds,
    );
    await this.audit.record(ctx, {
      action: 'template.created',
      targetCollection: 'templates',
      targetId: String(template._id),
      after: {
        companyId, name, from: 'copy', isDefault: false,
        source: { companyId, templateId: String(source._id), name: source.name, versions },
        filesDuplicated: 0,
      },
    });
    return this.viewOf(companyId, template);
  }

  /**
   * **A company's first template**, made with the company (ADR-0115 §1, §3): its default, named
   * *"{Company name} template"*. `usesPlatformDefaults` decides what it holds — every kind a published
   * version 1 of the AgencyBoost defaults, or nothing — and now decides nothing else about an office.
   */
  async createFirst(ctx: RequestContext, company: CompanyDocument): Promise<NamedTemplateDocument> {
    const companyId = String(company._id);
    const from: NewTemplateFrom = company.usesPlatformDefaults ? 'defaults' : 'empty';
    const name = `${company.name} template`;
    const template = await this.writeTemplate(
      ctx, companyId, name, { kind: from }, from === 'defaults' ? defaultKinds() : {}, true,
    );

    await this.audit.record(ctx, {
      action: 'template.created',
      targetCollection: 'templates',
      targetId: String(template._id),
      after: { companyId, name, from, isDefault: true },
    });
    return template;
  }

  /**
   * Rename, or **Make default** — which moves the default here from wherever it was, so a company
   * always has exactly one. Un-defaulting is not a write anybody can make: another is made the default.
   *
   * **Every refusal before any write** (exit review, finding 4): `{ name, isDefault: false }` on the
   * default used to rename it, audit the rename, and only then answer `409 TEMPLATE_IS_DEFAULT`.
   */
  async update(
    ctx: RequestContext,
    companyId: string,
    templateId: string,
    input: { name?: string; isDefault?: boolean },
  ): Promise<NamedTemplateView> {
    this.require(ctx);
    const template = await this.find(companyId, templateId);

    const name = input.name !== undefined ? this.cleanName(input.name) : template.name;
    const renaming = name !== template.name;
    if (renaming && template.status === 'active') await this.refuseNameTaken(companyId, name, templateId);
    if (input.isDefault === false && template.isDefault) {
      // A company always has exactly one default: it moves by making another the default.
      throw this.isDefault(TEMPLATE_REFUSALS.TEMPLATE_IS_DEFAULT.cannotStopBeingDefault({ name: template.name }));
    }
    const makingDefault = input.isDefault === true && !template.isDefault;
    if (makingDefault && template.status === 'archived') throw this.archivedCannotBeDefault();

    if (renaming) {
      const before = template.name;
      template.name = name;
      template.updatedBy = ctx.userId;
      await this.saveNamed(template);
      await this.audit.record(ctx, {
        action: 'template.renamed',
        targetCollection: 'templates',
        targetId: templateId,
        before: { name: before },
        after: { companyId, name },
      });
    }
    if (makingDefault) await this.makeDefault(ctx, companyId, template);

    return (await this.views(companyId, [template]))[0];
  }

  /**
   * **Archive**, never delete. Refused for the default (`TEMPLATE_IS_DEFAULT`); a second archive is a no-op.
   *
   * **One conditional write** (exit review, finding 3): archived only while it is not the default and
   * still active, so an archive racing *Make default* on the same template cannot leave the company's
   * default archived — one of the two writes finds its condition gone and is refused.
   */
  async archive(ctx: RequestContext, companyId: string, templateId: string): Promise<NamedTemplateView> {
    this.require(ctx);
    const template = await this.find(companyId, templateId);
    if (template.isDefault) throw this.archivingTheDefault(template.name);
    if (template.status === 'archived') return (await this.views(companyId, [template]))[0];

    const at = this.clock.now();
    const archived = await this.named.updateOne(
      { _id: template._id, companyId, isDefault: false, status: 'active', deletedAt: null },
      { $set: { status: 'archived', archivedAt: at, updatedBy: ctx.userId } },
    ).exec();
    if (archived.matchedCount === 0) {
      // Something moved between the read and the write: say what it is now.
      const now = await this.find(companyId, templateId);
      if (now.isDefault) throw this.archivingTheDefault(now.name);
      return (await this.views(companyId, [now]))[0];
    }
    template.status = 'archived';
    template.archivedAt = at;
    template.updatedBy = ctx.userId;
    await this.audit.record(ctx, {
      action: 'template.archived',
      targetCollection: 'templates',
      targetId: templateId,
      before: { status: 'active' },
      after: { companyId, name: template.name, status: 'archived' },
    });
    return (await this.views(companyId, [template]))[0];
  }

  /**
   * The template a kind route means: the one named, or **the company's default** when none is.
   * Archived ones resolve — they stay readable — and a write to one is refused by the caller.
   */
  async resolve(companyId: string, templateId?: string | null): Promise<NamedTemplateDocument> {
    if (templateId) return this.find(companyId, templateId);
    const found = await this.named
      .findOne({ companyId, isDefault: true, deletedAt: null }).exec();
    if (!found) throw new NotFoundException('Template');
    return found;
  }

  /** What `OfficeCounter` needs to count one template's offices. */
  scopeOf(template: NamedTemplateDocument): TemplateScope {
    return { templateId: String(template._id), holdsLegacyOffices: template.origin?.kind === 'migration' };
  }

  /**
   * **The live offices one template answers for, each with the kinds it is behind on** (ADR-0185 §4): what the
   * checklist's *N KPM memakai versi lama* opens. Information only — copy, never link (ADR-0115 §6): nothing here
   * changes an office. Every office the template answers for, by code; an archived template's too, as it stays
   * readable. `404` for a company or a template that is not the company's.
   *
   * **`company_template:read`, asked here as well as on the route** (S6 of the T17–T20 permission review): this lists
   * offices across the company, so it is refused before anything is read to a caller without it, whoever calls it —
   * as `publishAll` asks `company_template:write`.
   */
  async offices(ctx: RequestContext, companyId: string, templateId: string): Promise<TemplateOfficeView[]> {
    if (!can(ctx, 'company_template:read')) throw new PermissionDeniedException('company_template:read');
    await this.requireCompany(companyId);
    const template = await this.find(companyId, templateId);
    const [states, offices] = await Promise.all([
      this.sectionsOf(companyId, [String(template._id)]),
      this.officesOf.officesOf(companyId, this.scopeOf(template)),
    ]);
    const sections = states.get(String(template._id))!;
    return offices.map((office) => {
      const behind: OfficeTemplateKind[] = [];
      const unrecorded: OfficeTemplateKind[] = [];
      for (const kind of OFFICE_TEMPLATE_KINDS) {
        const published = sections[kind].publishedVersion;
        // Nothing published of the kind: there is no version to be behind, or unrecorded against.
        if (published === null) continue;
        const standing = standingOf(office.seededFrom[kind], published);
        if (standing === 'behind') behind.push(kind);
        if (standing === 'unrecorded') unrecorded.push(kind);
      }
      return { id: office.id, code: office.code, branchName: office.branchName, behind, unrecorded };
    });
  }

  // ------------------------------------------------- what the copies share (P13.2-T7)

  /**
   * **A new template's name, checked before anything is written**: the company exists (`404`), the
   * name is cleaned, and no active template of the company has it (`409 TEMPLATE_NAME_TAKEN`).
   */
  async checkNewName(companyId: string, raw: string): Promise<string> {
    await this.requireCompany(companyId);
    const name = this.cleanName(raw);
    await this.refuseNameTaken(companyId, name, null);
    return name;
  }

  /** The company exists and is not deleted, or `404`. */
  async checkCompany(companyId: string): Promise<void> {
    await this.requireCompany(companyId);
  }

  /**
   * **The Template library and its default template** (ADR-0164): the one company of kind `template`, which a
   * new company copies and a new office may start from. `null` where there is none — a database migration
   * `0037` has not run on, as a spec's may be — and the caller falls back to the AgencyBoost defaults.
   */
  async library(): Promise<{ companyId: string; template: NamedTemplateDocument } | null> {
    const company = await this.companies.findOne({ kind: 'template', deletedAt: null }, { _id: 1 }).exec();
    if (!company) return null;
    const companyId = String(company._id);
    const template = await this.named.findOne({ companyId, isDefault: true, deletedAt: null }).exec();
    return template ? { companyId, template } : null;
  }

  /**
   * **A company-level kind, copied to a new company** (ADR-0164 §4): the source's newest published
   * `campaign_kinds`, as the new company's published version 1 under no template — so its tab reads what its
   * carrier rules were copied from, not the platform's. Nothing where the source never published one. A copy,
   * never a link. `true` when it wrote.
   */
  async copyCompanyKind(
    ctx: RequestContext, kind: 'campaign_kinds', fromCompanyId: string, companyId: string,
  ): Promise<boolean> {
    const source = await this.rows
      .findOne({ companyId: fromCompanyId, templateId: null, kind, status: 'published', deletedAt: null })
      .sort({ version: -1 })
      .exec();
    if (!source) return false;
    if (await this.rows.exists({ companyId, templateId: null, kind, deletedAt: null }).exec()) return false;
    await this.rows.create({
      companyId, templateId: null, kind, version: 1, status: 'published',
      payload: structuredClone(source.toObject().payload), publishedAt: this.clock.now(),
      deletedAt: null, createdBy: ctx.userId, updatedBy: ctx.userId,
    });
    return true;
  }

  /** One of the company's templates, archived ones included; `404` for any other id. */
  async findOf(companyId: string, templateId: string): Promise<NamedTemplateDocument> {
    return this.find(companyId, templateId);
  }

  /**
   * **One template's kinds as published now** — the newest published row of each, filtered by its
   * company and its id, and nothing where it published none. A draft is never read: it is somebody's
   * work in progress. The named read a copy and an import make of a template (ADR-0115 §6).
   */
  async publishedKindsOf(companyId: string, templateId: string): Promise<PublishedKinds> {
    const rows = await Promise.all(OFFICE_TEMPLATE_KINDS.map((kind) => this.rows
      .findOne({ companyId, templateId, kind, status: 'published', deletedAt: null })
      .sort({ version: -1 })
      .exec()));
    const kinds: TemplateKinds = {};
    const versions: PublishedKinds['versions'] = {};
    OFFICE_TEMPLATE_KINDS.forEach((kind, i) => {
      const row = rows[i];
      if (!row) return;
      kinds[kind] = structuredClone(row.payload);
      versions[kind] = row.version;
    });
    return { kinds, versions };
  }

  /**
   * **Write a new template from its kinds, the template last** (P13.2-T7 AC-5): each kind a published
   * version 1 under an id minted here, and only then the template that names them — so a template is
   * never seen with half its kinds, and a refusal at the end (a name taken by a race the pre-check could
   * not see) soft-deletes the rows already written, leaving nothing anybody can reach. Never the
   * default when made, but for a company's first. A kind absent from `kinds` is left unpublished: held
   * empty. *New template* from the AgencyBoost defaults and a company's first template are written here
   * too since P13.2's exit review (finding 5): they wrote the template first and its kinds after it.
   */
  async writeTemplate(
    ctx: RequestContext,
    companyId: string,
    name: string,
    origin: TemplateOrigin,
    kinds: TemplateKinds,
    /** Only a company's first template is made the default, with the company. */
    isDefault = false,
  ): Promise<NamedTemplateDocument> {
    const _id = new Types.ObjectId();
    const templateId = String(_id);
    const now = this.clock.now();
    const rows = OFFICE_TEMPLATE_KINDS.filter((kind) => kinds[kind]).map((kind) => ({
      companyId, templateId, kind, version: 1, status: 'published' as const,
      payload: structuredClone(kinds[kind]!), publishedAt: now,
      deletedAt: null, createdBy: ctx.userId, updatedBy: ctx.userId,
    }));
    try {
      if (rows.length) await this.rows.insertMany(rows);
      return await this.named.create({
        _id, companyId, name, isDefault, status: 'active', archivedAt: null, origin,
        deletedAt: null, createdBy: ctx.userId, updatedBy: ctx.userId,
      });
    } catch (err) {
      // Under an id nothing names yet, so nobody could have read them; soft-deleted all the same.
      await this.rows.updateMany(
        { companyId, templateId, deletedAt: null }, { $set: { deletedAt: now } },
      ).exec();
      if (isDuplicate(err)) throw isDefaultIndex(err) ? this.defaultMoved() : this.nameTaken(name);
      throw err;
    }
  }

  /** One template as the console reads it. */
  async viewOf(companyId: string, template: NamedTemplateDocument): Promise<NamedTemplateView> {
    return (await this.views(companyId, [template]))[0];
  }

  // -------------------------------------------------------------------- internals

  private async find(companyId: string, templateId: string): Promise<NamedTemplateDocument> {
    const template = await this.named
      .findOne({ _id: templateId, companyId, deletedAt: null }).exec()
      // A malformed id arrives from a URL: "not here", never a CastError and a 500.
      .catch(() => null);
    if (!template) throw new NotFoundException('Template');
    return template;
  }

  private async requireCompany(companyId: string): Promise<CompanyDocument> {
    const company = await this.companies
      .findOne({ _id: companyId, deletedAt: null }).exec()
      .catch(() => null);
    if (!company) throw new NotFoundException('Company');
    return company;
  }

  private cleanName(raw: string): string {
    const name = raw.trim().replace(/\s+/g, ' ');
    if (!name) throw new InvalidRequestException(TEMPLATE_REFUSALS.VALIDATION_FAILED.templateNeedsName);
    return name;
  }

  private async refuseNameTaken(companyId: string, name: string, except: string | null): Promise<void> {
    const clash = await this.named
      .findOne({
        companyId, name, status: 'active', deletedAt: null,
        ...(except ? { _id: { $ne: except } } : {}),
      })
      .collation(NAME_COLLATION)
      .exec();
    if (clash) throw this.nameTaken(name);
  }

  /** `company_template:write`, or `403 PERM_DENIED` — before anything is read or written. */
  private require(ctx: RequestContext): void {
    if (!can(ctx, 'company_template:write')) throw new PermissionDeniedException('company_template:write');
  }

  /**
   * **Make default**, without ever leaving the company with two defaults or none (exit review, finding 3).
   *
   * The unique index allows one default per company, so the old default is cleared first — **on the
   * condition that it still is the default**: of two *Make default*s racing, the second finds nothing to
   * clear and is refused before it writes. Then this one is set, on the condition that it is still
   * active and not the default — an archive that landed in between leaves it unset. Any failure after the
   * old default was cleared puts it back, so a company is never left without one; a duplicate on the
   * index (a default that appeared in between) answers `409 VERSION_CONFLICT`, never a 500.
   */
  private async makeDefault(ctx: RequestContext, companyId: string, template: NamedTemplateDocument): Promise<void> {
    const previous = await this.named.findOne({ companyId, isDefault: true, deletedAt: null }).exec();
    if (previous) {
      const cleared = await this.named.updateOne(
        { _id: previous._id, companyId, isDefault: true, deletedAt: null },
        { $set: { isDefault: false, updatedBy: ctx.userId } },
      ).exec();
      if (cleared.matchedCount === 0) throw this.defaultMoved();
    }

    const restore = async () => {
      if (!previous) return;
      await this.named.updateOne(
        { _id: previous._id, isDefault: false, deletedAt: null },
        { $set: { isDefault: true, updatedBy: previous.updatedBy } },
      ).exec()
        // A default made in between by somebody else stands: the company has one.
        .catch((err: unknown) => { if (!isDuplicate(err)) throw err; });
    };

    let set: { matchedCount: number };
    try {
      set = await this.named.updateOne(
        { _id: template._id, companyId, isDefault: false, status: 'active', deletedAt: null },
        { $set: { isDefault: true, updatedBy: ctx.userId } },
      ).exec();
    } catch (err) {
      await restore();
      if (isDuplicate(err)) throw this.defaultMoved();
      throw err;
    }
    if (set.matchedCount === 0) {
      await restore();
      const now = await this.find(companyId, String(template._id));
      if (now.status === 'archived') throw this.archivedCannotBeDefault();
      throw this.defaultMoved();
    }

    template.isDefault = true;
    template.updatedBy = ctx.userId;
    await this.audit.record(ctx, {
      action: 'template.default_changed',
      targetCollection: 'templates',
      targetId: String(template._id),
      before: { defaultTemplateId: previous ? String(previous._id) : null },
      after: { companyId, defaultTemplateId: String(template._id), name: template.name },
    });
  }

  private archivingTheDefault(name: string): DomainException {
    return this.isDefault(TEMPLATE_REFUSALS.TEMPLATE_IS_DEFAULT.cannotArchive({ name }));
  }

  private archivedCannotBeDefault(): InvalidRequestException {
    return new InvalidRequestException(TEMPLATE_REFUSALS.VALIDATION_FAILED.archivedCannotBeDefault);
  }

  /**
   * `VERSION_CONFLICT` (409), no `details`: the company's default changed while this write was making
   * another one — two *Make default*s at once, or one racing a company's first template. Nothing of this
   * write stands; reading the list again and trying again succeeds.
   */
  private defaultMoved(): DomainException {
    return new DomainException(
      ErrorCode.VERSION_CONFLICT,
      TEMPLATE_REFUSALS.VERSION_CONFLICT.defaultMoved,
      HttpStatus.CONFLICT,
    );
  }

  /** `TEMPLATE_IS_DEFAULT` (409): archiving the default, or un-defaulting it without a successor. */
  private isDefault(why: Sentence<'TEMPLATE_IS_DEFAULT'>): DomainException {
    return new DomainException(ErrorCode.TEMPLATE_IS_DEFAULT, why, HttpStatus.CONFLICT);
  }

  private nameTaken(name: string): DomainException {
    return new DomainException(
      ErrorCode.TEMPLATE_NAME_TAKEN,
      TEMPLATE_REFUSALS.TEMPLATE_NAME_TAKEN.taken({ name }),
      HttpStatus.CONFLICT,
      { name },
    );
  }

  private async saveNamed(template: NamedTemplateDocument): Promise<void> {
    try {
      await template.save();
    } catch (err) {
      if (isDuplicate(err)) throw this.nameTaken(template.name);
      throw err;
    }
  }

  private async views(companyId: string, templates: NamedTemplateDocument[]): Promise<NamedTemplateView[]> {
    if (templates.length === 0) return [];
    const legacy = await this.named
      .findOne({ companyId, 'origin.kind': 'migration', deletedAt: null }, { _id: 1 }).exec();
    const [counts, states] = await Promise.all([
      this.officesOf.countsByTemplate(companyId, legacy ? String(legacy._id) : null),
      this.sectionsOf(companyId, templates.map((t) => String(t._id))),
    ]);

    return templates.map((t) => {
      const id = String(t._id);
      const sections = states.get(id)!;
      const publishedVersions = Object.fromEntries(OFFICE_TEMPLATE_KINDS.map((kind) => [
        kind, sections[kind].publishedVersion,
      ])) as Record<OfficeTemplateKind, number | null>;
      const stamps = t as unknown as { createdAt?: Date; updatedAt?: Date };
      return {
        id,
        companyId: t.companyId,
        name: t.name,
        isDefault: t.isDefault,
        status: t.status,
        archivedAt: t.archivedAt ? t.archivedAt.toISOString() : null,
        origin: t.origin,
        publishedVersions,
        sections,
        officeCount: counts.get(id) ?? 0,
        createdAt: (stamps.createdAt ?? this.clock.now()).toISOString(),
        updatedAt: (stamps.updatedAt ?? this.clock.now()).toISOString(),
      };
    });
  }

  /**
   * **Each template's seven kinds: the newest published version and whether a draft waits** (ADR-0185 §3) — one
   * aggregate over `companyTemplates` for every template asked about, filtered by the company and the ids. A kind with
   * no row at all is `{ publishedVersion: null, hasDraft: false }`: *Kosong*.
   */
  private async sectionsOf(
    companyId: string, templateIds: string[],
  ): Promise<Map<string, Record<OfficeTemplateKind, TemplateSectionState>>> {
    const rows = await this.rows
      .aggregate<{ _id: { templateId: string; kind: OfficeTemplateKind; status: 'draft' | 'published' }; version: number }>([
        {
          $match: {
            companyId, status: { $in: ['draft', 'published'] }, deletedAt: null,
            templateId: { $in: templateIds },
          },
        },
        {
          $group: {
            _id: { templateId: '$templateId', kind: '$kind', status: '$status' }, version: { $max: '$version' },
          },
        },
      ])
      .exec();

    return new Map(templateIds.map((id) => {
      const mine = rows.filter((r) => r._id.templateId === id);
      const sections = Object.fromEntries(OFFICE_TEMPLATE_KINDS.map((kind) => [kind, {
        publishedVersion: mine.find((r) => r._id.kind === kind && r._id.status === 'published')?.version ?? null,
        hasDraft: mine.some((r) => r._id.kind === kind && r._id.status === 'draft'),
      }])) as Record<OfficeTemplateKind, TemplateSectionState>;
      return [id, sections];
    }));
  }
}

/** Each of the seven kinds as a published version 1 of the AgencyBoost defaults. */
function defaultKinds(): TemplateKinds {
  return Object.fromEntries(OFFICE_TEMPLATE_KINDS.map((kind) => [kind, platformDefaultPayload(kind)]));
}

/** A duplicate key on one of the two unique indexes: the active name, or the one default. */
function isDuplicate(err: unknown): boolean {
  return (err as { code?: number } | null)?.code === 11000;
}

/** Whether the duplicate was the one-default index rather than the name one. */
function isDefaultIndex(err: unknown): boolean {
  const e = err as { keyPattern?: Record<string, unknown>; message?: string };
  return Boolean(e.keyPattern && 'isDefault' in e.keyPattern) || /isDefault/.test(e.message ?? '');
}
