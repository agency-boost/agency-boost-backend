import type { Content, TDocumentDefinitions } from 'pdfmake/interfaces';
import { PROPOSAL } from '@/domain/constants';
import { mix } from '@/domain/branding/palette';
import { agencyBoostLogo, artOf, iconOf, type ArtKind } from './proposal-pdf.art';
import type { PdfColours, PdfItem, PdfModel, PdfRow } from './proposal-pdf.model';
import { PDF_WORDS as W } from './proposal-pdf.words';

/**
 * **The proposal's pages, placed** (P19.14-T3 AC-1 to AC-5; ADR-0256 §1, §2, §4). Pure: a {@link PdfModel}, a density
 * and a ruler in; every word's place, every shape and the file's `pdfmake` definition out.
 *
 * **Set like the mockups, measured like a printer.** Every text is broken into its lines here, with the very fonts the
 * file is drawn in (the builder's ruler), and placed at an absolute point; every shape — the bands, the cards, the tiles,
 * the illustrations — is one SVG behind each page. So the layout knows, before anything is rendered, where each page
 * ends and whether it fits; `pdfmake` only draws it.
 *
 * - **One product: one page. Two or more: exactly two** (AC-1). The cards are page 1's and the boxes page 2's, so a
 *   product is never split; nothing is ever placed on a third page.
 * - **The fitting rule** ({@link fitProposal}): each page is laid out at its first density and moved to the next until
 *   it fits — fewer rows per box (*Nilai tunai* first, as the rows come most important first), tighter spacing, one line
 *   where two were allowed. The last density fits the worst case the catalogue allows, by test.
 * - **The sizes** (AC-2): {@link PDF_TYPE}, each at least its floor in `PROPOSAL` — body 12 pt, labels 10, product names
 *   15, premiums 18, the client's name 24 — and the dark text on white or a light tint.
 */

/** The three weights of Inter the file carries (ADR-0222 §3). */
export type PdfFace = 'regular' | 'semibold' | 'bold';

/** **A ruler**: how wide a text is in one face and size, and how tall a line of it — the builder's, from the fonts. */
export interface PdfMeasure {
  width(text: string, face: PdfFace, size: number): number;
  lineHeight(size: number): number;
}

/** The two families the builder registers: Inter 400 with its 700, and Inter 600 with its 700 (ADR-0222 §3). */
export const PDF_FONTS = { REGULAR: 'Inter', SEMIBOLD: 'InterSemiBold' } as const;

/** What a text is, for the size it must reach (AC-2). */
export type PdfTextRole = 'clientName' | 'productName' | 'premium' | 'body' | 'label';

/** **Each size the file sets, in points** (ADR-0256 §2) — the mockups' CSS pixels × 0.75, raised to the floors. */
export const PDF_TYPE = {
  CLIENT: 26, CLIENT_PAGE2: 24, BRAND: 16.5, BRAND_PAGE2: 13.5, KICKER: 10.5, TAG: 10,
  SECTION: 11.5, TILE_LABEL: 10, TILE_VALUE: 13, CHIP: 10.5,
  TOTAL_LABEL: 10.5, TOTAL: 26, TOTAL_LINE: 10, NEED: 12, NEED_STATE: 10,
  TYPE: 10, NAME: 15, NAME_HERO: 18, WHO: 12, PREMIUM: 18, PRICE_HERO: 26, PILL: 10.5, PER: 12, SOURCE: 10,
  ROW: 12, PROTECT_LABEL: 10, PROTECT: 18, FACT: 12,
  STEP_NUMBER: 12, STEP_TITLE: 13, STEP_TEXT: 12, STEP_PILL: 12, STEPS_LABEL: 10.5,
  DISCLAIMER: 12, AGENT_NAME: 15, AGENT_LINE: 12, AGENT_CTA: 12, INITIALS: 13.5,
  TIMELINE: 10, FOOTER: 10,
} as const;

/** The floor each role is held to (`PROPOSAL`). */
export const PDF_ROLE_MIN: Readonly<Record<PdfTextRole, number>> = {
  clientName: PROPOSAL.PDF_CLIENT_NAME_MIN_PT,
  productName: PROPOSAL.PDF_PRODUCT_NAME_MIN_PT,
  premium: PROPOSAL.PDF_PREMIUM_MIN_PT,
  body: PROPOSAL.PDF_BODY_MIN_PT,
  label: PROPOSAL.PDF_LABEL_MIN_PT,
};

/** Points in a millimetre. */
const MM = 72 / 25.4;
/** A4, in points. */
export const PAGE_W = 595.28;
export const PAGE_H = 841.89;
/** The mockups' 14 mm sides. */
const SIDE = 14 * MM;
const CW = PAGE_W - 2 * SIDE;
/** The footer's foot: 5 mm from the page's edge. */
const FOOT = 5 * MM;
/** The header's stripe in the second colour: the mockups' 5 px. */
const STRIPE = 3.75;
/** The agent's block, in the main colour, above the footer. */
const AGENT_H = 60;

/** **A density**: how much each page holds (ADR-0256 §1, the fitting rule). */
export interface PdfDensity {
  /** Rows a page-2 box keeps; on a one-product page, the card's rows. */
  rows: number;
  /** The vertical rhythm: 1 is the mockups', down to 0.6. */
  gap: number;
  /** Lines a product's name, the client's name, a tile's value and a fact may take. */
  lines: 1 | 2;
  /** *Langkah selanjutnya* as one line of pills rather than three cards (page 2). */
  stepsInLine: boolean;
}

/** One line of text at its place. */
export interface PdfRun {
  page: number;
  text: string;
  x: number;
  y: number;
  face: PdfFace;
  size: number;
  colour: string;
  /** Letter spacing, in points, between characters. */
  spacing: number;
  role: PdfTextRole;
}

/** Where a product is drawn: page 1's card, page 2's box, or the one-product card. */
export interface PdfBlock { item: number; page: number; top: number; bottom: number; where: 'card' | 'box' | 'hero' }

/** The KPM's logo, as an image at its place. */
export interface PdfPicture { page: number; x: number; y: number; w: number; h: number }

/** One page laid out: its background, its words, and how far past its room it runs (≤ 0 when it fits). */
interface LaidPage { svg: string; runs: PdfRun[]; pictures: PdfPicture[]; blocks: PdfBlock[]; over: number }

/** The file laid out. */
export interface PdfLayout {
  pages: LaidPage[];
  densities: PdfDensity[];
}

// ------------------------------------------------------------------------------------------------ measuring

const n2 = (v: number) => Math.round(v * 100) / 100;

/** A ruler with the letter spacing `pdfmake` adds between characters. */
function widthOf(m: PdfMeasure, text: string, face: PdfFace, size: number, spacing = 0): number {
  return m.width(text, face, size) + spacing * Math.max(0, [...text].length - 1);
}

const ELLIPSIS = '…';

/**
 * **A text in at most `lines` lines of `width`**, broken where a reader breaks it — between words, a word longer than the
 * line cut where it must — the last line ended in *…* when the text runs past them. A no-break space keeps a money figure
 * whole.
 */
