import { isLocalDate, type LocalDate } from '@/common/time/local-day';
import type { Message } from '@/common/i18n/sentence';
import { AGENT_CODE_PATTERN, JOINING, normalisePhone, type Gender, type WorkStatus } from '@/domain/constants';
import { birthDateProblem, joinMonthProblem } from '@/modules/users/personal-data';
import { ROSTER_ROW_WORDS } from './roster-import.messages';
import { TENANTS_REFUSALS } from './tenants.messages';

/** The file's refusals, in both languages (P18.10-T5 AC-3). */
const SAY = TENANTS_REFUSALS.VALIDATION_FAILED;
const ROW = ROSTER_ROW_WORDS;

/**
 * The member import's file: its columns, how a line is read, and what a row's own cells can tell.
 *
 * Parsing lives apart from the service so the column contract can be read, tested and changed without a database: the
 * rules about the *file* are not rules about the *office*. What the office already holds — who has a code, who an upline
 * is, the company's ladder — is the service's (`roster-import.service.ts`).
 */

/** Every field a row can carry, in the template's order. */
export const ROSTER_FIELDS = [
  'agentCode',
  'fullName',
  'role',
  'leaderAgentCode',
  'phone',
  'email',
  'joinDate',
  'workStatus',
  'dateOfBirth',
  'gender',
  'companyJoinMonth',
] as const;
export type RosterField = (typeof ROSTER_FIELDS)[number];

/**
 * **The template's header, in A3's words** (P19.3-T4 AC-7; ADR-0205 §5): A3's nine — *Kode agen, Nama, Peran, Kode
 * upline, No. WhatsApp, Email, Tanggal bergabung, Waktu, Tanggal lahir* — then today's two other demographic columns,
 * *Jenis kelamin* and *Bulan bergabung di perusahaan* (ADR-0158), accepted after them. A file's own words are not a
 * screen's (P18.10-T3 AC-4): the header is the same in both languages.
 */
export const ROSTER_HEADER_NAMES: Readonly<Record<RosterField, string>> = {
  agentCode: 'Kode agen',
  fullName: 'Nama',
  role: 'Peran',
  leaderAgentCode: 'Kode upline',
  phone: 'No. WhatsApp',
  email: 'Email',
  joinDate: 'Tanggal bergabung',
  workStatus: 'Waktu',
  dateOfBirth: 'Tanggal lahir',
  gender: 'Jenis kelamin',
  companyJoinMonth: 'Bulan bergabung di perusahaan',
};

/** The columns, in the template's order, by their header names. The template download writes exactly this header. */
export const ROSTER_COLUMNS: readonly string[] = ROSTER_FIELDS.map((field) => ROSTER_HEADER_NAMES[field]);
export const ROSTER_TEMPLATE_HEADER = ROSTER_COLUMNS.join(',');

/** A row cannot be read without these three: who, what code, which rung (the A3 mockup's own check). */
export const ROSTER_REQUIRED_FIELDS: readonly RosterField[] = ['agentCode', 'fullName', 'role'];

/**
 * **Old files still import** (ADR-0205 §5; ADR-0184 §1): a header cell is read by its name, in any case, A3's words
 * or today's — the nine names the template carried until P19.3-T4 (`fullName`, `email`, `agentCode`, `role`,
 * `leaderAgentCode`, `dateOfBirth`, `companyJoinMonth`, `workStatus`, `gender`) — or the plain English and Indonesian a
 * person writes as a heading. Columns may come in any order, and only the three required need be there.
 */
