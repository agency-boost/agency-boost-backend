import {
  PRODUCT_DATA, type CalcLimitKind, type CalcState, type ProductCurrency, type ProposalCalcType,
  type ProposalPayFrequency, type RateBasis,
} from '@/domain/constants';
import type { FrequencyFactors, RateRules } from './rate-table.schema';

/**
 * **The premium engine** (P19.15-T1 AC-5, AC-7; ADR-0258 §4, §5; the P1 spec's *Premium and UP*): from a premium table's
 * rows, its rules and its *Cara bayar* factors, the amounts a card shows. **Pure, and the only place a premium is worked
 * out** — the agent's card (through the item's `PATCH`), *Uji coba* and *Uji 3 contoh* all call it, so the three can
 * never disagree (AC-7).
 *
 * - **Exact.** Rates and factors are decimals held as integer micros and every product is a `BigInt`, so no binary
 *   fraction ever reaches a rupiah; one rounding, half up, to the currency's unit (Rp1, or a cent), at the end.
 * - **Nothing invented.** A combination the table lacks is *missing*, never filled from a neighbour; a *Cara bayar*
 *   without a factor or rows of its own is not offered — never an assumed 12× or 11×.
 * - **Nothing changed silently.** A limit gives a message and a chip with the nearest allowed value; the amounts stay.
 */

/** One price of the table, as the engine reads it (`rateRows`). */
export interface EngineRow {
  age: number | null;
  gender: 'male' | 'female' | null;
  smoker: boolean | null;
  plan: string | null;
  payTerm: string | null;
  currency: ProductCurrency;
  frequency: ProposalPayFrequency | null;
  basis: RateBasis;
  rate: number;
  bandMin: number | null;
  bandMax: number | null;
}

/** Who and what is priced. */
export interface EngineProfile {
  age: number | null;
  gender: 'male' | 'female' | null;
  smoker: boolean | null;
  plan: string | null;
  payTerm: string | null;
  currency: ProductCurrency;
}

export interface EngineTable {
  /** The rows that may price this profile — the caller may narrow them by age first; the engine matches the rest. */
  rows: readonly EngineRow[];
  rules: RateRules;
  frequencies: FrequencyFactors;
  /** Whether the table prices by age at all, so a missing age is asked for rather than read as *any*. */
  ageRated: boolean;
}

export type FixedAmount = 'up' | 'premium' | 'goal' | 'none';

export interface EngineRequest {
  calcType: ProposalCalcType;
  profile: EngineProfile;
  payFrequency: ProposalPayFrequency;
  /** The chosen pay term is *Sekali bayar*: its rows are the single premium. */
  singlePayTerm: boolean;
  /** The amount the agent typed last, which the engine keeps (P1 spec: *"the fixed one"*). */
  fixed: FixedAmount;
  up: number | null;
  premium: number | null;
  goal: number | null;
  /** *Cara bayar* just changed, which emptied the premium: the UP is kept and the premium worked out again. */
  frequencyChanged?: boolean;
}

export interface EngineLimit {
  kind: CalcLimitKind;
  /** The limit itself, minor units — a premium limit per year. */
  limitMinor: number;
  /** *"— pakai Rp100 jt"*: the nearest allowed value of the amount to change, or `null` where nothing typed can reach it. */
  chip: { field: 'up' | 'premium' | 'goal'; amountMinor: number } | null;
}

export interface EngineResult {
  state: CalcState;
  up: number | null;
  premium: number | null;
  /** The amount the engine kept: `fixed`, or `up` after a change of *Cara bayar* (ADR-0258 §5). */
  fixed: FixedAmount;
  /** *"Premi disesuaikan karena UP dibulatkan ke {step}"*. */
  note: 'up_rounded' | null;
  /** The step the UP was rounded down to (the rules' `upStep`, else the currency's unit). */
  stepMinor: number | null;
  limit: EngineLimit | null;
  /** The *Cara bayar* the table prices for this profile — what the card offers. */
  frequencies: ProposalPayFrequency[];
  /** `needs_input`: what is missing. */
  missing: 'age' | 'gender' | null;
  /** `age_outside`: the bounds the age is outside of. */
  ageBounds: { min: number | null; max: number | null } | null;
  /** The annual premium of the result, where the table states one: what premium limits read. */
  annualPremium: number | null;
}

const MICRO = 1_000_000n;
const PERIODIC: readonly ProposalPayFrequency[] = ['monthly', 'quarterly', 'semiannual', 'annual'];