export function inLines(
  m: PdfMeasure, text: string, face: PdfFace, size: number, width: number, lines: number, spacing = 0,
): string[] {
  const room = width - 1; // a point's leeway, so the renderer never disagrees with the ruler
  const fits = (s: string) => widthOf(m, s, face, size, spacing) <= room;
  const out: string[] = [];
  let rest = text.replace(/[ \t\r\n]+/g, ' ').trim();
  while (rest && out.length < lines) {
    if (fits(rest)) {
      out.push(rest);
      rest = '';
      break;
    }
    const words = rest.split(' ');
    let take = 0;
    while (take < words.length && fits(words.slice(0, take + 1).join(' '))) take += 1;
    let line = words.slice(0, take).join(' ');
    let next = words.slice(take).join(' ');
    if (take === 0) {
      const chars = [...words[0]];
      let k = 1;
      while (k < chars.length && fits(chars.slice(0, k + 1).join(''))) k += 1;
      line = chars.slice(0, k).join('');
      next = [chars.slice(k).join(''), ...words.slice(1)].join(' ').trim();
    }
    out.push(line);
    rest = next;
  }
  if (rest && out.length > 0) {
    let last = [...out[out.length - 1]];
    while (last.length > 0 && !fits(`${last.join('').trimEnd()}${ELLIPSIS}`)) last = last.slice(0, -1);
    out[out.length - 1] = `${last.join('').trimEnd()}${ELLIPSIS}`;
  }
  return out;
}

/** The largest size from `max` down to `min`, by half points, at which `text` fits `width` on one line. */
function sizeToFit(m: PdfMeasure, text: string, face: PdfFace, max: number, min: number, width: number): number {
  let size = max;
  while (size > min && widthOf(m, text, face, size) > width - 1) size -= 0.5;
  return size;
}

// ------------------------------------------------------------------------------------------------ a page

interface TextStyle { face: PdfFace; size: number; colour: string; role: PdfTextRole; spacing?: number }

interface Fill { fill?: string; stroke?: string; sw?: number; r?: number; dash?: string; opacity?: number }

/** One page's drawing: shapes into its SVG, words into runs. */
class Sheet {
  readonly shapes: string[] = [];
  readonly runs: PdfRun[] = [];
  readonly pictures: PdfPicture[] = [];
  readonly blocks: PdfBlock[] = [];

  constructor(readonly page: number, readonly m: PdfMeasure) {}

  lh(size: number): number {
    return this.m.lineHeight(size);
  }

  width(text: string, s: TextStyle): number {
    return widthOf(this.m, text, s.face, s.size, s.spacing ?? 0);
  }

  lines(text: string, s: TextStyle, width: number, lines: number): string[] {
    return inLines(this.m, text, s.face, s.size, width, lines, s.spacing ?? 0);
  }

  one(text: string, s: TextStyle, width: number): string {
    return this.lines(text, s, width, 1)[0] ?? '';
  }

  private attrs(f: Fill): string {
    return [
      `fill="${f.fill ?? 'none'}"`,
      f.stroke ? `stroke="${f.stroke}" stroke-width="${n2(f.sw ?? 1)}"` : '',
      f.dash ? `stroke-dasharray="${f.dash}"` : '',
      f.opacity !== undefined ? `opacity="${f.opacity}"` : '',
    ].filter(Boolean).join(' ');
  }

  rect(x: number, y: number, w: number, h: number, f: Fill): void {
    const r = f.r ? ` rx="${n2(Math.min(f.r, w / 2, h / 2))}"` : '';
    this.shapes.push(`<rect x="${n2(x)}" y="${n2(y)}" width="${n2(w)}" height="${n2(h)}"${r} ${this.attrs(f)}/>`);
  }

  /** A rectangle with each corner its own radius: top-left, top-right, bottom-right, bottom-left. */
  corners(x: number, y: number, w: number, h: number, [tl, tr, br, bl]: [number, number, number, number], f: Fill): void {
    const d = [
      `M${n2(x + tl)} ${n2(y)}`, `H${n2(x + w - tr)}`, tr ? `A${tr} ${tr} 0 0 1 ${n2(x + w)} ${n2(y + tr)}` : '',
      `V${n2(y + h - br)}`, br ? `A${br} ${br} 0 0 1 ${n2(x + w - br)} ${n2(y + h)}` : '',
      `H${n2(x + bl)}`, bl ? `A${bl} ${bl} 0 0 1 ${n2(x)} ${n2(y + h - bl)}` : '',
      `V${n2(y + tl)}`, tl ? `A${tl} ${tl} 0 0 1 ${n2(x + tl)} ${n2(y)}` : '', 'Z',
    ].filter(Boolean).join(' ');
    this.shapes.push(`<path d="${d}" ${this.attrs(f)}/>`);
  }

  circle(cx: number, cy: number, r: number, f: Fill): void {
    this.shapes.push(`<circle cx="${n2(cx)}" cy="${n2(cy)}" r="${n2(r)}" ${this.attrs(f)}/>`);
  }

  line(x1: number, y1: number, x2: number, y2: number, f: Fill): void {
    this.shapes.push(`<line x1="${n2(x1)}" y1="${n2(y1)}" x2="${n2(x2)}" y2="${n2(y2)}" ${this.attrs(f)}/>`);
  }

  /** Markup drawn for a `vw × vh` box, placed in `w × h` at (`x`, `y`). */
  place(markup: string, x: number, y: number, w: number, h: number, vw: number, vh: number): void {
    const k = (v: number) => Math.round(v * 10000) / 10000;
    this.shapes.push(`<g transform="translate(${n2(x)} ${n2(y)}) scale(${k(w / vw)} ${k(h / vh)})">${markup}</g>`);
  }

  raw(markup: string): void {
    this.shapes.push(markup);
  }

  text(text: string, x: number, y: number, s: TextStyle): number {
    if (!text) return 0;
    this.runs.push({ page: this.page, text, x: n2(x), y: n2(y), face: s.face, size: s.size, colour: s.colour, spacing: s.spacing ?? 0, role: s.role });
    return this.width(text, s);
  }

  right(text: string, xRight: number, y: number, s: TextStyle): void {
    this.text(text, xRight - this.width(text, s), y, s);
  }

  centre(text: string, cx: number, y: number, s: TextStyle): void {
    this.text(text, cx - this.width(text, s) / 2, y, s);
  }

  svg(): string {
    return `<svg xmlns="http://www.w3.org/2000/svg" width="${PAGE_W}" height="${PAGE_H}" viewBox="0 0 ${PAGE_W} ${PAGE_H}">${this.shapes.join('')}</svg>`;
  }
}

// ------------------------------------------------------------------------------------------------ the parts

const art = (s: Sheet, kind: ArtKind, c: PdfColours, x: number, y: number, w: number) =>
  s.place(artOf(kind, c.art), x, y, w, w * 0.75, 200, 150);

/** **The logo on its white circle** (AC-4): the KPM's square logo, its initials, or AgencyBoost's 3-dot mark. */
function mark(s: Sheet, model: PdfModel, x: number, y: number, d: number): void {
  const c = model.colours;
  const m = model.brand.mark;
  if (m.kind === 'initials') {
    s.circle(x + d / 2, y + d / 2, d / 2, { fill: c.avatarFill });
    const style: TextStyle = { face: 'bold', size: Math.max(PROPOSAL.PDF_LABEL_MIN_PT, n2(d * 0.3)), colour: c.avatarText, role: 'label' };
    const text = s.one(m.text, style, d * 0.9);
    s.centre(text, x + d / 2, y + (d - s.lh(style.size)) / 2, style);
    return;
  }
  s.circle(x + d / 2, y + d / 2, d / 2, { fill: '#ffffff' });
  if (m.kind === 'agencyboost') {
    const side = d * 0.7;
    s.place(agencyBoostLogo(), x + (d - side) / 2, y + (d - side) / 2, side, side, 64, 64);
    return;
  }
  // The logo inside the circle's square, its proportions kept.
  const box = d * 0.72;
  const scale = Math.min(box / Math.max(1, m.width), box / Math.max(1, m.height));
  const [w, h] = [m.width * scale, m.height * scale];
  s.pictures.push({ page: s.page, x: n2(x + (d - w) / 2), y: n2(y + (d - h) / 2), w: n2(w), h: n2(h) });
}

