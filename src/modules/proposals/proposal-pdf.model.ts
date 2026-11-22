import { formatRupiah, formatRupiahCompact } from '@/common/format/format';
import { contrastRatio, fillOf, inkOf, mix, tintOf } from '@/domain/branding/palette';
import {
  PROPOSAL, needTagFor, type PdfDetailBlockKind, type ProductCurrency, type ProposalNeedTag,
} from '@/domain/constants';
import { evaluateFormula } from '@/modules/products/proposal-formula';
import { CHECK_ILLUSTRATION } from '@/modules/products/proposal-fields-prudential';
import { COIN_TINT, type ArtColours, type ArtKind, type IconKind } from './proposal-pdf.art';
import type { PdfBranding } from './proposal-branding';
import { PDF_WORDS as W, premiumWordOf } from './proposal-pdf.words';

/**
 * **What the proposal's PDF says, decided before anything is laid out** (P19.14-T3; ADR-0256). A pure view model:
 * {@link pdfModelOf} reads the stored proposal, its items' snapshots, the KPM's branding, the agent and the insurer, and
 * answers every word, figure, row and colour the file prints. The layout (`proposal-pdf.layout.ts`) only places it.
 *
 * - **Nothing is a placeholder** (AC-2): a row whose value needs a premium table or an illustration we do not have, a
 *   formula that cannot be worked out, a field still *"Sesuai ilustrasi resmi"* — each is **left out**, never printed as
 *   *–*, *●●●* or *dari ilustrasi* (ADR-0256 §4, replacing ADR-0223 §4's *–*).
 * - **The client's details print only when filled** (AC-3): *Usia* and *Jenis kelamin*, then *Status*, *Tanggungan*,
 *   *Pekerjaan*, *Kota*, each only with a value; *Yang dibahas* only with a need.
 * - **Rows come most important first** (the spec's *Detail per product*): the chosen values, the pay term, *Manfaat
 *   utama*, *Masa*, *Jadwal*, *Total dibayar*, the catalogue's benefits, *Yang tidak ditanggung*, and *Nilai tunai* last —
 *   so a box that keeps its first five drops *Nilai tunai* first.
 * - **The colours** (ADR-0256 §3): the main colour as a fill white reads on, its tints at 7 % and 14 %, the second colour
 *   as it was picked for lines and dots and as its ink for words; body text and numbers stay dark.
 */

// ------------------------------------------------------------------------------------------------ what it reads

/**
 * **The input shapes, structural** — the stored proposal as P19.14-T1/T2 keep it (ADR-0254, ADR-0255), only the parts the
 * file reads. Optional members are the ones an older proposal may lack; each is read defensively.
 */
export interface PdfFieldSource {
  key: string;
  label: string;
  labelSyariah?: string | null;
  /** `chips`, `money`, `fixed` or `derived`. */
  type: string;
  options: readonly { label: string; years?: number | null }[];
  showOnPdf?: boolean;
  showOnSummary?: boolean;
  paymentYears?: boolean;
  plan?: boolean;
}

export interface PdfDetailRowSource { label: string; note: string | null; formula: string | null; text: string | null }
export interface PdfDetailBlockSource { block: PdfDetailBlockKind; rows: readonly PdfDetailRowSource[]; notGuaranteed?: boolean }

export interface PdfPayTermSource {
  key: string;
  label: string;
  years: number | null;
  toAge: number | null;
  single: boolean;
}

export interface PdfMoneySource { amountMinor: number | null; currency: ProductCurrency }

export interface PdfItemSource {
  snapshot: {
    name: string;
    typeLabel: string;
    category: string;
    fields: readonly PdfFieldSource[];
    benefits?: readonly string[];
    pdfDetail?: readonly PdfDetailBlockSource[];
    currencies?: readonly ProductCurrency[];
    isSyariah?: boolean;
    needTag?: string | null;
    payTerms?: readonly PdfPayTermSource[];
  };
  insured: { relation: 'client' | 'spouse' | 'child' | 'other'; name: string | null; age: number | null };
  fieldValues: Readonly<Record<string, string | number>>;
  /** The item's own *Cara bayar* (ADR-0255 §2). */
  payFrequency?: string | null;
  /** The pay term chosen, by its `key` in `snapshot.payTerms` (ADR-0255 §2). */
  payTerm?: string | null;
  up?: PdfMoneySource | null;
  premium: PdfMoneySource | null;
  /** The premium table the premium was read from (19.15); `null` — a `manual` item — reads *dari ilustrasi resmi*. */
  rateTableVersionId?: string | null;
  rateTableEffectiveFrom?: string | null;
}

