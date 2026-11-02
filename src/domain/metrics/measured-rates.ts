/**
 * `MEASURED_LEAD_TO_APPOINTMENT_RATE` and `MEASURED_CLOSING_RATE` (ADR-0055, P10-T9).
 *
 * The measurement of the two conversion assumptions an agent types on Goal Settings, **over the office's
 * cascade binding** — whatever codes it binds to *Set appointment*, *Sales meeting* and *Submission polis*
 * (ADR-0163), each role's codes summed — so the number under each field is the same quantity as the field.
 * Not the office's ratios: those are the office's to redefine and benchmark (ADR-0024); these follow the field.
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
  binding: { leads: readonly string[]; appointments: readonly string[]; closings: readonly string[] },
): MeasuredRates {
  const count = (codes: readonly string[]) => codes.reduce((sum, code) => sum + (counts.get(code) ?? 0), 0);
  const leads = count(binding.leads);
  const appointments = count(binding.appointments);
  const closings = count(binding.closings);
  return {
    leadToAppointmentRate: leads === 0 ? null : appointments / leads,
    closingRate: appointments === 0 ? null : closings / appointments,
  };
}
