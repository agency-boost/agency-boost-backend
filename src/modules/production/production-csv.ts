import { HttpStatus } from '@nestjs/common';
import { DomainException } from '@/common/errors/domain.exception';
import { ErrorCode } from '@/common/errors/error-codes';
import type { Sentence } from '@/common/i18n/sentence';
import { decodeText, decodeWindows1252, type TextEncoding } from '@/common/spreadsheet/text';
import { PRODUCTION_REFUSALS } from './production.messages';

const SAY = PRODUCTION_REFUSALS.UPLOAD_MALFORMED_CSV;

/**
 * Bytes to records, for a file that may have been through a spreadsheet (P9-T3, ADR-0052).
 *
 * Everything here is about **form**: which encoding, which delimiter, where a field starts and ends.
 * Nothing here knows what a column means — that is `production-preview.ts`. The split is so each
 * half can be tested against literals without the other.
 */

export type UploadEncoding = TextEncoding;
export type UploadDelimiter = ',' | ';' | '\t';

/** A record as a spreadsheet would number it: the line it starts on, and its fields, untrimmed. */
export interface CsvRecord {
  line: number;
  cells: string[];
}

const malformed = (message: Sentence<'UPLOAD_MALFORMED_CSV'>, details?: Record<string, unknown>) =>
  new DomainException(ErrorCode.UPLOAD_MALFORMED_CSV, message, HttpStatus.UNPROCESSABLE_ENTITY, details);

/**
 * The bytes of a CSV as text: UTF-8, and Windows-1252 when they are not valid UTF-8 (ADR-0052) — `decodeText`, which
 * the roster's file shares since ADR-0184 moved it to `common/spreadsheet/text.ts`.
 *
 * **Refused here, whole**: an empty file, and anything with a NUL byte in it, which no text file has. **A workbook is
 * not refused any more** (ADR-0184): `readFileUpload` (`production-preview.ts`) sends one to `readXlsx` before it would
 * reach this, and a ZIP that did reach it has NUL bytes and is answered as neither text nor a workbook.
 */
export function decodeUpload(bytes: Uint8Array): { text: string; encoding: UploadEncoding } {
  if (bytes.length === 0) throw malformed(SAY.empty);
  return decodeText(bytes);
}

export { decodeWindows1252 };

/**
 * Comma, semicolon or tab — whichever the header line uses most, counted outside quotes.
 *
 * **Decided once, from the header.** None of the template's column names holds any of the three, so
 * the header's separators are exactly thirteen of one kind. Guessing per row would let one stray
 * character change how a single line is read; the file has one shape. The roster import's rule,
 * extended by the semicolon a spreadsheet writes under Indonesian regional settings.
 */
export function delimiterOf(text: string): UploadDelimiter {
  const counts: Record<UploadDelimiter, number> = { ',': 0, ';': 0, '\t': 0 };
  let quoted = false;
  for (const c of text) {
    if (c === '"') quoted = !quoted;
    else if (!quoted && (c === '\n' || c === '\r')) break;
    else if (!quoted && c in counts) counts[c as UploadDelimiter] += 1;
  }
  return (Object.keys(counts) as UploadDelimiter[]).reduce((best, d) => (counts[d] > counts[best] ? d : best), ',');
}

/**
 * RFC 4180, with the line each record starts on.
 *
 * A quoted field may hold the delimiter, a doubled quote and a line break. An unquoted field is taken
 * as it is, stray quote and all — a spreadsheet never writes one, and refusing a whole file for it
 * would be refusing on form. **A quote that is opened and never closed is refused**, because
 * everything after it would be read as one field and there is no honest way to say where it ends.
 *
 * Line endings are `\n`, `\r\n` or a bare `\r`: whatever the file used.
 */
export function parseCsv(text: string, delimiter: UploadDelimiter): CsvRecord[] {
  const records: CsvRecord[] = [];
  let cells: string[] = [];
  let field = '';
  let quoted = false;
  let line = 1;
  let recordLine = 1;
  let quoteOpenedOn = 0;

  const endField = () => { cells.push(field); field = ''; };
  const endRecord = () => {
    endField();
    records.push({ line: recordLine, cells });
    cells = [];
  };

  for (let i = 0; i < text.length; i += 1) {
    const c = text[i];
    if (quoted) {
      if (c === '"' && text[i + 1] === '"') { field += '"'; i += 1; }
      else if (c === '"') quoted = false;
      else {
        if (c === '\n' || (c === '\r' && text[i + 1] !== '\n')) line += 1;
        field += c;
      }
      continue;
    }
    if (c === '"' && field.trim() === '') { quoted = true; quoteOpenedOn = line; field = ''; }
    else if (c === delimiter) endField();
    else if (c === '\r' || c === '\n') {
      if (c === '\r' && text[i + 1] === '\n') i += 1;
      endRecord();
      line += 1;
      recordLine = line;
    } else field += c;
  }

  if (quoted) throw malformed(SAY.unclosedQuote({ line: quoteOpenedOn }), { line: quoteOpenedOn });
  // The last record, unless the file ended on a line break.
  if (field !== '' || cells.length > 0) endRecord();
  return records;
}
