import { HttpStatus } from '@nestjs/common';
import { DomainException } from '@/common/errors/domain.exception';
import { ErrorCode, type ErrorCodeValue } from '@/common/errors/error-codes';
import type { Sentence } from '@/common/i18n/sentence';
import type { FieldSentence } from '@/common/validation/fields';
import {
  ANALYTICS, ANALYTICS_MAA_INPUTS, ANALYTICS_SECTION_KODES, ANALYTICS_SYSTEM_KODES, ANALYTICS_SYSTEM_UNITS,
  DEMOGRAPHICS, NPS, QUAL, QUANT, SUBGROUP, SURVEY,
  type AnalyticsSectionKode, type AnalyticsSystemKode,
} from '@/domain/constants';
import { compileLinearPattern, type LinearPattern, type PatternProblem } from './linear-pattern';
import { ANALYTICS_TEMPLATE_REFUSALS } from './analytics-template.messages';

const SAY = ANALYTICS_TEMPLATE_REFUSALS.VALIDATION_FAILED;

/*
 * **The template's *Advanced analytics* section, as a payload** (P19.5-T1; ADR-0214 §2, ADR-0215 §8, ADR-0216 §1): its
 * type, version 1, the platform's default, the check a draft and a publish meet, and the rules a draft save keeps —
 * the system columns, the locks, the aliases a rename leaves and the archive a delete fills.
 *
 * **These are the types every reader after T1 relies on** — the Data upload (T2), the KPM's page (T3) and the surveys
 * (T4) read `AdvancedAnalyticsConfig` through `AnalyticsConfigReader.publishedFor` and nothing else.
 */

export type SectionKode = AnalyticsSectionKode;
export type SystemKode = AnalyticsSystemKode;
/** *Rp juta* (stored as minor units, invariant §9), *Persen 0–100*, or *Angka bulat*. */
export type UploadUnit = 'rp_million' | 'percent' | 'count';
/** *Dihitung dari jumlah bulan*, *Diunggah di CSV*, or *Tidak ada YTD*. */
export type YtdRule = 'sum' | 'upload' | 'none';

export interface LabelPair {
  id: string;
  en: string;
}

/** One column of the monthly Data upload (ADR-0214 §2). */
export interface UploadField {
  /** `ANALYTICS.KODE_PATTERN`, never ending `_YTD`; unique across `uploadFields` and `archivedFields`; never changed. */
  kode: string;
  /** `true` exactly for the four system kodes (R1). */
  system: boolean;
  /** `id` required; `en` may be empty, and the ID label stands in for it. */
  label: LabelPair;
  /** Earlier labels, ID and EN, kept by the server on a rename (AA UI-024). The editor never sends its own. */
  labelAliases: string[];
  unit: UploadUnit;
  ytd: YtdRule;
  min: number | null;
  max: number | null;
  /** Required from `effectiveFrom` on (R2). */
  required: boolean;
  /** `leaders`: filled on AB and AAB rows only (`UNIT_PERSISTENCY`, ADR-0201 §2). */
  rows: 'all' | 'leaders';
  /** `YYYY-MM`: months before it show *—* for the column and keep their status (R2). */
  effectiveFrom: string;
  tip: LabelPair;
}

export interface UploadRules {
  /** An anchored pattern, `^…$`, read by the linear engine (`linear-pattern.ts`). */
  agentCodePattern: string;
  /** *Contoh yang cocok*; must match the pattern. */
  agentCodeExample: string;
  unknownAgent: 'flag' | 'reject';
  /** Fixed at `ANALYTICS.HISTORY_MONTHS_BEFORE_JOIN` (R5). */
  historyMonthsBeforeJoin: number;
  /** `ANALYTICS.COMPLETE_PCT_MIN` to 100. */
  completePct: number;
  /** 0 to `ANALYTICS.YTD_TOLERANCE_PCT_MAX`; read only by `ytd: 'upload'` columns. */
  ytdTolerancePct: number;
}

export interface NpsQuestion {
  kode: string;
  text: LabelPair;
  aspect: string;
  /** The optional *Kenapa?*. */
  askWhy: boolean;
}

export interface NpsConfig {
  cadence: 'quarter' | 'half';
  /** *Ingatkan 1 hari sebelum berakhir* is always on and is not a setting (C-R10). */
  defaults: { anonymous: boolean; remindHalfway: boolean };
  promoterMin: number;
  /** Below `promoterMin`; a detractor is 0 to `passiveMin − 1`. */
  passiveMin: number;
  questions: NpsQuestion[];
  openQuestion: { kode: 'OPEN'; text: LabelPair };
}

export type QualQuestionType =
  | 'aspiration' | 'scale_items' | 'state_items' | 'unit_items' | 'downline_coaching' | 'support' | 'choice';

export interface QualQuestion {
  /** `Q4` … `Q12`, never reused. */
  kode: string;
  text: LabelPair;
  type: QualQuestionType;
  /**
   * What the question asks about, each by a kode never reused (P19.5-T4): Q4's four choices — `exclusive` for the two
   * chosen only alone (*"opsi 3 dan 4 hanya sendiri"*) — the 1-to-5 and state items of Q5 to Q9, and Q11's areas. A
   * question published without them, as version 1 was, is asked with the platform default's for its kode
   * (`qualItemsOf`), and the run's snapshot holds whichever it asked.
   */
  items?: QualItem[];
}

export interface QualItem {
  kode: string;
  label: LabelPair;
  exclusive?: boolean;
}

export interface QualBlock {
  kode: string;
  title: LabelPair;
  audience: 'all' | 'leader';
  questions: QualQuestion[];
}

export interface QualConfig {
  /** Fixed `[6, 12]` in this phase (OD-266 Q4). */
  months: number[];
  defaults: { anonymous: boolean; perPerson: boolean; remindHalfway: boolean };
  blocks: QualBlock[];
}

/** ADR-0215 §8: each a template value, its default `metrics-and-definitions.md` §B.33's. */
export interface AnalyticsThresholds {
  ageBandUpper: [number, number];
  tenureBands: [number, number, number];
  quantPeerBandPct: number;
  quantDiffBand: number;
  /** Fixed at `QUANT.MIN_PEERS` (R3). */
  quantMinPeers: number;
  qualIssueMaxRating: number;
  qualBigPct: number;
  qualWatchPct: number;
  supportPromMin: number;
  supportPasMin: number;
  coachingGoodPct: number;
  subgroupOkPct: number;
  powerUserDays: number;
  powerUserWindow: number;
  subgroupWeekMultiplier: number;
  subgroupHeadDefaults: { aa: number; rec: number };
}

