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