export interface PdfClientSource {
  name: string;
  age: number | null;
  gender: 'male' | 'female' | null;
  details?: {
    status?: 'single' | 'married' | null;
    dependants?: string | null;
    occupation?: string | null;
    city?: string | null;
    needs?: readonly string[] | null;
    needsOther?: string | null;
  } | null;
}

export interface PdfProposalSource {
  client: PdfClientSource;
  showTotal: boolean;
  /** `YYYY-MM-DD`: the proposal's date (ADR-0222 §6). */
  date: string;
  items: readonly PdfItemSource[];
}

/** **Everything a file is built from** (ADR-0222 §2): the proposal, and what is read live when it is built. */
export interface PdfModelInput {
  proposal: PdfProposalSource;
  agent: { name: string | null; code: string | null; phone: string | null };
  /** The company's name: the disclaimer is the only place it is printed (decision 5). */
  insurer: string;
  /** The KPM's name: the file's author. */
  kpmName: string;
  branding: PdfBranding;
}

// ------------------------------------------------------------------------------------------------ what it answers

/** The fixed text colours (ADR-0256 §3): the spec's dark text, and the token's muted grey (`--color-muted`). */
export const PDF_INK = '#1a1f2b';
export const PDF_MUTED = '#5f5e5a';
export const PDF_WHITE = '#ffffff';

export interface PdfColours {
  /** **The main colour as a fill white reads on** (4.5:1): bands, blocks, titles, premiums. */
  band: string;
  /** White on the band, and white a little toward it where that still reads 4.5:1 (taglines, captions). */
  onBand: string;
  onBandSoft: string;
  /** The *Hubungi saya* pill on the agent block: the band lifted toward white, white still reading 4.5:1. */
  bandLift: string;
  /** The main colour at 7 % and 14 % over white: tiles, strips, lines. */
  tint: string;
  tintStrong: string;
  /** The second colour as picked: the stripe, the card edges, the dots. */
  second: string;
  /** Its tints: pills and chips (16 %), a coin's top (55 %). */
  secondTint: string;
  secondCoin: string;
  /** The second colour as words on white (its ink): the category labels. */
  secondInk: string;
  /** An avatar or a logo-less mark: the second colour as a fill, and the words that read on it. */
  avatarFill: string;
  avatarText: string;
  /** The main colour as words on its own tint, else the dark text. */
  bandOnTint: string;
  ink: string;
  muted: string;
  /** A grey surface: the dark text at 5 % over white. */
  grey: string;
  /** The colours every illustration is drawn in. */
  art: ArtColours;
}

export type PdfMark =
  | { kind: 'logo'; png: Buffer; width: number; height: number }
  | { kind: 'agencyboost' }
  | { kind: 'initials'; text: string };

export interface PdfTile { label: string; value: string }

/**
 * A row of a box: a value the agent chose, a detail of the product, a benefit, or *Nilai tunai*. A detail row keeps its
 * block, and its label and note apart, so the one-product page can take its amounts and facts out by what they are.
 */
export interface PdfRow {
  label: string;
  value: string;
  kind: 'value' | 'detail' | 'benefit' | 'cash';
  block?: PdfDetailBlockKind;
  base?: string;
  note?: string | null;
}

export interface PdfStage { label: string; value: string | null }

export interface PdfItem {
  art: ArtKind;
  /** *KESEHATAN*. */
  typeLabel: string;
  name: string;
  plan: string | null;
  /** *"PRUWell Medical · Silver A"*. */
  title: string;
  /** Page 2's second line: the plan, else the type in sentence case (*Penyakit kritis*). */
  subtitle: string;
  /** *"Untuk: Bapak Budi · UP Rp 500 juta"*. */
  who: string;
  /** The premium in full, or `null` while it is not typed (nothing is printed for it). */
  premium: string | null;
  /** *per bulan*, *sekali bayar*. */
  per: string;
  /** The pill: *"per bulan · 10 tahun"*. */
  pill: string;
  /** *"Tabel tarif berlaku …"* or *"Premi dari ilustrasi resmi"*. */
  source: string;
  rows: PdfRow[];
  timeline: PdfStage[] | null;
  /** One product only: *Perlindungan Anda*'s amounts (≤ `PDF_PROTECTION_MAX`) and *Yang perlu diketahui* (≤ `PDF_FACTS_MAX`). */
  protection: PdfTile[];
  facts: { title: string; text: string | null }[];
}

export interface PdfNeedTile { need: ProposalNeedTag; label: string; state: string; covered: boolean; icon: IconKind }

export interface PdfSummary {
  /** Only with *Tampilkan total*, and only over the products of one *Cara bayar* and one currency. */
  total: { label: string; amount: string; lines: string[] } | null;
  tiles: PdfNeedTile[];
}

