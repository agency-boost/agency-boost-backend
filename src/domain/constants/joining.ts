import { addDays, isLocalDate, type LocalDate } from '@/common/time/local-day';
import type { Sentence } from '@/common/i18n/sentence';
import { JOINING_REFUSALS } from './joining.messages';

/**
 * **A person's join date in an office, and who it makes them** (ADR-0169, P18.96-T2).
 *
 * `memberships.joinDate` is an office date the leader gives when the person is added or approved, the office's today
 * by default. `memberships.joinedAs` is decided from it **once**, when it is first set, and nothing recomputes it: a
 * later correction of the date does not reclassify. Documented once in `docs/00-product/metrics-and-definitions.md`
 * and pinned by `joining.spec.ts`; the frontend re-declares none of it.
 */
export const JOINING = {
  /**
   * **A new hire joined no more than this many days before the office's today** when their join date was set
   * (ADR-0169 §3): 90 days back is `new_hire`, 91 is `existing_agent`. The 3M window's length, kept apart from the
   * office's `activationWindowDays` because it is not an office's to change.
   */
  NEW_HIRE_MAX_DAYS_BACK: 90,
  /**
   * **The earliest join date anybody may give.** An existing agent may have joined decades ago, so there is no
   * bound but a sane one: a date before this is a mistyped year, not a career.
   */
  EARLIEST_JOIN_DATE: '1980-01-01',
} as const;

/**
 * **A leader's invite to somebody who is not in the office yet** (ADR-0170 §2, P18.96-T3 AC-2). Documented once in
 * `docs/00-product/metrics-and-definitions.md` and pinned by `joining.spec.ts`.
 */
export const INVITES = {
  /**
   * **An invite may be accepted for this many days** from when it was made, or last resent: 14. *Resend* gives it a
   * new link and 14 days more; past them it reads *Invite expired* and its link opens nothing.
   */
  EXPIRY_DAYS: 14,
  /** The longest name the form takes, once trimmed: a person's full name, never a paragraph. */
  NAME_MAX: 120,
} as const;

/**
 * **Sign-ups from one address** (the P18.96 exit review, L2): `POST /auth/register` — on an invite's link or without
 * one — is limited per client address, as an invite link's banner is, so one place cannot script accounts or walk a
 * list of agent codes against `AGENT_CODE_TAKEN`. Twenty an hour lets an office's onboarding session sign up on one
 * Wi-Fi and stops a script within minutes. Documented once in `docs/00-product/metrics-and-definitions.md` and pinned
 * by `joining.spec.ts`.
 */
export const REGISTRATION = {
  /** Sign-up attempts one client address may make in a window, refused or not. */
  MAX_PER_ADDRESS: 20,
  /** The window: one hour. */
  WINDOW_SECONDS: 60 * 60,
} as const;

/**
 * **3M activation and the year `/new-hires` lists** (ADR-0171 §2, ADR-0173; P18.96-T6). Documented once in
 * `docs/00-product/metrics-and-definitions.md` (*3M activation*) and pinned by `joining.spec.ts`; the frontend
 * re-declares none of it.
 */
export const ACTIVATION_3M = {
  /**
   * **The last day a first sale activates a new hire**, counted from the join date as day 1: a first sale on day 90
   * is *activated*, on day 91 it is not. The client's *"first sale by day 90"*; not the office's `activationWindowDays`,
   * which paces the checklist and is the office's to change, and not `JOINING.NEW_HIRE_MAX_DAYS_BACK`, which classifies.
   */
  DAYS: 90,
  /**
   * **`/new-hires` lists the new hires who joined within this many calendar months before the office's today** — a
   * join date after the same day twelve months back (ADR-0173 §1). Older ones leave the page and stay in the data.
   */
  WINDOW_MONTHS: 12,
} as const;

/** `memberships.joinedAs` (ADR-0169 §3). The screens say *New hire* and *Existing agent*. */
export const JOINED_AS = ['new_hire', 'existing_agent'] as const;
export type JoinedAs = (typeof JOINED_AS)[number];

/**
 * **Who a join date makes somebody, on the office's today** (ADR-0169 §3): `new_hire` when it is no more than
 * `JOINING.NEW_HIRE_MAX_DAYS_BACK` days before today, else `existing_agent`. Both are office dates, compared as
 * strings — `YYYY-MM-DD` sorts as the calendar does — so no instant and no zone is involved here.
 */
export function joinedAsFor(joinDate: LocalDate, today: LocalDate): JoinedAs {
  return joinDate >= addDays(today, -JOINING.NEW_HIRE_MAX_DAYS_BACK) ? 'new_hire' : 'existing_agent';
}

/**
 * **What is wrong with a join date a leader gave**, or `null` when nothing is: a real calendar day, not after the
 * office's today, and not before `JOINING.EARLIEST_JOIN_DATE`. The sentence names the field, as the shared envelope's
 * other refusals do, in both languages (P18.98-T5 AC-3).
 */
export function joinDateViolation(value: unknown, today: LocalDate): Sentence<'VALIDATION_FAILED'> | null {
  if (!isLocalDate(value)) return JOINING_REFUSALS.VALIDATION_FAILED.notADate;
  if (value > today) return JOINING_REFUSALS.VALIDATION_FAILED.afterToday;
  if (value < JOINING.EARLIEST_JOIN_DATE) {
    return JOINING_REFUSALS.VALIDATION_FAILED.beforeEarliest({ year: JOINING.EARLIEST_JOIN_DATE.slice(0, 4) });
  }
  return null;
}
