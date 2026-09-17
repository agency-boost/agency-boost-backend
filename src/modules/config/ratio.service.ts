import { BadRequestException, HttpStatus, Injectable, NotFoundException } from '@nestjs/common';
import { DomainException } from '@/common/errors/domain.exception';
import { ErrorCode } from '@/common/errors/error-codes';
import { Clock } from '@/common/clock/clock.port';
import { RequestContext } from '@/common/context/request-context';
import { AuditService } from '@/modules/audit/audit.service';
import { ActivityConfigService } from './activity.service';
import { RatioDefinitionRepository } from './activity.repository';
import { OrgLevelService } from '@/modules/tenants/org-level.service';
import {
  defaultDisplayUnitFor, resolveDisplayUnit, type RatioDisplayUnit,
} from '@/domain/constants';
import { RatioComparison, RatioDefinitionDocument, RatioOrigin } from './ratio-definition.schema';

export interface RatioDefinitionView {
  id: string;
  code: string;
  label: string;
  numerator: string[];
  denominator: string[];
  benchmark: number;
  comparison: RatioComparison;
  /** How the benchmark is written (P4-T25). Always `points` on a `band` ratio. */
  displayUnit: RatioDisplayUnit;
  displayOrder: number;
  version: number;
  status: 'active' | 'archived';
  /**
   * Where the row came from (ADR-0021, revised by ADR-0024). `platform` rows were
   * provisioned; their formula is the office's to change, like everything else on them.
   */
  origin: RatioOrigin;
  /** The formula this office was provisioned with, or `null` on a ratio it created. */
  standardNumerator: string[] | null;
  standardDenominator: string[] | null;
  /**
   * The formula no longer matches what the office was seeded from (ADR-0024).
   *
   * Derived, never stored. A display and support caveat — nothing is excluded from anything
   * on account of it, because a platform comparison computes the seeded formula itself
   * rather than reading this row.
   */
  divergesFromStandard: boolean;
  /** Ladder rung codes. Empty means every rung (ADR-0020). */
  appliesToOrgLevelCodes: string[];
}

const CODE_SHAPE = /^[A-Z][A-Z0-9_]{2,39}$/;

/** Two formula sides are the same set of codes. Order is display, never meaning. */
const sameCodes = (a: readonly string[], b: readonly string[]) =>
  a.length === b.length && [...a].sort().join() === [...b].sort().join();

/**
 * The row's formula against the one its office was provisioned with (ADR-0024).
 *
 * `false` for a ratio the office created: there is no standard it could have moved away
 * from, which is not the same as agreeing with one.
 */
function diverges(doc: RatioDefinitionDocument): boolean {
  if (!doc.standardNumerator || !doc.standardDenominator) return false;
  return !sameCodes(doc.numerator, doc.standardNumerator)
    || !sameCodes(doc.denominator, doc.standardDenominator);
}

/**
 * The office's ratio definitions (P4-T2).
 *
 * **A formula referencing a code the office does not have is refused at write time,
 * naming the code.** This is the whole reason the activity taxonomy and the ratios live
 * in one module: a ratio that quietly divides by a code nobody logs any more reads as
 * `0.0%` on every agent's screen, and looks like an agent problem rather than a
 * configuration one.
 *
 * Archiving a type does **not** break the ratios that name it — an archived type still has
 * history, and the ratio still has to compute over the window it covers. What is refused
 * is *binding a new formula* to something archived or absent.
 */
@Injectable()
export class RatioService {
  constructor(
    private readonly ratios: RatioDefinitionRepository,
    private readonly activity: ActivityConfigService,
    private readonly orgLevels: OrgLevelService,
    private readonly audit: AuditService,
    private readonly clock: Clock,
  ) {}

  async list(ctx: RequestContext, includeArchived = false): Promise<RatioDefinitionView[]> {
    const filter = includeArchived ? {} : { status: 'active' };
    const rows = await this.ratios.find(ctx, filter, { sort: { displayOrder: 1 } });
    return rows.map((r) => this.view(r));
  }

