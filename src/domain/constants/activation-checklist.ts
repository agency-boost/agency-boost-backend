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
 * re-score somebody. The codes are ours; every label is the prototype's, **written in Bahasa Indonesia since
 * P18.10-T7** (OD-238, option 1): the platform's Default template is in the client's default language, with the
 * approved glossary's kept-English terms (*goal*, *leader*, *closing*, *case*, *1-on-1*, *milestone*) kept.
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
  /** Where that link sends them; `null` for a data kind, whose way in is its own form (P18.8-T4 AC-3). */
  readonly route: string | null;
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
 *
 * **The three feature kinds are live** (P13-T3 AC-1): a goal, a lead or an activity day written through
 * its own module completes the item bound to it, by code (`activation-links.ts`), and nobody ticks it by
 * hand. **So is the training kind, since P18.2-T3** (`ACTIVATION_TRAINING_LINK`, below).
 */
export const ACTIVATION_LINK_KINDS: Readonly<Record<ActivationFeatureLink, ActivationLinkKind>> = {
  'feature:goals': {
    label: 'Goal Settings',
    route: '/goals',
    completesWhen: 'the hire has saved any goal since joining',
    live: true,
  },
  'feature:leads': {
    label: 'Leads Management',
    route: '/leads',
    completesWhen: 'the hire has added at least one prospect',
    live: true,
  },
  'feature:activity': {
    label: 'Activity Management',
    route: '/activity/log',
    completesWhen: 'the hire has logged activity in four consecutive weeks',
    live: true,
  },
} as const;

/**
 * A training link's shape, for the screens that offer one and the manual that explains it.
 *
 * **Live since P18.2-T3** (ADR-0031): an item bound to `training:<moduleCode>` completes when its hire marks that
 * module *Done* (`trainingProgress.status`), attributed to the hire, at the progress's `completedAt`, and nobody
 * ticks it by hand while the module is offered. `route` is the catalog's; each served link resolves it to the
 * module's own page, `/training/{categoryCode}/{moduleCode}` (`ActivationService.linkView`).
 */
export const ACTIVATION_TRAINING_LINK: ActivationLinkKind = {
  label: 'Training module',
  route: '/training',
  completesWhen: 'the hire has completed that training module',
  live: true,
};

/**
 * **Every link kind, as a screen with no office to resolve against reads it** (P18.2-T3 AC-6, I-80): the three
 * feature kinds by their own name, and `training` for every `training:<moduleCode>` link. The Company template's
 * *Activation checklist* tab draws its *Auto* badge from this, served with the template's read, so the frontend
 * never re-declares the registry (invariant §7) and the badge says *Auto* only for a kind the server says is live.
 */
export function activationLinkKinds(): Readonly<Record<ActivationFeatureLink | 'training', ActivationLinkKind>> {
  return { ...ACTIVATION_LINK_KINDS, training: ACTIVATION_TRAINING_LINK };
}

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

/**
 * The prototype's five sections, in its order and with its numbering in the label — **in Bahasa Indonesia since
 * P18.10-T7** (OD-238, option 1; ADR-0179 §5), as the sixteen items are. The prototype's English is
 * `SEEDED_ACTIVATION_LABELS_BEFORE_OD_238`'s.
 */