/** A section's title in the main colour, a hairline after it; the `y` under it. */
function section(s: Sheet, y: number, title: string, c: PdfColours, gap: number): number {
  const top = y + 14 * gap;
  const style: TextStyle = { face: 'bold', size: PDF_TYPE.SECTION, colour: c.band, role: 'label', spacing: 0.9 };
  const w = s.text(title.toUpperCase(), SIDE, top, style);
  const mid = top + s.lh(style.size) / 2;
  s.line(SIDE + w + 7.5, mid, SIDE + CW, mid, { stroke: c.tintStrong, sw: 1.1 });
  return top + s.lh(style.size) + 7 * gap;
}

/** A label and its value on one line of `w`: the label muted on the left, the value bold on the right. */
function row(s: Sheet, r: PdfRow, x: number, y: number, w: number, c: PdfColours): void {
  const size = PDF_TYPE.ROW;
  if (r.kind === 'benefit') {
    s.text(s.one(`✓ ${r.label}`, { face: 'regular', size, colour: c.ink, role: 'body' }, w), x, y, { face: 'regular', size, colour: c.ink, role: 'body' });
    return;
  }
  const label: TextStyle = { face: 'regular', size, colour: c.muted, role: 'body' };
  const value: TextStyle = { face: 'bold', size, colour: c.ink, role: 'body' };
  const gap = 9;
  const lw = s.width(r.label, label);
  const vw = s.width(r.value, value);
  let [l, v] = [r.label, r.value];
  if (lw + gap + vw > w - 1) {
    // The label keeps what it needs up to half the line, more where the value leaves room; the value the rest.
    const labelRoom = Math.max(w / 2, w - gap - vw);
    if (lw > labelRoom - 1) l = s.one(l, label, labelRoom);
    v = s.one(v, value, w - gap - s.width(l, label));
  }
  s.text(l, x, y, label);
  s.right(v, x + w, y, value);
}

/** **The header band** (AC-3): the logo, the name, the tagline and date, *DISIAPKAN KHUSUS UNTUK*, the client; the stripe. */
function hero(s: Sheet, model: PdfModel, picture: ArtKind, d: PdfDensity): number {
  const c = model.colours;
  const pad = 20;
  const markD = 40;
  const artW = 187;
  const artX = PAGE_W - 25.5 - artW;
  const textRight = artX - 8;
  const kicker: TextStyle = { face: 'semibold', size: PDF_TYPE.KICKER, colour: c.onBandSoft, role: 'label', spacing: 1.26 };
  const client: TextStyle = { face: 'bold', size: PDF_TYPE.CLIENT, colour: c.onBand, role: 'clientName' };
  const kickY = pad + markD + 14;
  const nameY = kickY + s.lh(kicker.size) + 2;
  const names = s.lines(model.client.title, client, textRight - SIDE, d.lines);
  const bandH = nameY + names.length * s.lh(client.size) + 18;

  // The band, its ring and its picture, held inside it; then the stripe.
  s.raw(`<defs><clipPath id="band1"><rect x="0" y="0" width="${PAGE_W}" height="${n2(bandH)}"/></clipPath></defs>`);
  s.raw('<g clip-path="url(#band1)">');
  s.rect(0, 0, PAGE_W, bandH, { fill: c.band });
  s.circle(PAGE_W - 20 * MM, 16 * MM, 41 * MM, { stroke: mix(c.band, '#ffffff', 0.06), sw: 18 * MM });
  art(s, picture, c, artX, 17, artW);
  s.raw('</g>');
  s.rect(0, bandH, PAGE_W, STRIPE, { fill: c.second });

  mark(s, model, SIDE, pad, markD);
  const bx = SIDE + markD + 9;
  const brand: TextStyle = { face: 'bold', size: PDF_TYPE.BRAND, colour: c.onBand, role: 'label' };
  const tag: TextStyle = { face: 'regular', size: PDF_TYPE.TAG, colour: c.onBandSoft, role: 'label' };
  const blockH = s.lh(brand.size) + 1 + s.lh(tag.size);
  const top = pad + (markD - blockH) / 2;
  s.text(s.one(model.brand.name, brand, textRight - bx), bx, top, brand);
  s.text(s.one(`${W.tagline} · ${model.date}`, tag, textRight - bx), bx, top + s.lh(brand.size) + 1, tag);
  s.text(W.preparedFor, SIDE, kickY, kicker);
  names.forEach((line, i) => s.text(line, SIDE, nameY + i * s.lh(client.size), client));
  return bandH + STRIPE;
}

/** ***Tentang Bapak/Ibu …*** (AC-3): the tiles, three a row, each only when filled; *Yang dibahas* with its chips. */
function about(s: Sheet, y: number, model: PdfModel, d: PdfDensity): number {
  const c = model.colours;
  const { tiles, needs } = model.client;
  if (tiles.length === 0 && needs.length === 0) return y;
  let at = section(s, y, W.about(model.client.short), c, d.gap);
  const label: TextStyle = { face: 'regular', size: PDF_TYPE.TILE_LABEL, colour: c.muted, role: 'label' };
  const value: TextStyle = { face: 'bold', size: PDF_TYPE.TILE_VALUE, colour: c.ink, role: 'body' };
  const gap = 6;
  const w = (CW - 2 * gap) / 3;
  const pad = 6;
  for (let from = 0; from < tiles.length; from += 3) {
    const row = tiles.slice(from, from + 3).map((t) => ({ t, lines: s.lines(t.value, value, w - 18, d.lines) }));
    const h = 2 * pad + s.lh(label.size) + 1.5 + Math.max(...row.map((r) => r.lines.length)) * s.lh(value.size);
    row.forEach(({ t, lines }, i) => {
      const x = SIDE + i * (w + gap);
      s.rect(x, at, w, h, { fill: c.tint, r: 9 });
      s.text(s.one(t.label, label, w - 18), x + 9, at + pad, label);
      lines.forEach((line, k) => s.text(line, x + 9, at + pad + s.lh(label.size) + 1.5 + k * s.lh(value.size), value));
    });
    at += h + (from + 3 < tiles.length ? gap : 0);
  }
  if (needs.length > 0) {
    if (tiles.length > 0) at += 6 * d.gap;
    const head: TextStyle = { face: 'regular', size: PDF_TYPE.CHIP, colour: c.muted, role: 'label' };
    const chip: TextStyle = { face: 'semibold', size: PDF_TYPE.CHIP, colour: c.ink, role: 'label' };
    const chipH = s.lh(chip.size) + 6;
    const x0 = SIDE + s.width(W.discussed, head) + 6;
    s.text(W.discussed, SIDE, at + 3, head);
    let x = x0;
    for (const need of needs) {
      const text = s.one(need, chip, SIDE + CW - x0 - 18);
      const cw = s.width(text, chip) + 18;
      if (x > x0 && x + cw > SIDE + CW) {
        x = x0;
        at += chipH + 4.5;
      }
      s.rect(x, at, cw, chipH, { fill: c.secondTint, r: chipH / 2 });
      s.text(text, x + 9, at + 3, chip);
      x += cw + 4.5;
    }
    at += chipH;
  }
  return at;
}