/** A decimal as integer micros (`12.35` → `12_350_000n`): `PRODUCT_DATA.RATE_DECIMALS` places, exactly. */
export function toMicros(value: number): bigint {
  return BigInt(Math.round(value * Number(MICRO)));
}

/** `num / den`, half up, both non-negative. */
function roundDiv(num: bigint, den: bigint): bigint {
  return (num * 2n + den) / (den * 2n);
}

/** `num / den`, rounded up, both non-negative. */
function ceilDiv(num: bigint, den: bigint): bigint {
  return (num + den - 1n) / den;
}

/** The currency's rounding unit, minor units: Rp1 is 100 sen, a cent is 1. */
export function unitOf(currency: ProductCurrency): number {
  return PRODUCT_DATA.ROUNDING_UNIT_MINOR[currency];
}

/** `amount` rounded down to a multiple of `step`. */
export function floorTo(amount: number, step: number): number {
  return amount - (amount % step);
}

/** `amount` rounded up to a multiple of `step`. */
export function ceilTo(amount: number, step: number): number {
  const rest = amount % step;
  return rest === 0 ? amount : amount + step - rest;
}

/** **UP → premium**: `up × rate ÷ 1.000 × factor`, rounded half up to the unit. */
export function premiumOfUp(upMinor: number, rateMicros: bigint, factorMicros: bigint, unit: number): number {
  const num = BigInt(upMinor) * rateMicros * factorMicros;
  return Number(roundDiv(num, 1000n * MICRO * MICRO * BigInt(unit)) * BigInt(unit));
}

/** **Premium → UP**: `premium ÷ (rate ÷ 1.000 × factor)`, rounded down to a minor unit; `null` for a zero rate. */
export function upOfPremium(premiumMinor: number, rateMicros: bigint, factorMicros: bigint): number | null {
  const den = rateMicros * factorMicros;
  if (den === 0n) return null;
  return Number((BigInt(premiumMinor) * 1000n * MICRO * MICRO) / den);
}

/** **A plan's premium**: the table's annual premium × the factor, rounded half up to the unit. */
export function premiumOfPlan(annualMinor: number, factorMicros: bigint, unit: number): number {
  return Number(roundDiv(BigInt(annualMinor) * factorMicros, MICRO * BigInt(unit)) * BigInt(unit));
}

/** **Premium → benefit** (`premium_benefit`): the annual premium × rate ÷ 1.000, rounded down to the unit. */
export function benefitOfPremium(premiumMinor: number, rateMicros: bigint, factorMicros: bigint, unit: number): number | null {
  if (factorMicros === 0n) return null;
  const num = BigInt(premiumMinor) * MICRO * rateMicros;
  const den = factorMicros * 1000n * MICRO * BigInt(unit);
  return Number((num / den) * BigInt(unit));
}

/** Does `row` price `p`? `null` in a row is *any*; a smoker not asked reads *Tidak*. */
export function rowMatches(row: EngineRow, p: EngineProfile): boolean {
  return (row.age === null || row.age === p.age)
    && (row.gender === null || row.gender === p.gender)
    && (row.smoker === null || row.smoker === (p.smoker ?? false))
    && (row.plan === null || row.plan === p.plan)
    && (row.payTerm === null || row.payTerm === p.payTerm)
    && row.currency === p.currency;
}

/** How exactly a row names its profile: the more attributes it names, the more it is the profile's own. */
const specificity = (row: EngineRow) =>
  [row.age, row.gender, row.smoker, row.plan, row.payTerm].filter((v) => v !== null).length;

/** The most specific of the rows, the first of equals (the file's order). */
function mostSpecific(rows: readonly EngineRow[]): EngineRow | null {
  let best: EngineRow | null = null;
  for (const row of rows) if (best === null || specificity(row) > specificity(best)) best = row;
  return best;
}

/** **The rows for one *Cara bayar*, and the factor that turns them into it** — or why there are none. */
export function rowsFor(
  matched: readonly EngineRow[], frequency: ProposalPayFrequency, factors: FrequencyFactors, single: boolean,
): { rows: EngineRow[]; factor: bigint } | 'missing_combination' | 'no_frequency' {
  const direct = matched.filter((r) => r.frequency === frequency);
  if (direct.length > 0) return { rows: direct, factor: MICRO };
  const base = matched.filter((r) => r.frequency === null);
  if (base.length === 0) return matched.length === 0 ? 'missing_combination' : 'no_frequency';
  if (single || frequency === 'single') return single && frequency === 'single' ? { rows: base, factor: MICRO } : 'no_frequency';
  if (frequency === 'annual') return { rows: base, factor: factors.annual === null ? MICRO : toMicros(factors.annual) };
  const factor = factors[frequency as Exclude<ProposalPayFrequency, 'single' | 'annual'>];
  return factor === null ? 'no_frequency' : { rows: base, factor: toMicros(factor) };
}

