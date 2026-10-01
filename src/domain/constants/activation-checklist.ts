/**
 * The 90-day activation checklist a new office starts with, and the links that complete an item
 * on its own (P5-T3, ADR-0031).
 *
 * **The seed, not the truth.** Every office owns its checklist from provisioning onward: it adds,
 * renames, reorders and removes items, and publishes a version of its own. This is what gets copied
 * when a company has published no `activation_checklist` template (ADR-0018).
 *
 * **Sixteen items in five aspects**, verbatim from `Overall.html:6435-6458`, with item 13 reading
 * *"Close first case independently"* — the Owner's own template (`KPM_Owner.html:1553`), which is
 * the document that defines the item (ADR-0031).
 *
 * **Codes, never positions.** A hire's progress names its items by code, so a code that moved would
 * re-score somebody. The codes are ours; every label is the prototype's.
 */

/** What an item waits for, or `none` for one a leader ticks. `training:` carries a module code. */
export const ACTIVATION_FEATURE_LINKS = [
  'feature:goals',
  'feature:leads',
  'feature:activity',
] as const;
export type ActivationFeatureLink = (typeof ACTIVATION_FEATURE_LINKS)[number];

/** The prefix a training link carries, followed by a module's code: `training:PROSPECT_LIST`. */
export const ACTIVATION_TRAINING_LINK_PREFIX = 'training:';

export interface ActivationLinkKind {
  /** What the agent's screen calls it in *"Go to {label} →"* (P13-T4). */
  readonly label: string;
  /** Where that link sends them. */
  readonly route: string;
  /** What completes it, in one sentence — the screens and the manual both read this. */
  readonly completesWhen: string;
  /**
   * Whether an evaluator exists yet. **Until a kind is live, its item is ticked by hand** and the
   * tick is recorded as manual; once it is live, no role may tick it (ADR-0031).
   */
  readonly live: boolean;
  /*
   * No `livePhase`. It carried the phase that would make a kind live, for a screen to print — and a
   * phase number is our schedule, which a customer can do nothing with (ADR-0062 §3). The re-plan of
   * 2026-09-29 left it naming the wrong phases, which is the argument: a number nothing renders is a
   * number nothing keeps true (P10.1-T2 AC-13). The roadmap says when; `live` says whether.
   */
}

/**
 * Every link kind, in one place (P5-T3 AC-7).
 *
 * The label and the route live here rather than in a switch on the agent's screen, so a kind added
 * later cannot fall through one and render a link to nowhere.
 */
export const ACTIVATION_LINK_KINDS: Readonly<Record<ActivationFeatureLink, ActivationLinkKind>> = {
  'feature:goals': {
    label: 'Goal Settings',
    route: '/goals',
    completesWhen: 'the hire has saved any goal since joining this office',
    live: false,
  },
  'feature:leads': {
    label: 'Leads Management',
    route: '/leads',
    completesWhen: 'the hire has added at least one prospect',
    live: false,
  },
  'feature:activity': {
    label: 'Activity Management',
    route: '/activity/log',
    completesWhen: 'the hire has logged activity in four consecutive weeks',
    live: false,
  },
} as const;

/** A training link's shape, for the screens that offer one and the manual that explains it. */
export const ACTIVATION_TRAINING_LINK: ActivationLinkKind = {
  label: 'Training module',
  route: '/training',
  completesWhen: 'the hire has completed that training module',
  live: false,
};

/**
 * How many consecutive weeks of logged activity `feature:activity` waits for (ADR-0031).
 *
 * The item reads *"Fill Activity Tracker weekly"*, and one log on day one is not a weekly habit.
 * Weeks are Monday to Sunday in the tenant's timezone, and any four consecutive weeks count.
 */
export const ACTIVATION_ACTIVITY_WEEKS = 4;

export interface SeedActivationAspect {
  readonly code: string;
  readonly label: string;
  readonly displayOrder: number;
}

export interface SeedActivationItem {
  readonly code: string;
  readonly aspectCode: string;
  readonly label: string;
  /** Within its aspect. */
  readonly displayOrder: number;
  readonly autoLink: ActivationFeatureLink | null;
}

/** The prototype's five sections, in its order and with its numbering in the label. */
export const SEED_ACTIVATION_ASPECTS: readonly SeedActivationAspect[] = [
  { code: 'INTRODUCTION', label: '1. Introduction', displayOrder: 1 },
  { code: 'INITIAL_SETUP', label: '2. Initial Setup', displayOrder: 2 },
  { code: 'TRAINING_AND_CERTIFICATION', label: '3. Training & Certification', displayOrder: 3 },
  { code: 'FIRST_SALE', label: '4. First Sale', displayOrder: 4 },
  { code: 'ONGOING_HABITS', label: '5. Ongoing Habits', displayOrder: 5 },
] as const;

