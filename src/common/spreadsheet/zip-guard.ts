import { HttpStatus } from '@nestjs/common';
import { unzipSync, zipSync, type Unzipped } from 'fflate';
import { DomainException } from '@/common/errors/domain.exception';
import { ErrorCode } from '@/common/errors/error-codes';
import type { Sentence } from '@/common/i18n/sentence';
import { SPREADSHEET } from '@/domain/constants';
import { SPREADSHEET_REFUSALS } from './spreadsheet.messages';

const SAY = SPREADSHEET_REFUSALS;

/** `PK\x03\x04`, a ZIP's first local file header — every `.xlsx` starts with it. */
const ZIP_MAGIC = [0x50, 0x4b, 0x03, 0x04];

/** Whether the bytes start like a ZIP: the one test that tells a workbook from a CSV before either is read. */
export function looksLikeZip(bytes: Uint8Array): boolean {
  return bytes.length >= ZIP_MAGIC.length && ZIP_MAGIC.every((b, i) => bytes[i] === b);
}

/** One part of an archive, as its central directory lists it. Nothing has been inflated to know this. */
export interface ZipPart {
  name: string;
  /** The bytes it occupies in the file. */
  compressedSize: number;
  /** The bytes it says it unpacks to — what the directory declares, which a hostile archive may understate. */
  size: number;
}

export const notAWorkbook = () => new DomainException(
  ErrorCode.UPLOAD_MALFORMED_CSV, SAY.UPLOAD_MALFORMED_CSV.notAWorkbook, HttpStatus.UNPROCESSABLE_ENTITY,
);

/** Too large inside: `ASSET_TOO_LARGE`, the code every upload over a bound answers, with the bound in `details`. */
export const tooLarge = (message: Sentence<'ASSET_TOO_LARGE'>, details: Record<string, unknown>) =>
  new DomainException(ErrorCode.ASSET_TOO_LARGE, message, HttpStatus.PAYLOAD_TOO_LARGE, details);

/**
 * **The archive's parts, from its central directory, with nothing inflated** (ADR-0184 §3).
 *
 * `fflate`'s `unzipSync` walks the directory and hands each entry to `filter` with its declared `originalSize` before it
 * would inflate it; answering `false` to every one reads the list and unpacks nothing. A directory with more than
 * `SPREADSHEET.MAX_ENTRIES` parts is refused as it is walked, so a directory of a million entries is not listed whole.
 * An archive whose directory cannot be found or read is not a workbook.
 */
export function listZip(bytes: Uint8Array): ZipPart[] {
  const parts: ZipPart[] = [];
  try {
    unzipSync(bytes, {
      filter: (file) => {
        parts.push({ name: file.name, compressedSize: file.size, size: file.originalSize });
        if (parts.length > SPREADSHEET.MAX_ENTRIES) {
          throw tooLarge(SAY.ASSET_TOO_LARGE.tooManyParts({ max: SPREADSHEET.MAX_ENTRIES }), { maxEntries: SPREADSHEET.MAX_ENTRIES });
        }
        return false;
      },
    });
  } catch (err) {
    if (err instanceof DomainException) throw err;
    throw notAWorkbook();
  }
  return parts;
}

/**
 * **Refuse a ZIP whose parts, as declared, add up to more than the workbook bound** — before anything is inflated.
 *
 * The declared sizes are the archive's own word, and the word is what bounds the next step: `unpackWithinLimits`
 * inflates each part into a buffer of exactly its declared size, so a part that understates is cut short there and
 * never grows past it. Together the two hold memory to `SPREADSHEET.MAX_UNCOMPRESSED_BYTES` whatever the archive says.
 */
export function checkZip(bytes: Uint8Array): ZipPart[] {
  const parts = listZip(bytes);
  const declared = parts.reduce((sum, part) => sum + part.size, 0);
  if (declared > SPREADSHEET.MAX_UNCOMPRESSED_BYTES) {
    throw tooLarge(
      SAY.ASSET_TOO_LARGE.unpacksTooLarge({ mb: SPREADSHEET.MAX_UNCOMPRESSED_BYTES / 1024 / 1024 }),
      { maxUncompressedBytes: SPREADSHEET.MAX_UNCOMPRESSED_BYTES },
    );
  }
  return parts;
}

/**
 * **The workbook, unpacked within its limits and packed again uncompressed** — the only bytes `exceljs` is given.
 *
 * Why not hand `exceljs` the upload itself: it unpacks with JSZip, which inflates a part to whatever size its stream
 * produces and checks the declared size only afterwards. A part whose directory entry says one kilobyte and whose
 * stream inflates to a gigabyte would pass `checkZip` and be inflated whole. So the parts are inflated here, by
 * `fflate`, each into a buffer the size its entry declares — a part that lies is truncated, its XML then fails to parse,
 * and the file is refused as not a workbook — and handed on **stored**, so what JSZip reads is at most what was checked.
 *
 * The cost of a lying part is time, not memory: its stream is still walked to its end, a megabyte of it at most (the
 * upload's ceiling), which is a second or so.
 */
export function unpackWithinLimits(bytes: Uint8Array): Uint8Array {
  checkZip(bytes);
  let parts: Unzipped;
  try {
    parts = unzipSync(bytes);
  } catch {
    throw notAWorkbook();
  }
  return zipSync(parts, { level: 0 });
}