export interface PdfAgent { name: string | null; initials: string; line: string; cta: readonly [string, string] }

export interface PdfModel {
  brand: { branded: boolean; name: string; mark: PdfMark };
  colours: PdfColours;
  meta: { title: string; author: string; producer: string };
  /** *11 November 2026*. */
  date: string;
  client: { title: string; short: string; tiles: PdfTile[]; needs: string[] };
  items: PdfItem[];
  summary: PdfSummary | null;
  steps: { title: string; text: string }[];
  disclaimer: string;
  agent: PdfAgent | null;
  /** The footer's left part: the brand's name, and on a page without the agent block, who prepared it. */
  footer: { name: string; preparedBy: string | null };
}

// ------------------------------------------------------------------------------------------------ money

const NBSP = '\u00a0';
const unbroken = (s: string) => s.replace(/ /g, NBSP);

/** **A USD amount: always in full, with its code** (ADR-0209 §8): *USD 1.250,00*. Never compact, never converted. */
export function usdInFull(minor: number): string {
  const cents = Math.round(Math.abs(minor));
  const whole = Math.floor(cents / 100).toString().replace(/\B(?=(\d{3})+(?!\d))/g, '.');
  const rest = String(cents % 100).padStart(2, '0');
  return `${minor < 0 && cents > 0 ? '-' : ''}USD ${whole},${rest}`;
}

/** **A premium and a total: in full, as a price is** (ADR-0174 §4): *Rp 828.000*; the space unbreakable. */
export function moneyInFull(minor: number, currency: ProductCurrency): string {
  return unbroken(currency === 'USD' ? usdInFull(minor) : formatRupiah(minor, 'id'));
}

/**
 * **A value's amount: compact, its unit in words** (ADR-0256 §6; the mockups' *Rp500 juta*, *Rp4 miliar*): §B.25's
 * figure with *ribu*, *juta*, *miliar* written out for a 50+ reader. A USD amount stays in full.
 */
export function moneyInWords(minor: number, currency: ProductCurrency): string {
  if (currency === 'USD') return unbroken(usdInFull(minor));
  const compact = formatRupiahCompact(minor, {}, 'id').replace(/ rb$/, ' ribu').replace(/ Jt$/, ' juta').replace(/ M$/, ' miliar');
  return unbroken(compact);
}

// ------------------------------------------------------------------------------------------------ colours

/** White, or white moved toward `fill` by the largest of `steps` that still reads 4.5:1 on it. */
function softWhiteOn(fill: string, steps: readonly number[]): string {
  for (const t of steps) {
    const colour = mix(PDF_WHITE, fill, t);
    if (contrastRatio(colour, fill) >= 4.5) return colour;
  }
  return PDF_WHITE;
}

/** `fill` lifted toward white by the largest of `steps` under which white still reads 4.5:1. */
function liftedUnderWhite(fill: string, steps: readonly number[]): string {
  for (const t of steps) {
    const colour = mix(fill, PDF_WHITE, t);
    if (contrastRatio(PDF_WHITE, colour) >= 4.5) return colour;
  }
  return fill;
}

/**
 * **The file's colours from the branding's two** (ADR-0256 §3). `main` becomes the band — **itself where white reads
 * 4.5:1 on it, else its nearest darker shade where it does** (`inkOf`: `fillOf`'s darker side, so the band's white words
 * always read) — and its tints; `second` stays as picked for what carries no words, and is its ink where it is words.
 */
export function coloursOf(main: string, second: string): PdfColours {
  const band = inkOf(main.toLowerCase());
  const tint = tintOf(band, PROPOSAL.PDF_TINT_LIGHT);
  const tintStrong = tintOf(band, PROPOSAL.PDF_TINT_STRONG);
  const secondColour = second.toLowerCase();
  const avatar = fillOf(secondColour);
  const secondTint = tintOf(secondColour, 0.16);
  const secondCoin = tintOf(secondColour, COIN_TINT);
  return {
    band,
    onBand: PDF_WHITE,
    onBandSoft: softWhiteOn(band, [0.2, 0.12, 0.06]),
    bandLift: liftedUnderWhite(band, [0.15, 0.1, 0.05]),
    tint,
    tintStrong,
    second: secondColour,
    secondTint,
    secondCoin,
    secondInk: inkOf(secondColour),
    avatarFill: avatar.fill,
    avatarText: avatar.colour,
    bandOnTint: contrastRatio(band, tint) >= 4.5 ? band : PDF_INK,
    ink: PDF_INK,
    muted: PDF_MUTED,
    grey: tintOf(PDF_INK, 0.05),
    art: { a: band, b: secondColour, a1: tint, a2: tintStrong, b2: secondCoin },
  };
}

