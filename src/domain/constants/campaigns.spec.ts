import { formatDayMonth } from '@/common/format/format';
import { readerIn } from '@/common/i18n/reader';
import { render } from '@/common/i18n/sentence';
import { english, indonesian } from '../../../test/i18n';
import {
  CAMPAIGN_DURATION_WORDS, CAMPAIGN_KINDS, CAMPAIGN_LIMITS, CAMPAIGN_POSTER_COLORS, CAMPAIGN_QUALIFICATION_STATUSES,
  CAMPAIGN_ROLLING_MONTHS, CAMPAIGN_SUBTYPES, CAMPAIGN_WINDOWS, DEFAULT_CAMPAIGN_POSTER, MDRT_CAMPAIGN_CODE, MDRT_TOOLTIP,
  RESERVED_CAMPAIGN_CODES, STRUCTURAL_CAMPAIGN_WINDOWS,
} from './campaigns';
import { CALENDAR_YEAR_DAYS } from './campaigns.messages';
import { LANGUAGES } from './language';

/** Every value a campaign's rules read, pinned once (invariant §7; `metrics-and-definitions.md` §B.22). */
describe('the campaigns’ constants (Phase 18.5, §B.22)', () => {
  it('P18.5-T7 AC-9 the kinds, subtypes and windows D-fields and D-windows answered', () => {
    expect(CAMPAIGN_KINDS).toEqual(['seasonal', 'structural']);
    expect(CAMPAIGN_SUBTYPES).toEqual(['promotion', 'ongoing']);
    expect(CAMPAIGN_WINDOWS).toEqual(['campaign_dates', 'calendar_year', 'rolling_12m']);
    expect(STRUCTURAL_CAMPAIGN_WINDOWS).toEqual(['calendar_year', 'rolling_12m']);
    expect(CAMPAIGN_ROLLING_MONTHS).toBe(12);
  });

  it('P18.5-T7 AC-9 the bounds of what an Owner types, and the poster a campaign has without one', () => {
    expect(CAMPAIGN_LIMITS).toEqual({ BLURB_MAX: 200, POSTER_EMOJI_MAX: 8 });
    expect(CAMPAIGN_POSTER_COLORS).toEqual(['amber', 'amber-dark', 'navy', 'navy-soft', 'muted', 'success', 'gold']);
    expect(DEFAULT_CAMPAIGN_POSTER).toEqual({ emoji: '🎯', color: 'navy' });
    // The prototype's longest blurb fits (81 characters, `Overall.html:8040-8074`).
    expect(81).toBeLessThanOrEqual(CAMPAIGN_LIMITS.BLURB_MAX);
  });

  it('P18.5-T8 AC-4 a chaser is qualified, in progress, not met or unknown; a member who did not chase is not_joined (ADR-0143)', () => {
    expect(CAMPAIGN_QUALIFICATION_STATUSES).toEqual(['qualified', 'in_progress', 'not_met', 'unknown', 'not_joined']);
  });

  it('P18.5-T7 AC-7 Chasing MDRT binds to one code, its tooltip in ADR-0142 §3’s words, and `chasing` is no campaign', () => {
    expect(MDRT_CAMPAIGN_CODE).toBe('MDRT_QUALIFICATION');
    expect(`${english(MDRT_TOOLTIP.OPENING)}. ${english(MDRT_TOOLTIP.NONE)}`)
      .toBe('Chasing MDRT (Million Dollar Round Table) this year. No MDRT campaign is running.');
    expect(RESERVED_CAMPAIGN_CODES).toEqual(['CHASING']);
    expect(english(CAMPAIGN_DURATION_WORDS.calendar_year)).toBe('Standing — evaluated per calendar year (1 Jan – 31 Des)');
    expect(english(CAMPAIGN_DURATION_WORDS.rolling_12m)).toBe('Rolling 12-month window');
    expect(Object.keys(CAMPAIGN_DURATION_WORDS)).toEqual(['calendar_year', 'rolling_12m']);
  });

  /** **Both languages** (P18.98-T5 AC-4): the same words in Bahasa Indonesia, *MDRT* kept (the glossary's §C6). */
  it('P18.98-T5 AC-4 MDRT’s tooltip and the windows’ words in Indonesian; a calendar year’s days are a figure', () => {
    expect(`${indonesian(MDRT_TOOLTIP.OPENING)}. ${indonesian(MDRT_TOOLTIP.NONE)}`)
      .toBe('Mengejar MDRT (Million Dollar Round Table) tahun ini. Tidak ada campaign MDRT yang sedang berjalan.');
    expect(indonesian(CAMPAIGN_DURATION_WORDS.calendar_year)).toBe('Selalu aktif — dinilai per tahun kalender (1 Jan – 31 Des)');
    expect(indonesian(CAMPAIGN_DURATION_WORDS.rolling_12m)).toBe('Periode 12 bulan bergulir');
    // An English reader whose figures are English reads *Dec*; the words are the same.
    expect(render(CAMPAIGN_DURATION_WORDS.calendar_year, readerIn('en')))
      .toBe('Standing — evaluated per calendar year (1 Jan – 31 Dec)');
  });

  it('P18.98-T5 AC-4 a calendar year’s first and last day are the formatter’s own, in each language', () => {
    for (const language of LANGUAGES) {
      expect([language, CALENDAR_YEAR_DAYS[language]])
        .toEqual([language, `${formatDayMonth('2026-01-01', language)} – ${formatDayMonth('2026-12-31', language)}`]);
    }
  });
});
