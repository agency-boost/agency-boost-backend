import { randomInt } from 'node:crypto';
import type { LocalDate } from '@/common/time/local-day';
import type { FieldSentence } from '@/common/validation/fields';
import { AGENT_CODE_PATTERN, type Gender, type WorkStatus } from '@/domain/constants';
import { birthDateProblem, joinMonthProblem } from '@/modules/users/personal-data';
import { TENANTS_REFUSALS } from './tenants.messages';

/** Each row's issue, in both languages (P18.98-T5 AC-3): written for the reader where the preview answers. */
const SAY = TENANTS_REFUSALS.VALIDATION_FAILED;

/**
 * The roster file, and the password an imported account starts on.
 *
 * Parsing lives apart from the service so the column contract can be read, tested and
 * changed without a database — the same split `agent-code.ts` had, and for the same
 * reason: the rules about the *file* are not rules about the *office*.
 */

/**
 * The columns, in order. The template download writes exactly this header.
 *
 * **Nine since P18.8-T4** (ADR-0158 §2): the four a person records follow the five, in this order, and
 * every one is required — a row missing any is an issue naming it.
 */
export const ROSTER_COLUMNS = [
  'fullName',
  'email',
  'agentCode',
  'role',
  'leaderAgentCode',
  'dateOfBirth',
  'companyJoinMonth',
  'workStatus',
  'gender',
] as const;

/**
 * The file's words for `memberships.workStatus` and `users.gender`, read in any case.
 *
 * Hyphenated in the file because that is how a person writes it in a spreadsheet; underscored in the
 * database because that is how a code is written (ADR-0158 §1).
 */
const WORK_STATUS_WORDS: Record<string, WorkStatus> = { 'full-time': 'full_time', 'part-time': 'part_time' };
const GENDER_WORDS: Record<string, Gender> = { male: 'male', female: 'female' };

export const ROSTER_TEMPLATE_HEADER = ROSTER_COLUMNS.join(',');

/**
 * Is this a rung's code in shape — letters, digits and underscores, starting with a letter, as the ladder
 * writes them (any case)? Whether the company's ladder has it is the import's to check.
 */
export function isRungCode(value: string): boolean {
  return /^[A-Za-z][A-Za-z0-9_]{1,31}$/.test(value);
}

/**
 * A line the importer ignores entirely.
 *
 * This exists so the template can carry **worked examples** without them becoming people.
 * A template with live example rows is a trap: somebody types under them, uploads, and
 * imports Rina Wijaya along with their actual roster — or, if the examples happen to be
 * invalid, gets four issues about rows they did not write and cannot see the point of.
 *
 * Commented out, they can be read, copied over, or left alone, and none of those creates
 * anybody.
 */
export const COMMENT_PREFIX = '#';

/**
 * The three worked examples, as **cells** rather than as a line.
 *
 * They answer the questions the columns raise: what goes in the leader column for
 * somebody at the top (nothing), that what goes in it is a *code* and not a name, and how
 * a chain of three reads. A blank template answers none of them, and the issue list is a
 * worse place to learn than the example itself.
 *
 * Cells, because two places need them in two shapes — the downloaded template writes them
 * as commented CSV, and the paste box shows them tab-separated, the way a clipboard
 * carries them. Deriving the second from the first would put a CSV splitter in the
 * frontend: a second parser, disagreeing with this one over precisely the row that is
 * here to demonstrate quoting.
 */
export const ROSTER_EXAMPLES: readonly (readonly string[])[] = [
  ['Agus Prasetyo', 'agus@example.test', '88001', 'AB', '', '1984-05-12', '2012-03', 'full-time', 'male'],
  ['Puspita, Sari', 'sari@example.test', '88002', 'AAB', '88001', '1990-11-02', '2016-08', 'full-time', 'female'],
  ['Rina Wijaya', 'rina@example.test', '88003', 'Agent', '88002', '1998-07-21', '2024-01', 'part-time', 'female'],
];

/** Quote a cell only where the delimiter would otherwise tear it in half. */
const asCsvCell = (cell: string) => (cell.includes(',') ? `"${cell}"` : cell);

/**
 * The template a person downloads: the header, then the three examples, commented out so
 * they cannot import.
 */
