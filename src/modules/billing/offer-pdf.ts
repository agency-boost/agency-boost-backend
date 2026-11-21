import type { Content, TDocumentDefinitions } from 'pdfmake/interfaces';
import { formatDate, formatRupiah } from '@/common/format/format';
import { BILLING_ANNUAL_DISCOUNT_PCT, BILLING_BREAK_EVEN } from '@/domain/constants';
import { PDF_FONTS, proposalFileName } from '@/modules/proposals/proposal-pdf.layout';
import type { OfferPricing } from './price-offer';

/**
 * **The offer's PDF** (*Buat PDF*; P19.23-T5 AC-2; ADR-0279 §7): one A4 page in Bahasa Indonesia — the words the Owner
 * reads — built in memory from the server's figures and never kept. Drawn with the proposal's own fonts and renderer
 * (`renderPdf`, ADR-0222 §3), so no other file is reachable while it is made.
 *
 * Every sum is the server's (`priceOffer`); every money figure goes through the shared formatter, *Rp 64.125.000*, and
 * every date through the shared date, *20 Nov 2026*. The colours are the product's tokens, in the hex a PDF takes.
 */

/** `--color-navy`, `--color-amber-ink`, `--color-success`, `--color-muted`: the tokens, for a PDF that reads no CSS. */
const INK = { navy: '#1b2b4b', amber: '#a85e1b', success: '#3b6d11', muted: '#5f5e5a', line: '#e4e2dc', tint: '#fdf1e6' } as const;

/** What the PDF needs beyond the figures: who it is for, the dates, the note, today and the platform's number. */
export interface OfferPdfModel {
  pricing: OfferPricing;
  kpmName: string;
  companyName: string | null;
  startDate: string;
  endDate: string;
  note: string | null;
  /** The office's today, the day the offer is dated. */
  today: string;
  /** *Nomor WhatsApp pengirim* (Pengaturan platform), or `null` when none is set. */
  whatsappNumber: string | null;
}

const rp = (minor: number) => formatRupiah(minor, 'id');

/** Tenths of a policy as the calculator writes them: one decimal below ten, a whole number from ten (*8,0*, *11*). */
export function policies(tenths: number): string {
  if (tenths >= 100) return String(Math.floor((tenths + 5) / 10));
  return `${Math.floor(tenths / 10)},${tenths % 10}`;
}

/** The breakdown's lines, as the result card draws them: they sum to the total exactly. */
export function breakdownLines(p: OfferPricing): { label: string; value: string; minus?: boolean }[] {
  const lines: { label: string; value: string; minus?: boolean }[] = [];
  const { tier } = p;
  if (p.normalMinor !== null && tier.standardMinor !== null && p.normalMinor >= p.grossMinor) {
    lines.push({ label: `Harga normal (${p.leaders} × ${rp(tier.standardMinor)} × ${p.months})`, value: rp(p.normalMinor) });
    if (p.priceDiscountMinor > 0) {
      lines.push({ label: `Diskon harga → ${rp(p.rateMinor)}`, value: rp(p.priceDiscountMinor), minus: true });
    }
  } else {
    lines.push({ label: `${p.leaders} leader × ${rp(p.rateMinor)} × ${p.months} bln`, value: rp(p.grossMinor) });
  }
  if (p.annualDiscountMinor > 0) {
    lines.push({ label: `Hemat tahunan ${BILLING_ANNUAL_DISCOUNT_PCT}%`, value: rp(p.annualDiscountMinor), minus: true });
  }
  if (p.bulkDiscountMinor > 0) {
    lines.push({ label: 'Diskon bulk order', value: rp(p.bulkDiscountMinor), minus: true });
  }
  return lines;
}

/** The file's name: `Penawaran-{KPM}-{tanggal}.pdf`, ASCII and UTF-8, as the proposal names its own. */
export function offerFileName(kpmName: string, today: string): { name: string; ascii: string } {
  const named = proposalFileName(kpmName, today);
  return { name: named.name.replace(/^Proposal-/, 'Penawaran-'), ascii: named.ascii.replace(/^Proposal-/, 'Penawaran-') };
}

