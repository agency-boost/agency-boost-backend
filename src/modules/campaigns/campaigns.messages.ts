import { formatNumber } from '@/common/format/format';
import { readerIn } from '@/common/i18n/reader';
import { messages, refusals, render, type Sentence } from '@/common/i18n/sentence';
import { MDRT_TOOLTIP, type Language } from '@/domain/constants';

/** A count or a typed number in Indonesian: *1.000* from a thousand up, *1,5* with decimals (the glossary's §E). */
const idNumber = (n: number): string => formatNumber(n, undefined, 'id');

/** Where a requirement sits in a campaign: *Requirement 2* — *Syarat 2*. */
const requirementAt = (n: number) => ({ en: `Requirement ${n}`, id: `Syarat ${n}` });

/** Where a rule, a group of its criteria, or one criterion sits in a company's rule set. */
export interface RulePlace {
  rule: number;
  group?: number;
  criterion?: number;
}

/** *Rule 2, group 1, criterion 3* — *Aturan 2, grup 1, kriteria 3*. */
const ruleAt = ({ rule, group, criterion }: RulePlace) => {
  const at = (words: { rule: string; group: string; criterion: string }) => [
    `${words.rule} ${rule}`,
    ...(group === undefined ? [] : [`${words.group} ${group}`]),
    ...(criterion === undefined ? [] : [`${words.criterion} ${criterion}`]),
  ].join(', ');
  return {
    en: at({ rule: 'Rule', group: 'group', criterion: 'criterion' }),
    id: at({ rule: 'Aturan', group: 'grup', criterion: 'kriteria' }),
  };
};

/**
 * **The campaigns module's refusals, in both languages** (P18.10-T5 AC-2, AC-3): a campaign as the Owner writes it,
 * a company's rule set, the agent's chase and the override of a final result. *Campaign*, *MDRT* and a metric's name
 * stay as the glossary keeps them (§A.4, §A.6); a requirement is a *syarat*, an override a *koreksi manual* and a
 * standing a *hasil campaign* (the API's vocabulary). A field is named as the API names it — `endsAt`, `poster.color`.
 */