export const ROSTER_TEMPLATE = [
  `${COMMENT_PREFIX} AgencyBoost roster template.`,
  `${COMMENT_PREFIX} Add one row per person below. Lines starting with ${COMMENT_PREFIX} are ignored,`,
  `${COMMENT_PREFIX} so the examples never import — delete them or leave them, either is fine.`,
  `${COMMENT_PREFIX}`,
  `${COMMENT_PREFIX} fullName          the person's name. Quote it if it contains a comma.`,
  `${COMMENT_PREFIX} email             their address. It must be one nobody has registered yet.`,
  `${COMMENT_PREFIX}                   You send them their password yourself — nothing is emailed.`,
  `${COMMENT_PREFIX} agentCode         the producer id their insurer issued: digits only, 3 to 32 of them.`,
  `${COMMENT_PREFIX}                   Unique within the insurer.`,
  `${COMMENT_PREFIX} role              the rung's code on your company's ladder: AB, AAB or Agent,`,
  `${COMMENT_PREFIX}                   or a rung the company added.`,
  `${COMMENT_PREFIX} leaderAgentCode   the agent code of whoever they report to.`,
  `${COMMENT_PREFIX}                   LEAVE IT EMPTY for somebody who reports to nobody.`,
  `${COMMENT_PREFIX} dateOfBirth       YYYY-MM-DD, like 1990-03-15. They must be at least 18.`,
  `${COMMENT_PREFIX} companyJoinMonth  YYYY-MM, like 2021-07: the month they joined the insurer.`,
  `${COMMENT_PREFIX} workStatus        full-time or part-time.`,
  `${COMMENT_PREFIX} gender            male or female.`,
  ROSTER_TEMPLATE_HEADER,
  ...ROSTER_EXAMPLES.map((cells) => `${COMMENT_PREFIX} ${cells.map(asCsvCell).join(',')}`),
  '',
].join('\n');

export interface RosterRow {
  /** 1-based, and counting the header — so it is the line number a spreadsheet shows. */
  line: number;
  fullName: string;
  email: string;
  agentCode: string;
  role: string;
  /** Empty for somebody who reports to nobody: the office root, or a second one. */
  leaderAgentCode: string;
  /** `YYYY-MM-DD`, checked: a real day, in the past, at least 18 years ago (ADR-0158 §2). */
  dateOfBirth: string;
  /** `YYYY-MM`, checked: a real month, not one still to come. */
  companyJoinMonth: string;
  /** Read from `full-time` / `part-time`; `null` only on a row that has an issue saying why. */
  workStatus: WorkStatus | null;
  /** Read from `male` / `female`; `null` only on a row that has an issue saying why. */
  gender: Gender | null;
}

export interface RosterIssue {
  line: number;
  column: string;
  /**
   * What is wrong, in both languages (P18.98-T5 AC-3): the preview writes it for its reader, and the commit's refusal
   * carries it in `details.issues`, which the error filter writes for its reader.
   */
  message: FieldSentence;
}

/**
 * A password nobody chose, for an account somebody else is creating.
 *
 * **Readable, because it is going to be retyped.** The admin reads it off a screen and
 * puts it in an email, and the recipient types it once. `l1O0` and friends are excluded
 * for the same reason the leader-code alphabet excludes them, and the groups are
 * hyphenated so a person can keep their place.
 *
 * It is generated with `randomInt`, never stored in plaintext, and returned to the
 * importing admin exactly once — the commit response is the only place it exists outside
 * the recipient's inbox. `mustChangePassword` is set alongside it, so the credential the
 * admin has seen opens nothing but the screen that replaces it.
 */
const PASSWORD_ALPHABET = 'abcdefghijkmnpqrstuvwxyz23456789';
const PASSWORD_GROUPS = 4;
const PASSWORD_GROUP_LENGTH = 4;

export function generateTemporaryPassword(): string {
  const groups: string[] = [];
  for (let g = 0; g < PASSWORD_GROUPS; g += 1) {
    let group = '';
    for (let i = 0; i < PASSWORD_GROUP_LENGTH; i += 1) {
      group += PASSWORD_ALPHABET[randomInt(PASSWORD_ALPHABET.length)];
    }
    groups.push(group);
  }
  // 16 characters of alphabet-32 is ~80 bits, and comfortably over the 10-character
  // minimum `PasswordService` enforces — which matters, because the account has to be
  // able to sign in with it before it can replace it.
  return groups.join('-');
}