/** The section's whole payload (ADR-0214 §2). */
export interface AdvancedAnalyticsConfig {
  /** The six, each once; their order is the KPM's tab order. */
  sections: { kode: SectionKode; enabled: boolean }[];
  /** Their order is the file's column order. */
  uploadFields: UploadField[];
  /** Deleted custom columns; their stored values are kept, and adding the kode again restores them (AT-13). */
  archivedFields: UploadField[];
  /** Fixed (decision 1(b)). */
  derived: { maaActiveIfAnyPositive: string[] };
  uploadRules: UploadRules;
  nps: NpsConfig;
  qualitative: QualConfig;
  thresholds: AnalyticsThresholds;
}

/** One field a draft got wrong, by its path in the payload, and what is wrong with it. */
export interface AnalyticsViolation {
  field: string;
  message: FieldSentence;
}

// ------------------------------------------------------------------------------------------------- version 1

/**
 * **Today's seven Data upload columns as kodes** — the cells of `monthlyAgentData` before T2 reshapes it, each to the
 * kode version 1 gives it (ADR-0214 §9). What the migration, the lock read and T2's row migration share.
 */
export const KODE_OF_CELL = {
  ape: 'APE',
  persistency: 'PERSISTENCY',
  recruitment: 'RECRUITMENT',
  newActiveAgents: 'NEW_ACTIVE_AGENTS',
  fyp: 'FYP',
  policyCount: 'POLICY_COUNT',
  unitPersistency: 'UNIT_PERSISTENCY',
} as const;

/** A label as every header this product issued wrote it: version 1's six and version 2's seventh. */
const ISSUED: Record<keyof typeof KODE_OF_CELL, { label: string; ytd: boolean }> = {
  ape: { label: 'APE (Rp M)', ytd: true },
  persistency: { label: 'Rolling Persistency (%)', ytd: true },
  recruitment: { label: 'Recruitment', ytd: true },
  newActiveAgents: { label: 'New Active Agents', ytd: true },
  fyp: { label: 'FYP (Rp M)', ytd: true },
  policyCount: { label: '# of Policy', ytd: true },
  unitPersistency: { label: 'Unit Persistency (%)', ytd: false },
};

/** A column's issued words: its file label, and the headers `TEMPLATE_HEADERS` 1 and 2 wrote for it. */
function issuedAliases(cell: keyof typeof KODE_OF_CELL): string[] {
  const { label, ytd } = ISSUED[cell];
  return [label, `${label} — This Month`, ...(ytd ? [`${label} — YTD`] : [])];
}

const field = (
  cell: keyof typeof KODE_OF_CELL, label: LabelPair, unit: UploadUnit, ytd: YtdRule, effectiveFrom: string,
  over: Partial<UploadField>,
): UploadField => {
  const kode = KODE_OF_CELL[cell];
  return {
    kode,
    system: (ANALYTICS_SYSTEM_KODES as readonly string[]).includes(kode),
    label,
    labelAliases: issuedAliases(cell),
    unit,
    ytd,
    min: 0,
    max: unit === 'percent' ? 100 : null,
    required: false,
    rows: 'all',
    effectiveFrom,
    tip: { id: '', en: '' },
    ...over,
  };
};

/**
 * **Version 1's seven columns** (ADR-0214 §9): today's upload, in the file's order, each `required: false` as today's
 * import requires nothing (ADR-0051), with the issued headers as aliases so no KPM's upload changes until a Super Admin
 * publishes. `effectiveFrom` is the earliest month a KPM on the template holds, or the month the migration ran.
 */
export function v1UploadFields(effectiveFrom: string): UploadField[] {
  return [
    field('ape', { id: 'APE', en: 'APE' }, 'rp_million', 'sum', effectiveFrom, {
      tip: { id: 'Annualised premium equivalent bulan ini.', en: 'This month\'s annualised premium equivalent.' },
    }),
    field('persistency', { id: 'Persistensi rolling', en: 'Rolling persistency' }, 'percent', 'none', effectiveFrom, {
      tip: { id: 'Sudah bergulir 12 bulan, jadi tidak ada YTD.', en: 'Already rolling over 12 months, so no YTD.' },
    }),
    field('recruitment', { id: 'Rekrutmen', en: 'Recruitment' }, 'count', 'sum', effectiveFrom, {
      tip: { id: 'Kode agen baru yang terdaftar bulan ini.', en: 'New agent codes registered this month.' },
    }),
    field('newActiveAgents', { id: 'Agen aktif baru', en: 'New active agents' }, 'count', 'sum', effectiveFrom, {
      tip: { id: 'Agen baru yang menutup polis pertama bulan ini.', en: 'New agents who closed their first policy this month.' },
    }),
    field('fyp', { id: 'FYP', en: 'FYP' }, 'rp_million', 'sum', effectiveFrom, {
      tip: { id: 'First year premium bulan ini.', en: 'This month\'s first year premium.' },
    }),
    field('policyCount', { id: 'Jumlah polis (case issued)', en: '# of policy (case issued)' }, 'count', 'sum', effectiveFrom, {
      tip: { id: 'Polis yang terbit bulan ini.', en: 'Policies issued this month.' },
    }),
    field('unitPersistency', { id: 'Unit persistency', en: 'Unit persistency' }, 'percent', 'none', effectiveFrom, {
      rows: 'leaders',
      tip: { id: 'Persistensi unit leader, hanya di baris AB dan AAB.', en: 'The leader\'s unit persistency, on AB and AAB rows only.' },
    }),
  ];
}

/**
 * **Version 1's agent-code pattern** (ADR-0214 §7, §9): the first of these that every code registered on the template's
 * KPMs already matches. The last matches any code of 1 to 64 characters, so there is always one.
 */
export const V1_PATTERN_CANDIDATES: readonly { pattern: string; example: string }[] = [
  { pattern: '^\\d{3,32}$', example: '80777' },
  { pattern: '^[A-Za-z0-9-]{1,32}$', example: 'KPM0417-001' },
  { pattern: '^.{1,64}$', example: 'KPM0417-001' },
];

/** The mockup's five score questions and its open one (ADR-0216 §1). */
function defaultNps(): NpsConfig {
  const q = (kode: string, id: string, en: string, aspect: string): NpsQuestion => ({
    kode, text: { id, en }, aspect, askWhy: true,
  });
  return {
    cadence: SURVEY.NPS_CADENCE_DEFAULT,
    defaults: { anonymous: true, remindHalfway: true },
    promoterMin: NPS.PROMOTER_MIN,
    passiveMin: NPS.DETRACTOR_MAX + 1,
    questions: [
      q('P1', 'Seberapa besar kemungkinan Anda merekomendasikan KPM ini kepada teman sebagai tempat berkarier?',
        'How likely are you to recommend this KPM to a friend as a place to build a career?', 'Keseluruhan'),
      q('P2', 'Seberapa jelas visi dan arah KPM ini bagi Anda?', 'How clear are this KPM\'s vision and direction to you?', 'Visi'),
      q('P3', 'Seberapa Anda merasa menjadi bagian dari komunitas di KPM ini?',
        'How much do you feel part of the community at this KPM?', 'Komunitas'),
      q('P4', 'Seberapa kompak tim dan leader Anda bekerja sama?', 'How well do your team and leaders work together?', 'Kekompakan'),
      q('P5', 'Seberapa membantu training dari KPM ini untuk pekerjaan Anda?', 'How useful is this KPM\'s training for your work?', 'Training'),
    ],
    openQuestion: {
      kode: 'OPEN',
      text: {
        id: 'Apa satu hal yang paling ingin Anda perbaiki di KPM ini?',
        en: 'What one thing would you most like this KPM to improve?',
      },
    },
  };
}