export const SEED_ACTIVATION_ASPECTS: readonly SeedActivationAspect[] = [
  { code: 'INTRODUCTION', label: '1. Pengenalan', displayOrder: 1 },
  { code: 'INITIAL_SETUP', label: '2. Persiapan awal', displayOrder: 2 },
  { code: 'TRAINING_AND_CERTIFICATION', label: '3. Pelatihan & sertifikasi', displayOrder: 3 },
  { code: 'FIRST_SALE', label: '4. Penjualan pertama', displayOrder: 4 },
  { code: 'ONGOING_HABITS', label: '5. Kebiasaan rutin', displayOrder: 5 },
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
  { code: 'INSURANCE_BASICS', aspectCode: 'INTRODUCTION', label: 'Pelajari dasar-dasar asuransi', displayOrder: 1, autoLink: null },
  { code: 'CAREER_MINDSET', aspectCode: 'INTRODUCTION', label: 'Pelajari pola pikir karier keagenan', displayOrder: 2, autoLink: null },
  { code: 'COMPANY_PROFILE', aspectCode: 'INTRODUCTION', label: 'Pelajari profil perusahaan', displayOrder: 3, autoLink: null },
  { code: 'KPM_INTRO_SESSION', aspectCode: 'INTRODUCTION', label: 'Ikuti sesi pengenalan KPM', displayOrder: 4, autoLink: null },

  { code: 'GOAL_SETTING', aspectCode: 'INITIAL_SETUP', label: 'Atur goal: target APE & aktivitas', displayOrder: 1, autoLink: 'feature:goals' },
  { code: 'CRM_SETUP', aspectCode: 'INITIAL_SETUP', label: 'Siapkan sistem CRM perusahaan', displayOrder: 2, autoLink: null },
  { code: 'ADD_PROSPECTS', aspectCode: 'INITIAL_SETUP', label: 'Tambahkan prospek di Leads Management', displayOrder: 3, autoLink: 'feature:leads' },
  { code: 'CHECK_CONTEST', aspectCode: 'INITIAL_SETUP', label: 'Cek kontes terdekat', displayOrder: 4, autoLink: null },

  { code: 'MANDATORY_TRAINING', aspectCode: 'TRAINING_AND_CERTIFICATION', label: 'Pelatihan wajib: keterampilan menjual & pengetahuan produk', displayOrder: 1, autoLink: null },
  { code: 'CERTIFY_PRODUCTS', aspectCode: 'TRAINING_AND_CERTIFICATION', label: 'Sertifikasi produk prioritas', displayOrder: 2, autoLink: null },
  { code: 'ROLE_PLAY', aspectCode: 'TRAINING_AND_CERTIFICATION', label: 'Role play dengan leader', displayOrder: 3, autoLink: null },

  { code: 'JOINT_FIELD_WORK', aspectCode: 'FIRST_SALE', label: 'Joint field work dengan leader', displayOrder: 1, autoLink: null },
  // ADR-0031: the Owner template's wording, *Close first case independently*. `Overall.html:6453` drops the last
  // word, and the item before it is the one done *with* a leader.
  { code: 'FIRST_CASE_CLOSED', aspectCode: 'FIRST_SALE', label: 'Closing case pertama secara mandiri', displayOrder: 2, autoLink: null },

  { code: 'ACTIVITY_TRACKER_WEEKLY', aspectCode: 'ONGOING_HABITS', label: 'Isi Activity Tracker setiap minggu', displayOrder: 1, autoLink: 'feature:activity' },
  { code: 'WEEKLY_CHECK_IN', aspectCode: 'ONGOING_HABITS', label: 'Check-in 1-on-1 mingguan (4 minggu)', displayOrder: 2, autoLink: null },
  { code: 'INDEPENDENT_AGENT_MILESTONE', aspectCode: 'ONGOING_HABITS', label: 'Capai milestone agen mandiri (3 kali closing secara mandiri)', displayOrder: 3, autoLink: null },
] as const;

/**
 * **The item the roster's *Active Agent* column and the coaching renderer's *New Active Agent* read**
 * (D-group, `:6755`, `:6472`): bound to this code, never to item 13 by position (invariant §4). It is not
 * ADR-0054's *AA* or *MAA*, and no metric (invariant §8): a checklist item is done or it is not.
 */
export const ACTIVATION_FIRST_CASE_CODE = 'FIRST_CASE_CLOSED';

/**
 * **The words the seed gave before P18.10-T7** (OD-238, option 1), per code — the prototype's English
 * (`Overall.html:6435-6458`; item 13 `KPM_Owner.html:1553`). Kept only so migration `0046` can recognise the Template company's
 * Default template where it still holds them, and for the specs. No office and no template is given them any more.
 */
export const SEEDED_ACTIVATION_LABELS_BEFORE_OD_238: {
  readonly aspects: Readonly<Record<string, string>>;
  readonly items: Readonly<Record<string, string>>;
} = {
  aspects: {
    INTRODUCTION: '1. Introduction',
    INITIAL_SETUP: '2. Initial Setup',
    TRAINING_AND_CERTIFICATION: '3. Training & Certification',
    FIRST_SALE: '4. First Sale',
    ONGOING_HABITS: '5. Ongoing Habits',
  },
  items: {
    INSURANCE_BASICS: 'Learn insurance basics',
    CAREER_MINDSET: 'Learn agency career mindset',
    COMPANY_PROFILE: 'Learn company profile',
    KPM_INTRO_SESSION: 'Join KPM introduction session',
    GOAL_SETTING: 'Goal setting: APE & activity targets',
    CRM_SETUP: 'Set up company CRM system',
    ADD_PROSPECTS: 'Add prospects in Leads Management',
    CHECK_CONTEST: 'Check nearest contest',
    MANDATORY_TRAINING: 'Mandatory training: selling skill & product knowledge',
    CERTIFY_PRODUCTS: 'Certify priority products',
    ROLE_PLAY: 'Role play with leader',
    JOINT_FIELD_WORK: 'Joint Field Work with leader',
    FIRST_CASE_CLOSED: 'Close first case independently',
    ACTIVITY_TRACKER_WEEKLY: 'Fill Activity Tracker weekly',
    WEEKLY_CHECK_IN: 'Weekly 1-on-1 check-in (4 weeks)',
    INDEPENDENT_AGENT_MILESTONE: 'Reach Independent Agent milestone (3 independent closings)',
  },
};