/**
 * Split one line, honouring quotes.
 *
 * Not a full RFC 4180 parser and not trying to be: a name with a comma in it is the case
 * that actually turns up, and a quoted field with an embedded newline is not something a
 * roster export produces. What it must not do is split *"Wijaya, Rina"* into two columns
 * and report a mystifying issue about a missing agent code.
 *
 * The delimiter is a parameter because the same rows arrive two ways: comma-separated
 * from a downloaded file, and **tab**-separated from a clipboard. Copying cells out of
 * Excel, Google Sheets, LibreOffice or Numbers puts tab-delimited text on the clipboard —
 * which is the whole reason somebody can paste a roster without knowing what CSV is.
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

/**
 * Read a roster file into rows and complaints.
 *
 * Everything it can decide from the file alone is decided here — shape, emptiness,
 * duplicates within the file. What it cannot know is what the *office* already contains,
 * so a code somebody already holds, or a leader who is neither in the file nor in the
 * office, is the service's to report.
 */
/**
 * Tab or comma, decided by the first surviving line.
 *
 * A tab cannot appear in any of our column names or in a plausible agent code, so its
 * presence is unambiguous — and a clipboard paste always has one. Guessing per row would
 * let a single stray character change how one line is read; the file has one shape.
 */
function delimiterOf(firstLine: string): string {
  return firstLine.includes('\t') ? '\t' : ',';
}

/**
 * Is this line the column names, rather than a person?
 *
 * **Any** cell naming a column is enough. Requiring the first one meant `name,email` —
 * somebody's own header, wrong — was read as a person, and answered with *"expected 5
 * columns, found 2"* instead of *"download the template"*. A data row would have to hold
 * a cell equal to `email` or `role` to be misread this way, and an email cell is never
 * literally the word `email`.
 */
function looksLikeHeader(cells: string[]): boolean {
  const names = new Set<string>(ROSTER_COLUMNS.map((c) => c.toLowerCase()));
  return cells.some((cell) => names.has(cell.toLowerCase().replace(/^﻿/, '')));
}

/**
 * `today` is the office's calendar day (from the injected clock, in `kpms.timezone`), which a birth
 * date and a join month are measured against. The parser reads no clock of its own.
 */