const ALIASES: Readonly<Record<RosterField, readonly string[]>> = {
  agentCode: ['kode agen', 'agentcode', 'agent code', 'kode'],
  fullName: ['nama', 'fullname', 'full name', 'name', 'nama lengkap'],
  role: ['peran', 'role', 'jenjang'],
  leaderAgentCode: ['kode upline', 'leaderagentcode', 'leader agent code', 'upline', 'upline code', 'kode leader'],
  phone: ['no. whatsapp', 'no whatsapp', 'nomor whatsapp', 'whatsapp', 'no. wa', 'phone'],
  email: ['email', 'e-mail'],
  joinDate: ['tanggal bergabung', 'joindate', 'join date'],
  workStatus: ['waktu', 'workstatus', 'work status', 'status kerja', 'penuh/paruh waktu'],
  dateOfBirth: ['tanggal lahir', 'dateofbirth', 'date of birth'],
  gender: ['jenis kelamin', 'gender'],
  companyJoinMonth: ['bulan bergabung di perusahaan', 'companyjoinmonth', 'company join month', 'bulan bergabung'],
};

const FIELD_OF_NAME = new Map<string, RosterField>(
  ROSTER_FIELDS.flatMap((field) => ALIASES[field].map((alias) => [alias, field] as const)),
);

/** A header cell as its name is compared: the byte-order mark, a trailing `*` and runs of spaces gone, any case. */
function headerKey(cell: string): string {
  return cell.replace(/^﻿/, '').replace(/\*+$/, '').replace(/\s+/g, ' ').trim().toLowerCase();
}

/** The field a header cell names, or `null`. */
export function fieldOfHeader(cell: string): RosterField | null {
  return FIELD_OF_NAME.get(headerKey(cell)) ?? null;
}

/**
 * **Columns read and set aside**: `Alasan`, which the skipped rows' file adds (A3), so that file, fixed, uploads again as
 * it is; and its English. Nothing in them is a person's.
 */
const SET_ASIDE = new Set(['alasan', 'reason']);

/** The order a **headerless** paste is read in: A3's, or today's nine where the second cell is an address. */
const OLD_ORDER: readonly RosterField[] = [
  'fullName', 'email', 'agentCode', 'role', 'leaderAgentCode', 'dateOfBirth', 'companyJoinMonth', 'workStatus', 'gender',
];

/**
 * The file's words for `memberships.workStatus` and `users.gender`, read in any case (ADR-0158 §1): A3's *Full-time*
 * and *Part-time*, the template's `full-time`, and the Indonesian a person writes.
 */
const WORK_STATUS_WORDS: Record<string, WorkStatus> = {
  'full-time': 'full_time', 'full time': 'full_time', fulltime: 'full_time', full_time: 'full_time', 'penuh waktu': 'full_time',
  'part-time': 'part_time', 'part time': 'part_time', parttime: 'part_time', part_time: 'part_time', 'paruh waktu': 'part_time',
};
/** `L` and `P` too (P19.12-T7 AC-1; ADR-0250 §1): the letters an Indonesian form writes for *Laki-laki* and *Perempuan*. */
const GENDER_WORDS: Record<string, Gender> = {
  male: 'male', 'laki-laki': 'male', 'laki laki': 'male', pria: 'male', l: 'male',
  female: 'female', perempuan: 'female', wanita: 'female', p: 'female',
};

/**
 * Is this a rung's code in shape — letters, digits and underscores, starting with a letter, as the ladder writes them
 * (any case)? Whether the company's ladder has it is the import's to check.
 */
export function isRungCode(value: string): boolean {
  return /^[A-Za-z][A-Za-z0-9_]{1,31}$/.test(value);
}

/**
 * A line the importer ignores entirely: the `#` guidance a template downloaded before ADR-0184 carried. Neither
 * template has it now; a file of the old shape still reads as it always did.
 */
export const COMMENT_PREFIX = '#';

/**
 * **The three worked examples, as cells** in the template's order: what the paste box shows, tab-separated, and what
 * the Excel template's *Petunjuk* sheet lists under the header (ADR-0184). Somebody at the top (no upline), a code and
 * not a name in the upline column, a chain of three, a name with a comma, and one with no WhatsApp number.
 */
