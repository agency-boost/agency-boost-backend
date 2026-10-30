import { formatNumber } from '@/common/format/format';
import { readerIn } from '@/common/i18n/reader';
import { messages, refusals, render, type Sentence } from '@/common/i18n/sentence';
import {
  RECRUITMENT_CANDIDATE_TYPES, RECRUITMENT_HESITATIONS, RECRUITMENT_MOTIVATIONS, RECRUITMENT_PITCH_SLOTS,
  type RecruitmentHesitationCode, type RecruitmentMotivationCode, type RecruitmentPitchSlotCode,
  type RecruitmentTypeCode,
} from '@/domain/constants';

/** A bound in Indonesian: *1.000* from a thousand up (the glossary's §E). */
const idNumber = (n: number): string => formatNumber(n, undefined, 'id');

/**
 * **The recruitment module's refusals, in both languages** (P18.98-T5 AC-2, AC-3): a plan's brief, read from its
 * address; the pitch materials' checklists; and a company's playbook, refused field by field. *Recruitment*,
 * *Playbook* and *Pitch* stay as the glossary keeps them (§A.6); *brief* is the loanword Indonesian offices use. A
 * parameter or a field is named as the API names it — `motivation`, `body.profiles.retiree.tagline` — in both.
 */
export const RECRUITMENT_REFUSALS = refusals('modules/recruitment', {
  VALIDATION_FAILED: {
    /* ---- a plan's brief (`recruitment-plan.ts`) ---- */
    briefIncomplete: ({ missing }: { missing: readonly string[] }) => ({
      en: `A brief needs a candidate type, a motivation and a hesitation; ${missing.join(' and ')} missing.`,
      id: `Brief memerlukan jenis kandidat, motivasi, dan keraguan; ${missing.join(' dan ')} belum diisi.`,
    }),
    notACandidateType: ({ type }: { type: string }) => ({
      en: `"${type}" is not a candidate type.`,
      id: `"${type}" bukan jenis kandidat.`,
    }),
    notOneOfAnswers: ({ parameter }: { parameter: string }) => ({
      en: `${parameter} holds a code that is not one of its answers, or none at all.`,
      id: `${parameter} berisi kode yang bukan salah satu jawabannya, atau tidak berisi kode sama sekali.`,
    }),
    answerTwice: ({ parameter }: { parameter: string }) => ({
      en: `${parameter} names one answer twice.`,
      id: `${parameter} menyebut satu jawaban dua kali.`,
    }),

    /*
     * ---- the pitch materials (`recruitment-pitch.service.ts`) ----
     * A slot's title is the platform's (`RECRUITMENT_MESSAGES`, below), written in the refusal's own language — until
     * P18.98-T7 it was the registry's English in both.
     */
    noSuchItem: ({ title, item }: { title: Sentence; item: string }) => ({
      en: (figures) => `${render(title, { language: 'en', figures })} has no item "${item}" to confirm.`,
      id: `${render(title, readerIn('id'))} tidak memiliki item "${item}" untuk dikonfirmasi.`,
    }),
    noFileYet: ({ title }: { title: Sentence }) => ({
      en: (figures) => `${render(title, { language: 'en', figures })} has no file yet: upload one before confirming `
        + 'what it includes.',
      id: `${render(title, readerIn('id'))} belum memiliki file: unggah file dulu sebelum mengonfirmasi isinya.`,
    }),

    /* ---- a playbook, field by field (`recruitment-playbook-input.ts`): what follows the field's path ---- */
    notAnObject: {
      en: 'Must be an object of fields.',
      id: 'Harus berupa objek berisi kolom.',
    },
    notPartOfPlaybook: {
      en: 'Is not part of a recruitment playbook.',
      id: 'Bukan bagian dari playbook recruitment.',
    },
    empty: {
      en: 'Must not be empty.',
      id: 'Tidak boleh kosong.',
    },
    tooLong: ({ max }: { max: number }) => ({
      en: `Must be ${max} characters or fewer.`,
      id: `Paling banyak ${idNumber(max)} karakter.`,
    }),
    missing: {
      en: 'Is missing: every one must be answered.',
      id: 'Belum diisi: semuanya wajib dijawab.',
    },
    notAList: {
      en: 'Must be a list.',
      id: 'Harus berupa daftar.',
    },
    benefitsCount: ({ min, max }: { min: number; max: number }) => ({
      en: `Must hold ${min} to ${max} benefits.`,
      id: `Harus berisi ${idNumber(min)} sampai ${idNumber(max)} manfaat.`,
    }),
    /** The refusal's own message: every violation, its field's path then its sentence, in the reader's language. */
    cannotSave: ({ violations }: { violations: readonly { field: string; message: Sentence }[] }) => ({
      en: (figures) => `This playbook cannot be saved: ${violations
        .map((v) => `${v.field} — ${render(v.message, { language: 'en', figures })}`).join('; ')}`,
      id: `Playbook ini tidak dapat disimpan: ${violations
        .map((v) => `${v.field} — ${render(v.message, readerIn('id'))}`).join('; ')}`,
    }),
  },
});