// ------------------------------------------------------------------------------------------------ the client

const HONORIFIC = /^(bapak|bpk\.?|bp\.?|pak|tuan|tn\.?|sdr\.?|saudara|ibu|ibuk|bu|nyonya|ny\.?|sdri\.?|saudari)\s+/i;
const FEMALE_HONORIFIC = /^(ibu|ibuk|bu|nyonya|ny\.?|sdri\.?|saudari)$/i;

/**
 * **The client as the file addresses them**: *Bapak* or *Ibu* by the proposal's gender, and the name without a title the
 * lead already carries (*"Pak Budi"* is *Bapak Budi*, never *Bapak Pak Budi*). With no gender, the lead's own title
 * decides, else *Bapak/Ibu*.
 */
export function addressOf(name: string, gender: 'male' | 'female' | null): { title: string; short: string } {
  const trimmed = name.replace(/\s+/g, ' ').trim();
  const match = HONORIFIC.exec(trimmed);
  const bare = match && trimmed.length > match[0].length ? trimmed.slice(match[0].length) : trimmed;
  const implied = match ? (FEMALE_HONORIFIC.test(match[1]) ? 'female' : 'male') : null;
  const honorific = W.honorific(gender ?? implied);
  const first = bare.split(' ')[0] ?? bare;
  return { title: `${honorific} ${bare}`, short: `${honorific} ${first}` };
}

const filled = (value: string | null | undefined): string | null => {
  const text = typeof value === 'string' ? value.replace(/\s+/g, ' ').trim() : '';
  return text.length > 0 ? text : null;
};

/** *Tentang Bapak/Ibu …*'s tiles: each only when filled (AC-3). */
export function clientTilesOf(client: PdfClientSource): PdfTile[] {
  const d = client.details ?? {};
  const tiles: (PdfTile | null)[] = [
    client.age === null ? null : { label: W.age, value: W.years(client.age) },
    client.gender ? { label: W.gender, value: W.genders[client.gender] } : null,
    d.status ? { label: W.status, value: W.statuses[d.status] } : null,
    filled(d.dependants) ? { label: W.dependants, value: filled(d.dependants)! } : null,
    filled(d.occupation) ? { label: W.occupation, value: filled(d.occupation)! } : null,
    filled(d.city) ? { label: W.city, value: filled(d.city)! } : null,
  ];
  return tiles.filter((t): t is PdfTile => t !== null);
}

/** *Yang dibahas*: step 1's chips, in the spec's order; *Lainnya* is the agent's own words where they typed some. */
export function clientNeedsOf(client: PdfClientSource): string[] {
  const chosen = new Set(client.details?.needs ?? []);
  const out: string[] = [];
  for (const need of ['HOSPITAL', 'CRITICAL_INCOME', 'FAMILY', 'EDUCATION', 'FUTURE', 'OTHER'] as const) {
    if (!chosen.has(need)) continue;
    out.push(need === 'OTHER' ? filled(client.details?.needsOther) ?? W.needs.OTHER : W.needs[need]);
  }
  return out;
}

// ------------------------------------------------------------------------------------------------ an item

const PLACEHOLDER = /●|dari ilustrasi|dari tabel tarif|^\s*[-–—]\s*$/i;

/** A value the file may print: not empty, not the catalogue's *"Sesuai ilustrasi resmi"*, not a placeholder. */
function printable(value: string | null | undefined): string | null {
  const text = filled(value);
  if (!text || text === CHECK_ILLUSTRATION || PLACEHOLDER.test(text)) return null;
  return text;
}

const ART_BY_CATEGORY: Readonly<Record<string, ArtKind>> = {
  health: 'health', ci: 'critical', life: 'family', education: 'education', investment: 'growth',
};
const ART_BY_NEED: Readonly<Record<ProposalNeedTag, ArtKind>> = {
  HOSPITAL: 'health', CRITICAL_INCOME: 'critical', FAMILY: 'family', EDUCATION: 'education', FUTURE: 'growth',
};

/** **A product's picture** (AC-5): its category's; a category without one reads its need's, else the umbrella. */
export function artOfItem(item: Pick<PdfItemSource, 'snapshot'>): ArtKind {
  return ART_BY_CATEGORY[item.snapshot.category] ?? ART_BY_NEED[needOfItem(item)] ?? 'family';
}

