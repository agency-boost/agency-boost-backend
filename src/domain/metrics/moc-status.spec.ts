import { SEED_MOC_RULES } from '@/domain/constants';
import { combine, criterionLabel, criterionMet, mocRuleFor, mocRulesText, mocStatus, type MocInput, type MocRule } from './moc-status';

const RP = (rupiah: number) => rupiah * 100;
const rule = (code: 'MOC_AB' | 'MOC_AAB'): MocRule => {
  const seeded = SEED_MOC_RULES.find((r) => r.code === code)!;
  return {
    code, appliesToOrgLevelCodes: [...seeded.appliesToOrgLevelCodes], groupMode: seeded.groupMode,
    criteriaGroups: seeded.criteriaGroups.map((g) => ({ mode: g.mode, criteria: g.criteria.map((c) => ({ ...c })) })),
  };
};
const AB = rule('MOC_AB');
const AAB = rule('MOC_AAB');
const i = (current: number | null): MocInput => ({ current, period: 'Aug and Sep 2026' });

describe('MOC_STATUS (OD-22 → option 1, D-moc)', () => {
  const passing = {
    NET_APE: i(RP(700_000_000)), MONTHLY2_AA_DU: i(5), MONTHLY2_AA_DG: i(7), MOC_PERSISTENCY: i(88), DIRECT_AB_COUNT: i(0),
  };

  it('P18-T2 AC-4 the AB’s standard path: all four met, whatever Direct AB is', () => {
    const moc = mocStatus(AB, passing);
    expect(moc.status).toBe('met');
    expect(moc.path).toBe('Met via the standard three-criteria path.');
    expect(moc.missing).toBeNull();
    expect(moc.criteria.map((c) => [c.label, c.current, c.required, c.met])).toEqual([
      ['Net APE', RP(700_000_000), RP(600_000_000), true],
      ['Monthly2 AA — DU', 5, 4, true],
      ['Monthly2 AA — DG', 7, 6, true],
      ['Rolling Persistency — DU/DG', 88, 75, true],
      ['— OR — Direct AB (AB on AB)', 0, 5, false],
    ]);
  });

  it('P18-T2 AC-4 the AB’s override path: five direct ABs, whatever the rest', () => {
    const moc = mocStatus(AB, { ...passing, NET_APE: i(RP(1)), MONTHLY2_AA_DU: i(null), DIRECT_AB_COUNT: i(5) });
    expect(moc).toMatchObject({ status: 'met', path: 'Met via the Direct AB (AB on AB) override path.', missing: null });
  });

  it('P18-T2 AC-4 not met: the gaps, and what it needs — the override’s threshold from the rule', () => {
    const moc = mocStatus(AB, { ...passing, MONTHLY2_AA_DU: i(2), MOC_PERSISTENCY: i(70) });
    expect(moc.status).toBe('not_met');
    expect(moc.path).toBe('Needs to clear either the three standard criteria together, or reach 5 Direct ABs.');
    expect(moc.criteria.filter((c) => c.met === false).map((c) => c.code)).toEqual(['MONTHLY2_AA_DU', 'MOC_PERSISTENCY', 'DIRECT_AB_COUNT']);
  });

  it('P18-T2 AC-4 an input not uploaded is null, never ✕, and the status is unknown with what is missing', () => {
    const moc = mocStatus(AB, { ...passing, MOC_PERSISTENCY: { current: null, period: 'Not uploaded yet' } });
    expect(moc.status).toBe('unknown');
    expect(moc.criteria.find((c) => c.code === 'MOC_PERSISTENCY')).toMatchObject({ met: null, current: null });
    expect(moc.missing).toBe('Not uploaded yet: Rolling Persistency — DU/DG.');
    expect(moc.path).toBe('Needs to clear either the three standard criteria together, or reach 5 Direct ABs.');
  });

  it('P18-T2 AC-4 one ✕ fails a group whatever else is unknown; a held count is decided, an input not uploaded is not', () => {
    expect(mocStatus(AB, { ...passing, NET_APE: i(RP(1)), MOC_PERSISTENCY: i(null) }).status).toBe('not_met');
    expect(criterionMet(i(4), 'gte', 4)).toBe(true);
    expect(criterionMet(i(3), 'gte', 4)).toBe(false);
    expect(criterionMet(i(null), 'gte', 4)).toBeNull();
    expect(criterionMet(undefined, 'gte', 4)).toBeNull();
  });

  it('P18-T2 AC-4 the AAB rule: all three, no alternate path', () => {
    const met = mocStatus(AAB, { NET_APE: i(RP(250_000_000)), MONTHLY2_AA: i(2), MOC_PERSISTENCY: i(80) });
    expect(met).toMatchObject({ status: 'met', path: 'AAB requirements have no alternate path — all three must be met.' });
    expect(met.criteria.map((c) => c.label)).toEqual(['Net APE', 'Monthly2 AA', 'Rolling Persistency — DU']);
    expect(mocStatus(AAB, { NET_APE: i(RP(250_000_000)), MONTHLY2_AA: i(1), MOC_PERSISTENCY: i(80) }).status).toBe('not_met');
    // Item 2 of the exit review: a held count is a count — one is short of two, not *perhaps*.
    expect(mocStatus(AAB, { NET_APE: i(RP(250_000_000)), MONTHLY2_AA: i(1), MOC_PERSISTENCY: i(80) }).missing).toBeNull();
    expect(mocStatus(AAB, { NET_APE: i(RP(250_000_000)), MONTHLY2_AA: i(null), MOC_PERSISTENCY: i(80) }))
      .toMatchObject({ status: 'unknown', missing: 'Not uploaded yet: Monthly2 AA.' });
  });

  it('P18-T2 AC-4 the rule that applies is the rung’s, by code; none for a rung no rule names', () => {
    expect(mocRuleFor([AB, AAB], 'AAB')).toBe(AAB);
    expect(mocRuleFor([AB, AAB], 'AGENT')).toBeNull();
  });

  it('P18-T2 AC-4 every comparator a rule may carry, and a label the prototype never drew by its registry name', () => {
    expect([criterionMet(i(5), 'gt', 4), criterionMet(i(4), 'lte', 4), criterionMet(i(4), 'lt', 4), criterionMet(i(4), 'eq', 4)])
      .toEqual([true, true, false, true]);
    expect(criterionMet(i(3), 'eq', 4)).toBe(false);
    expect(combine([true, null], 'any')).toBe(true);
    expect(combine([false, null], 'any')).toBeNull();
    expect(combine([false, false], 'any')).toBe(false);
    expect(criterionLabel('APE_ACHIEVED', AB)).toBe('APE achieved');
    expect(criterionLabel('SOMETHING_ELSE', AB)).toBe('SOMETHING_ELSE');
  });

  it('P18-T2 AC-4 a single-group rule names its rung and its count; a rung-less rule says *These*', () => {
    const custom: MocRule = {
      code: 'X', appliesToOrgLevelCodes: [], groupMode: 'all',
      criteriaGroups: [{ mode: 'all', criteria: Array.from({ length: 12 }, () => ({ metricKey: 'NET_APE', comparator: 'gte', value: 1 })) }],
    };
    expect(mocStatus(custom, { NET_APE: i(2) }).path).toBe('These requirements have no alternate path — all 12 must be met.');
    const override: MocRule = { ...AB, criteriaGroups: [AB.criteriaGroups[0], { mode: 'all', criteria: [{ metricKey: 'NET_APE', comparator: 'gte', value: 9 }] }] };
    expect(mocStatus(override, { NET_APE: i(1) }).path).toMatch(/reach 9 Direct ABs\.$/);
  });

  it('P18-T2 AC-4, P18.95-T1 AC-4 the MOC column’s tooltip, composed from the company’s rules in the prototype’s words (`KPM_Owner.html:1248`), its sums and percentages as ADR-0167 §1 writes them', () => {
    expect(mocRulesText([AAB, AB])).toBe(
      'AAB: Net APE ≥ Rp 200 jt AND Monthly2 AA ≥ 2 AND Rolling Persistency DU ≥ 75,0%.\n'
      + 'AB: (Net APE ≥ Rp 600 jt AND Monthly2 AA DU ≥ 4 / DG ≥ 6 AND Rolling Persistency DU/DG ≥ 75,0%) OR Direct AB (AB on AB) ≥ 5.',
    );
    // A carrier that moves a threshold moves the sentence; no rule, no sentence.
    const raised: MocRule = { ...AAB, criteriaGroups: [{ mode: 'all', criteria: [{ metricKey: 'NET_APE', comparator: 'gt', value: RP(250_500_000) }] }] };
    expect(mocRulesText([raised])).toBe('AAB: Net APE > Rp 250,5 jt.');
    // A threshold is a rule: one the compact form would round is written in full, never rounded (lossless).
    const exact: MocRule = { ...AAB, criteriaGroups: [{ mode: 'all', criteria: [
      { metricKey: 'NET_APE', comparator: 'gte', value: RP(250_550_000) },
      { metricKey: 'MOC_PERSISTENCY', comparator: 'gte', value: 75.55 },
    ] }] };
    expect(mocRulesText([exact])).toBe('AAB: Net APE ≥ Rp 250.550.000 AND Rolling Persistency DU ≥ 75,55%.');
    expect(mocRulesText([])).toBe('');
    expect(mocRulesText([{ ...AAB, criteriaGroups: [{ mode: 'all', criteria: [] }] }])).toBe('');
  });

  it('P18-T2 AC-4 the tooltip: an AND of groups, a group of one unbracketed, a DG with no DU before it, every comparator', () => {
    const odd: MocRule = {
      code: 'X', appliesToOrgLevelCodes: ['AB', 'AAB'], groupMode: 'all',
      criteriaGroups: [
        { mode: 'all', criteria: [{ metricKey: 'MONTHLY2_AA_DG', comparator: 'lte', value: 3 }, { metricKey: 'DIRECT_AB_COUNT', comparator: 'lt', value: 2 }] },
        { mode: 'all', criteria: [{ metricKey: 'MAA_COUNT_IN_UNIT', comparator: 'eq', value: 9 }] },
        { mode: 'all', criteria: [] },
      ],
    };
    expect(mocRulesText([odd])).toBe('AB/AAB: (Monthly2 AA DG ≤ 3 AND Direct AB (AB on AB) < 2) AND Active agents in unit = 9.');
    const exact: MocRule = {
      ...AB, groupMode: 'all',
      criteriaGroups: [{ mode: 'all', criteria: [{ metricKey: 'MONTHLY2_AA_DU', comparator: 'eq', value: 4 }, { metricKey: 'MONTHLY2_AA_DG', comparator: 'eq', value: 6 }] }],
    };
    expect(mocRulesText([exact])).toBe('AB: Monthly2 AA DU = 4 / DG = 6.');
  });
});
