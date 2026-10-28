import type { LocalDate } from '@/common/time/local-day';

/**
 * **`FIRST_SALE_DATE`** (ADR-0171 §1, P18.96-T4 AC-1; `metrics-and-definitions.md`, *First sale*) — the day of a
 * person's first sale, and where it came from. **Defined here once**: the membership's stored `firstSaleDate`, the
 * migration that backfills it, the seed, and the checklist's `sales:first` link all call `firstSaleOf`.
 *
 * A first sale is **a paid and issued case** (the client's *"issued ≥1 case, new business only"*). It is the earliest
 * of:
 *
 * 1. the office day one of the person's **sales** leads first reached *Paid and issued* — `lead`. A recruitment lead
 *    never counts: it is a person joining, not a case;
 * 2. a **manual checklist tick naming a closing** — a closing logged from the checklist's *Which case?* — `manual`;
 * 3. **failing both**, the first day of the first month the **production file** shows a policy for them —
 *    `monthly_file`. Never before the join date: a month they joined in reads as the join date itself.
 *
 * **Since joining only**: evidence dated before the person's join date is not theirs to count here — a sale before
 * they joined is not a new hire's first sale. A person with no join date yet (pending) counts everything.
 *
 * **It only ever moves earlier** (`earlierFirstSale`): a later record with an earlier date moves it; nothing moves it
 * later — not a lead deleted or moved back down the ladder. **One exception** (`fileSaleWithdrawn`, the P18.96 exit
 * review, M4): a first sale the file gave whose month the file no longer shows is recomputed from what remains, while
 * no 3M result is kept. Pure: the caller reads the records, in the office's calendar (invariant §9), and writes the
 * answer.
 */

/** Where a first sale came from (ADR-0171 §1). The screens say *from the monthly file* for the last. */
export const FIRST_SALE_SOURCES = ['lead', 'manual', 'monthly_file'] as const;
export type FirstSaleSource = (typeof FIRST_SALE_SOURCES)[number];

/** The collection a first sale's record is in: a lead, or a month of the production file. */
export type FirstSaleRecordCollection = 'leads' | 'monthlyAgentData';

/** One closing: a sales lead's first office day at *Paid and issued*. */
export interface ClosingEvidence {
  date: LocalDate;
  recordId: string;
  /**
   * **Logged from the checklist's *Which case?*** (P18.96-T4 AC-3): a closing a hand tick named, created at *Paid
   * and issued* rather than reaching it through the leads flow — the ADR's *manual tick that names a closing*.
   */
  logged: boolean;
}

/** One month of the production file, `YYYY-MM`, and how many policies it holds for the person. */
export interface FileMonthEvidence {
  month: string;
  recordId: string;
  policies: number;
}

export interface SaleEvidence {
  /** The person's join date, an office date; `null` while pending. */
  joinDate: LocalDate | null;
  closings: readonly ClosingEvidence[];
  fileMonths: readonly FileMonthEvidence[];
}

export interface FirstSale {
  date: LocalDate;
  source: FirstSaleSource;
  recordCollection: FirstSaleRecordCollection;
  recordId: string;
}

/** `{date, id}` ascending; on one day a closing from the leads flow before a logged one, then by id. */
function byDate(a: ClosingEvidence, b: ClosingEvidence): number {
  if (a.date !== b.date) return a.date < b.date ? -1 : 1;
  if (a.logged !== b.logged) return a.logged ? 1 : -1;
  return a.recordId < b.recordId ? -1 : a.recordId > b.recordId ? 1 : 0;
}

/** A month's first day, or the join date when the person joined during it: a sale is never dated before joining. */
function fileDay(month: string, joinDate: LocalDate | null): LocalDate {
  const first = `${month}-01`;
  return joinDate !== null && joinDate > first ? joinDate : first;
}

