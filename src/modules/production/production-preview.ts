import { HttpStatus } from '@nestjs/common';
import { DomainException } from '@/common/errors/domain.exception';
import { ErrorCode } from '@/common/errors/error-codes';
import type { Reader } from '@/common/i18n/reader';
import { render, type Sentence } from '@/common/i18n/sentence';
import { readXlsx } from '@/common/spreadsheet/read-xlsx';
import { looksLikeZip } from '@/common/spreadsheet/zip-guard';
import type { AdvancedAnalyticsConfig, UploadField } from '@/modules/config/analytics-config';
import type { LinearPattern } from '@/modules/config/linear-pattern';
import {
  type CsvRecord, decodeUpload, delimiterOf, parseCsv, type UploadDelimiter, type UploadEncoding,
} from './production-csv';
import { headerOf, labelIn } from './production-template';
import { PRODUCTION_UPLOAD_NOTES } from './production-template.messages';
import { cellKey, inForce, refusalForField, toFile, toStored } from './upload-columns';
import { PRODUCTION_REFUSALS } from './production.messages';

const SAY = PRODUCTION_REFUSALS;

/**
 * What a filled file would change, before anything does (P9-T3) — **read against the KPM's template** since P19.5-T2
 * (ADR-0214 §5).
 *
 * **Form is forgiven; meaning is refused, naming the cell** (ADR-0052). A blank is *not provided* and
 * leaves the stored figure alone (ADR-0051). Nothing here reads or writes the database: the service
 * hands in the configuration, the roster and what is stored, and gets back a diff.
 */

export type CellStatus = 'new' | 'changed' | 'unchanged' | 'not_provided' | 'refused';

export interface PreviewIssue {
  code: string;
  /** Written for the reader of the preview — and kept with the batch, in its language, by the commit (P18.10-T5 AC-6). */
  message: string;
  /** The cell's kode, or `null` for the row. */
  kode: string | null;
  /** The cell's uploaded year to date (`[KODE_YTD]`), or its month; `null` for the row. */
  ytd: boolean | null;
}

/**
 * A figure somebody corrected by hand that the file would change (ADR-0053). Listed apart in the
 * preview, with a choice: it is only replaced if whoever imports ticks it.
 */
export interface PreviewCorrection {
  /** Who corrected it, by name. */
  by: string | null;
  at: string | null;
  reason: string | null;
  /** The figure the correction replaced. When the file carries it again, the file is probably the old one. */
  replacedValue: number | null;
}

export interface PreviewCell {
  kode: string;
  /** `true` for a `ytd: 'upload'` column's uploaded year to date. */
  ytd: boolean;
  status: CellStatus;
  /** What is stored now. Money in minor units, a percentage in percent, counts as counts. */
  before: number | null;
  /** What the file would write, in the same units. `null` unless the status is `new` or `changed`/`unchanged`. */
  after: number | null;
  /** The cell as the file has it, for a refusal the reader has to find in their spreadsheet. */
  raw: string | null;
  /** Set when the stored figure was corrected by hand and the file would change it (ADR-0053). */
  correction: PreviewCorrection | null;
}

/** A row's state: imported, refused with its reason, or held apart as *Belum terdaftar* (ADR-0214 §8). */
export type PreviewRowStatus = 'ready' | 'refused' | 'held';

export interface PreviewRow {
  /** The line of the file, as a spreadsheet numbers it — the header is line 1. */
  line: number;
  /** As the file has it. */
  agentCode: string;
  membershipId: string | null;
  /** The member's own code — differs from `agentCode` when it was recovered, or only by case. */
  resolvedAgentCode: string | null;
  /** The roster's name. The file's is never used to match (AC-6). */
  name: string | null;
  fileName: string;
  nameDiffers: boolean;
  /** An all-digit code a spreadsheet stripped of its leading zeros, matched to the one member it fits. */
  codeRecovered: boolean;
  status: PreviewRowStatus;
  issues: PreviewIssue[];
  /** One per column the file is read for (`FileLayout.columns`), in the template's order; empty when the row is refused. */
  cells: PreviewCell[];
}

export interface PreviewSummary {
  /** Data rows in the file. */
  rows: number;
  ready: number;
  refused: number;
  /** Rows of a code no member holds, kept apart as *Belum terdaftar* under `unknownAgent: 'flag'` (ADR-0214 §8). */
  held: number;
  newCells: number;
  changedCells: number;
  unchangedCells: number;
  notProvidedCells: number;
  refusedCells: number;
  /** Figures corrected by hand that the file would change — each replaced only if ticked (ADR-0053). */
  correctionCells: number;
  /** Active members the file does not list. They keep what they have (ADR-0051). */
  notInFile: number;
}

