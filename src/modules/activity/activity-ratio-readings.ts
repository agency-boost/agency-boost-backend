import { Injectable } from '@nestjs/common';
import { RequestContext } from '@/common/context/request-context';
import { render } from '@/common/i18n/sentence';
import type { LocalDate } from '@/common/time/local-day';
import { SEED_RATIO_PURPOSES } from '@/domain/constants';
import type { RatioDisplayUnit } from '@/domain/constants/ratio-display';
import {
  ActivityCategoryRepository, ActivityTypeRepository, RatioDefinitionRepository,
} from '@/modules/config/activity.repository';
import { diverges } from '@/modules/config/ratio-diverges';
import { ActivityLogRepository } from './activity-log.repository';
import { appliesTo, computeRatio, type RatioStatus } from './activity-ratios';
import { ACTIVITY_MESSAGES } from './activity.messages';

/** One activity code in a ratio's formula, as the office names and numbers it. */
export interface RatioTermView {
  code: string;
  label: string;
  /** The number the log screen shows — display order, never an identity (invariant §4). 0 when unknown. */
  displayOrder: number;
}

/** One of the office's ratios, computed over the member's last 30 days (P10-T2). */
export interface ActivityRatioView {
  code: string;
  label: string;
  comparison: 'gte' | 'band';
  displayUnit: RatioDisplayUnit;
  /** The office's own benchmark — a proportion for a rate, points either side for the balance. */
  benchmark: number;
  /**
   * The section the ratio measures, read from its denominator — *Selling* for a selling success rate —
   * or *Balance* for the two-sided one. `null` when the denominator spans sections.
   */
  tag: { code: string | null; label: string } | null;
  numerator: RatioTermView[];
  denominator: RatioTermView[];
  /**
   * The balance's two ends, named by the section each side counts — *Selling* and *Recruitment* on the
   * seed — so an office that rebuilds it is not told it leans toward selling. `null` for a rate, and a
   * side is `null` when its codes span sections.
   */
  sides: { numerator: string | null; denominator: string | null } | null;
  /** The platform's sentence for what it measures; `null` for an office's own formula, or one it changed. */
  purpose: string | null;
  divergesFromStandard: boolean;
  value: number | null;
  share: number | null;
  numeratorCount: number;
  denominatorCount: number;
  status: RatioStatus;
}

/**
 * **The office's ratios over sets of members' summed counts** (P10-T2's computation; UI V1, Phase 18.99 T4): the one
 * place the ratio views are built. `ActivityService.ratiosOf` — `GET /activity/ratios`, the Ratio page — is its
 * one-member set; the Unit Dashboard's *Activities* tab asks it for the *Unit* and the *Group* (UI-001: *Ratio values
 * match the Ratio page logic for the same people and window*).
 *
 * - **The window is the caller's**: `ROLLING_30D` ending on the office's today, which both callers resolve.
 * - **The definitions are the office's own** (ADR-0024), active, **only those that apply to the rung asked**
 *   (ADR-0020): one that does not apply is absent, never failed.
 * - **The counts are every stored entry by code**, archived types included, each member counted once in a set.
 * - **One read of the logs for every set together**, and no subject resolved or audit entry written: the caller has
 *   decided who it may read, and records its own.
 *
 * Its own small reader, its repositories and nothing else, so the Unit Dashboard reaches none of training or events
 * through it (P15-T1 AC-11).
 */
@Injectable()
export class ActivityRatioReadings {
  constructor(
    private readonly logs: ActivityLogRepository,
    private readonly ratioDefinitions: RatioDefinitionRepository,
    private readonly categories: ActivityCategoryRepository,
    private readonly types: ActivityTypeRepository,
  ) {}

  async ratiosOfSets<K extends string>(
    ctx: RequestContext,
    sets: Readonly<Record<K, readonly string[]>>,
    orgLevelCode: string,
    window: { from: LocalDate; to: LocalDate },
  ): Promise<Record<K, ActivityRatioView[]>> {
    const everybody = [...new Set(Object.values<readonly string[]>(sets).flat())];
    const [rows, definitions, categories, types] = await Promise.all([
      everybody.length === 0
        ? Promise.resolve([])
        : this.logs.find(ctx, {
          membershipId: everybody.length === 1 ? everybody[0] : { $in: everybody },
          localDate: { $gte: window.from, $lte: window.to },
        }),
      this.ratioDefinitions.find(ctx, { status: 'active' }, { sort: { displayOrder: 1 } }),
      this.categories.find(ctx, {}),
      this.types.find(ctx, {}),
    ]);

    /** Each set's counts by code, every member in it once. */
    const sumsOf = (ids: readonly string[]) => {
      const members = new Set(ids);
      const sums = new Map<string, number>();
      for (const row of rows) {
        if (!members.has(row.membershipId)) continue;
        for (const entry of row.entries) {
          sums.set(entry.activityTypeCode, (sums.get(entry.activityTypeCode) ?? 0) + entry.count);
        }
      }
      return sums;
    };
    const typeOf = new Map(types.map((t) => [t.code, t]));
    const sectionOf = new Map(categories.map((c) => [c.code, c]));
    const term = (code: string): RatioTermView => {
      const type = typeOf.get(code);
      return { code, label: type?.label ?? code, displayOrder: type?.displayOrder ?? 0 };
    };
    /** The one section a list of codes belongs to, or undefined when they span more than one. */
    const sectionFor = (codes: readonly string[]) => {
      const sections = [...new Set(codes.map((code) => typeOf.get(code)?.categoryCode))];
      return sections.length === 1 && sections[0] ? sectionOf.get(sections[0]) : undefined;
    };
    const tagFor = (comparison: string, denominator: readonly string[]) => {
      // A balance ratio has no section of its own: its tag is the API's word, in the reader's language (AC-4).
      if (comparison === 'band') return { code: null, label: render(ACTIVITY_MESSAGES.balanceTag, ctx.reader) };
      const section = sectionFor(denominator);
      return section ? { code: section.code, label: section.label } : null;
    };

    const applying = definitions.filter((d) => appliesTo(d.appliesToOrgLevelCodes, orgLevelCode));
    const ratiosFor = (sums: ReadonlyMap<string, number>) => applying.map((d): ActivityRatioView => {
      const diverged = diverges(d);
      return {
        code: d.code,
        label: d.label,
        comparison: d.comparison,
        displayUnit: d.displayUnit,
        benchmark: d.benchmark,
        tag: tagFor(d.comparison, d.denominator),
        sides: d.comparison === 'band'
          ? { numerator: sectionFor(d.numerator)?.label ?? null, denominator: sectionFor(d.denominator)?.label ?? null }
          : null,
        numerator: d.numerator.map(term),
        denominator: d.denominator.map(term),
        purpose: d.origin === 'platform' && !diverged ? SEED_RATIO_PURPOSES[d.code] ?? null : null,
        divergesFromStandard: diverged,
        ...computeRatio(d, sums),
      };
    });

    return Object.fromEntries(
      (Object.entries(sets) as [K, readonly string[]][]).map(([key, ids]) => [key, ratiosFor(sumsOf(ids))]),
    ) as Record<K, ActivityRatioView[]>;
  }
}
