/**
 * **The template's *Advanced analytics* section: its bounds and its defaults** (P19.5-T1; ADR-0214 §2, ADR-0215 §8,
 * ADR-0216 §1; `metrics-and-definitions.md` §B.33).
 *
 * Two kinds of value live here:
 *
 * - **Fixed** — a bound the draft is checked against (`UPLOAD_FIELDS_MAX`, `CODE_PATTERN_MAX_LENGTH`, …), the same for
 *   every template;
 * - **Template, the default** (`…_DEFAULT`) — what version 1 of every template and the platform's own configuration
 *   hold, and what the editor starts a new value from. Every KPM reads its template's own value, live (ADR-0214 §3);
 *   nothing here is what a KPM computes with once its template says otherwise.
 *
 * Each is held once, here, pinned by `advanced-analytics.spec.ts`, and served to the editor by the API — the frontend
 * never re-declares one (invariant §7). The NPS cut-off defaults add no constant: they are `NPS` (§B.4).
 */
export const ANALYTICS = {
  /** % of the KPM's members filled in every column in force for a month to be complete (`UPLOAD_MONTH_COMPLETE`). */
  COMPLETE_PCT_DEFAULT: 90,
  /** The lowest `completePct` a template may set (the mockup's *Bulan dianggap lengkap jika terisi*). */
  COMPLETE_PCT_MIN: 50,
  COMPLETE_PCT_MAX: 100,
  /** % of the month's YTD a `ytd: 'upload'` column's check allows. */
  YTD_TOLERANCE_PCT_DEFAULT: 1,
  YTD_TOLERANCE_PCT_MAX: 10,
  /** The months before the KPM's first month that it must upload (R5). Fixed: the editor shows it read-only. */
  HISTORY_MONTHS_BEFORE_JOIN: 12,
  /** The columns a template's Data upload may hold. */
  UPLOAD_FIELDS_MAX: 40,
  /** Characters of `agentCodePattern`. */
  CODE_PATTERN_MAX_LENGTH: 200,
  /** Example codes a refused publish, and the editor's live count, name. */
  CODE_MISMATCH_EXAMPLES: 5,
  /** A column's name, in either language. */
  LABEL_MAX_LENGTH: 60,
  /** A column's *Petunjuk di template CSV*, in either language. */
  TIP_MAX_LENGTH: 200,
  /** A survey question's text, in either language. */
  QUESTION_MAX_LENGTH: 300,
  /** A score question's *Aspek*. */
  ASPECT_MAX_LENGTH: 40,
  /** A kode: a capital first, then capitals, digits and `_`, 40 at most, never ending `_YTD` (ADR-0214 §2). */
  KODE_PATTERN: /^[A-Z][A-Z0-9_]{0,39}$/,
} as const;

/** The four columns every analytic reads, and only them (R1). Renamed, never deleted; their unit and YTD fixed. */
export const ANALYTICS_SYSTEM_KODES = ['APE', 'POLICY_COUNT', 'RECRUITMENT', 'NEW_ACTIVE_AGENTS'] as const;
export type AnalyticsSystemKode = (typeof ANALYTICS_SYSTEM_KODES)[number];

/** A system column's unit, fixed (R1): *Rp juta* for APE, a whole number for the other three. */
export const ANALYTICS_SYSTEM_UNITS: Readonly<Record<AnalyticsSystemKode, 'rp_million' | 'count'>> = {
  APE: 'rp_million',
  POLICY_COUNT: 'count',
  RECRUITMENT: 'count',
  NEW_ACTIVE_AGENTS: 'count',
};

/**
 * **`MAA_ACTIVE`'s inputs, fixed** (ADR-0214 §6, decision 1(b)): an agent is active in a month when APE or a policy is
 * above zero — `MONTHLY_ACTIVE_AGENT` (ADR-0054), one definition everywhere (invariant §8). The template stores and
 * serves it, and the editor draws it read-only.
 */
export const ANALYTICS_MAA_INPUTS = ['APE', 'POLICY_COUNT'] as const;

/** The six sections a KPM's *Advanced analytics* page may show, in the spec's order — version 1's tab order. */
export const ANALYTICS_SECTION_KODES = ['DEMOGRAPHICS', 'MAPA', 'NPS', 'QUANT', 'QUAL', 'SUBGROUP'] as const;
export type AnalyticsSectionKode = (typeof ANALYTICS_SECTION_KODES)[number];

/** A reader's name, in both languages, as *Dipakai di* draws it. */
export interface FieldReader {
  readonly id: string;
  readonly en: string;
}