/*
 * ── The data-backed items (ADR-0171 §3, P18.8-T4) ──────────────────────────────────────────────────
 */

/**
 * **The three kinds that complete from the office's sales and coaching records** (ADR-0171 §3, P18.8-T4 AC-2):
 *
 * - `sales:first` — the hire's **first sale since joining**, from the data: a sales lead that reached *Paid and
 *   issued* through the leads flow, or — failing that — a policy in the monthly production file (`firstSaleOf`);
 * - `sales:closings:3` — `ACTIVATION_INDEPENDENT_CLOSINGS` sales leads the leads flow took to *Paid and issued* since
 *   joining (`nthClosingOf`; the production file names no case, so it counts here for nothing);
 * - `coaching:weekly:4` — `ACTIVATION_WEEKLY_CHECK_INS` 1:1s with the hire in coaching sessions since joining.
 *
 * **Bound by an item's code, never chosen in the editor** (`ACTIVATION_CODE_BOUND_LINKS`): a published version is
 * never edited, so the platform's three items read their kind from their code, and an office's own item keeps
 * whatever `autoLink` it was given. `checkActivationChecklist` refuses one in a stored `autoLink`.
 */
export const ACTIVATION_DATA_LINKS = ['sales:first', 'sales:closings:3', 'coaching:weekly:4'] as const;
export type ActivationDataLink = (typeof ACTIVATION_DATA_LINKS)[number];

/** Every kind the engine evaluates by name: the three feature kinds and the three data kinds. */
export type ActivationNamedLink = ActivationFeatureLink | ActivationDataLink;

/** *Reach Independent Agent milestone (3 independent closings)*: how many closings `sales:closings:3` waits for. */
export const ACTIVATION_INDEPENDENT_CLOSINGS = 3;

/** *Weekly 1-on-1 check-in (4 weeks)*: how many 1:1s in coaching sessions `coaching:weekly:4` waits for. */
export const ACTIVATION_WEEKLY_CHECK_INS = 4;

/**
 * **The sales stage a first sale and a closing are** (ADR-0171 §1): *Paid and issued*, the sales ladder's own code
 * (`activity-taxonomy.ts`), by code and never by its rank (invariant §4). An office whose sales ladder has no such
 * stage has first sales from the production file and from checklist ticks only.
 */
export const FIRST_SALE_STAGE_CODE = 'PAID_AND_ISSUED';

/** What a hand tick of a data-backed item is saved with (P18.8-T4 AC-3): a closing, or a 1:1. */
export type ActivationRecordForm = 'closing' | 'one_on_one';

/** A data kind's registry entry: the link's, the form a hand tick opens, and the words of its source line. */
export interface ActivationDataLinkKind extends ActivationLinkKind {
  readonly form: ActivationRecordForm;
}

/**
 * **The data kinds' entries** (P18.8-T4 AC-2). `label` is the source line's — *"Completed from {label} · {date}"*
 * (`functional/activation.md`, *Data-backed items*) — and `route` is `null`: the item's way in is its own form, not
 * a *Go to* (AC-3).
 */
export const ACTIVATION_DATA_LINK_KINDS: Readonly<Record<ActivationDataLink, ActivationDataLinkKind>> = {
  'sales:first': {
    label: 'Sales data',
    route: null,
    completesWhen: 'the hire has a first sale since joining: a sales lead paid and issued, or a policy in the production file',
    live: true,
    form: 'closing',
  },
  'sales:closings:3': {
    label: 'Sales data',
    route: null,
    completesWhen: `the hire has ${ACTIVATION_INDEPENDENT_CLOSINGS} sales leads paid and issued since joining`,
    live: true,
    form: 'closing',
  },
  'coaching:weekly:4': {
    label: 'Coaching sessions',
    route: null,
    completesWhen: `${ACTIVATION_WEEKLY_CHECK_INS} 1:1s with the hire are recorded in coaching sessions since joining`,
    live: true,
    form: 'one_on_one',
  },
} as const;