  async create(
    ctx: RequestContext,
    input: {
      code: string; label: string; numerator: string[]; denominator: string[];
      benchmark: number; comparison: RatioComparison; displayUnit?: string;
      appliesToOrgLevelCodes?: string[];
    },
  ): Promise<RatioDefinitionView> {
    const code = this.normaliseCode(input.code);
    const displayUnit = this.resolvedUnit(code, input.comparison, input.displayUnit);
    if (await this.ratios.exists(ctx, { code })) {
      throw new BadRequestException(`This office already has a ratio called ${code}.`);
    }
    const numerator = await this.checkedCodes(ctx, input.numerator, 'numerator');
    const denominator = await this.checkedCodes(ctx, input.denominator, 'denominator');

    const created = await this.ratios.create(ctx, {
      code,
      label: input.label.trim(),
      numerator,
      denominator,
      benchmark: input.benchmark,
      comparison: input.comparison,
      displayUnit,
      // An office's own, by construction. Nothing a tenant creates is platform-standard —
      // `platform` is written by provisioning and by nothing else (ADR-0021).
      origin: 'office',
      appliesToOrgLevelCodes: await this.checkedRungs(ctx, input.appliesToOrgLevelCodes ?? []),
      displayOrder: (await this.ratios.count(ctx, {})) + 1,
      version: 1,
      status: 'active',
    } as Partial<RatioDefinitionDocument>);

    await this.record(ctx, 'ratio.created', String(created._id), { code });
    return this.view(created);
  }

  /**
   * Label, benchmark, comparison, applicability and — on an office's own ratio — the two
   * code lists. Never the code.
   *
   * **A platform ratio refuses a formula change, and the whole request with it**
   * (ADR-0021). Applying the acceptable half and reporting an error on the rest would
   * leave an Owner unable to answer "did my benchmark save?" from the response they got —
   * a half-applied write is worse than a refused one. The refusal names the ratio and the
   * way out, which is what makes it actionable rather than merely correct.
   *
   * This docstring claimed the opposite until P4-T18, and the ADR and the error catalog
   * followed it. The code and its test have always refused the whole request.
   */
  async update(
    ctx: RequestContext,
    id: string,
    input: {
      label?: string; benchmark?: number; comparison?: RatioComparison; displayUnit?: string;
      numerator?: string[]; denominator?: string[]; appliesToOrgLevelCodes?: string[];
    },
  ): Promise<RatioDefinitionView> {
    const existing = await this.ratios.findById(ctx, id);
    if (!existing) throw new NotFoundException('Ratio');

    /*
     * A platform ratio's formula is the office's to change (ADR-0024). It was refused until
     * then, to keep two offices' figures comparable — but the comparison that argument
     * protected reads the *seeded* formula, which `standardNumerator` records, not this row.
     * What the office writes here is what the office's own people are measured by.
     */
    const set: Record<string, unknown> = {};
    if (input.label !== undefined) set.label = input.label.trim();
    if (input.benchmark !== undefined) set.benchmark = input.benchmark;
    if (input.comparison !== undefined) set.comparison = input.comparison;
    /*
     * The unit is re-resolved whenever the rule or the unit is touched, and on a platform
     * ratio too — how a number is written is presentation, not formula, so ADR-0021 has
     * nothing to say about it. Changing only the rule is the case that matters: a ratio
     * turned into a band becomes `points` without being asked, because nothing else fits.
     */
    if (input.comparison !== undefined || input.displayUnit !== undefined) {
      set.displayUnit = this.resolvedUnit(
        existing.code,
        input.comparison ?? existing.comparison,
        input.displayUnit,
        existing.displayUnit,
      );
    }
    if (input.appliesToOrgLevelCodes !== undefined) {
      set.appliesToOrgLevelCodes = await this.checkedRungs(ctx, input.appliesToOrgLevelCodes);
    }
    if (input.numerator !== undefined) {
      set.numerator = await this.checkedCodes(ctx, input.numerator, 'numerator');
    }
    if (input.denominator !== undefined) {
      set.denominator = await this.checkedCodes(ctx, input.denominator, 'denominator');
    }
    if (Object.keys(set).length === 0) throw new BadRequestException('Nothing to change.');

    const updated = await this.ratios.updateById(ctx, id, { $set: set, $inc: { version: 1 } });
    if (!updated) throw new NotFoundException('Ratio');
    await this.record(ctx, 'ratio.updated', id, set);
    return this.view(updated);
  }

  /**
   * Every rung must be on the company's own ladder (ADR-0020, ADR-0012).
   *
   * Against `OrgLevelService`, never against a list here: the ladder belongs to the
   * company and a second copy of it in this module would be a second answer to what rungs
   * an office has. Archived rungs are refused — binding a ratio to a rung the company has
   * retired makes it apply to nobody, silently.
   *
   * An empty list is the common case and means every rung, so it short-circuits without
   * reading the ladder at all.
   */
  private checkedRungs(ctx: RequestContext, codes: string[]): Promise<string[]> {
    // One implementation, on `OrgLevelService` beside `ladderForOffice` — activity
    // categories scope the same way since P4-T18, and two copies of this would drift in
    // the message long before they drifted in the rule.
    return this.orgLevels.checkedRungs(ctx, codes, 'ratio');
  }

