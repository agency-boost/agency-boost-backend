import { formatDate, formatNumber, formatRupiah } from '@/common/format/format';
import { messages, type Sentence } from '@/common/i18n/sentence';

/**
 * **The quote a KPM's Owner receives** (P19.4-T3 AC-10; ADR-0211 §5): the printable quote's content as lines of plain
 * text for the email, and the inbox row's title and detail. Kept beside the renderer that writes it, as the member
 * invitation's words are. Every figure is the server's (`billing/price-quote.ts`), written in the reader's figures.
 */

/** The plan as the quote writes it. */
export const PLAN_WORDS = {
  six_months: { en: '6-month plan', id: 'Paket 6 bulan' },
  annual: { en: 'Annual plan', id: 'Paket tahunan' },
} as const;

/** **The quote the Owner receives** (ADR-0211 §5): the printable quote's content, as lines of plain text. */
export const QUOTE_WORDS = messages('modules/notifications: billing quote', {
  subject: ({ office }: { office: string }) => ({
    en: `Subscription quote for ${office}`,
    id: `Penawaran langganan untuk ${office}`,
  }),
  intro: ({ office }: { office: string }) => ({
    en: `AgencyBoost has prepared a subscription quote for ${office}. Its details are below.`,
    id: `AgencyBoost menyiapkan penawaran langganan untuk ${office}. Rinciannya di bawah ini.`,
  }),
  pic: ({ name }: { name: string }) => ({ en: `Person in charge (PIC): ${name}`, id: `Penanggung jawab (PIC): ${name}` }),
  /** `start` and `end` are office dates, `YYYY-MM-DD`, written in the reader's figures. */
  dates: ({ start, end }: { start: string; end: string }) => ({
    en: (figures) => `Plan start date: ${formatDate(start, figures)} · Plan end date: ${formatDate(end, figures)}`,
    id: `Tanggal mulai paket: ${formatDate(start, 'id')} · Tanggal berakhir paket: ${formatDate(end, 'id')}`,
  }),
  salesBy: ({ name }: { name: string }) => ({ en: `Sales input by: ${name}`, id: `Diisi oleh sales: ${name}` }),
  plan: ({ plan }: { plan: keyof typeof PLAN_WORDS }) => PLAN_WORDS[plan],
  tier: ({ range, custom }: { range: string; custom: boolean }) => ({
    en: `Tier: ${range} leaders${custom ? ' (custom)' : ''}`,
    id: `Tingkat: ${range} leaders${custom ? ' (khusus)' : ''}`,
  }),
  leaders: ({ n }: { n: number }) => ({
    en: (figures) => `Leaders on plan: ${formatNumber(n, undefined, figures)}`,
    id: `Jumlah leader dalam paket: ${formatNumber(n, undefined, 'id')}`,
  }),
  standard: ({ minor }: { minor: number }) => ({
    en: (figures) => `Standard price / leader / mo: ${formatRupiah(minor, figures)}`,
    id: `Harga standar / leader / bln: ${formatRupiah(minor, 'id')}`,
  }),
  offer: ({ minor }: { minor: number }) => ({
    en: (figures) => `Offering price / leader / mo: ${formatRupiah(minor, figures)}`,
    id: `Harga penawaran / leader / bln: ${formatRupiah(minor, 'id')}`,
  }),
  annualDiscount: ({ minor }: { minor: number }) => ({
    en: (figures) => `Annual discount: -${formatRupiah(minor, figures)}/leader/mo`,
    id: `Diskon tahunan: -${formatRupiah(minor, 'id')}/leader/bln`,
  }),
  manualDiscount: ({ minor }: { minor: number }) => ({
    en: (figures) => `Manual discount: -${formatRupiah(minor, figures)}/leader/mo`,
    id: `Diskon manual: -${formatRupiah(minor, 'id')}/leader/bln`,
  }),
  final: ({ minor }: { minor: number }) => ({
    en: (figures) => `Final price / leader / mo: ${formatRupiah(minor, figures)}`,
    id: `Harga akhir / leader / bln: ${formatRupiah(minor, 'id')}`,
  }),
  monthly: ({ minor }: { minor: number }) => ({
    en: (figures) => `Monthly total (all leaders): ${formatRupiah(minor, figures)}`,
    id: `Total bulanan (semua leader): ${formatRupiah(minor, 'id')}`,
  }),
  period: ({ minor, annual }: { minor: number; annual: boolean }) => ({
    en: (figures) => `${annual ? 'Annual' : '6-month'} total (all leaders): ${formatRupiah(minor, figures)}`,
    id: `Total ${annual ? 'tahunan' : '6 bulan'} (semua leader): ${formatRupiah(minor, 'id')}`,
  }),
  footer: {
    en: 'This quote is valid for the plan period shown above. Rate is locked for the duration of the subscription under '
      + "AgencyBoost's launch pricing, valid for signups before Mar 2027.",
    id: 'Penawaran ini berlaku untuk periode paket yang tercantum di atas. Tarif terkunci selama masa langganan dengan '
      + 'harga peluncuran AgencyBoost, berlaku untuk pendaftaran sebelum Mar 2027.',
  },
  reply: {
    en: 'To go ahead, or to ask about it, reply to this email or contact AgencyBoost.',
    id: 'Untuk melanjutkan, atau bertanya tentangnya, balas email ini atau hubungi AgencyBoost.',
  },
  // The inbox row: what came, and its total; the email carries the rest.
  noticeTitle: ({ office }: { office: string }) => ({
    en: `A subscription quote for ${office}`,
    id: `Penawaran langganan untuk ${office}`,
  }),
  noticeDetail: ({ plan, leaders, total }: { plan: keyof typeof PLAN_WORDS; leaders: number; total: number }) => ({
    en: (figures) => `${PLAN_WORDS[plan].en}, ${formatNumber(leaders, undefined, figures)} leaders: `
      + `${formatRupiah(total, figures)}. The details are in your email.`,
    id: `${PLAN_WORDS[plan].id}, ${formatNumber(leaders, undefined, 'id')} leader: ${formatRupiah(total, 'id')}. `
      + 'Rinciannya ada di email Anda.',
  }),
});

