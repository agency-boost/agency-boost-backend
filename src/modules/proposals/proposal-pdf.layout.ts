import type { Content, CustomTableLayout, TDocumentDefinitions } from 'pdfmake/interfaces';
import { formatDate, formatRupiah, formatRupiahCompact } from '@/common/format/format';
import { PROPOSAL, type ProductCurrency, type ProposalChannel } from '@/domain/constants';
import { evaluateFormula } from '@/modules/products/proposal-formula';
import type { SnapshotBlock, SnapshotField } from './proposal-items';
import type { PdfBranding } from './proposal-branding';
import type { ProposalItemView, ProposalView } from './proposal.service';
import { PDF_WORDS as W } from './proposal-pdf.words';

/**
 * **The proposal's two A4 pages, as a document definition** (P19.7-T3 AC-4 to AC-7; ADR-0223). Pure: the proposal as
 * every route answers it, the agent, the insurer's name, the KPM's branding and a ruler in; `pdfmake`'s document out.
 * The builder (`proposal-pdf.builder.ts`) renders it and steps page 2's level down until the file is two pages (AC-6).
 *
 * - **Page 1, *Ringkasan*:** the logo and the date; the title and its line; a receipt row per product; *Total premi*
 *   while the switch is on; the agent as text.
 * - **Page 2, *Rincian*:** a block per product — its values, its benefits, its `pdfDetail` blocks — at the level asked
 *   for; then the disclaimer and *Langkah selanjutnya*, once.
 * - **Both:** *Dibuat dengan AgencyBoost*, 8 pt, grey. Everything else at least 11 pt.
 * - **Colours** (ADR-0223 §6): lines in the secondary; text in the `-ink` shades; body text the fixed navy; no status
 *   colour; no colour as a background.
 *
 * **What makes the two pages provable** (ADR-0223 §5). The catalogue bounds how many things a page holds (five products,
 * eight fields, four summary values, four benefits, eight rows a block). **How long each thing is, it bounds only
 * loosely** — a product's name may be 200 characters, a person's 120 — so each slot of page 1, and each value of page 2
 * at level D, is **given a number of lines**, measured with the font that draws it. Text that would run past them ends
 * in *…*. Real names and labels are far inside every slot, and nothing is cut short; the worst case is what the slots
 * are for, and a test lays it out.
 */

/** The data a file is built from (ADR-0222 §2): the proposal, and what is read live when the file is built. */
export interface PdfInput {
  proposal: ProposalView;
  /** The agent, read now from their profile and membership. A part they do not hold is `null` and left out. */
  agent: { name: string | null; code: string | null; phone: string | null };
  /** The company's name: **the disclaimer is the only place it is printed** (decision 5). */
  insurer: string;
  /** The document's author (ADR-0222 §6). */
  kpmName: string;
  branding: PdfBranding;
}

/** The three weights of Inter the file carries (ADR-0222 §3). */
export type PdfFace = 'regular' | 'semibold' | 'bold';

/** **A ruler**: how wide a text is set in one face and size, in points — the builder's, from the fonts themselves. */
export interface PdfMeasure { width(text: string, face: PdfFace, size: number): number }

/**
 * **Page 2's levels, from the most detail to the least** (ADR-0223 §5):
 *
 * | Level | Per product |
 * |---|---|
 * | A | the values, the benefits, every `pdfDetail` block |
 * | B | as A, without *Nilai tunai* — dropped first |
 * | C | the values and *Manfaat utama* only; then once *"Rincian lengkap di Ilustrasi Resmi"* |
 * | D | the values only, each on one line, and the same line |
 */
export const PDF_LEVELS = ['A', 'B', 'C', 'D'] as const;
export type PdfLevel = (typeof PDF_LEVELS)[number];

/** **Where page 2 starts** (ADR-0223 §5): one or two products at A, three or more at C. */
export function startLevelOf(items: number): PdfLevel {
  return items <= 2 ? 'A' : 'C';
}

