import type { Reader } from '@/common/i18n/reader';
import { render } from '@/common/i18n/sentence';
import { readXlsx } from '@/common/spreadsheet/read-xlsx';
import { decodeText } from '@/common/spreadsheet/text';
import { writeWorkbook } from '@/common/spreadsheet/write-xlsx';
import { looksLikeZip } from '@/common/spreadsheet/zip-guard';
import {
  fieldOfHeader, ROSTER_COLUMNS, ROSTER_EXAMPLES, ROSTER_FIELDS, ROSTER_HEADER_NAMES, ROSTER_REQUIRED_FIELDS,
  type RosterField,
} from './roster-csv';
import { ROSTER_TEMPLATE_WORDS } from './roster-template.messages';

/** Where a column sits in the template, by its field — so nothing below counts positions. */
const at = (field: RosterField) => ROSTER_FIELDS.indexOf(field);

/**
 * How many rows under the header the Excel template's dropdowns reach: the 500-member office `performance-and-scale.md`
 * plans for. A row past it can still be typed and imported; it offers no list.
 */
export const ROSTER_FILL_ROWS = 500;

/** The fixed choices the file takes, as the template offers them (`roster-csv.ts` reads more spellings than these). */
const WORK_STATUSES = ['Full-time', 'Part-time'] as const;
const GENDERS = ['male', 'female'] as const;

/** Does this sheet row start a member file: it names the three columns a row cannot be read without (A3)? */
function isRosterHeader(cells: readonly string[]): boolean {
  const named = new Set(cells.map(fieldOfHeader));
  return ROSTER_REQUIRED_FIELDS.every((field) => named.has(field));
}

/**
 * **An uploaded member file, as the text `parseRoster` reads** (ADR-0184) — so a workbook and a CSV meet one parser and
 * one set of results, as a paste does.
 *
 * - **A workbook** (bytes that start as a ZIP) is opened by `readXlsx`, within the bounds a workbook is held to; its Data
 *   sheet — or the sheet that starts with a member header, A3's or today's — becomes one CSV line per sheet row,
 *   **numbered as the sheet numbers it**. A date cell is written `YYYY-MM-DD`, which the parser reads as a day, or in
 *   the company join month column as its month.
 * - **Anything else is a CSV**, decoded as the Data upload's is: UTF-8, Windows-1252 when it is not valid UTF-8, a
 *   byte-order mark dropped, a NUL byte refused.
 */
export async function rosterTextOf(bytes: Uint8Array): Promise<string> {
  if (!looksLikeZip(bytes)) return decodeText(bytes).text;
  const { rows } = await readXlsx(bytes, {
    isHeader: isRosterHeader,
    // The template's own month column; a workbook with its columns elsewhere is read by the parser's `isoMonth`.
    monthColumns: [at('companyJoinMonth')],
  });
  return rows.map(csvLineOf).join('\n');
}

/**
 * One sheet row as one line `parseRoster` splits back into the same cells.
 *
 * `parseRoster` reads a line at a time, so **a line break inside a cell becomes a space**, and so does a tab, which
 * would otherwise make the whole file read as tab-separated. A cell holding a comma or a quote is quoted with its quotes
 * doubled; so is one starting with `#`, which would otherwise make a person's line a comment.
 */
export function csvLineOf(cells: readonly string[]): string {
  return cells
    .map((cell) => cell.replace(/\s*[\r\n\t]+\s*/g, ' '))
    .map((cell) => (/[,"]/.test(cell) || cell.trimStart().startsWith('#') ? `"${cell.replace(/"/g, '""')}"` : cell))
    .join(',');
}

/**
 * **The member template as a workbook** (ADR-0184; P19.3-T4 AC-7): the guide on its own sheet (*Petunjuk*, *Guide*) in
 * the reader's language — the steps, each column, the rules, the three worked examples — and a **Data** sheet holding
 * A3's header and nothing else.
 *
 * Its Data sheet's code, phone and date columns are text, so `00088213` keeps its zeros and a typed `15/01/2026` stays
 * a day; *Waktu* and *Jenis kelamin* are dropdowns of the file's own words; **_Peran_ is a dropdown of the company
 * ladder's rungs when the office is known** (`rungs`), and free text otherwise, where the guide names the default ladder.
 */
export function rosterWorkbook(reader: Reader, rungs: readonly string[] | null): Promise<Buffer> {
  const say = (message: Parameters<typeof render>[0]) => render(message, reader);
  const W = ROSTER_TEMPLATE_WORDS;
  const [, , example] = ROSTER_EXAMPLES; // Rina, who has an upline and no number: an example for every column.
  const holds: Record<RosterField, string> = {
    agentCode: say(W.agentCode),
    fullName: say(W.fullName),
    role: rungs?.length ? say(W.roleFromLadder({ rungs: rungs.join(', ') })) : say(W.role),
    leaderAgentCode: say(W.leaderAgentCode),
    phone: say(W.phone),
    email: say(W.email),
    joinDate: say(W.joinDate),
    workStatus: say(W.workStatus),
    dateOfBirth: say(W.dateOfBirth),
    gender: say(W.gender),
    companyJoinMonth: say(W.companyJoinMonth),
  };

  return writeWorkbook({
    reader,
    guide: {
      title: say(W.title),
      steps: [say(W.stepFill), say(W.stepColumns), say(W.stepUpload)],
      columns: ROSTER_FIELDS.map((field, i) => ({
        name: ROSTER_HEADER_NAMES[field], required: ROSTER_REQUIRED_FIELDS.includes(field), holds: holds[field], example: example[i],
      })),
      rules: [say(W.ruleOnePerRow), say(W.ruleUplines), say(W.ruleExisting), say(W.ruleDates), say(W.ruleUnchanged), say(W.ruleSkipped)],
      examples: ROSTER_EXAMPLES,
    },
    data: {
      header: ROSTER_COLUMNS,
      widths: [14, 24, 12, 14, 18, 28, 18, 12, 14, 14, 26],
      textColumns: [at('agentCode'), at('leaderAgentCode'), at('phone'), at('joinDate'), at('dateOfBirth'), at('companyJoinMonth')],
      lists: [
        ...(rungs?.length ? [{ column: at('role'), values: rungs }] : []),
        { column: at('workStatus'), values: WORK_STATUSES },
        { column: at('gender'), values: GENDERS },
      ],
      fillRows: ROSTER_FILL_ROWS,
    },
  });
}