/** ***Ringkasan*** (AC-3): the total per period — with *Tampilkan total*, one *Cara bayar* and currency — and the need tiles. */
function summary(s: Sheet, y: number, model: PdfModel, d: PdfDensity): number {
  const c = model.colours;
  const sum = model.summary;
  if (!sum || (sum.tiles.length === 0 && !sum.total)) return y;
  const top = section(s, y, W.summary, c, d.gap);
  const need: TextStyle = { face: 'bold', size: PDF_TYPE.NEED, colour: c.bandOnTint, role: 'body' };
  const state: TextStyle = { face: 'regular', size: PDF_TYPE.NEED_STATE, colour: c.muted, role: 'label' };
  const tileMin = 14 + s.lh(need.size) + 1 + s.lh(state.size);
  const total = sum.total;
  const totW = total ? (CW - 9) / 2.25 : 0;
  const mapX = total ? SIDE + totW + 9 : SIDE;
  const mapW = total ? CW - totW - 9 : CW;
  const cols = total ? Math.min(2, Math.max(1, sum.tiles.length)) : Math.max(1, sum.tiles.length);
  const rows = Math.ceil(sum.tiles.length / cols);
  const mapH = rows > 0 ? rows * tileMin + (rows - 1) * 6 : 0;
  let blockH = mapH;
  if (total) {
    const label: TextStyle = { face: 'regular', size: PDF_TYPE.TOTAL_LABEL, colour: c.onBandSoft, role: 'label' };
    const amountSize = sizeToFit(s.m, total.amount, 'bold', PDF_TYPE.TOTAL, PROPOSAL.PDF_PREMIUM_MIN_PT, totW - 24);
    const amount: TextStyle = { face: 'bold', size: amountSize, colour: c.onBand, role: 'premium' };
    const line: TextStyle = { face: 'regular', size: PDF_TYPE.TOTAL_LINE, colour: c.onBandSoft, role: 'label' };
    const lines = total.lines.flatMap((l) => s.lines(l, line, totW - 24, 2)).slice(0, 3);
    const totH = 18 + s.lh(label.size) + 1 + s.lh(amount.size) + 1 + lines.length * s.lh(line.size);
    blockH = Math.max(totH, mapH);
    s.rect(SIDE, top, totW, blockH, { fill: c.band, r: 10.5 });
    let ty = top + (blockH - totH) / 2 + 9;
    s.text(s.one(total.label, label, totW - 24), SIDE + 12, ty, label);
    ty += s.lh(label.size) + 1;
    s.text(s.one(total.amount, amount, totW - 24), SIDE + 12, ty, amount);
    ty += s.lh(amount.size) + 1;
    lines.forEach((l, i) => s.text(l, SIDE + 12, ty + i * s.lh(line.size), line));
  }
  if (rows > 0) {
    const tileH = (blockH - (rows - 1) * 6) / rows;
    const tileW = (mapW - (cols - 1) * 6) / cols;
    sum.tiles.forEach((tile, i) => {
      const x = mapX + (i % cols) * (tileW + 6);
      const ty = top + Math.floor(i / cols) * (tileH + 6);
      s.rect(x, ty, tileW, tileH, { fill: tile.covered ? c.tint : c.grey, r: 9 });
      const icon = 19.5;
      s.place(iconOf(tile.icon, tile.covered ? c.band : c.muted), x + 9, ty + (tileH - icon) / 2, icon, icon, 24, 24);
      const tx = x + 9 + icon + 7;
      const tw = tileW - (tx - x) - 6;
      const inner = s.lh(need.size) + 1 + s.lh(state.size);
      const iy = ty + (tileH - inner) / 2;
      const head = { ...need, colour: tile.covered ? c.bandOnTint : c.muted };
      s.text(s.one(tile.label, head, tw), tx, iy, head);
      s.text(s.one(tile.state, state, tw), tx, iy + s.lh(need.size) + 1, state);
    });
  }
  return top + blockH;
}

/** **A product's card on page 1** (two products or more): its picture on a tinted strip, its name, who, the premium. */
function card(s: Sheet, y: number, item: PdfItem, index: number, c: PdfColours, d: PdfDensity): number {
  const pad = 7.5 * Math.max(d.gap, 0.6);
  const stripW = 69;
  const bodyX = SIDE + stripW + 12;
  const bodyR = SIDE + CW - 12;
  const type: TextStyle = { face: 'semibold', size: PDF_TYPE.TYPE, colour: c.secondInk, role: 'label', spacing: 1 };
  const name: TextStyle = { face: 'bold', size: PDF_TYPE.NAME, colour: c.ink, role: 'productName' };
  const who: TextStyle = { face: 'regular', size: PDF_TYPE.WHO, colour: c.muted, role: 'body' };
  const premium: TextStyle = { face: 'bold', size: PDF_TYPE.PREMIUM, colour: c.band, role: 'premium' };
  const pill: TextStyle = { face: 'regular', size: PDF_TYPE.PILL, colour: c.ink, role: 'label' };
  const premW = item.premium ? s.width(item.premium, premium) : 0;
  const pillText = s.one(item.pill, pill, (bodyR - bodyX) * 0.45 - 15);
  const pillW = s.width(pillText, pill) + 15;
  const pillH = s.lh(pill.size) + 5;
  const rightW = Math.max(premW, pillW);
  const leftW = bodyR - bodyX - rightW - 10.5;
  const names = s.lines(item.title, name, leftW, d.lines);
  const whos = s.lines(item.who, who, leftW, d.lines);
  const leftH = s.lh(type.size) + 2 + names.length * s.lh(name.size) + 1.5 + whos.length * s.lh(who.size);
  const rightH = (item.premium ? s.lh(premium.size) + 3 : 0) + pillH;
  const artW = d.gap >= 0.8 ? 61.5 : 52;
  const h = Math.max(leftH + 2 * pad, rightH + 2 * pad, artW * 0.75 + 9);

  s.rect(SIDE, y, CW, h, { fill: '#ffffff', r: 10.5 });
  s.corners(SIDE, y, stripW, h, [10.5, 0, 0, 10.5], { fill: c.tint });
  s.rect(SIDE + stripW - 3, y, 3, h, { fill: c.second });
  art(s, item.art, c, SIDE + (stripW - 3 - artW) / 2, y + 4.5, artW);
  s.rect(SIDE, y, CW, h, { stroke: c.tintStrong, sw: 1.1, r: 10.5 });

  let ty = y + pad;
  s.text(s.one(item.typeLabel, type, leftW), bodyX, ty, type);
  ty += s.lh(type.size) + 2;
  names.forEach((line, i) => s.text(line, bodyX, ty + i * s.lh(name.size), name));
  ty += names.length * s.lh(name.size) + 1.5;
  whos.forEach((line, i) => s.text(line, bodyX, ty + i * s.lh(who.size), who));

  let ry = y + pad;
  if (item.premium) {
    s.right(item.premium, bodyR, ry, premium);
    ry += s.lh(premium.size) + 3;
  }
  s.rect(bodyR - pillW, ry, pillW, pillH, { fill: c.secondTint, r: pillH / 2 });
  s.text(pillText, bodyR - pillW + 7.5, ry + 2.5, pill);
  s.blocks.push({ item: index, page: s.page, top: n2(y), bottom: n2(y + h), where: 'card' });
  return y + h;
}

