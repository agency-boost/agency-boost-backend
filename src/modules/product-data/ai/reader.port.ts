import type { FileReading, IllustrationReading } from './reading-schema';

/**
 * **The port the AI reading goes through** (P19.15-T2, T3; ADR-0259 §6): Claude in a deployment with
 * `ANTHROPIC_API_KEY`, a refusal that says reading is not switched on without it, and a fake in every test — so no test
 * ever calls the real API, as the mail adapters keep tests off the real mail service.
 */

/** A file as it is sent: a PDF and a picture as themselves, a workbook, a CSV and a Word file as text. */
export type ReadablePart =
  | { kind: 'pdf'; name: string; base64: string }
  | { kind: 'image'; name: string; base64: string; mediaType: 'image/jpeg' | 'image/png' }
  | { kind: 'text'; name: string; text: string; format: 'grid' | 'document' };

/** One product of the catalogue, as the model is told it: what it may match a name in the file to. */
export interface CatalogueEntry {
  id: string;
  companyId: string;
  code: string;
  name: string;
  syariahName: string | null;
  category: string;
  calcType: string;
  payTerms: { key: string; label: string }[];
  /** The money fields a formula may name (an illustration's), and `up` where the product has a sum assured. */
  formulaNames: string[];
  lifecycle: string;
}

export interface CompanyEntry { id: string; name: string }

export interface FileReadingInput {
  file: ReadablePart;
  /** The company the upload is for, or `null` on *Perusahaan*'s upload, where the file must say it. */
  company: CompanyEntry | null;
  companies: CompanyEntry[];
  catalogue: CatalogueEntry[];
  /** `YYYY-MM-DD`, in Asia/Jakarta: what *today* means to the model. */
  today: string;
}

export interface IllustrationReadingInput {
  file: Extract<ReadablePart, { kind: 'pdf' }>;
  product: CatalogueEntry;
  plan: string | null;
  today: string;
}

/** Tokens a reading took, for the cost the owner pays (ADR-0259 §7). Never the content. */
export interface ReadingUsage { inputTokens: number; outputTokens: number; model: string }

/**
 * **Why a reading failed**, in words a card can say: reading is off; Claude refused the request; the answer ran past its
 * bound; the answer did not fit the schema; the key was refused; Claude was busy or did not answer in time; the file was
 * refused (too many pages, too large); anything else.
 */
export type ReadingFailure =
  | 'not_configured' | 'refused' | 'too_long' | 'unreadable' | 'key_refused' | 'busy' | 'timeout' | 'file_refused'
  | 'service_error';

export type ReadingResult<T> =
  | { ok: true; value: T; usage: ReadingUsage }
  | { ok: false; failure: ReadingFailure; usage: ReadingUsage | null };

export abstract class ProductDataReader {
  /** Whether reading is switched on: a key is configured. The screens say so, and disable the button when not. */
  abstract get enabled(): boolean;

  /** **One file read**: every item it finds, each with its source, its certainty and its questions. */
  abstract readFile(input: FileReadingInput): Promise<ReadingResult<FileReading>>;

  /** **An official illustration condensed** into the PDF's five kinds of block, each with its page and its evidence. */
  abstract condenseIllustration(input: IllustrationReadingInput): Promise<ReadingResult<IllustrationReading>>;
}

/** The provider token: `ClaudeProductDataReader` with a key, `UnconfiguredProductDataReader` without, a fake in tests. */
export const PRODUCT_DATA_READER = Symbol('PRODUCT_DATA_READER');
