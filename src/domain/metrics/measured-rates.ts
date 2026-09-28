/**
 * `MEASURED_LEAD_TO_APPOINTMENT_RATE` and `MEASURED_CLOSING_RATE` (ADR-0055, P10-T9).
 *
 * The measurement of the two conversion assumptions an agent types on Goal Settings, **over the
 * goal's own cascade codes** — whatever the office binds *leads*, *appointments* and *closings* to — so
 * the number under each field is the same quantity as the field. Not the office's ratios: those are the
 * office's to redefine and benchmark (ADR-0024); these follow the field.
 *
 * `null` on a zero denominator — *not enough data*, never 0% and never a prompt to type something in.
 */
export interface MeasuredRates {
  /** Appointments ÷ leads contacted. */
  leadToAppointmentRate: number | null;
  /** Closings ÷ appointments. */
  closingRate: number | null;
}

export function measuredRates(
  counts: ReadonlyMap<string, number>,
  mapping: { leadsCode: string; appointmentsCode: string; closingsCode: string },
): MeasuredRates {
  const count = (code: string) => counts.get(code) ?? 0;
  const leads = count(mapping.leadsCode);
  const appointments = count(mapping.appointmentsCode);
  const closings = count(mapping.closingsCode);
  return {
    leadToAppointmentRate: leads === 0 ? null : appointments / leads,
    closingRate: appointments === 0 ? null : closings / appointments,
  };
}