/** The levels tried, in order, from where a proposal of this many products starts. */
export function levelsFrom(items: number): PdfLevel[] {
  return PDF_LEVELS.slice(PDF_LEVELS.indexOf(startLevelOf(items)));
}

/** Points in a millimetre. */
const MM = 72 / 25.4;

/** **The page's fixed measures** (ADR-0223 §1, §2, §3), in points. */
export const PDF_LAYOUT = {
  /** 15 mm on every side. */
  MARGIN: 15 * MM,
  /** The logo is drawn inside 45 × 12 mm, its proportions kept. */
  LOGO_BOX: [45 * MM, 12 * MM] as [number, number],
  TITLE_PT: 18,
  PREMIUM_PT: 16,
  NAME_PT: 13,
  /** **The fixed text colour** (ADR-0218 §7), navy: body text, whatever the KPM picks. */
  TEXT: '#1B2B4B',
  /** **The fixed muted grey** (`--color-muted`): labels and the footer. 6.4:1 on white. */
  MUTED: '#5F5E5A',
} as const;

/** The two families the builder registers: Inter 400 with its 700, and Inter 600 with its 700 (ADR-0222 §3). */
export const PDF_FONTS = { REGULAR: 'Inter', SEMIBOLD: 'InterSemiBold' } as const;

const { MARGIN, TEXT, MUTED } = PDF_LAYOUT;
const BODY = PROPOSAL.PDF_BODY_MIN_PT;
const SEMI = PDF_FONTS.SEMIBOLD;
/** The width text is set in: A4's 210 mm less both margins. */
const WIDTH = 595.28 - 2 * MARGIN;
/** Page 1's premium column. Its widest figure, *USD 10.000.000.000,00* at 16 pt, fits. */
const PREMIUM_COLUMN = 200;
const GAP = 12;
/** Page 1's left column: the type, the name, the insured. */
const LEFT_COLUMN = WIDTH - PREMIUM_COLUMN - GAP;
/** Two columns of *label · value* (pages 1 and 2), each less its cell's padding. */
const HALF = (WIDTH - GAP) / 2;
const ELLIPSIS = '…';

/** A table that draws no line, with the padding the two columns of values need and no more. */
const PLAIN_TABLE: CustomTableLayout = {
  hLineWidth: () => 0,
  vLineWidth: () => 0,
  paddingLeft: (i) => (i === 0 ? 0 : GAP / 2),
  paddingRight: (i, node) => (i < (node.table.widths?.length ?? 1) - 1 ? GAP / 2 : 0),
  paddingTop: () => 1,
  paddingBottom: () => 1,
};

// ------------------------------------------------------------------------------------------------ money and values

/** A money figure never breaks between its code and its number: the space in it is a no-break space. */
const unbroken = (money: string) => money.replace(/ /g, ' ');

/**
 * **A USD amount: always in full, with its code** (ADR-0209 §8; ADR-0223 §8) — *USD 1.250,00*, a thousands dot and a
 * decimal comma, from integer cents. Never compact, never converted.
 */
export function usdInFull(minor: number): string {
  const cents = Math.round(Math.abs(minor));
  const whole = Math.floor(cents / 100).toString().replace(/\B(?=(\d{3})+(?!\d))/g, '.');
  const rest = String(cents % 100).padStart(2, '0');
  return `${minor < 0 && cents > 0 ? '-' : ''}USD ${whole},${rest}`;
}

/** **A premium, *Total dibayar* and *Total premi*: in full, as a price is** (ADR-0174 §4) — *Rp 1.250.000*. */
export function moneyInFull(minor: number, currency: ProductCurrency): string {
  return unbroken(currency === 'USD' ? usdInFull(minor) : formatRupiah(minor, 'id'));
}

/** **A field's amount and a block's amount: compact** (§B.25) — *Rp 1 M*, *Rp 250 jt*; a USD amount still in full. */
export function moneyCompact(minor: number, currency: ProductCurrency): string {
  return unbroken(currency === 'USD' ? usdInFull(minor) : formatRupiahCompact(minor, {}, 'id'));
}