/**
 * **The platform's three data-backed items, by code** (ADR-0171 §3; invariant §4, codes and never positions). Their
 * published versions carry `autoLink: null`; a read gives each its kind from here (`effectiveAutoLink`), so no
 * published version is edited and an office that kept the codes gets the links.
 */
export const ACTIVATION_CODE_BOUND_LINKS: Readonly<Record<string, ActivationDataLink>> = {
  [ACTIVATION_FIRST_CASE_CODE]: 'sales:first',
  INDEPENDENT_AGENT_MILESTONE: 'sales:closings:3',
  WEEKLY_CHECK_IN: 'coaching:weekly:4',
};

/** Whether a link is one of the three data kinds. */
export function isActivationDataLink(link: string | null): link is ActivationDataLink {
  return link !== null && (ACTIVATION_DATA_LINKS as readonly string[]).includes(link);
}

/**
 * **The link an item is read with** (P18.8-T4 AC-2): its own `autoLink` where it has one — an office's own choice
 * stays — else the kind its code is bound to, else none.
 */
export function effectiveAutoLink(code: string, autoLink: string | null): string | null {
  if (autoLink !== null) return autoLink;
  return Object.prototype.hasOwnProperty.call(ACTIVATION_CODE_BOUND_LINKS, code) ? ACTIVATION_CODE_BOUND_LINKS[code] : null;
}

/** The form a hand tick of this link opens, or `null` for a link ticked by nobody, or without a record. */
export function recordFormOf(link: string | null): ActivationRecordForm | null {
  return isActivationDataLink(link) ? ACTIVATION_DATA_LINK_KINDS[link].form : null;
}

/** A link's registry entry, or `undefined` for a kind nothing declares. Training links resolve here. */
export function activationLinkKind(link: string | null): ActivationLinkKind | undefined {
  if (link === null) return undefined;
  if (link.startsWith(ACTIVATION_TRAINING_LINK_PREFIX)) {
    return link.length > ACTIVATION_TRAINING_LINK_PREFIX.length ? ACTIVATION_TRAINING_LINK : undefined;
  }
  if (isActivationDataLink(link)) return ACTIVATION_DATA_LINK_KINDS[link];
  return ACTIVATION_LINK_KINDS[link as ActivationFeatureLink];
}

/**
 * Whether a leader may tick this item by hand.
 *
 * A manual item, always. A linked item **only while its evaluator does not exist** — otherwise an
 * item bound to a kind no phase has built yet could never complete, and nobody bound to it could
 * reach 100% (ADR-0031). The moment a kind goes live, the answer flips to no, for every role.
 *
 * **`offered`** is D-orphan's (P18.2-T3 AC-4): whether the training module a `training:` link binds is offered
 * now, in the office's published snapshot. While it is not — archived or unpublished since the hire's version
 * was published — nobody could mark it *Done*, so the item is ticked by hand, for ADR-0031's own reason; a
 * `done` record made earlier still completes it. It says nothing about a feature link, which binds no module.
 *
 * **`completedByLink`** (the Phase 18.2 exit review, training review 1): an item its link already completed is never
 * hand-edited — not unticked, and not re-ticked over the link's attribution — whatever its link's state now. Without
 * it, D-orphan reopened such an item to a hand tick the moment its module was withdrawn.
 */
export function mayTickByHand(link: string | null, offered = true, completedByLink = false): boolean {
  if (completedByLink) return false;
  const kind = activationLinkKind(link);
  if (kind === undefined) return true;
  if (kind === ACTIVATION_TRAINING_LINK && !offered) return true;
  return !kind.live;
}

/**
 * **A hand write to a data-backed item** (P18.8-T4 AC-3): which ones are taken.
 *
 * - `refused` — its data already completed it (`completedByLink`): nobody edits it by hand, as any link's;
 * - `needs_record` — a tick: taken only with its record, the closing it names or the 1:1, saved together;
 * - `free` — an untick of a tick saved by hand, which leaves the record it named where it is.
 *
 * `null` for any other link, which `mayTickByHand` decides.
 */
export function dataItemHandWrite(
  link: string | null, done: boolean, completedByLink: boolean,
): 'refused' | 'needs_record' | 'free' | null {
  if (!isActivationDataLink(link)) return null;
  if (completedByLink) return 'refused';
  return done ? 'needs_record' : 'free';
}
