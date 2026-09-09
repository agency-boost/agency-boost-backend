import {
  generateTemporaryPassword,
  inLeaderFirstOrder,
  parseRoster,
  ROSTER_TEMPLATE,
  ROSTER_TEMPLATE_HEADER,
} from './roster-csv';

const H = ROSTER_TEMPLATE_HEADER;

describe('the roster file (P3.6-T4)', () => {
  describe('parsing', () => {
    it('reads a well-formed file', () => {
      const { rows, issues } = parseRoster(
        `${H}\nRina Wijaya,Rina@KPM.test,pru-1,agent,PRU-9\n`,
      );
      expect(issues).toEqual([]);
      expect(rows).toEqual([{
        line: 2,
        fullName: 'Rina Wijaya',
        // Normalised the way the account will store them, so the preview shows what the
        // commit will write rather than what the file happened to contain.
        email: 'rina@kpm.test',
        agentCode: 'PRU-1',
        role: 'agent',
        leaderAgentCode: 'PRU-9',
      }]);
    });

    it('keeps a comma inside a quoted name', () => {
      // The case that actually turns up in an export. Splitting it would report a
      // mystifying issue about a missing agent code rather than the real problem.
      const { rows, issues } = parseRoster(`${H}\n"Wijaya, Rina",r@k.test,PRU-1,agent,\n`);
      expect(issues).toEqual([]);
      expect(rows[0].fullName).toBe('Wijaya, Rina');
    });

    it('counts lines the way a spreadsheet does, header included', () => {
      const { rows } = parseRoster(`${H}\na,a@k.test,A1,agent,\nb,b@k.test,B1,agent,\n`);
      expect(rows.map((r) => r.line)).toEqual([2, 3]);
    });

    it('refuses a header that is not the template', () => {
      const { rows, issues } = parseRoster('name,email\nRina,r@k.test\n');
      expect(rows).toEqual([]);
      expect(issues[0].message).toContain('Download the template');
    });

    it('accepts a template saved by Excel, byte-order mark and all', () => {
      const { issues } = parseRoster(`﻿${H}\nRina,r@k.test,PRU-1,agent,\n`);
      expect(issues).toEqual([]);
    });

    it('says so when the file is empty', () => {
      expect(parseRoster('').issues[0].message).toBe('The file is empty.');
      expect(parseRoster('\n\n  \n').issues[0].message).toBe('The file is empty.');
    });

    it('reports every bad cell on a row, not the first one', () => {
      // A per-row issue list is only useful if one pass surfaces everything wrong.
      const { issues } = parseRoster(`${H}\n,not-an-email,,director,\n`);
      expect(issues.map((i) => i.column).sort()).toEqual(['agentCode', 'email', 'fullName', 'role']);
    });

    it('names the rung it will not accept', () => {
      const { issues } = parseRoster(`${H}\nRina,r@k.test,PRU-1,director,\n`);
      expect(issues[0].message).toContain('"director" is not a rung');
    });

    it('reports a row with the wrong number of columns rather than guessing', () => {
      const { issues } = parseRoster(`${H}\nRina,r@k.test,PRU-1\n`);
      expect(issues[0].message).toContain('Expected 5 columns, found 3');
    });

    it('catches a duplicate inside the file, and points at the first one', () => {
      const { issues } = parseRoster(
        `${H}\nA,same@k.test,PRU-1,agent,\nB,same@k.test,PRU-2,agent,\nC,c@k.test,PRU-1,agent,\n`,
      );
      expect(issues).toEqual([
        { line: 3, column: 'email', message: 'Already on line 2.' },
        { line: 4, column: 'agentCode', message: 'Already on line 2.' },
      ]);
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
        'fullName\temail\tagentCode\trole\tleaderAgentCode',
        'Rina Wijaya\trina@k.test\tPRU-1\tagent\tPRU-9',
      ));
      expect(issues).toEqual([]);
      expect(rows[0]).toMatchObject({ fullName: 'Rina Wijaya', agentCode: 'PRU-1' });
    });

    it('takes rows with no header at all, which is what somebody selects', () => {
      // A person highlights the rows they typed, not the header above them.
      const { rows, issues } = parseRoster(tsv(
        'Agus Prasetyo\tagus@k.test\tPRU-1\tab\t',
        'Rina Wijaya\trina@k.test\tPRU-2\tagent\tPRU-1',
      ));
      expect(issues).toEqual([]);
      expect(rows.map((r) => r.agentCode)).toEqual(['PRU-1', 'PRU-2']);
      // And the first row is line 1, because there is no header above it.
      expect(rows[0].line).toBe(1);
    });

    it('keeps a comma inside a cell, because the delimiter is the tab', () => {
      // Excel does not quote a comma when the clipboard delimiter is a tab, so this
      // arrives bare — and splitting on commas would tear the name in half.
      const { rows } = parseRoster('Puspita, Sari\tsari@k.test\tPRU-1\taab\t');
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
        'Agus\tagus@k.test\tPRU-1\tab\t',
        'Wijaya, Rina\trina@k.test\tPRU-2\tagent\tPRU-1',
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
      expect(ROSTER_TEMPLATE).toContain('ab, aab or agent');
    });

    it('shows a chain, so the leader column is unambiguous', () => {
      // Agus leads Sari leads Rina, by code — which is what the column takes.
      expect(ROSTER_TEMPLATE).toContain('PRU-88002,aab,PRU-88001');
      expect(ROSTER_TEMPLATE).toContain('PRU-88003,agent,PRU-88002');
    });

    it('imports what somebody adds under the examples, and nothing else', () => {
      const filled = `${ROSTER_TEMPLATE}Budi Santoso,budi@k.test,PRU-1,agent,\n`;
      const { rows, issues } = parseRoster(filled);
      expect(issues).toEqual([]);
      expect(rows.map((r) => r.fullName)).toEqual(['Budi Santoso']);
    });

    it('reports the line a spreadsheet shows, not the line after filtering', () => {
      // The template is eleven lines of comment before the header. Numbering the survivors
      // instead of carrying their real positions would point the reader at a row they
      // cannot see.
      const filled = `${ROSTER_TEMPLATE},not-an-email,,director,\n`;
      const { issues } = parseRoster(filled);
      const linesInFile = ROSTER_TEMPLATE.split('\n').length;
      expect(new Set(issues.map((i) => i.line))).toEqual(new Set([linesInFile]));
    });
  });

  describe('ordering', () => {
    it('puts a leader before the people who report to them', () => {
      // A spreadsheet lists people in whatever order it held them, and creating a
      // membership needs its leader to exist already.
      const { rows } = parseRoster(
        `${H}\nAgent,a@k.test,A1,agent,B1\nLeader,b@k.test,B1,ab,\n`,
      );
      expect(inLeaderFirstOrder(rows)?.map((r) => r.agentCode)).toEqual(['B1', 'A1']);
    });

    it('handles a chain three deep', () => {
      const { rows } = parseRoster(
        `${H}\nC,c@k.test,C1,agent,B1\nB,b@k.test,B1,aab,A1\nA,a@k.test,A1,ab,\n`,
      );
      expect(inLeaderFirstOrder(rows)?.map((r) => r.agentCode)).toEqual(['A1', 'B1', 'C1']);
    });

    it('leaves a leader who is not in the file alone, because the office may hold them', () => {
      const { rows } = parseRoster(`${H}\nRina,r@k.test,PRU-1,agent,ALREADY-HERE\n`);
      expect(inLeaderFirstOrder(rows)?.map((r) => r.agentCode)).toEqual(['PRU-1']);
    });

    it('refuses a cycle rather than discovering it halfway through the write', () => {
      const { rows } = parseRoster(
        `${H}\nA,a@k.test,A1,ab,B1\nB,b@k.test,B1,ab,A1\n`,
      );
      expect(inLeaderFirstOrder(rows)).toBeNull();
    });

    it('refuses somebody who is their own leader', () => {
      const { rows } = parseRoster(`${H}\nA,a@k.test,A1,ab,A1\n`);
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
