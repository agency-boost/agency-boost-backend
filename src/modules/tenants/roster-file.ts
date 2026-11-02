import type { Reader } from '@/common/i18n/reader';
import { render } from '@/common/i18n/sentence';
import { readXlsx } from '@/common/spreadsheet/read-xlsx';
import { decodeText } from '@/common/spreadsheet/text';
import { writeWorkbook } from '@/common/spreadsheet/write-xlsx';
import { looksLikeZip } from '@/common/spreadsheet/zip-guard';
import { ROSTER_COLUMNS, ROSTER_EXAMPLES, ROSTER_TEMPLATE_HEADER } from './roster-csv';
import { ROSTER_TEMPLATE_WORDS } from './roster-template.messages';

/** Where a column sits in the file, by its name — so nothing below counts positions. */
const at = (column: (typeof ROSTER_COLUMNS)[number]) => ROSTER_COLUMNS.indexOf(column);

/**
 * How many rows under the header the Excel template's dropdowns reach: the 500-member office `performance-and-scale.md`
 * plans for. A row past it can still be typed and imported; it offers no list.
 */
export const ROSTER_FILL_ROWS = 500;

/** The two fixed choices the file takes, as it writes them (`roster-csv.ts`, *the file's words*). */
const WORK_STATUSES = ['full-time', 'part-time'] as const;
const GENDERS = ['male', 'female'] as const;

/**
 * **An uploaded roster file, as the text `parseRoster` reads** (ADR-0184) — so a workbook and a CSV meet one parser, one
 * set of issues and one all-or-nothing commit, as a paste does.
 *
 * - **A workbook** (bytes that start as a ZIP) is opened by `readXlsx`, within the bounds a workbook is held to; its
 *   Data sheet — or the sheet that starts with the roster's header — becomes one CSV line per sheet row, **numbered as
 *   the sheet numbers it**: a blank row is an empty line, which `parseRoster` skips and still counts. A date in the
 *   month column is written `YYYY-MM`.
 * - **Anything else is a CSV**, decoded as the Data upload's is: UTF-8, Windows-1252 when it is not valid UTF-8, a
 *   byte-order mark dropped, a NUL byte refused.
 */
export async function rosterTextOf(bytes: Uint8Array): Promise<string> {
  if (!looksLikeZip(bytes)) return decodeText(bytes).text;
  const { rows } = await readXlsx(bytes, {
    isHeader: (cells) => cells.join(',').toLowerCase() === ROSTER_TEMPLATE_HEADER.toLowerCase(),
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
 * **The roster template as a workbook** (ADR-0184): the guide on its own sheet (*Petunjuk*, *Guide*) in the reader's
 * language — the steps, each column, the rules, the three worked examples — and a **Data** sheet holding the header
 * and nothing else.
 *
 * Its Data sheet's code and date columns are text, so `00088213` keeps its zeros and a typed `2021-07` stays a month;
 * `workStatus` and `gender` are dropdowns of the file's own words; **`role` is a dropdown of the company ladder's rung
 * codes when the office is known** (`rungs`), and free text otherwise, where the guide names the default ladder.
 */
export function rosterWorkbook(reader: Reader, rungs: readonly string[] | null): Promise<Buffer> {
  const say = (message: Parameters<typeof render>[0]) => render(message, reader);
  const W = ROSTER_TEMPLATE_WORDS;
  const [, , example] = ROSTER_EXAMPLES; // Rina, who has a leader: an example for every column.
  const holds: Record<(typeof ROSTER_COLUMNS)[number], string> = {
    fullName: say(W.fullName),
    email: say(W.email),
    agentCode: say(W.agentCode),
    role: rungs?.length ? say(W.roleFromLadder({ rungs: rungs.join(', ') })) : say(W.role),
    leaderAgentCode: say(W.leaderAgentCode),
    dateOfBirth: say(W.dateOfBirth),
    companyJoinMonth: say(W.companyJoinMonth),
    workStatus: say(W.workStatus),
    gender: say(W.gender),
  };

  return writeWorkbook({
    reader,
    guide: {
      title: say(W.title),
      steps: [say(W.stepFill), say(W.stepColumns), say(W.stepUpload)],
      columns: ROSTER_COLUMNS.map((name, i) => ({
        name, required: name !== 'leaderAgentCode', holds: holds[name], example: example[i],
      })),
      rules: [say(W.ruleOnePerRow), say(W.ruleLeaders), say(W.ruleDates), say(W.ruleUnchanged), say(W.ruleAllOrNothing)],
      examples: ROSTER_EXAMPLES,
    },
    data: {
      header: ROSTER_COLUMNS,
      widths: [24, 28, 14, 12, 18, 14, 18, 14, 10],
      textColumns: [at('agentCode'), at('leaderAgentCode'), at('dateOfBirth'), at('companyJoinMonth')],
      lists: [
        ...(rungs?.length ? [{ column: at('role'), values: rungs }] : []),
        { column: at('workStatus'), values: WORK_STATUSES },
        { column: at('gender'), values: GENDERS },
      ],
      fillRows: ROSTER_FILL_ROWS,
    },
  });
}
