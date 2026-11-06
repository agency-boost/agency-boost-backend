import { Fields } from '@/common/validation/fields';
import { VALIDATION_REFUSALS } from '@/common/validation/validation.messages';
import { GOAL_MODES, type GoalMode } from './goal.schema';
import { GOAL_REFUSALS } from './goals.messages';

/** A goal's field sentences, in both languages (P18.10-T5 AC-3): its own, and the shared *… is required.* */
const SAY = GOAL_REFUSALS.VALIDATION_FAILED;
const REQUIRED = VALIDATION_REFUSALS.VALIDATION_FAILED.required;

/**
 * What a goal's fields may hold (P8-T1).
 *
 * Pure, and separate from the service, so the rules can be exercised without a database — the shape
 * `lead-input.ts` and `campaign-input.ts` take, and the reason ADR-0030 gives for it.
 *
 * **This is the record's shape, not the cascade's arithmetic.** Whether the numbers *make sense
 * together* — and the `GOAL_INVALID_ASSUMPTION` code that says they do not — is P8-T2's, with the
 * formula they feed. What is here is the smaller and older question: is this a number at all, is it
 * money in the unit this product stores money in, is this a period.
 */

/** A calendar year, `YYYY`. Annual in v1 (ADR-0049); the shape widens when a second one does. */
const PERIOD = /^\d{4}$/;

/**
 * **Rp 10 trillion**, as sen — `1e15`, comfortably below `Number.MAX_SAFE_INTEGER` (`≈9.007e15`).
 *
 * Not a business rule — nobody's annual target is this — but a floor under the arithmetic: past
 * `MAX_SAFE_INTEGER` an integer stops being exact in a double, and every monetary figure in this
 * product is a JavaScript number. A target that silently loses its last digits is worse than one
 * that is refused.
 *
 * **The first version of this line said exactly that and then set the ceiling to `1e16`** — above
 * the limit it was written to stay under. The test that names the limit is what caught it, which is
 * the argument for a bound having a test rather than only a comment.
 */
export const GOAL_BOUNDS = {
  money: { min: 0, max: 10_000_000_000_000_00 },

  /** The cascade's divisor. Floored well above zero so it cannot divide by ~0. */
  monthsLeft: { min: 0.1, max: 120 },
} as const;

export interface CheckedGoal {
  period?: string;
  mode?: GoalMode;
  annualApeTargetMinor?: number;
  savingsTargetMinor?: number;
  commissionRatePct?: number;
  /** `null` is a value here: *use the office's calendar*, which is the ordinary case. */
  monthsLeft?: number | null;
  apeAchievedMinor?: number;
  caseSizeMinor?: number;
  leadsToApptPct?: number;
  closingRatePct?: number;
}

/** The four fields that hold IDR sen. Named once, so a fifth cannot be added without a decision. */
const MONEY = [
  'annualApeTargetMinor', 'savingsTargetMinor', 'apeAchievedMinor', 'caseSizeMinor',
] as const;

/** The three that are percentages. `monthsLeft` is not one — it is a count of months. */
const PERCENT = ['commissionRatePct', 'leadsToApptPct', 'closingRatePct'] as const;

export function checkGoal(body: unknown, opts: { partial?: boolean } = {}): CheckedGoal {
  const required = !opts.partial;
  const f = new Fields(body, [
    'period', 'mode', ...MONEY, ...PERCENT, 'monthsLeft',
  ]);

  const out: CheckedGoal = {};

  /*
   * Read raw rather than through `Fields.code`: a semantic code must start with a letter, and a
   * period is `2026`. It is a **year**, not a code — the two look alike and are not the same kind
   * of thing, which is the distinction ADR-0049 turns on.
   */
  const period = raw(body, 'period');
  if (period === undefined) {
    if (required) f.violations.push(REQUIRED({ field: 'period' }));
  } else if (typeof period !== 'string' || !PERIOD.test(period)) {
    f.violations.push(SAY.periodShape);
  } else {
    out.period = period;
  }

  const mode = f.oneOf('mode', GOAL_MODES, required);
  if (mode !== undefined) out.mode = mode;

  /*
   * **Whole sen, and that is the check.** `Fields.number` refuses a non-number and anything out of
   * range; what it cannot know is that these four are *minor units*, where a fraction is not a
   * rounding question but a unit error — somebody handed major units to a field that stores sen.
   */
  for (const field of MONEY) {
    /*
     * **The APE produced is the one money field a save may leave out** (S1 of the T17–T20 permission review): a screen
     * sends it only when the reader changed it in this edit, and absent means *keep the stored figure* (`typedApeOf`) —
     * so a coach saving the target never writes back, over the member's newer figure, the one they read.
     */
    const value = f.number(field, GOAL_BOUNDS.money, required && field !== 'apeAchievedMinor');
    if (value === undefined) continue;
    if (!Number.isInteger(value)) {
      f.violations.push(SAY.wholeSen({ field }));
      continue;
    }
    out[field] = value;
  }

  /*
   * **Shape only: is this a percentage-shaped number.** Whether it is a *usable* one — above zero
   * and at most a hundred — is `goal-cascade.ts`'s, which refuses it with
   * `GOAL_INVALID_ASSUMPTION` so a screen can point at the field rather than at the form. One
   * semantic rule, in the module that needs it (invariant §8).
   *
   * **Decimals survive here, deliberately** (I-108). The prototype's `parseNum` strips every
   * non-digit, so `12.5` becomes `125`: a commission rate of twelve and a half per cent read as a
   * hundred and twenty-five, and a plan built on a tenfold error.
   */
  for (const field of PERCENT) {
    const value = raw(body, field);
    if (value === undefined) {
      if (required) f.violations.push(REQUIRED({ field }));
      continue;
    }
    if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
      f.violations.push(SAY.percentShape({ field }));
      continue;
    }
    out[field] = value;
  }

  /*
   * **`null` is a value, not an absence** (P8-T5): it says *use the office's calendar*, and it is
   * what the screen sends unless the agent typed over the figure. Taken before the number check,
   * which would otherwise record a violation for it.
   */
  const months = raw(body, 'monthsLeft');
  if (months === null) out.monthsLeft = null;
  else if (months !== undefined || required) {
    const checked = f.number('monthsLeft', GOAL_BOUNDS.monthsLeft, required);
    if (checked !== undefined) out.monthsLeft = checked;
  }

  return f.done(out);
}

