/**
 * **The platform console's *Platform* sections** (P19.23-T6; ADR-0279): *Pengumuman*'s bounds and who it can go to.
 *
 * Documented once in `docs/00-product/metrics-and-definitions.md` (*Platform console*) and pinned by
 * `platform-console.spec.ts`. The frontend mirrors the message's bound for its counter beside a comment naming this file;
 * the server's refusal is the one that counts.
 */
export const ANNOUNCEMENT = Object.freeze({
  /**
   * **Who an announcement goes to** (spec §10: *"to all owners, all members, or selected companies / KPMs"*):
   * `owners` — the Owner of every live, active KPM; `members` — every active member of every live, active KPM;
   * `selected` — every active member of the KPMs chosen, and of every live, active KPM of the companies chosen. Each
   * person once, however many of their KPMs it reaches; test accounts neither counted nor sent to.
   */
  AUDIENCES: Object.freeze(['owners', 'members', 'selected'] as const),
  /** The longest message, in characters, once trimmed: an inbox line and a short paragraph, never a document. */
  MESSAGE_MAX_LENGTH: 500,
  /** The most companies, and the most KPMs, one *Pilih perusahaan / KPM* may name. */
  SELECTED_MAX: 100,
  /** How many sent announcements the section lists, newest first. */
  LIST_SIZE: 20,
});

export type AnnouncementAudience = (typeof ANNOUNCEMENT.AUDIENCES)[number];