/** The mockup's eight blocks (ADR-0216 §1): `ABOUT` is never asked — the member list holds all three answers. */
function defaultQualitative(): QualConfig {
  const block = (
    kode: string, id: string, en: string, audience: 'all' | 'leader', questions: QualQuestion[],
  ): QualBlock => ({ kode, title: { id, en }, audience, questions });
  const question = (kode: string, type: QualQuestionType, id: string, en: string, items?: QualItem[]): QualQuestion => ({
    kode, type, text: { id, en }, ...(items ? { items } : {}),
  });
  const item = (kode: string, id: string, en: string, exclusive?: true): QualItem => ({
    kode, label: { id, en }, ...(exclusive ? { exclusive } : {}),
  });
  // The coaching mockup's items (`coaching-survey-results-2026-11-02.html`), each by a kode of its own.
  const unitItems = [
    item('ACTIVATION', 'Aktivasi agen baru secara sengaja', 'Deliberate activation of new agents'),
    item('GOALS', 'Pemantauan goal agen', 'Following agents\' goals'),
    item('LEADS', 'Manajemen leads agen', 'Managing agents\' leads'),
    item('ACTIVITY', 'Pemantauan aktivitas', 'Following activity'),
    item('ONE_ON_ONE', 'Coaching 1-on-1', '1-on-1 coaching'),
    item('ROLEPLAY', 'Sales roleplay', 'Sales roleplay'),
    item('JFW', 'Joint field work', 'Joint field work'),
    item('UNIT_MEETING', 'Unit meeting', 'Unit meeting'),
  ];
  return {
    months: [...QUAL.MONTHS],
    defaults: { anonymous: false, perPerson: true, remindHalfway: true },
    blocks: [
      block('ABOUT', 'Tentang Anda', 'About you', 'all', [
        question('Q1', 'choice', 'Waktu kerja', 'Working time'),
        question('Q2', 'choice', 'Masa kerja', 'Tenure'),
        question('Q3', 'choice', 'Usia', 'Age'),
      ]),
      block('ASPIRATION', 'Aspirasi', 'Aspiration', 'all', [
        question('Q4', 'aspiration', 'Apa yang ingin Anda capai di {perusahaan} dalam 12 bulan ke depan?',
          'What do you want to achieve at {perusahaan} in the next 12 months?', [
            item('TOP', 'Saya ingin menjadi top producer', 'I want to be a top producer'),
            item('TEAM', 'Saya ingin menjadi team builder yang produktif', 'I want to be a productive team builder'),
            item('FLOW', 'Saya ingin menjalani saja dan mengikuti alurnya', 'I want to go along and follow the flow', true),
            item('WEIGH', 'Saya masih mempertimbangkan karier saya di industri asuransi',
              'I am still weighing my career in insurance', true),
          ]),
      ]),
      block('SALES', 'A. Penjualan', 'A. Sales', 'all', [
        question('Q5', 'scale_items', 'Seberapa yakin Anda dengan setiap bagian penjualan ini?',
          'How confident are you in each part of selling?', [
            item('FREQUENCY', 'Frekuensi penjualan', 'Sales frequency'),
            item('ACTIVITY', 'Activity management', 'Activity management'),
            item('PIPELINE', 'Leads pipeline', 'Leads pipeline'),
            item('APPOINTMENT', 'Penjadwalan janji temu', 'Booking appointments'),
            item('FACT_FINDING', 'Fact-finding & identifikasi kebutuhan', 'Fact-finding and needs analysis'),
            item('PRESENTATION', 'Presentasi selling', 'Sales presentation'),
            item('PRODUCT', 'Pengetahuan produk', 'Product knowledge'),
          ]),
      ]),
      block('RECRUIT', 'B. Rekrutmen', 'B. Recruitment', 'leader', [
        question('Q6', 'scale_items', 'Seberapa yakin Anda dengan setiap bagian rekrutmen ini?',
          'How confident are you in each part of recruiting?', [
            item('FREQUENCY', 'Frekuensi rekrut', 'Recruiting frequency'),
            item('ACTIVITY', 'Activity management', 'Activity management'),
            item('PIPELINE', 'Leads pipeline', 'Leads pipeline'),
            item('FILTERING', 'Filtering kandidat berkualitas', 'Filtering quality candidates'),
            item('APPOINTMENT', 'Penjadwalan janji temu', 'Booking appointments'),
            item('HOT_BUTTON', 'Mendapatkan hot button atau keraguan', 'Finding the hot button or the doubt'),
            item('PITCH', 'Pitch rekrutmen', 'Recruitment pitch'),
            item('LICENSING', 'Proses aplikasi & lisensi', 'Application and licensing'),
          ]),
      ]),
      block('ACTIVATION', 'C. Aktivasi', 'C. Activation', 'leader', [
        question('Q7', 'state_items', 'Bagaimana Anda menjalankan setiap langkah aktivasi?',
          'How do you carry out each activation step?', [
            item('COMPANY_TRAINING', 'Pelatihan perusahaan', 'Company training'),
            item('KPM_TRAINING', 'Pelatihan KPM', 'KPM training'),
            item('KPM_INTRO', 'Pengenalan KPM', 'KPM introduction'),
            item('GOAL_SETTING', 'Goal-setting', 'Goal-setting'),
            item('LEADS_LIST', 'Penyusunan daftar leads / prospek', 'Building the leads / prospect list'),
            item('JFW', 'Joint field work', 'Joint field work'),
            item('ROLEPLAY', 'Coaching penjualan & roleplay', 'Sales coaching and roleplay'),
          ]),
      ]),
      block('UNIT', 'D. Manajemen unit', 'D. Unit management', 'leader', [
        question('Q8', 'state_items', 'Seberapa konsisten Anda menjalankan rutinitas unit?',
          'How consistently do you run your unit\'s routines?', unitItems),
        question('Q9', 'unit_items', 'Seberapa puas Anda dengan setiap bagian manajemen unit?',
          'How satisfied are you with each part of unit management?', unitItems.map((i) => ({ ...i }))),
      ]),
      block('COACHING', 'Coaching downline', 'Coaching downline', 'leader', [
        question('Q10', 'downline_coaching', 'Apakah Anda masih melakukan coaching ke downline Anda?',
          'Do you still coach your downline?'),
        question('Q11', 'downline_coaching', 'Di area mana coaching Anda paling banyak?',
          'Which areas does your coaching cover most?', [
            item('SALES', 'Penjualan', 'Sales'),
            item('RECRUIT', 'Rekrutmen', 'Recruitment'),
            item('ACTIVATION', 'Aktivasi', 'Activation'),
            item('UNIT', 'Manajemen unit', 'Unit management'),
          ]),
      ]),
      block('SUPPORT', 'Dukungan leader', 'Leader support', 'all', [
        question('Q12', 'support', 'Seberapa puas Anda dengan dukungan leader Anda? (rahasia)',
          'How satisfied are you with your leader\'s support? (confidential)'),
      ]),
    ],
  };
}

