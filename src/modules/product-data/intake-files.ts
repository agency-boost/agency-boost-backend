import { HttpStatus } from '@nestjs/common';
import { Workbook } from 'exceljs';
import { strFromU8, unzipSync } from 'fflate';
import sharp from 'sharp';
import { DomainException } from '@/common/errors/domain.exception';
import { ErrorCode } from '@/common/errors/error-codes';
import { cellText } from '@/common/spreadsheet/read-xlsx';
import { decodeText } from '@/common/spreadsheet/text';
import { unpackWithinLimits } from '@/common/spreadsheet/zip-guard';
import { INTAKE, type IntakeFileKind } from '@/domain/constants';
import { delimiterOf, parseCsv } from '@/modules/production/production-csv';
import type { ReadablePart } from './ai/reader.port';
import { INTAKE_REFUSALS } from './intake.messages';

const SAY = INTAKE_REFUSALS;

/**
 * **An upload's files, typed from their bytes and made readable** (P19.15-T3 AC-1; ADR-0259 §2).
 *
 * - **The bytes decide the kind**, never the name nor the browser's claim — as `assets/content-sniff.ts` does for every
 *   other upload. The whole file is here (it arrived as a form, not through a signed upload), so a ZIP is told apart from
 *   a workbook and a Word file by its own directory: `xl/workbook.xml` is a workbook, `word/document.xml` a Word file,
 *   anything else a ZIP of files. Text has no signature: only a name ending `.csv` or a `text/csv` claim makes one, and
 *   only with no NUL byte.
 * - **A ZIP is unpacked here, within its bounds** (`INTAKE.ZIP_*`): its directory is read before anything is inflated, a
 *   ZIP inside it is refused, and a folder or a hidden file (`__MACOSX/`, `.DS_Store`) is skipped.
 * - **What Claude does not read natively is converted here, without a new dependency**: a workbook to a grid of text with
 *   each cell's sheet and address (`exceljs`, through the same zip guard every workbook upload passes), a CSV to the same
 *   grid (the Data upload's decoder), a Word file to its text (its `word/document.xml`, unzipped by `fflate` and stripped
 *   of its XML). A PDF goes as a document and a picture as an image, scaled down to what the model reads in full.
 */

/** One file as it is read: the file itself, or one of a ZIP's files. */
export interface PreparedFile {
  /** The name a card shows: `tarif.xlsx`, or `kiriman.zip › tarif.xlsx`. */
  name: string;
  kind: IntakeFileKind;
  mimeType: string;
  bytes: Buffer;
  /** The ZIP it came out of, by name; `null` for a file uploaded as itself. */
  fromZip: string | null;
}

/** One cell of a grid, with its address as the spreadsheet shows it. */
export interface GridCell { col: string; text: string }
export interface GridRow { row: number; cells: GridCell[] }
export interface GridSheet { name: string; rows: GridRow[] }

const ZIP = [0x50, 0x4b, 0x03, 0x04];
const starts = (b: Uint8Array, sig: readonly number[], at = 0) => sig.every((x, i) => b[at + i] === x);
const ascii = (s: string) => [...s].map((c) => c.charCodeAt(0));

const XLSX_MIME = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
const DOCX_MIME = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';

export const notAccepted = (name: string) => new DomainException(
  ErrorCode.ASSET_TYPE_NOT_ALLOWED, SAY.ASSET_TYPE_NOT_ALLOWED.notAccepted({ name }), HttpStatus.UNSUPPORTED_MEDIA_TYPE,
  { name, allowed: ['xlsx', 'csv', 'pdf', 'png', 'jpeg', 'webp', 'docx', 'zip'] },
);

const tooLarge = (message: ReturnType<typeof SAY.ASSET_TOO_LARGE.uploadTooLarge>, details: Record<string, unknown>) =>
  new DomainException(ErrorCode.ASSET_TOO_LARGE, message, HttpStatus.PAYLOAD_TOO_LARGE, details);

/** The names inside a ZIP, from its directory, with nothing inflated; `null` when it is no readable ZIP. */
function zipNames(bytes: Uint8Array): { name: string; size: number }[] | null {
  const names: { name: string; size: number }[] = [];
  try {
    unzipSync(bytes, {
      filter: (file) => {
        names.push({ name: file.name, size: file.originalSize });
        if (names.length > 2_000) throw new Error('directory too long');
        return false;
      },
    });
  } catch {
    return null;
  }
  return names;
}