/** **The one product's card** (one product): its picture, name and premium on a tint, then up to eight rows in two columns. */
function heroCard(s: Sheet, y: number, item: PdfItem, c: PdfColours, d: PdfDensity): number {
  const padX = 13.5;
  const padY = 10.5 * Math.max(d.gap, 0.6);
  const artW = 72;
  const type: TextStyle = { face: 'semibold', size: PDF_TYPE.TYPE, colour: c.secondInk, role: 'label', spacing: 1 };
  const name: TextStyle = { face: 'bold', size: PDF_TYPE.NAME_HERO, colour: c.ink, role: 'productName' };
  const who: TextStyle = { face: 'regular', size: PDF_TYPE.WHO, colour: c.muted, role: 'body' };
  const per: TextStyle = { face: 'regular', size: PDF_TYPE.PER, colour: c.muted, role: 'body' };
  const source: TextStyle = { face: 'regular', size: PDF_TYPE.SOURCE, colour: c.muted, role: 'label' };
  const priceSize = item.premium ? sizeToFit(s.m, item.premium, 'bold', PDF_TYPE.PRICE_HERO, PROPOSAL.PDF_PREMIUM_MIN_PT, 230) : 0;
  const price: TextStyle = { face: 'bold', size: priceSize, colour: c.bandOnTint, role: 'premium' };
  // Two points of leeway: a figure measured to fit is never cut by the ruler's own leeway.
  const rightW = Math.min(230, Math.max(item.premium ? s.width(item.premium, price) : 0, s.width(item.pill, per), s.width(item.source, source)) + 2);
  const textX = SIDE + padX + artW + 10.5;
  const leftW = SIDE + CW - padX - rightW - 12 - textX;
  const names = s.lines(item.title, name, leftW, d.lines);
  const leftH = s.lh(type.size) + 2 + names.length * s.lh(name.size) + 2 + s.lh(who.size);
  const rightH = (item.premium ? s.lh(priceSize) : 0) + s.lh(per.size) + 1 + s.lh(source.size);
  const headH = Math.max(artW * 0.75, leftH, rightH) + 2 * padY;

  const rows = item.rows.slice(0, d.rows);
  const perCol = Math.ceil(rows.length / 2);
  const rowH = s.lh(PDF_TYPE.ROW) + 6 * Math.max(d.gap, 0.7);
  const bodyH = rows.length > 0 ? 4.5 + perCol * rowH + 4.5 : 0;
  const h = headH + 3 + bodyH;

  s.rect(SIDE, y, CW, h, { fill: '#ffffff', r: 12 });
  s.corners(SIDE, y, CW, headH, [12, 12, 0, 0], { fill: c.tint });
  s.rect(SIDE, y + headH, CW, 3, { fill: c.second });
  art(s, item.art, c, SIDE + padX, y + (headH - artW * 0.75) / 2, artW);
  s.rect(SIDE, y, CW, h, { stroke: c.tintStrong, sw: 1.1, r: 12 });

  let ty = y + (headH - leftH) / 2;
  s.text(s.one(item.typeLabel, type, leftW), textX, ty, type);
  ty += s.lh(type.size) + 2;
  names.forEach((line, i) => s.text(line, textX, ty + i * s.lh(name.size), name));
  ty += names.length * s.lh(name.size) + 2;
  s.text(s.one(item.who, who, leftW), textX, ty, who);

  const xr = SIDE + CW - padX;
  let ry = y + (headH - rightH) / 2;
  if (item.premium) {
    s.right(s.one(item.premium, price, rightW), xr, ry, price);
    ry += s.lh(priceSize);
  }
  s.right(s.one(item.pill, per, rightW), xr, ry, per);
  ry += s.lh(per.size) + 1;
  s.right(s.one(item.source, source, rightW), xr, ry, source);

  const colW = (CW - 2 * padX - 16.5) / 2;
  rows.forEach((r, i) => {
    const col = i < perCol ? 0 : 1;
    const k = col === 0 ? i : i - perCol;
    const x = SIDE + padX + col * (colW + 16.5);
    const ry2 = y + headH + 3 + 4.5 + k * rowH;
    row(s, r, x, ry2 + (rowH - s.lh(PDF_TYPE.ROW)) / 2, colW, c);
    const last = col === 0 ? k === perCol - 1 : i === rows.length - 1;
    if (!last) s.line(x, ry2 + rowH, x + colW, ry2 + rowH, { stroke: c.tintStrong, sw: 0.75, dash: '2 2' });
  });
  s.blocks.push({ item: 0, page: s.page, top: n2(y), bottom: n2(y + h), where: 'hero' });
  return y + h;
}

/** ***Perlindungan Anda***: up to three amounts, large, on the main colour. */
function protection(s: Sheet, y: number, item: PdfItem, c: PdfColours, d: PdfDensity): number {
  const k = item.protection.length;
  if (k === 0) return y;
  const top = section(s, y, W.protection, c, d.gap);
  const w = (CW - (k - 1) * 7.5) / k;
  const label: TextStyle = { face: 'regular', size: PDF_TYPE.PROTECT_LABEL, colour: c.onBandSoft, role: 'label' };
  const sizes = item.protection.map((p) => sizeToFit(s.m, p.value, 'bold', PDF_TYPE.PROTECT, PROPOSAL.PDF_BODY_MIN_PT, w - 21));
  const valueSize = Math.min(...sizes);
  const value: TextStyle = { face: 'bold', size: valueSize, colour: c.onBand, role: 'body' };
  const h = 15 + s.lh(label.size) + 3 + s.lh(value.size);
  item.protection.forEach((p, i) => {
    const x = SIDE + i * (w + 7.5);
    s.rect(x, top, w, h, { fill: c.band, r: 10.5 });
    s.text(s.one(p.label, label, w - 21), x + 10.5, top + 7.5, label);
    s.text(s.one(p.value, value, w - 21), x + 10.5, top + 7.5 + s.lh(label.size) + 3, value);
  });
  return top + h;
}

/** ***Yang perlu diketahui***: two short facts. */
function facts(s: Sheet, y: number, item: PdfItem, c: PdfColours, d: PdfDensity): number {
  const k = item.facts.length;
  if (k === 0) return y;
  const top = section(s, y, W.goodToKnow, c, d.gap);
  const w = (CW - (k - 1) * 7.5) / k;
  const title: TextStyle = { face: 'bold', size: PDF_TYPE.FACT, colour: c.ink, role: 'body' };
  const text: TextStyle = { face: 'regular', size: PDF_TYPE.FACT, colour: c.ink, role: 'body' };
  const laid = item.facts.map((f) => ({ title: s.one(f.title, title, w - 19.5), lines: f.text ? s.lines(f.text, text, w - 19.5, d.lines) : [] }));
  const h = 14 + s.lh(title.size) + Math.max(...laid.map((f) => (f.lines.length > 0 ? 1 + f.lines.length * s.lh(text.size) : 0)));
  laid.forEach((f, i) => {
    const x = SIDE + i * (w + 7.5);
    s.rect(x, top, w, h, { fill: c.grey, r: 9 });
    s.text(f.title, x + 9.75, top + 7, title);
    f.lines.forEach((line, j) => s.text(line, x + 9.75, top + 7 + s.lh(title.size) + 1 + j * s.lh(text.size), text));
  });
  return top + h;
}

