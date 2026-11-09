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
 * **The bounds of what the leaders type** (D-forum-model), in characters. The prototype bounds nothing — every
 * field is `contenteditable` (`:2655-2843`); these are ours, each with room for the prototype's longest value.
 *
 * - `titleMax` — a meeting's title, after trimming, from 1. *"Strategic Check-in — #14"* is 24.
 * - `textMax` — an agenda item's text, and each cell of the tracker but its PIC.
 * - `picMax` — a PIC, typed by hand (`:2817`, `:2834`): a name or two, never a membership.
 * - `targetMax` — a *Monthly Target* cell: short text, *"22 (3 @ unit)"* (`:2470`), *TBD* a value.
 */
export const LEADER_MEETING_LIMITS = {
  titleMax: 120,
  textMax: 500,
  picMax: 80,
  targetMax: 40,
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
