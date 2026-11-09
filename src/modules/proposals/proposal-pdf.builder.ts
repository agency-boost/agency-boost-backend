import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { Injectable } from '@nestjs/common';
import pdfmake from 'pdfmake';
import type { DynamicContent, TDocumentDefinitions } from 'pdfmake/interfaces';
import { PROPOSAL } from '@/domain/constants';
import {
  levelsFrom, PDF_FONTS, proposalDocument, type PdfFace, type PdfInput, type PdfLevel, type PdfMeasure,
} from './proposal-pdf.layout';

/** The three Inter files (ADR-0222 §3): 400, 600 and 700, SIL Open Font License (`assets/fonts/OFL.txt`). */
const FONT_FILES = { regular: 'Inter-Regular.ttf', semibold: 'Inter-SemiBold.ttf', bold: 'Inter-Bold.ttf' } as const;

/**
 * **`backend/assets/fonts/`**, found from here upward: `src/modules/proposals` in a test, `dist/modules/proposals` in the
 * image (whose `assets/` the Dockerfile copies beside `dist/`).
 */
function fontsDirectory(): string {
  let at = __dirname;
  for (;;) {
    const candidate = join(at, 'assets', 'fonts');
    if (existsSync(join(candidate, FONT_FILES.regular))) return candidate;
    const up = dirname(at);
    if (up === at) throw new Error('The proposal PDF’s fonts are missing: assets/fonts/Inter-*.ttf');
    at = up;
  }
}

/** pdfmake's in-memory files: the fonts are read once, when the API starts, and never from disk again. */
interface VirtualFiles { writeFileSync(name: string, content: Buffer): void }

let fontsLoaded = false;

/** **Loaded once** (ADR-0222 §3), into pdfmake's own memory; no other file is reachable from a document. */
function loadFonts(): void {
  if (fontsLoaded) return;
  const directory = fontsDirectory();
  const files = (pdfmake as unknown as { virtualfs: VirtualFiles }).virtualfs;
  for (const file of Object.values(FONT_FILES)) files.writeFileSync(file, readFileSync(join(directory, file)));
  pdfmake.setFonts({
    [PDF_FONTS.REGULAR]: { normal: FONT_FILES.regular, bold: FONT_FILES.bold },
    [PDF_FONTS.SEMIBOLD]: { normal: FONT_FILES.semibold, bold: FONT_FILES.bold },
  });
  // Nothing outside memory: no URL is fetched and no local path is read while a document is made.
  pdfmake.setUrlAccessPolicy(() => false);
  pdfmake.setLocalAccessPolicy(() => false);
  fontsLoaded = true;
}

/** The face pdfmake draws for each of ours: a family and whether it is bold. */
const FACES: Record<PdfFace, [string, boolean]> = {
  regular: [PDF_FONTS.REGULAR, false],
  semibold: [PDF_FONTS.SEMIBOLD, false],
  bold: [PDF_FONTS.REGULAR, true],
};

/** pdfkit's font, as pdfmake hands it out: what it measures a run of text with. */
interface MeasuredFont { widthOfString(text: string, size: number): number }

let ruler: PdfMeasure | null = null;

/**
 * **The ruler the layout sets its slots with** (`proposal-pdf.layout.ts`, *What makes the two pages provable*): the very
 * fonts the file is drawn in, opened once in a document that is never written, so a line the layout keeps is a line the
 * renderer keeps.
 */