/** A slot's English, read from the registry so the two cannot drift. */
const SLOT = (code: RecruitmentPitchSlotCode) => RECRUITMENT_PITCH_SLOTS.find((s) => s.code === code)!;
/** *Opportunity Overview*'s checklist item's English, the same way. */
const ITEM = (code: string) => SLOT('opportunity').checklist.find((i) => i.code === code)!.label;
/** A chip's English, the same way. */
const CHIP = (vocabulary: readonly { code: string; label: string }[], code: string) =>
  vocabulary.find((c) => c.code === code)!.label;

/**
 * **The recruitment module's own words, in both languages** (P18.98-T7; ADR-0179 §7): what the API serves of the
 * registry (`domain/constants/recruitment.ts`) — the six pitch slots' titles and lines, *Opportunity Overview*'s
 * checklist, and the brief's chips — written for the request's reader. Each English is the registry's, read from it,
 * byte for byte; the codes do not change. **None of them is the company's**: the playbook a plan is built from — a
 * profile's label, tagline, benefits, openings and answers — is content, and is shown as typed (ADR-0179 §5).
 *
 * *FAQ* is the loanword Indonesian already uses (§B.0 rule 5), the same in both. *Agent*, *AAB* and *AB* are the roles
 * (§A.5); *pitch*, *coaching* and *KPM* stay English (§A.5, §A.6). The Indonesian has no approved row yet: chosen in
 * §B.0's voice and listed for the product owner (P18.98-T7).
 */
export const RECRUITMENT_MESSAGES = messages('modules/recruitment', {
  /*
   * ---- the six pitch slots (`RECRUITMENT_PITCH_SLOTS`) ----
   * **A slot's title is its English name in both languages** (UI V1, UI-107: *one row per material with its English
   * name as in the app*; the seed playbook's Indonesian next action names *Opportunity Overview* too). Its line is
   * Indonesian.
   */
  opportunityTitle: { en: SLOT('opportunity').title, id: SLOT('opportunity').title },
  opportunityLine: { en: SLOT('opportunity').line, id: 'Pitch utama: perannya, penghasilannya, dan apa yang dibutuhkan.' },
  proofTitle: { en: SLOT('proof').title, id: SLOT('proof').title },
  proofLine: { en: SLOT('proof').line, id: 'Rekam jejak, testimoni, dan alasan untuk percaya.' },
  faqTitle: { en: SLOT('faq').title, id: 'FAQ' },
  faqLine: { en: SLOT('faq').line, id: 'Jawaban lugas atas pertanyaan yang selalu diajukan kandidat.' },
  howtojoinTitle: { en: SLOT('howtojoin').title, id: SLOT('howtojoin').title },
  howtojoinLine: {
    en: SLOT('howtojoin').line,
    id: 'Langkah pendaftaran, dokumen yang diperlukan, dan penandaan ke KPM.',
  },
  companyTitle: { en: SLOT('company').title, id: SLOT('company').title },
  companyLine: { en: SLOT('company').line, id: 'Profil perusahaan asuransi yang produknya dipasarkan agensi ini.' },
  agencyTitle: { en: SLOT('agency').title, id: SLOT('agency').title },
  agencyLine: { en: SLOT('agency').line, id: 'Profil agensi ini sendiri.' },

  /* ---- *Opportunity Overview*'s checklist ---- */
  careerPathItem: { en: ITEM('career-path'), id: 'Jenjang karier (Agent → AAB → AB)' },
  incomeItem: { en: ITEM('income'), id: 'Potensi penghasilan / ilustrasi kompensasi' },
  supportItem: { en: ITEM('support'), id: 'Dukungan yang diberikan (pelatihan, coaching, alat bantu)' },
  commitmentItem: { en: ITEM('commitment'), id: 'Komitmen yang dibutuhkan — pemeliharaan kontrak dan aktivitas wajib' },

  /* ---- the brief's chips: *Candidate type*, *What's driving them*, *Their biggest hesitation* ---- */
  freshGradType: { en: CHIP(RECRUITMENT_CANDIDATE_TYPES, 'fresh-grad'), id: 'Lulusan baru' },
  careerSwitchType: { en: CHIP(RECRUITMENT_CANDIDATE_TYPES, 'career-switch'), id: 'Pindah karier' },
  businessOwnerType: { en: CHIP(RECRUITMENT_CANDIDATE_TYPES, 'business-owner'), id: 'Pemilik usaha' },
  retireeType: { en: CHIP(RECRUITMENT_CANDIDATE_TYPES, 'retiree'), id: 'Pensiunan' },
  otherInsurerType: { en: CHIP(RECRUITMENT_CANDIDATE_TYPES, 'other-insurer'), id: 'Agent (asuransi lain)' },
  sideIncomeMotivation: { en: CHIP(RECRUITMENT_MOTIVATIONS, 'side-income'), id: 'Penghasilan tambahan' },
  fullCareerMotivation: { en: CHIP(RECRUITMENT_MOTIVATIONS, 'full-career'), id: 'Ganti karier' },
  flexibilityMotivation: { en: CHIP(RECRUITMENT_MOTIVATIONS, 'flexibility'), id: 'Fleksibilitas' },
  leadershipMotivation: { en: CHIP(RECRUITMENT_MOTIVATIONS, 'leadership'), id: 'Memimpin tim' },
  noExperienceHesitation: { en: CHIP(RECRUITMENT_HESITATIONS, 'no-experience'), id: 'Belum berpengalaman menjual' },
  stableJobHesitation: { en: CHIP(RECRUITMENT_HESITATIONS, 'stable-job'), id: 'Sudah memiliki pekerjaan tetap' },
  reputationHesitation: { en: CHIP(RECRUITMENT_HESITATIONS, 'reputation'), id: 'Reputasi buruk' },
  noNetworkHesitation: { en: CHIP(RECRUITMENT_HESITATIONS, 'no-network'), id: 'Tidak memiliki jaringan' },
  timeHesitation: { en: CHIP(RECRUITMENT_HESITATIONS, 'time'), id: 'Khawatir akan komitmen waktu' },
});