/** The need tile a product ticks: its own `needTag`, else its category's (ADR-0255 §5). */
export function needOfItem(item: Pick<PdfItemSource, 'snapshot'>): ProposalNeedTag {
  const own = item.snapshot.needTag;
  return own && own in ART_BY_NEED ? own as ProposalNeedTag : needTagFor(item.snapshot.category);
}

const isSyariah = (item: PdfItemSource) => item.snapshot.isSyariah === true;

const labelOf = (field: PdfFieldSource, syariah: boolean) => (syariah && field.labelSyariah ? field.labelSyariah : field.label);

function currencyOf(item: PdfItemSource): ProductCurrency {
  return item.premium?.currency ?? item.up?.currency ?? item.snapshot.currencies?.[0] ?? 'IDR';
}

/** A field's value as printed, or `null` where it has none worth printing. */
function fieldValueOf(field: PdfFieldSource, item: PdfItemSource): string | null {
  if (field.type === 'fixed') return printable(field.options[0]?.label);
  const value = item.fieldValues[field.key];
  if (field.type === 'money') {
    const minor = typeof value === 'number' ? value : field.key === 'up' ? item.up?.amountMinor ?? null : null;
    return minor === null ? null : moneyInWords(minor, currencyOf(item));
  }
  return typeof value === 'string' ? printable(value) : null;
}

/** The plan, where the product has one: a `plan` field's chosen, fixed or derived value. */
export function planOfItem(item: PdfItemSource): string | null {
  const field = item.snapshot.fields.find((f) => f.plan);
  return field ? fieldValueOf(field, item) : null;
}

/** The pay term: the item's chosen one, else the product's only one, else its `paymentYears` field's. */
export function payTermOfItem(item: PdfItemSource): { label: string; years: number | null; toAge: number | null; single: boolean } | null {
  const terms = item.snapshot.payTerms ?? [];
  const chosen = terms.find((t) => t.key === item.payTerm) ?? (terms.length === 1 ? terms[0] : undefined);
  if (chosen) return chosen;
  const field = item.snapshot.fields.find((f) => f.paymentYears);
  if (!field) return null;
  const option = field.type === 'fixed' ? field.options[0] : field.options.find((o) => o.label === item.fieldValues[field.key]);
  const label = printable(option?.label);
  return label ? { label, years: option?.years ?? null, toAge: null, single: false } : null;
}

const frequencyOf = (item: PdfItemSource): keyof typeof W.per =>
  (item.payFrequency && item.payFrequency in W.per ? item.payFrequency : 'monthly') as keyof typeof W.per;

/** The pay term as a pill says it: *10 tahun*, *s/d usia 60*; a sentence too long for a pill is not said there. */
function termInPill(term: ReturnType<typeof payTermOfItem>): string | null {
  if (!term || term.single) return null;
  if (term.years) return W.payYears(term.years);
  if (term.toAge) return W.payToAge(term.toAge);
  return term.label.length <= 16 ? term.label : null;
}

/** The money values a `pdfDetail` formula reads: the product's money fields, and the sum assured as `up`. */
function moneyValuesOf(item: PdfItemSource): Record<string, number | null> {
  const values: Record<string, number | null> = {};
  for (const field of item.snapshot.fields) {
    if (field.type !== 'money') continue;
    const value = item.fieldValues[field.key];
    values[field.key] = typeof value === 'number' ? value : null;
  }
  if (item.up?.amountMinor != null) values.up = item.up.amountMinor;
  return values;
}

/** A `pdfDetail` row's value: its formula worked out in the item's currency, or its text; `null` — left out — else. */
export function detailValueOf(row: PdfDetailRowSource, item: PdfItemSource): string | null {
  if (row.formula) {
    const minor = evaluateFormula(row.formula, moneyValuesOf(item));
    return minor === null ? null : moneyInWords(minor, currencyOf(item));
  }
  return printable(row.text);
}

/** An amount: *Rp 4 miliar*, *Rp4 miliar*, *USD 1.250,00* — the catalogue's text or a formula's figure. */
const isMoney = (value: string) => /^-?(Rp|USD)[\s\u00a0]?\d/.test(value);

const STAGE = /^(sd|smp|sma|smk|kuliah|universitas|perguruan tinggi|s1)\b/i;

/** The insured, as *Untuk:* says them. */
function whoOf(item: PdfItemSource, clientShort: string): string {
  const { relation, name, age } = item.insured;
  return relation === 'client' ? clientShort : W.insuredOf(relation, filled(name), age);
}