/** **The document** — pure, so its words are tested without rendering a file. */
export function offerDocument(model: OfferPdfModel): TDocumentDefinitions {
  const { pricing: p } = model;
  const period = p.plan === 'annual' ? 'Tahunan' : '6 bulan';
  const perPeriod = p.plan === 'annual' ? 'tahun' : '6 bulan';
  const income = p.breakEven.incomePerPolicyMinor;
  const b = BILLING_BREAK_EVEN;
  const ape = b.POLICY_APE_MINOR;

  const facts: [string, string][] = [
    ['Periode', period],
    ['Mulai – berakhir', `${formatDate(model.startDate, 'id')} – ${formatDate(model.endDate, 'id')}`],
    ['Jumlah leader', String(p.leaders)],
    ...(p.agents ? [['Jumlah agent', `${p.agents} (tidak ditagih)`] as [string, string]] : []),
    ['Harga / leader / bulan', p.tier.customPricing ? `${rp(p.rateMinor)} · harga khusus` : rp(p.rateMinor)],
  ];

  const tiles: [string, string][] = [
    [rp(p.perMonthMinor), 'per bulan'],
    [rp(p.perLeaderPerDayMinor), 'per leader / hari'],
    ...(p.perAgentPerDayMinor !== null ? [[rp(p.perAgentPerDayMinor), 'per agent / hari'] as [string, string]] : []),
  ];

  const content: Content[] = [
    { text: 'Penawaran langganan AgencyBoost', style: 'title' },
    {
      text: [
        { text: model.kpmName, bold: true },
        ...(model.companyName ? [` · ${model.companyName}`] : []),
        `  ·  ${formatDate(model.today, 'id')}`,
      ],
      margin: [0, 2, 0, 14],
      color: INK.muted,
    },
    {
      table: { widths: [150, '*'], body: facts.map(([label, value]) => [{ text: label, color: INK.muted }, { text: value, bold: true }]) },
      layout: 'noBorders',
      margin: [0, 0, 0, 14],
    },
    { text: `Total ${p.plan === 'annual' ? '1 tahun' : '6 bulan'}`, style: 'label' },
    ...(p.normalMinor !== null && p.normalMinor > p.totalMinor
      ? [{ text: [{ text: 'Harga normal  ', color: INK.muted }, { text: rp(p.normalMinor), decoration: 'lineThrough' as const, color: INK.muted }] }]
      : []),
    { text: rp(p.totalMinor), style: 'total' },
    ...(p.savingMinor > 0
      ? [{ text: `Hemat ${rp(p.savingMinor)} (${p.savingPct}%) dari harga standar`, color: INK.success, bold: true, margin: [0, 2, 0, 10] as [number, number, number, number] }]
      : [{ text: '', margin: [0, 0, 0, 8] as [number, number, number, number] }]),
    {
      table: {
        widths: tiles.map(() => '*'),
        body: [tiles.map(([value, label]) => ({
          stack: [{ text: value, bold: true, color: INK.amber, fontSize: 13 }, { text: label, color: INK.muted, fontSize: 9 }],
          margin: [6, 6, 6, 6],
        }))],
      },
      layout: { hLineColor: INK.line, vLineColor: INK.line },
      margin: [0, 0, 0, 14],
    },
    {
      table: {
        widths: ['*', 'auto'],
        body: [
          ...breakdownLines(p).map((line) => [
            { text: line.label, color: line.minus ? INK.success : INK.navy },
            { text: `${line.minus ? '− ' : ''}${line.value}`, alignment: 'right' as const, color: line.minus ? INK.success : INK.navy, bold: true },
          ]),
          [{ text: 'Total', bold: true }, { text: rp(p.totalMinor), bold: true, alignment: 'right' as const, color: INK.amber }],
        ],
      },
      layout: { hLineColor: INK.line, vLineWidth: () => 0 },
      margin: [0, 0, 0, 16],
    },
    {
      table: {
        widths: ['*'],
        body: [[{
          stack: [
            { text: 'BALIK MODAL JIKA 1 KPM JUAL TAMBAHAN', bold: true, color: INK.amber, fontSize: 10 },
            {
              text: `${policies(p.breakEven.policiesPerPeriodTenths)} polis / ${perPeriod}  ·  ${policies(p.breakEven.policiesPerMonthTenths)} polis / bulan`,
              bold: true, fontSize: 13, margin: [0, 4, 0, 4],
            },
            {
              text: `1 polis APE ${rp(ape)}: komisi ${b.COMMISSION_PCT}% ${rp(ape * b.COMMISSION_PCT / 100)} + overriding `
                + `${b.OVERRIDING_PCT}% ${rp(ape * b.OVERRIDING_PCT / 100)} + bonus ${b.BONUS_PCT}% ${rp(ape * b.BONUS_PCT / 100)} = ${rp(income)}`,
              fontSize: 9, color: INK.muted,
            },
          ],
          fillColor: INK.tint,
          margin: [8, 8, 8, 8],
        }]],
      },
      layout: 'noBorders',
      margin: [0, 0, 0, 14],
    },
    ...(model.note ? [{ text: [{ text: 'Catatan: ', bold: true }, model.note], margin: [0, 0, 0, 10] as [number, number, number, number] }] : []),
    { text: 'Harga per leader per bulan; agent di bawah leader tidak ditagih.', fontSize: 9, color: INK.muted },
  ];

  return {
    pageSize: 'A4',
    pageMargins: [48, 48, 48, 56],
    info: { title: `Penawaran langganan AgencyBoost · ${model.kpmName}` },
    defaultStyle: { font: PDF_FONTS.REGULAR, fontSize: 11, color: INK.navy, lineHeight: 1.25 },
    styles: {
      title: { font: PDF_FONTS.SEMIBOLD, fontSize: 18, bold: true },
      label: { fontSize: 10, color: INK.muted, bold: true },
      total: { fontSize: 26, bold: true, color: INK.amber },
    },
    content,
    footer: (current: number, count: number) => ({
      columns: [
        {
          text: model.whatsappNumber ? `AgencyBoost · WhatsApp ${model.whatsappNumber}` : 'AgencyBoost',
          fontSize: 9, color: INK.muted,
        },
        { text: `hal. ${current} / ${count}`, alignment: 'right', fontSize: 9, color: INK.muted },
      ],
      margin: [48, 16, 48, 0],
    }),
  };
}