/** A field's label on this proposal: its syariah label on a *Syariah* proposal, where it has one (ADR-0221 §9). */
export function labelOf(field: Pick<SnapshotField, 'label' | 'labelSyariah'>, channel: ProposalChannel): string {
  return channel === 'syariah' && field.labelSyariah ? field.labelSyariah : field.label;
}

/** **A field's value as printed**: a choice's label, an amount compact, a fixed field's sentence; *–* when empty. */
export function valueOf(field: SnapshotField, item: Pick<ProposalItemView, 'fieldValues' | 'currency'>): string {
  if (field.type === 'fixed') return field.options[0]?.label ?? W.none;
  const value = item.fieldValues[field.key];
  if (field.type === 'chips') return typeof value === 'string' ? value : W.none;
  return typeof value === 'number' ? moneyCompact(value, item.currency) : W.none;
}

/**
 * **A `pdfDetail` row's value** (ADR-0225 §4; ADR-0223 §4): its formula worked out from the item's own money values, in
 * the item's currency — or its text. A formula that cannot be worked out (a value left empty, a division by zero)
 * writes *–*, never zero.
 */
export function detailValueOf(
  row: SnapshotBlock['rows'][number], item: Pick<ProposalItemView, 'fieldValues' | 'currency' | 'snapshot'>,
): string {
  if (row.formula) {
    const money: Record<string, number | null> = {};
    for (const field of item.snapshot.fields) {
      if (field.type !== 'money') continue;
      const value = item.fieldValues[field.key];
      money[field.key] = typeof value === 'number' ? value : null;
    }
    const minor = evaluateFormula(row.formula, money);
    return minor === null ? W.none : moneyCompact(minor, item.currency);
  }
  return row.text ?? W.none;
}

// ------------------------------------------------------------------------------------------------ slots

/**
 * **A text set in at most `lines` lines of `width`**, broken where a reader breaks it — between words, a word longer
 * than the line cut where it must — and the last line ended in *…* when the text runs past it. A text that fits comes
 * back as it was, its lines joined by line breaks.
 */
export function inLines(measure: PdfMeasure, text: string, face: PdfFace, size: number, width: number, lines: number): string {
  const room = width - 1; // a point's leeway, so the renderer never wraps a line this ruler kept
  const fits = (s: string) => measure.width(s, face, size) <= room;
  const out: string[] = [];
  // Ordinary spaces only: a money figure's no-break space keeps it whole on one line.
  let rest = text.replace(/[ \t\r\n]+/g, ' ').trim();
  while (rest && out.length < lines) {
    if (fits(rest)) {
      out.push(rest);
      rest = '';
      break;
    }
    // The longest run of whole words that fits; a single word too long for the line is cut by characters.
    const words = rest.split(' ');
    let take = 0;
    while (take < words.length && fits(words.slice(0, take + 1).join(' '))) take += 1;
    let line = words.slice(0, take).join(' ');
    let next = words.slice(take).join(' ');
    if (take === 0) {
      const chars = [...words[0]];
      let n = 1;
      while (n < chars.length && fits(chars.slice(0, n + 1).join(''))) n += 1;
      line = chars.slice(0, n).join('');
      next = [chars.slice(n).join(''), ...words.slice(1)].join(' ').trim();
    }
    out.push(line);
    rest = next;
  }
  if (rest) {
    let last = [...out[out.length - 1]];
    while (last.length > 0 && !fits(`${last.join('').trimEnd()}${ELLIPSIS}`)) last = last.slice(0, -1);
    out[out.length - 1] = `${last.join('').trimEnd()}${ELLIPSIS}`;
  }
  return out.join('\n');
}

/** Faces by family and weight, as the content asks for them. */
const FACE = { regular: { font: PDF_FONTS.REGULAR }, semibold: { font: SEMI }, bold: { font: PDF_FONTS.REGULAR, bold: true } } as const;

