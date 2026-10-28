import { ASSET_LIMITS, DOCUMENT_MIME_TYPES } from './assets';

/**
 * **Recruitment tools** (Phase 17; `functional/recruitment.md`): the candidate brief's vocabulary, the
 * office's six pitch slots — the four the readiness counts, and two optional — with the rule that says when one
 * is done and what the banner counts, and the playbook a company started from the defaults is given — each
 * once, here, and served to the browser rather than re-declared there (invariant §7).
 *
 * `:NNN` is a line of `prototype/AgencyBoost_Recruitment_Section.html`. Every string below is the
 * prototype's, verbatim, and `recruitment.spec.ts` reads each one back out of that file — except seven chip
 * labels, the client's shorter words of 2026-10-26 (UI-015, below), which the spec pins as the client gave them.
 */

/**
 * *Candidate type* (`:302-311`), in the chips' order (D-vocabulary). A single choice. The label is the
 * chip's; the plan's summary prints the profile's own label instead (*Fresh graduate*, `:557`).
 */
export const RECRUITMENT_CANDIDATE_TYPES = [
  { code: 'fresh-grad', label: 'Fresh grad' },
  { code: 'career-switch', label: 'Career switcher' },
  { code: 'business-owner', label: 'Business owner' },
  { code: 'retiree', label: 'Retiree' },
  { code: 'other-insurer', label: 'Agent (other insurer)' },
] as const;
export type RecruitmentTypeCode = (typeof RECRUITMENT_CANDIDATE_TYPES)[number]['code'];

/**
 * *What's driving them* (`:313-321`), in the chips' order. Several may be chosen; at least one.
 *
 * **The labels are the client's shorter words** (ADR-0167; the client's UI review of 2026-10-26, UI-015;
 * P18.95-T6 AC-2, parity I-421), at every size: the prototype's *Extra income on the side*, *Full career
 * change*, *Flexibility / time freedom* and *Building a team / leadership* stacked one chip per line on a
 * phone. **The codes are the prototype's and do not change**: an address, a playbook's openings and every
 * test key on them, never on a label. The plan prints the same label beside the opening it tags.
 */
export const RECRUITMENT_MOTIVATIONS = [
  { code: 'side-income', label: 'Side income' },
  { code: 'full-career', label: 'Career change' },
  { code: 'flexibility', label: 'Flexibility' },
  { code: 'leadership', label: 'Lead a team' },
] as const;
export type RecruitmentMotivationCode = (typeof RECRUITMENT_MOTIVATIONS)[number]['code'];

/**
 * *Their biggest hesitation* (`:323-332`), in the chips' order. Several may be chosen; at least one.
 *
 * **Three labels are the client's shorter words** (UI-015, as above): *No sales exp.*, *Bad reputation* and
 * *No network*. The client gave none for *Already has a stable job* or *Worried about time commitment*, so
 * those two keep the prototype's words — nothing is invented in their place — and wrap inside their cell of
 * the phone's two columns. Codes unchanged.
 */
export const RECRUITMENT_HESITATIONS = [
  { code: 'no-experience', label: 'No sales exp.' },
  { code: 'stable-job', label: 'Already has a stable job' },
  { code: 'reputation', label: 'Bad reputation' },
  { code: 'no-network', label: 'No network' },
  { code: 'time', label: 'Worried about time commitment' },
] as const;
export type RecruitmentHesitationCode = (typeof RECRUITMENT_HESITATIONS)[number]['code'];

/** What a candidate says, and what the agent answers (`:482-508`). */
export interface RecruitmentWords {
  readonly theySay: string;
  readonly youSay: string;
}

/** One candidate profile's words (`:394-476`): its label, tagline, *Good fit for*, benefits, an opening per motivation. */
export interface RecruitmentProfileWords {
  readonly label: string;
  readonly tagline: string;
  readonly goodFitFor: string;
  readonly benefits: readonly string[];
  readonly openings: Readonly<Record<RecruitmentMotivationCode, string>>;
}

/**
 * **A company's recruitment playbook** (OD-88 → option 5, ADR-0125): every profile, the base objection for
 * every hesitation, the objections a profile has of its own (the prototype's `OBJECTION_OVERRIDES`,
 * `:495` — not an office's overrides), and the next action (`CLOSING`, `:510`).
 */
export interface RecruitmentPlaybookBody {
  readonly profiles: Readonly<Record<RecruitmentTypeCode, RecruitmentProfileWords>>;
  readonly objections: Readonly<Record<RecruitmentHesitationCode, RecruitmentWords>>;
  readonly profileObjections: Readonly<
    Partial<Record<RecruitmentTypeCode, Readonly<Partial<Record<RecruitmentHesitationCode, RecruitmentWords>>>>>
  >;
  readonly nextAction: string;
}