export const ROSTER_EXAMPLES: readonly (readonly string[])[] = [
  ['88001', 'Agus Prasetyo', 'AB', '', '0812 1100 8801', 'agus@example.test', '02/03/2015', 'Full-time', '12/05/1984', 'male', '2012-03'],
  ['88002', 'Puspita, Sari', 'AAB', '88001', '0812 1100 8802', 'sari@example.test', '01/07/2019', 'Full-time', '02/11/1990', 'female', '2016-08'],
  ['88003', 'Rina Wijaya', 'Agent', '88002', '', 'rina@example.test', '15/01/2026', 'Part-time', '21/07/1998', 'female', '2024-01'],
];

/** **The CSV template: the header, and nothing else** (ADR-0184). The guide is the Excel template's *Petunjuk* sheet. */
export const ROSTER_TEMPLATE = `${ROSTER_TEMPLATE_HEADER}\n`;

/** Something wrong with one cell, or with the file as a whole (`column: 'file'`). */
export interface RosterIssue {
  /** 1-based, and counting the header — the line number a spreadsheet shows. */
  line: number;
  /** The header name of the cell, or `file`. */
  column: string;
  /** In both languages (P18.10-T5 AC-3): written for the reader where it is answered. */
  message: Message;
}

export interface RosterRow {
  /** 1-based, and counting the header — the line number a spreadsheet shows. */
  line: number;
  /** The row as the file holds it, one cell per column of `ParsedRoster.header`: what the skipped-rows file writes back. */
  cells: string[];
  agentCode: string;
  fullName: string;
  /** The rung as typed, trimmed; `Agen` read as `Agent` (A3). The ladder decides whether it is one. */
  role: string;
  /** Empty for somebody at the top — or, on an update, for *keep the upline they have*. */
  leaderAgentCode: string;
  /** `+62…`, or `null` when the cell is blank. */
  phone: string | null;
  /** Lower-cased; empty when blank. */
  email: string;
  /** `YYYY-MM-DD`; `null` when blank — today for a new person, unchanged for an update. */
  joinDate: LocalDate | null;
  workStatus: WorkStatus | null;
  dateOfBirth: LocalDate | null;
  gender: Gender | null;
  /** `YYYY-MM`. */
  companyJoinMonth: string | null;
  /**
   * What is wrong with the row's **required** cells — *Kode agen*, *Nama*, *Peran* — and its *Email*, or with the line.
   * A row with any is skipped for them, each naming its cell; an *Email* problem only on a new person's row, since an
   * update never applies the email (the service's to decide, ADR-0250 §2).
   */
  problems: RosterIssue[];
  /**
   * **An optional cell given in a shape its column does not take, left empty** (P19.12-T7 AC-2; ADR-0250 §2): *No.
   * WhatsApp*, *Tanggal bergabung*, *Waktu*, *Tanggal lahir*, *Jenis kelamin* or *Bulan bergabung di perusahaan*. Its
   * field is `null` — nothing given — and the row goes on, the warning naming the cell and what was wrong with it.
   */
  warnings: RosterIssue[];
}

export interface ParsedRoster {
  /** The file's header, as it reads — or the template's, for rows pasted without one. */
  header: string[];
  rows: RosterRow[];
  /** What makes the file unreadable as a whole. With any, there are no rows. */
  issues: RosterIssue[];
}

/**
 * Split one line, honouring quotes. A name with a comma in it is the case that turns up; what this must not do is split
 * *"Wijaya, Rina"* into two columns. The delimiter is a parameter: a downloaded file is comma-separated, a clipboard
 * pasted from Excel, Google Sheets, LibreOffice or Numbers is tab-separated.
 */
function splitLine(line: string, delimiter: string): string[] {
  const out: string[] = [];
  let field = '';
  let quoted = false;
  for (let i = 0; i < line.length; i += 1) {
    const c = line[i];
    if (quoted) {
      if (c === '"' && line[i + 1] === '"') { field += '"'; i += 1; }
      else if (c === '"') quoted = false;
      else field += c;
    } else if (c === '"') quoted = true;
    else if (c === delimiter) { out.push(field); field = ''; }
    else field += c;
  }
  out.push(field);
  return out.map((f) => f.trim());
}