/** *LANGKAH: 1 · Diskusikan → 2 · Lengkapi data → 3 · Polis terbit*, one line of pills. */
function stepsInLine(s: Sheet, y: number, model: PdfModel, d: PdfDensity): number {
  const c = model.colours;
  const top = y + 14 * d.gap;
  const label: TextStyle = { face: 'semibold', size: PDF_TYPE.STEPS_LABEL, colour: c.muted, role: 'label', spacing: 0.6 };
  const pill: TextStyle = { face: 'bold', size: PDF_TYPE.STEP_PILL, colour: c.bandOnTint, role: 'body' };
  const arrow: TextStyle = { face: 'regular', size: PDF_TYPE.STEP_PILL, colour: c.muted, role: 'body' };
  const h = s.lh(pill.size) + 9;
  let x = SIDE + s.text(W.stepsLabel, SIDE, top + (h - s.lh(label.size)) / 2, label) + 9;
  model.steps.forEach((step, i) => {
    const text = `${i + 1} · ${step.title}`;
    const w = s.width(text, pill) + 18;
    s.rect(x, top, w, h, { fill: c.tint, r: 9 });
    s.text(text, x + 9, top + 4.5, pill);
    x += w;
    if (i < model.steps.length - 1) x += 6 + s.text('→', x + 6, top + 4.5, arrow) + 6;
  });
  return top + h;
}

/** ***Langkah selanjutnya*** as page 2 draws it: three cards, a number in the main colour, a title and a line. */
function stepCards(s: Sheet, y: number, model: PdfModel, d: PdfDensity): number {
  const c = model.colours;
  const top = section(s, y, W.nextSteps, c, d.gap);
  const w = (CW - 15) / 3;
  const title: TextStyle = { face: 'bold', size: PDF_TYPE.STEP_TITLE, colour: c.ink, role: 'body' };
  const text: TextStyle = { face: 'regular', size: PDF_TYPE.STEP_TEXT, colour: c.muted, role: 'body' };
  const num: TextStyle = { face: 'bold', size: PDF_TYPE.STEP_NUMBER, colour: c.onBand, role: 'body' };
  const disc = 22.5;
  const h = 15 + disc + 4 + s.lh(title.size) + 2 + 2 * s.lh(text.size);
  model.steps.forEach((step, i) => {
    const x = SIDE + i * (w + 7.5);
    s.rect(x, top, w, h, { fill: c.tint, r: 10.5 });
    s.circle(x + 10.5 + disc / 2, top + 7.5 + disc / 2, disc / 2, { fill: c.band });
    s.centre(String(i + 1), x + 10.5 + disc / 2, top + 7.5 + (disc - s.lh(num.size)) / 2, num);
    const ty = top + 7.5 + disc + 4;
    s.text(s.one(step.title, title, w - 21), x + 10.5, ty, title);
    s.lines(step.text, text, w - 21, 2).forEach((line, j) => s.text(line, x + 10.5, ty + s.lh(title.size) + 2 + j * s.lh(text.size), text));
  });
  return top + h;
}

/** **The disclaimer**, naming the insurer, a second-colour edge on its left. */
function disclaimer(s: Sheet, y: number, model: PdfModel, d: PdfDensity): number {
  const c = model.colours;
  const top = y + 11 * d.gap;
  const style: TextStyle = { face: 'regular', size: PDF_TYPE.DISCLAIMER, colour: c.muted, role: 'body' };
  const lines = s.lines(model.disclaimer, style, CW - 12, 3);
  const step = s.lh(style.size) * 1.1;
  const h = lines.length * step;
  s.rect(SIDE, top, 3, h, { fill: c.second });
  lines.forEach((line, i) => s.text(line, SIDE + 12, top + i * step, style));
  return top + h;
}

/** Where the agent's block starts: above the footer. */
const agentTop = (m: PdfMeasure) => PAGE_H - FOOT - m.lineHeight(PDF_TYPE.FOOTER) - 9 - AGENT_H;

/** **The agent** (AC-3), in the main colour: initials, name, *Agen · Kode … · phone*, *Hubungi saya untuk diskusi*. */
function agentBlock(s: Sheet, model: PdfModel): void {
  const a = model.agent;
  if (!a) return;
  const c = model.colours;
  const y = agentTop(s.m);
  s.rect(SIDE, y, CW, AGENT_H, { fill: c.band, r: 12 });
  const disc = 39;
  const ax = SIDE + 13.5;
  if (a.initials) {
    s.circle(ax + disc / 2, y + AGENT_H / 2, disc / 2, { fill: c.avatarFill });
    const initials: TextStyle = { face: 'bold', size: PDF_TYPE.INITIALS, colour: c.avatarText, role: 'label' };
    s.centre(a.initials, ax + disc / 2, y + (AGENT_H - s.lh(initials.size)) / 2, initials);
  }
  const cta: TextStyle = { face: 'regular', size: PDF_TYPE.AGENT_CTA, colour: c.onBand, role: 'body' };
  const ctaW = Math.max(...a.cta.map((l) => s.width(l, cta))) + 21;
  const ctaH = 2 * s.lh(cta.size) + 9;
  const cx = SIDE + CW - 13.5 - ctaW;
  const cy = y + (AGENT_H - ctaH) / 2;
  s.rect(cx, cy, ctaW, ctaH, { fill: c.bandLift, r: ctaH / 2 });
  a.cta.forEach((line, i) => s.centre(line, cx + ctaW / 2, cy + 4.5 + i * s.lh(cta.size), cta));
  const tx = ax + (a.initials ? disc + 10.5 : 0);
  const tw = cx - 9 - tx;
  const name: TextStyle = { face: 'bold', size: PDF_TYPE.AGENT_NAME, colour: c.onBand, role: 'body' };
  const line: TextStyle = { face: 'regular', size: PDF_TYPE.AGENT_LINE, colour: c.onBandSoft, role: 'body' };
  const blockH = (a.name ? s.lh(name.size) + 1 : 0) + s.lh(line.size);
  let ty = y + (AGENT_H - blockH) / 2;
  if (a.name) {
    s.text(s.one(a.name, name, tw), tx, ty, name);
    ty += s.lh(name.size) + 1;
  }
  s.text(s.one(a.line, line, tw), tx, ty, line);
}

/** **The footer**: the KPM's name (or AgencyBoost's), who prepared it where the agent's block is not on the page; the page. */
function footer(s: Sheet, model: PdfModel, pages: number, withAgent: boolean): void {
  const style: TextStyle = { face: 'regular', size: PDF_TYPE.FOOTER, colour: model.colours.muted, role: 'label' };
  const y = PAGE_H - FOOT - s.lh(style.size);
  const page = W.page(s.page, pages);
  const pw = s.width(page, style);
  s.right(page, SIDE + CW, y, style);
  const left = withAgent || !model.footer.preparedBy || !model.agent ? model.footer.name : `${model.footer.name} · ${model.footer.preparedBy}`;
  s.text(s.one(left, style, CW - pw - 12), SIDE, y, style);
}

/** The bottom a page's flowing content must stay above: the agent's block, or the footer. */
function roomOf(m: PdfMeasure, withAgent: boolean): number {
  return withAgent ? agentTop(m) - 6 : PAGE_H - FOOT - m.lineHeight(PDF_TYPE.FOOTER) - 10;
}

// ------------------------------------------------------------------------------------------------ the pages

