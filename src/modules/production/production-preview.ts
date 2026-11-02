import { HttpStatus } from '@nestjs/common';
import { DomainException } from '@/common/errors/domain.exception';
import { ErrorCode } from '@/common/errors/error-codes';
import type { Reader } from '@/common/i18n/reader';
import { render, type Sentence } from '@/common/i18n/sentence';
import { readXlsx } from '@/common/spreadsheet/read-xlsx';
import { looksLikeZip } from '@/common/spreadsheet/zip-guard';
import { PRODUCTION_METRICS, type ProductionMetric } from './monthly-agent-data.schema';
import {
  type CsvRecord, decodeUpload, delimiterOf, parseCsv, type UploadDelimiter, type UploadEncoding,
} from './production-csv';
import { breaksYtd, isMoney, refusalFor } from './production-rules';
import { METRIC_FILE_LABEL, TEMPLATE_HEADERS } from './production-template';
import { minorToRpMillions, rpMillionsToMinor } from './production-units';
import { PRODUCTION_REFUSALS } from './production.messages';

const SAY = PRODUCTION_REFUSALS;

/**
 * What a filled file would change, before anything does (P9-T3).
 *
 * **Form is forgiven; meaning is refused, naming the cell** (ADR-0052). A blank is *not provided* and
 * leaves the stored figure alone (ADR-0051). Nothing here reads or writes the database: the service
 * hands in the roster and what is stored, and gets back a diff.
 */

export type Cadence = 'monthly' | 'ytd';
export const CADENCES: readonly Cadence[] = ['monthly', 'ytd'];

export type CellStatus = 'new' | 'changed' | 'unchanged' | 'not_provided' | 'refused';

export interface PreviewIssue {
  code: string;
  /** Written for the reader of the preview — and kept with the batch, in its language, by the commit (P18.98-T5 AC-6). */
  message: string;
  metric: ProductionMetric | null;
  cadence: Cadence | null;
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
  metric: ProductionMetric;
  cadence: Cadence;
  status: CellStatus;
  /** What is stored now. Money in minor units, persistency in percent, counts as counts. */
  before: number | null;
  /** What the file would write, in the same units. `null` unless the status is `new` or `changed`/`unchanged`. */
  after: number | null;
  /** The cell as the file has it, for a refusal the reader has to find in their spreadsheet. */
  raw: string | null;
  /** Set when the stored figure was corrected by hand and the file would change it (ADR-0053). */
  correction: PreviewCorrection | null;
}

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
  status: 'ready' | 'refused';
  issues: PreviewIssue[];
  /** Twelve, in the template's order — empty when the row itself is refused. */
  cells: PreviewCell[];
}

export interface PreviewSummary {
  /** Data rows in the file. */
  rows: number;
  ready: number;
  refused: number;
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

export interface RosterMember {
  membershipId: string;
  agentCode: string;
  name: string;
}

/** What is stored for one member this month, per metric and cadence. */
export type StoredFigures = Record<ProductionMetric, Record<Cadence, number | null>>;

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
  templateVersion: number;
  /** Every record after the header, blank ones included; `buildPreview` skips those. */
  records: CsvRecord[];
}

/** The twelve value columns, in the template's order: six monthly, then the same six YTD. */
export const VALUE_COLUMNS: readonly { metric: ProductionMetric; cadence: Cadence }[] = [
  ...PRODUCTION_METRICS.map((metric) => ({ metric, cadence: 'monthly' as const })),
  ...PRODUCTION_METRICS.map((metric) => ({ metric, cadence: 'ytd' as const })),
];

const COLUMN_COUNT = 2 + VALUE_COLUMNS.length;

/** The header's own words for a value column — what the reader will look for in their spreadsheet. */
export const columnLabel = (metric: ProductionMetric, cadence: Cadence) =>
  `${METRIC_FILE_LABEL[metric]} — ${cadence === 'monthly' ? 'This Month' : 'YTD'}`;

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

/**
 * Which version of the template this header is, or `UPLOAD_TEMPLATE_MISMATCH` naming the first
 * column that differs. Trailing empty cells are ignored; anything else — renamed, missing, extra,
 * reordered — is a different file, and nothing is previewed.
 */