/** A column the file is read for: one of the template's current columns in force, its month or its uploaded YTD. */
export interface PreviewColumn {
  kode: string;
  ytd: boolean;
  /** The file's own header for it. */
  header: string;
  /** The column's name in the reader's language. */
  label: string;
  unit: UploadField['unit'];
}

/** What the preview says about the file's columns (AA UI-013; ADR-0214 §5). Not a refusal: the file still imports. */
export type PreviewNoteCode = 'column_missing' | 'column_retired' | 'column_unknown' | 'column_not_in_force';

export interface PreviewNote {
  code: PreviewNoteCode;
  kode: string | null;
  /** The file's header it is about; `null` for a column the file lacks. */
  header: string | null;
  message: string;
}

export interface RosterMember {
  membershipId: string;
  agentCode: string;
  name: string;
  /**
   * A member of a leader class — `ab` or `aab`, by their rung's tier (ADR-0156) — on the upload: the rows a `rows:
   * 'leaders'` column may be filled on (P19.3-T1, ADR-0201 §2). Absent or `false` is an agent's row.
   */
  leader?: boolean;
}

/** What is stored for one member — or one held code — this month, by kode, and last month's uploaded years to date. */
export interface StoredFigures {
  values: Record<string, number | null>;
  ytdValues: Record<string, number | null>;
  /** Last month's held `ytdValues`, which a `ytd: 'upload'` column's check reads (ADR-0214 §5 step 7). */
  previousYtd: Record<string, number | null>;
}

const NOTHING_STORED: StoredFigures = { values: {}, ytdValues: {}, previousYtd: {} };

/** What the file was (ADR-0184): text read as CSV, or an Excel workbook whose Data sheet was read. */
export type UploadFormat = 'csv' | 'xlsx';

export interface ReadUpload {
  format: UploadFormat;
  /** How a CSV's bytes were read. A workbook's text is UTF-8 by its own format, and reads `utf-8`. */
  encoding: UploadEncoding;
  /**
   * A CSV's delimiter. **A workbook has none, and reads `,`**: what the delimiter decides is the decimal mark
   * (`buildPreview`), and a workbook's numbers reach the preview written with the point (`cellText`).
   */
  delimiter: UploadDelimiter;
  /** The header row's cells, as the file has them. */
  header: string[];
  /** Every record after the header, blank ones included; `buildPreview` skips those. */
  records: CsvRecord[];
}

// ── the header ─────────────────────────────────────────────────────────────────────────────────

/**
 * What a UTF-8 em dash and en dash become when a spreadsheet reads the bytes as Windows-1252 and
 * saves the result: `â€”` and `â€“`. The template's byte-order mark prevents it; a file that lost the
 * mark on the way does not.
 */
const MOJIBAKE_DASHES = /â€[“”]/g;
const DASHES = /[‐-―−-]/g;

