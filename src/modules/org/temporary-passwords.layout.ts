import type { Content, CustomTableLayout, TableCell, TDocumentDefinitions } from 'pdfmake/interfaces';
import { TEMPORARY_PASSWORD } from '@/domain/constants';
import { REPORT_COLOURS } from '@/modules/kpm-report/kpm-report.layout';
import { monthLong } from '@/modules/kpm-report/kpm-report.words';
import { PDF_FONTS } from '@/modules/proposals/proposal-pdf.layout';

/**
 * ***Akun & password*** **— the PDF's pages** (P19.30-T1 AC-2;
 * [ADR-0288](../../../../docs/04-adr/0288-a-kpm-may-hand-out-temporary-passwords-in-one-pdf-and-each-person-chooses-their-own-at-first-sign-in.md)
 * §2). Pure: a {@link TemporaryPasswordSheet} in, the file's `pdfmake` definition out — flowed, so the table runs onto as
 * many pages as it needs with **its header row repeated** (`headerRows`) and a row never split (`dontBreakRows`).
 *
 * - **The head**: *Akun & password*, the KPM's name and company and the day it was made, the confidential line, and
 *   where to sign in (OD-482).
 * - **One row per person**: *No · Nama* (CAPITALS) *· Peran · Kode agen · Email* (the username) *· Password*.
 * - **Every page's footer**: *"<KPM> · Akun & password · hal. x / n"*.
 * - **Nothing smaller than `TEMPORARY_PASSWORD.PDF_MIN_TEXT_PT`** (9 pt). A4 landscape, so an address of forty-odd
 *   characters stays on one line beside the name. The KPM report's colours and the app's Inter (`renderPdf`): no font
 *   added, no image, nothing fetched.
 * - **Indonesian only**, as the KPM report: the sheet is handed to the office's people, whatever language the reader's
 *   screen is in.
 */

/** Every word the sheet prints (Indonesian, ADR-0288 §2). */
export const SHEET_WORDS = {
  title: 'Akun & password',
  /** The line ADR-0288 §2 and P19.30-T1 AC-2 give, word for word. */
  confidential: 'Rahasia — bagikan ke masing-masing orang saja. Password wajib diganti saat pertama masuk.',
  signIn: (address: string) => `Masuk di ${address} dengan email dan password di bawah ini.`,
  columns: ['No', 'Nama', 'Peran', 'Kode agen', 'Email', 'Password'] as const,
  footer: (kpm: string, page: number, pages: number) => `${kpm} · Akun & password · hal. ${page} / ${pages}`,
  count: (n: number) => `${n} akun`,
} as const;

/** One person on the sheet. */
export interface SheetRow {
  fullName: string;
  /** The rung as the company's ladder writes it short — *AB*, *AAB*, *Agent* or a rung of its own. */
  role: string;
  agentCode: string;
  /** The username they sign in with. */
  email: string;
  /** Their temporary password, printed here and kept nowhere in readable form. */
  password: string;
}

export interface TemporaryPasswordSheet {
  kpm: { name: string; company: string };
  /** The KPM's day it was made, `YYYY-MM-DD` (invariant §9: the KPM's own calendar). */
  day: string;
  /** Where to sign in: the app's own address. */
  signInAt: string;
  rows: SheetRow[];
}

const C = REPORT_COLOURS;
const MIN = TEMPORARY_PASSWORD.PDF_MIN_TEXT_PT;
/**
 * Every size the sheet sets, in points — none below `MIN`. **A row is one size** (`ROW`), its password in bold and spaced
 * a little: a row's cells share one baseline, so the line reads straight across, on paper or to a screen reader.
 */
export const SHEET_TYPE = { SMALL: MIN, BODY: 10, ROW: 11, META: 11, TITLE: 18 } as const;
const T = SHEET_TYPE;
const MARGIN = 32;

/** The table look: a tinted header row, light rules between rows, no vertical lines — the KPM report's lists'. */
const TABLE_LAYOUT: CustomTableLayout = {
  hLineWidth: (i, node) => (i === 0 || i === (node.table.headerRows ?? 0) ? 0 : 0.6),
  vLineWidth: () => 0,
  hLineColor: () => C.line,
  fillColor: (row, node) => (row < (node.table.headerRows ?? 0) ? C.head : row % 2 === 0 ? C.paper : null),
  paddingLeft: () => 6,
  paddingRight: () => 6,
  paddingTop: () => 5,
  paddingBottom: () => 5,
};

const th = (text: string, alignment: 'left' | 'right' = 'left'): TableCell =>
  ({ text: text.toUpperCase(), bold: true, fontSize: T.SMALL, color: C.headInk, alignment, characterSpacing: 0.2 }) as TableCell;

