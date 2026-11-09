/**
 * The training taxonomy a new office starts with (P5-T1, ADR-0029).
 *
 * **The seed, not the truth.** Every office owns its copy from provisioning onward and
 * creates, edits and archives categories, skills and modules freely. This is what gets copied
 * when a company has published no `training_taxonomy` template of its own (ADR-0018).
 *
 * **What the Owner's settings screen shows** (`KPM_Owner.html:4267-4292`), which the Training
 * Section file matches for Sales (`Training Section.html:3876-3894`): six categories, and only
 * Sales holds anything. `Overall.html`'s 24 modules, the older consolidated cut, are not
 * seeded. Every seeded module is published, as the prototype shows them.
 *
 * **Codes, never numbers.** The prototype keys modules by the integers 1–10, and an
 * activation item or a progress record that pointed at a position would follow whatever moved
 * into it. The codes are ours; the labels are the prototype's, **written in Bahasa Indonesia since
 * P18.10-T7** (OD-238, option 1; ADR-0179 §5) — *Sales*, *Recruitment* and *Closing* kept English by the
 * approved glossary (§A.3, §A.6). The English is `SEEDED_TRAINING_WORDINGS_BEFORE_OD_238`'s.
 */

/** Whether a module is offered to agents at all — not when (that is the office's publish). */
export const TRAINING_PUBLISH_STATES = ['draft', 'published'] as const;
export type TrainingPublishState = (typeof TRAINING_PUBLISH_STATES)[number];

/**
 * **A member's status on one module** (P18.2-T1, `trainingProgress.status`): the prototype's three, in its
 * order (`Overall.html:7657-7661`) — *Not started*, *In progress*, *Done*.
 *
 * **The member's own word** (OD-149, answered 2026-10-10 as recommended): the three-way toggle they set, and
 * nothing that verifies it — no quiz, no certificate, no leader's mark. `in_progress` is not done, and *Done*
 * back to *Not started* is allowed (`Overall.html:7905-7911`). `TRAINING_COMPLETION_PCT` counts `done` only.
 */
export const TRAINING_STATUSES = ['not_started', 'in_progress', 'done'] as const;
export type TrainingStatus = (typeof TRAINING_STATUSES)[number];

/**
 * **A skill's and a module's *Deskripsi singkat*** (P19.6-T4, ADR-0220 §1; UI-161): the grey line under the name, at most
 * `DESCRIPTION_MAX` characters of plain text, `null` for none. A category keeps its own `description` and its own bound
 * (`TRAINING_BOUNDS.description`, 200). Pinned in `training-taxonomy.spec.ts`; documented in `metrics-and-definitions.md`.
 */
export const TRAINING_TEXT = {
  DESCRIPTION_MAX: 160,
} as const;

/** What {@link splitTrainingTitle} decided about one name, and why it left one whole. */
export type TrainingTitleSplit =
  | { split: true; name: string; description: string }
  | { split: false; reason: 'no_colon' | 'empty_half' | 'too_long' };

/**
 * **The split rule** (P19.6-T4 AC-2, ADR-0220 §3): a name or title holding a colon followed by a space is split at the
 * **first** such colon — the part before it, trimmed, the name; the part after it, trimmed, the description. *"Leads
 * generation: 8 cara mendapat calon nasabah"* is *Leads generation* and *8 cara mendapat calon nasabah*.
 *
 * Left whole, with the reason: no such colon; either half empty; a description past `TRAINING_TEXT.DESCRIPTION_MAX`.
 * Pure, so the migration, its spec and anything that reports a split read one rule.
 */
export function splitTrainingTitle(title: string): TrainingTitleSplit {
  const at = title.indexOf(': ');
  if (at < 0) return { split: false, reason: 'no_colon' };
  const name = title.slice(0, at).trim();
  const description = title.slice(at + 2).trim();
  if (!name || !description) return { split: false, reason: 'empty_half' };
  if (description.length > TRAINING_TEXT.DESCRIPTION_MAX) return { split: false, reason: 'too_long' };
  return { split: true, name, description };
}

export interface SeedTrainingCategory {
  readonly code: string;
  readonly label: string;
  /** The subtitle an agent's category page shows. */
  readonly description: string | null;
  readonly displayOrder: number;
}

export interface SeedTrainingSkill {
  readonly code: string;
  readonly categoryCode: string;
  readonly label: string;
  /** Within its category. */
  readonly displayOrder: number;
}

export interface SeedTrainingModule {
  readonly code: string;
  /** Its category is the skill's — never stored twice (ADR-0029). */
  readonly skillCode: string;
  readonly title: string;
  readonly publishState: TrainingPublishState;
  /** Within its skill. */
  readonly displayOrder: number;
}

/**
 * Sales's subtitle as seeded before OD-150 (ADR-0029's *"the Skill tracker stays separate"*): the prototype's promise
 * of a link nothing builds (`Overall.html:7865`). Kept only so migration `0029` can recognise the words an office
 * never changed; no office is given it any more.
 */
export const SEEDED_SALES_SUBTITLE_BEFORE_OD_150 = 'Structured modules — tracked here, and later in your Skill Tracker.';

