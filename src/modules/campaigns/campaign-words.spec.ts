import { readerIn } from '@/common/i18n/reader';
import { campaignOrder, mdrtTooltip, requirementWords, targetWords, type Orderable } from './campaign-words';

const at = (iso: string) => new Date(iso);
const c = (over: Partial<Orderable> & { code: string }): Orderable => ({
  title: over.code, kind: 'seasonal', phase: 'running', startsAt: at('2026-07-01T00:00:00Z'), endsAt: at('2026-09-30T00:00:00Z'),
  ...over,
});

/** What the server composes for the campaigns screens (P18.2-T7; D-lists, OD-152). */
describe('campaign words (P18.2-T7)', () => {
  it('P18.2-T7 AC-2 orders seasonal running (ending soonest), upcoming (starting soonest), ended (latest), then structural A to Z', () => {
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

  it('P18.2-T7 AC-2 breaks a tie of title by code, structural and seasonal alike', () => {
    const same = [c({ code: 'B', title: 'Same', kind: 'structural' }), c({ code: 'A', title: 'Same', kind: 'structural' })];
    expect(same.sort(campaignOrder).map((x) => x.code)).toEqual(['A', 'B']);
    expect([c({ code: 'Y', title: 'Same' }), c({ code: 'X', title: 'Same' })].sort(campaignOrder).map((x) => x.code)).toEqual(['X', 'Y']);
  });

  it('P18.2-T7 AC-2 breaks a tie by title, and a running campaign with no end sorts last among the running', () => {
    expect([c({ code: 'B', title: 'Beta' }), c({ code: 'A', title: 'Alpha' })].sort(campaignOrder).map((x) => x.code)).toEqual(['A', 'B']);
    expect([c({ code: 'OPEN', endsAt: null }), c({ code: 'DATED' })].sort(campaignOrder).map((x) => x.code)).toEqual(['DATED', 'OPEN']);
  });

  it('P18.2-T7 AC-3, P18.7-T1 AC-4, P18.9-T3 AC-2 writes a target as the card does: rupiah from sen compact, a percentage as set with no ,0, a count', () => {
    expect(targetWords('APE_ACHIEVED', 240_000_000_000)).toBe('Rp 2,4 M');
    expect(targetWords('ROLLING_PERSISTENCY', 90)).toBe('90%');
    expect(targetWords('NEW_HIRES', 3)).toBe('3');
    expect(targetWords('NEW_HIRES', 1_250)).toBe('1.250');
    // ADR-0142 §3's words, in ADR-0167 §1's formats: *"APE of Rp 1,2 M or more"*.
    expect(requirementWords({ metricKey: 'APE_ACHIEVED', comparator: 'gte', value: 120_000_000_000 })).toBe('APE of Rp 1,2 M or more');
    expect(requirementWords({ metricKey: 'NEW_HIRES', comparator: 'gt', value: 2 })).toBe('New Hire above 2');
    expect(requirementWords({ metricKey: 'ROLLING_PERSISTENCY', comparator: 'lte', value: 90 })).toBe('Rolling persistency of 90% or less');
    expect(requirementWords({ metricKey: 'NEW_HIRES', comparator: 'lt', value: 2 })).toBe('New Hire below 2');
    expect(requirementWords({ metricKey: 'UNKNOWN_KEY', comparator: 'eq', value: 1 })).toBe('UNKNOWN_KEY of exactly 1');
  });

  it('P18.7-T1 AC-4 never rounds a target: one the compact form would round is written in full, a percentage to every decimal set', () => {
    expect(targetWords('APE_ACHIEVED', 125_000_000_000)).toBe('Rp 1.250.000.000');
    expect(requirementWords({ metricKey: 'APE_ACHIEVED', comparator: 'gte', value: 115_000 })).toBe('APE of Rp 1.150 or more');
    expect(targetWords('ROLLING_PERSISTENCY', 75.55)).toBe('75,55%');
  });

  it('P18.2-T7 AC-7 composes Chasing MDRT’s tooltip from the campaign, or says none is running — never FYC pace (OD-152)', () => {
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
    })).toBe('Chasing MDRT (Million Dollar Round Table) this year — APE of Rp 1 or more and Rolling persistency of 85% or more.');
    expect(mdrtTooltip(null)).not.toMatch(/FYC|pace|office|KPM/i);
  });
});