/** One header cell as ADR-0052 compares it: trimmed, spaces collapsed, dashes folded, case ignored. */
export function headerKey(cell: string): string {
  return cell
    .replace(/^﻿/, '')
    .replace(MOJIBAKE_DASHES, '-')
    .replace(DASHES, '-')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

/** A trailing `[KODE]` or `[KODE_YTD]` (ADR-0214 §5 step 1), any case. */
const KODE_IN_HEADER = /\[\s*([A-Za-z][A-Za-z0-9_]{0,43})\s*\]\s*$/;
/** A trailing unit in brackets, set aside before a label is compared: *(Rp juta)*, *(Rp M)*, *(%)*. */
const TRAILING_UNIT = /\s*\(\s*(rp\s*juta|rp\s*m|rp|idr|%|persen|percent)\s*\)\s*$/i;
/** A trailing cadence the issued headers wrote: *— This Month*, *— YTD*, or a bare *YTD*. */
const THIS_MONTH = /\s*-\s*this month$/;
const YTD_TAIL = /\s*(-\s*)?ytd$/;

const AGENT_CODE_HEADERS = new Set(['agent code', 'kode agen', 'kode']);
const AGENT_NAME_HEADERS = new Set(['agent name', 'nama agen', 'nama', 'name']);

/** A header's words as a label is compared: normalised, its cadence and its unit set aside. */
function labelKey(text: string): { key: string; ytd: boolean } {
  let key = headerKey(text).replace(KODE_IN_HEADER, '').trim();
  let ytd = false;
  if (THIS_MONTH.test(key)) key = key.replace(THIS_MONTH, '');
  else if (YTD_TAIL.test(key) && key.replace(YTD_TAIL, '').trim() !== '') {
    key = key.replace(YTD_TAIL, '');
    ytd = true;
  }
  return { key: key.replace(TRAILING_UNIT, '').trim(), ytd };
}

/** A column the file holds that is read: which kode and cadence, where, and under which header. */
export interface LayoutColumn {
  field: UploadField;
  ytd: boolean;
  index: number;
  header: string;
}

/** How a file's header reads against the KPM's template (ADR-0214 §5). */
export interface FileLayout {
  codeIndex: number;
  nameIndex: number | null;
  /** The columns read, in the template's order. */
  columns: LayoutColumn[];
  notes: PreviewNote[];
}

/**
 * **A file's header, read column by column against the KPM's template** (P19.5-T2 AC-2, AC-3; AT-3, AT-4; ADR-0214 §5,
 * amending ADR-0052). Each header cell, after ADR-0052's normalising and with a trailing unit set aside, is matched:
 *
 * 1. by a `[KODE]` or `[KODE_YTD]` in it;
 * 2. else by the column's current ID label, then its EN label, then its `labelAliases` — which hold its earlier labels
 *    (AA UI-024) and the headers this product issued before (versions 1 and 2), each to its kode — case-insensitive.
 *
 * Archived columns are matched too, so a file using one is noted rather than misread. Then:
 *
 * - **a current column in force for the month** is read; its YTD only when its year to date is uploaded;
 * - **a current column the file lacks** is *not provided* for every row — *"Kolom <nama> kosong di file ini. Baris tetap
 *   diimpor."* — and no row is skipped for it, a required one included;
 * - **an archived or unknown `[KODE]`, or an issued YTD of a column whose year to date is calculated**, is ignored and
 *   noted *"Kolom <nama> tidak dipakai lagi"*; a header matching nothing, *"Kolom <header> tidak dikenali"*;
 * - **a column whose `effectiveFrom` is after the month** is not read for it (R2), and noted.
 *
 * `UPLOAD_TEMPLATE_MISMATCH` (422) only for a file with no `Agent Code` column, no column read, or two headers on one
 * kode — named in `details`, never guessed between.
 */
export function layoutOf(
  header: readonly string[], config: AdvancedAnalyticsConfig, month: string, reader: Reader,
): FileLayout {
  const say = (message: Sentence<null>) => render(message, reader);
  const current = new Map(config.uploadFields.map((f) => [f.kode, f]));
  const archived = new Map(config.archivedFields.map((f) => [f.kode, f]));
  const name = (field: UploadField) => labelIn(field, reader.language);

  // Every label a column answers to, at the priority it is matched with: the ID label, the EN label, the aliases.
  const byLabel = new Map<string, { field: UploadField; ytd: boolean; rank: number }>();
  const offer = (text: string, field: UploadField, rank: number) => {
    const { key, ytd } = labelKey(text);
    if (!key) return;
    const id = `${key}${ytd ? '\u0000ytd' : ''}`;
    const had = byLabel.get(id);
    if (!had || rank < had.rank) byLabel.set(id, { field, ytd, rank });
  };
  for (const [list, base] of [[config.uploadFields, 0], [config.archivedFields, 10]] as const) {
    for (const field of list) {
      offer(field.label.id, field, base + 1);
      if (field.label.en) offer(field.label.en, field, base + 2);
      for (const alias of field.labelAliases ?? []) offer(alias, field, base + 3);
    }
  }

  let codeIndex = -1;
  let nameIndex: number | null = null;
  const read = new Map<string, LayoutColumn>();
  const notes: PreviewNote[] = [];
  const retired = (kode: string | null, text: string, label: string) => notes.push({
    code: 'column_retired', kode, header: text, message: say(PRODUCTION_UPLOAD_NOTES.columnRetired({ name: label })),
  });

  header.forEach((raw, index) => {
    const text = raw.replace(/^﻿/, '').trim();
    const key = headerKey(text);
    if (key === '') return;
    if (AGENT_CODE_HEADERS.has(key)) {
      if (codeIndex === -1) codeIndex = index;
      return;
    }
    if (AGENT_NAME_HEADERS.has(key)) {
      if (nameIndex === null) nameIndex = index;
      return;
    }

    let field: UploadField | null = null;
    let ytd = false;
    const bracket = KODE_IN_HEADER.exec(text);
    if (bracket) {
      const code = bracket[1].toUpperCase();
      ytd = code.endsWith('_YTD');
      const kode = ytd ? code.slice(0, -4) : code;
      field = current.get(kode) ?? null;
      if (!field) {
        const gone = archived.get(kode);
        retired(kode, text, gone ? name(gone) : text);
        return;
      }
    } else {
      const { key: label, ytd: wantsYtd } = labelKey(text);
      const hit = byLabel.get(`${label}${wantsYtd ? '\u0000ytd' : ''}`);
      if (!hit) {
        notes.push({ code: 'column_unknown', kode: null, header: text, message: say(PRODUCTION_UPLOAD_NOTES.columnUnknown({ header: text })) });
        return;
      }
      if (!current.has(hit.field.kode)) {
        retired(hit.field.kode, text, name(hit.field));
        return;
      }
      field = current.get(hit.field.kode)!;
      ytd = hit.ytd;
    }

    // An issued year to date of a column whose year to date is calculated: the file's figure is not stored (R4).
    if (ytd && field.ytd !== 'upload') {
      retired(field.kode, text, `${name(field)} YTD`);
      return;
    }
    const key2 = cellKey(field.kode, ytd);
    const had = read.get(key2);
    if (had) {
      throw new DomainException(
        ErrorCode.UPLOAD_TEMPLATE_MISMATCH,
        SAY.UPLOAD_TEMPLATE_MISMATCH.twoHeadersOneColumn({ first: had.header, second: text, kode: key2 }),
        HttpStatus.UNPROCESSABLE_ENTITY,
        { kode: key2, headers: [had.header, text], columns: [had.index + 1, index + 1] },
      );
    }
    read.set(key2, { field, ytd, index, header: text });
  });

  if (codeIndex === -1) {
    throw new DomainException(
      ErrorCode.UPLOAD_TEMPLATE_MISMATCH, SAY.UPLOAD_TEMPLATE_MISMATCH.noAgentCode, HttpStatus.UNPROCESSABLE_ENTITY,
      { column: 'Agent Code' },
    );
  }

  // In the template's order; a column not yet in force this month is not read for it (R2).
  const columns: LayoutColumn[] = [];
  const order = [
    ...config.uploadFields.map((f) => ({ f, ytd: false })),
    ...config.uploadFields.filter((f) => f.ytd === 'upload').map((f) => ({ f, ytd: true })),
  ];
  for (const { f, ytd } of order) {
    const col = read.get(cellKey(f.kode, ytd));
    if (!col) {
      if (inForce(f, month)) {
        const label = ytd ? `${name(f)} YTD` : name(f);
        notes.push({
          code: 'column_missing', kode: f.kode, header: null,
          message: say(PRODUCTION_UPLOAD_NOTES.columnMissing({ name: label })),
        });
      }
      continue;
    }
    if (!inForce(f, month)) {
      notes.push({
        code: 'column_not_in_force', kode: f.kode, header: col.header,
        message: say(PRODUCTION_UPLOAD_NOTES.columnNotInForce({ name: name(f), from: f.effectiveFrom })),
      });
      continue;
    }
    columns.push(col);
  }
  if (read.size === 0) {
    throw new DomainException(
      ErrorCode.UPLOAD_TEMPLATE_MISMATCH, SAY.UPLOAD_TEMPLATE_MISMATCH.noColumnMatched, HttpStatus.UNPROCESSABLE_ENTITY,
      { found: header.filter((h) => h.trim() !== '').length },
    );
  }
  return { codeIndex, nameIndex, columns, notes };
}

/** A column as the preview names it to its reader. */
export function previewColumnOf(col: LayoutColumn, language: Reader['language']): PreviewColumn {
  return { kode: col.field.kode, ytd: col.ytd, header: col.header, label: labelIn(col.field, language), unit: col.field.unit };
}

function trimTrailingEmpty(cells: readonly string[]): string[] {
  let end = cells.length;
  while (end > 0 && cells[end - 1].trim() === '') end -= 1;
  return cells.slice(0, end);
}

const isBlank = (r: CsvRecord) => r.cells.every((c) => c.trim() === '');

/** Whether a row looks like an import's header: it has an *Agent Code* column. How a workbook's data sheet is found. */
function isUploadHeader(cells: readonly string[]): boolean {
  return cells.some((c) => AGENT_CODE_HEADERS.has(headerKey(c)));
}

/** Bytes of a CSV → its header, its records, and how the file was written. File-level refusals throw. */
export function readUpload(bytes: Uint8Array): ReadUpload {
  const { text, encoding } = decodeUpload(bytes);
  const delimiter = delimiterOf(text.replace(/^[\r\n]+/, ''));
  return { format: 'csv', encoding, delimiter, ...headerAndRecords(parseCsv(text, delimiter)) };
}

/**
 * **Any filled template, a CSV or an Excel workbook** (ADR-0184): what the service reads an upload with.
 *
 * A workbook — bytes that start as a ZIP — is opened by `readXlsx`, within the bounds a workbook is held to, and its
 * Data sheet's rows become the records a CSV's lines would have been, each numbered as the sheet numbers its row. From
 * there it is the same file, its header read by `layoutOf`. Anything else is read as a CSV.
 */
export async function readFileUpload(bytes: Uint8Array): Promise<ReadUpload> {
  if (!looksLikeZip(bytes)) return readUpload(bytes);
  const { rows } = await readXlsx(bytes, { isHeader: isUploadHeader });
  return {
    format: 'xlsx',
    encoding: 'utf-8',
    delimiter: ',',
    ...headerAndRecords(rows.map((cells, i): CsvRecord => ({ line: i + 1, cells }))),
  };
}

/** The first row with anything in it is the header; the rest are the records. A file of nothing is refused. */
function headerAndRecords(records: CsvRecord[]): Pick<ReadUpload, 'header' | 'records'> {
  const headerAt = records.findIndex((r) => !isBlank(r));
  if (headerAt === -1) {
    throw new DomainException(
      ErrorCode.UPLOAD_MALFORMED_CSV, SAY.UPLOAD_MALFORMED_CSV.empty, HttpStatus.UNPROCESSABLE_ENTITY,
    );
  }
  return { header: records[headerAt].cells, records: records.slice(headerAt + 1) };
}

// ── one value ─────────────────────────────────────────────────────────────────────────────────

/** A value read, or why it is refused: the end of a sentence, in both languages, said after the cell. */
type Read = { value: number } | { reason: Sentence<'UPLOAD_VALUE_OUT_OF_RANGE'> };

/**
 * A number, where **the decimal mark follows the delimiter**: `,` in a `;` file, `.` otherwise
 * (ADR-0052). A number carrying the other mark, both, a space or any grouping is refused — `1.500`
 * in a `;` file is one and a half thousand to one reader and one and a half to another.
 */
export function readNumber(raw: string, decimalMark: ',' | '.', allowPercent: boolean): Read {
  let s = raw.trim();
  if (allowPercent && s.endsWith('%')) s = s.slice(0, -1).trimEnd();
  const other = decimalMark === ',' ? '.' : ',';
  if (s.includes(decimalMark) && s.includes(other)) {
    return { reason: SAY.UPLOAD_VALUE_OUT_OF_RANGE.bothMarks };
  }
  if (s.includes(other)) {
    return { reason: SAY.UPLOAD_VALUE_OUT_OF_RANGE.otherMark({ other, mark: decimalMark }) };
  }
  const pattern = decimalMark === ',' ? /^([+-]?)(\d+)(?:,(\d+))?$/ : /^([+-]?)(\d+)(?:\.(\d+))?$/;
  const m = pattern.exec(s);
  if (!m) return { reason: SAY.UPLOAD_VALUE_OUT_OF_RANGE.notANumber };
  return { value: Number(`${m[1]}${m[2]}${m[3] ? `.${m[3]}` : ''}`) };
}

/**
 * A column's cell, read and checked, in the unit it is stored in (ADR-0214 §5 step 5).
 *
 * Money arrives in millions of rupiah and leaves in sen (invariant §9, AC-7) — converted **before**
 * the check, so the check is `refusalForField`'s, the one a correction meets too.
 */
export function readCell(field: Pick<UploadField, 'unit' | 'min' | 'max'>, raw: string, decimalMark: ',' | '.'): Read {
  const read = readNumber(raw, decimalMark, field.unit === 'percent');
  if ('reason' in read) return read;
  const stored = toStored(field.unit, read.value);
  const reason = refusalForField(field, stored);
  return reason ? { reason } : { value: stored };
}

// ── one agent code ─────────────────────────────────────────────────────────────────────────────

const stripZeros = (digits: string) => digits.replace(/^0+(?=\d)/, '');

const SCIENTIFIC = /^\d+([.,]\d+)?E[+-]?\d+$/i;
const MONTHS = '(jan|feb|mar|apr|may|mei|jun|jul|aug|agu|agt|sep|oct|okt|nov|dec|des)[a-z]*';
const DATE_LIKE = [
  /^\d{1,4}[-/.]\d{1,2}([-/.]\d{1,4})?$/,
  new RegExp(`^\\d{1,2}[- ]${MONTHS}([- ]\\d{2,4})?$`, 'i'),
  new RegExp(`^${MONTHS}[- ]\\d{1,4}$`, 'i'),
];

/** Why no member answers to a code: none at all, several, or a code a spreadsheet seems to have rewritten. */
export type MissReason = 'no_code' | 'ambiguous' | 'scientific' | 'date_like' | 'unknown';

interface CodeMatch {
  member: RosterMember | null;
  recovered: boolean;
  reason: Sentence<'UPLOAD_UNKNOWN_AGENT_CODE'> | null;
  miss: MissReason | null;
}

/**
 * Exact first, ignoring letter case. On a miss, an **all-digit** code is matched with leading zeros
 * dropped on both sides — only when exactly one active member answers to it (ADR-0052). Otherwise
 * the row is refused, and when the code looks like something a spreadsheet makes of a code, the
 * message says so.
 */
export function matchCode(code: string, roster: readonly RosterMember[]): CodeMatch {
  const miss = (why: MissReason, reason: Sentence<'UPLOAD_UNKNOWN_AGENT_CODE'>): CodeMatch => (
    { member: null, recovered: false, reason, miss: why }
  );
  if (code === '') return miss('no_code', SAY.UPLOAD_UNKNOWN_AGENT_CODE.noCode);

  const upper = code.toUpperCase();
  const exact = roster.find((m) => m.agentCode.toUpperCase() === upper);
  if (exact) return { member: exact, recovered: false, reason: null, miss: null };

  if (/^\d+$/.test(code)) {
    const key = stripZeros(code);
    const fits = roster.filter((m) => /^\d+$/.test(m.agentCode) && stripZeros(m.agentCode) === key);
    if (fits.length === 1) return { member: fits[0], recovered: true, reason: null, miss: null };
    if (fits.length > 1) return miss('ambiguous', SAY.UPLOAD_UNKNOWN_AGENT_CODE.ambiguous);
  }

  if (SCIENTIFIC.test(code)) return miss('scientific', SAY.UPLOAD_UNKNOWN_AGENT_CODE.scientific);
  if (DATE_LIKE.some((p) => p.test(code))) return miss('date_like', SAY.UPLOAD_UNKNOWN_AGENT_CODE.dateLike);
  return miss('unknown', SAY.UPLOAD_UNKNOWN_AGENT_CODE.unknown);
}

/** A held code, as ADR-0052 normalises it: what `unregisteredAgentData` is keyed by. */
export const heldCodeOf = (code: string) => code.trim().toUpperCase();

const nameKey = (name: string) => name.replace(/^'/, '').replace(/\s+/g, ' ').trim().toLowerCase();

// ── the whole preview ─────────────────────────────────────────────────────────────────────────

/** The template's rules a row is checked by (ADR-0214 §5). */
export interface RowRules {
  /** The template's `agentCodePattern`, compiled; `null` checks no format. */
  pattern: LinearPattern | null;
  /** The template's `agentCodeExample`, which the refusal names. */
  example: string;
  unknownAgent: 'flag' | 'reject';
  ytdTolerancePct: number;
}

/**
 * Every data row of the file against the roster, the template and what is stored (ADR-0214 §5), **in this order**:
 *
 * 1. **the code** is matched to a member as ADR-0052 matches it;
 * 2. **a code no member holds that is not in the template's format** refuses the row (`UPLOAD_AGENT_CODE_PATTERN`,
 *    naming the template's example) — *as built*: a code that matches a member is the member's, and publishing
 *    proved every registered code is in the format (§7), so a recovered code stripped of its zeros is not refused;
 * 3. **an unregistered code** follows `unknownAgent`: `reject` refuses it (`UPLOAD_UNKNOWN_AGENT_CODE`), `flag` holds
 *    it apart as *Belum terdaftar* — a code a spreadsheet rewrote (scientific, date-like) or several members fit is
 *    refused either way;
 * 4. **a blank in a required column the file carries**, from its `effectiveFrom` on, skips the row:
 *    `UPLOAD_REQUIRED_BLANK`, *"<label> wajib diisi"* (R2) — a leaders' column only on a leader's row;
 * 5. **a value outside the column's limits** refuses that cell (`UPLOAD_VALUE_OUT_OF_RANGE`), and the row's other cells
 *    import;
 * 6. **a value in a leaders' column on an agent's row** is refused for that cell (`UPLOAD_LEADER_ONLY_VALUE`);
 * 7. **a `ytd: 'upload'` column's YTD** must be last month's held YTD plus this month's figure, within
 *    `ytdTolerancePct` % of the YTD — January's equals its month; with no earlier month held it is not checked.
 *    Otherwise that YTD cell is refused (`UPLOAD_YTD_MISMATCH`), and the month's figure still imports.
 *
 * Also refused as before: an agent listed twice (both rows), and a row with more cells than the header.
 *
 * **Each issue is written for `reader`** (P18.10-T5): the preview is answered to them, and a commit keeps its issues
 * with the batch. Its code is the same in both languages.
 */
export function buildPreview(
  input: {
    records: readonly CsvRecord[];
    delimiter: UploadDelimiter;
    header: readonly string[];
    layout: FileLayout;
    month: string;
    roster: readonly RosterMember[];
    stored: (membershipId: string) => StoredFigures;
    /** What a held code holds already this month; absent, nothing. */
    heldStored?: (agentCode: string) => StoredFigures;
    rules: RowRules;
  },
  reader: Reader,
): { rows: PreviewRow[]; summary: PreviewSummary } {
  const issue = (code: string, message: Sentence, kode: string | null = null, ytd: boolean | null = null): PreviewIssue => (
    { code, message: render(message, reader), kode, ytd }
  );
  const decimalMark = input.delimiter === ';' ? ',' : '.';
  const { layout, rules } = input;
  const columnCount = trimTrailingEmpty(input.header).length;
  const data = input.records.filter((r) => !isBlank(r));
  const label = (field: UploadField, ytd: boolean) => headerOf(field, ytd, reader.language);

  // Pass 1: who each row is, so an agent listed twice can refuse both of its rows.
  const matched = data.map((record) => {
    const code = (record.cells[layout.codeIndex] ?? '').trim();
    const extra = trimTrailingEmpty(record.cells).length;
    const match = matchCode(code, input.roster);
    return { record, code, extra, match };
  });
  const seen = new Map<string, number[]>();
  const key = (m: (typeof matched)[number]) => (m.match.member ? m.match.member.membershipId : m.code ? `held:${heldCodeOf(m.code)}` : null);
  matched.forEach((m) => {
    const k = key(m);
    if (k) seen.set(k, [...(seen.get(k) ?? []), m.record.line]);
  });

  const rows = matched.map((m): PreviewRow => {
    const { record, code, extra, match } = m;
    const fileName = (layout.nameIndex === null ? '' : record.cells[layout.nameIndex] ?? '').trim();
    const member = match.member;
    const base = {
      line: record.line,
      agentCode: code,
      membershipId: member?.membershipId ?? null,
      resolvedAgentCode: member?.agentCode ?? null,
      name: member?.name ?? null,
      fileName,
      nameDiffers: !!member && fileName !== '' && nameKey(fileName) !== nameKey(member.name),
      codeRecovered: match.recovered,
    };
    const refuse = (i: PreviewIssue): PreviewRow => ({ ...base, status: 'refused', issues: [i], cells: [] });

    if (extra > columnCount) {
      return refuse(issue(
        ErrorCode.UPLOAD_MALFORMED_CSV, SAY.UPLOAD_MALFORMED_CSV.tooManyCells({ cells: extra, template: columnCount }),
      ));
    }

    let held = false;
    if (!member) {
      const spreadsheetMade = match.miss === 'no_code' || match.miss === 'ambiguous' || match.miss === 'scientific' || match.miss === 'date_like';
      if (!spreadsheetMade && rules.pattern && !rules.pattern.test(code)) {
        return refuse(issue(ErrorCode.UPLOAD_AGENT_CODE_PATTERN, SAY.UPLOAD_AGENT_CODE_PATTERN.notTheFormat({ example: rules.example })));
      }
      if (spreadsheetMade || rules.unknownAgent === 'reject') return refuse(issue(ErrorCode.UPLOAD_UNKNOWN_AGENT_CODE, match.reason!));
      held = true;
    }

    const lines = seen.get(key(m) as string)!;
    if (lines.length > 1) {
      const others = lines.filter((l) => l !== record.line).join(', ');
      return refuse(issue(
        ErrorCode.UPLOAD_DUPLICATE_AGENT_CODE,
        SAY.UPLOAD_DUPLICATE_AGENT_CODE.alsoOnLine({ who: member ? member.name || member.agentCode : code, lines: others }),
      ));
    }

    const leaderRow = member?.leader === true;
    const stored = member ? input.stored(member.membershipId) : (input.heldStored?.(heldCodeOf(code)) ?? NOTHING_STORED);

    // Step 4: a required column the file carries, blank on a row it applies to.
    for (const col of layout.columns) {
      if (col.ytd || !col.field.required) continue;
      if (col.field.rows === 'leaders' && !leaderRow) continue;
      if ((record.cells[col.index] ?? '').trim() === '') {
        return refuse(issue(
          ErrorCode.UPLOAD_REQUIRED_BLANK, SAY.UPLOAD_REQUIRED_BLANK.required({ label: labelIn(col.field, reader.language) }),
          col.field.kode, false,
        ));
      }
    }

    const issues: PreviewIssue[] = [];
    const cells = layout.columns.map(({ field, ytd, index }): PreviewCell => {
      const raw = (record.cells[index] ?? '').trim();
      const before = (ytd ? stored.ytdValues : stored.values)[field.kode] ?? null;
      const cell = (status: CellStatus, after: number | null = null): PreviewCell => (
        { kode: field.kode, ytd, status, before, after, raw: status === 'not_provided' ? null : raw, correction: null }
      );
      if (raw === '') return cell('not_provided');
      // Step 6: a leaders' figure on an agent's row (ADR-0201 §2) — refused, whatever it says. A held code is nobody's
      // row yet, so it is not refused for it.
      if (field.rows === 'leaders' && !leaderRow && !held) {
        issues.push(issue(
          ErrorCode.UPLOAD_LEADER_ONLY_VALUE, SAY.UPLOAD_LEADER_ONLY_VALUE.agentRow({ column: label(field, ytd), raw }),
          field.kode, ytd,
        ));
        return cell('refused');
      }
      const read = readCell(field, raw, decimalMark);
      if ('reason' in read) {
        issues.push(issue(
          ErrorCode.UPLOAD_VALUE_OUT_OF_RANGE,
          SAY.UPLOAD_VALUE_OUT_OF_RANGE.cell({ column: label(field, ytd), raw, reason: read.reason }),
          field.kode, ytd,
        ));
        return cell('refused');
      }
      return cell(before === null ? 'new' : before === read.value ? 'unchanged' : 'changed', read.value);
    });

    // Step 7: an uploaded year to date adds up to last month's and this month's.
    for (const ytdCell of cells.filter((c) => c.ytd && (c.status === 'new' || c.status === 'changed' || c.status === 'unchanged'))) {
      const field = layout.columns.find((c) => c.field.kode === ytdCell.kode && c.ytd)!.field;
      const monthCell = cells.find((c) => c.kode === ytdCell.kode && !c.ytd);
      const thisMonth = monthCell && monthCell.after !== null ? monthCell.after : stored.values[field.kode] ?? null;
      const january = input.month.endsWith('-01');
      const previous = january ? 0 : stored.previousYtd[field.kode] ?? null;
      if (thisMonth === null || previous === null) continue;
      const expected = previous + thisMonth;
      const tolerance = Math.abs(ytdCell.after as number) * (rules.ytdTolerancePct / 100);
      if (Math.abs((ytdCell.after as number) - expected) <= tolerance) continue;
      issues.push(issue(
        ErrorCode.UPLOAD_YTD_MISMATCH,
        SAY.UPLOAD_YTD_MISMATCH.doesNotAddUp({ column: label(field, true), raw: ytdCell.raw ?? '', expected: String(toFile(field.unit, expected)) }),
        field.kode, true,
      ));
      ytdCell.status = 'refused';
      ytdCell.after = null;
    }

    return { ...base, status: held ? 'held' : 'ready', issues, cells };
  });

  const count = (s: CellStatus) => rows.reduce((n, r) => n + r.cells.filter((c) => c.status === s).length, 0);
  return {
    rows,
    summary: {
      rows: rows.length,
      ready: rows.filter((r) => r.status === 'ready').length,
      refused: rows.filter((r) => r.status === 'refused').length,
      held: rows.filter((r) => r.status === 'held').length,
      newCells: count('new'),
      changedCells: count('changed'),
      unchangedCells: count('unchanged'),
      notProvidedCells: count('not_provided'),
      refusedCells: count('refused'),
      // What is stored is only numbers here; the service knows which were corrected and fills this in.
      correctionCells: 0,
      notInFile: input.roster.filter((member) => !seen.has(member.membershipId)).length,
    },
  };
}
