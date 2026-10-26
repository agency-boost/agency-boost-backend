import { CASCADE_ACTIVITY_CODES } from '@/domain/constants';
import { measuredRates } from './measured-rates';
import { metric } from './registry';

const counts = (entries: Record<string, number>) => new Map(Object.entries(entries));
/** The default binding: the platform's three codes, one per role. */
const DEFAULT = {
  leads: [CASCADE_ACTIVITY_CODES.leadsCode],
  appointments: [CASCADE_ACTIVITY_CODES.appointmentsCode],
  closings: [CASCADE_ACTIVITY_CODES.closingsCode],
};

/** The two conversion assumptions, measured (ADR-0055, P10-T9). */
describe('measured conversion rates (ADR-0055)', () => {
  it('divides appointments by leads contacted, and closings by appointments, over the cascade’s codes', () => {
    expect(measuredRates(
      counts({ LEADS_CONTACTED: 40, SELL_PRESENTATION: 10, SELL_SUBMISSION: 2, SELL_FOLLOWUP: 99, RECRUIT_PRESENTATION: 99 }),
      DEFAULT,
    )).toEqual({ leadToAppointmentRate: 0.25, closingRate: 0.2 });
  });

  it('is not enough data — null, never 0 — where the denominator is zero', () => {
    expect(measuredRates(counts({ SELL_SUBMISSION: 3 }), DEFAULT))
      .toEqual({ leadToAppointmentRate: null, closingRate: null });
    expect(measuredRates(counts({ LEADS_CONTACTED: 5 }), DEFAULT))
      .toEqual({ leadToAppointmentRate: 0, closingRate: null });
  });

  it('follows whatever codes the office binds, not the seeded ones', () => {
    const binding = { leads: ['CALLS'], appointments: ['MEETINGS'], closings: ['SALES'] };
    expect(measuredRates(counts({ CALLS: 10, MEETINGS: 5, SALES: 1, LEADS_CONTACTED: 1000 }), binding))
      .toEqual({ leadToAppointmentRate: 0.5, closingRate: 0.2 });
  });

  it('P18.9-T2 AC-2 sums a role bound to [A, B]: the replaced activity and its replacement', () => {
    const binding = { ...DEFAULT, appointments: ['SELL_PRESENTATION', 'SALES_MEETING'] };
    // 6 + 4 meetings over 40 leads; 2 submissions over those 10.
    expect(measuredRates(
      counts({ LEADS_CONTACTED: 40, SELL_PRESENTATION: 6, SALES_MEETING: 4, SELL_SUBMISSION: 2 }), binding,
    )).toEqual({ leadToAppointmentRate: 0.25, closingRate: 0.2 });
  });

  it('is registered — a metric the registry does not define is not served (invariant §8)', () => {
    expect(metric('MEASURED_LEAD_TO_APPOINTMENT_RATE')).toMatchObject({ period: 'ROLLING_30D', threshold: null });
    expect(metric('MEASURED_CLOSING_RATE')).toMatchObject({ period: 'ROLLING_30D', threshold: null });
  });
});