function defaultThresholds(): AnalyticsThresholds {
  return {
    ageBandUpper: [...DEMOGRAPHICS.AGE_BAND_UPPER_DEFAULT] as [number, number],
    tenureBands: [...DEMOGRAPHICS.TENURE_BANDS_DEFAULT] as [number, number, number],
    quantPeerBandPct: QUANT.PEER_BAND_PCT_DEFAULT,
    quantDiffBand: QUANT.DIFF_BAND_DEFAULT,
    quantMinPeers: QUANT.MIN_PEERS,
    qualIssueMaxRating: QUAL.ISSUE_MAX_RATING_DEFAULT,
    qualBigPct: QUAL.BIG_PCT_DEFAULT,
    qualWatchPct: QUAL.WATCH_PCT_DEFAULT,
    supportPromMin: QUAL.SUPPORT_PROMOTER_MIN_DEFAULT,
    supportPasMin: QUAL.SUPPORT_PASSIVE_MIN_DEFAULT,
    coachingGoodPct: QUAL.COACHING_GOOD_PCT_DEFAULT,
    subgroupOkPct: SUBGROUP.OK_PCT_DEFAULT,
    powerUserDays: SUBGROUP.POWER_USER_DAYS_DEFAULT,
    powerUserWindow: SUBGROUP.POWER_USER_WINDOW_DAYS_DEFAULT,
    subgroupWeekMultiplier: SUBGROUP.WEEK_MULTIPLIER_DEFAULT,
    subgroupHeadDefaults: { aa: SUBGROUP.HEAD_AA_TARGET_DEFAULT, rec: SUBGROUP.HEAD_REC_TARGET_DEFAULT },
  };
}

/**
 * **A whole configuration from today's columns** (ADR-0214 §9): what migration `advanced-analytics-v1` publishes as
 * version 1 of every template, and — with the first candidate pattern — the platform's default (§3), which a template
 * made later starts from. Each call is a fresh copy.
 */
export function analyticsConfigV1(
  { effectiveFrom, agentCodePattern = V1_PATTERN_CANDIDATES[0].pattern, agentCodeExample = V1_PATTERN_CANDIDATES[0].example }:
  { effectiveFrom: string; agentCodePattern?: string; agentCodeExample?: string },
): AdvancedAnalyticsConfig {
  return {
    sections: ANALYTICS_SECTION_KODES.map((kode) => ({ kode, enabled: true })),
    uploadFields: v1UploadFields(effectiveFrom),
    archivedFields: [],
    derived: { maaActiveIfAnyPositive: [...ANALYTICS_MAA_INPUTS] },
    uploadRules: {
      agentCodePattern,
      agentCodeExample,
      unknownAgent: 'reject',
      historyMonthsBeforeJoin: ANALYTICS.HISTORY_MONTHS_BEFORE_JOIN,
      completePct: ANALYTICS.COMPLETE_PCT_DEFAULT,
      ytdTolerancePct: ANALYTICS.YTD_TOLERANCE_PCT_DEFAULT,
    },
    nps: defaultNps(),
    qualitative: defaultQualitative(),
    thresholds: defaultThresholds(),
  };
}

/**
 * **The month the platform default's columns start from** (ADR-0214 §3): the spec's seed month. A KPM reading the
 * platform default has every column in force for every month it can hold, as today.
 */
export const PLATFORM_DEFAULT_EFFECTIVE_FROM = '2024-01';

/** **The platform's own configuration** (ADR-0214 §3): version 1 with the first pattern, `^\d{3,32}$`. */
export function platformAnalyticsConfig(): AdvancedAnalyticsConfig {
  return analyticsConfigV1({ effectiveFrom: PLATFORM_DEFAULT_EFFECTIVE_FROM });
}

/**
 * **A qualitative question's items, as it is asked** (P19.5-T4; ADR-0216 §1): its own, or — for a question published
 * without any, as every version 1 the migration wrote was — the platform default's for the same kode. `[]` for a kode
 * the default does not know. What a run's snapshot stores, so a run asks the same items to its end (R6).
 */
export function qualItemsOf(question: Pick<QualQuestion, 'kode' | 'items'>): QualItem[] {
  if (question.items && question.items.length > 0) return question.items.map((i) => ({ ...i, label: { ...i.label } }));
  const fallback = defaultQualitative().blocks.flatMap((b) => b.questions).find((q) => q.kode === question.kode);
  return (fallback?.items ?? []).map((i) => ({ ...i, label: { ...i.label } }));
}

/**
 * **The Prudential seed** (spec §3; OD-266 Q3): version 1 with Prudential's eight-digit codes, unregistered codes kept
 * and flagged, and the mockup's required flags — offered as a **draft**, published once its pattern test passes.
 */
export function prudentialSeedDraft(base: AdvancedAnalyticsConfig): AdvancedAnalyticsConfig {
  const copy = structuredClone(base);
  const required = new Set(['APE', 'PERSISTENCY', 'RECRUITMENT', 'NEW_ACTIVE_AGENTS', 'POLICY_COUNT']);
  copy.uploadFields = copy.uploadFields.map((f) => ({ ...f, required: required.has(f.kode) }));
  copy.uploadRules = { ...copy.uploadRules, agentCodePattern: '^[0-9]{8}$', agentCodeExample: '70012345', unknownAgent: 'flag' };
  return copy;
}

// --------------------------------------------------------------------------------------------- the pattern

const PATTERN_SAYS: Record<PatternProblem, FieldSentence> = {
  too_long: SAY.patternTooLong({ max: ANALYTICS.CODE_PATTERN_MAX_LENGTH }),
  not_anchored: SAY.patternNotAnchored,
  backreference: SAY.patternBackreference,
  lookaround: SAY.patternLookaround,
  unsupported: SAY.patternUnsupported,
  syntax: SAY.patternSyntax,
  too_large: SAY.patternTooLarge,
};