/** One context for a document: what it is built from, the ruler, and page 2's level. */
interface Draw { input: PdfInput; measure: PdfMeasure; level: PdfLevel }

/** A text in a slot of `lines` lines, styled as its face. */
function slot(d: Draw, text: string, face: PdfFace, size: number, width: number, lines: number, style: Record<string, unknown> = {}): Content {
  return { text: inLines(d.measure, text, face, size, width, lines), ...FACE[face], fontSize: size, ...style };
}

/**
 * **A label and its value, as runs**: the label muted, the value semibold in the body's colour. With `width`, the pair
 * is held to one line of it — the label given at most half when both will not fit, the value the rest.
 */
function pair(d: Draw, label: string, value: string, width?: number): Content[] {
  let [l, v] = [label, value];
  if (width !== undefined) {
    const gap = d.measure.width('  ', 'regular', BODY);
    const lw = d.measure.width(l, 'regular', BODY);
    const vw = d.measure.width(v, 'semibold', BODY);
    if (lw + gap + vw > width - 1) {
      // The label keeps all it needs up to half the line, more where the value leaves room; the value takes the rest.
      const labelRoom = Math.max(width / 2, width - gap - vw);
      if (lw > labelRoom - 1) l = inLines(d.measure, l, 'regular', BODY, labelRoom, 1);
      v = inLines(d.measure, v, 'semibold', BODY, width - gap - d.measure.width(l, 'regular', BODY), 1);
    }
  }
  return [{ text: `${l}  `, color: MUTED }, { text: v, font: SEMI }];
}

/** Pairs in two columns, row by row. */
function twoColumns(cells: Content[][], margin: [number, number, number, number]): Content {
  const body: Content[][] = [];
  for (let at = 0; at < cells.length; at += 2) {
    body.push([{ text: cells[at] }, cells[at + 1] ? { text: cells[at + 1] } : { text: '' }]);
  }
  return { table: { widths: ['*', '*'], body }, layout: PLAIN_TABLE, margin };
}

/** A line across the text's width, in the secondary colour (ADR-0223 §6: lines and rules). */
function rule(colour: string, width = 0.75, margin: [number, number, number, number] = [0, 0, 0, 0]): Content {
  return { canvas: [{ type: 'line', x1: 0, y1: 0, x2: WIDTH, y2: 0, lineWidth: width, lineColor: colour }], margin };
}

/** *"PRUWell Medical · Gold"*: the name the proposal shows, and its plan where the product has one. */
function nameAndPlan(item: Pick<ProposalItemView, 'name' | 'plan'>): string {
  return item.plan ? `${item.name} · ${item.plan}` : item.name;
}

function insuredOf(item: Pick<ProposalItemView, 'insured'>): string {
  return W.insured(item.insured.relation, item.insured.name, item.insured.age);
}

function premiumOf(item: Pick<ProposalItemView, 'premium'>): string {
  return item.premium.amountMinor === null ? W.none : moneyInFull(item.premium.amountMinor, item.premium.currency);
}

// ------------------------------------------------------------------------------------------------ page 1

function header(d: Draw): Content[] {
  const { proposal: p, branding: b } = d.input;
  const mark: Content = b.logo
    ? { image: 'logo', fit: PDF_LAYOUT.LOGO_BOX }
    // AgencyBoost's wordmark, as the shell draws it: the product's name, set in the fixed navy (ADR-0223 §3).
    : { text: W.wordmark, bold: true, fontSize: PDF_LAYOUT.NAME_PT + 3, color: TEXT };
  return [
    {
      columns: [
        { width: '*', stack: [mark] },
        { width: 'auto', text: formatDate(p.date, 'id'), color: MUTED, alignment: 'right', margin: [0, 2, 0, 0] },
      ],
      columnGap: GAP,
    },
    slot(d, W.title(p.client.name), 'bold', PDF_LAYOUT.TITLE_PT, WIDTH, 2, { color: b.secondaryInk, margin: [0, 12, 0, 0] }),
    slot(d, W.subtitle(p.client.age, p.channel, p.payFrequency), 'regular', BODY, WIDTH, 1, { margin: [0, 3, 0, 8] }),
    rule(b.secondary, 1.5),
  ];
}