/** Tab or comma, decided by the first surviving line: a tab is in no column name and no plausible cell. */
function delimiterOf(firstLine: string): string {
  return firstLine.includes('\t') ? '\t' : ',';
}

/** Is this line the column names, rather than a person? Any cell naming a column is enough. */
export function looksLikeHeader(cells: readonly string[]): boolean {
  return cells.some((cell) => fieldOfHeader(cell) !== null);
}

/**
 * **A day as the file writes it, as `YYYY-MM-DD`**: A3's `DD/MM/YYYY` (or `D/M/YYYY`, or with dashes), or ISO already.
 * Anything else is returned as typed, so the check names what was written.
 */
export function isoDay(typed: string): string {
  const dmy = /^(\d{1,2})[/.-](\d{1,2})[/.-](\d{4})$/.exec(typed);
  if (dmy) return `${dmy[3]}-${dmy[2].padStart(2, '0')}-${dmy[1].padStart(2, '0')}`;
  return typed;
}

/** **A month as the file writes it, as `YYYY-MM`**: `YYYY-MM`, `MM/YYYY`, or a whole day — a workbook's date cell. */
export function isoMonth(typed: string): string {
  const my = /^(\d{1,2})[/.-](\d{4})$/.exec(typed);
  if (my) return `${my[2]}-${my[1].padStart(2, '0')}`;
  const day = isoDay(typed);
  if (/^\d{4}-\d{2}-\d{2}$/.test(day)) return day.slice(0, 7);
  return typed;
}

/** The file's header names, a list joined for a sentence. */
const named = (fields: readonly RosterField[]) => fields.map((f) => ROSTER_HEADER_NAMES[f]).join(', ');

/**
 * **Read a member file into rows** (P19.3-T4; ADR-0205 §5). Everything it can decide from the file alone is decided
 * here — the header, each cell's shape, a code or an address twice. A row with a problem is still a row: the import
 * skips it with its reasons and imports the rest (A3), where until ADR-0205 one problem refused the whole file. Only a
 * file whose columns cannot be read is refused whole.
 *
 * `today` is the office's calendar day (the injected clock, in `kpms.timezone`): a birth date, a join date and a join
 * month are measured against it. The parser reads no clock of its own.
 */
/**
 * **The agent-code format a KPM's codes follow** (P19.5-T1 AC-11; ADR-0214 §7): its template's published
 * `agentCodePattern`, read by the linear engine, and its example — in place of the global `AGENT_CODE_PATTERN`.
 */
export interface AgentCodeRule {
  test(code: string): boolean;
  example: string;
}

