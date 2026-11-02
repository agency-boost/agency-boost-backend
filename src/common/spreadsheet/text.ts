import { HttpStatus } from '@nestjs/common';
import { DomainException } from '@/common/errors/domain.exception';
import { ErrorCode } from '@/common/errors/error-codes';
import { SPREADSHEET_REFUSALS } from './spreadsheet.messages';

/** How the bytes of a text upload were read. */
export type TextEncoding = 'utf-8' | 'windows-1252';

const UTF8_BOM = [0xef, 0xbb, 0xbf];

/**
 * **The bytes of a CSV as text: UTF-8, and Windows-1252 when they are not valid UTF-8** (ADR-0052). Moved here from
 * the Data upload on 2026-11-01 (ADR-0184) so the roster's file is read the same way.
 *
 * **Why the order.** A template is saved as UTF-8; a spreadsheet that saves it as *CSV UTF-8* keeps it so, and one that
 * saves it as plain *CSV* writes the machine's code page, where an em dash is the single byte `0x97` — not valid UTF-8,
 * which is how the fallback is chosen. Windows-1252 decodes every byte, so the fallback cannot fail; a file that is
 * neither reaches its parser and is refused there, about its columns. A byte-order mark is dropped.
 *
 * **Refused here: a NUL byte**, which no text file has — a PDF, an image, an old `.xls`. Empty bytes are text; whether
 * an empty file is a refusal is the caller's to say.
 */
export function decodeText(bytes: Uint8Array): { text: string; encoding: TextEncoding } {
  if (bytes.includes(0)) {
    throw new DomainException(
      ErrorCode.UPLOAD_MALFORMED_CSV, SPREADSHEET_REFUSALS.UPLOAD_MALFORMED_CSV.notText, HttpStatus.UNPROCESSABLE_ENTITY,
    );
  }
  const body = UTF8_BOM.every((b, i) => bytes[i] === b) ? bytes.subarray(UTF8_BOM.length) : bytes;
  try {
    return { text: new TextDecoder('utf-8', { fatal: true }).decode(body), encoding: 'utf-8' };
  } catch {
    return { text: decodeWindows1252(body), encoding: 'windows-1252' };
  }
}

/**
 * Windows-1252's 0x80–0x9F, where it differs from Latin-1. The five bytes it leaves undefined keep their Latin-1 control
 * character, as the WHATWG decoder does.
 */
const CP1252_HIGH: Record<number, number> = {
  0x80: 0x20ac, 0x82: 0x201a, 0x83: 0x0192, 0x84: 0x201e, 0x85: 0x2026, 0x86: 0x2020, 0x87: 0x2021,
  0x88: 0x02c6, 0x89: 0x2030, 0x8a: 0x0160, 0x8b: 0x2039, 0x8c: 0x0152, 0x8e: 0x017d,
  0x91: 0x2018, 0x92: 0x2019, 0x93: 0x201c, 0x94: 0x201d, 0x95: 0x2022, 0x96: 0x2013, 0x97: 0x2014,
  0x98: 0x02dc, 0x99: 0x2122, 0x9a: 0x0161, 0x9b: 0x203a, 0x9c: 0x0153, 0x9e: 0x017e, 0x9f: 0x0178,
};

/**
 * **Not `new TextDecoder('windows-1252')`.** Node accepts the label and decodes Latin-1, where `0x97` is a C1 control
 * character and not the em dash — so the one byte this fallback exists for would vanish from the header. Found by the
 * Data upload's own test; the table above is the difference.
 */
export function decodeWindows1252(bytes: Uint8Array): string {
  let out = '';
  for (const b of bytes) out += String.fromCharCode(CP1252_HIGH[b] ?? b);
  return out;
}
