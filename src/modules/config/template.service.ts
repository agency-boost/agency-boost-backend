import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { Clock } from '@/common/clock/clock.port';
import { RequestContext } from '@/common/context/request-context';
import { AuditService } from '@/modules/audit/audit.service';
import { Company, CompanyDocument } from '@/modules/tenants/company.schema';
import {
  SEED_ACTIVITY_CATEGORIES, SEED_ACTIVITY_TYPES, SEED_LEAD_STATUSES, SEED_RATIO_DEFINITIONS,
  resolveDisplayUnit,
} from '@/domain/constants';
import {
  CompanyTemplate, CompanyTemplateDocument, TemplateKind,
} from './company-template.schema';
import { OfficeCounter } from './office-counter.port';

export interface TemplateView {
  id: string;
  companyId: string;
  kind: TemplateKind;
  version: number;
  status: 'draft' | 'published' | 'archived';
  payload: Record<string, unknown>;
  publishedAt: string | null;
  /** The version offices are currently seeded from, or `null` if nothing is published. */
  publishedVersion: number | null;
  /** How many offices of this company were seeded from something older than that. */
  officesBehind: number;
}

/** What an empty template of each kind starts from, so a Super Admin edits rather than types. */
const STARTING_PAYLOAD: Record<string, () => Record<string, unknown>> = {
  activity_taxonomy: () => ({
    categories: SEED_ACTIVITY_CATEGORIES.map((c) => ({ ...c })),
    types: SEED_ACTIVITY_TYPES.map((t) => ({ ...t })),
  }),
  lead_pipeline: () => ({ statuses: SEED_LEAD_STATUSES.map((s) => ({ ...s })) }),
  ratio_set: () => ({
    ratios: SEED_RATIO_DEFINITIONS.map((r) => ({
      ...r, numerator: [...r.numerator], denominator: [...r.denominator],
    })),
  }),
};

/**
 * The preset every new office of one company is built from (P4-T8, ADR-0018).
 *
 * **A draft and a published history, not one editable row.** A published version is
 * immutable because an office records the version it was seeded from
 * (`kpms.seededFromVersion`), and a version whose content could change afterwards would
 * make that record a lie. So editing after publishing starts a new draft, and publishing
 * turns that draft into the next version.
 *
 * **Publishing reaches nothing that already exists.** Copy-on-provision means copy *once*:
 * an office that has diverged keeps its divergence, which is the whole point of Phase 4.
 * What publishing changes is what the *next* office starts from — and `officesBehind`
 * says how many are not on it, which is the number the Superadmin prototype puts on its
 * front page (*"6 of 8 existing KPMs haven't reviewed the new default activation
 * checklist"*).
 *
 * **A different collection from an office's own configuration, deliberately.** The tenant
 * screens write `activityTypes` and its peers; this writes a payload that is *copied* into
 * them. The same shape, edited by two people who mean different things by it.
 */
@Injectable()
export class TemplateService {
  constructor(
    @InjectModel(CompanyTemplate.name)
    private readonly templates: Model<CompanyTemplateDocument>,
    @InjectModel(Company.name) private readonly companies: Model<CompanyDocument>,
    private readonly audit: AuditService,
    private readonly clock: Clock,
    private readonly officesOf: OfficeCounter,
  ) {}

  /**
   * What a Super Admin is looking at: the draft if there is one, else the newest
   * published, else a starting point built from the platform defaults.
   *
   * The last case matters more than it looks. A company with nothing published is the
   * normal state of a new insurer, and handing back an empty object would mean the first
   * thing a Super Admin does is retype twelve activity types from a PDF.
   */
  async read(companyId: string, kind: TemplateKind): Promise<TemplateView> {
    await this.requireCompany(companyId);

    const draft = await this.templates
      .findOne({ companyId, kind, status: 'draft', deletedAt: null }).exec();
    const published = await this.newestPublished(companyId, kind);

    const behind = await this.officesBehind(companyId, published?.version ?? null);

    if (draft) return this.view(draft, published?.version ?? null, behind);
    if (published) return this.view(published, published.version, behind);

    return {
      id: '',
      companyId,
      kind,
      version: 0,
      status: 'draft',
      payload: STARTING_PAYLOAD[kind]?.() ?? {},
      publishedAt: null,
      publishedVersion: null,
      officesBehind: behind,
    };
  }