/**
 * **One product as a receipt's line** (ADR-0223 §3 item 2): the type, the name and plan, who is insured on the left;
 * the premium large on the right with *Total dibayar* under it; then up to four summary values in two columns.
 */
function receiptRow(d: Draw, item: ProposalItemView): Content {
  const { proposal: p, branding: b } = d.input;
  const summary = item.snapshot.fields.filter((f) => f.showOnSummary).slice(0, PROPOSAL.SUMMARY_FIELDS_MAX);
  const cells = summary.map((field) => pair(d, labelOf(field, p.channel), valueOf(field, item), HALF - GAP / 2));
  return {
    unbreakable: true,
    margin: [0, 7, 0, 7],
    stack: [
      {
        columnGap: GAP,
        columns: [
          {
            width: '*',
            stack: [
              slot(d, item.snapshot.typeLabel.toUpperCase(), 'semibold', BODY, LEFT_COLUMN, 1, { color: b.primaryInk }),
              slot(d, nameAndPlan(item), 'bold', PDF_LAYOUT.NAME_PT, LEFT_COLUMN, 2, { margin: [0, 1, 0, 0] }),
              slot(d, `${W.insuredLabel}: ${insuredOf(item)}`, 'regular', BODY, LEFT_COLUMN, 1, { margin: [0, 1, 0, 0] }),
            ],
          },
          {
            width: PREMIUM_COLUMN,
            stack: [
              { text: W.premiumPer(p.channel, p.payFrequency), color: MUTED, alignment: 'right' },
              { text: premiumOf(item), bold: true, fontSize: PDF_LAYOUT.PREMIUM_PT, color: b.secondaryInk, alignment: 'right' },
              ...(item.totalPaid
                ? [slot(d, W.totalPaid(item.totalPaid.years, moneyInFull(item.totalPaid.amountMinor, item.currency)), 'regular', BODY, PREMIUM_COLUMN, 2, { alignment: 'right' })]
                : []),
            ],
          },
        ],
      },
      ...(cells.length > 0 ? [twoColumns(cells, [0, 4, 0, 0])] : []),
    ],
  };
}

/** ***Total premi***, one line per currency, never summed across (ADR-0223 §3 item 3). Only while the switch is on. */
function totals(d: Draw): Content[] {
  const { proposal: p, branding: b } = d.input;
  if (!p.showTotal || p.totals.length === 0) return [];
  return [{
    unbreakable: true,
    margin: [0, 8, 0, 0],
    columnGap: GAP,
    columns: [
      { width: '*', text: W.totalPremium(p.channel, p.payFrequency), font: SEMI, color: b.secondaryInk, margin: [0, 3, 0, 0] },
      {
        width: 'auto',
        stack: p.totals.map((t) => ({
          text: moneyInFull(t.amountMinor, t.currency), bold: true, fontSize: PDF_LAYOUT.PREMIUM_PT, color: b.secondaryInk, alignment: 'right' as const,
        })),
      },
    ],
  }];
}

/** **The agent, as text** (ADR-0223 §3 item 4): name, *Kode agen*, phone. A part the profile does not hold is left out. */
function agentLines(d: Draw): Content[] {
  const { name, code, phone } = d.input.agent;
  const second = [code ? W.agentCode(code) : null, phone].filter((part): part is string => !!part).join('   ·   ');
  const lines: Content[] = [
    ...(name ? [slot(d, name, 'semibold', BODY, WIDTH, 1)] : []),
    ...(second ? [slot(d, second, 'regular', BODY, WIDTH, 1, { margin: [0, 1, 0, 0] })] : []),
  ];
  return lines.length > 0 ? [{ unbreakable: true, margin: [0, 14, 0, 0], stack: lines }] : [];
}

