import { HttpStatus, Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import type { Model } from 'mongoose';
import { RequestContext } from '@/common/context/request-context';
import {
  DomainException, InvalidRequestException, NotFoundException, PermissionDeniedException,
} from '@/common/errors/domain.exception';
import { ErrorCode } from '@/common/errors/error-codes';
import { AuditService } from '@/modules/audit/audit.service';
import { ProductDraftService, stateOf } from '@/modules/products/product-draft.service';
import { isHeldBy } from '@/modules/products/product.schema';
import { can } from '@/modules/rbac/permissions';
import { Company, CompanyDocument } from '@/modules/tenants/company.schema';
import { Kpm, KpmDocument } from '@/modules/tenants/kpm.schema';
import { COMPANY_PUBLICATION_REFUSALS } from './company-publication.messages';
import { CompanyTemplate, CompanyTemplateDocument, type TemplateKind } from './company-template.schema';
import { NamedTemplateService } from './named-template.service';
import type { NamedTemplateDocument } from './named-template.schema';
import { OfficeCounter } from './office-counter.port';
import { isOfficeTemplateKind, type OfficeTemplateKind } from './template-defaults';
import { differencesOf, itemsOfPayload } from './template-push';
import { TemplatePushService, type ApplyOfficeResult } from './template-push.service';
import { PUBLISH_ORDER, TemplateService } from './template.service';

const SAY = COMPANY_PUBLICATION_REFUSALS.VALIDATION_FAILED;

/**
 * **The settings *Terbitkan ke KPM* lists, by the rows of *Pengaturan template*** (P19.23-T4 AC-4, AC-5; ADR-0278 §5):
 * each the kinds behind it and how it reaches a KPM.
 *
 * - `chosen` — **copied into each KPM** (ADR-0018): published, then pushed to the KPMs chosen, overwriting their own
 *   version of it (ADR-0208 §5). A change while the template holds a draft of it, or while a KPM of the company is behind
 *   its newest published version.
 * - `all` — **read live by every KPM** (ADR-0026's carrier rules, ADR-0210's playbook): publishing reaches every KPM of
 *   the company at once, so no KPM is chosen for it. A change only while a draft waits.
 *
 * *Recruitment pitch* and *Objection handling* are one kind, the recruitment playbook (OD-424). *Advanced analytics* and
 * *Tampilan* are no row of *Pengaturan template*, and keep their own publish.
 */
export const PUBLICATION_SETTINGS = [
  { setting: 'activity_types', kinds: ['activity_taxonomy', 'ratio_set'], reach: 'chosen' },
  { setting: 'lead_statuses', kinds: ['lead_pipeline'], reach: 'chosen' },
  { setting: 'activation_checklist', kinds: ['activation_checklist'], reach: 'chosen' },
  { setting: 'training', kinds: ['training_taxonomy'], reach: 'chosen' },
  { setting: 'capability_mapping', kinds: ['capability_ladder'], reach: 'chosen' },
  { setting: 'events', kinds: ['event_types'], reach: 'chosen' },
  { setting: 'campaigns', kinds: ['campaign_kinds'], reach: 'all' },
  { setting: 'recruitment', kinds: ['recruitment_playbook'], reach: 'all' },
] as const satisfies readonly { setting: string; kinds: readonly TemplateKind[]; reach: 'chosen' | 'all' }[];

export type PublicationSetting = (typeof PUBLICATION_SETTINGS)[number]['setting'];

/** **One change step 1 lists** (ADR-0278 §5). */
export interface PublicationChange {
  /** `setting:<row>` or `product:<id>`: what step 1 sends back. */
  id: string;
  type: 'setting' | 'product_new' | 'product_change';
  setting: PublicationSetting | null;
  kinds: TemplateKind[];
  productId: string | null;
  productCode: string | null;
  productName: string | null;
  /** It waits as a draft, and is published before it reaches anybody. */
  draft: boolean;
  /** `chosen`: the KPMs ticked in step 2. `all`: every KPM that reads it, by itself. */
  reach: 'chosen' | 'all';
  /** A KPM's own version is replaced: *Menimpa daftar … di KPM*. False for a product, which only adds. */
  overwrites: boolean;
  /** The draft against the newest published version, by item: what step 1's line counts. Zero where not counted. */
  added: number;
  changed: number;
  removed: number;
  /** KPMs that do not have it yet: behind its newest published version, or without the product. */
  missing: number;
}

/** **One KPM step 2 lists** (ADR-0278 §6). */
export interface PublicationKpm {
  id: string;
  code: string;
  name: string;
  /** Changes this KPM made its own version of, which publishing to it would overwrite: *akan tertimpa*. */
  ownEdits: string[];
  /** Changes it already has: nothing would reach it. */
  upToDate: string[];
}

export interface PublicationView {
  companyId: string;
  /** The company's default template, which *Pengaturan template* edits; `null` where it has none yet. */
  templateId: string | null;
  /** The Default template (the Template library): it has no KPM, and *Terbitkan ke KPM* is not its. */
  library: boolean;
  changes: PublicationChange[];
  kpms: PublicationKpm[];
}

/** The company card's line (AC-1): how many changes wait, and whether its template is still empty. */
export interface PublicationSummary {
  companyId: string;
  changes: number;
  templateEmpty: boolean;
  kpms: number;
}

export type PublicationOutcome =
  | { id: string; outcome: 'published' }
  | { id: string; outcome: 'refused'; error: { code: string; message: string } };

export interface PublishToKpmsView {
  results: PublicationOutcome[];
  /** What the push did, per KPM and kind (ADR-0208 §4): empty where no copied setting was chosen. */
  offices: ApplyOfficeResult[];
}

/** One KPM of the company, as this service needs it. */
export interface CompanyKpm {
  id: string;
  code: string;
  name: string;
  createdAt: Date | null;
  seededFrom: Record<string, { version: number | null; templateId?: string | null } | undefined>;
}

/**
 * ***Terbitkan ke KPM*** (P19.23-T4 AC-5; ADR-0278 §5–§7): **nothing is published automatically and nothing is
 * pre-selected.** Step 1 the changes, step 2 the KPMs, then once confirmed:
 *
 * 1. each setting chosen that waits as a draft is published (`TemplateService.publish`, every check it makes);
 * 2. the copied settings chosen are pushed to the KPMs chosen (`TemplatePushService.apply`) — overwriting a KPM's own
 *    version, which needs `overwriteConfirmed` wherever the server finds one, worked out again here;
 * 3. a product's draft is published (`ProductDraftService.publishDraft`), reaching every KPM that has it (OD-423), and a
 *    new product is **added** to the KPMs chosen (`release`), their settings untouched.
 *
 * The company's default template is the template (ADR-0278 §1). Its KPMs are the ones it answers for. Every write is the
 * Super Admin's, audited by each service it goes through and once here. Cross-company: a KPM of another company named in
 * step 2 is `404`, and nothing is written.
 */
@Injectable()
export class CompanyPublicationService {
  constructor(
    @InjectModel(CompanyTemplate.name) private readonly templateRows: Model<CompanyTemplateDocument>,
    @InjectModel(Company.name) private readonly companies: Model<CompanyDocument>,
    @InjectModel(Kpm.name) private readonly kpmRows: Model<KpmDocument>,
    private readonly named: NamedTemplateService,
    private readonly templates: TemplateService,
    private readonly push: TemplatePushService,
    private readonly officesOf: OfficeCounter,
    private readonly products: ProductDraftService,
    private readonly audit: AuditService,
  ) {}

  // ------------------------------------------------------------------------------- the reads

  /** **Step 1 and step 2** (`GET …/publication`): every change waiting, and every KPM with what it changed itself. */
  async read(ctx: RequestContext, companyId: string): Promise<PublicationView> {
    this.requireRead(ctx);
    const { library, template, kpms } = await this.companyOf(companyId);
    const { changes, holders, versions } = await this.changesOf(companyId, template, kpms);
    const own = template && !library
      ? await this.push.ownEdits(ctx, companyId, String(template._id), copiedKinds(changes))
      : new Map<string, OfficeTemplateKind[]>();
    const templateId = template ? String(template._id) : null;
    return {
      companyId,
      templateId,
      library,
      changes,
      kpms: kpms.map((kpm) => kpmView(kpm, changes, own.get(kpm.id) ?? [], { templateId, versions, holders })),
    };
  }

  /** **The card's count** (`?summary=true`, AC-1): no KPM's settings read, so the companies page asks it per card. */
  async summary(ctx: RequestContext, companyId: string): Promise<PublicationSummary> {
    this.requireRead(ctx);
    const { library, template, kpms } = await this.companyOf(companyId);
    const { changes } = await this.changesOf(companyId, template, kpms);
    const filled = template ? await this.named.withPublishedDefault([companyId]) : new Set<string>();
    return {
      companyId,
      // The Default template has no KPM: what it waits on is its own sections' drafts.
      changes: library ? changes.filter((c) => c.draft).length : changes.length,
      templateEmpty: !filled.has(companyId),
      kpms: kpms.length,
    };
  }

  // ------------------------------------------------------------------------------- the write

  /** **Terbitkan** (`POST …/publication`): see the class. Refused whole, before any write, for anything it can check first. */
  async publish(
    ctx: RequestContext,
    companyId: string,
    body: { changes: readonly string[]; kpmIds: readonly string[]; overwriteConfirmed?: boolean },
  ): Promise<PublishToKpmsView> {
    if (!can(ctx, 'company_template:write')) throw new PermissionDeniedException('company_template:write');
    if (!can(ctx, 'product_catalog:crud')) throw new PermissionDeniedException('product_catalog:crud');
    const view = await this.read(ctx, companyId);
    if (view.library) throw new InvalidRequestException(SAY.defaultTemplateHasNoKpm);

    const ids = [...new Set(body.changes ?? [])];
    if (ids.length === 0) throw new InvalidRequestException(SAY.nothingChosen);
    const byId = new Map(view.changes.map((c) => [c.id, c]));
    const unknown = ids.filter((id) => !byId.has(id));
    if (unknown.length) throw new InvalidRequestException(SAY.unknownChange({ ids: unknown }), { changes: unknown });
    const chosen = ids.map((id) => byId.get(id)!);

    const kpmIds = [...new Set(body.kpmIds ?? [])];
    const kpms = new Map(view.kpms.map((k) => [k.id, k]));
    // Another company's KPM is a stranger here: 404, and nothing written (ADR-0002).
    for (const id of kpmIds) if (!kpms.has(id)) throw new NotFoundException('Kpm');
    if (chosen.some((c) => c.reach === 'chosen') && kpmIds.length === 0) {
      throw new InvalidRequestException(SAY.noKpmChosen);
    }

    // *Saya paham pengaturan KPM ini akan ditimpa* (AC-5), worked out from the KPMs' rows now, not from the page's read.
    const overwritten = kpmIds.filter((id) => chosen.some((c) => c.overwrites && kpms.get(id)!.ownEdits.includes(c.id)));
    if (overwritten.length && body.overwriteConfirmed !== true) {
      const names = overwritten.map((id) => kpms.get(id)!.name);
      throw new DomainException(
        ErrorCode.TEMPLATE_APPLY_UNCONFIRMED,
        COMPANY_PUBLICATION_REFUSALS.TEMPLATE_APPLY_UNCONFIRMED.overwriteUnconfirmed({ names }),
        HttpStatus.CONFLICT,
        { kpmIds: overwritten, changes: chosen.filter((c) => c.overwrites).map((c) => c.id) },
      );
    }

    const results: PublicationOutcome[] = [];
    const refused = new Set<string>();
    const templateId = view.templateId;

    // 1. The settings' drafts, in *Terbitkan semua*'s order; the company's carrier rules last.
    const settings = chosen.filter((c) => c.type === 'setting');
    for (const kind of [...PUBLISH_ORDER, 'campaign_kinds'] as TemplateKind[]) {
      const change = settings.find((c) => c.kinds.includes(kind));
      if (!change || !change.draft || refused.has(change.id)) continue;
      if (!(await this.hasDraft(companyId, kind === 'campaign_kinds' ? null : templateId, kind))) continue;
      try {
        await this.templates.publish(ctx, companyId, kind, kind === 'campaign_kinds' ? null : templateId);
      } catch (err) {
        if (!(err instanceof DomainException)) throw err;
        refused.add(change.id);
        results.push({ id: change.id, outcome: 'refused', error: { code: err.code, message: err.messageFor(ctx.reader) } });
      }
    }

    // 2. The copied settings, to the KPMs chosen — their own versions replaced only as confirmed above.
    const pushKinds = settings
      .filter((c) => c.reach === 'chosen' && !refused.has(c.id))
      .flatMap((c) => c.kinds)
      .filter(isOfficeTemplateKind);
    let offices: ApplyOfficeResult[] = [];
    if (templateId && pushKinds.length && kpmIds.length) {
      const published = (await this.named.publishedKindsOf(companyId, templateId)).versions;
      const kinds = pushKinds.filter((k) => published[k] !== undefined);
      if (kinds.length) {
        offices = (await this.push.apply(ctx, companyId, templateId, {
          kinds, kpmIds, replaceChanged: body.overwriteConfirmed === true ? kpmIds : [],
        })).offices;
      }
    }
    for (const change of settings) if (!refused.has(change.id)) results.push({ id: change.id, outcome: 'published' });

    // 3. The products: a draft published for every KPM that has it, a new product added to the KPMs chosen.
    for (const change of chosen.filter((c) => c.type !== 'setting')) {
      try {
        await this.products.publishDraft(ctx, companyId, change.productId!);
        if (change.type === 'product_new') await this.products.release(ctx, companyId, change.productId!, kpmIds);
        results.push({ id: change.id, outcome: 'published' });
      } catch (err) {
        if (!(err instanceof DomainException)) throw err;
        results.push({ id: change.id, outcome: 'refused', error: { code: err.code, message: err.messageFor(ctx.reader) } });
      }
    }

    await this.audit.record(ctx, {
      action: 'company_template.published_to_kpms',
      targetCollection: 'companies',
      targetId: companyId,
      after: {
        companyId,
        templateId,
        changes: results.map((r) => ({ id: r.id, outcome: r.outcome })),
        kpmIds,
        overwritten,
      },
    });
    return { results, offices };
  }

  // -------------------------------------------------------------------------- internals

  private requireRead(ctx: RequestContext): void {
    if (!can(ctx, 'company_template:read')) throw new PermissionDeniedException('company_template:read');
  }

  /** The company (`404` where none), whether it is the Default template, its default template, and its KPMs. */
  private async companyOf(companyId: string): Promise<{
    library: boolean; template: NamedTemplateDocument | null; kpms: CompanyKpm[];
  }> {
    await this.named.checkCompany(companyId);
    const company = await this.companies.findOne({ _id: companyId, deletedAt: null }, { kind: 1 }).lean().exec();
    const library = (company as { kind?: string } | null)?.kind === 'template';
    const template = await this.named.resolve(companyId).catch((err: unknown) => {
      if (err instanceof NotFoundException) return null;
      throw err;
    });
    if (!template || library) return { library, template, kpms: [] };
    const seeds = await this.officesOf.officesOf(companyId, this.named.scopeOf(template));
    const created = new Map(
      (await this.kpmRows.find({ _id: { $in: seeds.map((s) => s.id) } }, { createdAt: 1 }).lean().exec())
        .map((row) => [String((row as { _id: unknown })._id), (row as { createdAt?: Date }).createdAt ?? null]),
    );
    return {
      library,
      template,
      kpms: seeds.map((s) => ({
        id: s.id, code: s.code, name: s.branchName, createdAt: created.get(s.id) ?? null,
        seededFrom: s.seededFrom as CompanyKpm['seededFrom'],
      })),
    };
  }

  /** Every change waiting: the settings by row, then the products in shelf order. */
  private async changesOf(
    companyId: string, template: NamedTemplateDocument | null, kpms: readonly CompanyKpm[],
  ): Promise<{ changes: PublicationChange[]; holders: Map<string, Set<string>>; versions: Versions }> {
    const out: PublicationChange[] = [];
    const holders = new Map<string, Set<string>>();
    const templateId = template ? String(template._id) : null;
    const published = templateId ? await this.named.publishedKindsOf(companyId, templateId) : { kinds: {}, versions: {} };
    const versions = published.versions as Versions;

    for (const row of PUBLICATION_SETTINGS) {
      const kinds = [...row.kinds] as TemplateKind[];
      let draft = false;
      let added = 0;
      let changed = 0;
      let removed = 0;
      for (const kind of kinds) {
        const at = kind === 'campaign_kinds' ? null : templateId;
        if (kind !== 'campaign_kinds' && !templateId) continue;
        const waiting = await this.templateRows
          .findOne({ companyId, templateId: at, kind, status: 'draft', deletedAt: null }).exec();
        if (!waiting) continue;
        draft = true;
        if (isOfficeTemplateKind(kind)) {
          const before = (published.kinds as Record<string, Record<string, unknown> | undefined>)[kind] ?? null;
          for (const d of differencesOf(kind, itemsOfPayload(kind, before), itemsOfPayload(kind, waiting.payload as Record<string, unknown>))) {
            if (d.change === 'added') added += 1;
            else if (d.change === 'removed') removed += 1;
            else changed += 1;
          }
        }
      }
      // KPMs behind on any of its copied kinds' newest published version.
      const missing = row.reach === 'chosen'
        ? kpms.filter((k) => kinds.some((kind) => behind(k, kind, versions[kind], templateId))).length
        : 0;
      if (!draft && missing === 0) continue;
      out.push({
        id: `setting:${row.setting}`,
        type: 'setting',
        setting: row.setting,
        kinds,
        productId: null, productCode: null, productName: null,
        draft,
        reach: row.reach,
        overwrites: row.reach === 'chosen',
        added, changed, removed,
        missing,
      });
    }

    for (const product of await this.products.rowsOf(companyId)) {
      const state = stateOf(product);
      const id = String(product._id);
      const held = kpms.filter((k) => isHeldBy(product, { id: k.id, createdAt: k.createdAt }));
      const lacking = kpms.length - held.length;
      holders.set(`product:${id}`, new Set(held.map((k) => k.id)));
      const isNew = state === 'unpublished' || (Array.isArray(product.releasedTo) && lacking > 0);
      if (!isNew && state !== 'draft') continue;
      // A withdrawn product is added to nobody: only its draft, if any, is a change.
      if (isNew && product.lifecycle === 'withdrawn' && state !== 'draft') continue;
      const asNew = isNew && product.lifecycle !== 'withdrawn';
      out.push({
        id: `product:${id}`,
        type: asNew ? 'product_new' : 'product_change',
        setting: null,
        kinds: [],
        productId: id,
        productCode: product.code,
        productName: product.name,
        draft: state !== 'published',
        reach: asNew ? 'chosen' : 'all',
        overwrites: false,
        added: 0, changed: 0, removed: 0,
        missing: asNew ? lacking : 0,
      });
    }
    return { changes: out, holders, versions };
  }

  private async hasDraft(companyId: string, templateId: string | null, kind: TemplateKind): Promise<boolean> {
    return (await this.templateRows.exists({ companyId, templateId, kind, status: 'draft', deletedAt: null }).exec()) !== null;
  }
}

/** Each kind's newest published version of the company's template. */
type Versions = Partial<Record<string, number>>;

/** The copied kinds among the changes: what `ownEdits` is asked about. */
function copiedKinds(changes: readonly PublicationChange[]): OfficeTemplateKind[] {
  return changes.filter((c) => c.reach === 'chosen').flatMap((c) => c.kinds).filter(isOfficeTemplateKind);
}

/**
 * Whether a KPM lacks the newest published version of one copied kind: no record (made before records were kept), a
 * record of nothing, an older version, or a version of another template. Nothing published of the kind: nothing to lack.
 */
export function behind(
  kpm: Pick<CompanyKpm, 'seededFrom'>, kind: TemplateKind, newest: number | undefined, templateId: string | null,
): boolean {
  if (!isOfficeTemplateKind(kind) || newest === undefined) return false;
  const record = kpm.seededFrom[kind];
  if (!record || record.version === null || record.version === undefined) return true;
  if (record.templateId && templateId && record.templateId !== templateId) return true;
  return record.version < newest;
}

/**
 * **What one KPM has of each change, and what of its own a change would overwrite** (ADR-0278 §6). A change it already
 * has — a setting with no draft whose newest version it holds, a new product it was given — is `upToDate`. A setting it
 * changed itself is `ownEdits` only where something would reach it: a draft published, or a version it lacks — so the
 * tick is asked for exactly the KPMs whose words would go.
 */
export function kpmView(
  kpm: CompanyKpm,
  changes: readonly PublicationChange[],
  own: readonly OfficeTemplateKind[],
  at: { templateId: string | null; versions: Versions; holders: Map<string, Set<string>> },
): PublicationKpm {
  const upToDate: string[] = [];
  const ownEdits: string[] = [];
  for (const change of changes) {
    if (change.reach === 'all') continue;
    if (change.type === 'product_new') {
      if (at.holders.get(change.id)?.has(kpm.id)) upToDate.push(change.id);
      continue;
    }
    const lacks = change.kinds.some((kind) => behind(kpm, kind, at.versions[kind], at.templateId));
    const current = !change.draft && !lacks;
    if (current) upToDate.push(change.id);
    else if (change.kinds.some((k) => (own as readonly string[]).includes(k))) ownEdits.push(change.id);
  }
  return { id: kpm.id, code: kpm.code, name: kpm.name, ownEdits, upToDate };
}
