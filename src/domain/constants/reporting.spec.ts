import { KPM_REPORTING, MOC_PERSISTENCY_MIN_PCT, SEED_MOC_RULES } from '@/domain/constants';

describe('the Owner’s reporting constants (Phase 18, §B)', () => {
  it('P19.19-T3 AC-1 Produksi 6 bulan is the six months ending with this one', () => {
    expect(KPM_REPORTING.MONTHLY_CHART_MONTHS).toBe(6);
  });

  it('P19.3-T1 AC-14 Monthly2 AA has no two-month window any more: it averages the year’s months held (Q6)', () => {
    expect('MONTHLY2_MONTHS' in KPM_REPORTING).toBe(false);
  });

  it('P19.19-T4 AC-1 KPM Analytics’ periods, its 70% split and the first Overview’s five are retired (ADR-0272 §1, §2)', () => {
    for (const key of ['ANALYTICS_PERIODS', 'ANALYTICS_DEFAULT_PERIOD', 'STATUS_SPLIT_PCT', 'NOT_LOGGED_SHOWN']) {
      expect(key in KPM_REPORTING).toBe(false);
    }
  });

  it('P19.19-T3 AC-2 a compliance card is red below 34% done, yellow below 67% and green from 67% (the brief’s §6)', () => {
    expect(KPM_REPORTING.COMPLIANCE_LOW_BELOW_PCT).toBe(34);
    expect(KPM_REPORTING.COMPLIANCE_HIGH_FROM_PCT).toBe(67);
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
