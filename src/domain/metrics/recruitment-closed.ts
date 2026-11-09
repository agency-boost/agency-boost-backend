/**
 * `RECRUITMENT_CLOSED_LAST_MONTH` — *Recruitment last month* (`metrics-and-definitions.md` §A.11; P19.3-T1, ADR-0200 §5,
 * the data sources' D2: *"The upload `RECRUITMENT` column, everywhere … Overview 'last month'"*).
 *
 * **The office's file's recruitment for the previous calendar month**: the upload's `RECRUITMENT` summed over the
 * office's rows for that month — a leaver's row included, as the file's figures stay the office's (ADR-0136 §1) — the
 * sum `OfficialApe.officeMonths` already makes (`OfficeMonth.recruitmentMonthly`). **`null`** — drawn *"–"* — **when no
 * row of that month holds a recruitment figure**: not uploaded, never 0.
 *
 * *Until P19.3-T1* it counted the recruitment leads closed won in the month (the handover's second mockup bug, *"uses
 * pipeline closes"*). A lead is a candidate: the pipeline counts them by stage, and nothing here reads one.
 */
export function recruitmentLastMonth(month: { recruitmentMonthly: number | null } | undefined): number | null {
  return month?.recruitmentMonthly ?? null;
}
