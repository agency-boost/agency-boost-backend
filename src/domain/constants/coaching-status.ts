/**
 * **`COACHING_STATUS` — a person's coaching status tile** (`revisions/2026-11-19/DATA-DEFINITIONS.md`, *Coaching*; the
 * brief's part A; ADR-0267 §5; `metrics-and-definitions.md` §A.3). Pinned by `coaching-status.spec.ts`.
 *
 * **A new named metric beside the roster's *overdue*, never a change to it.** `PERFORMANCE.COACHING_OVERDUE_DAYS` (7)
 * still decides `COACHED_7D` and the coaching roster's overdue flag; this 14 is the tile the Unit Dashboard's rows and the
 * owner's person card draw. **Fixed**, not an office setting.
 */
export const COACHING_STATUS = {
  /** Green *Coaching n hari lalu* while the last 1-on-1 is at most this many days old (today counting 0); yellow after. */
  RECENT_MAX_DAYS: 14,
} as const;

/**
 * The tile's three states: red *Belum pernah coaching* (`never`), green (`recent`), yellow (`lapsed`). Codes, never the
 * words or the colours: a page writes them in its reader's language and its own tokens.
 */
export const COACHING_STATUSES = ['never', 'recent', 'lapsed'] as const;
export type CoachingStatus = (typeof COACHING_STATUSES)[number];