/** The playbook's bounds, and the pitch document's link (D-slots, OD-88). */
export const RECRUITMENT = {
  /** Each authored string, after trimming: at least this many characters … */
  TEXT_MIN_LENGTH: 1,
  /** … and at most this many. */
  TEXT_MAX_LENGTH: 600,
  /** A profile's *Lead with these benefits*: at least one … */
  BENEFITS_MIN: 1,
  /** … and at most six. The prototype draws four for every profile. */
  BENEFITS_MAX: 6,
  /**
   * How long a pitch document's link lasts: the one signed-link lifetime every stored file has
   * (`ASSET_SIGNED_URL_TTL_SECONDS`), derived rather than restated, so the two cannot drift.
   */
  LINK_TTL_SECONDS: ASSET_LIMITS.SIGNED_URL_TTL_SECONDS,
  /** The office's own folder the pitch documents land in, fixed by the server (ADR-0032). */
  PITCH_UPLOAD_FOLDER: 'recruitment-pitch',
  /** A pitch document is a PDF and nothing else (D-slots). */
  PITCH_MIME_TYPES: DOCUMENT_MIME_TYPES,
  /** At most 25 MB: the one ceiling every upload has (`ASSET_MAX_BYTES`). */
  PITCH_MAX_BYTES: ASSET_LIMITS.MAX_BYTES,
} as const;

/**
 * **The office's six pitch documents** (D-slots; ADR-0177 §2), in the order drawn, each with its title, its
 * line, and whether the office's readiness counts it (`required`).
 *
 * - **The four the prototype draws** (`SLOTS`, `:626-661`), each `required`, verbatim. *Opportunity Overview*
 *   alone carries a checklist — *"Confirm this PDF actually includes"* — of four items, by the prototype's ids
 *   (`:634-637`). The prototype's `tooltip` is never drawn and is not carried (contradiction 15).
 * - **Then two optional ones**, the product owner's (UI-042; OD-233 → ADR-0177): *Company Profile* and
 *   *Agency Profile*, each the office's own PDF as the four are (ADR-0032), with no checklist, uploaded,
 *   replaced and opened as the others, and counted in neither the ring nor the banner
 *   (`recruitmentPitchSummary`). Not in the prototype: their titles are the request's words, and their lines —
 *   served and drawn on no card, as the four's are — say what each document is for, from the glossary's rows.
 */
export const RECRUITMENT_PITCH_SLOTS = [
  {
    code: 'opportunity',
    title: 'Opportunity Overview',
    line: 'The core pitch: the role, what it pays, and what it takes.',
    required: true,
    checklist: [
      { code: 'career-path', label: 'Career Path Ladder (Agent → AAB → AB)' },
      { code: 'income', label: 'Income Potential / compensation illustration' },
      { code: 'support', label: 'Support provided (training, coaching, tools)' },
      { code: 'commitment', label: 'Commitment needed — contract maintenance and required activity' },
    ],
  },
  { code: 'proof', title: 'Proof & Credibility', line: 'Track record, testimonials, and reasons to believe.', required: true, checklist: [] },
  { code: 'faq', title: 'FAQ', line: 'Straight answers to the questions candidates always ask.', required: true, checklist: [] },
  { code: 'howtojoin', title: 'How to Join', line: 'Steps to register, documents needed, and KPM tagging.', required: true, checklist: [] },
  { code: 'company', title: 'Company Profile', line: 'A profile of the insurer the agency sells for.', required: false, checklist: [] },
  { code: 'agency', title: 'Agency Profile', line: 'A profile of the agency itself.', required: false, checklist: [] },
] as const;
export type RecruitmentPitchSlotCode = (typeof RECRUITMENT_PITCH_SLOTS)[number]['code'];

/** A slot's state, by the one completion rule (`slotStatus`, `:681-691`). */
export const RECRUITMENT_PITCH_STATES = ['missing', 'complete', 'partial', 'uploaded'] as const;
export type RecruitmentPitchState = (typeof RECRUITMENT_PITCH_STATES)[number];

/**
 * **The completion rule, stated once** (D-slots): no file is *missing*; a file with every item of its
 * checklist ticked is *complete*; a file with an item open is *partial* (*Uploaded · needs confirmation*,
 * ADR-0177 §1 — the prototype's *"{n}/{m} confirmed"*); a file on a slot with no checklist is *uploaded*. The
 * same for a required slot and an optional one: an optional slot has no checklist, so it is *missing* or
 * *uploaded*.
 */
export function recruitmentPitchState(
  hasFile: boolean, checklist: readonly { readonly ticked: boolean }[],
): RecruitmentPitchState {
  if (!hasFile) return 'missing';
  if (checklist.length === 0) return 'uploaded';
  return checklist.every((item) => item.ticked) ? 'complete' : 'partial';
}