/** **What the bytes are**: one of the five kinds read, a ZIP of files, or nothing accepted (`null`). */
export function kindOf(name: string, declared: string, bytes: Uint8Array): IntakeFileKind | 'zip' | null {
  if (starts(bytes, ZIP)) {
    const names = zipNames(bytes);
    if (!names) return null;
    if (names.some((n) => n.name === 'xl/workbook.xml')) return 'xlsx';
    if (names.some((n) => n.name === 'word/document.xml')) return 'docx';
    return 'zip';
  }
  if (Buffer.from(bytes.subarray(0, 1024)).includes('%PDF-', 0, 'latin1')) return 'pdf';
  if (starts(bytes, [0xff, 0xd8, 0xff])) return 'image';
  if (starts(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return 'image';
  if (starts(bytes, ascii('RIFF')) && starts(bytes, ascii('WEBP'), 8)) return 'image';
  const csvByName = /\.(csv|txt)$/i.test(name) || declared === 'text/csv';
  if (csvByName && bytes.length > 0 && !bytes.includes(0)) return 'csv';
  return null;
}

function mimeOf(kind: IntakeFileKind, bytes: Uint8Array): string {
  switch (kind) {
    case 'xlsx': return XLSX_MIME;
    case 'docx': return DOCX_MIME;
    case 'pdf': return 'application/pdf';
    case 'csv': return 'text/csv';
    case 'image':
      if (starts(bytes, [0xff, 0xd8, 0xff])) return 'image/jpeg';
      if (starts(bytes, [0x89, 0x50])) return 'image/png';
      return 'image/webp';
  }
}

/** A ZIP's own files, each typed, within `INTAKE.ZIP_*`; a ZIP inside it is refused. */
function unpack(zipName: string, bytes: Uint8Array): PreparedFile[] {
  const names = zipNames(bytes);
  if (!names) throw notAccepted(zipName);
  const files = names.filter((n) => !n.name.endsWith('/') && !/(^|\/)(__MACOSX|\.)/.test(n.name));
  if (files.length > INTAKE.ZIP_ENTRIES_MAX) {
    throw tooLarge(SAY.ASSET_TOO_LARGE.zipTooManyFiles({ name: zipName, max: INTAKE.ZIP_ENTRIES_MAX }), { maxEntries: INTAKE.ZIP_ENTRIES_MAX });
  }
  const declared = files.reduce((sum, n) => sum + n.size, 0);
  if (declared > INTAKE.ZIP_UNPACKED_MAX_BYTES) {
    throw tooLarge(SAY.ASSET_TOO_LARGE.zipUnpacksTooLarge({ name: zipName, mb: INTAKE.ZIP_UNPACKED_MAX_BYTES / 1024 / 1024 }), {
      maxUnpackedBytes: INTAKE.ZIP_UNPACKED_MAX_BYTES,
    });
  }
  const wanted = new Set(files.map((f) => f.name));
  let parts: Record<string, Uint8Array>;
  try {
    parts = unzipSync(bytes, { filter: (file) => wanted.has(file.name) && file.originalSize <= INTAKE.FILE_MAX_BYTES });
  } catch {
    throw notAccepted(zipName);
  }
  return files.map((entry) => {
    const inner = parts[entry.name];
    const shown = `${zipName} › ${entry.name.split('/').pop()}`;
    if (!inner) throw tooLarge(SAY.ASSET_TOO_LARGE.fileTooLarge({ name: shown, mb: INTAKE.FILE_MAX_BYTES / 1024 / 1024 }), { maxBytes: INTAKE.FILE_MAX_BYTES });
    const kind = kindOf(entry.name, '', inner);
    if (kind === 'zip' || /\.zip$/i.test(entry.name)) {
      throw new DomainException(ErrorCode.ASSET_TYPE_NOT_ALLOWED, SAY.ASSET_TYPE_NOT_ALLOWED.zipInZip({ name: shown }), HttpStatus.UNSUPPORTED_MEDIA_TYPE, { name: shown });
    }
    if (!kind) throw notAccepted(shown);
    const body = Buffer.from(inner);
    return { name: shown, kind, mimeType: mimeOf(kind, body), bytes: body, fromZip: zipName };
  });
}

/** One file as the form carried it. */
export interface UploadedFile { originalname: string; mimetype?: string; buffer: Buffer; size: number }

/**
 * **An upload's files, checked and typed, ZIPs unpacked** — refused whole, naming the file, when any is too large, of a
 * kind not read, or a ZIP holding a ZIP. Nothing is stored before this has passed.
 */
export function prepareUpload(files: readonly UploadedFile[]): PreparedFile[] {
  if (files.length === 0) {
    throw new DomainException(ErrorCode.VALIDATION_FAILED, SAY.VALIDATION_FAILED.noFiles, HttpStatus.BAD_REQUEST, { field: 'files' });
  }
  if (files.length > INTAKE.FILES_MAX) {
    throw new DomainException(ErrorCode.VALIDATION_FAILED, SAY.VALIDATION_FAILED.tooManyFiles({ max: INTAKE.FILES_MAX }), HttpStatus.BAD_REQUEST, {
      field: 'files', max: INTAKE.FILES_MAX,
    });
  }
  const total = files.reduce((sum, f) => sum + f.size, 0);
  if (total > INTAKE.UPLOAD_MAX_BYTES) {
    throw tooLarge(SAY.ASSET_TOO_LARGE.uploadTooLarge({ mb: INTAKE.UPLOAD_MAX_BYTES / 1024 / 1024 }), { maxBytes: INTAKE.UPLOAD_MAX_BYTES });
  }
  const out: PreparedFile[] = [];
  for (const file of files) {
    const name = file.originalname.normalize('NFC').slice(0, 200) || 'file';
    if (file.size === 0) throw notAccepted(name);
    const kind = kindOf(name, file.mimetype ?? '', file.buffer);
    if (!kind) throw notAccepted(name);
    if (kind === 'zip') out.push(...unpack(name, file.buffer));
    else out.push({ name, kind, mimeType: mimeOf(kind, file.buffer), bytes: file.buffer, fromZip: null });
  }
  if (out.length > INTAKE.READ_FILES_MAX) {
    throw new DomainException(ErrorCode.VALIDATION_FAILED, SAY.VALIDATION_FAILED.tooManyFiles({ max: INTAKE.READ_FILES_MAX }), HttpStatus.BAD_REQUEST, {
      field: 'files', max: INTAKE.READ_FILES_MAX,
    });
  }
  return out;
}

// ------------------------------------------------------------------------------------------------ grids

/** `1` → `A`, `28` → `AB`. */
export function columnLetter(n: number): string {
  let s = '';
  let x = n;
  while (x > 0) {
    const r = (x - 1) % 26;
    s = String.fromCharCode(65 + r) + s;
    x = Math.floor((x - 1) / 26);
  }
  return s;
}

/** **A workbook's every sheet as a grid** — each value as text, merged cells written once at their first cell. */
export async function workbookGrid(bytes: Uint8Array): Promise<GridSheet[]> {
  const workbook = new Workbook();
  await workbook.xlsx.load(Buffer.from(unpackWithinLimits(bytes)) as unknown as Parameters<Workbook['xlsx']['load']>[0]);
  const sheets: GridSheet[] = [];
  workbook.eachSheet((sheet) => {
    const rows: GridRow[] = [];
    sheet.eachRow({ includeEmpty: false }, (row, rowNumber) => {
      const cells: GridCell[] = [];
      row.eachCell({ includeEmpty: false }, (cell, colNumber) => {
        // A merged cell other than its first repeats the first's value: written once, where the sheet writes it.
        if (cell.isMerged && cell.master.address !== cell.address) return;
        const text = cellText(cell, false).replace(/\s+/g, ' ').trim();
        if (text) cells.push({ col: columnLetter(colNumber), text });
      });
      if (cells.length) rows.push({ row: rowNumber, cells });
    });
    sheets.push({ name: sheet.name, rows });
  });
  return sheets;
}

/** **A CSV as a one-sheet grid**, its delimiter guessed as the Data upload guesses it. */
export function csvGrid(bytes: Uint8Array, name: string): GridSheet[] {
  const { text } = decodeText(bytes);
  const records = parseCsv(text, delimiterOf(text));
  return [{
    name,
    rows: records.map((r) => ({
      row: r.line,
      cells: r.cells.map((t, i) => ({ col: columnLetter(i + 1), text: t.replace(/\s+/g, ' ').trim() })).filter((c) => c.text),
    })).filter((r) => r.cells.length),
  }];
}

/**
 * **A grid as the text Claude reads**: each sheet named, each row its number, each cell its column — `12 | A=45 | B=L |
 * C=1,234` — so a value it reports comes back with the sheet and the cell it stands in. `null` past the bounds.
 */
export function gridText(sheets: readonly GridSheet[]): string | null {
  let cells = 0;
  const lines: string[] = [];
  for (const sheet of sheets) {
    lines.push(`### Sheet "${sheet.name}"`);
    for (const row of sheet.rows) {
      cells += row.cells.length;
      lines.push(`${row.row} | ${row.cells.map((c) => `${c.col}=${c.text}`).join(' | ')}`);
    }
  }
  const text = lines.join('\n');
  return cells > INTAKE.CELLS_MAX || text.length > INTAKE.TEXT_MAX_CHARS ? null : text;
}

// ------------------------------------------------------------------------------------------------ Word

const ENTITIES: Readonly<Record<string, string>> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };

/** **A Word file's text**: its paragraphs, a table's cells joined with `|`, its tabs; no XML. `null` when unreadable. */
export function docxText(bytes: Uint8Array): string | null {
  let xml: string;
  try {
    const parts = unzipSync(bytes, { filter: (f) => f.name === 'word/document.xml' && f.originalSize <= INTAKE.ZIP_UNPACKED_MAX_BYTES });
    const doc = parts['word/document.xml'];
    if (!doc) return null;
    xml = strFromU8(doc);
  } catch {
    return null;
  }
  const text = xml
    .replace(/<w:tab\/>/g, '\t')
    .replace(/<w:br\/>/g, '\n')
    .replace(/<\/w:tc>/g, ' | ')
    .replace(/<\/w:(p|tr)>/g, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&(#x?[0-9a-f]+|[a-z]+);/gi, (whole, code: string) => {
      if (code.startsWith('#x') || code.startsWith('#X')) return String.fromCodePoint(parseInt(code.slice(2), 16));
      if (code.startsWith('#')) return String.fromCodePoint(parseInt(code.slice(1), 10));
      return ENTITIES[code.toLowerCase()] ?? whole;
    })
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  return text.length > INTAKE.TEXT_MAX_CHARS ? null : text;
}

// ------------------------------------------------------------------------------------------------ what Claude reads

/** A picture, turned upright and scaled down to `INTAKE.IMAGE_LONG_EDGE_PX` on its long side, never up. */
async function pictureForReading(bytes: Buffer, mimeType: string): Promise<{ data: Buffer; mediaType: 'image/jpeg' | 'image/png' }> {
  const image = sharp(bytes, { failOn: 'error' }).rotate().resize({
    width: INTAKE.IMAGE_LONG_EDGE_PX, height: INTAKE.IMAGE_LONG_EDGE_PX, fit: 'inside', withoutEnlargement: true,
  });
  if (mimeType === 'image/png') return { data: await image.png().toBuffer(), mediaType: 'image/png' };
  return { data: await image.jpeg({ quality: 88 }).toBuffer(), mediaType: 'image/jpeg' };
}

/** What a file is read as, and the grid a table's rows are later taken from exactly (a workbook's and a CSV's). */
export interface Readable {
  part: ReadablePart;
  grid: GridSheet[] | null;
}

/** Why a file could not be made readable: too long to send, or not readable as what its bytes say. */
export class Unreadable extends Error {
  constructor(readonly reason: 'too_long' | 'unreadable') {
    super(reason);
  }
}

/** **The file as Claude is sent it** — throws `Unreadable` rather than send a part of it. */
export async function readableOf(file: PreparedFile): Promise<Readable> {
  switch (file.kind) {
    case 'pdf':
      return { part: { kind: 'pdf', name: file.name, base64: file.bytes.toString('base64') }, grid: null };
    case 'image': {
      try {
        const picture = await pictureForReading(file.bytes, file.mimeType);
        return { part: { kind: 'image', name: file.name, base64: picture.data.toString('base64'), mediaType: picture.mediaType }, grid: null };
      } catch {
        throw new Unreadable('unreadable');
      }
    }
    case 'docx': {
      const text = docxText(file.bytes);
      if (text === null) throw new Unreadable(file.bytes.length > 0 ? 'too_long' : 'unreadable');
      return { part: { kind: 'text', name: file.name, text, format: 'document' }, grid: null };
    }
    case 'xlsx':
    case 'csv': {
      let grid: GridSheet[];
      try {
        grid = file.kind === 'xlsx' ? await workbookGrid(file.bytes) : csvGrid(file.bytes, file.name);
      } catch {
        throw new Unreadable('unreadable');
      }
      const text = gridText(grid);
      if (text === null) throw new Unreadable('too_long');
      return { part: { kind: 'text', name: file.name, text, format: 'grid' }, grid };
    }
  }
}

/** A grid's cell by sheet, row and column — how a table's rows are read exactly once a person confirmed the mapping. */
export function cellAt(grid: readonly GridSheet[], sheet: string | null, row: number, col: string): string | null {
  const s = sheet === null ? grid[0] : grid.find((g) => g.name === sheet);
  return s?.rows.find((r) => r.row === row)?.cells.find((c) => c.col === col)?.text ?? null;
}
