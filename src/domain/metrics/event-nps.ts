import { NPS } from '@/domain/constants';

/**
 * `EVENT_NPS` (P18.5-T6 AC-6; `metrics-and-definitions.md`; `KPM_Owner.html:3754-3761`).
 *
 * **The prototype's single rounding**, `round(100·(P − D)/n)`: one definition, so the registry's earlier
 * `round(P/n·100) − round(D/n·100)` is gone — at n = 7, P = 4, D = 2 the two disagree (29 against 28), and the
 * prototype's is the one the Owner's card was drawn from.
 *
 * **Over confirmed attendees only** (OD-31): the caller passes the scores of the feedback whose author a confirmer
 * marked attended. **`null` with none** — the card reads *—*, never 0, because 0 is a real reading (promoters and
 * detractors balanced, the prototype's own Town Hall) and must not also mean *nobody answered*.
 */

export type NpsBucket = 'promoter' | 'passive' | 'detractor';

/** Which bucket a score falls in: 9–10 promoter, 7–8 passive, 0–6 detractor. */
export function npsBucket(score: number): NpsBucket {
  if (score >= NPS.PROMOTER_MIN) return 'promoter';
  if (score <= NPS.DETRACTOR_MAX) return 'detractor';
  return 'passive';
}

/** Is this a score the scale has: a whole number from 0 to 10? */
export function isNpsScore(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= NPS.SCALE_MIN && value <= NPS.SCALE_MAX;
}

export interface NpsReading {
  /** `null` when there is no score to read. */
  readonly nps: number | null;
  readonly n: number;
  readonly promoters: number;
  readonly passives: number;
  readonly detractors: number;
}

/** The office's NPS over these scores, with its parts. */
export function eventNps(scores: readonly number[]): NpsReading {
  const promoters = scores.filter((s) => npsBucket(s) === 'promoter').length;
  const detractors = scores.filter((s) => npsBucket(s) === 'detractor').length;
  const n = scores.length;
  const passives = n - promoters - detractors;
  if (n === 0) return { nps: null, n, promoters, passives, detractors };
  const rounded = Math.round((100 * (promoters - detractors)) / n);
  // `Math.round(-0.4)` is `-0`: a reading of nothing either way is 0, never a signed zero a screen prints as "-0".
  return { nps: rounded === 0 ? 0 : rounded, n, promoters, passives, detractors };
}