function pageOne(d: Draw): Content[] {
  const { proposal: p, branding: b } = d.input;
  const rows = p.items.flatMap((item, at) => [...(at > 0 ? [rule(b.secondary)] : []), receiptRow(d, item)]);
  return [...header(d), ...rows, ...(p.items.length > 0 ? [rule(b.secondary)] : []), ...totals(d), ...agentLines(d)];
}

// ------------------------------------------------------------------------------------------------ page 2

/** The blocks a level keeps (ADR-0223 §5). */
function blocksAt(blocks: readonly SnapshotBlock[], level: PdfLevel): SnapshotBlock[] {
  if (level === 'A') return [...blocks];
  if (level === 'B') return blocks.filter((block) => block.block !== 'nilai_tunai');
  if (level === 'C') return blocks.filter((block) => block.block === 'manfaat');
  return [];
}

/**
 * **The values, as two columns of *label · value*** (ADR-0223 §4): *Tertanggung* and the premium first, then the
 * `showOnPdf` fields. At level D each is held to one line, which is what makes D always fit.
 */
function valuesOf(d: Draw, item: ProposalItemView): Content {
  const p = d.input.proposal;
  const width = d.level === 'D' ? HALF - GAP / 2 : undefined;
  const cells: Content[][] = [
    pair(d, W.insuredLabel, insuredOf(item), width),
    pair(d, W.premiumPer(p.channel, p.payFrequency), premiumOf(item), width),
    ...item.snapshot.fields.filter((f) => f.showOnPdf).map((field) => pair(d, labelOf(field, p.channel), valueOf(field, item), width)),
  ];
  return twoColumns(cells, [0, 3, 0, 0]);
}

function detailBlock(item: ProposalItemView, block: SnapshotBlock, b: PdfBranding): Content {
  return {
    margin: [0, 5, 0, 0],
    stack: [
      { text: W.block(block.block, block.notGuaranteed), font: SEMI, color: b.secondaryInk },
      {
        table: {
          widths: ['*', 'auto'],
          body: block.rows.map((row) => [
            { text: [{ text: row.label }, ...(row.note ? [{ text: `  ${row.note}`, color: MUTED }] : [])] },
            { text: detailValueOf(row, item), font: SEMI, alignment: 'right' as const },
          ]),
        },
        layout: PLAIN_TABLE,
        margin: [0, 1, 0, 0],
      },
    ],
  };
}

/** **One product's block on page 2**, never split across pages (ADR-0223 §4, §5). */
function detailOf(d: Draw, item: ProposalItemView): Content {
  const b = d.input.branding;
  const benefits = d.level === 'A' || d.level === 'B' ? item.snapshot.benefits.slice(0, PROPOSAL.BENEFITS_ON_PDF_MAX) : [];
  return {
    unbreakable: true,
    margin: [0, 6, 0, 6],
    stack: [
      slot(d, nameAndPlan(item), 'bold', PDF_LAYOUT.NAME_PT, WIDTH, d.level === 'D' ? 1 : 2, { color: b.secondaryInk }),
      valuesOf(d, item),
      ...(benefits.length > 0
        ? [{ margin: [0, 5, 0, 0] as [number, number, number, number], stack: [
          { text: W.benefits, font: SEMI, color: b.secondaryInk },
          { ul: benefits, margin: [0, 1, 0, 0] as [number, number, number, number] },
        ] }]
        : []),
      ...blocksAt(item.snapshot.pdfDetail, d.level).map((block) => detailBlock(item, block, b)),
    ],
  };
}

/** **The foot of page 2, once** (ADR-0223 §4): the line of levels C and D, the disclaimer, *Langkah selanjutnya*. */
function foot(d: Draw): Content {
  const { proposal: p, branding: b } = d.input;
  return {
    unbreakable: true,
    margin: [0, 8, 0, 0],
    stack: [
      ...(d.level === 'C' || d.level === 'D' ? [{ text: W.fullDetails, font: SEMI, margin: [0, 0, 0, 5] as [number, number, number, number] }] : []),
      slot(d, W.disclaimer(d.input.insurer, p.channel), 'regular', BODY, WIDTH, 3),
      { text: [{ text: `${W.nextSteps}: `, font: SEMI }, { text: W.steps }], color: b.secondaryInk, margin: [0, 5, 0, 0] },
    ],
  };
}

