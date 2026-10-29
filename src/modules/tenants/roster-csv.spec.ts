import {
  generateTemporaryPassword,
  inLeaderFirstOrder,
  parseRoster as parse,
  ROSTER_EXAMPLES,
  ROSTER_TEMPLATE,
  ROSTER_TEMPLATE_HEADER,
  type RosterIssue,
} from './roster-csv';
import { english, indonesian } from '../../../test/i18n';

const H = ROSTER_TEMPLATE_HEADER;
/** The office's calendar day the four personal columns are measured against (ADR-0158 §2). */
const TODAY = '2026-10-26';
/** What a person records, for a row whose test is about something else (P18.8-T4). */
const P = ',1990-03-15,2021-07,full-time,female';
const P_TAB = P.split(',').join('\t');
/** Each issue as the API's English writes it: an issue is a sentence in both languages (P18.98-T5 AC-3). */
const inEnglish = <T extends { issues: RosterIssue[] }>(result: T) => ({
  ...result, issues: result.issues.map((issue) => ({ ...issue, message: english(issue.message) })),
});
const parseRoster = (text: string) => inEnglish(parse(text, TODAY));

describe('the roster file (P3.6-T4)', () => {
  describe('parsing', () => {
    it('reads a well-formed file', () => {
      const { rows, issues } = parseRoster(
        `${H}\nRina Wijaya,Rina@KPM.test,00881,agent,99${P}\n`,
      );
      expect(issues).toEqual([]);
      expect(rows).toEqual([{
        line: 2,
        fullName: 'Rina Wijaya',
        // Normalised the way the account will store them, so the preview shows what the
        // commit will write rather than what the file happened to contain.
        email: 'rina@kpm.test',
        agentCode: '00881',
        role: 'agent',
        leaderAgentCode: '99',
        dateOfBirth: '1990-03-15',
        companyJoinMonth: '2021-07',
        workStatus: 'full_time',
        gender: 'female',
      }]);
    });

    it('keeps a comma inside a quoted name', () => {
      // The case that actually turns up in an export. Splitting it would report a
      // mystifying issue about a missing agent code rather than the real problem.
      const { rows, issues } = parseRoster(`${H}\n"Wijaya, Rina",r@k.test,881,agent,${P}\n`);
      expect(issues).toEqual([]);
      expect(rows[0].fullName).toBe('Wijaya, Rina');
    });

    it('counts lines the way a spreadsheet does, header included', () => {
      const { rows } = parseRoster(`${H}\na,a@k.test,101,agent,${P}\nb,b@k.test,201,agent,${P}\n`);
      expect(rows.map((r) => r.line)).toEqual([2, 3]);
    });

    it('refuses a header that is not the template', () => {
      const { rows, issues } = parseRoster('name,email\nRina,r@k.test\n');
      expect(rows).toEqual([]);
      expect(issues[0].message).toContain('Download the template');
    });

    it('accepts a template saved by Excel, byte-order mark and all', () => {
      const { issues } = parseRoster(`﻿${H}\nRina,r@k.test,881,agent,${P}\n`);
      expect(issues).toEqual([]);
    });

    it('says so when the file is empty', () => {
      expect(parseRoster('').issues[0].message).toBe('The file is empty.');
      expect(parseRoster('\n\n  \n').issues[0].message).toBe('The file is empty.');
    });

    it('reports every bad cell on a row, not the first one', () => {
      // A per-row issue list is only useful if one pass surfaces everything wrong.
      const { issues } = parseRoster(`${H}\n,not-an-email,,senior manager,,,,,\n`);
      expect(issues.map((i) => i.column).sort()).toEqual([
        'agentCode', 'companyJoinMonth', 'dateOfBirth', 'email', 'fullName', 'gender', 'role', 'workStatus',
      ]);
    });

    it('names the rung it will not accept', () => {
      const { issues } = parseRoster(`${H}\nRina,r@k.test,881,senior manager,${P}\n`);
      expect(issues[0].message).toBe(
        '"senior manager" is not a rung. Use a rung of your company’s ladder by its code — AB, AAB or Agent, '
          + 'or one it added.',
      );
    });

    it('OD-50 leaves a rung the company added to the import, which checks it against the ladder', () => {
      // `SM` is a code in shape; whether the company's ladder has it, only the office can say.
      const { rows, issues } = parseRoster(`${H}\nRina,r@k.test,881,SM,${P}\n`);
      expect(issues).toEqual([]);
      expect(rows[0].role).toBe('sm');
    });

    it('reports a row with the wrong number of columns rather than guessing', () => {
      const { issues } = parseRoster(`${H}\nRina,r@k.test,881\n`);
      expect(issues[0].message).toContain('Expected 9 columns, found 3');
    });

    it('catches a duplicate inside the file, and points at the first one', () => {
      const { issues } = parseRoster(
        `${H}\nA,same@k.test,881,agent,${P}\nB,same@k.test,882,agent,${P}\nC,c@k.test,881,agent,${P}\n`,
      );
      expect(issues).toEqual([
        { line: 3, column: 'email', message: 'Already on line 2.' },
        { line: 4, column: 'agentCode', message: 'Already on line 2.' },
      ]);
    });
  });

  it('P18.98-T5 AC-7 says each issue in Indonesian too, the file’s own words kept as the file writes them', () => {
    const { issues } = parse(
      `${H}\nRina,r@k.test,8a1,senior manager,,15/03/1990,2021-07,fulltime,f\nB,r@k.test,882,agent,${P}\n`, TODAY,
    );
    expect(issues.map(({ line, column, message }) => ({ line, column, message: indonesian(message) }))).toEqual([
      { line: 2, column: 'agentCode', message: '"8a1" bukan kode agen. Gunakan angka saja, 3 sampai 32 digit.' },
      {
        line: 2, column: 'role',
        message: '"senior manager" bukan jenjang. Gunakan kode jenjang dari susunan jenjang perusahaan Anda — AB, AAB, '
          + 'atau Agent, atau jenjang yang ditambahkannya.',
      },
      {
        line: 2, column: 'dateOfBirth',
        message: '"15/03/1990" bukan tanggal lahir. Tulis dengan format YYYY-MM-DD, misalnya 1990-03-15.',
      },
      { line: 2, column: 'workStatus', message: '"fulltime" bukan status kerja. Gunakan full-time atau part-time.' },
      { line: 2, column: 'gender', message: '"f" bukan jenis kelamin. Gunakan male atau female.' },
      { line: 3, column: 'email', message: 'Sudah ada di baris 2.' },
    ]);
    expect(indonesian(parse('', TODAY).issues[0].message)).toBe('File ini kosong.');
    expect(indonesian(parse('name,email\nRina,r@k.test\n', TODAY).issues[0].message))
      .toBe(`Header harus persis: ${H}. Unduh templat.`);
  });

  describe('what a person records (P18.8-T4, ADR-0158)', () => {
    const row = (cells: Partial<Record<'code' | 'role' | 'dob' | 'join' | 'work' | 'gender', string>>) => {
      const c = { code: '881', role: 'agent', dob: '1990-03-15', join: '2021-07', work: 'full-time', gender: 'female', ...cells };
      return parseRoster(`${H}\nRina,r@k.test,${c.code},${c.role},,${c.dob},${c.join},${c.work},${c.gender}\n`);
    };
    const only = (result: ReturnType<typeof row>) => result.issues.map(({ column, message }) => ({ column, message }));

    it('AC-2: reads the four columns after the five, in that order, into what is stored', () => {
      expect(H).toBe('fullName,email,agentCode,role,leaderAgentCode,dateOfBirth,companyJoinMonth,workStatus,gender');
      const { rows, issues } = row({ work: 'Part-Time', gender: 'MALE' });
      expect(issues).toEqual([]);
      expect(rows[0]).toMatchObject({
        dateOfBirth: '1990-03-15', companyJoinMonth: '2021-07', workStatus: 'part_time', gender: 'male',
      });
    });

    it('AC-2: a row missing any of the four is an issue naming it', () => {
      expect(only(row({ dob: '' }))).toEqual([{ column: 'dateOfBirth', message: 'A date of birth is required.' }]);
      expect(only(row({ join: '' }))).toEqual([
        { column: 'companyJoinMonth', message: 'The month they joined the company is required.' },
      ]);
      expect(only(row({ work: '' }))).toEqual([
        { column: 'workStatus', message: 'A work status is required: full-time or part-time.' },
      ]);
      expect(only(row({ gender: '' }))).toEqual([{ column: 'gender', message: 'A gender is required: male or female.' }]);
    });

    it('AC-2: a malformed one is an issue naming it and what it takes', () => {
      expect(only(row({ dob: '15/03/1990' }))[0]).toMatchObject({ column: 'dateOfBirth' });
      expect(only(row({ dob: '15/03/1990' }))[0].message).toContain('Write it YYYY-MM-DD');
      expect(only(row({ join: '07/2021' }))[0]).toMatchObject({ column: 'companyJoinMonth' });
      expect(only(row({ work: 'fulltime' }))).toEqual([
        { column: 'workStatus', message: '"fulltime" is not a work status. Use full-time or part-time.' },
      ]);
      expect(only(row({ gender: 'f' }))).toEqual([{ column: 'gender', message: '"f" is not a gender. Use male or female.' }]);
    });

    it('AC-4: a birth date in the past and at least 18 years ago, as of the office\'s today', () => {
      expect(row({ dob: '2008-10-26' }).issues).toEqual([]);
      expect(only(row({ dob: '2008-10-27' }))).toEqual([
        { column: 'dateOfBirth', message: 'A date of birth must be at least 18 years ago.' },
      ]);
      expect(only(row({ dob: '2027-01-01' }))).toEqual([
        { column: 'dateOfBirth', message: 'A date of birth must be in the past.' },
      ]);
      // Measured against the day it is handed, not the machine's.
      expect(parse(`${H}\nRina,r@k.test,881,agent,,2008-10-27,2021-07,full-time,female\n`, '2026-10-27').issues).toEqual([]);
    });

    it('AC-4: a join month not in the future', () => {
      expect(row({ join: '2026-10' }).issues).toEqual([]);
      expect(only(row({ join: '2026-11' }))).toEqual([
        { column: 'companyJoinMonth', message: 'The company join month cannot be in the future.' },
      ]);
    });

    it('AC-5: an agent code is digits, 3 to 32 of them', () => {
      expect(row({ code: '880' }).issues).toEqual([]);
      for (const bad of ['PRU-88001', '88', '8'.repeat(33), '88.001']) {
        expect(only(row({ code: bad }))).toEqual([
          { column: 'agentCode', message: `"${bad}" is not an agent code. Use digits only, 3 to 32 of them.` },
        ]);
      }
    });

    it('AC-2: reads a rung in any case, as the template writes them AB, AAB and Agent', () => {
      for (const [cell, role] of [['AB', 'ab'], ['AAB', 'aab'], ['Agent', 'agent'], ['aGeNt', 'agent']]) {
        expect(row({ role: cell }).rows[0].role).toBe(role);
      }
      expect(ROSTER_EXAMPLES.map((cells) => cells[3])).toEqual(['AB', 'AAB', 'Agent']);
    });
  });

  describe('pasted from a spreadsheet', () => {
    /*
     * The point of accepting this at all: copying cells out of Excel, Google Sheets,
     * LibreOffice or Numbers puts **tab**-delimited text on the clipboard. Somebody who
     * pastes never opens a file, never saves one, and never learns what CSV is — which
     * was the complaint.
     */
    const tsv = (...rows: string[]) => rows.join('\n');

    it('reads tab-separated rows the same as comma-separated ones', () => {
      const { rows, issues } = parseRoster(tsv(
        H.split(',').join('\t'),
        `Rina Wijaya\trina@k.test\t881\tagent\t99${P_TAB}`,
      ));
      expect(issues).toEqual([]);
      expect(rows[0]).toMatchObject({ fullName: 'Rina Wijaya', agentCode: '881', workStatus: 'full_time' });
    });

    it('takes rows with no header at all, which is what somebody selects', () => {
      // A person highlights the rows they typed, not the header above them.
      const { rows, issues } = parseRoster(tsv(
        `Agus Prasetyo\tagus@k.test\t881\tAB\t${P_TAB}`,
        `Rina Wijaya\trina@k.test\t882\tAgent\t881${P_TAB}`,
      ));
      expect(issues).toEqual([]);
      expect(rows.map((r) => r.agentCode)).toEqual(['881', '882']);
      // And the first row is line 1, because there is no header above it.
      expect(rows[0].line).toBe(1);
    });

    it('keeps a comma inside a cell, because the delimiter is the tab', () => {
      // Excel does not quote a comma when the clipboard delimiter is a tab, so this
      // arrives bare — and splitting on commas would tear the name in half.
      const { rows } = parseRoster(`Puspita, Sari\tsari@k.test\t881\taab\t${P_TAB}`);
      expect(rows[0].fullName).toBe('Puspita, Sari');
    });

    it('still says "download the template" for a header somebody got wrong', () => {
      // Any cell naming a column marks it as a header attempt, so this is answered with
      // the template rather than with a confusing complaint about column counts.
      const { issues } = parseRoster('name,email\nRina,r@k.test\n');
      expect(issues[0].message).toContain('Download the template');
    });

    it('reads a headerless paste with a comma in the middle as one shape, not two', () => {
      // The delimiter is decided once, from the first line. Deciding per row would let a
      // stray character change how a single line is read.
      const { rows, issues } = parseRoster(tsv(
        `Agus\tagus@k.test\t881\tab\t${P_TAB}`,
        `Wijaya, Rina\trina@k.test\t882\tagent\t881${P_TAB}`,
      ));
      expect(issues).toEqual([]);
      expect(rows[1].fullName).toBe('Wijaya, Rina');
    });
  });

  describe('the template', () => {
    it('carries worked examples that cannot import', () => {
      // A template with live examples is a trap: somebody types under them and imports
      // Rina Wijaya along with their actual roster.
      const { rows, issues } = parseRoster(ROSTER_TEMPLATE);
      expect(issues).toEqual([]);
      expect(rows).toEqual([]);
      // And they are there to be read.
      expect(ROSTER_TEMPLATE).toContain('Agus Prasetyo');
      expect(ROSTER_TEMPLATE).toContain('"Puspita, Sari"');
    });

    it('shows what each column takes, and the one that is left empty', () => {
      // The leader column is the one people get wrong: it is an agent code, not a name,
      // and somebody at the top of the office has none.
      expect(ROSTER_TEMPLATE).toContain('LEAVE IT EMPTY');
      expect(ROSTER_TEMPLATE).toContain('AB, AAB or Agent');
      // And the four a person records, with the shape each takes (ADR-0158).
      expect(ROSTER_TEMPLATE).toContain('dateOfBirth       YYYY-MM-DD');
      expect(ROSTER_TEMPLATE).toContain('companyJoinMonth  YYYY-MM');
      expect(ROSTER_TEMPLATE).toContain('full-time or part-time');
      expect(ROSTER_TEMPLATE).toContain('male or female');
      expect(ROSTER_TEMPLATE).toContain('digits only, 3 to 32');
    });

    it('does not imply the password is emailed, because nothing emails it', () => {
      // `NOTIFICATION_ADAPTERS` is empty: no mail has ever left this system (OD-45). The
      // importing admin reads each password off the commit screen and passes it on, and
      // a column comment saying "where their password is sent" read as if the product
      // did it for them.
      expect(ROSTER_TEMPLATE).toContain('You send them their password yourself');
      expect(ROSTER_TEMPLATE).not.toContain('where their password is sent');
    });

    it('shows a chain, so the leader column is unambiguous', () => {
      // Agus leads Sari leads Rina, by code — which is what the column takes.
      expect(ROSTER_TEMPLATE).toContain('88002,AAB,88001');
      expect(ROSTER_TEMPLATE).toContain('88003,Agent,88002');
    });

    it('quotes an example name with a comma, and leaves the others bare', () => {
      // The template is a CSV, so the comma has to be escaped here — and only here.
      expect(ROSTER_TEMPLATE).toContain('# "Puspita, Sari",sari@example.test');
      expect(ROSTER_TEMPLATE).toContain('# Agus Prasetyo,agus@example.test');
    });

    it('imports what somebody adds under the examples, and nothing else', () => {
      const filled = `${ROSTER_TEMPLATE}Budi Santoso,budi@k.test,881,agent,${P}\n`;
      const { rows, issues } = parseRoster(filled);
      expect(issues).toEqual([]);
      expect(rows.map((r) => r.fullName)).toEqual(['Budi Santoso']);
    });

    it('reports the line a spreadsheet shows, not the line after filtering', () => {
      // The template is eleven lines of comment before the header. Numbering the survivors
      // instead of carrying their real positions would point the reader at a row they
      // cannot see.
      const filled = `${ROSTER_TEMPLATE},not-an-email,,director,,,,,\n`;
      const { issues } = parseRoster(filled);
      const linesInFile = ROSTER_TEMPLATE.split('\n').length;
      expect(new Set(issues.map((i) => i.line))).toEqual(new Set([linesInFile]));
    });
  });

  describe('the worked examples', () => {
    /*
     * They are one list because two places show them: the downloaded template writes them
     * as commented CSV, and the paste box shows them tab-separated. The guarantee worth
     * pinning is that neither is a lie — an example a person copies must be one that
     * would actually import.
     */
    const asPaste = () => ROSTER_EXAMPLES.map((cells) => cells.join('\t')).join('\n');

    it('would import, exactly as the paste box shows them', () => {
      const { rows, issues } = parseRoster(asPaste());
      expect(issues).toEqual([]);
      expect(rows.map((r) => r.agentCode)).toEqual(['88001', '88002', '88003']);
    });

    it('shows the leader column filled and empty, which is the column people get wrong', () => {
      // One row at the top of the office with nothing in it, and two naming a code. A
      // single example row can only ever demonstrate one of those.
      expect(ROSTER_EXAMPLES.map((cells) => cells[4])).toEqual(['', '88001', '88002']);
    });

    it('reads as a chain, so the column is plainly a code and not a name', () => {
      const { rows } = parseRoster(asPaste());
      expect(inLeaderFirstOrder(rows)?.map((r) => r.agentCode))
        .toEqual(['88001', '88002', '88003']);
    });

    it('needs no quoting when pasted, because the delimiter is the tab', () => {
      // The same name is quoted in the CSV template. Showing it bare in the paste box is
      // not an inconsistency — it is the difference between the two formats.
      const { rows } = parseRoster(asPaste());
      expect(rows[1].fullName).toBe('Puspita, Sari');
    });
  });

  describe('ordering', () => {
    it('puts a leader before the people who report to them', () => {
      // A spreadsheet lists people in whatever order it held them, and creating a
      // membership needs its leader to exist already.
      const { rows } = parseRoster(
        `${H}\nAgent,a@k.test,101,agent,201${P}\nLeader,b@k.test,201,ab,${P}\n`,
      );
      expect(inLeaderFirstOrder(rows)?.map((r) => r.agentCode)).toEqual(['201', '101']);
    });

    it('handles a chain three deep', () => {
      const { rows } = parseRoster(
        `${H}\nC,c@k.test,301,agent,201${P}\nB,b@k.test,201,aab,101${P}\nA,a@k.test,101,ab,${P}\n`,
      );
      expect(inLeaderFirstOrder(rows)?.map((r) => r.agentCode)).toEqual(['101', '201', '301']);
    });

    it('leaves a leader who is not in the file alone, because the office may hold them', () => {
      const { rows } = parseRoster(`${H}\nRina,r@k.test,881,agent,ALREADY-HERE${P}\n`);
      expect(inLeaderFirstOrder(rows)?.map((r) => r.agentCode)).toEqual(['881']);
    });

    it('refuses a cycle rather than discovering it halfway through the write', () => {
      const { rows } = parseRoster(
        `${H}\nA,a@k.test,101,ab,201${P}\nB,b@k.test,201,ab,101${P}\n`,
      );
      expect(inLeaderFirstOrder(rows)).toBeNull();
    });

    it('refuses somebody who is their own leader', () => {
      const { rows } = parseRoster(`${H}\nA,a@k.test,101,ab,101${P}\n`);
      expect(inLeaderFirstOrder(rows)).toBeNull();
    });
  });

  describe('the temporary password', () => {
    it('is long enough to sign in with, which is the whole job', () => {
      // It has to clear PasswordService's ten-character minimum, or the account cannot
      // reach the screen that replaces it.
      const password = generateTemporaryPassword();
      expect(password.length).toBeGreaterThanOrEqual(10);
    });

    it('leaves out the characters people misread when retyping', () => {
      // It is read off a screen, put in an email and typed once. `l1O0` is where that
      // goes wrong, exactly as it does for a leader code.
      for (let i = 0; i < 40; i += 1) {
        expect(generateTemporaryPassword()).not.toMatch(/[l1O0I]/);
      }
    });

    it('is grouped, so a person can keep their place', () => {
      expect(generateTemporaryPassword()).toMatch(/^[a-z2-9]{4}(-[a-z2-9]{4}){3}$/);
    });

    it('is different every time', () => {
      const seen = new Set(Array.from({ length: 200 }, generateTemporaryPassword));
      expect(seen.size).toBe(200);
    });
  });
});
