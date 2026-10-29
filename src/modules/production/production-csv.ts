import { HttpStatus } from '@nestjs/common';
import { DomainException } from '@/common/errors/domain.exception';
import { ErrorCode } from '@/common/errors/error-codes';
import type { Sentence } from '@/common/i18n/sentence';
import { PRODUCTION_REFUSALS } from './production.messages';

const SAY = PRODUCTION_REFUSALS.UPLOAD_MALFORMED_CSV;

/**
 * Bytes to records, for a file that may have been through a spreadsheet (P9-T3, ADR-0052).
 *
 * Everything here is about **form**: which encoding, which delimiter, where a field starts and ends.
 * Nothing here knows what a column means — that is `production-preview.ts`. The split is so each
 * half can be tested against literals without the other.
 */

export type UploadEncoding = 'utf-8' | 'windows-1252';
export type UploadDelimiter = ',' | ';' | '\t';

/** A record as a spreadsheet would number it: the line it starts on, and its fields, untrimmed. */
export interface CsvRecord {
  line: number;
  cells: string[];
}

const malformed = (message: Sentence<'UPLOAD_MALFORMED_CSV'>, details?: Record<string, unknown>) =>
  new DomainException(ErrorCode.UPLOAD_MALFORMED_CSV, message, HttpStatus.UNPROCESSABLE_ENTITY, details);

/** `PK\x03\x04` — every `.xlsx` is a zip. */
const ZIP_MAGIC = [0x50, 0x4b, 0x03, 0x04];
const UTF8_BOM = [0xef, 0xbb, 0xbf];

const startsWith = (bytes: Uint8Array, prefix: number[]) => prefix.every((b, i) => bytes[i] === b);

/**
 * The bytes as text: UTF-8, and Windows-1252 when they are not valid UTF-8 (ADR-0052).
 *
 * **Why the order.** The template is issued as UTF-8 with a byte-order mark. A spreadsheet that saves
 * it as *CSV UTF-8* keeps both; one that saves it as plain *CSV* writes the machine's code page, where
 * the header's em dash is the single byte `0x97` — which is not valid UTF-8, and is how the fallback
 * is chosen. Windows-1252 decodes every byte, so the fallback cannot fail; a file that is neither
 * reaches the header check and is refused there, with a message about its columns.
 *
 * **Refused here, whole**: an empty file, a workbook saved as `.xlsx`, and anything with a NUL byte
 * in it, which no text file has.
 */
export function decodeUpload(bytes: Uint8Array): { text: string; encoding: UploadEncoding } {
  if (bytes.length === 0) throw malformed(SAY.empty);
  if (startsWith(bytes, ZIP_MAGIC)) throw malformed(SAY.workbook);
  if (bytes.includes(0)) throw malformed(SAY.notText);

  const body = startsWith(bytes, UTF8_BOM) ? bytes.subarray(UTF8_BOM.length) : bytes;
  try {
    return { text: new TextDecoder('utf-8', { fatal: true }).decode(body), encoding: 'utf-8' };
  } catch {
    return { text: decodeWindows1252(body), encoding: 'windows-1252' };
  }
}

/**
 * Windows-1252's 0x80–0x9F, where it differs from Latin-1. The five bytes it leaves undefined keep
 * their Latin-1 control character, as the WHATWG decoder does.
 */
const CP1252_HIGH: Record<number, number> = {
  0x80: 0x20ac, 0x82: 0x201a, 0x83: 0x0192, 0x84: 0x201e, 0x85: 0x2026, 0x86: 0x2020, 0x87: 0x2021,
  0x88: 0x02c6, 0x89: 0x2030, 0x8a: 0x0160, 0x8b: 0x2039, 0x8c: 0x0152, 0x8e: 0x017d,
  0x91: 0x2018, 0x92: 0x2019, 0x93: 0x201c, 0x94: 0x201d, 0x95: 0x2022, 0x96: 0x2013, 0x97: 0x2014,
  0x98: 0x02dc, 0x99: 0x2122, 0x9a: 0x0161, 0x9b: 0x203a, 0x9c: 0x0153, 0x9e: 0x017e, 0x9f: 0x0178,
};

/**
 * **Not `new TextDecoder('windows-1252')`.** Node accepts the label and decodes Latin-1, where
 * `0x97` is a C1 control character and not the em dash — so the one byte this fallback exists for
 * would vanish from the header. Found by this module's own test; the table above is the difference.
 */
export function decodeWindows1252(bytes: Uint8Array): string {
  let out = '';
  for (const b of bytes) out += String.fromCharCode(CP1252_HIGH[b] ?? b);
  return out;
}

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