/**
 * ***Dipakai di*: every reader of each kode, one static map** (ADR-0214 §6; spec §3). The four system columns' readers
 * are the template mockup's tags. Three custom kodes have readers that predate the section — `PERSISTENCY`
 * (`ROLLING_PERSISTENCY` and the campaigns' persistency requirement), `FYP` (a campaign that reads it) and
 * `UNIT_PERSISTENCY` (`MOC_PERSISTENCY` and the Unit comparison) — and data honesty names them. Any other kode reads
 * *Belum dipakai*.
 */
export const ANALYTICS_FIELD_READERS: Readonly<Record<string, readonly FieldReader[]>> = {
  APE: [
    { id: 'MAPA', en: 'MAPA' },
    { id: 'Kuantitatif D1', en: 'Quantitative D1' },
    { id: 'Sub-group', en: 'Sub-group' },
    { id: 'MAA aktif', en: 'MAA active' },
  ],
  POLICY_COUNT: [
    { id: 'MAPA', en: 'MAPA' },
    { id: 'Kuantitatif C2, D1', en: 'Quantitative C2, D1' },
    { id: 'MAA aktif', en: 'MAA active' },
  ],
  RECRUITMENT: [
    { id: 'MAPA', en: 'MAPA' },
    { id: 'Kuantitatif A1', en: 'Quantitative A1' },
    { id: 'Sub-group', en: 'Sub-group' },
  ],
  NEW_ACTIVE_AGENTS: [{ id: 'Kuantitatif B1–B2', en: 'Quantitative B1–B2' }],
  PERSISTENCY: [
    { id: 'Persistensi rolling', en: 'Rolling persistency' },
    { id: 'Campaign', en: 'Campaigns' },
  ],
  FYP: [{ id: 'Campaign', en: 'Campaigns' }],
  UNIT_PERSISTENCY: [
    { id: 'MOC', en: 'MOC' },
    { id: 'Perbandingan unit', en: 'Unit comparison' },
  ],
};

/** Quantitative analytics: what the template's *Ambang & benchmark* holds of it (ADR-0215 §5, §8). */
export const QUANT = {
  /** The peer KPMs a median needs, the KPM itself not counted (R3). Fixed: shown *3 KPM*. */
  MIN_PEERS: 3,
  /** % of the median either side that is *in line*. Colour only. */
  PEER_BAND_PCT_DEFAULT: 5,
  PEER_BAND_PCT_MAX: 50,
  /** Agents either side, for A2. Colour only. */
  DIFF_BAND_DEFAULT: 2,
  /**
   * *Written by P19.5-T3 (ADR-0215 §6; AA UI-023).* The months a run's period ends in: June (January to June) and
   * December (January to December). Fixed.
   */
  RUN_MONTHS: [6, 12] as readonly [number, number],
  /** The day of the month after a run's period it last recalculates; it freezes at 00:00 on the next day. Fixed. */
  FREEZE_DAY: 15,
  /** A2: the months its two years read, ending at the run's last month — all held, or *Belum cukup data*. Fixed. */
  GROWTH_MONTHS: 24,
  /** A2's later year, C3's window and B3's tenure: the rolling months, ending at the run's last month. Fixed. */
  ROLLING_MONTHS: 12,
  /** B2: the calendar months after the join month a first policy still activates a new agent. Fixed. */
  ACTIVATION_MONTHS_AFTER_JOIN: 12,
} as const;

/** *Written by P19.5-T3 (ADR-0215 §6):* the ten Quant metrics, A1 to D1, in the data sources' order. */
export const QUANT_METRICS = [
  { code: 'A1', metric: 'QUANT_RECRUITS_PER_LEADER' },
  { code: 'A2', metric: 'QUANT_ANNUAL_ACTIVE_NET_GROWTH' },
  { code: 'A3', metric: 'QUANT_ACTIVE_PER_LEADER' },
  { code: 'B1', metric: 'NEW_AGENT_ACTIVATION_3M_PCT' },
  { code: 'B2', metric: 'QUANT_ACTIVATION_12M_PCT' },
  { code: 'B3', metric: 'QUANT_TENURED_ACTIVE_PCT' },
  { code: 'C1', metric: 'QUANT_AVG_MAA_PER_LEADER' },
  { code: 'C2', metric: 'CASES_PER_PRODUCING_AGENT' },
  { code: 'C3', metric: 'QUANT_AVG_ACTIVE_MONTHS' },
  { code: 'D1', metric: 'AVERAGE_CASE_SIZE_REALISED' },
] as const;
export type QuantMetric = (typeof QUANT_METRICS)[number]['metric'];
export type QuantCode = (typeof QUANT_METRICS)[number]['code'];

/**
 * *Written by P19.5-T3 (ADR-0215 §1):* each section's address on the KPM's page, `/kpm/advanced-analytics/<slug>`, and
 * *Event*'s, which no template switches off. The slug is the page's; the kode is the template's (invariant §3).
 */