export const CAMPAIGNS_REFUSALS = refusals('modules/campaigns', {
  VALIDATION_FAILED: {
    /* ---- one campaign's fields (`campaign-input.ts`) ---- */
    reservedCode: ({ code }: { code: string }) => ({
      en: `${code} is a word the Campaigns pages use for themselves. Choose another code.`,
      id: `${code} sudah dipakai oleh halaman Campaigns sendiri. Pilih kode lain.`,
    }),
    endsAfterStarts: {
      en: 'endsAt must be after startsAt.',
      id: 'endsAt harus setelah startsAt.',
    },
    notADateTime: ({ field }: { field: string }) => ({
      en: `${field} is not a date and time.`,
      id: `${field} bukan tanggal dan waktu yang valid.`,
    }),
    posterNotObject: {
      en: 'poster must be an object with an emoji and a color.',
      id: 'poster harus berupa objek berisi emoji dan color.',
    },
    posterEmoji: {
      en: 'poster.emoji is one emoji.',
      id: 'poster.emoji harus berupa satu emoji.',
    },
    posterColor: ({ colors }: { colors: readonly string[] }) => ({
      en: `poster.color is one of ${colors.join(', ')}.`,
      id: `poster.color harus salah satu dari ${colors.join(', ')}.`,
    }),
    requirementsNotList: {
      en: 'requirements must be a list.',
      id: 'requirements harus berupa daftar.',
    },
    requirementNotObject: ({ n }: { n: number }) => ({
      en: `${requirementAt(n).en} must be an object of fields.`,
      id: `${requirementAt(n).id} harus berupa objek berisi kolom.`,
    }),
    metricTwice: ({ n, name }: { n: number; name: string }) => ({
      en: `${requirementAt(n).en}: ${name} is asked for already. A campaign asks for each figure once.`,
      id: `${requirementAt(n).id}: ${name} sudah diminta. Campaign meminta setiap angka satu kali saja.`,
    }),
    notAMetric: ({ n, key, keys }: { n: number; key: string; keys: readonly string[] }) => ({
      en: `${requirementAt(n).en}: "${key}" is not a metric this product measures. One of: ${keys.join(', ')}.`,
      id: `${requirementAt(n).id}: "${key}" bukan metrik yang diukur produk ini. Salah satu dari: ${keys.join(', ')}.`,
    }),
    countsTheOffice: ({ n, name }: { n: number; name: string }) => ({
      en: `${requirementAt(n).en}: ${name} counts the office, not anybody’s work, so a campaign cannot ask for it.`,
      id: `${requirementAt(n).id}: ${name} menghitung KPM, bukan hasil kerja seseorang, jadi campaign tidak dapat `
        + 'memintanya.',
    }),
    notMeasuredYet: ({ n, name }: { n: number; name: string }) => ({
      en: `${requirementAt(n).en}: ${name} is not measured yet, so a campaign asking for it could never qualify anybody.`,
      id: `${requirementAt(n).id}: ${name} belum diukur, jadi campaign yang memintanya tidak akan pernah membuat siapa `
        + 'pun memenuhi syarat.',
    }),
    notACampaignMetric: ({ n, name, names }: { n: number; name: string; names: readonly string[] }) => ({
      en: `${requirementAt(n).en}: ${name} is not something a campaign can measure. One of: ${names.join(', ')}.`,
      id: `${requirementAt(n).id}: ${name} bukan sesuatu yang dapat diukur campaign. Salah satu dari: ${names.join(', ')}.`,
    }),
    comparatorOneOf: ({ n, values }: { n: number; values: readonly string[] }) => ({
      en: `${requirementAt(n).en}: comparator is one of ${values.join(', ')}.`,
      id: `${requirementAt(n).id}: comparator harus salah satu dari ${values.join(', ')}.`,
    }),
    valueNotNumber: ({ n }: { n: number }) => ({
      en: `${requirementAt(n).en}: value must be a number.`,
      id: `${requirementAt(n).id}: value harus berupa angka.`,
    }),
    moneyWholeSen: ({ n, name, value }: { n: number; name: string; value: number }) => ({
      en: `${requirementAt(n).en}: ${name} is money, so it is whole sen — ${value} is not.`,
      id: `${requirementAt(n).id}: ${name} adalah uang, jadi nilainya harus sen bulat — ${idNumber(value)} bukan sen bulat.`,
    }),

    /* ---- a campaign across its fields (`checkCampaignShape`) ---- */
    seasonalNeedsEnd: {
      en: 'A seasonal campaign needs an end: endsAt is required.',
      id: 'Campaign musiman memerlukan waktu selesai: endsAt wajib diisi.',
    },
    seasonalWindow: {
      en: 'A seasonal campaign is read over its own dates: window is campaign_dates.',
      id: 'Campaign musiman dinilai berdasarkan tanggalnya sendiri: window harus campaign_dates.',
    },
    subtypeOnlyStructural: {
      en: 'Only a structural campaign has a subtype.',
      id: 'Hanya campaign struktural yang memiliki subtype.',
    },
    structuralSubtype: {
      en: 'A structural campaign is a promotion path or an ongoing incentive: subtype is required.',
      id: 'Campaign struktural adalah jalur promosi atau insentif berkelanjutan: subtype wajib diisi.',
    },
    structuralWindow: ({ windows }: { windows: readonly string[] }) => ({
      en: `A structural campaign is read over ${windows.join(' or ')}.`,
      id: `Campaign struktural dinilai berdasarkan ${windows.join(' atau ')}.`,
    }),
    wholeMonths: {
      en: 'A campaign asking for figures from the monthly production file runs in whole months: start it on the 1st '
        + 'and end it on the last day of a month.',
      id: 'Campaign yang meminta angka dari file produksi bulanan berjalan dalam bulan penuh: mulai pada tanggal 1 dan '
        + 'akhiri pada hari terakhir suatu bulan.',
    },
    notRungs: ({ codes }: { codes: readonly string[] }) => ({
      en: `${codes.join(', ')} ${codes.length === 1 ? 'is not a rung' : 'are not rungs'} of your company's ladder.`,
      id: `${codes.join(', ')} bukan jenjang di susunan jenjang perusahaan Anda.`,
    }),

    /* ---- the Owner's writes (`campaign.service.ts`) ---- */
    codeTaken: ({ code }: { code: string }) => ({
      en: `A campaign with the code ${code} already exists. Choose another code.`,
      id: `Campaign dengan kode ${code} sudah ada. Pilih kode lain.`,
    }),
    codeTakenField: ({ code }: { code: string }) => ({
      en: `A campaign with the code ${code} already exists.`,
      id: `Campaign dengan kode ${code} sudah ada.`,
    }),
    companyWide: {
      en: 'Company-wide campaigns are not available. Every campaign here is your own.',
      id: 'Campaign untuk seluruh perusahaan tidak tersedia. Setiap campaign di sini adalah milik KPM Anda sendiri.',
    },

    /* ---- the override of a final result (`campaign-standing-overrides.ts`) ---- */
    alreadyReads: ({ status }: { status: string }) => ({
      en: `The result already reads ${status}.`,
      id: `Hasil ini sudah bernilai ${status}.`,
    }),
    statusAlreadyReads: ({ status }: { status: string }) => ({
      en: `status already reads ${status}.`,
      id: `status sudah bernilai ${status}.`,
    }),

    /* ---- a company's rule set (`campaign-kinds-payload.ts`) ---- */
    rulesNotList: {
      en: 'rules must be a list.',
      id: 'rules harus berupa daftar.',
    },
    rulesEmpty: {
      en: 'A rule set with no rules leaves every office of this company with nothing to qualify for.',
      id: 'Kumpulan aturan tanpa satu aturan pun membuat setiap KPM di perusahaan ini tidak memiliki syarat apa pun '
        + 'untuk dipenuhi.',
    },
    notARuleKind: ({ at, kind, kinds }: { at: RulePlace; kind: string; kinds: readonly string[] }) => ({
      en: `${ruleAt(at).en}: ${kind || '(none)'} is not a rule kind. One of ${kinds.join(', ')}.`,
      id: `${ruleAt(at).id}: ${kind || '(tidak ada)'} bukan jenis aturan. Salah satu dari ${kinds.join(', ')}.`,
    }),
    ruleNoCode: ({ at }: { at: RulePlace }) => ({
      en: `${ruleAt(at).en} has no code. A standing row names the code, never the label.`,
      id: `${ruleAt(at).id} tidak memiliki kode. Baris hasil campaign menyebut kodenya, bukan labelnya.`,
    }),
    ruleCodeTwice: ({ code, kind }: { code: string; kind: string }) => ({
      en: `The code ${code} is used twice in ${kind}, so one rule would wear two names.`,
      id: `Kode ${code} dipakai dua kali di ${kind}, sehingga satu aturan akan memiliki dua nama.`,
    }),
    ruleNoName: ({ at }: { at: RulePlace }) => ({
      en: `${ruleAt(at).en} has no name, so it would render as a blank row.`,
      id: `${ruleAt(at).id} tidak memiliki nama, sehingga akan tampil sebagai baris kosong.`,
    }),
    ruleRank: ({ at }: { at: RulePlace }) => ({
      en: `${ruleAt(at).en} needs a rank of 1 or more — it is the order the tiers are climbed in.`,
      id: `${ruleAt(at).id} memerlukan peringkat 1 atau lebih — peringkat adalah urutan tingkat yang dinaiki.`,
    }),
    ruleRankShared: ({ kind, rank }: { kind: string; rank: number }) => ({
      en: `Two ${kind} rules share rank ${rank}, so which one is higher is undecidable.`,
      id: `Dua aturan ${kind} berada di peringkat ${idNumber(rank)}, jadi tidak dapat ditentukan mana yang lebih tinggi.`,
    }),
    ruleAsksNothing: ({ at }: { at: RulePlace }) => ({
      en: `${ruleAt(at).en} asks for nothing, so everybody qualifies for it the day it publishes.`,
      id: `${ruleAt(at).id} tidak meminta apa pun, sehingga semua orang memenuhi syaratnya pada hari aturan ini `
        + 'diterbitkan.',
    }),
    groupModeOneOf: ({ at, modes }: { at: RulePlace; modes: readonly string[] }) => ({
      en: `${ruleAt(at).en}: groupMode must be ${modes.join(' or ')}.`,
      id: `${ruleAt(at).id}: groupMode harus ${modes.join(' atau ')}.`,
    }),
    modeOneOf: ({ at, modes }: { at: RulePlace; modes: readonly string[] }) => ({
      en: `${ruleAt(at).en}: mode must be ${modes.join(' or ')}.`,
      id: `${ruleAt(at).id}: mode harus ${modes.join(' atau ')}.`,
    }),
    groupAsksNothing: ({ at }: { at: RulePlace }) => ({
      en: `${ruleAt(at).en} asks for nothing, so it passes for everybody.`,
      id: `${ruleAt(at).id} tidak meminta apa pun, sehingga semua orang lolos.`,
    }),
    criterionNoMetric: ({ at }: { at: RulePlace }) => ({
      en: `${ruleAt(at).en} names no metric.`,
      id: `${ruleAt(at).id} tidak menyebut metrik apa pun.`,
    }),
    criterionCountsTheOffice: ({ at, name }: { at: RulePlace; name: string }) => ({
      en: `${ruleAt(at).en}: ${name} counts the office, not anybody’s work, so a rule cannot ask for it.`,
      id: `${ruleAt(at).id}: ${name} menghitung KPM, bukan hasil kerja seseorang, jadi aturan tidak dapat memintanya.`,
    }),
    criterionComparator: ({ at, comparator, values }: { at: RulePlace; comparator: string; values: readonly string[] }) => ({
      en: `${ruleAt(at).en}: ${comparator} is not a comparator. One of ${values.join(', ')}.`,
      id: `${ruleAt(at).id}: ${comparator} bukan pembanding. Salah satu dari ${values.join(', ')}.`,
    }),
    criterionNoNumber: ({ at }: { at: RulePlace }) => ({
      en: `${ruleAt(at).en} has no number to compare against.`,
      id: `${ruleAt(at).id} tidak memiliki angka untuk dibandingkan.`,
    }),
  },
  CAMPAIGN_NOT_OPEN: {
    ended: {
      en: 'This campaign has ended, so it can no longer be chased or dropped.',
      id: 'Campaign ini sudah berakhir, jadi Anda tidak dapat lagi mulai atau berhenti mengejarnya.',
    },
  },
  CAMPAIGN_NOT_ELIGIBLE: {
    notYourRole: {
      en: 'This campaign is not open to your role.',
      id: 'Campaign ini tidak terbuka untuk peran Anda.',
    },
  },
  CAMPAIGN_OVERRIDE_SELF: {
    ownResult: {
      en: 'You can’t override your own result.',
      id: 'Anda tidak dapat mengoreksi hasil Anda sendiri.',
    },
  },
  CAMPAIGN_STANDING_NOT_FINAL: {
    notFinal: {
      en: 'This campaign’s result is not final yet. It can be overridden once the last month it reads has locked.',
      id: 'Hasil campaign ini belum final. Hasil ini dapat dikoreksi manual setelah bulan terakhir yang dibacanya dikunci.',
    },
  },
  VERSION_CONFLICT: {
    changedWhileCorrected: {
      en: 'This result changed while it was being corrected. Reload and try again.',
      id: 'Hasil ini berubah saat sedang dikoreksi. Muat ulang, lalu coba lagi.',
    },
  },
});

