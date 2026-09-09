import { randomInt } from 'node:crypto';

/**
 * The roster file, and the password an imported account starts on.
 *
 * Parsing lives apart from the service so the column contract can be read, tested and
 * changed without a database — the same split `agent-code.ts` had, and for the same
 * reason: the rules about the *file* are not rules about the *office*.
 */

/** The columns, in order. The template download writes exactly this header. */
export const ROSTER_COLUMNS = [
  'fullName',
  'email',
  'agentCode',
  'role',
  'leaderAgentCode',
] as const;

export const ROSTER_TEMPLATE_HEADER = ROSTER_COLUMNS.join(',');

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
 * The template a person downloads: the header, then three examples they cannot import.
 *
 * The three are chosen to answer the questions the columns raise — what does a name with
 * a comma look like, what goes in the leader column for somebody at the top, and how does
 * a chain read. A blank template answers none of them, and the issue list is a worse place
 * to learn than the file itself.
 */
export const ROSTER_TEMPLATE = [
  `${COMMENT_PREFIX} AgencyBoost roster template.`,
  `${COMMENT_PREFIX} Add one row per person below. Lines starting with ${COMMENT_PREFIX} are ignored,`,
  `${COMMENT_PREFIX} so the examples never import — delete them or leave them, either is fine.`,
  `${COMMENT_PREFIX}`,
  `${COMMENT_PREFIX} fullName          the person's name. Quote it if it contains a comma.`,
  `${COMMENT_PREFIX} email             where their password is sent. Nobody may have registered it yet.`,
  `${COMMENT_PREFIX} agentCode         the producer id their insurer issued. Unique within the insurer.`,
  `${COMMENT_PREFIX} role              ab, aab or agent. Nothing else.`,
  `${COMMENT_PREFIX} leaderAgentCode   the agent code of whoever they report to.`,
  `${COMMENT_PREFIX}                   LEAVE IT EMPTY for somebody who reports to nobody.`,
  ROSTER_TEMPLATE_HEADER,
  `${COMMENT_PREFIX} Agus Prasetyo,agus@example.test,PRU-88001,ab,`,
  `${COMMENT_PREFIX} "Puspita, Sari",sari@example.test,PRU-88002,aab,PRU-88001`,
  `${COMMENT_PREFIX} Rina Wijaya,rina@example.test,PRU-88003,agent,PRU-88002`,
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
}

export interface RosterIssue {
  line: number;
  column: string;
  message: string;
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
 * Split one CSV line, honouring quotes.
 *
 * Not a full RFC 4180 parser and not trying to be: a name with a comma in it is the case
 * that actually turns up, and a quoted field with an embedded newline is not something a
 * roster export produces. What it must not do is split *"Wijaya, Rina"* into two columns
 * and report a mystifying issue about a missing agent code.
 */
function splitLine(line: string): string[] {
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
    else if (c === ',') { out.push(field); field = ''; }
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
export function parseRoster(csv: string): { rows: RosterRow[]; issues: RosterIssue[] } {
  const issues: RosterIssue[] = [];

  /*
   * **The line number a spreadsheet shows, carried rather than recomputed.**
   *
   * Blank lines and commented ones are dropped, but each surviving line keeps the number
   * it had in the file. Filtering first and numbering afterwards was the first version of
   * this, and the template ships with eleven comment lines — so every issue would have
   * been reported eleven lines off, pointing the reader at somebody else's row.
   */
  const lines = csv
    .split(/\r?\n/)
    .map((text, index) => ({ text, line: index + 1 }))
    .filter(({ text }) => text.trim() !== '' && !text.trimStart().startsWith(COMMENT_PREFIX));

  if (lines.length === 0) {
    issues.push({ line: 1, column: 'file', message: 'The file is empty.' });
    return { rows: [], issues };
  }

  const header = splitLine(lines[0].text).map((h) => h.replace(/^﻿/, ''));
  if (header.join(',').toLowerCase() !== ROSTER_TEMPLATE_HEADER.toLowerCase()) {
    issues.push({
      line: lines[0].line,
      column: 'file',
      message: `The header must read exactly: ${ROSTER_TEMPLATE_HEADER}. Download the template.`,
    });
    return { rows: [], issues };
  }

  const rows: RosterRow[] = [];
  const seenEmail = new Map<string, number>();
  const seenCode = new Map<string, number>();

  for (let i = 1; i < lines.length; i += 1) {
    const { line } = lines[i];
    const cells = splitLine(lines[i].text);
    if (cells.length !== ROSTER_COLUMNS.length) {
      issues.push({
        line,
        column: 'file',
        message: `Expected ${ROSTER_COLUMNS.length} columns, found ${cells.length}.`,
      });
      continue;
    }

    const [fullName, emailRaw, agentCodeRaw, roleRaw, leaderAgentCodeRaw] = cells;
    const email = emailRaw.toLowerCase();
    const agentCode = agentCodeRaw.toUpperCase();
    const role = roleRaw.toLowerCase();
    const leaderAgentCode = leaderAgentCodeRaw.toUpperCase();

    if (!fullName) issues.push({ line, column: 'fullName', message: 'A name is required.' });
    // Deliberately loose, and the same shape `@IsEmail` will apply on the way in. The
    // point here is to catch the blank and the obviously-not-an-address, not to relitigate
    // what an address may contain.
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      issues.push({ line, column: 'email', message: `"${emailRaw}" is not an email address.` });
    }
    if (!agentCode) {
      issues.push({ line, column: 'agentCode', message: 'An agent code is required.' });
    }
    if (!['ab', 'aab', 'agent'].includes(role)) {
      issues.push({
        line, column: 'role', message: `"${roleRaw}" is not a rung. Use ab, aab or agent.`,
      });
    }

    // Within the file. Against the office is the service's to check.
    const emailFirst = seenEmail.get(email);
    if (email && emailFirst) {
      issues.push({ line, column: 'email', message: `Already on line ${emailFirst}.` });
    } else if (email) seenEmail.set(email, line);

    const codeFirst = seenCode.get(agentCode);
    if (agentCode && codeFirst) {
      issues.push({ line, column: 'agentCode', message: `Already on line ${codeFirst}.` });
    } else if (agentCode) seenCode.set(agentCode, line);

    rows.push({ line, fullName, email, agentCode, role, leaderAgentCode });
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