/** A number from the payload, or 0: the payload is the server's, so a missing figure is a defect, never a guess. */
const num = (payload: Record<string, unknown>, key: string) => (typeof payload[key] === 'number' ? payload[key] as number : 0);
const text = (payload: Record<string, unknown>, key: string) => (typeof payload[key] === 'string' ? payload[key] as string : '');
const planOf = (payload: Record<string, unknown>): keyof typeof PLAN_WORDS => (payload.plan === 'annual' ? 'annual' : 'six_months');

/**
 * **The quote, as the email's lines** (ADR-0211 §5): the dialog's names and dates, *Plan details*, *Discounts* when one
 * applies, *Final price*, the totals and the footer — the printed quote's sections, top to bottom.
 */
export function quoteEmailLines(
  payload: Record<string, unknown>,
  say: (sentence: Sentence) => string,
): string[] {
  const plan = planOf(payload);
  const annual = num(payload, 'annualDiscountMinor');
  const manual = num(payload, 'manualDiscountMinor');
  return [
    say(QUOTE_WORDS.intro({ office: text(payload, 'office') })),
    '',
    say(QUOTE_WORDS.pic({ name: text(payload, 'pic') })),
    say(QUOTE_WORDS.dates({ start: text(payload, 'startDate'), end: text(payload, 'endDate') })),
    say(QUOTE_WORDS.salesBy({ name: text(payload, 'salesBy') })),
    '',
    say(QUOTE_WORDS.plan({ plan })),
    say(QUOTE_WORDS.tier({ range: text(payload, 'tierRange'), custom: payload.customPricing === true })),
    say(QUOTE_WORDS.leaders({ n: num(payload, 'leaders') })),
    say(QUOTE_WORDS.standard({ minor: num(payload, 'standardMinor') })),
    say(QUOTE_WORDS.offer({ minor: num(payload, 'offerMinor') })),
    ...(annual > 0 ? [say(QUOTE_WORDS.annualDiscount({ minor: annual }))] : []),
    ...(manual > 0 ? [say(QUOTE_WORDS.manualDiscount({ minor: manual }))] : []),
    say(QUOTE_WORDS.final({ minor: num(payload, 'finalMinor') })),
    '',
    say(QUOTE_WORDS.monthly({ minor: num(payload, 'monthlyTotalMinor') })),
    say(QUOTE_WORDS.period({ minor: num(payload, 'periodTotalMinor'), annual: plan === 'annual' })),
    '',
    say(QUOTE_WORDS.footer),
    say(QUOTE_WORDS.reply),
  ];
}

/** **The inbox row** (ADR-0211 §5): what came, for which KPM, and its total; the email holds the rest. */
export function quoteNotice(
  payload: Record<string, unknown>,
  say: (sentence: Sentence) => string,
): { title: string; detail: string } {
  return {
    title: say(QUOTE_WORDS.noticeTitle({ office: text(payload, 'office') })),
    detail: say(QUOTE_WORDS.noticeDetail({
      plan: planOf(payload), leaders: num(payload, 'leaders'), total: num(payload, 'periodTotalMinor'),
    })),
  };
}
