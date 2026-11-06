import {
  ANALYTICS, ANALYTICS_FIELD_READERS, ANALYTICS_MAA_INPUTS, ANALYTICS_SECTION_KODES, ANALYTICS_SYSTEM_KODES,
  ANALYTICS_SYSTEM_UNITS, DEMOGRAPHICS, NPS, QUAL, QUANT, SUBGROUP, SURVEY, SURVEY_ROLE_CLASSES, SURVEY_STATES,
} from './index';

/**
 * **§B.33 — the template's *Advanced analytics* section: its bounds and its defaults** (P19.5-T1; ADR-0214 §2, ADR-0215
 * §8, ADR-0216 §1). Every value pinned once, imported, never re-declared (invariant §7).
 */
describe('§B.33 Advanced analytics constants', () => {
  it('P19.5-T1 pins the upload rules’ bounds and defaults (ADR-0214 §2, §7)', () => {
    expect(ANALYTICS).toMatchObject({
      COMPLETE_PCT_DEFAULT: 90,
      COMPLETE_PCT_MIN: 50,
      COMPLETE_PCT_MAX: 100,
      YTD_TOLERANCE_PCT_DEFAULT: 1,
      YTD_TOLERANCE_PCT_MAX: 10,
      HISTORY_MONTHS_BEFORE_JOIN: 12,
      UPLOAD_FIELDS_MAX: 40,
      CODE_PATTERN_MAX_LENGTH: 200,
      CODE_MISMATCH_EXAMPLES: 5,
      LABEL_MAX_LENGTH: 60,
      TIP_MAX_LENGTH: 200,
      QUESTION_MAX_LENGTH: 300,
      ASPECT_MAX_LENGTH: 40,
    });
    expect(ANALYTICS.KODE_PATTERN.source).toBe('^[A-Z][A-Z0-9_]{0,39}$');
  });

  it('P19.5-T1 AC-5 pins the four system columns, their fixed units, and MAA’s fixed inputs (R1, decision 1(b))', () => {
    expect(ANALYTICS_SYSTEM_KODES).toEqual(['APE', 'POLICY_COUNT', 'RECRUITMENT', 'NEW_ACTIVE_AGENTS']);
    expect(ANALYTICS_SYSTEM_UNITS).toEqual({
      APE: 'rp_million', POLICY_COUNT: 'count', RECRUITMENT: 'count', NEW_ACTIVE_AGENTS: 'count',
    });
    expect(ANALYTICS_MAA_INPUTS).toEqual(['APE', 'POLICY_COUNT']);
  });

  it('P19.5-T1 AC-4 pins the six sections in the spec’s order', () => {
    expect(ANALYTICS_SECTION_KODES).toEqual(['DEMOGRAPHICS', 'MAPA', 'NPS', 'QUANT', 'QUAL', 'SUBGROUP']);
  });

  it('P19.5-T1 AC-10 names every system column’s readers, and the three custom kodes that predate the section', () => {
    expect(Object.keys(ANALYTICS_FIELD_READERS).sort()).toEqual(
      ['APE', 'FYP', 'NEW_ACTIVE_AGENTS', 'PERSISTENCY', 'POLICY_COUNT', 'RECRUITMENT', 'UNIT_PERSISTENCY'],
    );
    expect(ANALYTICS_FIELD_READERS.APE.map((r) => r.id)).toEqual(['MAPA', 'Kuantitatif D1', 'Sub-group', 'MAA aktif']);
    for (const kode of ANALYTICS_SYSTEM_KODES) expect(ANALYTICS_FIELD_READERS[kode].length).toBeGreaterThan(0);
  });

  it('P19.5-T1 AC-14 pins the thresholds’ defaults (ADR-0215 §8)', () => {
    expect(QUANT).toEqual({
      MIN_PEERS: 3, PEER_BAND_PCT_DEFAULT: 5, PEER_BAND_PCT_MAX: 50, DIFF_BAND_DEFAULT: 2,
      // P19.5-T3 (ADR-0215 §6; AA UI-023): the runs and the windows the ten metrics read.
      RUN_MONTHS: [6, 12], FREEZE_DAY: 15, GROWTH_MONTHS: 24, ROLLING_MONTHS: 12, ACTIVATION_MONTHS_AFTER_JOIN: 12,
    });
    expect(DEMOGRAPHICS).toEqual({ AGE_BAND_UPPER_DEFAULT: [29, 45], AGE_LABEL_FLOOR: 17, TENURE_BANDS_DEFAULT: [3, 7, 10] });
    expect(QUAL).toEqual({
      ISSUE_MAX_RATING_DEFAULT: 3, BIG_PCT_DEFAULT: 60, WATCH_PCT_DEFAULT: 40, SUPPORT_PROMOTER_MIN_DEFAULT: 9,
      SUPPORT_PASSIVE_MIN_DEFAULT: 7, COACHING_GOOD_PCT_DEFAULT: 70, MONTHS: [6, 12],
    });
    expect(SUBGROUP).toEqual({
      OK_PCT_DEFAULT: 80, POWER_USER_DAYS_DEFAULT: 10, POWER_USER_WINDOW_DAYS_DEFAULT: 30, WEEK_MULTIPLIER_DEFAULT: 2,
      HEAD_AA_TARGET_DEFAULT: 3, HEAD_REC_TARGET_DEFAULT: 6,
    });
  });

  it('P19.5-T1 AC-13 pins the NPS cadence, and adds no NPS cut-off of its own (§B.4’s)', () => {
    expect(SURVEY.NPS_CADENCE_DEFAULT).toBe('quarter');
    expect(NPS.PROMOTER_MIN).toBe(9);
    expect(NPS.DETRACTOR_MAX + 1).toBe(7);
  });

  it('P19.5-T4 pins the runs’, the form’s and the reminder’s fixed values (§B.33; ADR-0216 §3, §5, §6)', () => {
    expect(SURVEY).toEqual({
      NPS_CADENCE_DEFAULT: 'quarter',
      REMINDER_DAYS_BEFORE_CLOSE: 1,
      POPUPS_PER_DAY: 1,
      MIN_GROUP: 3,
      SECONDS_PER_QUESTION: 30,
      RATING_MAX: 5,
      TEXT_MAX_LENGTH: 1000,
    });
    expect(SURVEY_STATES).toEqual(['consistent', 'inconsistent', 'not_done']);
    expect(SURVEY_ROLE_CLASSES).toEqual(['agent', 'aab', 'ab']);
    // A score question reads §B.4's scale: no second 0-to-10 constant.
    expect([NPS.SCALE_MIN, NPS.SCALE_MAX]).toEqual([0, 10]);
  });
});