/**
 * The sixteen items.
 *
 * Three carry a link, and they are the three the flow doc marks `Auto`: items 5, 7 and 14. **Item 9
 * carries none**, although the prototype's settings screen shows it bound to a training module
 * (`KPM_Owner.html:1546`): which module an office means is the office's choice, and a seeded link to
 * a module the office might archive would refuse its own provisioning.
 */
export const SEED_ACTIVATION_ITEMS: readonly SeedActivationItem[] = [
  { code: 'INSURANCE_BASICS', aspectCode: 'INTRODUCTION', label: 'Learn insurance basics', displayOrder: 1, autoLink: null },
  { code: 'CAREER_MINDSET', aspectCode: 'INTRODUCTION', label: 'Learn agency career mindset', displayOrder: 2, autoLink: null },
  { code: 'COMPANY_PROFILE', aspectCode: 'INTRODUCTION', label: 'Learn company profile', displayOrder: 3, autoLink: null },
  { code: 'KPM_INTRO_SESSION', aspectCode: 'INTRODUCTION', label: 'Join KPM introduction session', displayOrder: 4, autoLink: null },

  { code: 'GOAL_SETTING', aspectCode: 'INITIAL_SETUP', label: 'Goal setting: APE & activity targets', displayOrder: 1, autoLink: 'feature:goals' },
  { code: 'CRM_SETUP', aspectCode: 'INITIAL_SETUP', label: 'Set up company CRM system', displayOrder: 2, autoLink: null },
  { code: 'ADD_PROSPECTS', aspectCode: 'INITIAL_SETUP', label: 'Add prospects in Leads Management', displayOrder: 3, autoLink: 'feature:leads' },
  { code: 'CHECK_CONTEST', aspectCode: 'INITIAL_SETUP', label: 'Check nearest contest', displayOrder: 4, autoLink: null },

  { code: 'MANDATORY_TRAINING', aspectCode: 'TRAINING_AND_CERTIFICATION', label: 'Mandatory training: selling skill & product knowledge', displayOrder: 1, autoLink: null },
  { code: 'CERTIFY_PRODUCTS', aspectCode: 'TRAINING_AND_CERTIFICATION', label: 'Certify priority products', displayOrder: 2, autoLink: null },
  { code: 'ROLE_PLAY', aspectCode: 'TRAINING_AND_CERTIFICATION', label: 'Role play with leader', displayOrder: 3, autoLink: null },

  { code: 'JOINT_FIELD_WORK', aspectCode: 'FIRST_SALE', label: 'Joint Field Work with leader', displayOrder: 1, autoLink: null },
  // ADR-0031: the Owner template's wording. `Overall.html:6453` drops the last word, and the item
  // before it is the one done *with* a leader.
  { code: 'FIRST_CASE_CLOSED', aspectCode: 'FIRST_SALE', label: 'Close first case independently', displayOrder: 2, autoLink: null },

  { code: 'ACTIVITY_TRACKER_WEEKLY', aspectCode: 'ONGOING_HABITS', label: 'Fill Activity Tracker weekly', displayOrder: 1, autoLink: 'feature:activity' },
  { code: 'WEEKLY_CHECK_IN', aspectCode: 'ONGOING_HABITS', label: 'Weekly 1-on-1 check-in (4 weeks)', displayOrder: 2, autoLink: null },
  { code: 'INDEPENDENT_AGENT_MILESTONE', aspectCode: 'ONGOING_HABITS', label: 'Reach Independent Agent milestone (3 independent closings)', displayOrder: 3, autoLink: null },
] as const;

/** A link's registry entry, or `undefined` for a kind nothing declares. Training links resolve here. */
export function activationLinkKind(link: string | null): ActivationLinkKind | undefined {
  if (link === null) return undefined;
  if (link.startsWith(ACTIVATION_TRAINING_LINK_PREFIX)) {
    return link.length > ACTIVATION_TRAINING_LINK_PREFIX.length ? ACTIVATION_TRAINING_LINK : undefined;
  }
  return ACTIVATION_LINK_KINDS[link as ActivationFeatureLink];
}

/**
 * Whether a leader may tick this item by hand.
 *
 * A manual item, always. A linked item **only while its evaluator does not exist** — otherwise an
 * item bound to a kind no phase has built yet could never complete, and nobody bound to it could
 * reach 100% (ADR-0031). The moment a kind goes live, the answer flips to no, for every role.
 */
export function mayTickByHand(link: string | null): boolean {
  const kind = activationLinkKind(link);
  return kind === undefined ? true : !kind.live;
}
