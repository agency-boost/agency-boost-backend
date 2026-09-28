import type { LocalDate } from '@/common/time/local-day';
import { INSIGHTS } from '@/domain/constants';
import type { RatioDisplayUnit } from '@/domain/constants/ratio-display';
import type { OpenLead } from '@/modules/leads/lead-readings';
import type { Pace } from './summary-figures';

/**
 * The Personal Summary's insight cards (P10-T7, ADR-0060): **named rules over registered metrics,
 * computed on read.** Pure — the facts in, the cards out — so every rule, its threshold and the priority
 * between them is a unit test away. Nothing is stored and nothing runs at night.
 *
 * **A card carries its facts, not its sentence.** The screen writes the words, as it writes the pace
 * line; the server decides which rules fired and from which numbers, and a card names its rule.
 */

/** The six rules, in their fixed priority (ADR-0060). */
export const INSIGHT_RULES = [
  'NOTHING_LOGGED',
  'BEHIND_PACE',
  'LEAD_OVERDUE',
  'LEAD_NEGLECTED',
  'RATIO_BELOW',
  'RATIO_STRENGTH',
] as const;
export type InsightRule = (typeof INSIGHT_RULES)[number];

/**
 * Which of the prototype's two cards a suggestion belongs on: *What to do next* is something to do this
 * week; *How you can improve your performance* is a pattern in how activity converts.
 */
export type InsightKind = 'action' | 'improve';

export interface RatioFacts {
  code: string;
  label: string;
  value: number;
  benchmark: number;
  displayUnit: RatioDisplayUnit;
}

export type Insight =
  | { rule: 'NOTHING_LOGGED'; kind: 'action'; facts: { windowDays: number; lastLoggedOn: LocalDate | null } }
  | { rule: 'BEHIND_PACE'; kind: 'action'; facts: { projected: number; closingTarget: number; neededPerWeek: number; weeksLeft: number } }
  | { rule: 'LEAD_OVERDUE'; kind: 'action'; facts: { leadId: string; name: string; overdueDays: number; others: number } }
  | { rule: 'LEAD_NEGLECTED'; kind: 'action'; facts: { leadId: string; name: string; others: number } }
  | { rule: 'RATIO_BELOW'; kind: 'improve'; facts: RatioFacts }
  | { rule: 'RATIO_STRENGTH'; kind: 'improve'; facts: RatioFacts };

/** A ratio as the engine answers it — only what the rules read. */
export interface RatioReading {
  code: string;
  label: string;
  comparison: 'gte' | 'band';
  displayUnit: RatioDisplayUnit;
  benchmark: number;
  value: number | null;
  denominatorCount: number;
  status: 'success' | 'alert' | 'neutral';
}

export interface InsightInputs {
  /** `ACTIVITY_COMPLIANCE_7D` over the office's window, and the last day logged. */
  compliance: { compliant: boolean; windowDays: number; lastLoggedOn: LocalDate | null };
  /** The pace sentence's figures; `null` without a goal. */
  pace: Pace | null;
  /** **Every** open lead of the reader's own, nearest next action first — not only the ten the card lists. */
  leads: readonly OpenLead[];
  /** The office's ratios for the reader's rung, over the last 30 days. */
  ratios: readonly RatioReading[];
}

/**
 * The rates with enough behind them to say something: a rate, not the two-ended balance, with a value
 * and at least `INSIGHTS.RATIO_MIN_DENOMINATOR` of its denominator, against a benchmark above zero.
 */
function measurable(ratios: readonly RatioReading[]): (RatioReading & { value: number; standing: number })[] {
  return ratios
    .filter((r): r is RatioReading & { value: number } => r.comparison === 'gte' && r.value !== null
      && r.denominatorCount >= INSIGHTS.RATIO_MIN_DENOMINATOR && r.benchmark > 0)
    .map((r) => ({ ...r, standing: r.value / r.benchmark }));
}