export function templateVersionOf(cells: readonly string[]): number {
  const found = trimTrailingEmpty(cells).map(headerKey);
  for (const [version, header] of Object.entries(TEMPLATE_HEADERS)) {
    const expected = header.map(headerKey);
    if (expected.length === found.length && expected.every((h, i) => h === found[i])) return Number(version);
  }

  const latest = TEMPLATE_HEADERS[Math.max(...Object.keys(TEMPLATE_HEADERS).map(Number))];
  const shown = trimTrailingEmpty(cells).map((c) => c.trim());
  const at = latest.findIndex((h, i) => headerKey(h) !== (found[i] ?? null));
  const column = at === -1 ? latest.length + 1 : at + 1;
  const expected = at === -1 ? null : latest[at];
  const actual = shown[column - 1] ?? null;

  let message: Sentence<'UPLOAD_TEMPLATE_MISMATCH'>;
  if (expected === null) {
    message = SAY.UPLOAD_TEMPLATE_MISMATCH.extraColumn({ actual, column });
  } else if (actual === null) {
    message = SAY.UPLOAD_TEMPLATE_MISMATCH.headerStops({ shown: shown.length, column, expected });
  } else {
    message = SAY.UPLOAD_TEMPLATE_MISMATCH.columnDiffers({ column, actual, expected });
  }
  throw new DomainException(
    ErrorCode.UPLOAD_TEMPLATE_MISMATCH,
    message,
    HttpStatus.UNPROCESSABLE_ENTITY,
    { column, expected, found: actual },
  );
}

function trimTrailingEmpty(cells: readonly string[]): string[] {
  let end = cells.length;
  while (end > 0 && cells[end - 1].trim() === '') end -= 1;
  return cells.slice(0, end);
}

const isBlank = (r: CsvRecord) => r.cells.every((c) => c.trim() === '');

/** Bytes of a CSV → a known template, its records, and how the file was written. File-level refusals throw. */
export function readUpload(bytes: Uint8Array): ReadUpload {
  const { text, encoding } = decodeUpload(bytes);
  const delimiter = delimiterOf(text.replace(/^[\r\n]+/, ''));
  return { format: 'csv', encoding, delimiter, ...templateOf(parseCsv(text, delimiter)) };
}

/**
 * **Any filled template, a CSV or an Excel workbook** (ADR-0184): what the service reads an upload with.
 *
 * A workbook — bytes that start as a ZIP — is opened by `readXlsx`, within the bounds a workbook is held to, and its
 * Data sheet's rows become the records a CSV's lines would have been, each numbered as the sheet numbers its row. From
 * there it is the same file: **the header matched exactly as a CSV's**, `UPLOAD_TEMPLATE_MISMATCH` naming the first
 * column that differs, and the same preview. Anything else is read as a CSV.
 */
export async function readFileUpload(bytes: Uint8Array): Promise<ReadUpload> {
  if (!looksLikeZip(bytes)) return readUpload(bytes);
  const { rows } = await readXlsx(bytes, { isHeader: isTemplateHeader });
  return {
    format: 'xlsx',
    encoding: 'utf-8',
    delimiter: ',',
    ...templateOf(rows.map((cells, i): CsvRecord => ({ line: i + 1, cells }))),
  };
}

/** Whether a row is a header this product issued — how a workbook's data sheet is found when it is not called Data. */
function isTemplateHeader(cells: readonly string[]): boolean {
  try {
    templateVersionOf(cells);
    return true;
  } catch {
    return false;
  }
}