  /** Save the working copy. Creates the draft if this is the first edit since publishing. */
  async saveDraft(
    ctx: RequestContext,
    companyId: string,
    kind: TemplateKind,
    payload: Record<string, unknown>,
  ): Promise<TemplateView> {
    await this.requireCompany(companyId);

    const existing = await this.templates
      .findOne({ companyId, kind, status: 'draft', deletedAt: null }).exec();

    const saved = existing
      ? await this.templates.findOneAndUpdate(
        { _id: existing._id },
        { $set: { payload, updatedBy: ctx.userId } },
        { new: true },
      ).exec()
      : await this.templates.create({
        companyId,
        kind,
        // A draft carries the version it *will* be, so the screen can say so.
        version: ((await this.newestPublished(companyId, kind))?.version ?? 0) + 1,
        status: 'draft',
        payload,
        publishedAt: null,
        deletedAt: null,
        createdBy: ctx.userId,
        updatedBy: ctx.userId,
      });

    await this.audit.record(ctx, {
      action: 'company_template.draft_saved',
      targetCollection: 'companyTemplates',
      targetId: String(saved!._id),
      after: { companyId, kind },
    });

    const published = await this.newestPublished(companyId, kind);
    return this.view(
      saved!,
      published?.version ?? null,
      await this.officesBehind(companyId, published?.version ?? null),
    );
  }

  /**
   * Publish the draft, making it the version new offices are seeded from.
   *
   * The draft row **becomes** the published row rather than being copied into one: the id
   * a Super Admin has been editing is the id offices will record, and two rows where one
   * will do is a second place for them to disagree.
   */
  async publish(
    ctx: RequestContext, companyId: string, kind: TemplateKind,
  ): Promise<TemplateView> {
    await this.requireCompany(companyId);

    const draft = await this.templates
      .findOne({ companyId, kind, status: 'draft', deletedAt: null }).exec();
    if (!draft) {
      throw new BadRequestException(
        'There is nothing to publish. Change something first — the published version is '
          + 'immutable, because offices record which one they were built from.',
      );
    }
    await this.refuseBroken(companyId, kind, draft.payload);

    const published = await this.newestPublished(companyId, kind);
    draft.version = (published?.version ?? 0) + 1;
    draft.status = 'published';
    draft.publishedAt = this.clock.now();
    draft.updatedBy = ctx.userId;
    await draft.save();

    await this.audit.record(ctx, {
      action: 'company_template.published',
      targetCollection: 'companyTemplates',
      targetId: String(draft._id),
      after: { companyId, kind, version: draft.version },
    });

    return this.view(draft, draft.version, await this.officesBehind(companyId, draft.version));
  }

  /** Every version of every kind for one company, newest first. The history panel. */
  async history(companyId: string, kind: TemplateKind): Promise<TemplateView[]> {
    await this.requireCompany(companyId);
    const rows = await this.templates
      .find({ companyId, kind, deletedAt: null })
      .sort({ version: -1 })
      .exec();
    const published = rows.find((r) => r.status === 'published');
    return rows.map((r) => this.view(r, published?.version ?? null, 0));
  }

  // -------------------------------------------------------------- internals

  private async newestPublished(companyId: string, kind: TemplateKind) {
    return this.templates
      .findOne({ companyId, kind, status: 'published', deletedAt: null })
      .sort({ version: -1 })
      .exec();
  }

  private async requireCompany(companyId: string): Promise<void> {
    const company = await this.companies
      .findOne({ _id: companyId, deletedAt: null }).exec()
      // A malformed id arrives from a URL; an uncaught CastError is a 500 and a log line
      // about an unhandled error, which is the wrong story about a typo.
      .catch(() => null);
    if (!company) throw new NotFoundException('Company');
  }

  private async officesBehind(companyId: string, publishedVersion: number | null) {
    if (publishedVersion === null) return 0;
    return this.officesOf.countBehind(companyId, publishedVersion);
  }