/** **The pattern compiled, or the sentence that refuses it** (ADR-0214 §7). */
export function agentCodePattern(source: unknown): { pattern: LinearPattern } | { refusal: FieldSentence } {
  const compiled = compileLinearPattern(typeof source === 'string' ? source : '', ANALYTICS.CODE_PATTERN_MAX_LENGTH);
  return compiled.ok ? { pattern: compiled.pattern } : { refusal: PATTERN_SAYS[compiled.problem] };
}

/** How many of `codes` the pattern refuses, and the first examples (AA UI-018: up to five). */
export function codeCheck(pattern: LinearPattern, codes: readonly string[]): {
  mismatched: number; total: number; examples: string[];
} {
  const bad = codes.filter((code) => !pattern.test(code));
  return { mismatched: bad.length, total: codes.length, examples: bad.slice(0, ANALYTICS.CODE_MISMATCH_EXAMPLES) };
}

// ------------------------------------------------------------------------------------------- the payload check

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => v !== null && typeof v === 'object' && !Array.isArray(v);
const MONTH = /^\d{4}-(0[1-9]|1[0-2])$/;
const QUESTION_KODE = /^[A-Z][A-Z0-9_]{0,19}$/;
const UNITS: readonly UploadUnit[] = ['rp_million', 'percent', 'count'];
const YTDS: readonly YtdRule[] = ['sum', 'upload', 'none'];
const QUAL_TYPES: readonly QualQuestionType[] = [
  'aspiration', 'scale_items', 'state_items', 'unit_items', 'downline_coaching', 'support', 'choice',
];

const TOP_KEYS = ['sections', 'uploadFields', 'archivedFields', 'derived', 'uploadRules', 'nps', 'qualitative', 'thresholds'];
const FIELD_KEYS = [
  'kode', 'system', 'label', 'labelAliases', 'unit', 'ytd', 'min', 'max', 'required', 'rows', 'effectiveFrom', 'tip',
];

/**
 * **Everything that breaks the payload's type** (ADR-0214 §2): each violation named by its field, collected before
 * anything is refused, so three mistakes are heard about together. `[]` for a payload the section can hold. The 409s —
 * the system columns, the locks and a kode taken — are `normaliseAnalyticsDraft`'s, which needs the version KPMs read.
 */
