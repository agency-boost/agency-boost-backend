import { messages, type Sentence } from '@/common/i18n/sentence';
import type { CampaignWindow } from './campaigns';
import type { Language } from './language';

/**
 * **A calendar year's first and last day, in each language's figures** — *1 Jan – 31 Des*, *1 Jan – 31 Dec* — as
 * `formatDayMonth` writes them, joined by the formatters' range (`common/format`; the glossary's §E). Written here,
 * not called: the formatters read `domain/constants`, which reads this file, and `campaigns.spec.ts` holds the two to
 * the formatter's own output so they cannot drift.
 */
export const CALENDAR_YEAR_DAYS: Readonly<Record<Language, string>> = { id: '1 Jan – 31 Des', en: '1 Jan – 31 Dec' };

/**
 * **The campaigns' fixed words, in both languages** (P18.10-T5 AC-4): what a window reads as on the card and in the
 * dialog, and *Chasing MDRT*'s header tooltip. *MDRT* and *Campaign* stay as the glossary keeps them (§A.5, §A.6;
 * §C6: the name kept, the sentence around it translated); *Standing* is a standing programme, *Selalu aktif* as
 * §B.3 writes *Always on*; *mengejar* is to chase a campaign.
 */
const CAMPAIGN_WORDS = messages('domain/campaigns', {
  /**
   * `calendar_year`: verbatim where the prototype writes it (`Overall.html:7972`, `:8012`) but for its dates — a
   * figure, so the reader's (*1 Jan – 31 Des* where it wrote *Jan 1 – Dec 31*; ADR-0167 §1).
   */
  calendarYear: {
    en: (figures) => `Standing — evaluated per calendar year (${CALENDAR_YEAR_DAYS[figures]})`,
    id: `Selalu aktif — dinilai per tahun kalender (${CALENDAR_YEAR_DAYS.id})`,
  },
  /** `rolling_12m` (`Overall.html:7972`). */
  rolling12m: {
    en: 'Rolling 12-month window',
    id: 'Periode 12 bulan bergulir',
  },
  /** The tooltip's opening, ADR-0142 §3's words. */
  mdrtOpening: {
    en: 'Chasing MDRT (Million Dollar Round Table) this year',
    id: 'Mengejar MDRT (Million Dollar Round Table) tahun ini',
  },
  /** ADR-0142 §3, verbatim: *"Chasing MDRT (Million Dollar Round Table) this year. No MDRT campaign is running."* */
  mdrtNone: {
    en: 'No MDRT campaign is running.',
    id: 'Tidak ada campaign MDRT yang sedang berjalan.',
  },
});

/**
 * **What a window reads as on the card and in the dialog** — the two that are not a campaign's own dates, which are
 * composed in the office's calendar instead (`durationWords`).
 */
export const CAMPAIGN_DURATION_WORDS = {
  calendar_year: CAMPAIGN_WORDS.calendarYear,
  rolling_12m: CAMPAIGN_WORDS.rolling12m,
} as const satisfies Readonly<Record<Exclude<CampaignWindow, 'campaign_dates'>, Sentence<null>>>;

/**
 * *Chasing MDRT*'s header tooltip (OD-152 → option 3, D-18): the prototype's opening, then the office's MDRT
 * requirement in words — or, with no MDRT campaign running, saying so. *"…based on annual FYC pace"* is not
 * shipped: the ✓ is a chase, not a pace, and FYC is not in the file.
 */
export const MDRT_TOOLTIP = {
  OPENING: CAMPAIGN_WORDS.mdrtOpening,
  NONE: CAMPAIGN_WORDS.mdrtNone,
} as const;