function pageTwo(d: Draw): Content[] {
  const { proposal: p, branding: b } = d.input;
  const blocks = p.items.flatMap((item, at) => [...(at > 0 ? [rule(b.secondary)] : []), detailOf(d, item)]);
  return [
    { text: W.details, bold: true, fontSize: PDF_LAYOUT.NAME_PT, color: b.secondaryInk },
    rule(b.secondary, 1.5, [0, 5, 0, 0]),
    ...blocks,
    ...(p.items.length > 0 ? [rule(b.secondary)] : []),
    foot(d),
  ];
}

// ------------------------------------------------------------------------------------------------ the document

/**
 * **The document at one level.** Page 1 is the content up to the break; page 2 starts with *Rincian*. The file's title is
 * *"Proposal untuk Bapak/Ibu {Nama}"*, its author the KPM's name, its producer *AgencyBoost*, and it names no insurer
 * (ADR-0222 §6). `createdAt` is the clock's: no date is read from the machine.
 */
export function proposalDocument(input: PdfInput, level: PdfLevel, measure: PdfMeasure, createdAt: Date): TDocumentDefinitions {
  const d: Draw = { input, measure, level };
  const b = input.branding;
  return {
    pageSize: 'A4',
    pageOrientation: 'portrait',
    pageMargins: [MARGIN, MARGIN, MARGIN, MARGIN],
    info: {
      title: W.title(input.proposal.client.name),
      author: input.kpmName,
      producer: W.producer,
      creator: W.producer,
      creationDate: createdAt,
    },
    defaultStyle: { font: PDF_FONTS.REGULAR, fontSize: BODY, color: TEXT, lineHeight: 1 },
    ...(b.logo ? { images: { logo: `data:image/png;base64,${b.logo.png.toString('base64')}` } } : {}),
    footer: () => ({
      text: W.footer, fontSize: PROPOSAL.PDF_FOOTER_PT, color: MUTED, margin: [MARGIN, MARGIN / 2, MARGIN, 0],
    }),
    content: [...pageOne(d), { stack: pageTwo(d), pageBreak: 'before' }],
  };
}

// ------------------------------------------------------------------------------------------------ the file's name

/**
 * **`Proposal-{Nama klien}-{tanggal}.pdf`** (ADR-0222 §6). The client's copy of the name with its accents taken off
 * (NFKD), every run of characters that are not letters or digits made one `-`, the `-` at either end removed, at most
 * `PROPOSAL.FILE_NAME_CLIENT_MAX` characters (and a `-` the cut leaves at the end removed too), *Klien* if nothing is
 * left; `{tanggal}` the proposal's date, which page 1 prints. `ascii` is the same with every character above 127 dropped,
 * for `filename=`; `name` is `filename*`'s.
 */
export function proposalFileName(clientName: string, date: string): { name: string; ascii: string } {
  const client = [...clientName
    .normalize('NFKD')
    .replace(/\p{M}+/gu, '')
    .replace(/[^\p{L}\p{N}]+/gu, '-')
    .replace(/^-+|-+$/g, '')]
    .slice(0, PROPOSAL.FILE_NAME_CLIENT_MAX)
    .join('')
    .replace(/-+$/, '') || 'Klien';
  const name = `Proposal-${client}-${date}.pdf`;
  // eslint-disable-next-line no-control-regex
  return { name, ascii: name.replace(/[^\x00-\x7F]/g, '') };
}

/** The `Content-Disposition` an attachment of this name answers with (RFC 6266, RFC 5987). */
export function dispositionOf(file: { name: string; ascii: string }): string {
  const encoded = encodeURIComponent(file.name).replace(/['()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
  return `attachment; filename="${file.ascii}"; filename*=UTF-8''${encoded}`;
}