/** The first row with anything in it is the header; the rest are the records. A file of nothing is refused. */
function templateOf(records: CsvRecord[]): Pick<ReadUpload, 'templateVersion' | 'records'> {
  const headerAt = records.findIndex((r) => !isBlank(r));
  if (headerAt === -1) {
    throw new DomainException(
      ErrorCode.UPLOAD_MALFORMED_CSV, SAY.UPLOAD_MALFORMED_CSV.empty, HttpStatus.UNPROCESSABLE_ENTITY,
    );
  }
  return { templateVersion: templateVersionOf(records[headerAt].cells), records: records.slice(headerAt + 1) };
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
 * A value column's cell, read and range-checked, in the unit it is stored in.
 *
 * Money arrives in millions of rupiah and leaves in sen (invariant §9, AC-7) — converted **before**
 * the range is checked, so the check is `production-rules.ts`'s, the one a correction meets too.
 */
export function readCell(metric: ProductionMetric, raw: string, decimalMark: ',' | '.'): Read {
  const read = readNumber(raw, decimalMark, metric === 'persistency');
  if ('reason' in read) return read;
  const stored = isMoney(metric) ? rpMillionsToMinor(read.value) : read.value;
  const reason = refusalFor(metric, stored);
  return reason ? { reason } : { value: stored };
}

/** A stored value as the file would write it, for a message comparing the two. */
const asWritten = (metric: ProductionMetric, stored: number) =>
  String(isMoney(metric) ? minorToRpMillions(stored) : stored);

// ── one agent code ─────────────────────────────────────────────────────────────────────────────

const stripZeros = (digits: string) => digits.replace(/^0+(?=\d)/, '');

const SCIENTIFIC = /^\d+([.,]\d+)?E[+-]?\d+$/i;
const MONTHS = '(jan|feb|mar|apr|may|mei|jun|jul|aug|agu|agt|sep|oct|okt|nov|dec|des)[a-z]*';
const DATE_LIKE = [
  /^\d{1,4}[-/.]\d{1,2}([-/.]\d{1,4})?$/,
  new RegExp(`^\\d{1,2}[- ]${MONTHS}([- ]\\d{2,4})?$`, 'i'),
  new RegExp(`^${MONTHS}[- ]\\d{1,4}$`, 'i'),
];

interface CodeMatch {
  member: RosterMember | null;
  recovered: boolean;
  reason: Sentence<'UPLOAD_UNKNOWN_AGENT_CODE'> | null;
}

/**
 * Exact first, ignoring letter case. On a miss, an **all-digit** code is matched with leading zeros
 * dropped on both sides — only when exactly one active member answers to it (ADR-0052). Otherwise
 * the row is refused, and when the code looks like something a spreadsheet makes of a code, the
 * message says so.
 */
export function matchCode(code: string, roster: readonly RosterMember[]): CodeMatch {
  if (code === '') return { member: null, recovered: false, reason: SAY.UPLOAD_UNKNOWN_AGENT_CODE.noCode };

  const upper = code.toUpperCase();
  const exact = roster.find((m) => m.agentCode.toUpperCase() === upper);
  if (exact) return { member: exact, recovered: false, reason: null };

  if (/^\d+$/.test(code)) {
    const key = stripZeros(code);
    const fits = roster.filter((m) => /^\d+$/.test(m.agentCode) && stripZeros(m.agentCode) === key);
    if (fits.length === 1) return { member: fits[0], recovered: true, reason: null };
    if (fits.length > 1) {
      return { member: null, recovered: false, reason: SAY.UPLOAD_UNKNOWN_AGENT_CODE.ambiguous };
    }
  }

  if (SCIENTIFIC.test(code)) return { member: null, recovered: false, reason: SAY.UPLOAD_UNKNOWN_AGENT_CODE.scientific };
  if (DATE_LIKE.some((p) => p.test(code))) {
    return { member: null, recovered: false, reason: SAY.UPLOAD_UNKNOWN_AGENT_CODE.dateLike };
  }
  return { member: null, recovered: false, reason: SAY.UPLOAD_UNKNOWN_AGENT_CODE.unknown };
}

const nameKey = (name: string) => name.replace(/^'/, '').replace(/\s+/g, ' ').trim().toLowerCase();

// ── the whole preview ─────────────────────────────────────────────────────────────────────────

/**
 * Every data row of the file against the roster and what is stored.
 *
 * A row is **refused** when it cannot be attributed to exactly one member — no code, an unknown
 * one, an agent listed twice, or more cells than the template. A **ready** row previews each of its
 * twelve cells: new, changed, unchanged, not provided, or refused with the reason.
 *
 * **Each issue is written for `reader`** (P18.98-T5): the preview is answered to them, and a commit keeps its issues
 * with the batch — the words of whoever imported it, as they read them. Its code is the same in both languages.
 */
export function buildPreview(
  input: {
    records: readonly CsvRecord[];
    delimiter: UploadDelimiter;
    roster: readonly RosterMember[];
    stored: (membershipId: string) => StoredFigures;
  },
  reader: Reader,
): { rows: PreviewRow[]; summary: PreviewSummary } {
  const issue = (
    code: string, message: Sentence, metric: ProductionMetric | null = null, cadence: Cadence | null = null,
  ): PreviewIssue => ({ code, message: render(message, reader), metric, cadence });
  const decimalMark = input.delimiter === ';' ? ',' : '.';
  const data = input.records.filter((r) => !isBlank(r));

  // Pass 1: who each row is, so an agent listed twice can refuse both of its rows.
  const matched = data.map((record) => {
    const cells = record.cells;
    const code = (cells[0] ?? '').trim();
    const extra = trimTrailingEmpty(cells).length;
    const match = matchCode(code, input.roster);
    return { record, code, extra, match };
  });
  const seen = new Map<string, number[]>();
  matched.forEach(({ match, record }) => {
    if (match.member) seen.set(match.member.membershipId, [...(seen.get(match.member.membershipId) ?? []), record.line]);
  });

  const rows = matched.map(({ record, code, extra, match }): PreviewRow => {
    const fileName = (record.cells[1] ?? '').trim();
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

    if (extra > COLUMN_COUNT) {
      return refuse(issue(
        ErrorCode.UPLOAD_MALFORMED_CSV, SAY.UPLOAD_MALFORMED_CSV.tooManyCells({ cells: extra, template: COLUMN_COUNT }),
      ));
    }
    if (!member) return refuse(issue(ErrorCode.UPLOAD_UNKNOWN_AGENT_CODE, match.reason!));
    const lines = seen.get(member.membershipId)!;
    if (lines.length > 1) {
      const others = lines.filter((l) => l !== record.line).join(', ');
      return refuse(issue(
        ErrorCode.UPLOAD_DUPLICATE_AGENT_CODE,
        SAY.UPLOAD_DUPLICATE_AGENT_CODE.alsoOnLine({ who: member.name || member.agentCode, lines: others }),
      ));
    }

    const stored = input.stored(member.membershipId);
    const issues: PreviewIssue[] = [];
    const cells = VALUE_COLUMNS.map(({ metric, cadence }, i): PreviewCell => {
      const raw = (record.cells[2 + i] ?? '').trim();
      const before = stored[metric][cadence];
      if (raw === '') return { metric, cadence, status: 'not_provided', before, after: null, raw: null, correction: null };
      const read = readCell(metric, raw, decimalMark);
      if ('reason' in read) {
        issues.push(issue(
          ErrorCode.UPLOAD_VALUE_OUT_OF_RANGE,
          SAY.UPLOAD_VALUE_OUT_OF_RANGE.cell({ column: columnLabel(metric, cadence), raw, reason: read.reason }),
          metric, cadence,
        ));
        return { metric, cadence, status: 'refused', before, after: null, raw, correction: null };
      }
      const status: CellStatus = before === null ? 'new' : before === read.value ? 'unchanged' : 'changed';
      return { metric, cadence, status, before, after: read.value, raw, correction: null };
    });

    // YTD is a sum of months, so it cannot be less than this month — after the file is applied.
    for (const metric of PRODUCTION_METRICS) {
      const month = cells.find((c) => c.metric === metric && c.cadence === 'monthly')!;
      const ytd = cells.find((c) => c.metric === metric && c.cadence === 'ytd')!;
      const fromFile = (c: PreviewCell) => c.status !== 'not_provided' && c.status !== 'refused';
      const m = fromFile(month) ? month.after : month.status === 'not_provided' ? month.before : null;
      const y = fromFile(ytd) ? ytd.after : ytd.status === 'not_provided' ? ytd.before : null;
      if (m === null || y === null || !breaksYtd(metric, m, y)) continue;

      if (fromFile(ytd)) {
        issues.push(issue(
          ErrorCode.UPLOAD_VALUE_OUT_OF_RANGE,
          SAY.UPLOAD_VALUE_OUT_OF_RANGE.ytdBelowMonth({
            column: columnLabel(metric, 'ytd'), raw: ytd.raw!,
            month: fromFile(month) ? `“${month.raw}”` : asWritten(metric, m),
          }),
          metric, 'ytd',
        ));
        ytd.status = 'refused';
        ytd.after = null;
        if (fromFile(month)) {
          month.status = 'refused';
          month.after = null;
          issues.push(issue(
            ErrorCode.UPLOAD_VALUE_OUT_OF_RANGE,
            SAY.UPLOAD_VALUE_OUT_OF_RANGE.heldBack({ column: columnLabel(metric, 'monthly'), raw: month.raw! }),
            metric, 'monthly',
          ));
        }
      } else {
        issues.push(issue(
          ErrorCode.UPLOAD_VALUE_OUT_OF_RANGE,
          SAY.UPLOAD_VALUE_OUT_OF_RANGE.monthAboveYtd({
            column: columnLabel(metric, 'monthly'), raw: month.raw!, ytd: asWritten(metric, y),
          }),
          metric, 'monthly',
        ));
        month.status = 'refused';
        month.after = null;
      }
    }

    return { ...base, status: 'ready', issues, cells };
  });

  const count = (s: CellStatus) => rows.reduce((n, r) => n + r.cells.filter((c) => c.status === s).length, 0);
  return {
    rows,
    summary: {
      rows: rows.length,
      ready: rows.filter((r) => r.status === 'ready').length,
      refused: rows.filter((r) => r.status === 'refused').length,
      newCells: count('new'),
      changedCells: count('changed'),
      unchangedCells: count('unchanged'),
      notProvidedCells: count('not_provided'),
      refusedCells: count('refused'),
      // What is stored is only numbers here; the service knows which were corrected and fills this in.
      correctionCells: 0,
      notInFile: input.roster.filter((m) => !seen.has(m.membershipId)).length,
    },
  };
}