/** The card's key figure after the insured: the sum assured, else the first summary amount. */
function keyFigureOf(item: PdfItemSource): string | null {
  const syariah = isSyariah(item);
  const upField = item.snapshot.fields.find((f) => f.key === 'up' && f.type === 'money');
  const up = item.up?.amountMinor ?? (typeof item.fieldValues.up === 'number' ? item.fieldValues.up : null);
  if (up !== null && up !== undefined && (upField || item.up)) return `${W.upShort(syariah)} ${moneyInWords(up, currencyOf(item))}`;
  for (const field of item.snapshot.fields) {
    if (!field.showOnSummary || field.type !== 'money' || field.plan) continue;
    const value = fieldValueOf(field, item);
    if (value) {
      const label = labelOf(field, syariah);
      return `${label.charAt(0).toLowerCase()}${label.slice(1)} ${value}`;
    }
  }
  return null;
}

/** **An item's rows, most important first** (the spec's *Detail per product*), each with a value — else left out. */
export function rowsOfItem(item: PdfItemSource, timeline: boolean): PdfRow[] {
  const syariah = isSyariah(item);
  const rows: PdfRow[] = [];
  const blocks = item.snapshot.pdfDetail ?? [];
  const detail = (kind: PdfDetailBlockKind, as: PdfRow['kind']) => {
    for (const block of blocks.filter((b) => b.block === kind)) {
      for (const row of block.rows) {
        const base = filled(row.label);
        if (!base || (kind === 'jadwal' && timeline && STAGE.test(base))) continue;
        // An exclusion is its label: *"Kondisi yang sudah ada — tidak ditanggung"* where its row gives no value.
        const value = detailValueOf(row, item) ?? (kind === 'pengecualian' ? W.notCovered : null);
        if (!value) continue;
        const note = filled(row.note);
        const label = [base, note].filter(Boolean).join(' ');
        rows.push({
          label: kind === 'nilai_tunai' && block.notGuaranteed ? `${label} (${W.notGuaranteed})` : label,
          value, kind: as, block: kind, base, note,
        });
      }
    }
  };

  // 1. What the agent chose: the sum assured, then each `showOnPdf` field but the plan (it is in the title).
  const fields = item.snapshot.fields.filter((f) => f.showOnPdf !== false && !f.plan);
  const upField = fields.find((f) => f.key === 'up' && f.type === 'money');
  if (!upField && item.up?.amountMinor != null) {
    rows.push({ label: W.upLabel(syariah), value: moneyInWords(item.up.amountMinor, currencyOf(item)), kind: 'value' });
  }
  for (const field of fields) {
    const value = fieldValueOf(field, item);
    if (value) rows.push({ label: field.key === 'up' && syariah && !field.labelSyariah ? W.upLabel(true) : labelOf(field, syariah), value, kind: 'value' });
  }
  // 2. The pay term, where no field already said it.
  const term = payTermOfItem(item);
  if (term && !item.snapshot.fields.some((f) => f.paymentYears && f.showOnPdf !== false && fieldValueOf(f, item))) {
    const value = term.single ? 'Sekali bayar' : term.years ? W.payYears(term.years) : term.toAge ? W.payToAge(term.toAge) : printable(term.label);
    if (value) rows.push({ label: W.payTerm, value, kind: 'value' });
  }
  // 3–5. *Manfaat utama*, *Masa tunggu / berlaku*, *Jadwal* (its school stages drawn as the timeline instead).
  detail('manfaat', 'detail');
  detail('masa', 'detail');
  detail('jadwal', 'detail');
  // 6. *Total dibayar*: the premium × the payments a year × the years, where the term is a number of years.
  const frequency = frequencyOf(item);
  const perYear = (PROPOSAL.PAYMENTS_PER_YEAR as Readonly<Record<string, number>>)[frequency];
  const premium = item.premium?.amountMinor ?? null;
  if (premium !== null && term?.years && !term.single && frequency !== 'single' && perYear) {
    rows.push({ label: W.totalPaid, value: moneyInWords(premium * perYear * term.years, currencyOf(item)), kind: 'value' });
  }
  // 7. The catalogue's benefits, then 8. *Yang tidak ditanggung*, and 9. *Nilai tunai* — dropped first.
  for (const benefit of (item.snapshot.benefits ?? []).slice(0, PROPOSAL.BENEFITS_ON_PDF_MAX)) {
    const text = printable(benefit);
    if (text) rows.push({ label: text, value: '', kind: 'benefit' });
  }
  detail('pengecualian', 'detail');
  detail('nilai_tunai', 'cash');
  return rows;
}

/** **The education timeline** (the spec's *SD → SMP → SMA → Kuliah*): the product's `jadwal` rows naming a school stage. */
export function timelineOfItem(item: PdfItemSource): PdfStage[] | null {
  const stages: PdfStage[] = [];
  for (const block of (item.snapshot.pdfDetail ?? []).filter((b) => b.block === 'jadwal')) {
    for (const row of block.rows) {
      const label = filled(row.label);
      if (label && STAGE.test(label)) stages.push({ label, value: detailValueOf(row, item) });
    }
  }
  return stages.length >= 2 ? stages : null;
}

