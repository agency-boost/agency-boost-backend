/**
 * **The *Potensi* tab's three figures** (P19.1-T6; ADR-0193; UI-155; `metrics-and-definitions.md`, §A.10): each defined
 * once, here, over what the leads and the office's production row for the month say. Pure, so each rule is a unit test.
 *
 * - **`LEAD_POTENSI_THIS_MONTH`** — a lead is *potensi* for month M when it holds a `commitments[]` entry for M: the
 *   switch *Potensi closing bulan ini* / *Potensi rekrut bulan ini* (UI-153), the commitment P7-T5 built, renamed on
 *   screen. A person's ***n potensi*** counts those of a type that are **still open** at the month's end — open now for
 *   the office's current month, open at the month's last office day for an earlier one.
 * - **`AA_THIS_MONTH`** — a member is *AA* in M when one of their sales leads was marked *Berhasil* in M (`outcome =
 *   won`, `outcomeAt` inside M on the office's calendar), **or** the office's production row for M shows policies > 0.
 *   Never `MONTHLY_ACTIVE_AGENT` (it reads a lead), never `FIRST_SALE_DATE` (any month's case counts).
 * - **`REKRUT_THIS_MONTH`** — a recruitment lead marked *Berhasil* in M, switched on or not. *Berhasil* is possible only
 *   at the office's terminal Recruit stage (ADR-0194 §4).
 *
 * **M's bounds are the office's** — `Clock.monthBounds(timezone, month)`, Asia/Jakarta (invariant §9, ADR-0016). An
 * instant is in M when `start <= at < endExclusive`; 00:00 WIB on the 1st is the next month's.
 */

/** What these rules read of a lead. Nothing else of it. */
export interface PotensiLead {
  type: 'sales' | 'recruitment' | null;
  outcome: 'won' | 'lost' | null;
  outcomeAt: Date | null;
  commitments?: readonly { month: string }[] | null;
}

/** A month on the office's calendar: its key and its bounds. */
export interface PotensiMonth {
  /** `YYYY-MM`. */
  month: string;
  start: Date;
  endExclusive: Date;
}

/** `LEAD_POTENSI_THIS_MONTH`: the lead's switch is on for `month`. Its outcome does not turn it off (UI-153 item 4). */
export function leadPotensiThisMonth(lead: Pick<PotensiLead, 'commitments'>, month: string): boolean {
  return (lead.commitments ?? []).some((c) => c.month === month);
}

const inMonth = (at: Date | null, m: PotensiMonth) =>
  at !== null && at.getTime() >= m.start.getTime() && at.getTime() < m.endExclusive.getTime();

/** Marked *Berhasil* inside the month, on the office's calendar. */
export function wonIn(lead: Pick<PotensiLead, 'outcome' | 'outcomeAt'>, m: PotensiMonth): boolean {
  return lead.outcome === 'won' && inMonth(lead.outcomeAt, m);
}

/**
 * **Still open at the month's end** — closed (won or lost) at no instant before `endExclusive`. For the office's
 * current month that is *open now*; for an earlier month, a lead closed after it ended still counts as open then.
 */
export function openAtEndOf(lead: Pick<PotensiLead, 'outcome' | 'outcomeAt'>, m: PotensiMonth): boolean {
  if (lead.outcome === null) return true;
  // A close with no instant is a close of unknown date: counted as closed, never as a potential.
  return lead.outcomeAt !== null && lead.outcomeAt.getTime() >= m.endExclusive.getTime();
}

/** One view's figures for one person. */
export interface PersonPotensiView {
  /** *n potensi*: leads of the view's type switched on for M and still open at its end. */
  potensi: number;
  /** Every lead of the view's type switched on for M, whatever became of it: a person with one is in a past month's *y*. */
  switched: number;
  /** Leads of the view's type marked *Berhasil* in M, switched on or not: *AA ✓*'s lead path, *n rekrut ✓*. */
  won: number;
}

/** A person's figures on both tiles. */
export interface PersonPotensi {
  sales: PersonPotensiView;
  recruitment: PersonPotensiView;
}

const nothing = (): PersonPotensiView => ({ potensi: 0, switched: 0, won: 0 });

/** **A person's two views** over their leads, for month M. A lead with no type is on neither tile. */
export function personPotensi(leads: readonly PotensiLead[], m: PotensiMonth): PersonPotensi {
  const out: PersonPotensi = { sales: nothing(), recruitment: nothing() };
  for (const lead of leads) {
    if (lead.type !== 'sales' && lead.type !== 'recruitment') continue;
    const view = out[lead.type];
    const switched = leadPotensiThisMonth(lead, m.month);
    const won = wonIn(lead, m);
    if (switched) view.switched += 1;
    if (switched && openAtEndOf(lead, m)) view.potensi += 1;
    if (won) view.won += 1;
  }
  return out;
}

/**
 * `AA_THIS_MONTH`: a sales lead marked *Berhasil* in M, **or** M's production row shows policies above zero. `null`
 * policies is a month the office holds no figure for, which is not zero and is not a case either.
 */
export function aaThisMonth(salesWonInMonth: number, policiesInMonth: number | null): boolean {
  return salesWonInMonth > 0 || (policiesInMonth !== null && policiesInMonth > 0);
}

/** `REKRUT_THIS_MONTH` over a person: their recruitment leads marked *Berhasil* in M. */
export function rekrutThisMonth(person: PersonPotensi): number {
  return person.recruitment.won;
}