export function parseRoster(text: string, today: LocalDate, codeRule?: AgentCodeRule): ParsedRoster {
  /*
   * The line number a spreadsheet shows, carried rather than recomputed: blank and commented lines are dropped, but each
   * surviving line keeps the number it had in the file, so an issue points at the reader's own row.
   */
  const lines = text
    .split(/\r?\n/)
    .map((content, index) => ({ text: content, line: index + 1 }))
    .filter(({ text: content }) => content.trim() !== '' && !content.trimStart().startsWith(COMMENT_PREFIX));

  const refuse = (line: number, message: Message): ParsedRoster =>
    ({ header: [...ROSTER_COLUMNS], rows: [], issues: [{ line, column: 'file', message }] });
  if (lines.length === 0) return refuse(1, SAY.fileEmpty);

  const delimiter = delimiterOf(lines[0].text);
  const firstCells = splitLine(lines[0].text, delimiter).map((h) => h.replace(/^﻿/, ''));
  const hasHeader = looksLikeHeader(firstCells);

  /** Which field each column holds, in the file's order; `null` for a blank header cell. */
  let fields: (RosterField | null)[];
  let header: string[];
  if (hasHeader) {
    while (firstCells.length > 0 && firstCells[firstCells.length - 1] === '') firstCells.pop();
    fields = firstCells.map((cell) => (cell === '' ? null : fieldOfHeader(cell)));
    header = firstCells;
    const unknown = firstCells.filter((cell, i) => cell !== '' && fields[i] === null && !SET_ASIDE.has(headerKey(cell)));
    if (unknown.length > 0) {
      return refuse(lines[0].line, SAY.unknownColumns({ columns: unknown, accepted: ROSTER_COLUMNS }));
    }
    const seen = new Set<RosterField>();
    for (const field of fields) {
      if (field === null) continue;
      if (seen.has(field)) return refuse(lines[0].line, SAY.columnTwice({ column: ROSTER_HEADER_NAMES[field] }));
      seen.add(field);
    }
    const missing = ROSTER_REQUIRED_FIELDS.filter((field) => !seen.has(field));
    if (missing.length > 0) return refuse(lines[0].line, SAY.missingColumns({ columns: named(missing) }));
  } else {
    // No header: what somebody selects and copies. A3's order, unless the second cell is an address — today's nine.
    const old = firstCells[1]?.includes('@') ?? false;
    fields = [...(old ? OLD_ORDER : ROSTER_FIELDS)];
    header = fields.map((field) => ROSTER_HEADER_NAMES[field as RosterField]);
  }

  const rows: RosterRow[] = [];
  const seenCode = new Map<string, number>();
  const seenEmail = new Map<string, number>();

  for (let i = hasHeader ? 1 : 0; i < lines.length; i += 1) {
    const { line } = lines[i];
    const raw = splitLine(lines[i].text, delimiter);
    const problems: RosterIssue[] = [];
    const warnings: RosterIssue[] = [];
    const say = (field: RosterField | 'file', message: Message) =>
      problems.push({ line, column: field === 'file' ? 'file' : ROSTER_HEADER_NAMES[field], message });
    /** An optional cell's problem: the cell is left empty and the row goes on (ADR-0250 §2). */
    const blank = (field: RosterField, message: Message) =>
      warnings.push({ line, column: ROSTER_HEADER_NAMES[field], message });

    // A row may stop short — a spreadsheet's CSV drops trailing blanks — but never run past the header.
    const extra = raw.slice(fields.length).some((cell) => cell !== '');
    if (extra) say('file', SAY.columnCount({ expected: fields.length, found: raw.length }));
    const cells = Array.from({ length: fields.length }, (_, c) => raw[c] ?? '');
    const value = (field: RosterField) => {
      const at = fields.indexOf(field);
      return at < 0 ? '' : cells[at];
    };

    const agentCode = value('agentCode').toUpperCase();
    const fullName = value('fullName');
    const roleTyped = value('role');
    // A3: `Agen` is read as `Agent`.
    const role = /^agen$/i.test(roleTyped) ? 'Agent' : roleTyped;
    const leaderAgentCode = value('leaderAgentCode').toUpperCase();
    const emailRaw = value('email');
    const email = emailRaw.toLowerCase();
    const phoneRaw = value('phone');

    if (!agentCode) say('agentCode', SAY.agentCodeRequired);
    else if (codeRule && !codeRule.test(agentCode)) {
      // The KPM's template's own format (ADR-0214 §7): Prudential's `^[0-9]{8}$` once it is published.
      say('agentCode', SAY.notTemplateCode({ value: value('agentCode'), example: codeRule.example }));
    } else if (!codeRule && !AGENT_CODE_PATTERN.test(agentCode)) {
      // ADR-0158 §4's rule, with today's message, where no template's format is known.
      say('agentCode', SAY.notAnAgentCode({ value: value('agentCode') }));
    } else if (seenCode.has(agentCode)) {
      say('agentCode', ROW.codeTwice);
    }
    if (!fullName) say('fullName', SAY.nameRequired);
    if (!role) say('role', SAY.roleRequired);
    // Loose, as `@IsEmail` is on the way in: the blank is allowed here, the obviously-not-an-address is not.
    if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) say('email', SAY.notAnEmail({ value: emailRaw }));
    else if (email && seenEmail.has(email)) say('email', SAY.alreadyOnLine({ line: seenEmail.get(email)! }));

    /*
     * **The six optional cells forgive** (P19.12-T7 AC-2; ADR-0250 §2, amending ADR-0205 §5): *No. WhatsApp*, the join
     * date and the four fields of ADR-0158. Blank is nothing given; a value that is given is checked as before, and a
     * bad one is **left empty with a warning** naming the cell — the field `null`, as if blank — and the person still
     * imported. Until ADR-0250 a bad one skipped the whole row.
     */
    const phone = phoneRaw ? normalisePhone(phoneRaw) : null;
    if (phoneRaw && !phone) blank('phone', ROW.notAPhone({ value: phoneRaw }));

    const joinTyped = value('joinDate');
    let joinDate: string | null = joinTyped ? isoDay(joinTyped) : null;
    if (joinDate !== null) {
      const problem = !isLocalDate(joinDate) ? ROW.notAJoinDate({ value: joinTyped })
        : joinDate > today ? ROW.joinDateAfterToday
          : joinDate < JOINING.EARLIEST_JOIN_DATE
            ? ROW.joinDateBeforeEarliest({ year: JOINING.EARLIEST_JOIN_DATE.slice(0, 4) })
            : null;
      // Left empty, a new person joins on the import's day, as with a blank cell.
      if (problem) { blank('joinDate', problem); joinDate = null; }
    }
    const birthTyped = value('dateOfBirth');
    let dateOfBirth: string | null = birthTyped ? isoDay(birthTyped) : null;
    if (dateOfBirth !== null) {
      const problem = birthDateProblem(dateOfBirth, today);
      if (problem) { blank('dateOfBirth', problem); dateOfBirth = null; }
    }
    const monthTyped = value('companyJoinMonth');
    let companyJoinMonth: string | null = monthTyped ? isoMonth(monthTyped) : null;
    if (companyJoinMonth !== null) {
      const problem = joinMonthProblem(companyJoinMonth, today);
      if (problem) { blank('companyJoinMonth', problem); companyJoinMonth = null; }
    }
    const workTyped = value('workStatus');
    const workStatus = workTyped ? WORK_STATUS_WORDS[workTyped.toLowerCase()] ?? null : null;
    if (workTyped && !workStatus) blank('workStatus', SAY.notAWorkStatus({ value: workTyped }));
    const genderTyped = value('gender');
    const gender = genderTyped ? GENDER_WORDS[genderTyped.toLowerCase()] ?? null : null;
    if (genderTyped && !gender) blank('gender', SAY.notAGender({ value: genderTyped }));

    // The first row with a code or an address stands; a later one is skipped (A3's *muncul dua kali*).
    if (agentCode && !seenCode.has(agentCode)) seenCode.set(agentCode, line);
    if (email && !seenEmail.has(email)) seenEmail.set(email, line);

    rows.push({
      line, cells, agentCode, fullName, role, leaderAgentCode, phone, email,
      joinDate: joinDate as LocalDate | null, workStatus, dateOfBirth: dateOfBirth as LocalDate | null, gender,
      companyJoinMonth, problems, warnings,
    });
  }

  if (rows.length === 0) return refuse(lines[0].line, SAY.headerOnly);
  return { header, rows, issues: [] };
}

/** One CSV cell: quoted, its quotes doubled, when it holds a comma, a quote or a line break. */
function csvCell(cell: string): string {
  return /[",\r\n]/.test(cell) ? `"${cell.replace(/"/g, '""')}"` : cell;
}

/**
 * **The skipped rows, as a file** (A3: *"⬇ Unduh baris yang dilewati"*; ADR-0205 §8): the same columns, then `Alasan`,
 * each row as the file had it and in the file's order. Fixed and uploaded again, it imports what it now can.
 */
export function skippedRowsCsv(header: readonly string[], rows: readonly { cells: readonly string[]; reason: string }[]): string {
  const lines = [[...header, 'Alasan'], ...rows.map((row) => [...row.cells, row.reason])];
  return `${lines.map((cells) => cells.map(csvCell).join(',')).join('\n')}\n`;
}
