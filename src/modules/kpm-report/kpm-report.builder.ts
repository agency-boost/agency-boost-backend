import { Injectable } from '@nestjs/common';
import type { TDocumentDefinitions } from 'pdfmake/interfaces';
import { KPM_REPORT } from '@/domain/constants';
import { pdfRuler, renderPdf, type RenderedPdf } from '@/modules/proposals/proposal-pdf.builder';
import { kpmReportDocument } from './kpm-report.layout';
import type { KpmReportModel } from './kpm-report.model';

/**
 * **The KPM report's file, built in memory each time and never kept** (P19.24-T1 AC-3;
 * [ADR-0280](../../../../docs/04-adr/0280-the-kpm-report-is-one-pdf-built-on-the-server-from-the-pages-own-readings.md) §4).
 *
 * - **The proposal's renderer** (`renderPdf`; ADR-0222 §3, ADR-0256): the app's three Inter files, loaded once into
 *   `pdfmake`'s own memory, **no URL fetched and no local path read** while a document is made. The report adds no font
 *   and no image.
 * - **The pages are counted** from the footer every page is given (*"hal. x / n"*).
 * - **At most `KPM_REPORT.CONCURRENCY` builds at once** in one process; the others wait their turn, so a burst of reports
 *   cannot carry the 512 MB container past its limit.
 */
@Injectable()
export class KpmReportBuilder {
  private running = 0;
  private readonly queue: (() => void)[] = [];

  constructor() {
    // The fonts are read when the API starts, as the proposal's builder reads them.
    pdfRuler();
  }

  async build(model: KpmReportModel, createdAt: Date): Promise<RenderedPdf> {
    await this.turn();
    try {
      return await this.render(kpmReportDocument(model, createdAt));
    } finally {
      this.done();
    }
  }

  /** One render; a seam a test may replace. */
  protected render(definition: TDocumentDefinitions): Promise<RenderedPdf> {
    return renderPdf(definition);
  }

  private turn(): Promise<void> {
    if (this.running < KPM_REPORT.CONCURRENCY) {
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
