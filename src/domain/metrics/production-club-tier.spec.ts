import { SEED_PRODUCTION_CLUB_TIERS } from '@/domain/constants';
import { productionClubTier, type ClubTier } from './production-club-tier';

const TIERS: ClubTier[] = SEED_PRODUCTION_CLUB_TIERS.map((t) => ({ code: t.code, label: t.name, minAnnualApeMinor: t.minAnnualApe }));
const RP = (rupiah: number) => rupiah * 100;

describe('PRODUCTION_CLUB_TIER (D-clubs)', () => {
  it('P18-T2 AC-5 the highest tier reached only, from the year to date', () => {
    expect(productionClubTier(RP(1_300_000_000), TIERS)).toEqual({ code: 'STAR_CLUB', label: 'Star Club' });
    expect(productionClubTier(RP(2_000_000_000), TIERS)).toEqual({ code: 'ELITE_CLUB', label: 'Elite Club' });
    expect(productionClubTier(RP(4_000_000_000), TIERS)).toEqual({ code: 'CHAIRMANS_CLUB', label: "Chairman's Club" });
  });

  it('P18-T2 AC-5 below every tier, or nothing uploaded, is no badge', () => {
    expect(productionClubTier(RP(1_199_999_999), TIERS)).toBeNull();
    expect(productionClubTier(null, TIERS)).toBeNull();
    expect(productionClubTier(RP(9_000_000_000), [])).toBeNull();
  });
});
