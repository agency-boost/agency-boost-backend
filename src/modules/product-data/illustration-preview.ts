import { PROPOSAL, type PdfDetailBlockKind } from '@/domain/constants';
import type { PdfDetailBlock } from '@/modules/products/proposal-fields';
import { AGENCYBOOST_PDF_BRANDING } from '@/modules/proposals/proposal-branding';
import { newItem, type ProductForItem } from '@/modules/proposals/proposal-items';
import {
  itemOf, pdfModelOf, type PdfItemSource, type PdfModel, type PdfRow,
} from '@/modules/proposals/proposal-pdf.model';
import type { IllustrationBlock } from './illustration.schema';

/**
 * **The product's PDF box, as agents will print it** (P19.15-T2 AC-3; ADR-0259 §8). Built with the proposal PDF's own
 * model (`proposal-pdf.model.ts`): the draft's blocks laid into the product as a new proposal would snapshot it
 * (`newItem`), with the illustration's own inputs as the sample values. What a box holds and what it drops is the
 * layout's rule — 7 rows a box with two products, 5 with three or four, *Nilai tunai* (the last rows) first to go — so
 * the preview says which rows would not fit, rather than another rule of its own.
 */

/** **The draft's blocks as the product's `pdfDetail`**: each with its page and the illustration's file and date. */
export function pdfDetailOf(blocks: readonly IllustrationBlock[], fileName: string, illustrationDate: string): PdfDetailBlock[] {
  return blocks.filter((b) => b.rows.length).map((b) => ({
    block: b.block,
    rows: b.rows.map((r) => ({ label: r.label, note: r.note, formula: r.formula, text: r.formula ? null : r.text })),
    source: { file: fileName.slice(0, 120), page: b.page ?? b.rows.find((r) => r.page)?.page ?? 1, date: illustrationDate },
    notGuaranteed: b.block === 'nilai_tunai',
  }));
}

/** A preview's item: the product with the draft's blocks, its sample values filled in. */
export function previewItem(product: ProductForItem & { name: string }, detail: PdfDetailBlock[], samples: Readonly<Record<string, number>>, insuredAge = 35): PdfItemSource {
  const stored = newItem('preview', { ...product, pdfDetail: detail }, product.name, insuredAge);
  const currency = stored.snapshot.currencies[0] ?? 'IDR';
  const fieldValues = { ...stored.fieldValues };
  for (const field of stored.snapshot.fields) {
    if (field.type === 'money' && samples[field.key] !== undefined) fieldValues[field.key] = samples[field.key];
  }
  return {
    ...(stored as unknown as PdfItemSource),
    fieldValues,
    up: stored.snapshot.calcType === 'up_premium' && samples.up !== undefined ? { amountMinor: samples.up, currency } : stored.up,
  };
}

export interface PreviewRow { label: string; value: string; block: PdfDetailBlockKind | null; kind: PdfRow['kind'] }

export interface BoxPreview {
  /** Every row the product would print, most important first. */
  rows: PreviewRow[];
  /** With two products: the first `PDF_BOX_ROWS_FEW` rows; the rest is what does not fit. */
  withTwo: { kept: number; dropped: PreviewRow[] };
  /** With three or four products: the first `PDF_BOX_ROWS_MANY`. */
  withMore: { kept: number; dropped: PreviewRow[] };
  /** Rows whose value the sample inputs could not give: left out of the file, as an agent's would be. */
  missing: string[];
  fits: boolean;
}

/** **What the box holds**, and what it drops, at each number of products. */
export function boxPreview(item: PdfItemSource, detail: readonly PdfDetailBlock[]): BoxPreview {
  const printed = itemOf(item, 'Bapak Contoh', false);
  const rows: PreviewRow[] = printed.rows.map((r) => ({ label: r.label, value: r.value, block: r.block ?? null, kind: r.kind }));
  const shown = new Set(printed.rows.filter((r) => r.block).map((r) => r.base ?? r.label));
  const missing = detail.flatMap((b) => b.rows.map((r) => r.label)).filter((label) => !shown.has(label) && !printed.timeline?.some((t) => t.label === label));
  const timelineRows = printed.timeline ? 3 : 0;
  const few = Math.max(0, PROPOSAL.PDF_BOX_ROWS_FEW - timelineRows);
  const many = Math.max(0, PROPOSAL.PDF_BOX_ROWS_MANY - timelineRows);
  return {
    rows,
    withTwo: { kept: Math.min(rows.length, few), dropped: rows.slice(few) },
    withMore: { kept: Math.min(rows.length, many), dropped: rows.slice(many) },
    missing,
    fits: rows.length <= few,
  };
}

/** **A sample proposal's file model**: the product for the client and again for a spouse, so page 2 draws its box. */
export function previewModel(item: PdfItemSource, insurer: string, date: string): PdfModel {
  const spouse: PdfItemSource = { ...item, insured: { relation: 'spouse', name: 'Ibu Contoh', age: 33 } };
  return pdfModelOf({
    proposal: { client: { name: 'Bapak Contoh', age: 35, gender: 'male', details: null }, showTotal: false, date, items: [item, spouse] },
    agent: { name: 'Contoh Agen', code: null, phone: null },
    insurer,
    kpmName: 'AgencyBoost',
    branding: AGENCYBOOST_PDF_BRANDING,
  });
}