/**
 * **What each default category was seeded with before P18.9-T4** (ADR-0176 §9; the client's UI-031: Sales's
 * *"Structured modules — tracked here."* is generic): Sales's OD-150 sentence, and no description for the other five.
 * Kept only so migration `0045` can recognise a category an office never changed, and so `0029` still writes the words
 * it was written for; no office is given them any more.
 */
export const SEEDED_TRAINING_DESCRIPTIONS_BEFORE_P18_97: Readonly<Record<string, string | null>> = {
  SALES: 'Structured modules — tracked here.',
  PRODUCT: null,
  RECRUITING: null,
  TEAM_MANAGEMENT: null,
  SOFT_SKILLS: null,
  COMPANY_AND_KPM: null,
};

/**
 * **Motivation, the owner's seventh category** (Phase 18.11 T10; the UI V1 report's UI-063, *new, owner 30 Oct*): the
 * category row's order is *Sales · Product · Recruiting · Team Management · **Motivation** · Soft Skills · Company and
 * KPM*, so it sits fifth and the two after it move down one. **Empty, as the five others are**: a category with no
 * published module is not offered to a field member (ADR-0176 §9), so nobody sees it until an office publishes a module
 * in it. Its code is stable from today (invariant §3). *Motivasi* is the approved glossary's word for *motivation*
 * (§B.10, the recruitment playbook's); its line is proposed in §B.10 (*UI V1, Phase 18.11 T10*). A new office is given
 * it from here; migration `0048` gives it to the Template company's *Default template*; an office made before keeps its
 * own taxonomy (ADR-0018) and adds it in Settings › Training if it wants it.
 */
export const MOTIVATION_CATEGORY: SeedTrainingCategory = {
  code: 'MOTIVATION',
  label: 'Motivasi',
  description: 'Semangat, tujuan, dan kebiasaan yang membuat Anda terus bergerak setiap hari.',
  displayOrder: 5,
};

/**
 * `KPM_Owner.html:4267`, the six categories in its order, and since UI V1 the owner's seventh, *Motivation*, fifth. **Each carries one real line saying what it teaches**
 * (P18.9-T4 AC-9, ADR-0176 §9; UI-031), shown under a category's title on an agent's training page and under its name
 * in the Owner's settings. Sales's read *"Structured modules — tracked here."* — `Training Section.html:1201` less
 * OD-150's Skill Tracker promise — and the other five nothing. A new office is given these; migration `0045` gives
 * them to an existing office only where it still holds the seeded words. **Drafted 2026-10-28, for the product owner
 * to confirm at the walk.**
 */
export const SEED_TRAINING_CATEGORIES: readonly SeedTrainingCategory[] = [
  {
    // *Sales* is kept English in both languages, as the tab beside *Recruit* is (the approved glossary, §A.3).
    code: 'SALES',
    label: 'Sales',
    description: 'Temukan prospek, gali kebutuhannya, jawab keberatan, dan lakukan closing.',
    displayOrder: 1,
  },
  {
    code: 'PRODUCT',
    label: 'Produk',
    description: 'Apa yang dilindungi setiap produk, untuk siapa produk itu cocok, dan cara menjelaskannya.',
    displayOrder: 2,
  },
  {
    code: 'RECRUITING',
    label: 'Recruitment',
    description: 'Temukan, dekati, dan rekrut orang-orang yang akan membangun tim Anda.',
    displayOrder: 3,
  },
  {
    code: 'TEAM_MANAGEMENT',
    label: 'Manajemen tim',
    description: 'Pimpin unit Anda: tetapkan goal, beri coaching kepada agen Anda, dan bantu agen baru memulai.',
    displayOrder: 4,
  },
  // The owner's seventh (UI V1, UI-063, 30 Oct 2026), between Team Management and Soft Skills: `MOTIVATION_CATEGORY`.
  MOTIVATION_CATEGORY,
  {
    code: 'SOFT_SKILLS',
    label: 'Soft skills',
    description: 'Komunikasi, rasa percaya diri, dan kebiasaan harian di balik penjualan yang konsisten.',
    displayOrder: 6,
  },
  {
    code: 'COMPANY_AND_KPM',
    label: 'Perusahaan dan KPM',
    description: 'Cara kerja perusahaan asuransi Anda dan KPM ini, serta kepada siapa bertanya untuk setiap hal.',
    displayOrder: 7,
  },
];

/**
 * **The words the seed gave before P18.10-T7** (OD-238, option 1), per code — the prototype's English labels and
 * titles (`KPM_Owner.html:4267-4291`) and P18.9-T4's English descriptions. Kept only so migration `0046` can
 * recognise the Template company's Default template where it still holds them, so `0045` still writes the words it
 * was written for, and for the specs. No office and no template is given them any more. *Sales* and *Closing* are
 * kept English, so their labels are not here.
 */
