/**
 * Events an office runs (P5-T6, ADR-0034).
 *
 * The prototype stores an audience as **free text** — *"Prudential Event | All agents"*,
 * *"KPM | Leaders only"* — which is two structured facts and an invitee list crammed into one
 * string that nothing can filter on. These are those facts.
 */

/** Who is putting the event on. `company` is the insurer's, and an office may hide it, not edit it. */
export const EVENT_ISSUERS = ['company', 'kpm', 'group'] as const;
export type EventIssuer = (typeof EVENT_ISSUERS)[number];

/**
 * Who is invited.
 *
 * **`leaders` is the graph's definition — a member with at least one active direct report — and
 * never the role enum P4-T9 retired as an authorisation input.** An AAB with nobody under them
 * leads nobody, and inviting them to a leaders' meeting on the strength of a job title is the
 * class of defect OD-50 records, in a field that did not exist when it was written.
 */
export const EVENT_AUDIENCE_SCOPES = [
  'all_agents', 'select_agents', 'leaders', 'select_leaders',
] as const;
export type EventAudienceScope = (typeof EVENT_AUDIENCE_SCOPES)[number];

/** The two scopes that carry an invitee list. The other two are resolved from the office. */
export const SELECT_AUDIENCE_SCOPES: readonly EventAudienceScope[] = ['select_agents', 'select_leaders'];

/**
 * Where an event sits relative to now, **derived on every read** and never stored (P5-T6 AC-3).
 *
 * The prototype hardcodes `status: 'upcoming' | 'past'` and labels one campaign *Running* in the
 * list while its data says `past` — two answers to one question, and the wrong one is whichever
 * nobody remembered to update.
 */
export const EVENT_PHASES = ['upcoming', 'running', 'past'] as const;
export type EventPhase = (typeof EVENT_PHASES)[number];

/** The event types an office starts with, from the prototype's own list. */
export const SEED_EVENT_TYPES = [
  { code: 'TRAINING', label: 'Training', emoji: '📚', color: '#2D9CDB' },
  { code: 'PRODUCT_LAUNCH', label: 'Product launch', emoji: '🚀', color: '#F2994A' },
  { code: 'RECOGNITION', label: 'Recognition', emoji: '🏆', color: '#27AE60' },
  { code: 'RECRUITMENT', label: 'Recruitment', emoji: '🤝', color: '#9B51E0' },
  { code: 'COMMUNITY', label: 'Community', emoji: '🎉', color: '#EB5757' },
] as const;

/**
 * **What a member is to an event they were invited to** — `EVENT_ATTENDANCE_STATUS` (P18.5-T5 AC-8; D-status, OD-31).
 *
 * `unconfirmed` is D-status's value: a member who RSVP'd or said they came, after the event ended, whom no confirmer
 * has marked yet. Calling them a *no-show* because nobody has checked is the dishonesty exit test 2 guards against from
 * the other side, so `no_show` is only ever a confirmer's mark. Computed in one place, `domain/metrics/event-attendance.ts`.
 */
export const EVENT_ATTENDANCE_STATUSES = [
  'attended', 'registered', 'unconfirmed', 'no_show', 'not_registered',
] as const;
export type EventAttendanceStatus = (typeof EVENT_ATTENDANCE_STATUSES)[number];

/**
 * **The NPS scale and its buckets** (`metrics-and-definitions.md` §B, `NPS_*`; `KPM_Owner.html:3754-3761`,
 * `Overall.html:8658-8664`). A score is a whole number from `SCALE_MIN` to `SCALE_MAX`; a promoter scores at least
 * `PROMOTER_MIN`, a detractor at most `DETRACTOR_MAX`, a passive between. Fixed: the platform's, not an office's.
 * Served to the screens (`limits.nps`, `constants`), never re-declared there (invariant §7).
 */
export const NPS = {
  SCALE_MIN: 0,
  SCALE_MAX: 10,
  PROMOTER_MIN: 9,
  DETRACTOR_MAX: 6,
} as const;

/**
 * The longest *Why?* or *How can we improve?* answer, in characters after trimming (P18.5-T6 AC-3). Either beyond it
 * is refused `400`, never cut. Served as `limits.feedbackTextMax`.
 */
export const EVENT_FEEDBACK_TEXT_MAX = 1000;