/** Whether a slot counts as done for the banner's ring (`:797-799`): complete, or uploaded with nothing to confirm. */
export function recruitmentPitchDone(state: RecruitmentPitchState): boolean {
  return state === 'complete' || state === 'uploaded';
}

/** The banner's counts (`PitchMaterialsView.summary`). */
export interface RecruitmentPitchSummary {
  /** Required slots complete, or uploaded with nothing to confirm. */
  done: number;
  /** How many slots are required: the ring's *x/4*. */
  total: number;
  /** Required slots with no file. */
  missing: number;
  /** Required slots with a file and an item still open. */
  unconfirmed: number;
}

/**
 * **What the ring and the banner count, stated once** (`:797-820`; ADR-0177 §3): **the required slots alone**
 * — `done` by `recruitmentPitchDone`, `missing`, and `unconfirmed` (`partial`) — over `total`, how many are
 * required. An optional slot counts in none of them, whatever it holds: uploading or leaving *Company Profile*
 * or *Agency Profile* moves nothing on the banner, so an office with neither still reads *complete*.
 */
export function recruitmentPitchSummary(
  slots: readonly { readonly required: boolean; readonly state: RecruitmentPitchState }[],
): RecruitmentPitchSummary {
  const required = slots.filter((slot) => slot.required);
  return {
    done: required.filter((slot) => recruitmentPitchDone(slot.state)).length,
    total: required.length,
    missing: required.filter((slot) => slot.state === 'missing').length,
    unconfirmed: required.filter((slot) => slot.state === 'partial').length,
  };
}

/**
 * **The words a company started from the defaults is given** (OD-88, ADR-0125; T2 AC-2): the prototype's
 * playbook verbatim (`:394-510`) — five profiles, each with its label, tagline, *Good fit for*, four
 * benefits and four openings; five base objections; three profiles' own; the next action — keyed by the
 * codes above. 72 strings. The company's to reword from the day it has them: the ladder named at `:401`
 * and *"Every agent in this office …"* at `:484` are the prototype's, kept verbatim (D-copy).
 */
