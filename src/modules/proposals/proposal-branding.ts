import { Injectable } from '@nestjs/common';
import { RequestContext } from '@/common/context/request-context';
import { AGENCYBOOST_COLOURS, BrandingReader, type BrandingForPdf } from '@/modules/branding/branding-reader';

/**
 * **What the proposal's PDF draws of a KPM's branding** (P19.7-T3 AC-7; ADR-0223 §3, §6; ADR-0218 §3, §5): the wide logo
 * the KPM shows, and four colours of its palette — `BrandingReader.forPdf`'s shape.
 *
 * - **`secondary`** draws the lines: the title's rule and the lines between products. Never a background.
 * - **`secondaryInk`** is the secondary as text — headings, premium figures, *Langkah selanjutnya*.
 * - **`primaryInk`** is the primary as text — the product type labels. On paper the primary appears only as text.
 * - The `-ink` shades are ADR-0218 §5's palette: the colour darkened by `INK_STEP` until it reads 4.5:1 on white.
 */
export type PdfBranding = BrandingForPdf;

/**
 * **Without branding: AgencyBoost's** (AC-7; ADR-0223 §6, *"navy `#1B2B4B` and orange `#E8954A` on lines, navy and
 * `#A85E1B` as text"*) — the branding reader's own defaults, and the wordmark in place of a logo.
 */
export const AGENCYBOOST_PDF_BRANDING: PdfBranding = Object.freeze({ logo: null, ...AGENCYBOOST_COLOURS });

/**
 * **The one place the PDF reads a KPM's branding** (ADR-0222 §2: *"the KPM's branding as it is now"*), each time a file
 * is built, so a download again carries the colours and the logo the KPM shows today (AC-7).
 *
 * Through P19.6-T1's `BrandingReader.forPdf` (ADR-0218 §3): the KPM's own, else its template's published *Tampilan*,
 * else AgencyBoost's — the same resolution and the same palette function every screen of the KPM is painted with, so the
 * paper and the screens cannot differ.
 */
@Injectable()
export class ProposalBranding {
  constructor(private readonly reader: BrandingReader) {}

  async of(ctx: RequestContext): Promise<PdfBranding> {
    return ctx.kpmId ? this.reader.forPdf(ctx.kpmId) : AGENCYBOOST_PDF_BRANDING;
  }
}