export function pdfRuler(): PdfMeasure {
  if (ruler) return ruler;
  loadFonts();
  // pdfmake's own document class: it opens a face from the same in-memory files the renderer reads.
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const PdfDocument = require('pdfmake/js/PDFDocument').default as new (...args: unknown[]) => {
    provideFont(family: string, bold: boolean, italics: boolean): MeasuredFont;
  };
  const files = (pdfmake as unknown as { virtualfs: unknown }).virtualfs;
  const fonts = (pdfmake as unknown as { fonts: unknown }).fonts;
  const document = new PdfDocument(fonts, {}, {}, {}, { size: 'A4', autoFirstPage: false, font: null }, files);
  const faces = Object.fromEntries(
    (Object.entries(FACES) as [PdfFace, [string, boolean]][]).map(([face, [family, bold]]) => [face, document.provideFont(family, bold, false)]),
  ) as Record<PdfFace, MeasuredFont>;
  ruler = { width: (text, face, size) => faces[face].widthOfString(text, size) };
  return ruler;
}

/** A document's bytes, and how many pages it laid out. */
export interface RenderedPdf { bytes: Buffer; pages: number }

/** What the builder answers: the file, its pages, and the level page 2 was laid out at. */
export interface BuiltPdf extends RenderedPdf { level: PdfLevel }

/** **Were level D ever not to fit** (a bound raised without the worst-case test): a `500`, never a third page. */
export class ProposalPdfTooLong extends Error {
  constructor(readonly pages: number) {
    super(`The proposal’s PDF did not fit ${PROPOSAL.PDF_PAGES} pages at its last level (${pages} pages).`);
  }
}

/** Lay a document out and render it, counting its pages from the footer every page is given. */
export async function renderPdf(definition: TDocumentDefinitions): Promise<RenderedPdf> {
  loadFonts();
  let pages = 0;
  const footer = definition.footer as DynamicContent;
  const document = pdfmake.createPdf({
    ...definition,
    footer: (current, count, size) => {
      pages = count;
      return footer(current, count, size);
    },
  });
  const bytes = await document.getBuffer();
  return { bytes, pages };
}

/**
 * **The proposal's file, built in memory each time and never kept** (P19.7-T3; ADR-0222 §2, §3; ADR-0223 §5).
 *
 * - **The fitting rule** (AC-6; Acc. 15): page 2 is laid out from its starting level — A for one or two products, C for
 *   three or more — and moved down one level at a time until the document is exactly `PROPOSAL.PDF_PAGES` pages. A
 *   product's block is unbreakable, so a page breaks only between products.
 * - **Level D always fits**, by the catalogue's bounds; a test lays out the worst case. Were it not to,
 *   {@link ProposalPdfTooLong} — the service answers `500`, and no third page is ever made.
 * - **At most `PROPOSAL.PDF_CONCURRENCY` renders at once** in one process; the others wait their turn, so a burst cannot
 *   carry the 512 MB container past its limit.
 */
@Injectable()
export class ProposalPdfBuilder {
  private running = 0;
  private readonly queue: (() => void)[] = [];

  constructor() {
    pdfRuler();
  }

  async build(input: PdfInput, createdAt: Date): Promise<BuiltPdf> {
    await this.turn();
    try {
      let last = 0;
      for (const level of levelsFrom(input.proposal.items.length)) {
        const rendered = await this.render(proposalDocument(input, level, pdfRuler(), createdAt));
        if (rendered.pages === PROPOSAL.PDF_PAGES) return { ...rendered, level };
        last = rendered.pages;
      }
      throw new ProposalPdfTooLong(last);
    } finally {
      this.done();
    }
  }

  /** One render; a seam a test replaces to make a level that does not fit. */
  protected render(definition: TDocumentDefinitions): Promise<RenderedPdf> {
    return renderPdf(definition);
  }

  /** How many renders are under way now, and how many wait (for the concurrency test). */
  get load(): { running: number; waiting: number } {
    return { running: this.running, waiting: this.queue.length };
  }

  private turn(): Promise<void> {
    if (this.running < PROPOSAL.PDF_CONCURRENCY) {
      this.running += 1;
      return Promise.resolve();
    }
    return new Promise((resolve) => this.queue.push(() => {
      this.running += 1;
      resolve();
    }));
  }

  private done(): void {
    this.running -= 1;
    this.queue.shift()?.();
  }
}