/** The closings since joining, oldest first; `dataOnly` leaves out the ones a hand tick logged. */
function closingsSince(evidence: SaleEvidence, dataOnly: boolean): ClosingEvidence[] {
  return evidence.closings
    .filter((c) => (evidence.joinDate === null || c.date >= evidence.joinDate) && !(dataOnly && c.logged))
    .sort(byDate);
}

/** The file's months holding a policy, from the join month on, oldest first. */
function fileMonthsSince(evidence: SaleEvidence): FileMonthEvidence[] {
  const joinMonth = evidence.joinDate?.slice(0, 7) ?? null;
  return evidence.fileMonths
    .filter((m) => m.policies > 0 && (joinMonth === null || m.month >= joinMonth))
    .sort((a, b) => (a.month < b.month ? -1 : a.month > b.month ? 1 : 0));
}

/**
 * **`FIRST_SALE_DATE`**: the earliest closing since joining — from the leads flow, or logged by a hand tick — and,
 * failing both, the production file's first month with a policy. `null` when there is none.
 *
 * **`dataOnly`** is the checklist's reading (P18.96-T4 AC-4): what the *data* says, a logged closing left out, so a
 * tick saved with one reads *waiting for data* until a closing of the leads flow or the file confirms it.
 */
export function firstSaleOf(evidence: SaleEvidence, options: { dataOnly?: boolean } = {}): FirstSale | null {
  const [earliest] = closingsSince(evidence, options.dataOnly === true);
  if (earliest) {
    return {
      date: earliest.date, source: earliest.logged ? 'manual' : 'lead', recordCollection: 'leads', recordId: earliest.recordId,
    };
  }
  const [month] = fileMonthsSince(evidence);
  if (!month) return null;
  return {
    date: fileDay(month.month, evidence.joinDate), source: 'monthly_file', recordCollection: 'monthlyAgentData',
    recordId: month.recordId,
  };
}

/**
 * **A first sale the file gave, that the file no longer shows** (the P18.96 exit review, M4; ADR-0171's dated note):
 * read from a month of the production file (`monthly_file`), and that month (`recordId`) holds no policy for them now
 * — its import reverted, or its policies corrected to none or cleared. The one case `FirstSaleService` recomputes a
 * first sale from what remains, later or cleared, while no 3M result is kept. `fileMonths` are the months that hold
 * a policy, as `ProductionReadings.policyMonthsOfMany` answers them.
 */
export function fileSaleWithdrawn(
  stored: FirstSale | null, fileMonths: readonly { id: string; policies: number }[],
): boolean {
  return stored !== null && stored.source === 'monthly_file'
    && !fileMonths.some((m) => m.id === stored.recordId && m.policies > 0);
}

/** **Never later** (ADR-0171 §1): the stored first sale, unless the computed one is earlier. */
export function earlierFirstSale(stored: FirstSale | null, computed: FirstSale | null): FirstSale | null {
  if (computed === null) return stored;
  if (stored === null) return computed;
  return computed.date < stored.date ? computed : stored;
}

/**
 * **The closing that made it `n`, from the data** (P18.96-T4 AC-2, `sales:closings:3`; ADR-0171 §3, *"from three paid
 * and issued closings"*): the `n`th sales lead since joining that the leads flow took to *Paid and issued*, by the day
 * it first did. **Leads only**: the production file counts policies, not which case is whose, and the ADR names the
 * file for the first sale alone. Logged closings are left out, as `firstSaleOf`'s `dataOnly` leaves them — they are
 * the ticks' records. `null` before there are `n`.
 */
export function nthClosingOf(
  evidence: Pick<SaleEvidence, 'joinDate' | 'closings'>, n: number,
): { date: LocalDate; source: 'lead'; recordCollection: 'leads'; recordId: string } | null {
  const leads = closingsSince({ ...evidence, fileMonths: [] }, true);
  return leads.length >= n
    ? { date: leads[n - 1].date, source: 'lead', recordCollection: 'leads', recordId: leads[n - 1].recordId }
    : null;
}
