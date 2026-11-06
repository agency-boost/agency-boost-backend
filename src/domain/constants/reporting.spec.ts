import { KPM_REPORTING, MOC_PERSISTENCY_MIN_PCT, SEED_MOC_RULES } from '@/domain/constants';

describe('the Owner’s reporting constants (Phase 18, §B)', () => {
  it('P18-T2 AC-3 the analytics’ two periods, This month first and by default (D-period)', () => {
    expect(KPM_REPORTING.ANALYTICS_PERIODS).toEqual(['this_month', 'previous_month']);
    expect(KPM_REPORTING.ANALYTICS_DEFAULT_PERIOD).toBe('this_month');
  });

  it('P18-T2 AC-6 the monthly chart is the six months before this one', () => {
    expect(KPM_REPORTING.MONTHLY_CHART_MONTHS).toBe(6);
  });

  it('P19.3-T1 AC-14 Monthly2 AA has no two-month window any more: it averages the year’s months held (Q6)', () => {
    expect('MONTHLY2_MONTHS' in KPM_REPORTING).toBe(false);
  });

  it('P18-T1 AC-7, P18-T2 AC-3 a row is success at 70% attainment and above, alert below (`KPM_Owner.html:3150`, `:3220`)', () => {
    expect(KPM_REPORTING.STATUS_SPLIT_PCT).toBe(70);
  });

  it('UI-109 a compliance bar is red below 50% done and green from 80% (`kpm-mobile` 3)', () => {
    expect(KPM_REPORTING.COMPLIANCE_LOW_BELOW_PCT).toBe(50);
    expect(KPM_REPORTING.COMPLIANCE_HIGH_FROM_PCT).toBe(80);
  });

  it('P19.3-T2 AC-2 the Belum mencatat list names five and counts the rest (`kpm-overview-mobile` 3; was three, `KPM_Owner.html:988-1001`)', () => {
    expect(KPM_REPORTING.NOT_LOGGED_SHOWN).toBe(5);
  });

  it('P18-T2 AC-4 MOC_PERSISTENCY_MIN_PCT is 75, and both seeded MOC rules ask for it (`KPM_Owner.html:3305`, `:3313`)', () => {
    expect(MOC_PERSISTENCY_MIN_PCT).toBe(75);
    for (const rule of SEED_MOC_RULES) {
      const first = rule.criteriaGroups[0].criteria as readonly { metricKey: string; comparator: string; value: number }[];
      expect([rule.code, first.find((c) => c.metricKey === 'MOC_PERSISTENCY')])
        .toEqual([rule.code, { metricKey: 'MOC_PERSISTENCY', comparator: 'gte', value: MOC_PERSISTENCY_MIN_PCT }]);
    }
  });
});