export const SEED_RECRUITMENT_PLAYBOOK: RecruitmentPlaybookBody = {
  profiles: {
    'fresh-grad': {
      label: 'Fresh graduate',
      tagline:
        'New to the workforce, deciding on a first real career move.',
      goodFitFor:
        "Someone weighing this against an entry-level corporate job, who needs to know growth here isn't capped by tenure or hierarchy.",
      benefits: [
        'No prior experience required — full structured training and licensing support from day one.',
        'Clear promotion path: Agent → Associate Agency Builder → Agency Builder, with defined milestones, not tenure.',
        'Income is performance-based from the start, so effort compounds instead of waiting on annual raises.',
        'Daily coaching inside a ready-made team environment — not a cold desk with no guidance.',
      ],
      openings: {
        'side-income':
          'Are you thinking of this as something on the side for now, or could it become your main thing if it works out?',
        'full-career':
          'What would need to be true for you to feel confident this could be a real career, not just a first job?',
        'flexibility':
          'What does your ideal work week actually look like — hours, structure, who you report to?',
        'leadership':
          'Where do you want to be in three years — still doing the same role, or running your own team?',
      },
    },
    'career-switch': {
      label: 'Career switcher',
      tagline:
        'Currently employed, evaluating whether to leave a stable job.',
      goodFitFor:
        "Someone financially able to take a calculated risk, who's tired of a capped income ceiling in their current role.",
      benefits: [
        'Uncapped income tied to effort and results, not tenure or a fixed salary band.',
        'Transferable skills — relationship management, communication, problem-solving — apply directly.',
        'You can start part-time and prove the model before fully committing, using a defined activation checklist.',
        'A fast leadership track if you want to build and lead a team, not just sell individually.',
      ],
      openings: {
        'side-income':
          'Would you want to test this alongside your current job first, before making any bigger decision?',
        'full-career':
          "What's the actual ceiling on your current role — and is that a ceiling you're okay with long-term?",
        'flexibility':
          'How much of your frustration is really about the work, versus the lack of control over your schedule?',
        'leadership':
          "Have you ever had the chance to build and run your own team, or has that always been someone else's call?",
      },
    },
    'business-owner': {
      label: 'Business owner',
      tagline:
        'Already running something — a small business, freelance work, or a side venture.',
      goodFitFor:
        'Someone who wants ownership and scale, not another job with a different name.',
      benefits: [
        'Building an agency is building your own business — full ownership of your book, your team, your numbers.',
        'You already understand risk, cash flow, and client relationships — the fundamentals transfer directly.',
        'Recruiting and building a downline compounds income the same way you already think about scaling a business.',
        "Minimal overhead to start — you grow it the same way you scaled what you're running now.",
      ],
      openings: {
        'side-income':
          "Is this something you'd run alongside what you already have, or are you looking to eventually replace it?",
        'full-career':
          "What's pulling you away from what you're running now — income ceiling, stability, or something else?",
        'flexibility':
          "You already control your own schedule — what would make this a better use of that time than what you're doing now?",
        'leadership':
          "You're already building something. What if the next thing you built was a team, not just a client base?",
      },
    },
    'retiree': {
      label: 'Retiree',
      tagline:
        'Re-entering the workforce after time away, or looking for reduced-hours work.',
      goodFitFor:
        'Someone who needs flexibility more than a fixed schedule, and has an underused personal network.',
      benefits: [
        'Flexible schedule — activity is tracked by outcome, not clock-in hours.',
        'No resume-gap penalty — performance from day one is what counts, not recent work history.',
        'Reconnect and monetize an existing personal network — years of relationships often become your first leads.',
        'Start at whatever pace fits — ramp up once your schedule allows.',
      ],
      openings: {
        'side-income':
          "Are you looking for something light to start, or open to it growing once you've got your footing back?",
        'full-career':
          'What would make this feel like a real second chapter, rather than just filling time?',
        'flexibility':
          "What's the actual time you have available in a normal week right now?",
        'leadership':
          'Given everything you already know from your career, would you want to eventually guide others through the same thing?',
      },
    },
    'other-insurer': {
      label: 'Agent (other insurer)',
      tagline:
        'Currently licensed and selling for a different insurance company.',
      goodFitFor:
        "Someone already comfortable with insurance sales, weighing whether your agency's payout, culture, or support beats their current shop.",
      benefits: [
        'Already licensed — the conversation skips straight to platform, payout, and support, not whether insurance sales works for them.',
        'Can bring an existing book and network instead of starting from zero.',
        'Direct, side-by-side comparison of compensation structure and leadership support against what they have now.',
        'Faster ramp than any other profile — no curve on the fundamentals of selling insurance.',
      ],
      openings: {
        'side-income':
          'Are you looking to test us alongside your current book, or ready to make a full move if the numbers work?',
        'full-career':
          "What's missing where you are now that would make a move worth it?",
        'flexibility':
          'How much control do you actually have over your schedule and territory right now?',
        'leadership':
          'Does your current agency let you build and lead your own team, or has that been out of reach?',
      },
    },
  },
  objections: {
    'no-experience': {
      theySay: "I don't have any sales experience — I don't think I could do this.",
      youSay:
        "Nobody starts with experience. Every agent in this office went through the same licensing and shadow-selling process you would. The first 90 days are structured, so you're never selling alone.",
    },
    'stable-job': {
      theySay: 'I already have a stable job — why would I give that up?',
      youSay:
        "You don't have to quit on day one. Most agents start part-time, hit specific activity and income milestones, and only transition fully once the numbers prove out. It's a calculated move, not a leap of faith.",
    },
    'reputation': {
      theySay: "Insurance has a bad reputation — people don't trust agents.",
      youSay:
        'That reputation comes from products sold badly, not from the industry itself. Our process is built around long-term client retention, not one-time sales — that changes how you actually sell.',
    },
    'no-network': {
      theySay: "I don't really have a network of people to sell to.",
      youSay:
        'Nobody starts with a full network. Part of the first 90 days is building your contact list systematically — referrals, community, and structured lead sources, not just family and friends.',
    },
    'time': {
      theySay: "I'm worried about how much time this takes outside a normal schedule.",
      youSay:
        "Activity is tracked, not hours. The goal-setting tool shows the minimum activity needed to hit target, so you're planning against a number, not guessing at hours.",
    },
  },
  profileObjections: {
    'business-owner': {
      'stable-job': {
        theySay: 'I already have my own thing running — why add this?',
        youSay:
          "You're not leaving what you built, you're adding a second engine that compounds the same way — through people and consistent activity, not just your own hours.",
      },
    },
    'retiree': {
      'time': {
        theySay: "I'm not sure I have much time to give this right now.",
        youSay:
          "That's exactly why activity is tracked by outcome, not hours. You can start light and the goal tool will show you the minimum needed — no guessing, no overcommitting.",
      },
    },
    'other-insurer': {
      'stable-job': {
        theySay: "I've already built relationships at my current agency — why start over?",
        youSay:
          "You're not starting over — you bring your book and relationships with you. What changes is the payout structure and the support behind you, not the relationships you've already built.",
      },
    },
  },
  nextAction:
    "Send them the Opportunity Overview from Pitch Materials, and set a specific date for their licensing or first shadow session — don't leave it open-ended.",
};