export function analyticsViolations(raw: unknown): AnalyticsViolation[] {
  const out: AnalyticsViolation[] = [];
  const fail = (at: string, message: FieldSentence) => out.push({ field: at, message });
  if (!isObj(raw)) {
    fail('payload', SAY.notAnObject);
    return out;
  }
  for (const key of Object.keys(raw)) if (!TOP_KEYS.includes(key)) fail(key, SAY.notPartOf({ key }));

  const bool = (v: unknown, at: string) => { if (typeof v !== 'boolean') fail(at, SAY.yesOrNo); };
  const whole = (v: unknown, at: string, min: number, max: number) => {
    if (typeof v !== 'number' || !Number.isInteger(v) || v < min || v > max) fail(at, SAY.wholeBetween({ min, max }));
  };
  const num = (v: unknown, at: string, min: number, max: number) => {
    if (typeof v !== 'number' || !Number.isFinite(v) || v < min || v > max) fail(at, SAY.numberBetween({ min, max }));
  };
  const text = (v: unknown, at: string, max: number, required: boolean, missing: FieldSentence = SAY.labelRequired) => {
    if (typeof v !== 'string') {
      fail(at, missing);
      return;
    }
    if (required && v.trim() === '') fail(at, missing);
    else if (v.length > max) fail(at, SAY.textTooLong({ max }));
  };
  const pair = (v: unknown, at: string, max: number, idRequired: boolean) => {
    if (!isObj(v)) {
      fail(at, SAY.notAnObject);
      return;
    }
    text(v.id, `${at}.id`, max, idRequired);
    text(v.en ?? '', `${at}.en`, max, false);
  };
  const oneOf = <T extends string>(v: unknown, at: string, values: readonly T[]) => {
    if (typeof v !== 'string' || !values.includes(v as T)) fail(at, SAY.oneOf({ values }));
  };

  // The six sections, each once, in any order.
  const sections = raw.sections;
  if (!Array.isArray(sections)) fail('sections', SAY.notAList);
  else {
    const kodes = sections.map((s) => (isObj(s) ? s.kode : null));
    const whole6 = kodes.length === ANALYTICS_SECTION_KODES.length
      && ANALYTICS_SECTION_KODES.every((k) => kodes.filter((x) => x === k).length === 1);
    if (!whole6) fail('sections', SAY.sections);
    sections.forEach((s, i) => { if (isObj(s)) bool(s.enabled, `sections.${i}.enabled`); });
  }

  // The columns, current and archived.
  const columns = (list: unknown, name: 'uploadFields' | 'archivedFields') => {
    if (!Array.isArray(list)) {
      fail(name, SAY.notAList);
      return;
    }
    if (name === 'uploadFields' && list.length > ANALYTICS.UPLOAD_FIELDS_MAX) {
      fail(name, SAY.tooManyFields({ max: ANALYTICS.UPLOAD_FIELDS_MAX }));
    }
    list.forEach((f, i) => {
      const at = `${name}.${i}`;
      if (!isObj(f)) {
        fail(at, SAY.notAnObject);
        return;
      }
      for (const key of Object.keys(f)) if (!FIELD_KEYS.includes(key)) fail(`${at}.${key}`, SAY.notPartOf({ key }));
      if (typeof f.kode !== 'string' || f.kode === '') fail(`${at}.kode`, SAY.kodeRequired);
      else if (!ANALYTICS.KODE_PATTERN.test(f.kode) || f.kode.endsWith('_YTD')) fail(`${at}.kode`, SAY.kodeShape);
      bool(f.system, `${at}.system`);
      pair(f.label, `${at}.label`, ANALYTICS.LABEL_MAX_LENGTH, true);
      if (!Array.isArray(f.labelAliases) || f.labelAliases.some((a) => typeof a !== 'string')) {
        fail(`${at}.labelAliases`, SAY.notAList);
      }
      oneOf(f.unit, `${at}.unit`, UNITS);
      oneOf(f.ytd, `${at}.ytd`, YTDS);
      for (const bound of ['min', 'max'] as const) {
        const v = f[bound];
        if (v !== null && (typeof v !== 'number' || !Number.isFinite(v))) fail(`${at}.${bound}`, SAY.number);
        else if (f.unit === 'percent' && typeof v === 'number' && (v < 0 || v > 100)) fail(`${at}.${bound}`, SAY.percentBounds);
      }
      if (typeof f.min === 'number' && typeof f.max === 'number' && f.min > f.max) fail(`${at}.min`, SAY.minAboveMax);
      bool(f.required, `${at}.required`);
      oneOf(f.rows, `${at}.rows`, ['all', 'leaders'] as const);
      if (typeof f.effectiveFrom !== 'string' || !MONTH.test(f.effectiveFrom)) fail(`${at}.effectiveFrom`, SAY.month);
      pair(f.tip, `${at}.tip`, ANALYTICS.TIP_MAX_LENGTH, false);
    });
  };
  columns(raw.uploadFields, 'uploadFields');
  columns(raw.archivedFields, 'archivedFields');

  // MAA's inputs, fixed (decision 1(b)).
  const derived = raw.derived;
  const maa = isObj(derived) ? derived.maaActiveIfAnyPositive : undefined;
  const fixed = Array.isArray(maa) && maa.length === ANALYTICS_MAA_INPUTS.length
    && ANALYTICS_MAA_INPUTS.every((k, i) => maa[i] === k)
    && Object.keys(derived as Obj).length === 1;
  if (!fixed) fail('derived.maaActiveIfAnyPositive', SAY.maaFixed);

  // The upload's rules.
  const rules = raw.uploadRules;
  if (!isObj(rules)) fail('uploadRules', SAY.notAnObject);
  else {
    const compiled = agentCodePattern(rules.agentCodePattern);
    if ('refusal' in compiled) fail('uploadRules.agentCodePattern', compiled.refusal);
    if (typeof rules.agentCodeExample !== 'string' || rules.agentCodeExample === '') {
      fail('uploadRules.agentCodeExample', SAY.exampleMismatch);
    } else if ('pattern' in compiled && !compiled.pattern.test(rules.agentCodeExample)) {
      fail('uploadRules.agentCodeExample', SAY.exampleMismatch);
    }
    oneOf(rules.unknownAgent, 'uploadRules.unknownAgent', ['flag', 'reject'] as const);
    if (rules.historyMonthsBeforeJoin !== ANALYTICS.HISTORY_MONTHS_BEFORE_JOIN) {
      fail('uploadRules.historyMonthsBeforeJoin', SAY.fixed({ value: String(ANALYTICS.HISTORY_MONTHS_BEFORE_JOIN) }));
    }
    whole(rules.completePct, 'uploadRules.completePct', ANALYTICS.COMPLETE_PCT_MIN, ANALYTICS.COMPLETE_PCT_MAX);
    num(rules.ytdTolerancePct, 'uploadRules.ytdTolerancePct', 0, ANALYTICS.YTD_TOLERANCE_PCT_MAX);
  }

  // The NPS survey's template half (ADR-0216 §1).
  const nps = raw.nps;
  if (!isObj(nps)) fail('nps', SAY.notAnObject);
  else {
    oneOf(nps.cadence, 'nps.cadence', ['quarter', 'half'] as const);
    if (!isObj(nps.defaults)) fail('nps.defaults', SAY.notAnObject);
    else {
      bool(nps.defaults.anonymous, 'nps.defaults.anonymous');
      bool(nps.defaults.remindHalfway, 'nps.defaults.remindHalfway');
    }
    whole(nps.promoterMin, 'nps.promoterMin', 1, 10);
    whole(nps.passiveMin, 'nps.passiveMin', 0, 9);
    if (typeof nps.promoterMin === 'number' && typeof nps.passiveMin === 'number' && nps.passiveMin >= nps.promoterMin) {
      fail('nps.passiveMin', SAY.passiveBelowPromoter);
    }
    const questions = nps.questions;
    if (!Array.isArray(questions)) fail('nps.questions', SAY.notAList);
    else {
      if (questions.length === 0) fail('nps.questions', SAY.atLeastOneQuestion);
      const seen = new Set<string>();
      questions.forEach((q, i) => {
        const at = `nps.questions.${i}`;
        if (!isObj(q)) {
          fail(at, SAY.notAnObject);
          return;
        }
        if (typeof q.kode !== 'string' || !QUESTION_KODE.test(q.kode) || q.kode === 'OPEN') fail(`${at}.kode`, SAY.kodeShape);
        else if (seen.has(q.kode)) fail(`${at}.kode`, SAY.questionKodeTaken({ kode: q.kode }));
        else seen.add(q.kode);
        pair(q.text, `${at}.text`, ANALYTICS.QUESTION_MAX_LENGTH, true);
        text(q.aspect, `${at}.aspect`, ANALYTICS.ASPECT_MAX_LENGTH, true);
        bool(q.askWhy, `${at}.askWhy`);
      });
    }
    const open = nps.openQuestion;
    if (!isObj(open) || open.kode !== 'OPEN') fail('nps.openQuestion', SAY.notAnObject);
    else pair(open.text, 'nps.openQuestion.text', ANALYTICS.QUESTION_MAX_LENGTH, true);
  }

  // The qualitative survey's template half.
  const qual = raw.qualitative;
  if (!isObj(qual)) fail('qualitative', SAY.notAnObject);
  else {
    const months = qual.months;
    if (!Array.isArray(months) || months.length !== QUAL.MONTHS.length || QUAL.MONTHS.some((m, i) => months[i] !== m)) {
      fail('qualitative.months', SAY.fixed({ value: QUAL.MONTHS.join(', ') }));
    }
    if (!isObj(qual.defaults)) fail('qualitative.defaults', SAY.notAnObject);
    else {
      for (const k of ['anonymous', 'perPerson', 'remindHalfway']) bool(qual.defaults[k], `qualitative.defaults.${k}`);
    }
    const blocks = qual.blocks;
    if (!Array.isArray(blocks)) fail('qualitative.blocks', SAY.notAList);
    else {
      const seen = new Set<string>();
      blocks.forEach((b, i) => {
        const at = `qualitative.blocks.${i}`;
        if (!isObj(b)) {
          fail(at, SAY.notAnObject);
          return;
        }
        if (typeof b.kode !== 'string' || !ANALYTICS.KODE_PATTERN.test(b.kode)) fail(`${at}.kode`, SAY.kodeShape);
        pair(b.title, `${at}.title`, ANALYTICS.LABEL_MAX_LENGTH, true);
        oneOf(b.audience, `${at}.audience`, ['all', 'leader'] as const);
        if (!Array.isArray(b.questions)) {
          fail(`${at}.questions`, SAY.notAList);
          return;
        }
        b.questions.forEach((q: unknown, j: number) => {
          const qat = `${at}.questions.${j}`;
          if (!isObj(q)) {
            fail(qat, SAY.notAnObject);
            return;
          }
          if (typeof q.kode !== 'string' || !QUESTION_KODE.test(q.kode)) fail(`${qat}.kode`, SAY.kodeShape);
          else if (seen.has(q.kode)) fail(`${qat}.kode`, SAY.questionKodeTaken({ kode: q.kode }));
          else seen.add(q.kode);
          pair(q.text, `${qat}.text`, ANALYTICS.QUESTION_MAX_LENGTH, true);
          oneOf(q.type, `${qat}.type`, QUAL_TYPES);
          // P19.5-T4: the items a question asks, each by its own kode, once.
          if (q.items !== undefined) {
            if (!Array.isArray(q.items)) fail(`${qat}.items`, SAY.notAList);
            else {
              const itemKodes = new Set<string>();
              q.items.forEach((it: unknown, k: number) => {
                const iat = `${qat}.items.${k}`;
                if (!isObj(it)) {
                  fail(iat, SAY.notAnObject);
                  return;
                }
                if (typeof it.kode !== 'string' || !QUESTION_KODE.test(it.kode) || itemKodes.has(it.kode)) {
                  fail(`${iat}.kode`, SAY.kodeShape);
                } else itemKodes.add(it.kode);
                pair(it.label, `${iat}.label`, ANALYTICS.LABEL_MAX_LENGTH, true);
                if (it.exclusive !== undefined) bool(it.exclusive, `${iat}.exclusive`);
              });
            }
          }
        });
      });
    }
  }

  // The thresholds (ADR-0215 §8).
  const t = raw.thresholds;
  if (!isObj(t)) fail('thresholds', SAY.notAnObject);
  else {
    const ascending = (v: unknown, at: string, n: number, min: number, max: number) => {
      if (!Array.isArray(v) || v.length !== n || v.some((x) => typeof x !== 'number' || !Number.isInteger(x) || x < min || x > max)) {
        fail(at, SAY.wholeBetween({ min, max }));
      } else if (v.some((x, i) => i > 0 && x <= v[i - 1])) fail(at, SAY.ascending);
    };
    ascending(t.ageBandUpper, 'thresholds.ageBandUpper', 2, DEMOGRAPHICS.AGE_LABEL_FLOOR + 1, 99);
    ascending(t.tenureBands, 'thresholds.tenureBands', 3, 1, 60);
    num(t.quantPeerBandPct, 'thresholds.quantPeerBandPct', 0, QUANT.PEER_BAND_PCT_MAX);
    whole(t.quantDiffBand, 'thresholds.quantDiffBand', 0, 1000);
    if (t.quantMinPeers !== QUANT.MIN_PEERS) fail('thresholds.quantMinPeers', SAY.fixed({ value: String(QUANT.MIN_PEERS) }));
    whole(t.qualIssueMaxRating, 'thresholds.qualIssueMaxRating', 1, 4);
    whole(t.qualBigPct, 'thresholds.qualBigPct', 0, 100);
    whole(t.qualWatchPct, 'thresholds.qualWatchPct', 0, 100);
    if (typeof t.qualBigPct === 'number' && typeof t.qualWatchPct === 'number' && t.qualWatchPct >= t.qualBigPct) {
      fail('thresholds.qualWatchPct', SAY.watchBelowBig);
    }
    whole(t.supportPromMin, 'thresholds.supportPromMin', 1, 10);
    whole(t.supportPasMin, 'thresholds.supportPasMin', 0, 9);
    if (typeof t.supportPromMin === 'number' && typeof t.supportPasMin === 'number' && t.supportPasMin >= t.supportPromMin) {
      fail('thresholds.supportPasMin', SAY.supportPassiveBelow);
    }
    whole(t.coachingGoodPct, 'thresholds.coachingGoodPct', 0, 100);
    whole(t.subgroupOkPct, 'thresholds.subgroupOkPct', 0, 100);
    whole(t.powerUserWindow, 'thresholds.powerUserWindow', 1, 90);
    whole(t.powerUserDays, 'thresholds.powerUserDays', 1, 90);
    if (typeof t.powerUserDays === 'number' && typeof t.powerUserWindow === 'number' && t.powerUserDays > t.powerUserWindow) {
      fail('thresholds.powerUserDays', SAY.powerUserDays);
    }
    num(t.subgroupWeekMultiplier, 'thresholds.subgroupWeekMultiplier', 1, 100);
    if (!isObj(t.subgroupHeadDefaults)) fail('thresholds.subgroupHeadDefaults', SAY.notAnObject);
    else {
      whole(t.subgroupHeadDefaults.aa, 'thresholds.subgroupHeadDefaults.aa', 0, 1000);
      whole(t.subgroupHeadDefaults.rec, 'thresholds.subgroupHeadDefaults.rec', 0, 1000);
    }
  }
  return out;
}

