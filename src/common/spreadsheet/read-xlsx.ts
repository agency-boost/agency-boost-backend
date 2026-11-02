import { HttpStatus } from '@nestjs/common';
import { Workbook, type Cell, type CellValue, type Worksheet } from 'exceljs';
import { DomainException } from '@/common/errors/domain.exception';
import { ErrorCode } from '@/common/errors/error-codes';
import { SPREADSHEET } from '@/domain/constants';
import { SPREADSHEET_REFUSALS } from './spreadsheet.messages';
import { notAWorkbook, tooLarge, unpackWithinLimits } from './zip-guard';

const SAY = SPREADSHEET_REFUSALS;

export interface ReadXlsxOptions {
  /**
   * Whether a row's cells are the header its import expects: how the sheet to read is found in a workbook with no sheet
   * called `Data` — a template somebody renamed the tab of, or copied the rows into a workbook of their own.
   */
  isHeader: (cells: readonly string[]) => boolean;
  /** 0-based columns that hold a month: a date there is written `YYYY-MM`, where any other is `YYYY-MM-DD`. */
  monthColumns?: readonly number[];
}

export interface SheetRows {
  /** The sheet the rows were read from, by its name in the workbook. */
  sheet: string;
  /**
   * Every row from the sheet's first to its last with a value, **`rows[i]` being the sheet's row `i + 1`** — so the
   * line an import reports is the row number the spreadsheet shows. A row with nothing in it is `[]`; each row is as
   * wide as its last value, its cells written as text (`cellText`).
   */
  rows: string[][];
}

/**
 * **A workbook's data sheet, as rows of text** (ADR-0184): what both imports read an `.xlsx` into, so each feeds the
 * rows to the same checks a CSV meets — the roster's `parseRoster`, the Data upload's header match and preview.
 *
 * The bytes go through `unpackWithinLimits` first: nothing is unpacked before the archive's directory has been checked,
 * and `exceljs` reads only parts inflated within it. Then the sheet: the one called `Data` (`SPREADSHEET.DATA_SHEET`,
 * any case); else the first whose first row is the import's header; else, in a workbook of one sheet, that one — so a
 * workbook somebody made themselves is answered about its columns, by the import's own header check, rather than about
 * a tab's name. A sheet past `SPREADSHEET.MAX_ROWS` rows, or with a value past `SPREADSHEET.MAX_COLUMNS`, is refused.
 */
export async function readXlsx(bytes: Uint8Array, options: ReadXlsxOptions): Promise<SheetRows> {
  const unpacked = unpackWithinLimits(bytes);
  const workbook = new Workbook();
  try {
    // `exceljs` types its parameter as a `Buffer` of its own declaring (an `ArrayBuffer`); it reads a Node buffer.
    await workbook.xlsx.load(Buffer.from(unpacked) as unknown as Parameters<Workbook['xlsx']['load']>[0]);
  } catch {
    throw notAWorkbook();
  }

  const sheet = dataSheetOf(workbook, options.isHeader);
  if (!sheet) {
    throw new DomainException(
      ErrorCode.UPLOAD_MALFORMED_CSV,
      SAY.UPLOAD_MALFORMED_CSV.noDataSheet({ sheet: SPREADSHEET.DATA_SHEET }),
      HttpStatus.UNPROCESSABLE_ENTITY,
      { sheet: SPREADSHEET.DATA_SHEET },
    );
  }
  return { sheet: sheet.name, rows: rowsOf(sheet, new Set(options.monthColumns ?? [])) };
}

function dataSheetOf(workbook: Workbook, isHeader: ReadXlsxOptions['isHeader']): Worksheet | null {
  const sheets = workbook.worksheets;
  const named = sheets.find((s) => s.name.trim().toLowerCase() === SPREADSHEET.DATA_SHEET.toLowerCase());
  if (named) return named;
  const headed = sheets.find((s) => {
    const first = firstRowOf(s);
    return first !== null && isHeader(first);
  });
  if (headed) return headed;
  return sheets.length === 1 ? sheets[0] : null;
}

/** A sheet's first row with a value, as text — `null` for a sheet with none. */
function firstRowOf(sheet: Worksheet): string[] | null {
  let first: string[] | null = null;
  sheet.eachRow((row) => {
    if (first !== null) return;
    const cells: string[] = [];
    row.eachCell((cell, col) => {
      if (col <= SPREADSHEET.MAX_COLUMNS) cells[col - 1] = cellText(cell, false);
    });
    first = Array.from(cells, (c) => c ?? '');
  });
  return first;
}

