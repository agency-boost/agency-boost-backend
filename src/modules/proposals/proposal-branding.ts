import { Injectable } from '@nestjs/common';
import { RequestContext } from '@/common/context/request-context';
import { AGENCYBOOST_COLOURS, BrandingReader, type BrandingForPdf } from '@/modules/branding/branding-reader';
import { PDF_WORDS } from './proposal-pdf.words';

/**
 * **What the proposal's PDF draws of a KPM's branding** (P19.14-T3 AC-4; ADR-0256 §3, §5).
 *
 * - **`branded`**: the KPM shows a logo or a pair of colours, its own or its template's. Then **its name and its logo
 *   stand everywhere AgencyBoost's would, and "AgencyBoost" is printed nowhere in the file**. Without branding, the file
 *   is AgencyBoost's: the 3-dot logo and its name.
 * - **`main` and `second`: the spec's *main colour* and *second colour*, mapped by role** (ADR-0256 §3). The main colour
 *   carries the bands, the blocks and the agent's card — **the KPM's *Warna kedua*** (`secondary`), which ADR-0218 §6 gives
 *   the header and hero cards; the second colour carries the stripe, the edges, the pills and the dots — **its *Warna
 *   utama*** (`primary`), the accent. So AgencyBoost's own defaults give the spec's navy and orange, a KPM's file wears the
 *   colours its screens do, and a KPM that sets AgencyBoost's two colours gets AgencyBoost's file.
 * - **`logo`**: the square logo, else the wide one (`BrandingReader.forPdf`); `null` draws the KPM's initials.
 */
export interface PdfBranding {
  branded: boolean;
  /** The KPM's name when branded; *AgencyBoost* otherwise. */
  name: string;
  logo: BrandingForPdf['logo'];
  main: string;
  second: string;
}

/** **Without branding: AgencyBoost's** — its name, the 3-dot logo (no image file), navy and orange from the tokens. */
export const AGENCYBOOST_PDF_BRANDING: PdfBranding = Object.freeze({
  branded: false,
  name: PDF_WORDS.agencyBoost,
  logo: null,
  main: AGENCYBOOST_COLOURS.secondary,
  second: AGENCYBOOST_COLOURS.primary,
});

/** **The mapping** (ADR-0256 §3): what `forPdf` reads, as the PDF draws it. */
export function pdfBrandingOf(shown: BrandingForPdf): PdfBranding {
  if (!shown.branded) return AGENCYBOOST_PDF_BRANDING;
  return {
    branded: true,
    name: shown.name.trim(),
    logo: shown.logo,
    main: shown.secondary ?? AGENCYBOOST_COLOURS.secondary,
    second: shown.primary ?? AGENCYBOOST_COLOURS.primary,
  };
}

/**
 * **The one place the PDF reads a KPM's branding** (ADR-0222 §2: *"the KPM's branding as it is now"*), each time a file
 * is built, so a download again carries the branding the KPM shows today. Through `BrandingReader.forPdf` (ADR-0218 §3):
 * the KPM's own, else its template's published *Tampilan*, else AgencyBoost's.
 */
@Injectable()
export class ProposalBranding {
  constructor(private readonly reader: BrandingReader) {}

  async of(ctx: RequestContext): Promise<PdfBranding> {
    return ctx.kpmId ? pdfBrandingOf(await this.reader.forPdf(ctx.kpmId)) : AGENCYBOOST_PDF_BRANDING;
  }
}