const factsOf = (r: RatioReading & { value: number }): RatioFacts => ({
  code: r.code, label: r.label, value: r.value, benchmark: r.benchmark, displayUnit: r.displayUnit,
});

/** Each rule on its own: the card it makes, or `null` when it has nothing to say. */
const RULES: Record<InsightRule, (input: InsightInputs) => Insight | null> = {
  // Silence in the window, not a day of zeroes: an all-zero day is a statement (ADR-0042).
  NOTHING_LOGGED: ({ compliance }) => (compliance.compliant ? null : {
    rule: 'NOTHING_LOGGED', kind: 'action',
    facts: { windowDays: compliance.windowDays, lastLoggedOn: compliance.lastLoggedOn },
  }),

  // The pace line's own *behind*: a projection short of the target, with the APE target not yet reached.
  // Before the 7th there is no projection, and no card.
  BEHIND_PACE: ({ pace }) => (pace && !pace.targetMet && pace.projected !== null && pace.projected < pace.closingTarget
    ? {
      rule: 'BEHIND_PACE', kind: 'action',
      facts: { projected: pace.projected, closingTarget: pace.closingTarget, neededPerWeek: pace.neededPerWeek, weeksLeft: pace.weeksLeft },
    }
    : null),

  // The latest of the late — the Leads screen's own `overdue` flag and its days.
  // `overdue` always carries its days — `LeadReadings` counts them for exactly that flag.
  LEAD_OVERDUE: ({ leads }) => {
    const late = leads.filter((l): l is OpenLead & { overdueDays: number } => l.flags.includes('overdue') && l.overdueDays !== null);
    if (late.length === 0) return null;
    const worst = late.reduce((a, b) => (b.overdueDays > a.overdueDays ? b : a));
    return {
      rule: 'LEAD_OVERDUE', kind: 'action',
      facts: { leadId: worst.id, name: worst.name, overdueDays: worst.overdueDays, others: late.length - 1 },
    };
  },

  // Nothing decided and nothing written down: the lead that stalls without anybody noticing.
  LEAD_NEGLECTED: ({ leads }) => {
    const stalled = leads.filter((l) => l.flags.includes('no-next-action') && l.flags.includes('no-remarks'));
    if (stalled.length === 0) return null;
    return {
      rule: 'LEAD_NEGLECTED', kind: 'action',
      facts: { leadId: stalled[0].id, name: stalled[0].name, others: stalled.length - 1 },
    };
  },

  // The rate furthest below its benchmark, as a share of it — a miss by half outranks a miss by a tenth.
  RATIO_BELOW: ({ ratios }) => {
    const below = measurable(ratios).filter((r) => r.status === 'alert');
    if (below.length === 0) return null;
    const worst = below.reduce((a, b) => (b.standing < a.standing ? b : a));
    return { rule: 'RATIO_BELOW', kind: 'improve', facts: factsOf(worst) };
  },

  // The rate furthest above — only one well past it, `INSIGHTS.STRENGTH_FACTOR` times, is a strength.
  RATIO_STRENGTH: ({ ratios }) => {
    const strong = measurable(ratios).filter((r) => r.status === 'success' && r.standing >= INSIGHTS.STRENGTH_FACTOR);
    if (strong.length === 0) return null;
    const best = strong.reduce((a, b) => (b.standing > a.standing ? b : a));
    return { rule: 'RATIO_STRENGTH', kind: 'improve', facts: factsOf(best) };
  },
};

/**
 * **The cards: every rule that fired, in the fixed priority, at most `INSIGHTS.MAX_CARDS`** (ADR-0060).
 * A rule without enough data makes no card; nothing is padded to fill the four.
 */
export function insightsFor(input: InsightInputs): Insight[] {
  return INSIGHT_RULES
    .map((rule) => RULES[rule](input))
    .filter((card): card is Insight => card !== null)
    .slice(0, INSIGHTS.MAX_CARDS);
}
