import { readerIn, SOURCE_READER } from '@/common/i18n/reader';
import { SEED_MOC_RULES } from '@/domain/constants';
import { combine, criterionLabel, criterionMet, mocRuleFor, mocRulesText, mocStatus, type MocInput, type MocRule } from './moc-status';

/** The API's English as it wrote it before P18.10-T5: English words, Indonesian figures. */
const EN = SOURCE_READER;
const ID = readerIn('id');

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
    MOC_APE: i(RP(700_000_000)), MONTHLY2_AA_DU: i(5), MONTHLY2_AA_DG: i(7), MOC_PERSISTENCY: i(88), DIRECT_AB_COUNT: i(0),
  };

  it('P18-T2 AC-4 the AB’s standard path: all four met, whatever Direct AB is', () => {
    const moc = mocStatus(AB, passing, EN);
    expect(moc.status).toBe('met');
    expect(moc.path).toBe('Met via the standard three-criteria path.');
    expect(moc.missing).toBeNull();
    expect(moc.criteria.map((c) => [c.label, c.current, c.required, c.met])).toEqual([
      ['APE', RP(700_000_000), RP(600_000_000), true],
      ['Monthly2 AA — DU', 5, 4, true],
      ['Monthly2 AA — DG', 7, 6, true],
      ['Rolling Persistency — DU/DG', 88, 75, true],
      ['— OR — Direct AB (AB on AB)', 0, 5, false],
    ]);
  });

  it('P18-T2 AC-4 the AB’s override path: five direct ABs, whatever the rest', () => {
    const moc = mocStatus(AB, { ...passing, MOC_APE: i(RP(1)), MONTHLY2_AA_DU: i(null), DIRECT_AB_COUNT: i(5) }, EN);
    expect(moc).toMatchObject({ status: 'met', path: 'Met via the Direct AB (AB on AB) override path.', missing: null });
  });

  it('P18-T2 AC-4 not met: the gaps, and what it needs — the override’s threshold from the rule', () => {
    const moc = mocStatus(AB, { ...passing, MONTHLY2_AA_DU: i(2), MOC_PERSISTENCY: i(70) }, EN);
    expect(moc.status).toBe('not_met');
    expect(moc.path).toBe('Needs to clear either the three standard criteria together, or reach 5 Direct ABs.');
    expect(moc.criteria.filter((c) => c.met === false).map((c) => c.code)).toEqual(['MONTHLY2_AA_DU', 'MOC_PERSISTENCY', 'DIRECT_AB_COUNT']);
  });

  it('P18-T2 AC-4 an input not uploaded is null, never ✕, and the status is unknown with what is missing', () => {
    const moc = mocStatus(AB, { ...passing, MOC_PERSISTENCY: { current: null, period: 'Not uploaded yet' } }, EN);
    expect(moc.status).toBe('unknown');
    expect(moc.criteria.find((c) => c.code === 'MOC_PERSISTENCY')).toMatchObject({ met: null, current: null });
    expect(moc.missing).toBe('Not uploaded yet: Rolling Persistency — DU/DG.');
    expect(moc.path).toBe('Needs to clear either the three standard criteria together, or reach 5 Direct ABs.');
  });

  it('P18-T2 AC-4 one ✕ fails a group whatever else is unknown; a held count is decided, an input not uploaded is not', () => {
    expect(mocStatus(AB, { ...passing, MOC_APE: i(RP(1)), MOC_PERSISTENCY: i(null) }, EN).status).toBe('not_met');
    expect(criterionMet(i(4), 'gte', 4)).toBe(true);
    expect(criterionMet(i(3), 'gte', 4)).toBe(false);
    expect(criterionMet(i(null), 'gte', 4)).toBeNull();
    expect(criterionMet(undefined, 'gte', 4)).toBeNull();
  });

  it('P18-T2 AC-4 the AAB rule: all three, no alternate path', () => {
    const met = mocStatus(AAB, { MOC_APE: i(RP(250_000_000)), MONTHLY2_AA: i(2), MOC_PERSISTENCY: i(80) }, EN);
    expect(met).toMatchObject({ status: 'met', path: 'AAB requirements have no alternate path — all three must be met.' });
    expect(met.criteria.map((c) => c.label)).toEqual(['APE', 'Monthly2 AA', 'Rolling Persistency — DU']);
    expect(mocStatus(AAB, { MOC_APE: i(RP(250_000_000)), MONTHLY2_AA: i(1), MOC_PERSISTENCY: i(80) }, EN).status).toBe('not_met');
    // Item 2 of the exit review: a held count is a count — one is short of two, not *perhaps*.
    expect(mocStatus(AAB, { MOC_APE: i(RP(250_000_000)), MONTHLY2_AA: i(1), MOC_PERSISTENCY: i(80) }, EN).missing).toBeNull();
    expect(mocStatus(AAB, { MOC_APE: i(RP(250_000_000)), MONTHLY2_AA: i(null), MOC_PERSISTENCY: i(80) }, EN))
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
      criteriaGroups: [{ mode: 'all', criteria: Array.from({ length: 12 }, () => ({ metricKey: 'MOC_APE', comparator: 'gte', value: 1 })) }],
    };
    expect(mocStatus(custom, { MOC_APE: i(2) }, EN).path).toBe('These requirements have no alternate path — all 12 must be met.');
    const override: MocRule = { ...AB, criteriaGroups: [AB.criteriaGroups[0], { mode: 'all', criteria: [{ metricKey: 'MOC_APE', comparator: 'gte', value: 9 }] }] };
    expect(mocStatus(override, { MOC_APE: i(1) }, EN).path).toMatch(/reach 9 Direct ABs\.$/);
  });

  it('P18-T2 AC-4, P18.7-T1 AC-4, P18.9-T3 AC-2 the MOC column’s tooltip, composed from the company’s rules in the prototype’s words (`KPM_Owner.html:1248`), its sums and percentages as ADR-0174 writes them', () => {
    expect(mocRulesText([AAB, AB], EN)).toBe(
      'AAB: APE ≥ Rp 200 Jt AND Monthly2 AA ≥ 2 AND Rolling Persistency DU ≥ 75%.\n'
      + 'AB: (APE ≥ Rp 600 Jt AND Monthly2 AA DU ≥ 4 / DG ≥ 6 AND Rolling Persistency DU/DG ≥ 75%) OR Direct AB (AB on AB) ≥ 5.',
    );
    // A carrier that moves a threshold moves the sentence; no rule, no sentence.
    const raised: MocRule = { ...AAB, criteriaGroups: [{ mode: 'all', criteria: [{ metricKey: 'MOC_APE', comparator: 'gt', value: RP(250_500_000) }] }] };
    expect(mocRulesText([raised], EN)).toBe('AAB: APE > Rp 250,5 Jt.');
    // A threshold is a rule: one the compact form would round is written in full, never rounded (lossless).
    const exact: MocRule = { ...AAB, criteriaGroups: [{ mode: 'all', criteria: [
      { metricKey: 'MOC_APE', comparator: 'gte', value: RP(250_550_000) },
      { metricKey: 'MOC_PERSISTENCY', comparator: 'gte', value: 75.55 },
    ] }] };
    expect(mocRulesText([exact], EN)).toBe('AAB: APE ≥ Rp 250.550.000 AND Rolling Persistency DU ≥ 75,55%.');
    expect(mocRulesText([], EN)).toBe('');
    expect(mocRulesText([{ ...AAB, criteriaGroups: [{ mode: 'all', criteria: [] }] }], EN)).toBe('');
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
    expect(mocRulesText([odd], EN)).toBe('AB/AAB: (Monthly2 AA DG ≤ 3 AND Direct AB (AB on AB) < 2) AND Active agents in unit = 9.');
    const exact: MocRule = {
      ...AB, groupMode: 'all',
      criteriaGroups: [{ mode: 'all', criteria: [{ metricKey: 'MONTHLY2_AA_DU', comparator: 'eq', value: 4 }, { metricKey: 'MONTHLY2_AA_DG', comparator: 'eq', value: 6 }] }],
    };
    expect(mocRulesText([exact], EN)).toBe('AB: Monthly2 AA DU = 4 / DG = 6.');
  });

  it('P18.10-T5 AC-4 the dialog’s sentences in Indonesian: the path, what is missing, the OR — the criteria by their names', () => {
    expect(mocStatus(AB, passing, ID)).toMatchObject({ status: 'met', path: 'Terpenuhi melalui jalur standar tiga kriteria.' });
    expect(mocStatus(AB, passing, ID).criteria.map((c) => c.label)).toEqual([
      'APE', 'Monthly2 AA — DU', 'Monthly2 AA — DG', 'Rolling Persistency — DU/DG', '— ATAU — Direct AB (AB on AB)',
    ]);
    expect(mocStatus(AB, { ...passing, MOC_APE: i(RP(1)), MONTHLY2_AA_DU: i(null), DIRECT_AB_COUNT: i(5) }, ID).path)
      .toBe('Terpenuhi melalui jalur alternatif Direct AB (AB on AB).');
    expect(mocStatus(AB, { ...passing, MOC_PERSISTENCY: { current: null, period: 'Belum diunggah' } }, ID)).toMatchObject({
      status: 'unknown',
      path: 'Perlu memenuhi ketiga kriteria standar sekaligus, atau mencapai 5 Direct ABs.',
      missing: 'Belum diunggah: Rolling Persistency — DU/DG.',
    });
    expect(mocStatus(AAB, { MOC_APE: i(RP(250_000_000)), MONTHLY2_AA: i(2), MOC_PERSISTENCY: i(80) }, ID).path)
      .toBe('Syarat AAB tidak memiliki jalur alternatif — ketiganya harus terpenuhi.');
    const custom: MocRule = {
      code: 'X', appliesToOrgLevelCodes: [], groupMode: 'all',
      criteriaGroups: [{ mode: 'all', criteria: Array.from({ length: 12 }, () => ({ metricKey: 'MOC_APE', comparator: 'gte', value: 1 })) }],
    };
    expect(mocStatus(custom, { MOC_APE: i(2) }, ID).path)
      .toBe('Syarat ini tidak memiliki jalur alternatif — semua 12 syarat harus terpenuhi.');
  });

  it('P18.10-T5 AC-4 the tooltip in the reader’s language: DAN and ATAU, and each threshold in their figures', () => {
    expect(mocRulesText([AAB, AB], ID)).toBe(
      'AAB: APE ≥ Rp 200 Jt DAN Monthly2 AA ≥ 2 DAN Rolling Persistency DU ≥ 75%.\n'
      + 'AB: (APE ≥ Rp 600 Jt DAN Monthly2 AA DU ≥ 4 / DG ≥ 6 DAN Rolling Persistency DU/DG ≥ 75%) ATAU Direct AB (AB on AB) ≥ 5.',
    );
    // A reader of English figures: *IDR 200M*, a decimal point — the English words with them.
    expect(mocRulesText([AAB], readerIn('en'))).toBe('AAB: APE ≥ IDR 200M AND Monthly2 AA ≥ 2 AND Rolling Persistency DU ≥ 75%.');
    const exact: MocRule = { ...AAB, criteriaGroups: [{ mode: 'all', criteria: [
      { metricKey: 'MOC_APE', comparator: 'gte', value: RP(250_550_000) },
      { metricKey: 'MOC_PERSISTENCY', comparator: 'gte', value: 75.55 },
    ] }] };
    expect(mocRulesText([exact], readerIn('en'))).toBe('AAB: APE ≥ IDR 250,550,000 AND Rolling Persistency DU ≥ 75.55%.');
  });

  describe('P19.3-T1 — APE is APE, and a stored NET_APE still reads (ADR-0201 §1)', () => {
    const legacy: MocRule = {
      ...AAB,
      criteriaGroups: [{ mode: 'all', criteria: [
        { metricKey: 'NET_APE', comparator: 'gte', value: RP(200_000_000) },
        { metricKey: 'MONTHLY2_AA', comparator: 'gte', value: 2 },
      ] }],
    };

    it('P19.3-T1 AC-5 the dialog and the tooltip say APE, never Net APE, in both languages', () => {
      expect(criterionLabel('MOC_APE', AB)).toBe('APE');
      const words = [mocRulesText([AAB, AB], EN), mocRulesText([AAB, AB], ID), mocRulesText([AAB, AB], readerIn('en'))].join('\n');
      expect(words).not.toMatch(/Net APE/);
      expect(mocStatus(AB, passing, EN).criteria.map((c) => c.label)).not.toContain('Net APE');
    });

    it('P19.3-T1 AC-5 a rule still naming NET_APE reads MOC_APE’s input, under APE and its code', () => {
      const moc = mocStatus(legacy, { MOC_APE: i(RP(250_000_000)), MONTHLY2_AA: i(3) }, EN);
      expect(moc.status).toBe('met');
      expect(moc.criteria[0]).toMatchObject({ code: 'MOC_APE', label: 'APE', current: RP(250_000_000), met: true });
      // Its threshold is still money in the tooltip, never a bare count of sen.
      expect(mocRulesText([legacy], EN)).toBe('AAB: APE ≥ Rp 200 Jt AND Monthly2 AA ≥ 2.');
      expect(criterionLabel('NET_APE', legacy)).toBe('APE');
    });

    it('P19.3-T1 AC-5 the seeded rules name MOC_APE', () => {
      for (const r of [AB, AAB]) expect(r.criteriaGroups[0].criteria[0].metricKey).toBe('MOC_APE');
    });
  });
});