/** **Page 1 of a one-product file** — everything on one page (AC-1, AC-3). */
export function layOnePage(model: PdfModel, d: PdfDensity, m: PdfMeasure): LaidPage {
  const s = new Sheet(1, m);
  const item = model.items[0];
  const c = model.colours;
  let y = hero(s, model, item ? item.art : 'family', d);
  y = about(s, y, model, d);
  if (item) {
    y = section(s, y, W.programs, c, d.gap);
    y = heroCard(s, y, item, c, d);
    y = protection(s, y, item, c, d);
    y = facts(s, y, item, c, d);
  }
  y = stepsInLine(s, y, model, d);
  y = disclaimer(s, y, model, d);
  agentBlock(s, model);
  footer(s, model, PROPOSAL.PDF_PAGES_ONE_PRODUCT, true);
  return { svg: s.svg(), runs: s.runs, pictures: s.pictures, blocks: s.blocks, over: n2(y - roomOf(m, Boolean(model.agent))) };
}

/** **Page 1 of a file of two products or more**: the header, *Tentang*, *Ringkasan*, a card per product (AC-3). */
export function layFirstPage(model: PdfModel, d: PdfDensity, m: PdfMeasure): LaidPage {
  const s = new Sheet(1, m);
  const c = model.colours;
  let y = hero(s, model, 'family', d);
  y = about(s, y, model, d);
  y = summary(s, y, model, d);
  y = section(s, y, W.programs, c, d.gap);
  model.items.forEach((item, i) => {
    y = card(s, y + (i > 0 ? 6 * Math.max(d.gap, 0.6) : 0), item, i, c, d);
  });
  footer(s, model, PROPOSAL.PDF_PAGES, false);
  return { svg: s.svg(), runs: s.runs, pictures: s.pictures, blocks: s.blocks, over: n2(y - roomOf(m, false)) };
}

/** A page-2 box's parts, measured: what it draws and how tall it is. */
function boxOf(s: Sheet, item: PdfItem, w: number, c: PdfColours, d: PdfDensity) {
  const pad = 9 * Math.max(d.gap, 0.6);
  const padX = 10.5;
  const title: TextStyle = { face: 'bold', size: PDF_TYPE.NAME, colour: c.ink, role: 'productName' };
  const titleW = w - 2 * padX - 48 - 7.5;
  const names = s.lines(item.name, title, titleW, d.lines);
  const sub = item.subtitle ? s.one(item.subtitle, title, titleW) : null;
  const headH = Math.max(36, (names.length + (sub ? 1 : 0)) * s.lh(title.size));
  const timeline = item.timeline && d.rows >= 5 ? item.timeline : null;
  const rows = item.rows.slice(0, Math.max(0, d.rows - (timeline ? 3 : 0)));
  const rowH = s.lh(PDF_TYPE.ROW) + 7 * Math.max(d.gap, 0.7);
  const hasValues = Boolean(timeline?.some((t) => t.value));
  const tlH = timeline ? s.lh(PDF_TYPE.ROW) + 4 + 18 + s.lh(PDF_TYPE.TIMELINE) + (hasValues ? s.lh(PDF_TYPE.TIMELINE) : 0) : 0;
  const srcH = 4 + s.lh(PDF_TYPE.SOURCE);
  const h = 2 * pad + headH + 4.5 + rows.length * rowH + tlH + srcH;
  return { pad, padX, title, names, sub, headH, timeline, rows, rowH, hasValues, h };
}

/** **A product's box on page 2** (AC-3): picture and name, its rows, the education timeline, where its premium comes from. */
function box(s: Sheet, x: number, y: number, w: number, h: number, item: PdfItem, index: number, c: PdfColours, d: PdfDensity): void {
  const b = boxOf(s, item, w, c, d);
  s.rect(x, y, w, h, { fill: '#ffffff', stroke: c.tintStrong, sw: 1.1, r: 10.5 });
  art(s, item.art, c, x + b.padX, y + b.pad, 48);
  const tx = x + b.padX + 48 + 7.5;
  const lines = [...b.names, ...(b.sub ? [b.sub] : [])];
  const ty0 = y + b.pad + (b.headH - lines.length * s.lh(b.title.size)) / 2;
  lines.forEach((line, i) => s.text(line, tx, ty0 + i * s.lh(b.title.size), b.title));
  let ry = y + b.pad + b.headH + 4.5;
  const iw = w - 2 * b.padX;
  b.rows.forEach((r, i) => {
    row(s, r, x + b.padX, ry + (b.rowH - s.lh(PDF_TYPE.ROW)) / 2, iw, c);
    ry += b.rowH;
    if (i < b.rows.length - 1 || b.timeline) s.line(x + b.padX, ry, x + w - b.padX, ry, { stroke: c.tintStrong, sw: 0.75, dash: '2 2' });
  });
  if (b.timeline) {
    const caption: TextStyle = { face: 'regular', size: PDF_TYPE.ROW, colour: c.muted, role: 'body' };
    const stage: TextStyle = { face: 'regular', size: PDF_TYPE.TIMELINE, colour: c.muted, role: 'label' };
    const pct: TextStyle = { face: 'bold', size: PDF_TYPE.TIMELINE, colour: c.ink, role: 'label' };
    s.text(s.one(W.timeline, caption, iw), x + b.padX, ry + 3, caption);
    const railY = ry + 3 + s.lh(caption.size) + 4 + 9;
    s.rect(x + b.padX + iw * 0.02, railY - 1.9, iw * 0.96, 3.75, { fill: c.tintStrong, r: 1.9 });
    const count = b.timeline.length;
    b.timeline.forEach((t, i) => {
      const cx = x + b.padX + iw * (0.08 + (count > 1 ? (i * 0.84) / (count - 1) : 0));
      s.circle(cx, railY, 7.5, { fill: c.second });
      s.circle(cx, railY, 6.4, { fill: '#ffffff' });
      s.circle(cx, railY, 4.1, { fill: c.second });
      const slot = (iw * 0.84) / Math.max(1, count - 1);
      const label = s.one(t.label, stage, slot);
      s.centre(label, cx, railY + 9, stage);
      if (t.value) s.centre(s.one(t.value, pct, slot), cx, railY + 9 + s.lh(stage.size), pct);
    });
  }
  const src: TextStyle = { face: 'regular', size: PDF_TYPE.SOURCE, colour: c.muted, role: 'label' };
  s.text(s.one(item.source, src, iw), x + b.padX, y + h - b.pad - s.lh(src.size), src);
  s.blocks.push({ item: index, page: s.page, top: n2(y), bottom: n2(y + h), where: 'box' });
}

/** **Page 2, *Rincian program*** (AC-3): the thinner band, a box per product two a row, the steps, the disclaimer, the agent. */
export function laySecondPage(model: PdfModel, d: PdfDensity, m: PdfMeasure): LaidPage {
  const s = new Sheet(2, m);
  const c = model.colours;
  const kicker: TextStyle = { face: 'semibold', size: PDF_TYPE.KICKER, colour: c.onBandSoft, role: 'label', spacing: 1.05 };
  const client: TextStyle = { face: 'bold', size: PDF_TYPE.CLIENT_PAGE2, colour: c.onBand, role: 'clientName' };
  const brand: TextStyle = { face: 'bold', size: PDF_TYPE.BRAND_PAGE2, colour: c.onBand, role: 'label' };
  const bandH = 20 + s.lh(kicker.size) + 2 + s.lh(client.size) + 16;
  s.rect(0, 0, PAGE_W, bandH, { fill: c.band });
  s.rect(0, bandH, PAGE_W, STRIPE, { fill: c.second });
  const markD = 33;
  const name = s.one(model.brand.name, brand, 190);
  const groupW = markD + 9 + s.width(name, brand);
  const gx = SIDE + CW - groupW;
  mark(s, model, gx, bandH / 2 - markD / 2, markD);
  s.text(name, gx + markD + 9, bandH / 2 - s.lh(brand.size) / 2, brand);
  s.text(W.details, SIDE, 20, kicker);
  s.text(s.one(model.client.title, client, gx - 12 - SIDE), SIDE, 20 + s.lh(kicker.size) + 2, client);

  let y = bandH + STRIPE + 17 * d.gap;
  const gap = 7.5;
  const w = (CW - gap) / 2;
  for (let at = 0; at < model.items.length; at += 2) {
    const pair = model.items.slice(at, at + 2);
    const h = Math.max(...pair.map((item) => boxOf(s, item, w, c, d).h));
    pair.forEach((item, i) => box(s, SIDE + i * (w + gap), y, w, h, item, at + i, c, d));
    y += h + (at + 2 < model.items.length ? gap : 0);
  }
  y = d.stepsInLine ? stepsInLine(s, y, model, d) : stepCards(s, y, model, d);
  y = disclaimer(s, y, model, d);
  agentBlock(s, model);
  footer(s, model, PROPOSAL.PDF_PAGES, true);
  return { svg: s.svg(), runs: s.runs, pictures: s.pictures, blocks: s.blocks, over: n2(y - roomOf(m, Boolean(model.agent))) };
}

