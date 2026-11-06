import { ASSET_LIMITS } from '@/domain/constants';

/**
 * **What a file's first bytes say it is** (P18.4-T2, ADR-0153, keeping ADR-0040's guarantee).
 *
 * Cloudinary read the bytes and reported the type it found. Google Cloud Storage reads nothing: it stores the
 * `Content-Type` the browser's form named, and the signed POST policy only pins that claim to the one type the
 * service already checked. So the type is read here from the bytes, and **the bytes win over the claim**, as they
 * did with Cloudinary (the code review's L6): a PNG saved as `.jpg` — a WhatsApp image, a picture saved from the
 * web — is reported as `image/png`, and the route's own list then decides whether it may stay (an image route
 * keeps it as what it is; a PDF-only route refuses it). Bytes that match no accepted type are reported as
 * `application/octet-stream`, which no allow-list holds, so the confirm step refuses them
 * (`AssetService.refuseBeyondLimits`).
 *
 * **This is a type check, not a malware check** (ADR-0040 still stands: v1 does not scan). It stops a file being
 * stored and delivered as something it is not — an executable renamed `.pdf` — and nothing more.
 */
export const OCTET_STREAM = 'application/octet-stream';

/** How much of an object is read to decide its type: enough for every signature below, never the whole file. */
export const SNIFF_SAMPLE_BYTES = 4096;

type AllowedMimeType = (typeof ASSET_LIMITS.ALLOWED_MIME_TYPES)[number];
const XLSX = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

const startsWith = (sample: Buffer, bytes: readonly number[], offset = 0): boolean =>
  sample.length >= offset + bytes.length && bytes.every((byte, i) => sample[offset + i] === byte);

const ascii = (text: string): number[] => [...text].map((c) => c.charCodeAt(0));

/**
 * One test per accepted type, keyed by exactly `ALLOWED_MIME_TYPES` — the record's type makes a type added to the
 * allow-list without a signature here a compile error, and `content-sniff.spec.ts` pins the same from the other
 * side.
 *
 * - **pdf**: `%PDF-` anywhere in the first 1024 bytes, the window the PDF specification allows a header in.
 * - **mp4**: `ftyp` at offset 4, the ISO base media box every MP4 opens with. A QuickTime `.mov` carries one too and
 *   passes; it is still a video, and the browser's player decides whether it plays.
 * - **xlsx**: a zip's local file header, `PK 03 04`. **Any zip passes** — a `.docx`, a `.jar` — because telling an
 *   OOXML workbook from another zip means reading its central directory, which a 4 KB sample does not reach. Good
 *   enough at this layer: the file is still delivered only as an attachment (`gcs.adapter.ts`), never rendered.
 * - **csv**: text has no signature, so **only the claim can name it**: declared `text/csv`, and no NUL byte in the
 *   sample, which every binary format above (and an executable) carries in its first few bytes. A CSV is never
 *   *detected* under another claim.
 * - **html** (P19.6-T2, ADR-0217 §2): text again, so **only the claim can name it** too: declared `text/html`, no NUL
 *   byte in the sample, and — after an optional UTF-8 byte-order mark, white space and `<!-- … -->` comments — it
 *   begins `<!doctype html` or `<html`, in any case. A file that claims HTML and is not one is
 *   `application/octet-stream`, which every list refuses.
 */
const SIGNATURES: Readonly<Record<AllowedMimeType, (sample: Buffer, declared: string) => boolean>> = {
  'image/jpeg': (s) => startsWith(s, [0xff, 0xd8, 0xff]),
  'image/png': (s) => startsWith(s, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  'image/webp': (s) => startsWith(s, ascii('RIFF')) && startsWith(s, ascii('WEBP'), 8),
  'video/mp4': (s) => startsWith(s, ascii('ftyp'), 4),
  [XLSX]: (s) => startsWith(s, [0x50, 0x4b, 0x03, 0x04]),
  'application/pdf': (s) => s.subarray(0, 1024).includes('%PDF-', 0, 'latin1'),
  'text/csv': (s, declared) => declared === 'text/csv' && s.length > 0 && !s.includes(0),
  'text/html': (s, declared) => declared === 'text/html' && !s.includes(0) && opensAsHtml(s),
};

/**
 * **The order the signatures are tried, which is what makes the answer one type.** The signatures anchored at a
 * fixed offset come first, because each is exact. The PDF's 1024-byte window comes after them, so a zip or an image
 * that happens to contain the text `%PDF-` is still the zip or the image. Text comes last, because only the claim
 * names it — so a file claimed as CSV whose first 1024 bytes hold `%PDF-` reads as a PDF, and the route's list
 * decides, as it does for any file whose bytes contradict its claim. HTML is tried before CSV (ADR-0217 §2); the two
 * never meet, since each needs its own claim.
 */
export const SNIFFED_TYPES: readonly AllowedMimeType[] = [
  'image/jpeg', 'image/png', 'image/webp', 'video/mp4', XLSX, 'application/pdf', 'text/html', 'text/csv',
];

/** The UTF-8 byte-order mark an editor may write before the first character. */
const UTF8_BOM = [0xef, 0xbb, 0xbf];
/** HTML's white space: space, tab, line feed, form feed, carriage return. */
const HTML_SPACE = new Set([0x20, 0x09, 0x0a, 0x0c, 0x0d]);
const COMMENT_OPEN = '<!--';
const COMMENT_CLOSE = '-->';
const HTML_OPENINGS = ['<!doctype html', '<html'];

/**
 * **Does the sample open as an HTML document** (ADR-0217 §2): past an optional byte-order mark, white space and any
 * number of comments, `<!doctype html` or `<html`, in any case. A comment still open at the sample's end is not one.
 */
function opensAsHtml(sample: Buffer): boolean {
  const text = sample.toString('latin1');
  let at = startsWith(sample, UTF8_BOM) ? UTF8_BOM.length : 0;
  for (;;) {
    while (at < text.length && HTML_SPACE.has(text.charCodeAt(at))) at += 1;
    if (!text.startsWith(COMMENT_OPEN, at)) break;
    const close = text.indexOf(COMMENT_CLOSE, at + COMMENT_OPEN.length);
    if (close < 0) return false;
    at = close + COMMENT_CLOSE.length;
  }
  const head = text.slice(at, at + HTML_OPENINGS[0].length).toLowerCase();
  return HTML_OPENINGS.some((opening) => head.startsWith(opening));
}

/**
 * **The accepted type the sample's bytes are, whatever was claimed; `application/octet-stream` when they are
 * none.** The claim matters only for CSV and HTML, which no bytes can identify. Pure: the caller reads the sample, at most
 * `SNIFF_SAMPLE_BYTES` from the start of the object.
 */
export function sniffedContentType(declared: string, sample: Buffer): string {
  return SNIFFED_TYPES.find((type) => SIGNATURES[type](sample, declared)) ?? OCTET_STREAM;
}