/** **The *Cara bayar* the table prices for a profile**: its own rows' frequencies, and from annual rows each factor given. */
export function offeredFrequencies(matched: readonly EngineRow[], factors: FrequencyFactors, single: boolean): ProposalPayFrequency[] {
  const out = new Set<ProposalPayFrequency>();
  for (const row of matched) if (row.frequency !== null) out.add(row.frequency);
  if (matched.some((r) => r.frequency === null)) {
    if (single) out.add('single');
    else for (const f of PERIODIC) if (f === 'annual' || factors[f as keyof FrequencyFactors] !== null) out.add(f);
  }
  return [...(single ? ['single' as const] : PERIODIC)].filter((f) => out.has(f));
}

/** The band row that holds `up`, for a `per_band` table; the plain row otherwise. */
function rowForUp(rows: readonly EngineRow[], up: number): EngineRow | null {
  const banded = rows.filter((r) => r.basis === 'per_band');
  if (banded.length === 0) return mostSpecific(rows.filter((r) => r.basis === 'per_mille'));
  return mostSpecific(banded.filter((r) => (r.bandMin ?? 0) <= up && up <= (r.bandMax ?? Number.MAX_SAFE_INTEGER)));
}

/**
 * **The calculation** (ADR-0258 §5). By `calcType`:
 *
 * - `up_premium`: the UP typed gives the premium; the premium typed gives the UP — `premium ÷ rate`, **rounded down to
 *   the UP step** — and the premium again from that UP, so the two always match, with *"Premi disesuaikan"* when it
 *   moved. A `per_band` table finds the band the UP falls in.
 * - `goal`: the goal amount gives the premium, at the rate per Rp1.000 of the goal.
 * - `premium_benefit`: the premium typed gives the benefit, at the rate per Rp1.000 of the annual premium; answered as
 *   `up`.
 * - `plan_priced`: the plan's own annual premium × the factor.
 * - `manual`: nothing.
 *
 * Before any of it: an age or a gender the table prices by and the card lacks is `needs_input`; an age outside the
 * version's entry ages, or past the pay term's maximum, is `age_outside`. On a failure the **calculated** amount is
 * emptied — stale numbers never print — and the typed one kept.
 */