export const ANALYTICS_SECTION_SLUGS: Readonly<Record<AnalyticsSectionKode | 'EVENTS', string>> = {
  DEMOGRAPHICS: 'demographics',
  MAPA: 'mapa',
  NPS: 'nps',
  QUANT: 'quant',
  QUAL: 'qual',
  SUBGROUP: 'subgroup',
  EVENTS: 'events',
};

/** Demographics' bands (ADR-0215 §3, §8). */
export const DEMOGRAPHICS = {
  /** Years: the top of *Gen Z* and of *Gen Y*. */
  AGE_BAND_UPPER_DEFAULT: [29, 45] as readonly [number, number],
  /** Years, the *17* of *Gen Z 17–29*: a label only, never a bound anything is counted by. */
  AGE_LABEL_FLOOR: 17,
  /** Years from joining the KPM. */
  TENURE_BANDS_DEFAULT: [3, 7, 10] as readonly [number, number, number],
} as const;

/** Qualitative analytics' cut-offs and colours (ADR-0216 §1, §4). */
export const QUAL = {
  /** The highest 1-to-5 rating that is an issue. Snapshotted per run. */
  ISSUE_MAX_RATING_DEFAULT: 3,
  /** % of respondents with an issue: *Masalah besar*. Colour only. */
  BIG_PCT_DEFAULT: 60,
  /** % of respondents with an issue: *Perlu perhatian*; below `BIG_PCT`. Colour only. */
  WATCH_PCT_DEFAULT: 40,
  /** Q12, 0 to 10: *puas*. Snapshotted per run. */
  SUPPORT_PROMOTER_MIN_DEFAULT: 9,
  /** Q12: *cukup*; below `SUPPORT_PROMOTER_MIN`. Snapshotted per run. */
  SUPPORT_PASSIVE_MIN_DEFAULT: 7,
  /** % of leader respondents still coaching their downline: *baik*. Colour only. */
  COACHING_GOOD_PCT_DEFAULT: 70,
  /** The months a qualitative run opens and closes in (OD-266 Q4). Fixed in this phase. */
  MONTHS: [6, 12] as readonly [number, number],
} as const;

/** Sub-group improvements (ADR-0215 §7, §8). */
export const SUBGROUP = {
  /** % of a target met: green. Colour only. */
  OK_PCT_DEFAULT: 80,
  /** Days logged in the window: a power user. */
  POWER_USER_DAYS_DEFAULT: 10,
  /** The window, in days. */
  POWER_USER_WINDOW_DAYS_DEFAULT: 30,
  /** × the AA target: the weekly activity target. */
  WEEK_MULTIPLIER_DEFAULT: 2,
  /** A head of group's AA target until the KPM sets one. */
  HEAD_AA_TARGET_DEFAULT: 3,
  /** A head of group's recruitment target until the KPM sets one. */
  HEAD_REC_TARGET_DEFAULT: 6,
} as const;

/**
 * The surveys (ADR-0216 §1 the template's half; §2 to §6 the runs, the form and the reminder — P19.5-T4). Each fixed
 * value is `metrics-and-definitions.md` §B.33's.
 */
export const SURVEY = {
  /** How often an NPS run may be held. */
  NPS_CADENCE_DEFAULT: 'quarter' as 'quarter' | 'half',
  /** Days before `closesOn` the red *Berakhir besok* popup is due — always (C-R3, C-R10). */
  REMINDER_DAYS_BEFORE_CLOSE: 1,
  /** Popups a person sees in one KPM day, whatever the device (C-R3, C-R4). */
  POPUPS_PER_DAY: 1,
  /** Respondents a breakdown cell needs before it is shown; fewer read `null` (ADR-0216 §3, PDP). */
  MIN_GROUP: 3,
  /** The *±m menit* estimate: seconds a question takes (the reminder mockup's *6 pertanyaan · ±3 menit*). */
  SECONDS_PER_QUESTION: 30,
  /** A 1-to-5 item's top. A score question and *Dukungan leader* run `NPS.SCALE_MIN` to `NPS.SCALE_MAX` (§B.4). */
  RATING_MAX: 5,
  /** Characters of a free-text answer: *Kenapa?*, the open question, Q4's note, Q12's reason. */
  TEXT_MAX_LENGTH: 1000,
} as const;

/** How a respondent runs a step (Q7, Q8): *Konsisten · Tidak konsisten · Tidak dilakukan*. Only the first is no issue. */
export const SURVEY_STATES = ['consistent', 'inconsistent', 'not_done'] as const;
export type SurveyState = (typeof SURVEY_STATES)[number];

/** The role classes a run may invite (ADR-0156 §3; ADR-0216 §2). */
export const SURVEY_ROLE_CLASSES = ['agent', 'aab', 'ab'] as const;
export type SurveyRoleClass = (typeof SURVEY_ROLE_CLASSES)[number];