/** A day in full, as the KPM report writes one: `2026-11-22` → *22 November 2026*. */
export function dayLong(day: string): string {
  return `${Number(day.slice(8, 10))} ${monthLong(day.slice(0, 7))}`;
}

/** A name as the KPM's documents print it: CAPITALS, the spaces tidied. */
export function sheetName(fullName: string): string {
  return fullName.replace(/\s+/g, ' ').trim().toLocaleUpperCase('id-ID');
}

/** The table: the header row, then one row per person in the order given. */
function table(rows: SheetRow[]): Content {
  return {
    table: {
      headerRows: 1,
      dontBreakRows: true,
      widths: [22, '*', 54, 74, '*', 96],
      body: [
        SHEET_WORDS.columns.map((column, i) => th(column, i === 0 ? 'right' : 'left')),
        ...rows.map((row, i): TableCell[] => [
          { text: String(i + 1), alignment: 'right', color: C.grey, fontSize: T.ROW },
          { text: sheetName(row.fullName), bold: true, color: C.navy, fontSize: T.ROW },
          { text: row.role, fontSize: T.ROW },
          { text: row.agentCode, fontSize: T.ROW },
          { text: row.email, fontSize: T.ROW },
          { text: row.password, bold: true, color: C.ink, fontSize: T.ROW, characterSpacing: 0.8 },
        ] as TableCell[]),
      ],
    },
    layout: TABLE_LAYOUT,
  } as Content;
}

/** The head of the first page. */
function head(sheet: TemporaryPasswordSheet): Content[] {
  return [
    { text: SHEET_WORDS.title, bold: true, fontSize: T.TITLE, color: C.navy },
    {
      text: [sheet.kpm.name, sheet.kpm.company, dayLong(sheet.day), SHEET_WORDS.count(sheet.rows.length)]
        .filter(Boolean).join(' · '),
      fontSize: T.META,
      color: C.grey,
      margin: [0, 2, 0, 8],
    },
    {
      table: { widths: ['*'], body: [[{ text: SHEET_WORDS.confidential, bold: true, color: C.navy, fontSize: T.BODY }]] },
      layout: {
        hLineWidth: () => 0, vLineWidth: (i: number) => (i === 0 ? 3 : 0), vLineColor: () => C.orange,
        fillColor: () => C.orangeTint, paddingLeft: () => 10, paddingRight: () => 10, paddingTop: () => 7, paddingBottom: () => 7,
      },
    } as Content,
    { text: SHEET_WORDS.signIn(sheet.signInAt), fontSize: T.BODY, color: C.ink, margin: [0, 8, 0, 10] },
  ];
}

/**
 * **The file's definition** (AC-2): A4 landscape, the app's Inter, the footer on every page, and the file's metadata — its
 * title *"Akun & password {KPM}"*, the author AgencyBoost. `createdAt` is the clock's: no date is read from the machine.
 */
export function temporaryPasswordsDocument(sheet: TemporaryPasswordSheet, createdAt: Date): TDocumentDefinitions {
  return {
    pageSize: 'A4',
    pageOrientation: 'landscape',
    pageMargins: [MARGIN, MARGIN, MARGIN, 44],
    info: {
      title: `${SHEET_WORDS.title} ${sheet.kpm.name}`,
      author: 'AgencyBoost',
      producer: 'AgencyBoost',
      creator: 'AgencyBoost',
      creationDate: createdAt,
    },
    defaultStyle: { font: PDF_FONTS.REGULAR, fontSize: T.BODY, color: C.ink, lineHeight: 1.15 },
    footer: (current: number, count: number) => ({
      text: SHEET_WORDS.footer(sheet.kpm.name, current, count),
      fontSize: T.SMALL,
      color: C.grey,
      alignment: 'right',
      margin: [MARGIN, 14, MARGIN, 0],
    }) as Content,
    content: [...head(sheet), table(sheet.rows)],
  };
}

/**
 * **`Akun-password-{KPM}-{YYYY-MM-DD}.pdf`**: the KPM's name with its accents taken off, every run of characters that
 * are not letters or digits made one `-`; `ascii` the same with every character above 127 dropped, for `filename=`.
 */
export function sheetFileName(kpmName: string, day: string): { name: string; ascii: string } {
  const kpm = kpmName.normalize('NFKD').replace(/\p{M}+/gu, '').replace(/[^\p{L}\p{N}]+/gu, '-').replace(/^-+|-+$/g, '').slice(0, 60) || 'KPM';
  const name = `Akun-password-${kpm}-${day}.pdf`;
  // eslint-disable-next-line no-control-regex
  return { name, ascii: name.replace(/[^\x00-\x7F]/g, '') };
}