/** One item, as the file prints it. With `single`, its key amounts and two facts are taken out of its rows. */
export function itemOf(item: PdfItemSource, clientShort: string, single: boolean): PdfItem {
  const syariah = isSyariah(item);
  const name = filled(item.snapshot.name) ?? '';
  const plan = planOfItem(item);
  const typeLabel = (filled(item.snapshot.typeLabel) ?? '').toUpperCase();
  const timeline = timelineOfItem(item);
  let rows = rowsOfItem(item, timeline !== null);
  const protection: PdfTile[] = [];
  const facts: { title: string; text: string | null }[] = [];
  if (single) {
    // *Perlindungan Anda*: the sum assured and *Manfaat utama*'s amounts. *Yang perlu diketahui*: *Masa*, then exclusions.
    const amounts = rows.filter((r) => isMoney(r.value) && (r.block === 'manfaat' || (r.kind === 'value' && /pertanggungan|santunan/i.test(r.label))))
      .slice(0, PROPOSAL.PDF_PROTECTION_MAX);
    const known = rows.filter((r) => r.block === 'masa' || r.block === 'pengecualian').slice(0, PROPOSAL.PDF_FACTS_MAX);
    for (const row of amounts) protection.push({ label: row.label, value: row.value });
    for (const row of known) facts.push({ title: `${row.base ?? row.label} ${row.value}`, text: row.note ?? null });
    rows = rows.filter((r) => !amounts.includes(r) && !known.includes(r));
  }
  const frequency = frequencyOf(item);
  const per = W.per[frequency];
  const pill = [per, termInPill(payTermOfItem(item))].filter(Boolean).join(' · ');
  const key = keyFigureOf(item);
  const type = typeLabel.toLowerCase();
  return {
    art: artOfItem(item),
    typeLabel,
    name,
    plan,
    title: plan ? `${name} · ${plan}` : name,
    subtitle: plan ?? (type ? type.charAt(0).toUpperCase() + type.slice(1) : ''),
    who: W.forWhom([whoOf(item, clientShort), key].filter(Boolean).join(' · ')),
    premium: item.premium?.amountMinor != null ? moneyInFull(item.premium.amountMinor, item.premium.currency) : null,
    per,
    pill,
    source: item.rateTableVersionId
      ? W.fromTable(item.rateTableEffectiveFrom ? W.longDate(item.rateTableEffectiveFrom.slice(0, 10)) : '')
      : W.fromIllustration(syariah),
    rows,
    timeline,
    protection,
    facts,
  };
}

// ------------------------------------------------------------------------------------------------ the summary

const NEED_ORDER: readonly ProposalNeedTag[] = ['HOSPITAL', 'CRITICAL_INCOME', 'FAMILY', 'EDUCATION', 'FUTURE'];
const NEED_ICON: Readonly<Record<ProposalNeedTag, IconKind>> = {
  HOSPITAL: 'heart', CRITICAL_INCOME: 'shield', FAMILY: 'umbrella', EDUCATION: 'cap', FUTURE: 'grow',
};

/**
 * **The need tiles** (the spec's *Ringkasan*): each need a product covers (*✓ terlindungi*, *✓ terencana*), then each the
 * client discussed that none covers (grey, *belum ada*), at most `PDF_NEED_TILES_MAX`, in the spec's order.
 */
export function needTilesOf(items: readonly PdfItemSource[], client: PdfClientSource): PdfNeedTile[] {
  const covered = new Set(items.map(needOfItem));
  const discussed = (client.details?.needs ?? []).filter((n): n is ProposalNeedTag => (NEED_ORDER as readonly string[]).includes(n));
  const chosen = [...NEED_ORDER.filter((n) => covered.has(n)), ...NEED_ORDER.filter((n) => !covered.has(n) && discussed.includes(n))]
    .slice(0, PROPOSAL.PDF_NEED_TILES_MAX);
  return NEED_ORDER.filter((n) => chosen.includes(n)).map((need) => ({
    need,
    label: W.needTiles[need],
    covered: covered.has(need),
    state: !covered.has(need) ? W.openState : need === 'EDUCATION' || need === 'FUTURE' ? W.plannedState : W.protectedState,
    icon: NEED_ICON[need],
  }));
}

/**
 * **The total** (the spec's *Ringkasan*; AC-3): only with *Tampilkan total*, and only over the products of **one *Cara
 * bayar* and one currency** — the largest such group, of two products at least; never IDR and USD added. The others are
 * said in one line under it.
 */