export function calculate(table: EngineTable, req: EngineRequest): EngineResult {
  const { profile: p, calcType } = req;
  const unit = unitOf(p.currency);
  const step = table.rules.upStep ?? unit;
  let fixed = req.fixed;
  const base: EngineResult = {
    state: 'ok', up: req.up, premium: req.premium, fixed, note: null, stepMinor: null, limit: null, frequencies: [],
    missing: null, ageBounds: null, annualPremium: null,
  };
  if (calcType === 'manual') return base;

  /** What the calculation fills, emptied on a failure. */
  const emptied = (state: CalcState, extra: Partial<EngineResult> = {}): EngineResult => {
    const out = { ...base, ...extra, state, fixed };
    if (calcType === 'up_premium') {
      if (fixed === 'premium') out.up = null;
      else out.premium = null;
    } else if (calcType === 'premium_benefit') out.up = null;
    else out.premium = null;
    return out;
  };

  if (p.age === null && table.ageRated) return emptied('needs_input', { missing: 'age' });
  if (p.gender === null && table.rows.some((r) => r.gender !== null)) return emptied('needs_input', { missing: 'gender' });

  const maxForTerm = p.payTerm !== null ? table.rules.payTermMaxAge[p.payTerm] ?? null : null;
  const maxAge = [table.rules.entryAgeMax, maxForTerm].filter((v): v is number => v !== null)
    .reduce<number | null>((a, b) => (a === null ? b : Math.min(a, b)), null);
  if (p.age !== null && ((table.rules.entryAgeMin !== null && p.age < table.rules.entryAgeMin) || (maxAge !== null && p.age > maxAge))) {
    return emptied('age_outside', { ageBounds: { min: table.rules.entryAgeMin, max: maxAge } });
  }

  const matched = table.rows.filter((r) => rowMatches(r, p));
  const frequencies = offeredFrequencies(matched, table.frequencies, req.singlePayTerm);
  base.frequencies = frequencies;
  const found = rowsFor(matched, req.payFrequency, table.frequencies, req.singlePayTerm);
  if (found === 'missing_combination' || found === 'no_frequency') return emptied(found);
  const { rows, factor } = found;
  // The annual rows, where the table states them: what a premium limit (per year) is held to.
  const annualRows = matched.filter((r) => r.frequency === null);
  const annualFactor = req.singlePayTerm ? MICRO : table.frequencies.annual === null ? MICRO : toMicros(table.frequencies.annual);

  switch (calcType) {
    case 'up_premium': {
      // After a change of *Cara bayar* the premium was emptied (a monthly figure is not an annual one): keep the UP.
      if (fixed === 'premium' && req.frequencyChanged && req.premium === null && req.up !== null) fixed = 'up';
      const typed = fixed === 'premium' ? req.premium : fixed === 'up' ? req.up : null;
      if (typed === null) return emptied('needs_amount');
      let up: number;
      let premium: number;
      let note: 'up_rounded' | null = null;
      if (fixed === 'up') {
        const row = rowForUp(rows, typed);
        if (!row) return emptied('missing_combination');
        up = typed;
        premium = premiumOfUp(up, toMicros(row.rate), factor, unit);
      } else {
        // A `per_band` table: a band whose own rate gives a UP inside it — the largest such UP, where a cheaper rate at a
        // larger band lets the same premium buy more. A plain one: its one rate.
        const banded = rows.filter((r) => r.basis === 'per_band');
        const plain = mostSpecific(rows.filter((r) => r.basis === 'per_mille'));
        const tries = banded.length > 0 ? banded : plain ? [plain] : [];
        let chosen: { up: number; row: EngineRow } | null = null;
        for (const row of tries) {
          const raw = upOfPremium(typed, toMicros(row.rate), factor);
          if (raw === null) continue;
          const rounded = floorTo(raw, step);
          if (row.basis === 'per_band' && !((row.bandMin ?? 0) <= rounded && rounded <= (row.bandMax ?? Number.MAX_SAFE_INTEGER))) continue;
          if (chosen === null || rounded > chosen.up) chosen = { up: rounded, row };
        }
        if (!chosen) return emptied('missing_combination');
        up = chosen.up;
        premium = premiumOfUp(up, toMicros(chosen.row.rate), factor, unit);
        if (premium !== typed) note = 'up_rounded';
      }
      const annualRow = rowForUp(annualRows, up);
      const annualPremium = annualRow ? premiumOfUp(up, toMicros(annualRow.rate), annualFactor, unit) : null;
      return {
        ...base, state: 'ok', fixed, up, premium, note, stepMinor: note ? step : null, annualPremium,
        limit: upPremiumLimit(table.rules, up, annualPremium, annualRow?.rate ?? 0, step, unit),
      };
    }
    case 'goal': {
      if (req.goal === null) return emptied('needs_amount');
      fixed = 'goal';
      const row = mostSpecific(rows.filter((r) => r.basis === 'per_mille'));
      if (!row) return emptied('missing_combination');
      const premium = premiumOfUp(req.goal, toMicros(row.rate), factor, unit);
      const annualRow = mostSpecific(annualRows.filter((r) => r.basis === 'per_mille'));
      const annualPremium = annualRow ? premiumOfUp(req.goal, toMicros(annualRow.rate), annualFactor, unit) : null;
      return { ...base, state: 'ok', fixed, premium, annualPremium, limit: goalLimit(table.rules, annualPremium, annualRow?.rate ?? 0, unit) };
    }
    case 'premium_benefit': {
      if (req.premium === null) return emptied('needs_amount');
      fixed = 'premium';
      const row = mostSpecific(rows.filter((r) => r.basis === 'per_mille'));
      if (!row) return emptied('missing_combination');
      const benefit = benefitOfPremium(req.premium, toMicros(row.rate), factor, unit);
      const annualPremium = factor === 0n ? null : Number(roundDiv(BigInt(req.premium) * MICRO, factor));
      return {
        ...base, state: 'ok', fixed, up: benefit, annualPremium,
        limit: premiumLimit(table.rules, annualPremium, factor, unit),
      };
    }
    case 'plan_priced': {
      const row = mostSpecific(rows.filter((r) => r.basis === 'per_plan'));
      if (!row) return emptied('missing_combination');
      const premium = premiumOfPlan(row.rate, factor, unit);
      const annualRow = mostSpecific(annualRows.filter((r) => r.basis === 'per_plan'));
      const annualPremium = annualRow ? premiumOfPlan(annualRow.rate, annualFactor, unit) : null;
      const limit = premiumLimit(table.rules, annualPremium, factor, unit);
      return { ...base, state: 'ok', fixed: 'none', premium, annualPremium, limit: limit ? { ...limit, chip: null } : null };
    }
  }
}

