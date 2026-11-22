import { Injectable } from '@nestjs/common';

/** One product's published illustration, as the Proposal tab's *Ilustrasi* column reads it (*"Ada · 3 bagian"*). */
export interface IllustrationSummary {
  /** How many detail blocks it publishes. */
  blocks: number;
  publishedAt: string | null;
}

/**
 * **The *Ilustrasi* column's read** (P19.15-T4 AC-1; the P1b spec's §2): which of a company's products have a published
 * illustration, and how many blocks. A port, so the list (T1) does not wait on *Ilustrasi* (T2, ADR-0259): D3 provides it
 * from its `illustrations` collection; until then nothing is published and every row reads *Belum ada*.
 */
export abstract class IllustrationSummaries {
  /** By product id: the products of `companyId` with a published illustration. */
  abstract ofCompany(companyId: string): Promise<Map<string, IllustrationSummary>>;
}

/** No illustration published anywhere — the column's *Belum ada* — until *Ilustrasi* provides the port. */
@Injectable()
export class NoIllustrations extends IllustrationSummaries {
  async ofCompany(): Promise<Map<string, IllustrationSummary>> {
    return new Map();
  }
}