export const SEEDED_TRAINING_WORDINGS_BEFORE_OD_238: {
  readonly categories: Readonly<Record<string, { readonly label?: string; readonly description: string }>>;
  readonly skills: Readonly<Record<string, string>>;
  readonly modules: Readonly<Record<string, string>>;
} = {
  categories: {
    SALES: { description: 'Find prospects, uncover their needs, answer objections and close.' },
    PRODUCT: { label: 'Product', description: 'What each product covers, who it suits and how to explain it.' },
    RECRUITING: { label: 'Recruiting', description: 'Find, approach and bring in the people who will build your team.' },
    TEAM_MANAGEMENT: {
      label: 'Team Management', description: 'Lead your unit: set goals, coach your agents and help new ones start.',
    },
    SOFT_SKILLS: {
      label: 'Soft Skills', description: 'Communication, confidence and the daily habits behind steady selling.',
    },
    COMPANY_AND_KPM: {
      label: 'Company and KPM', description: 'How your insurer and this office work, and who to ask for what.',
    },
  },
  skills: {
    PROSPECTING: 'Prospecting',
    NEEDS_ANALYSIS: 'Needs Analysis',
    OBJECTION_HANDLING: 'Objection Handling',
    CROSS_SELL: 'Cross-sell',
    RETENTION: 'Retention',
  },
  modules: {
    PROSPECT_LIST: 'Building Your Prospect List',
    REFERRAL_GENERATION: 'Referral Generation Techniques',
    COLD_APPROACH_SCRIPTS: 'Cold Approach Scripts',
    FINANCIAL_NEEDS_ANALYSIS: 'Conducting a Financial Needs Analysis',
    DISCOVERY_QUESTIONS: 'Asking the Right Discovery Questions',
    OBJECTION_FUNDAMENTALS: 'Objection Handling Fundamentals',
    CLOSING_TECHNIQUES: 'Closing Techniques That Work',
    PRICE_OBJECTIONS: 'Handling Price Objections',
    CROSS_SELL_OPPORTUNITIES: 'Identifying Cross-sell Opportunities',
    CLIENT_RETENTION: 'Client Retention Best Practices',
  },
};

/** `KPM_Owner.html:4272-4277`. Only Sales has skills; the rest start empty. */
export const SEED_TRAINING_SKILLS: readonly SeedTrainingSkill[] = [
  { code: 'PROSPECTING', categoryCode: 'SALES', label: 'Pencarian prospek', displayOrder: 1 },
  { code: 'NEEDS_ANALYSIS', categoryCode: 'SALES', label: 'Analisis kebutuhan', displayOrder: 2 },
  { code: 'OBJECTION_HANDLING', categoryCode: 'SALES', label: 'Penanganan keberatan', displayOrder: 3 },
  { code: 'CLOSING', categoryCode: 'SALES', label: 'Closing', displayOrder: 4 },
  { code: 'CROSS_SELL', categoryCode: 'SALES', label: 'Penjualan silang', displayOrder: 5 },
  { code: 'RETENTION', categoryCode: 'SALES', label: 'Retensi nasabah', displayOrder: 6 },
];

/**
 * `KPM_Owner.html:4282-4291`, in the prototype's order — which interleaves skills (a Closing
 * module sits between two Objection Handling ones), so `displayOrder` counts within the skill.
 */
export const SEED_TRAINING_MODULES: readonly SeedTrainingModule[] = [
  { code: 'PROSPECT_LIST', skillCode: 'PROSPECTING', title: 'Menyusun daftar prospek Anda', publishState: 'published', displayOrder: 1 },
  { code: 'REFERRAL_GENERATION', skillCode: 'PROSPECTING', title: 'Teknik mendapatkan referensi', publishState: 'published', displayOrder: 2 },
  { code: 'COLD_APPROACH_SCRIPTS', skillCode: 'PROSPECTING', title: 'Script pendekatan prospek baru', publishState: 'published', displayOrder: 3 },
  { code: 'FINANCIAL_NEEDS_ANALYSIS', skillCode: 'NEEDS_ANALYSIS', title: 'Melakukan analisis kebutuhan finansial', publishState: 'published', displayOrder: 1 },
  { code: 'DISCOVERY_QUESTIONS', skillCode: 'NEEDS_ANALYSIS', title: 'Mengajukan pertanyaan penggalian yang tepat', publishState: 'published', displayOrder: 2 },
  { code: 'OBJECTION_FUNDAMENTALS', skillCode: 'OBJECTION_HANDLING', title: 'Dasar-dasar penanganan keberatan', publishState: 'published', displayOrder: 1 },
  { code: 'CLOSING_TECHNIQUES', skillCode: 'CLOSING', title: 'Teknik closing yang efektif', publishState: 'published', displayOrder: 1 },
  { code: 'PRICE_OBJECTIONS', skillCode: 'OBJECTION_HANDLING', title: 'Menangani keberatan soal harga', publishState: 'published', displayOrder: 2 },
  { code: 'CROSS_SELL_OPPORTUNITIES', skillCode: 'CROSS_SELL', title: 'Mengenali peluang penjualan silang', publishState: 'published', displayOrder: 1 },
  { code: 'CLIENT_RETENTION', skillCode: 'RETENTION', title: 'Praktik terbaik mempertahankan nasabah', publishState: 'published', displayOrder: 1 },
];
