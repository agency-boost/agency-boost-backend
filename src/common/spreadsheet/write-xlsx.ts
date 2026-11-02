import { Workbook, type DataValidation, type Worksheet } from 'exceljs';
import type { Reader } from '@/common/i18n/reader';
import { render } from '@/common/i18n/sentence';
import { SPREADSHEET } from '@/domain/constants';
import { SPREADSHEET_WORDS } from './spreadsheet.messages';

/** One column of the Data sheet, as the guide describes it. */
export interface GuideColumn {
  /** Its name, exactly as the Data sheet's header writes it: the import's contract, the same in both languages. */
  name: string;
  required: boolean;
  /** What to enter, in the reader's language. */
  holds: string;
  /** A value that would be accepted, as it is typed. */
  example: string;
}

export interface TemplateWorkbook {
  /** Who the guide is written for: its sheet's name and every heading are in their language. */
  reader: Reader;
  guide: {
    title: string;
    /** How to fill the file in, a step a line. */
    steps: readonly string[];
    columns: readonly GuideColumn[];
    rules: readonly string[];
    /** Worked example rows, under the Data sheet's header — shown in the guide, never in the data. */
    examples?: readonly (readonly string[])[];
  };
  data: {
    header: readonly string[];
    /** Rows written under the header — the Data upload's agents. The roster's template has none. */
    rows?: readonly (readonly string[])[];
    /** Each column's width, in characters. */
    widths?: readonly number[];
    /** 0-based columns formatted as text (`@`), so a code keeps its leading zeros and a typed `2021-07` stays text. */
    textColumns?: readonly number[];
    /** Dropdowns: a column and the values it offers. A list longer than a spreadsheet allows is left off. */
    lists?: readonly { column: number; values: readonly string[] }[];
    /** How many rows under the header the dropdowns reach. */
    fillRows: number;
  };
}

/** The longest a dropdown's list may be written inline, separators included: the format's own limit. */
const LIST_FORMULA_MAX = 255;

/**
 * **A template as a workbook of two sheets** (ADR-0184): the guide, in the reader's language and named in it
 * (*Petunjuk*, *Guide*), and **Data**, which holds the header and nothing but the rows to fill in.
 *
 * The guide is the file's instructions, which the CSV template used to carry as `#` lines above the header: a title,
 * how to fill it in, a table of the Data sheet's columns (*Kolom · Wajib? · Isi · Contoh*), the rules, and worked
 * examples. Apart from the data, so nothing in it can be imported, and nothing the person types lands among it.
 *
 * The Data sheet: the header bold and frozen, so it stays in view; each column as wide as `widths` says; code and date
 * columns formatted as text; dropdowns where a column has fixed values; each header cell carrying what its column holds
 * as a note, which a spreadsheet shows on hovering it. Answered as the bytes of an `.xlsx`.
 */
export async function writeWorkbook(spec: TemplateWorkbook): Promise<Buffer> {
  const say = (message: Parameters<typeof render>[0]) => render(message, spec.reader);
  const workbook = new Workbook();
  workbook.creator = 'AgencyBoost';

  writeGuide(workbook.addWorksheet(say(SPREADSHEET_WORDS.guideSheet)), spec, say);
  writeData(workbook.addWorksheet(SPREADSHEET.DATA_SHEET, { views: [{ state: 'frozen', ySplit: 1 }] }), spec, say);
  // The guide is the first sheet and the one that opens: it is where somebody who has never seen the file starts.
  workbook.views = [{ x: 0, y: 0, width: 20_000, height: 12_000, firstSheet: 0, activeTab: 0, visibility: 'visible' }];

  return Buffer.from(await workbook.xlsx.writeBuffer());
}

type Say = (message: Parameters<typeof render>[0]) => string;

/**
 * The guide, top to bottom. A step and a rule are one unwrapped line each, which a spreadsheet lets run on across the
 * empty cells beside it; only the column table wraps, in its own wide column, where a row grows to fit.
 */
function writeGuide(sheet: Worksheet, spec: TemplateWorkbook, say: Say): void {
  const { guide } = spec;
  sheet.columns = [{ width: 26 }, { width: 10 }, { width: 72 }, { width: 22 }];
  const heading = (words: string) => { sheet.addRow([words]).font = { bold: true }; };

  sheet.addRow([guide.title]).font = { bold: true, size: 14 };
  sheet.addRow([]);

  heading(say(SPREADSHEET_WORDS.stepsHeading));
  guide.steps.forEach((step, i) => sheet.addRow([`${i + 1}. ${step}`]));
  sheet.addRow([]);

  heading(say(SPREADSHEET_WORDS.columnsHeading({ sheet: SPREADSHEET.DATA_SHEET })));
  sheet.addRow([
    say(SPREADSHEET_WORDS.column), say(SPREADSHEET_WORDS.required), say(SPREADSHEET_WORDS.holds), say(SPREADSHEET_WORDS.example),
  ]).font = { bold: true };
  for (const column of guide.columns) {
    const row = sheet.addRow([
      column.name, say(column.required ? SPREADSHEET_WORDS.yes : SPREADSHEET_WORDS.no), column.holds, column.example,
    ]);
    row.alignment = { vertical: 'top', wrapText: true };
    // An example is shown as typed: `00088213` as text, not as the number `88213`.
    row.getCell(4).numFmt = '@';
  }
  sheet.addRow([]);

  heading(say(SPREADSHEET_WORDS.rulesHeading));
  for (const rule of guide.rules) sheet.addRow([`• ${rule}`]);

  if (guide.examples?.length) {
    sheet.addRow([]);
    heading(say(SPREADSHEET_WORDS.examplesHeading));
    sheet.addRow([...spec.data.header]).font = { bold: true };
    for (const example of guide.examples) sheet.addRow([...example]).eachCell((cell) => { cell.numFmt = '@'; });
  }
}

function writeData(sheet: Worksheet, spec: TemplateWorkbook, say: Say): void {
  const { data, guide } = spec;
  const text = new Set(data.textColumns ?? []);
  sheet.columns = data.header.map((name, i) => ({
    width: data.widths?.[i] ?? Math.max(12, name.length + 2),
    style: text.has(i) ? { numFmt: '@' } : {},
  }));

  const header = sheet.getRow(1);
  data.header.forEach((name, i) => {
    const cell = header.getCell(i + 1);
    cell.value = name;
    cell.font = { bold: true };
    cell.numFmt = '@';
    const described = guide.columns.find((c) => c.name === name);
    if (described) cell.note = described.holds;
  });

  for (const cells of data.rows ?? []) sheet.addRow([...cells]);

  for (const list of data.lists ?? []) {
    const formula = `"${list.values.join(',')}"`;
    if (list.values.length === 0 || formula.length > LIST_FORMULA_MAX) continue;
    const letter = sheet.getColumn(list.column + 1).letter;
    const validation: DataValidation = {
      type: 'list',
      allowBlank: true,
      formulae: [formula],
      showErrorMessage: true,
      errorStyle: 'stop',
      errorTitle: say(SPREADSHEET_WORDS.listErrorTitle),
      error: say(SPREADSHEET_WORDS.listError),
    };
    // One rule over the column's range, as a spreadsheet writes it; `exceljs` declares the collection but not its type.
    (sheet as unknown as { dataValidations: { add(range: string, rule: DataValidation): void } })
      .dataValidations.add(`${letter}2:${letter}${data.fillRows + 1}`, validation);
  }
}
