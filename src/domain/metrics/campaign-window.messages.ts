import {
  formatDayMonth, formatMonth, formatMonthName, formatMonthRange,
} from '@/common/format/format';
import { messages } from '@/common/i18n/sentence';
import type { Language } from '@/domain/constants/language';

/** *Jan – Des*: January to December, no year, in a language's figures — the formatter's range with its year dropped. */
const wholeYear = (figures: Language) => `${formatMonthName('2000-01', figures)} – ${formatMonthName('2000-12', figures)}`;

/**
 * **The words a campaign's window is written in, in both languages** (P18.98-T5 AC-4): the card's open-ended duration
 * and the Personal Summary row's *Runs …* line (P18.95-T7 AC-1, ADR-0167 §7). Every month and day in them is a
 * figure, written in the reader's figures (`common/format`); the words around them are the reader's language —
 * *Mulai* for *From*, *Berlangsung* for *Runs*.
 */
export const CAMPAIGN_WINDOW_MESSAGES = messages('domain/campaign-window', {
  /** A campaign with a start and no end: *From 1 Jul* — *Mulai 1 Jul*. */
  from: ({ day }: { day: string }) => ({
    en: (figures) => `From ${formatDayMonth(day, figures)}`,
    id: `Mulai ${formatDayMonth(day, 'id')}`,
  }),
  /** `calendar_year`: *Runs Jan – Des*, no year, because it runs every year. */
  runsEveryYear: {
    en: (figures) => `Runs ${wholeYear(figures)}`,
    id: `Berlangsung ${wholeYear('id')}`,
  },
  /** `rolling_12m`: its months move with every file the office holds, so it names how many. */
  runsRolling: ({ months }: { months: number }) => ({
    en: `Runs over the last ${months} months`,
    id: `Berlangsung selama ${months} bulan terakhir`,
  }),
  /** `campaign_dates` with no end: *Runs from Okt 2026*. */
  runsFrom: ({ month }: { month: string }) => ({
    en: (figures) => `Runs from ${formatMonth(month, figures)}`,
    id: `Berlangsung mulai ${formatMonth(month, 'id')}`,
  }),
  /** `campaign_dates`: the months its own dates touch — *Runs Agu – Okt 2026*, *Runs Okt 2026* for one. */
  runsMonths: ({ from, to }: { from: string; to: string }) => ({
    en: (figures) => `Runs ${formatMonthRange(from, to, figures)}`,
    id: `Berlangsung ${formatMonthRange(from, to, 'id')}`,
  }),
});