/**
 * **The same words for an Indonesian reader, and an English one's figures** (P18.10-T5 AC-4): the comparator in words
 * — *minimal*, *lebih dari*, *maksimal*, *kurang dari*, *tepat* — the metric's name kept (§A.4), and every target a
 * figure in the reader's own (the glossary's §E). *MDRT* stays; the tooltip's sentence around it is Indonesian (§C6).
 */
describe('P18.10-T5 AC-4 the campaigns’ words, in both languages', () => {
  const ID = readerIn('id');
  const EN = readerIn('en');

  it('P18.10-T5 AC-4 a requirement in Indonesian: the comparator in words, the target in Indonesian figures', () => {
    expect(requirementWords({ metricKey: 'APE_ACHIEVED', comparator: 'gte', value: 120_000_000_000 }, ID)).toBe('APE minimal Rp 1,2 M');
    expect(requirementWords({ metricKey: 'NEW_HIRES', comparator: 'gt', value: 2 }, ID)).toBe('New Hire lebih dari 2');
    expect(requirementWords({ metricKey: 'ROLLING_PERSISTENCY', comparator: 'lte', value: 75.55 }, ID))
      .toBe('Rolling persistency maksimal 75,55%');
    expect(requirementWords({ metricKey: 'NEW_HIRES', comparator: 'lt', value: 1_250 }, ID)).toBe('New Hire kurang dari 1.250');
    expect(requirementWords({ metricKey: 'UNKNOWN_KEY', comparator: 'eq', value: 1 }, ID)).toBe('UNKNOWN_KEY tepat 1');
    // Lossless in both: a target the compact form would round is written in full.
    expect(requirementWords({ metricKey: 'APE_ACHIEVED', comparator: 'gte', value: 115_000 }, ID)).toBe('APE minimal Rp 1.150');
  });

  it('P18.10-T5 AC-4 an English reader whose figures are English: the words as before, IDR and a decimal point', () => {
    expect(targetWords('APE_ACHIEVED', 240_000_000_000, 'en')).toBe('IDR 2.4B');
    expect(requirementWords({ metricKey: 'APE_ACHIEVED', comparator: 'gte', value: 120_000_000_000 }, EN)).toBe('APE of IDR 1.2B or more');
    expect(requirementWords({ metricKey: 'ROLLING_PERSISTENCY', comparator: 'lte', value: 75.55 }, EN))
      .toBe('Rolling persistency of 75.55% or less');
    expect(requirementWords({ metricKey: 'NEW_HIRES', comparator: 'lt', value: 1_250 }, EN)).toBe('New Hire below 1,250');
  });

  it('P18.10-T5 AC-4 Chasing MDRT’s tooltip in Indonesian: none running, one asking nothing, and two requirements', () => {
    expect(mdrtTooltip(null, ID))
      .toBe('Mengejar MDRT (Million Dollar Round Table) tahun ini. Tidak ada campaign MDRT yang sedang berjalan.');
    expect(mdrtTooltip({ requirements: [] }, ID)).toBe('Mengejar MDRT (Million Dollar Round Table) tahun ini.');
    expect(mdrtTooltip({
      requirements: [
        { metricKey: 'APE_ACHIEVED', comparator: 'gte', value: 240_000_000_000 },
        { metricKey: 'ROLLING_PERSISTENCY', comparator: 'gte', value: 85 },
      ],
    }, ID)).toBe('Mengejar MDRT (Million Dollar Round Table) tahun ini — APE minimal Rp 2,4 M dan Rolling persistency minimal 85%.');
    expect(mdrtTooltip({ requirements: [{ metricKey: 'APE_ACHIEVED', comparator: 'gte', value: 240_000_000_000 }] }, EN))
      .toBe('Chasing MDRT (Million Dollar Round Table) this year — APE of IDR 2.4B or more.');
    expect(mdrtTooltip(null, ID)).not.toMatch(/FYC|pace|office|KPM/i);
  });
});