  async archive(ctx: RequestContext, id: string): Promise<RatioDefinitionView> {
    const updated = await this.ratios.updateById(ctx, id, {
      $set: { status: 'archived', archivedAt: this.clock.now() },
      $inc: { version: 1 },
    });
    if (!updated) throw new NotFoundException('Ratio');
    await this.record(ctx, 'ratio.archived', id, { code: updated.code });
    return this.view(updated);
  }

  async restore(ctx: RequestContext, id: string): Promise<RatioDefinitionView> {
    const updated = await this.ratios.updateById(ctx, id, {
      $set: { status: 'active', archivedAt: null },
      $inc: { version: 1 },
    });
    if (!updated) throw new NotFoundException('Ratio');
    await this.record(ctx, 'ratio.restored', id, { code: updated.code });
    return this.view(updated);
  }

  /**
   * Every code in the list must be an **active** activity type of this office.
   *
   * Named in the message, because "invalid formula" sends an Owner to compare two lists by
   * eye. A denominator that is empty is refused too: it is a division by zero dressed up
   * as configuration, and it would render as `∞` or `NaN` on every agent's screen.
   */
  private async checkedCodes(
    ctx: RequestContext, codes: string[], side: string,
  ): Promise<string[]> {
    const normalised = codes.map((c) => c.trim().toUpperCase());
    if (normalised.length === 0) {
      throw new BadRequestException(`A ratio needs at least one activity type in its ${side}.`);
    }
    const duplicates = normalised.filter((c, i) => normalised.indexOf(c) !== i);
    if (duplicates.length) {
      // Counting one type twice is almost always a mis-click, and it silently doubles
      // that type's weight in the result.
      throw new BadRequestException(
        `${duplicates[0]} appears twice in the ${side}. Each activity type counts once.`,
      );
    }

    const active = new Set(await this.activity.activeTypeCodes(ctx));
    const unknown = normalised.filter((c) => !active.has(c));
    if (unknown.length) {
      throw new BadRequestException(
        `The ${side} names ${unknown.join(', ')}, which this office has no active activity `
          + 'type for. Check the code, or add the type first.',
      );
    }
    return normalised;
  }

  /**
   * The unit a write ends up with, or a refusal naming the ratio (P4-T25).
   *
   * Refused rather than corrected when the caller *asked* for a unit the rule does not
   * allow: silently turning a requested `percent` into `points` would save something other
   * than what the Owner chose, and they would find out by reading the card.
   */
  private resolvedUnit(
    code: string, comparison: RatioComparison, requested?: string, current?: RatioDisplayUnit,
  ): RatioDisplayUnit {
    const resolved = resolveDisplayUnit(comparison, requested, current);
    if (resolved.refusal !== undefined) {
      throw new DomainException(
        ErrorCode.CONFIG_RATIO_UNIT_MISMATCH,
        `${code}: ${resolved.refusal}`,
        HttpStatus.BAD_REQUEST,
        { code },
      );
    }
    return resolved.unit;
  }

  private normaliseCode(raw: string): string {
    const code = raw.trim().toUpperCase();
    if (!CODE_SHAPE.test(code)) {
      throw new BadRequestException(
        'A code is 3–40 characters of A–Z, 0–9 and underscore, starting with a letter.',
      );
    }
    return code;
  }

  private view(doc: RatioDefinitionDocument): RatioDefinitionView {
    return {
      id: String(doc._id),
      code: doc.code,
      label: doc.label,
      numerator: doc.numerator,
      denominator: doc.denominator,
      benchmark: doc.benchmark,
      comparison: doc.comparison,
      // A row nothing has migrated yet still reads correctly; migration 0008 writes it.
      displayUnit: doc.displayUnit ?? defaultDisplayUnitFor(doc.code, doc.comparison),
      displayOrder: doc.displayOrder,
      version: doc.version,
      status: doc.status,
      origin: doc.origin,
      standardNumerator: doc.standardNumerator ?? null,
      standardDenominator: doc.standardDenominator ?? null,
      divergesFromStandard: diverges(doc),
      appliesToOrgLevelCodes: doc.appliesToOrgLevelCodes,
    };
  }

  private async record(
    ctx: RequestContext, action: string, targetId: string, after: Record<string, unknown>,
  ): Promise<void> {
    await this.audit.record(ctx, { action, targetCollection: 'ratioDefinitions', targetId, after });
  }
}
