import type { Sentence } from '@/common/i18n/sentence';
import { MONEY_METRICS, type ProductionMetric } from './monthly-agent-data.schema';
import { PRODUCTION_REFUSALS } from './production.messages';

const SAY = PRODUCTION_REFUSALS.UPLOAD_VALUE_OUT_OF_RANGE;

/**
 * What a production figure may be — **one definition, used by the import and by correction alike**
 * (P9-T5 AC-5).
 *
 * Every rule here is about a figure **in the unit it is stored in**: money in integer sen, persistency
 * in percent, the three counts as counts. The import converts the file's *Rp M* first and the
 * correction route receives sen, so both ask the same question of the same number, and a figure the
 * file would be refused for is a figure a correction is refused for too.
 */

/** Counts of people or policies: whole numbers. */
export const COUNT_METRICS: readonly ProductionMetric[] = ['recruitment', 'newActiveAgents', 'policyCount'];

/**
 * The metrics a year-to-date figure is a **sum** of months for, so YTD can never be less than the
 * month. Persistency is a rate — a year's can be lower than one good month's — so it is not here.
 */
export const ADDITIVE_METRICS: readonly ProductionMetric[] = ['ape', 'recruitment', 'newActiveAgents', 'fyp', 'policyCount'];

export const isMoney = (m: ProductionMetric) => (MONEY_METRICS as readonly string[]).includes(m);

/**
 * Why this figure cannot be stored, as the end of a sentence in both languages (P18.98-T5) — or `null` when it can.
 * The import says it after the cell (`Rolling Persistency (%) — This Month: “140” …`), a correction after the figure's
 * name (*APE this month …*).
 */
export function refusalFor(metric: ProductionMetric, stored: number): Sentence<'UPLOAD_VALUE_OUT_OF_RANGE'> | null {
  if (!Number.isFinite(stored)) return SAY.notANumber;
  if (stored < 0) return SAY.negative;
  if (metric === 'persistency') return stored > 100 ? SAY.persistencyAbove100 : null;
  if (isMoney(metric)) {
    if (!Number.isSafeInteger(stored)) return Number.isInteger(stored) ? SAY.tooLarge : SAY.fractionOfSen;
    return null;
  }
  if (COUNT_METRICS.includes(metric) && !Number.isInteger(stored)) {
    return SAY.notWhole({ counts: metric === 'policyCount' ? 'policies' : 'people' });
  }
  return null;
}

/** A pair that would leave the year so far below this month — for the five additive metrics only. */
export const breaksYtd = (metric: ProductionMetric, monthly: number | null, ytd: number | null): boolean =>
  ADDITIVE_METRICS.includes(metric) && monthly !== null && ytd !== null && ytd < monthly;
