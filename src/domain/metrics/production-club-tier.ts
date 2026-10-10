/**
 * `PRODUCTION_CLUB_TIER` (`metrics-and-definitions.md` §A.7; Phase 18, D-clubs) — the badge on an agency's row
 * (`KPM_Owner.html:3205-3210`, `:3340`): the **highest** tier whose threshold the agency's year-to-date APE
 * reaches, or none. A Chairman's Club agency is not also badged Star.
 *
 * **The tiers are the company's carrier rules**, of kind `production_club`, read live (ADR-0026) — never a
 * threshold in code. A year to date nobody has uploaded has no tier: `null`, not *no club*.
 */
export interface ClubTier {
  code: string;
  label: string;
  /** The annual APE the tier asks for, IDR minor units. */
  minAnnualApeMinor: number;
}

export function productionClubTier(
  apeYtdMinor: number | null, tiers: readonly ClubTier[],
): { code: string; label: string } | null {
  if (apeYtdMinor === null) return null;
  const reached = tiers
    .filter((tier) => apeYtdMinor >= tier.minAnnualApeMinor)
    .sort((a, b) => b.minAnnualApeMinor - a.minAnnualApeMinor);
  return reached.length === 0 ? null : { code: reached[0].code, label: reached[0].label };
}