/**
 * **What `PUT /goals/:period/ape-estimate` takes** (P19.1-T4, UI-157 item 4; ADR-0195 §2): `{ apeAchievedMinor }`, whole
 * IDR sen in the goal's money bounds, nothing else — the member's own estimate of the APE produced so far this year.
 * `null` is *Hapus*, and clears it to 0, nothing typed — as 0 does.
 */
export function checkEstimate(body: unknown): number {
  if (raw(body, 'apeAchievedMinor') === null) {
    new Fields(body, ['apeAchievedMinor']).done({});
    return 0;
  }
  const f = new Fields(body, ['apeAchievedMinor']);
  const value = f.number('apeAchievedMinor', GOAL_BOUNDS.money, true);
  if (value !== undefined && !Number.isInteger(value)) f.violations.push(SAY.wholeSen({ field: 'apeAchievedMinor' }));
  return f.done({ apeAchievedMinor: value as number }).apeAchievedMinor;
}

/**
 * **Which typed *APE yang sudah dicapai tahun ini* a save or a preview keeps** (ADR-0075, partly reversed by
 * ADR-0183).
 *
 * - **A body that leaves it out keeps the stored figure**, whoever saves (S1 of the T17–T20 permission review): the
 *   screens send it only when the reader changed it in this edit, so a coach saving the target does not write back the
 *   figure they read over the member's newer one. A body that carries it is an edit, and the last write wins.
 *
 * - **The member's own plan**: what they typed, always — measured against only while the office holds no figure, and
 *   stored as theirs either way (P9-T6).
 * - **Somebody else's plan** — a leader who coaches them, or the office's Owner or Admin, the reach `goal:update`
 *   already gives a save (§3.6) — **what they typed, when the office holds no year-to-date figure for the year**
 *   (ADR-0183: the member's figure is often nobody's until a leader types it in a 1:1).
 * - **An office figure — uploaded or corrected — locks it for everybody but the member**: somebody else's typing is
 *   *ignored*, not refused, and the member's stored figure is kept. Ignored because the plan around it is still theirs
 *   to save, and the screen never offers the field in that state (`PillReadOnly`).
 *
 * Pure, so the rule is pinned without a database.
 */
export function typedApeOf({ own, held, asked, stored }: {
  /** The caller's own plan. */
  own: boolean;
  /** The office's year-to-date figure for the year, or `null` when it holds none. */
  held: unknown;
  /** The figure the body carries, or `undefined` when it leaves it out. */
  asked: number | undefined;
  /** The figure the plan already stores (0 where there is no plan). */
  stored: number;
}): number {
  if (asked === undefined) return stored;
  if (own) return asked;
  return held === null || held === undefined ? asked : stored;
}

/**
 * **Who typed the figure a plan now stores** (S2 of the T17–T20 permission review): the saver when this save changed
 * it, else whoever typed it before — `null` on a row from before the field, which reads as the member. Pure, beside
 * `typedApeOf`, so the two rules are pinned together.
 */
export function typedByAfter({ before, after, savedBy, typedBefore }: {
  /** The figure the plan stored before the save (0 where there was none). */
  before: number;
  /** The figure the save stores. */
  after: number;
  /** The membership saving. */
  savedBy: string;
  /** Who typed the figure before, as stored; `null` or absent for the member. */
  typedBefore: string | null | undefined;
}): string | null {
  return after !== before ? savedBy : (typedBefore ?? null);
}

/** `Fields` collects its own; this reaches the raw value for the cases it does not cover. */
function raw(body: unknown, key: string): unknown {
  if (body === null || typeof body !== 'object' || Array.isArray(body)) return undefined;
  return (body as Record<string, unknown>)[key];
}
