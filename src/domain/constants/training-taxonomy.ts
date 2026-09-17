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

/** `KPM_Owner.html:4267`. Sales's subtitle is `Training Section.html:1201`. */
export const SEED_TRAINING_CATEGORIES: readonly SeedTrainingCategory[] = [
  {
    code: 'SALES',
    label: 'Sales',
    description: 'Structured modules — tracked here, and later in your Skill Tracker.',
    displayOrder: 1,
  },
  { code: 'PRODUCT', label: 'Product', description: null, displayOrder: 2 },
  { code: 'RECRUITING', label: 'Recruiting', description: null, displayOrder: 3 },
  { code: 'TEAM_MANAGEMENT', label: 'Team Management', description: null, displayOrder: 4 },
  { code: 'SOFT_SKILLS', label: 'Soft Skills', description: null, displayOrder: 5 },
  { code: 'COMPANY_AND_KPM', label: 'Company and KPM', description: null, displayOrder: 6 },
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
