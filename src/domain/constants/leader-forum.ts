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