/** `400 VALIDATION_FAILED`, every violation in `details.violations` beside its field. */
export function refuseAnalyticsViolations(violations: readonly AnalyticsViolation[]): void {
  if (violations.length === 0) return;
  throw new DomainException(
    ErrorCode.VALIDATION_FAILED, SAY.cannotSave({ n: violations.length }), HttpStatus.BAD_REQUEST,
    { violations: [...violations] },
  );
}

// ------------------------------------------------------------------------------------------ the draft's rules

const isSystem = (kode: string): kode is SystemKode => (ANALYTICS_SYSTEM_KODES as readonly string[]).includes(kode);
const fold = (s: string) => s.trim().replace(/\s+/g, ' ').toLocaleLowerCase('id');

/**
 * **The labels a column answers to besides its own** (ADR-0214 §2; AA UI-024): every alias it had, kept, and the labels
 * of `before` this one replaces — deduplicated and case-folded. A replaced label that is one of its current labels is
 * not added: the column already answers to it.
 */
function aliasesAfter(before: UploadField | undefined, after: UploadField): string[] {
  const own = new Set([after.label.id, after.label.en].filter(Boolean).map(fold));
  const out: string[] = [];
  const seen = new Set<string>();
  const add = (label: string, replaced: boolean) => {
    const key = fold(label);
    if (!key || seen.has(key) || (replaced && own.has(key))) return;
    seen.add(key);
    out.push(label.trim());
  };
  for (const alias of before?.labelAliases ?? []) add(alias, false);
  if (before) {
    add(before.label.id, true);
    add(before.label.en, true);
  }
  return out;
}

/** A `409` naming its column. */
function conflict<C extends ErrorCodeValue>(code: C, sentence: Sentence<C>, details: Record<string, unknown>): DomainException<C> {
  return new DomainException(code, sentence, HttpStatus.CONFLICT, details);
}