const WORDS = RECRUITMENT_MESSAGES;

/** Each slot's title and line, by code. */
const SLOT_WORDS: Readonly<Record<RecruitmentPitchSlotCode, { title: Sentence<null>; line: Sentence<null> }>> = {
  opportunity: { title: WORDS.opportunityTitle, line: WORDS.opportunityLine },
  proof: { title: WORDS.proofTitle, line: WORDS.proofLine },
  faq: { title: WORDS.faqTitle, line: WORDS.faqLine },
  howtojoin: { title: WORDS.howtojoinTitle, line: WORDS.howtojoinLine },
  company: { title: WORDS.companyTitle, line: WORDS.companyLine },
  agency: { title: WORDS.agencyTitle, line: WORDS.agencyLine },
};

/** Each checklist item's label, by code. */
const ITEM_WORDS: Readonly<Record<string, Sentence<null>>> = {
  'career-path': WORDS.careerPathItem,
  income: WORDS.incomeItem,
  support: WORDS.supportItem,
  commitment: WORDS.commitmentItem,
};

/** Each chip's label, by code — the three questions' codes are distinct, so one map holds them. */
const CHIP_WORDS: Readonly<Record<RecruitmentTypeCode | RecruitmentMotivationCode | RecruitmentHesitationCode, Sentence<null>>> = {
  'fresh-grad': WORDS.freshGradType,
  'career-switch': WORDS.careerSwitchType,
  'business-owner': WORDS.businessOwnerType,
  retiree: WORDS.retireeType,
  'other-insurer': WORDS.otherInsurerType,
  'side-income': WORDS.sideIncomeMotivation,
  'full-career': WORDS.fullCareerMotivation,
  flexibility: WORDS.flexibilityMotivation,
  leadership: WORDS.leadershipMotivation,
  'no-experience': WORDS.noExperienceHesitation,
  'stable-job': WORDS.stableJobHesitation,
  reputation: WORDS.reputationHesitation,
  'no-network': WORDS.noNetworkHesitation,
  time: WORDS.timeHesitation,
};

/** A pitch slot's title, as a sentence. */
export function pitchSlotTitle(code: RecruitmentPitchSlotCode): Sentence<null> {
  return SLOT_WORDS[code].title;
}

/** A pitch slot's line, as a sentence. */
export function pitchSlotLine(code: RecruitmentPitchSlotCode): Sentence<null> {
  return SLOT_WORDS[code].line;
}

/** A checklist item's label, as a sentence. */
export function pitchItemLabel(code: string): Sentence<null> {
  return ITEM_WORDS[code];
}

/** A chip's label, as a sentence: a candidate type, a motivation or a hesitation. */
export function briefChipLabel(
  code: RecruitmentTypeCode | RecruitmentMotivationCode | RecruitmentHesitationCode,
): Sentence<null> {
  return CHIP_WORDS[code];
}
