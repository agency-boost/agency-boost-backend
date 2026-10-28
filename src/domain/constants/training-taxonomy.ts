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
 * into it. The codes are ours; the labels are the prototype's, verbatim.
 */

/** Whether a module is offered to agents at all — not when (that is the office's publish). */
export const TRAINING_PUBLISH_STATES = ['draft', 'published'] as const;
export type TrainingPublishState = (typeof TRAINING_PUBLISH_STATES)[number];

/**
 * **A member's status on one module** (P18.5-T1, `trainingProgress.status`): the prototype's three, in its
 * order (`Overall.html:7657-7661`) — *Not started*, *In progress*, *Done*.
 *
 * **The member's own word** (OD-149, answered 2026-10-10 as recommended): the three-way toggle they set, and
 * nothing that verifies it — no quiz, no certificate, no leader's mark. `in_progress` is not done, and *Done*
 * back to *Not started* is allowed (`Overall.html:7905-7911`). `TRAINING_COMPLETION_PCT` counts `done` only.
 */
export const TRAINING_STATUSES = ['not_started', 'in_progress', 'done'] as const;
export type TrainingStatus = (typeof TRAINING_STATUSES)[number];

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
 * **What each default category was seeded with before P18.97-T4** (ADR-0176 §9; the client's UI-031: Sales's
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
 * `KPM_Owner.html:4267`, the six categories in its order. **Each carries one real line saying what it teaches**
 * (P18.97-T4 AC-9, ADR-0176 §9; UI-031), shown under a category's title on an agent's training page and under its name
 * in the Owner's settings. Sales's read *"Structured modules — tracked here."* — `Training Section.html:1201` less
 * OD-150's Skill Tracker promise — and the other five nothing. A new office is given these; migration `0045` gives
 * them to an existing office only where it still holds the seeded words. **Drafted 2026-10-28, for the product owner
 * to confirm at the walk.**
 */
export const SEED_TRAINING_CATEGORIES: readonly SeedTrainingCategory[] = [
  {
    code: 'SALES',
    label: 'Sales',
    description: 'Find prospects, uncover their needs, answer objections and close.',
    displayOrder: 1,
  },
  {
    code: 'PRODUCT',
    label: 'Product',
    description: 'What each product covers, who it suits and how to explain it.',
    displayOrder: 2,
  },
  {
    code: 'RECRUITING',
    label: 'Recruiting',
    description: 'Find, approach and bring in the people who will build your team.',
    displayOrder: 3,
  },
  {
    code: 'TEAM_MANAGEMENT',
    label: 'Team Management',
    description: 'Lead your unit: set goals, coach your agents and help new ones start.',
    displayOrder: 4,
  },
  {
    code: 'SOFT_SKILLS',
    label: 'Soft Skills',
    description: 'Communication, confidence and the daily habits behind steady selling.',
    displayOrder: 5,
  },
  {
    code: 'COMPANY_AND_KPM',
    label: 'Company and KPM',
    description: 'How your insurer and this office work, and who to ask for what.',
    displayOrder: 6,
  },
];

/** `KPM_Owner.html:4272-4277`. Only Sales has skills; the rest start empty. */
export const SEED_TRAINING_SKILLS: readonly SeedTrainingSkill[] = [
  { code: 'PROSPECTING', categoryCode: 'SALES', label: 'Prospecting', displayOrder: 1 },
  { code: 'NEEDS_ANALYSIS', categoryCode: 'SALES', label: 'Needs Analysis', displayOrder: 2 },
  { code: 'OBJECTION_HANDLING', categoryCode: 'SALES', label: 'Objection Handling', displayOrder: 3 },
  { code: 'CLOSING', categoryCode: 'SALES', label: 'Closing', displayOrder: 4 },
  { code: 'CROSS_SELL', categoryCode: 'SALES', label: 'Cross-sell', displayOrder: 5 },
  { code: 'RETENTION', categoryCode: 'SALES', label: 'Retention', displayOrder: 6 },
];

/**
 * `KPM_Owner.html:4282-4291`, in the prototype's order — which interleaves skills (a Closing
 * module sits between two Objection Handling ones), so `displayOrder` counts within the skill.
 */
export const SEED_TRAINING_MODULES: readonly SeedTrainingModule[] = [
  { code: 'PROSPECT_LIST', skillCode: 'PROSPECTING', title: 'Building Your Prospect List', publishState: 'published', displayOrder: 1 },
  { code: 'REFERRAL_GENERATION', skillCode: 'PROSPECTING', title: 'Referral Generation Techniques', publishState: 'published', displayOrder: 2 },
  { code: 'COLD_APPROACH_SCRIPTS', skillCode: 'PROSPECTING', title: 'Cold Approach Scripts', publishState: 'published', displayOrder: 3 },
  { code: 'FINANCIAL_NEEDS_ANALYSIS', skillCode: 'NEEDS_ANALYSIS', title: 'Conducting a Financial Needs Analysis', publishState: 'published', displayOrder: 1 },
  { code: 'DISCOVERY_QUESTIONS', skillCode: 'NEEDS_ANALYSIS', title: 'Asking the Right Discovery Questions', publishState: 'published', displayOrder: 2 },
  { code: 'OBJECTION_FUNDAMENTALS', skillCode: 'OBJECTION_HANDLING', title: 'Objection Handling Fundamentals', publishState: 'published', displayOrder: 1 },
  { code: 'CLOSING_TECHNIQUES', skillCode: 'CLOSING', title: 'Closing Techniques That Work', publishState: 'published', displayOrder: 1 },
  { code: 'PRICE_OBJECTIONS', skillCode: 'OBJECTION_HANDLING', title: 'Handling Price Objections', publishState: 'published', displayOrder: 2 },
  { code: 'CROSS_SELL_OPPORTUNITIES', skillCode: 'CROSS_SELL', title: 'Identifying Cross-sell Opportunities', publishState: 'published', displayOrder: 1 },
  { code: 'CLIENT_RETENTION', skillCode: 'RETENTION', title: 'Client Retention Best Practices', publishState: 'published', displayOrder: 1 },
];