/** The UP's limits first, then the premium's (per year), each with the UP that reaches the nearest allowed value. */
function upPremiumLimit(
  rules: RateRules, up: number, annual: number | null, rate: number, step: number, unit: number,
): EngineLimit | null {
  if (rules.upMin !== null && up < rules.upMin) {
    return { kind: 'up_min', limitMinor: rules.upMin, chip: { field: 'up', amountMinor: ceilTo(rules.upMin, step) } };
  }
  if (rules.upMax !== null && up > rules.upMax) {
    return { kind: 'up_max', limitMinor: rules.upMax, chip: { field: 'up', amountMinor: floorTo(rules.upMax, step) } };
  }
  if (annual === null) return null;
  const rateMicros = toMicros(rate);
  if (rules.premiumMin !== null && annual < rules.premiumMin && rateMicros > 0n) {
    // The least UP, on the step, whose annual premium reaches the minimum.
    let need = ceilTo(Number(ceilDiv(BigInt(rules.premiumMin) * 1000n * MICRO, rateMicros)), step);
    while (premiumOfUp(need, rateMicros, MICRO, unit) < rules.premiumMin) need += step;
    return { kind: 'premium_min', limitMinor: rules.premiumMin, chip: { field: 'up', amountMinor: need } };
  }
  if (rules.premiumMax !== null && annual > rules.premiumMax && rateMicros > 0n) {
    let most = floorTo(Number((BigInt(rules.premiumMax) * 1000n * MICRO) / rateMicros), step);
    while (most > 0 && premiumOfUp(most, rateMicros, MICRO, unit) > rules.premiumMax) most -= step;
    return { kind: 'premium_max', limitMinor: rules.premiumMax, chip: { field: 'up', amountMinor: most } };
  }
  return null;
}

/** A goal's premium limits (per year), with the goal that reaches the nearest allowed premium. */
function goalLimit(rules: RateRules, annual: number | null, rate: number, unit: number): EngineLimit | null {
  if (annual === null) return null;
  const rateMicros = toMicros(rate);
  if (rules.premiumMin !== null && annual < rules.premiumMin && rateMicros > 0n) {
    let need = ceilTo(Number(ceilDiv(BigInt(rules.premiumMin) * 1000n * MICRO, rateMicros)), unit);
    while (premiumOfUp(need, rateMicros, MICRO, unit) < rules.premiumMin) need += unit;
    return { kind: 'premium_min', limitMinor: rules.premiumMin, chip: { field: 'goal', amountMinor: need } };
  }
  if (rules.premiumMax !== null && annual > rules.premiumMax && rateMicros > 0n) {
    let most = floorTo(Number((BigInt(rules.premiumMax) * 1000n * MICRO) / rateMicros), unit);
    while (most > 0 && premiumOfUp(most, rateMicros, MICRO, unit) > rules.premiumMax) most -= unit;
    return { kind: 'premium_max', limitMinor: rules.premiumMax, chip: { field: 'goal', amountMinor: most } };
  }
  return null;
}

/** A premium's limits (per year), with the premium of this *Cara bayar* that reaches the nearest allowed one. */
function premiumLimit(rules: RateRules, annual: number | null, factor: bigint, unit: number): EngineLimit | null {
  if (annual === null) return null;
  if (rules.premiumMin !== null && annual < rules.premiumMin) {
    const amount = ceilTo(Number(ceilDiv(BigInt(rules.premiumMin) * factor, MICRO)), unit);
    return { kind: 'premium_min', limitMinor: rules.premiumMin, chip: { field: 'premium', amountMinor: amount } };
  }
  if (rules.premiumMax !== null && annual > rules.premiumMax) {
    const amount = floorTo(Number((BigInt(rules.premiumMax) * factor) / MICRO), unit);
    return { kind: 'premium_max', limitMinor: rules.premiumMax, chip: { field: 'premium', amountMinor: amount } };
  }
  return null;
}

/** **Within Rp1** (*Uji 3 contoh*): the app's result and the illustration's differ by at most the tolerance's units. */
export function withinTolerance(actual: number | null, expected: number, currency: ProductCurrency): boolean {
  return actual !== null && Math.abs(actual - expected) <= PRODUCT_DATA.TEST_TOLERANCE_UNITS * unitOf(currency);
}