/**
 * **A draft as it is saved, with the section's rules kept** (ADR-0214 §2), against `previous` — the version the KPMs
 * read now (the newest published, or the platform default) — and the kodes some KPM on the template holds a value
 * for. Refuses, `409`, naming the column:
 *
 * - `ANALYTICS_SYSTEM_COLUMN`: a system column missing, marked otherwise, another kode marked system, or a system
 *   column's unit or YTD changed (R1);
 * - `ANALYTICS_KODE_TAKEN`: two current columns with one kode;
 * - `ANALYTICS_UNIT_LOCKED`, `ANALYTICS_EFFECTIVE_FROM_LOCKED`: the unit or the start month of a kode with data
 *   changed (AA UI-017).
 *
 * And keeps, without asking:
 *
 * - **a rename's old labels**, as aliases (AA UI-024) — the editor's own `labelAliases` are never trusted;
 * - **a column dropped from the list**, in `archivedFields` (*Don't change*: archived, never erased);
 * - **an archived column added again**, out of `archivedFields` (AT-13).
 *
 * Answers the payload to store. The payload has passed `analyticsViolations` first.
 */
export function normaliseAnalyticsDraft(
  draft: AdvancedAnalyticsConfig,
  previous: AdvancedAnalyticsConfig,
  kodesWithData: ReadonlySet<string>,
): AdvancedAnalyticsConfig {
  const before = new Map<string, UploadField>();
  for (const f of previous.archivedFields ?? []) before.set(f.kode, f);
  for (const f of previous.uploadFields ?? []) before.set(f.kode, f);

  // Two current columns with one kode.
  const seen = new Set<string>();
  draft.uploadFields.forEach((f, i) => {
    if (seen.has(f.kode)) {
      throw conflict(ErrorCode.ANALYTICS_KODE_TAKEN, ANALYTICS_TEMPLATE_REFUSALS.ANALYTICS_KODE_TAKEN.taken({ kode: f.kode }), {
        field: `uploadFields.${i}.kode`, kode: f.kode,
      });
    }
    seen.add(f.kode);
  });

  // The four system columns: present, marked, their unit and YTD fixed — and no other kode marked system.
  for (const kode of ANALYTICS_SYSTEM_KODES) {
    const i = draft.uploadFields.findIndex((f) => f.kode === kode);
    if (i < 0) {
      throw conflict(ErrorCode.ANALYTICS_SYSTEM_COLUMN, ANALYTICS_TEMPLATE_REFUSALS.ANALYTICS_SYSTEM_COLUMN.missing({ kode }), {
        field: 'uploadFields', kode,
      });
    }
    const f = draft.uploadFields[i];
    if (!f.system) {
      throw conflict(ErrorCode.ANALYTICS_SYSTEM_COLUMN, ANALYTICS_TEMPLATE_REFUSALS.ANALYTICS_SYSTEM_COLUMN.notSystem({ kode }), {
        field: `uploadFields.${i}.system`, kode,
      });
    }
    if (f.unit !== ANALYTICS_SYSTEM_UNITS[kode] || f.ytd !== 'sum') {
      throw conflict(ErrorCode.ANALYTICS_SYSTEM_COLUMN, ANALYTICS_TEMPLATE_REFUSALS.ANALYTICS_SYSTEM_COLUMN.fixed({ kode }), {
        field: `uploadFields.${i}.${f.unit !== ANALYTICS_SYSTEM_UNITS[kode] ? 'unit' : 'ytd'}`, kode,
      });
    }
  }
  [...draft.uploadFields, ...draft.archivedFields].forEach((f) => {
    if (f.system && !isSystem(f.kode)) {
      throw conflict(ErrorCode.ANALYTICS_SYSTEM_COLUMN, ANALYTICS_TEMPLATE_REFUSALS.ANALYTICS_SYSTEM_COLUMN.onlyFour({ kode: f.kode }), {
        field: 'uploadFields', kode: f.kode,
      });
    }
  });

  // The locks: a kode some KPM holds data for keeps its unit and its start month.
  draft.uploadFields.forEach((f, i) => {
    const was = before.get(f.kode);
    if (!was || !kodesWithData.has(f.kode)) return;
    if (was.unit !== f.unit) {
      throw conflict(ErrorCode.ANALYTICS_UNIT_LOCKED, ANALYTICS_TEMPLATE_REFUSALS.ANALYTICS_UNIT_LOCKED.locked({ kode: f.kode }), {
        field: `uploadFields.${i}.unit`, kode: f.kode,
      });
    }
    if (was.effectiveFrom !== f.effectiveFrom) {
      throw conflict(
        'ANALYTICS_EFFECTIVE_FROM_LOCKED',
        ANALYTICS_TEMPLATE_REFUSALS.ANALYTICS_EFFECTIVE_FROM_LOCKED.locked({ kode: f.kode }),
        { field: `uploadFields.${i}.effectiveFrom`, kode: f.kode },
      );
    }
  });

  // The current columns, each answering to the labels it had; the archive, never losing a kode.
  const uploadFields = draft.uploadFields.map((f) => ({
    ...f,
    label: { id: f.label.id.trim(), en: (f.label.en ?? '').trim() },
    labelAliases: aliasesAfter(before.get(f.kode), f),
    min: f.unit === 'percent' && f.min === null ? 0 : f.min,
  }));
  const current = new Set(uploadFields.map((f) => f.kode));
  const archived = new Map<string, UploadField>();
  for (const f of [...previous.archivedFields ?? [], ...previous.uploadFields ?? [], ...draft.archivedFields]) {
    if (current.has(f.kode)) continue;
    // A column the draft archived keeps the labels it was published under.
    const was = before.get(f.kode);
    archived.set(f.kode, was ? { ...f, labelAliases: aliasesAfter(was, f) } : f);
  }
  return { ...draft, uploadFields, archivedFields: [...archived.values()] };
}

/** The columns of `next` that `previous` did not have current: *Baru · mulai <bulan>*, and what the notice names. */
export function newColumns(previous: AdvancedAnalyticsConfig | null, next: AdvancedAnalyticsConfig): UploadField[] {
  const had = new Set((previous?.uploadFields ?? []).map((f) => f.kode));
  return next.uploadFields.filter((f) => !had.has(f.kode));
}

/**
 * **Whether a publish changes what a KPM uploads** (ADR-0214 §4): its columns, its archive or its upload rules. A publish
 * that changes only the sections, the surveys or the thresholds tells nobody.
 */
export function uploadChanged(previous: AdvancedAnalyticsConfig | null, next: AdvancedAnalyticsConfig): boolean {
  if (!previous) return true;
  const shape = (c: AdvancedAnalyticsConfig) => stable([c.uploadFields, c.archivedFields, c.uploadRules]);
  return shape(previous) !== shape(next);
}

/** A value's JSON with every object's keys sorted: two payloads equal whatever order a store kept their keys in. */
function stable(value: unknown): string {
  const norm = (v: unknown): unknown => {
    if (Array.isArray(v)) return v.map(norm);
    if (v && typeof v === 'object') {
      return Object.fromEntries(Object.keys(v as Obj).sort().map((k) => [k, norm((v as Obj)[k])]));
    }
    return v;
  };
  return JSON.stringify(norm(value));
}