// ------------------------------------------------------------------------------------------------ fitting

/**
 * **The densities a page is tried at, in order** (ADR-0256 §1): the mockups' first; then fewer rows, a tighter rhythm,
 * one line where two were allowed. Page 2 starts at `PDF_BOX_ROWS_FEW` (7) rows a box with two products and
 * `PDF_BOX_ROWS_MANY` (5) with more — *Nilai tunai*, the last row, the first to go.
 */
export function densitiesFor(page: 'one' | 'first' | 'second', items: number): PdfDensity[] {
  const roomy = (rows: number): PdfDensity => ({ rows, gap: 1, lines: 2, stepsInLine: false });
  const tight = (rows: number, gap: number): PdfDensity => ({ rows, gap, lines: 1, stepsInLine: true });
  if (page === 'one') {
    const max = PROPOSAL.PDF_HERO_ROWS_MAX;
    return [{ ...roomy(max), stepsInLine: true }, { ...roomy(6), stepsInLine: true }, tight(6, 0.8), tight(4, 0.8), tight(2, 0.6), tight(0, 0.6)];
  }
  if (page === 'first') return [roomy(0), { ...roomy(0), gap: 0.8 }, tight(0, 0.8), tight(0, 0.6)];
  const start = items <= 2 ? PROPOSAL.PDF_BOX_ROWS_FEW : PROPOSAL.PDF_BOX_ROWS_MANY;
  const out: PdfDensity[] = [];
  for (let rows = start; rows >= 3; rows -= 1) out.push(roomy(rows));
  for (let rows = Math.min(start, PROPOSAL.PDF_BOX_ROWS_MANY); rows >= 1; rows -= 1) out.push(tight(rows, 0.7));
  return out;
}

/** The first density at which a page fits, laid out; `null` when none does. */
function firstFit(lay: (d: PdfDensity) => LaidPage, densities: PdfDensity[]): { page: LaidPage; density: PdfDensity } | null {
  for (const density of densities) {
    const page = lay(density);
    if (page.over <= 0) return { page, density };
  }
  return null;
}

/**
 * **The file laid out at the most it holds** (AC-1): one page for one product, two for more — each page at its first
 * density that fits. `null` when a page fits at none, which the builder refuses rather than print a third page.
 */
export function fitProposal(model: PdfModel, m: PdfMeasure): PdfLayout | null {
  if (model.items.length <= 1) {
    const one = firstFit((d) => layOnePage(model, d, m), densitiesFor('one', model.items.length));
    return one ? { pages: [one.page], densities: [one.density] } : null;
  }
  const first = firstFit((d) => layFirstPage(model, d, m), densitiesFor('first', model.items.length));
  const second = firstFit((d) => laySecondPage(model, d, m), densitiesFor('second', model.items.length));
  return first && second ? { pages: [first.page, second.page], densities: [first.density, second.density] } : null;
}

// ------------------------------------------------------------------------------------------------ the document

const FACE = {
  regular: { font: PDF_FONTS.REGULAR },
  semibold: { font: PDF_FONTS.SEMIBOLD },
  bold: { font: PDF_FONTS.REGULAR, bold: true },
} as const;

/**
 * **The `pdfmake` definition of a laid-out file.** Each page's shapes are its background, one SVG; each word an
 * absolutely placed line that never wraps; the KPM's logo an image. Page 2's first word breaks the page.
 *
 * **The file's metadata** (ADR-0222 §6; ADR-0256 §5): its title *"Proposal untuk {Bapak/Ibu} {Nama}"*, its author the
 * KPM's name, its producer and creator the brand's — the KPM's name when it shows branding, so "AgencyBoost" is nowhere.
 * It names no insurer. `createdAt` is the clock's: no date is read from the machine.
 */
export function proposalDocument(model: PdfModel, layout: PdfLayout, createdAt: Date): TDocumentDefinitions {
  const content: Content[] = [];
  layout.pages.forEach((page, at) => {
    const nodes: Content[] = [
      ...page.pictures.map((p) => ({ image: 'logo', width: p.w, height: p.h, absolutePosition: { x: p.x, y: p.y } })),
      ...page.runs.map((r) => ({
        text: r.text,
        absolutePosition: { x: r.x, y: r.y },
        ...FACE[r.face],
        fontSize: r.size,
        color: r.colour,
        noWrap: true,
        ...(r.spacing ? { characterSpacing: r.spacing } : {}),
      })),
    ];
    if (at > 0 && nodes.length > 0) (nodes[0] as { pageBreak?: string }).pageBreak = 'before';
    content.push(...nodes);
  });
  const logo = model.brand.mark.kind === 'logo' ? model.brand.mark.png : null;
  return {
    pageSize: 'A4',
    pageOrientation: 'portrait',
    pageMargins: [0, 0, 0, 0],
    info: {
      title: model.meta.title,
      author: model.meta.author,
      producer: model.meta.producer,
      creator: model.meta.producer,
      creationDate: createdAt,
    },
    defaultStyle: { font: PDF_FONTS.REGULAR, fontSize: PROPOSAL.PDF_BODY_MIN_PT, color: model.colours.ink, lineHeight: 1 },
    ...(logo ? { images: { logo: `data:image/png;base64,${logo.toString('base64')}` } } : {}),
    background: (page: number) => (layout.pages[page - 1]
      ? { svg: layout.pages[page - 1].svg, width: PAGE_W, height: PAGE_H, absolutePosition: { x: 0, y: 0 } }
      : null) as Content,
    footer: () => null as unknown as Content,
    content,
  };
}

// ------------------------------------------------------------------------------------------------ the file's name

/**
 * **`Proposal-{Nama klien}-{tanggal}.pdf`** (ADR-0222 §6). The client's copy of the name with its accents taken off
 * (NFKD), every run of characters that are not letters or digits made one `-`, the `-` at either end removed, at most
 * `PROPOSAL.FILE_NAME_CLIENT_MAX` characters (and a `-` the cut leaves at the end removed too), *Klien* if nothing is
 * left; `{tanggal}` the proposal's date. `ascii` is the same with every character above 127 dropped, for `filename=`;
 * `name` is `filename*`'s.
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
  const encoded = encodeURIComponent(file.name).replace(/['()*]/g, (ch) => `%${ch.charCodeAt(0).toString(16).toUpperCase()}`);
  return `attachment; filename="${file.ascii}"; filename*=UTF-8''${encoded}`;
}