export function totalOf(items: readonly PdfItemSource[], showTotal: boolean): PdfSummary['total'] {
  if (!showTotal || items.length < 2) return null;
  const groups = new Map<string, { frequency: keyof typeof W.per; currency: ProductCurrency; at: number[] }>();
  items.forEach((item, at) => {
    const frequency = frequencyOf(item);
    if (item.premium?.amountMinor == null || frequency === 'single') return;
    const key = `${frequency}|${item.premium.currency}`;
    const group = groups.get(key) ?? { frequency, currency: item.premium.currency, at: [] };
    group.at.push(at);
    groups.set(key, group);
  });
  const best = [...groups.values()].sort((x, y) => y.at.length - x.at.length || x.at[0] - y.at[0])[0];
  if (!best || best.at.length < 2) return null;
  const sum = best.at.reduce((total, at) => total + items[at].premium!.amountMinor!, 0);
  const others = items.map((item, at) => ({ item, at })).filter(({ at }) => !best.at.includes(at));
  const lines = [W.groupLine(best.at.length, W.adverb[best.frequency])];
  if (others.length === 1) {
    const { item } = others[0];
    const name = filled(item.snapshot.name) ?? '';
    const frequency = frequencyOf(item);
    if (frequency === 'single') lines.push(W.otherSingle(name));
    else if (item.premium && item.premium.currency !== best.currency) lines.push(W.otherCurrency(name, item.premium.currency));
    else lines.push(W.otherPer(name, W.per[frequency]));
  } else if (others.length > 1) {
    lines.push(W.othersApart(others.map(({ item }) => filled(item.snapshot.name) ?? '').join(', ')));
  }
  return { label: W.totalPer(W.per[best.frequency]), amount: moneyInFull(sum, best.currency), lines };
}

// ------------------------------------------------------------------------------------------------ the whole

/** Initials: the first letters of the first two words. */
export function initialsOf(name: string | null): string {
  return (name ?? '').split(/\s+/).filter(Boolean).slice(0, 2).map((w) => [...w][0]?.toUpperCase() ?? '').join('');
}

/** **A logo-less KPM's mark**: the initials of its name's words, *KPM* and its code left out — *KPM 0417 · BSD City* is *BC*. */
export function brandInitialsOf(name: string): string {
  const words = name.split(/[\s·,\-–—]+/).filter((w) => /^\p{L}/u.test(w) && !/^kpm$/i.test(w));
  return initialsOf(words.join(' ')) || initialsOf(name);
}

/** **The file, decided** — every word, figure and colour, from the stored proposal and what is read now. */
export function pdfModelOf(input: PdfModelInput): PdfModel {
  const { proposal: p, branding: b } = input;
  const address = addressOf(p.client.name, p.client.gender);
  const single = p.items.length <= 1;
  const items = p.items.map((item) => itemOf(item, address.short, single));
  const word = premiumWordOf(p.items.map(isSyariah));
  const name = b.branded ? b.name : W.agencyBoost;
  const mark: PdfMark = !b.branded
    ? { kind: 'agencyboost' }
    : b.logo
      ? { kind: 'logo', png: b.logo.png, width: b.logo.width, height: b.logo.height }
      : { kind: 'initials', text: brandInitialsOf(b.name) || '·' };
  const agentName = filled(input.agent.name);
  const agentLine = [W.agent, filled(input.agent.code) ? W.agentCode(filled(input.agent.code)!) : null, filled(input.agent.phone)]
    .filter((part): part is string => !!part).join(' · ');
  const agent: PdfAgent | null = agentName || filled(input.agent.code) || filled(input.agent.phone)
    ? { name: agentName, initials: initialsOf(agentName), line: agentLine, cta: W.callMe }
    : null;
  const prepared = [agentName, filled(input.agent.phone)].filter(Boolean).join(', ');
  return {
    brand: { branded: b.branded, name, mark },
    colours: coloursOf(b.main, b.second),
    meta: { title: W.title(address.title), author: filled(input.kpmName) ?? name, producer: name },
    date: W.longDate(p.date),
    client: { ...address, tiles: clientTilesOf(p.client), needs: clientNeedsOf(p.client) },
    items,
    summary: single ? null : { total: totalOf(p.items, p.showTotal), tiles: needTilesOf(p.items, p.client) },
    steps: W.steps(word),
    disclaimer: W.disclaimer(filled(input.insurer) ?? '', word),
    agent,
    footer: { name, preparedBy: prepared ? W.preparedBy(prepared) : null },
  };
}