export function parseRoster(text: string, today: LocalDate): { rows: RosterRow[]; issues: RosterIssue[] } {
  const issues: RosterIssue[] = [];

  /*
   * **The line number a spreadsheet shows, carried rather than recomputed.**
   *
   * Blank lines and commented ones are dropped, but each surviving line keeps the number
   * it had in the file. Filtering first and numbering afterwards was the first version of
   * this, and the template ships with eleven comment lines — so every issue would have
   * been reported eleven lines off, pointing the reader at somebody else's row.
   */
  const lines = text
    .split(/\r?\n/)
    .map((text, index) => ({ text, line: index + 1 }))
    .filter(({ text }) => text.trim() !== '' && !text.trimStart().startsWith(COMMENT_PREFIX));

  if (lines.length === 0) {
    issues.push({ line: 1, column: 'file', message: SAY.fileEmpty });
    return { rows: [], issues };
  }

  const delimiter = delimiterOf(lines[0].text);
  const firstCells = splitLine(lines[0].text, delimiter).map((h) => h.replace(/^﻿/, ''));

  /*
   * **The header is optional.**
   *
   * A downloaded file always has one. A paste often does not: somebody selects the rows
   * they typed and copies those, which is the natural thing to do and would otherwise be
   * rejected for a reason they could not act on.
   *
   * So: a first line that names the columns is a header; a first line that *starts* to —
   * `fullName` in the first cell but the rest wrong — is a header somebody got wrong, and
   * saying so beats reading their column names as a person's details; anything else is
   * data, and the first row is line 1.
   */
  const hasHeader = looksLikeHeader(firstCells);
  if (hasHeader && firstCells.join(',').toLowerCase() !== ROSTER_TEMPLATE_HEADER.toLowerCase()) {
    issues.push({
      line: lines[0].line,
      column: 'file',
      message: SAY.headerExactly({ header: ROSTER_TEMPLATE_HEADER }),
    });
    return { rows: [], issues };
  }

  const rows: RosterRow[] = [];
  const seenEmail = new Map<string, number>();
  const seenCode = new Map<string, number>();

  for (let i = hasHeader ? 1 : 0; i < lines.length; i += 1) {
    const { line } = lines[i];
    const cells = splitLine(lines[i].text, delimiter);
    if (cells.length !== ROSTER_COLUMNS.length) {
      issues.push({
        line,
        column: 'file',
        message: SAY.columnCount({ expected: ROSTER_COLUMNS.length, found: cells.length }),
      });
      continue;
    }

    const [
      fullName, emailRaw, agentCodeRaw, roleRaw, leaderAgentCodeRaw,
      dateOfBirth, companyJoinMonth, workStatusRaw, genderRaw,
    ] = cells;
    const email = emailRaw.toLowerCase();
    const agentCode = agentCodeRaw.toUpperCase();
    const role = roleRaw.toLowerCase();
    const leaderAgentCode = leaderAgentCodeRaw.toUpperCase();

    if (!fullName) issues.push({ line, column: 'fullName', message: SAY.nameRequired });
    // Deliberately loose, and the same shape `@IsEmail` will apply on the way in. The
    // point here is to catch the blank and the obviously-not-an-address, not to relitigate
    // what an address may contain.
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      issues.push({ line, column: 'email', message: SAY.notAnEmail({ value: emailRaw }) });
    }
    if (!agentCode) {
      issues.push({ line, column: 'agentCode', message: SAY.agentCodeRequired });
    } else if (!AGENT_CODE_PATTERN.test(agentCode)) {
      // ADR-0158 §4: digits only on every new code. One already held elsewhere keeps its letters.
      issues.push({ line, column: 'agentCode', message: SAY.notAnAgentCode({ value: agentCodeRaw }) });
    }
    // The shape of a rung's code. Whether it is a rung **of this company's ladder** the parser cannot know:
    // the import checks it against the ladder (OD-50), so a rung the company added — `SM` — is placed too.
    if (!isRungCode(role)) {
      issues.push({ line, column: 'role', message: SAY.notARung({ value: roleRaw }) });
    }

    // The four a person records (ADR-0158 §2), each required, each named when it is wrong.
    if (!dateOfBirth) {
      issues.push({ line, column: 'dateOfBirth', message: SAY.birthDateRequired });
    } else {
      const problem = birthDateProblem(dateOfBirth, today);
      if (problem) issues.push({ line, column: 'dateOfBirth', message: problem });
    }
    if (!companyJoinMonth) {
      issues.push({ line, column: 'companyJoinMonth', message: SAY.joinMonthRequired });
    } else {
      const problem = joinMonthProblem(companyJoinMonth, today);
      if (problem) issues.push({ line, column: 'companyJoinMonth', message: problem });
    }
    const workStatus = WORK_STATUS_WORDS[workStatusRaw.toLowerCase()] ?? null;
    if (!workStatus) {
      issues.push({
        line, column: 'workStatus',
        message: workStatusRaw ? SAY.notAWorkStatus({ value: workStatusRaw }) : SAY.workStatusRequired,
      });
    }
    const gender = GENDER_WORDS[genderRaw.toLowerCase()] ?? null;
    if (!gender) {
      issues.push({
        line, column: 'gender',
        message: genderRaw ? SAY.notAGender({ value: genderRaw }) : SAY.genderRequired,
      });
    }

    // Within the file. Against the office is the service's to check.
    const emailFirst = seenEmail.get(email);
    if (email && emailFirst) {
      issues.push({ line, column: 'email', message: SAY.alreadyOnLine({ line: emailFirst }) });
    } else if (email) seenEmail.set(email, line);

    const codeFirst = seenCode.get(agentCode);
    if (agentCode && codeFirst) {
      issues.push({ line, column: 'agentCode', message: SAY.alreadyOnLine({ line: codeFirst }) });
    } else if (agentCode) seenCode.set(agentCode, line);

    rows.push({
      line, fullName, email, agentCode, role, leaderAgentCode,
      dateOfBirth, companyJoinMonth, workStatus, gender,
    });
  }

  return { rows, issues };
}

/**
 * Order the rows so every leader is created before anybody who reports to them.
 *
 * A file lists people in whatever order a spreadsheet happened to hold them, and
 * `HierarchyService.create` needs the leader's membership to exist. Returns `null` when
 * the leader references form a cycle — which the caller reports as a row-level issue
 * rather than discovering halfway through a write it cannot undo.
 */
export function inLeaderFirstOrder(rows: RosterRow[]): RosterRow[] | null {
  const byCode = new Map(rows.map((r) => [r.agentCode, r]));
  const ordered: RosterRow[] = [];
  const state = new Map<string, 'visiting' | 'done'>();

  const visit = (row: RosterRow): boolean => {
    const seen = state.get(row.agentCode);
    if (seen === 'done') return true;
    if (seen === 'visiting') return false; // A cycle.
    state.set(row.agentCode, 'visiting');

    const leader = row.leaderAgentCode ? byCode.get(row.leaderAgentCode) : undefined;
    // A leader who is not in the file is either already in the office or an issue the
    // service raises; either way there is nothing to order around.
    if (leader && !visit(leader)) return false;

    state.set(row.agentCode, 'done');
    ordered.push(row);
    return true;
  };

  for (const row of rows) if (!visit(row)) return null;
  return ordered;
}