/** A requirement's noun and its target, the target a figure written in the reader's figures (`targetWords`). */
interface RequirementParts {
  noun: string;
  target: (figures: Language) => string;
}

/** The MDRT tooltip's two fixed sentences, in one language. */
const mdrt = (language: Language, figures: Language) => ({
  opening: render(MDRT_TOOLTIP.OPENING, { language, figures }),
  none: render(MDRT_TOOLTIP.NONE, { language, figures }),
});

/**
 * **What the campaigns screens print that the server composes, in both languages** (P18.10-T5 AC-4; P18.2-T7,
 * ADR-0142 §3): a requirement in words — *"APE of Rp 1,2 M or more"*, *"APE minimal Rp 1,2 M"* — and *Chasing
 * MDRT*'s header tooltip around them. The comparator is words (*minimal*, *maksimal*, *lebih dari*, *kurang dari*,
 * *tepat*); the metric's name is the registry's, kept (§A.4).
 */
export const CAMPAIGNS_MESSAGES = messages('modules/campaigns', {
  atLeast: ({ noun, target }: RequirementParts) => ({
    en: (figures) => `${noun} of ${target(figures)} or more`,
    id: `${noun} minimal ${target('id')}`,
  }),
  above: ({ noun, target }: RequirementParts) => ({
    en: (figures) => `${noun} above ${target(figures)}`,
    id: `${noun} lebih dari ${target('id')}`,
  }),
  atMost: ({ noun, target }: RequirementParts) => ({
    en: (figures) => `${noun} of ${target(figures)} or less`,
    id: `${noun} maksimal ${target('id')}`,
  }),
  below: ({ noun, target }: RequirementParts) => ({
    en: (figures) => `${noun} below ${target(figures)}`,
    id: `${noun} kurang dari ${target('id')}`,
  }),
  exactly: ({ noun, target }: RequirementParts) => ({
    en: (figures) => `${noun} of exactly ${target(figures)}`,
    id: `${noun} tepat ${target('id')}`,
  }),
  /** No MDRT campaign running: ADR-0142 §3's two sentences. */
  mdrtNoneRunning: {
    en: (figures) => `${mdrt('en', figures).opening}. ${mdrt('en', figures).none}`,
    id: () => `${mdrt('id', 'id').opening}. ${mdrt('id', 'id').none}`,
  },
  /** An MDRT campaign that asks for nothing: the opening alone. */
  mdrtAsksNothing: {
    en: (figures) => `${mdrt('en', figures).opening}.`,
    id: () => `${mdrt('id', 'id').opening}.`,
  },
  /** The opening, then each of its requirements in words, *and* between them. */
  mdrtAsks: ({ requirements }: { requirements: readonly Sentence[] }) => ({
    en: (figures) => `${mdrt('en', figures).opening} — `
      + `${requirements.map((r) => render(r, { language: 'en', figures })).join(' and ')}.`,
    id: `${mdrt('id', 'id').opening} — ${requirements.map((r) => render(r, readerIn('id'))).join(' dan ')}.`,
  }),
});
