import { campaignOrder, mdrtTooltip, requirementWords, targetWords, type Orderable } from './campaign-words';

const at = (iso: string) => new Date(iso);
const c = (over: Partial<Orderable> & { code: string }): Orderable => ({
  title: over.code, kind: 'seasonal', phase: 'running', startsAt: at('2026-07-01T00:00:00Z'), endsAt: at('2026-09-30T00:00:00Z'),
  ...over,
});

/** What the server composes for the campaigns screens (P18.5-T7; D-lists, OD-152). */
describe('campaign words (P18.5-T7)', () => {
  it('P18.5-T7 AC-2 orders seasonal running (ending soonest), upcoming (starting soonest), ended (latest), then structural A to Z', () => {
    const list = [
      c({ code: 'S_B', title: 'Production club', kind: 'structural', endsAt: null }),
      c({ code: 'ENDED_OLD', phase: 'ended', endsAt: at('2026-03-31T00:00:00Z') }),
      c({ code: 'UP_LATE', phase: 'upcoming', startsAt: at('2026-12-01T00:00:00Z') }),
      c({ code: 'RUN_LATE', endsAt: at('2026-12-31T00:00:00Z') }),
      c({ code: 'S_A', title: 'MDRT Qualification', kind: 'structural', endsAt: null }),
      c({ code: 'ENDED_NEW', phase: 'ended', endsAt: at('2026-06-30T00:00:00Z') }),
      c({ code: 'UP_SOON', phase: 'upcoming', startsAt: at('2026-11-01T00:00:00Z') }),
      c({ code: 'RUN_SOON', endsAt: at('2026-10-31T00:00:00Z') }),
    ].sort(campaignOrder);
    expect(list.map((x) => x.code)).toEqual(['RUN_SOON', 'RUN_LATE', 'UP_SOON', 'UP_LATE', 'ENDED_NEW', 'ENDED_OLD', 'S_A', 'S_B']);
  });

  it('P18.5-T7 AC-2 breaks a tie of title by code, structural and seasonal alike', () => {
    const same = [c({ code: 'B', title: 'Same', kind: 'structural' }), c({ code: 'A', title: 'Same', kind: 'structural' })];
    expect(same.sort(campaignOrder).map((x) => x.code)).toEqual(['A', 'B']);
    expect([c({ code: 'Y', title: 'Same' }), c({ code: 'X', title: 'Same' })].sort(campaignOrder).map((x) => x.code)).toEqual(['X', 'Y']);
  });

  it('P18.5-T7 AC-2 breaks a tie by title, and a running campaign with no end sorts last among the running', () => {
    expect([c({ code: 'B', title: 'Beta' }), c({ code: 'A', title: 'Alpha' })].sort(campaignOrder).map((x) => x.code)).toEqual(['A', 'B']);
    expect([c({ code: 'OPEN', endsAt: null }), c({ code: 'DATED' })].sort(campaignOrder).map((x) => x.code)).toEqual(['DATED', 'OPEN']);
  });

  it('P18.5-T7 AC-3, P18.95-T1 AC-4 writes a target as the card does: rupiah from sen compact, a percentage to one decimal, a count', () => {
    expect(targetWords('APE_ACHIEVED', 240_000_000_000)).toBe('Rp 2,4 M');
    expect(targetWords('ROLLING_PERSISTENCY', 90)).toBe('90,0%');
    expect(targetWords('NEW_HIRES', 3)).toBe('3');
    expect(targetWords('NEW_HIRES', 1_250)).toBe('1.250');
    // ADR-0142 §3's words, in ADR-0167 §1's formats: *"APE of Rp 1,2 M or more"*.
    expect(requirementWords({ metricKey: 'APE_ACHIEVED', comparator: 'gte', value: 120_000_000_000 })).toBe('APE of Rp 1,2 M or more');
    expect(requirementWords({ metricKey: 'NEW_HIRES', comparator: 'gt', value: 2 })).toBe('New Hire above 2');
    expect(requirementWords({ metricKey: 'ROLLING_PERSISTENCY', comparator: 'lte', value: 90 })).toBe('Rolling persistency of 90,0% or less');
    expect(requirementWords({ metricKey: 'NEW_HIRES', comparator: 'lt', value: 2 })).toBe('New Hire below 2');
    expect(requirementWords({ metricKey: 'UNKNOWN_KEY', comparator: 'eq', value: 1 })).toBe('UNKNOWN_KEY of exactly 1');
  });

  it('P18.95-T1 AC-4 never rounds a target: one the compact form would round is written in full, a percentage to every decimal set', () => {
    expect(targetWords('APE_ACHIEVED', 125_000_000_000)).toBe('Rp 1.250.000.000');
    expect(requirementWords({ metricKey: 'APE_ACHIEVED', comparator: 'gte', value: 115_000 })).toBe('APE of Rp 1.150 or more');
    expect(targetWords('ROLLING_PERSISTENCY', 75.55)).toBe('75,55%');
  });

  it('P18.5-T7 AC-7 composes Chasing MDRT’s tooltip from the campaign, or says none is running — never FYC pace (OD-152)', () => {
    expect(mdrtTooltip({ requirements: [{ metricKey: 'APE_ACHIEVED', comparator: 'gte', value: 240_000_000_000 }] }))
      .toBe('Chasing MDRT (Million Dollar Round Table) this year — APE of Rp 2,4 M or more.');
    // ADR-0142 §3, verbatim.
    expect(mdrtTooltip(null)).toBe('Chasing MDRT (Million Dollar Round Table) this year. No MDRT campaign is running.');
    expect(mdrtTooltip({ requirements: [] })).toBe('Chasing MDRT (Million Dollar Round Table) this year.');
    expect(mdrtTooltip({
      requirements: [
        { metricKey: 'APE_ACHIEVED', comparator: 'gte', value: 100 },
        { metricKey: 'ROLLING_PERSISTENCY', comparator: 'gte', value: 85 },
      ],
    })).toBe('Chasing MDRT (Million Dollar Round Table) this year — APE of Rp 1 or more and Rolling persistency of 85,0% or more.');
    expect(mdrtTooltip(null)).not.toMatch(/FYC|pace|office|KPM/i);
  });
});