function rowsOf(sheet: Worksheet, monthColumns: ReadonlySet<number>): string[][] {
  const rows: string[][] = [];
  // `eachRow` visits only rows holding a value, in order; the rows between are blank and kept as `[]`.
  sheet.eachRow((row, rowNumber) => {
    if (rowNumber > SPREADSHEET.MAX_ROWS) {
      throw tooLarge(SAY.ASSET_TOO_LARGE.tooManyRows({ max: SPREADSHEET.MAX_ROWS }), { maxRows: SPREADSHEET.MAX_ROWS });
    }
    const cells: string[] = [];
    row.eachCell((cell, col) => {
      if (col > SPREADSHEET.MAX_COLUMNS) {
        throw tooLarge(
          SAY.ASSET_TOO_LARGE.tooManyColumns({ max: SPREADSHEET.MAX_COLUMNS }), { maxColumns: SPREADSHEET.MAX_COLUMNS },
        );
      }
      cells[col - 1] = cellText(cell, monthColumns.has(col - 1));
    });
    while (rows.length < rowNumber - 1) rows.push([]);
    rows.push(Array.from(cells, (c) => c ?? ''));
  });
  return rows;
}

/**
 * **A cell as the text a CSV of the same sheet would hold** — what a person sees in it, not how the workbook stores it:
 *
 * - a **date** is `YYYY-MM-DD`, or `YYYY-MM` in a month column: `2021-07` typed into a cell that is not text becomes the
 *   1st of July, and the month is what was meant;
 * - a **number** is written without a binary tail (`0.30000000000000004` is `0.3`) or an exponent, and with the point as
 *   its decimal mark, whatever the spreadsheet's language showed; one formatted as a **percentage** is written as the
 *   percentage it shows — `0.85` shown as *85%* is `85%`;
 * - **rich text** is its runs joined; a **formula** is its result; a **link** is its text — an address typed in Excel
 *   becomes a `mailto:` link, and the address is what was typed; an **error** is its code, `#N/A`, which no column
 *   accepts and so is answered as wrong rather than read as empty; **TRUE** and **FALSE** are those words.
 *
 * A code's leading zeros survive only where the cell was text, which is why each template formats its code columns
 * as text (`writeWorkbook`'s `textColumns`). A code that lost them is the Data upload's to recover (ADR-0052).
 */
export function cellText(cell: Pick<Cell, 'value' | 'numFmt'>, month: boolean): string {
  return written(cell.value, cell.numFmt, month);
}

function written(value: CellValue, numFmt: string | undefined, month: boolean): string {
  if (value === null || value === undefined) return '';
  if (value instanceof Date) {
    // A workbook's dates are days counted from 1900 (or 1904), which `exceljs` hands over as UTC midnight.
    if (Number.isNaN(value.getTime())) return '';
    return value.toISOString().slice(0, month ? 7 : 10);
  }
  if (typeof value === 'number') return numFmt?.includes('%') ? `${plainNumber(value * 100)}%` : plainNumber(value);
  if (typeof value === 'string') return value;
  if (typeof value === 'boolean') return value ? 'TRUE' : 'FALSE';
  if ('richText' in value) return value.richText.map((run) => run.text).join('');
  if ('formula' in value || 'sharedFormula' in value) return written(value.result ?? null, numFmt, month);
  if ('hyperlink' in value) return written(value.text as CellValue, numFmt, month);
  if ('error' in value) return value.error;
  return '';
}

/**
 * A number as a person would type it: at most fifteen significant digits, which is what a spreadsheet keeps, so a
 * formula's `0.1 + 0.2` reads `0.3`; and never in exponent form, which JavaScript uses below `1e-6` and from `1e21`.
 */
export function plainNumber(n: number): string {
  if (!Number.isFinite(n)) return String(n);
  const tidy = Number(n.toPrecision(15));
  const text = String(tidy);
  if (!/e/i.test(text)) return text;
  return Math.abs(tidy) < 1
    ? tidy.toFixed(20).replace(/0+$/, '').replace(/\.$/, '')
    : BigInt(Math.round(tidy)).toString();
}
