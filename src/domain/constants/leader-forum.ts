/**
 * **The Strategic Leader Forum** (Phase 18.1; `functional/leader-forum.md`): how long a meeting's shared link
 * opens, and the bounds of every field the leaders type. Each is **Fixed** (`metrics-and-definitions.md` §B),
 * pinned by `leader-forum.spec.ts`, and served to the screen as a meeting's `limits` so the browser keeps no
 * copy of them (invariant §7).
 *
 * `:NNN` is a line of `prototype/AgencyBoost_KPM_Owner.html`.
 */

/**
 * `LEADER_MEETING_SHARE_DAYS` (ADR-0131 §3): a shared link opens for this many days after it is made, then
 * answers *not found*. **The forum's own cadence**, *"Recommended: every 2 weeks"* (`:2714`), so a link made
 * for one meeting stops opening about when the next one is held.
 */
export const LEADER_MEETING_SHARE_DAYS = 14;

/**
 * **The random part of a shared link, in bytes** (ADR-0131 §1, *"at least 32 bytes"*): read once from the
 * system's secure source and written into the address as base64url. Only its SHA-256 is stored.
 */
export const LEADER_MEETING_SHARE_TOKEN_BYTES = 32;

/**
 * **The bound of what the leaders type** (D-forum-model; P19.22-T8, ADR-0276), in characters, after trimming: an agenda
 * line's text and an action item's, from 1. The prototype bounds nothing; this is ours, with room for the mockup's
 * longest line (*"Strategi rekrut Q4: tiap AB 1 presentasi rekrut per minggu"*). A forum has no title to type since
 * P19.22 (*Forum #n*), and a PIC is a member, picked, never typed: the title, PIC and *Monthly Target* bounds went with
 * them.
 */
export const LEADER_MEETING_LIMITS = {
  textMax: 500,
} as const;

/**
 * **The places a *Monthly Target*'s rate is typed and kept to** (P18.9-T1 AC-10, ADR-0175 §4): a rate per unit — *1*,
 * *2,5*, *0,75* — to two places, refused with more (`400 VALIDATION_FAILED`, `SaveMonthlyTargetDto`), and its value, the
 * rate times the meeting's *# of units*, rounded to the same two, so the product of two decimals carries no binary
 * noise (`monthlyTargetOf`). *APE*'s, in IDR minor units, is held to whole sen besides. Not served in `limits`: the
 * screen's copy (`frontend/src/lib/leader-meeting-tabs.ts`) is read against this one by its spec (invariant §7).
 */
export const LEADER_MEETING_TARGET_RATE_DECIMALS = 2;

/**
 * **`NEW_AGENT_ACTIVATION_3M_PCT`'s window** (P19.3-T1; ADR-0202 §1, the data sources' D7, *"their first policy in the
 * join month or the 3 months after"*): a new agent is activated by a policy in their join month **or this many calendar
 * months after it** — four months in all, in the office's calendar. The forum's *3M new agent %* and Phase 19.5's Quant
 * B1 read it. Not `ACTIVATION_3M.DAYS` (90 days from the join date, a first paid-and-issued case), which New Hires keeps.
 */
export const NEW_AGENT_ACTIVATION_MONTHS_AFTER_JOIN = 3;
