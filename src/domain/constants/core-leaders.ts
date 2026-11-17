/**
 * ***Core leaders & groups*** (P19.13-T3; UI-199; ADR-0253; `functional/org-hierarchy.md`, *Core leaders & groups*).
 */
export const CORE_LEADERS = {
  /**
   * The most leaders one *Atur group* or *★ Jadikan core* may change at once (`PUT /members/core-leaders/bulk`): the
   * 500-member ceiling an office is measured at (`performance-and-scale.md`), as `UNIT_DASHBOARD.MAX_TAGGED_PER_ADD`
   * is, so every leader of an office always fits one request.
   */
  MAX_PER_BULK: 500,
} as const;