  /**
   * Refuse to publish a template that would produce a broken office.
   *
   * The alternative is discovering it at provisioning, which is the worst possible moment:
   * a Super Admin creating an office for a real branch, and a failure naming a template
   * they published three weeks ago.
   */
  /**
   * Refuse a payload that would produce a broken office.
   *
   * The promise `super-admin/08` makes is that this happens **here**, not at office
   * creation — the alternative is a Super Admin discovering it midway through setting up a
   * real branch, naming a template they published three weeks ago.
   *
   * `ratio_set` had no branch at all until P4-T20, so a ratio naming a code the taxonomy
   * did not declare published cleanly and then threw at provisioning: exactly the failure
   * the promise rules out.
   */
  private async refuseBroken(
    companyId: string, kind: TemplateKind, payload: Record<string, unknown>,
  ): Promise<void> {
    this.refuseEmpty(kind, payload);

    if (kind !== 'ratio_set') return;

    const { ratios } = payload as {
      ratios?: {
        code: string; numerator: string[]; denominator: string[];
        comparison?: string; displayUnit?: string;
      }[];
    };
    if (!ratios?.length) {
      throw new BadRequestException('A ratio set with no ratios gives every new office nothing to measure.');
    }

    /*
     * Against the **published** taxonomy, and its platform fallback — because that is what
     * provisioning reads (`provisioning.service.ts`). Checking the taxonomy *draft* would
     * pass here and still break the office, which is the defect wearing a different hat.
     */
    const taxonomy = await this.newestPublished(companyId, 'activity_taxonomy');
    const source = (taxonomy?.payload ?? STARTING_PAYLOAD.activity_taxonomy?.() ?? {}) as {
      types?: { code: string }[];
    };
    const known = new Set((source.types ?? []).map((t) => t.code));

    const missing = [...new Set(
      ratios.flatMap((r) => [...(r.numerator ?? []), ...(r.denominator ?? [])]),
    )].filter((code) => !known.has(code));

    if (missing.length) {
      throw new BadRequestException(
        `${missing.join(', ')} is named by a ratio and declared by no activity type in this `
          + `company\u2019s published taxonomy${taxonomy ? ` (version ${taxonomy.version})` : ''}. `
          + 'Publish the taxonomy first, or point the ratio at a code it has.',
      );
    }

    for (const ratio of ratios) {
      /*
       * A unit its rule cannot have (P4-T25) — refused here for the same reason as a
       * missing code: provisioning would otherwise throw it at a Super Admin creating a real
       * branch. An omitted unit is fine; provisioning resolves one.
       */
      if (ratio.displayUnit !== undefined) {
        const resolved = resolveDisplayUnit(
          ratio.comparison === 'band' ? 'band' : 'gte', ratio.displayUnit,
        );
        if (resolved.refusal !== undefined) {
          throw new BadRequestException(`${ratio.code}: ${resolved.refusal}`);
        }
      }
      if (!ratio.denominator?.length) {
        throw new BadRequestException(
          `${ratio.code} has nothing in its denominator. That is a division by zero dressed `
            + 'up as configuration, and it renders as ∞ on every agent\u2019s screen.',
        );
      }
    }
  }

  private refuseEmpty(kind: TemplateKind, payload: Record<string, unknown>): void {
    if (kind === 'activity_taxonomy') {
      const { categories, types } = payload as { categories?: unknown[]; types?: unknown[] };
      if (!categories?.length || !types?.length) {
        throw new BadRequestException(
          'A taxonomy with no categories or no types would give every new office an empty '
            + 'Log Activity screen.',
        );
      }
    }
    if (kind === 'lead_pipeline') {
      const { statuses } = payload as { statuses?: { pipeline: string; isTerminal: boolean }[] };
      for (const pipeline of ['sales', 'recruitment']) {
        const mine = (statuses ?? []).filter((s) => s.pipeline === pipeline);
        if (mine.length === 0) {
          throw new BadRequestException(`The ${pipeline} pipeline has no stages.`);
        }
        if (mine.filter((s) => s.isTerminal).length !== 1) {
          throw new BadRequestException(
            `The ${pipeline} pipeline needs exactly one stage that closes it. It is what `
              + 'gates marking a lead successful.',
          );
        }
      }
    }
  }

  private view(
    doc: CompanyTemplateDocument,
    publishedVersion: number | null,
    officesBehind: number,
  ): TemplateView {
    return {
      id: String(doc._id),
      companyId: doc.companyId,
      kind: doc.kind,
      version: doc.version,
      status: doc.status,
      payload: doc.payload,
      publishedAt: doc.publishedAt ? doc.publishedAt.toISOString() : null,
      publishedVersion,
      officesBehind,
    };
  }
}
