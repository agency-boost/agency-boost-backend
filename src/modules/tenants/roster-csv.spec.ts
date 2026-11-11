import * as rosterCsv from './roster-csv';
import {
  isoDay,
  isoMonth,
  parseRoster as parse,
  ROSTER_COLUMNS,
  ROSTER_EXAMPLES,
  ROSTER_TEMPLATE,
  ROSTER_TEMPLATE_HEADER,
  skippedRowsCsv,
  type RosterIssue,
} from './roster-csv';
import { english, indonesian } from '../../../test/i18n';

const H = ROSTER_TEMPLATE_HEADER;
/** The office's calendar day the dates are measured against (ADR-0158 §2). */
const TODAY = '2026-10-26';
/** Each issue as the API's English writes it: an issue is a sentence in both languages (P18.10-T5 AC-3). */
const said = (issues: RosterIssue[]) => issues.map((issue) => ({ ...issue, message: english(issue.message) }));
const parseRoster = (text: string) => {
  const parsed = parse(text, TODAY);
  return {
    ...parsed,
    issues: said(parsed.issues),
    rows: parsed.rows.map((r) => ({ ...r, problems: said(r.problems), warnings: said(r.warnings) })),
  };
};

/** The A3 sample's first row, the template's columns in order. */
const RAHMAT = '70045001,Rahmat Hidayat,AB,,0812 4500 1001,rahmat@contoh.id,02/03/2015,Full-time,12/05/1978,male,2012-03';

describe('P19.3-T4 the member file (the setup spec’s §A3; ADR-0205 §5)', () => {
  describe('AC-7 the columns', () => {
    it('P19.3-T4 AC-7 the template’s header is A3’s nine, in A3’s words, then the two demographic columns', () => {
      expect(ROSTER_COLUMNS).toEqual([
        'Kode agen', 'Nama', 'Peran', 'Kode upline', 'No. WhatsApp', 'Email', 'Tanggal bergabung', 'Waktu', 'Tanggal lahir',
        'Jenis kelamin', 'Bulan bergabung di perusahaan',
      ]);
      expect(ROSTER_TEMPLATE).toBe(`${H}\n`);
      expect(ROSTER_TEMPLATE).not.toContain('#');
    });

    it('P19.3-T4 AC-7 reads a row of the template into every field', () => {
      const { rows, issues } = parseRoster(`${H}\n${RAHMAT}\n`);
      expect(issues).toEqual([]);
      expect(rows[0]).toMatchObject({
        line: 2, agentCode: '70045001', fullName: 'Rahmat Hidayat', role: 'AB', leaderAgentCode: '', phone: '+6281245001001',
        email: 'rahmat@contoh.id', joinDate: '2015-03-02', workStatus: 'full_time', dateOfBirth: '1978-05-12', gender: 'male',
        companyJoinMonth: '2012-03', problems: [], warnings: [],
      });
      expect(rows[0].cells).toEqual(RAHMAT.split(','));
    });

    it('P19.3-T4 AC-7 an old file still imports: today’s English header names are read as A3’s, in their own order', () => {
      const old = 'fullName,email,agentCode,role,leaderAgentCode,dateOfBirth,companyJoinMonth,workStatus,gender';
      const { header, rows, issues } = parseRoster(`${old}\nRina Wijaya,Rina@KPM.test,00881,agent,99,1990-03-15,2021-07,full-time,female\n`);
      expect(issues).toEqual([]);
      expect(header).toEqual(old.split(','));
      expect(rows[0]).toMatchObject({
        fullName: 'Rina Wijaya', email: 'rina@kpm.test', agentCode: '00881', role: 'agent', leaderAgentCode: '99',
        dateOfBirth: '1990-03-15', companyJoinMonth: '2021-07', workStatus: 'full_time', gender: 'female', phone: null,
        joinDate: null, problems: [],
      });
    });

    it('P19.3-T4 AC-7 needs only Kode agen, Nama and Peran; the rest may be left out, or come in any order', () => {
      const { rows, issues } = parseRoster('Peran,Nama,Kode agen\nAgent,Budi,7001\n');
      expect(issues).toEqual([]);
      expect(rows[0]).toMatchObject({ agentCode: '7001', fullName: 'Budi', role: 'Agent', email: '', phone: null });
      expect(parseRoster('Nama,Email\nBudi,b@k.test\n').issues).toEqual([
        { line: 1, column: 'file', message: 'The file has no Kode agen, Peran column. Download the template and use its header.' },
      ]);
    });

    it('P19.3-T4 AC-7 names a heading the template does not have, rather than dropping its column without a word', () => {
      expect(parseRoster('Kode agen,Nama,Peran,Tangal lahir\n7001,Budi,Agent,01/01/1990\n').issues[0].message)
        .toBe(`"Tangal lahir": not a column of the template. Its columns are ${ROSTER_COLUMNS.join(', ')}.`);
      expect(parseRoster('Kode agen,Nama,Peran,Nama\n7001,Budi,Agent,B\n').issues[0].message).toBe('The column Nama appears twice.');
    });

    it('P19.3-T4 AC-7 sets aside a column with a blank heading — a spreadsheet’s spare column — and reads either side of it', () => {
      const { header, rows, issues } = parseRoster('Kode agen,Nama,,Peran\n70045001,Rahmat Hidayat,catatan,AB\n');
      expect(issues).toEqual([]);
      expect(header).toEqual(['Kode agen', 'Nama', '', 'Peran']);
      expect(rows[0]).toMatchObject({ agentCode: '70045001', fullName: 'Rahmat Hidayat', role: 'AB', problems: [] });
    });

    it('P19.3-T4 AC-7 keeps a comma inside a quoted name, and counts lines as a spreadsheet does', () => {
      const { rows } = parseRoster(`${H}\n\n"70045002","Puspita, Sari",AAB,70045001,,,,,,,\n`);
      expect(rows[0]).toMatchObject({ line: 3, fullName: 'Puspita, Sari' });
    });

    it('P19.3-T4 AC-7 reads a template downloaded before, its # guidance ignored, and one saved by Excel', () => {
      const { rows, issues } = parseRoster(`# guide\n# more\n﻿${H}\n# an example\n${RAHMAT}\n`);
      expect(issues).toEqual([]);
      expect(rows.map((r) => r.line)).toEqual([5]);
    });

    it('P19.3-T4 AC-7 a header and nobody under it, and an empty file, are said as such', () => {
      expect(parseRoster(ROSTER_TEMPLATE).issues[0].message).toBe('That file has a header and no people in it.');
      expect(parseRoster('').issues[0].message).toBe('The file is empty.');
    });

    it('P19.3-T4 AC-7 a row may stop short — a spreadsheet drops trailing blanks — but never run past the header', () => {
      const short = parseRoster(`${H}\n7001,Budi,Agent\n`);
      expect(short.rows[0].problems).toEqual([]);
      expect(short.rows[0].cells).toHaveLength(ROSTER_COLUMNS.length);
      const long = parseRoster(`Kode agen,Nama,Peran\n7001,Budi,Agent,extra\n`);
      expect(long.rows[0].problems).toEqual([{ line: 2, column: 'file', message: 'Expected 3 columns, found 4.' }]);
    });
  });

  describe('pasted from a spreadsheet', () => {
    it('reads tab-separated rows with no header in A3’s order', () => {
      const { rows, header, issues } = parseRoster(RAHMAT.split(',').join('\t'));
      expect(issues).toEqual([]);
      expect(header).toEqual([...ROSTER_COLUMNS]);
      expect(rows[0]).toMatchObject({ line: 1, agentCode: '70045001', fullName: 'Rahmat Hidayat' });
    });

    it('reads a headerless paste in today’s order when its second cell is an address', () => {
      const { rows } = parseRoster('Rina\trina@k.test\t101\tAgent\t\t1990-03-15\t2021-07\tfull-time\tfemale');
      expect(rows[0]).toMatchObject({ fullName: 'Rina', email: 'rina@k.test', agentCode: '101', role: 'Agent' });
    });

    it('P19.3-T4 AC-7 reads a paste one column wide — codes alone — in A3’s order, and says what each row still needs', () => {
      const { header, rows, issues } = parseRoster('70045001\n');
      expect(issues).toEqual([]);
      expect(header).toEqual([...ROSTER_COLUMNS]);
      expect(rows[0]).toMatchObject({ line: 1, agentCode: '70045001', fullName: '', role: '' });
      expect(rows[0].problems).toEqual([
        { line: 1, column: 'Nama', message: 'A name is required.' },
        { line: 1, column: 'Peran', message: 'A role is required.' },
      ]);
    });

    it('keeps a comma inside a cell, because the delimiter is the tab', () => {
      const { rows } = parseRoster(['Kode agen\tNama\tPeran', '7001\tWijaya, Rina\tAgent'].join('\n'));
      expect(rows[0].fullName).toBe('Wijaya, Rina');
    });

    it('the three worked examples read without a problem', () => {
      const { rows, issues } = parseRoster(ROSTER_EXAMPLES.map((cells) => cells.join('\t')).join('\n'));
      expect(issues).toEqual([]);
      expect(rows.map((r) => r.problems)).toEqual([[], [], []]);
      expect(rows.map((r) => r.leaderAgentCode)).toEqual(['', '88001', '88002']);
      expect(rows[2].phone).toBeNull();
    });
  });

  describe('AC-8 what a row’s own cells can tell', () => {
    it('P19.3-T4 AC-8 a code twice in the file: the later row is skipped with A3’s words, the first stands', () => {
      const { rows } = parse(`${H}\n${RAHMAT}\n70045001,Rahmat Lagi,AB,,,,,,,,\n`, TODAY);
      expect(rows[0].problems).toEqual([]);
      expect(rows[1].problems.map((p) => [p.column, english(p.message), indonesian(p.message)])).toEqual([
        ['Kode agen', 'This code appears twice in the file.', 'Kode muncul dua kali di file.'],
      ]);
    });

    it('P19.3-T4 AC-8 reads Agen as Agent', () => {
      expect(parseRoster(`${H}\n7001,Budi,Agen,7000,,,,,,,\n`).rows[0].role).toBe('Agent');
      expect(parseRoster(`${H}\n7001,Budi,agen,7000,,,,,,,\n`).rows[0].role).toBe('Agent');
      expect(parseRoster(`${H}\n7001,Budi,Agen Senior,7000,,,,,,,\n`).rows[0]).toMatchObject({ role: 'Agen Senior', problems: [] });
    });

    it('P19.3-T4 AC-8 a row with no WhatsApp number reads without a problem; a number that is none names its cell', () => {
      expect(parseRoster(`${H}\n7001,Budi,Agent,7000,,b@k.test,,,,,\n`).rows[0]).toMatchObject({ phone: null, problems: [] });
      // P19.12-T7 AC-2: named as a warning, the cell left empty and the row kept (ADR-0250 §2).
      const { rows } = parseRoster(`${H}\n7001,Budi,Agent,7000,12ab,b@k.test,,,,,\n`);
      expect(rows[0]).toMatchObject({ phone: null, problems: [] });
      expect(rows[0].warnings).toEqual([{ line: 2, column: 'No. WhatsApp', message: '"12ab" is not a WhatsApp number.' }]);
    });

    it('P19.3-T4 AC-8 the four fields of ADR-0158 and the join date are optional: blank is nothing given', () => {
      const { rows } = parseRoster(`${H}\n7001,Budi,Agent,7000,,b@k.test,,,,,\n`);
      expect(rows[0]).toMatchObject({ joinDate: null, workStatus: null, dateOfBirth: null, gender: null, companyJoinMonth: null });
      expect(rows[0].problems).toEqual([]);
    });

    it('P19.12-T7 AC-2 a value that is given is checked: a bad Email is a problem, a bad optional cell a warning', () => {
      const { rows } = parseRoster(`${H}\n7001,Budi,Agent,7000,,not-an-email,31/02/2020,sometimes,10/10/2015,f,2027-01\n`);
      expect(rows[0].problems).toEqual([
        { line: 2, column: 'Email', message: '"not-an-email" is not an email address.' },
      ]);
      expect(rows[0].warnings).toEqual([
        { line: 2, column: 'Tanggal bergabung', message: '"31/02/2020" is not a date. Write it DD/MM/YYYY or YYYY-MM-DD.' },
        { line: 2, column: 'Tanggal lahir', message: 'A date of birth must be at least 18 years ago.' },
        { line: 2, column: 'Bulan bergabung di perusahaan', message: 'The company join month cannot be in the future.' },
        { line: 2, column: 'Waktu', message: '"sometimes" is not a work status. Use Full-time or Part-time.' },
        {
          line: 2, column: 'Jenis kelamin',
          message: '"f" is not a gender. Use L or P, Laki-laki or Perempuan, or male or female.',
        },
      ]);
    });

    it('P19.12-T7 AC-2 each of the six optional cells, given badly, is left empty: its field null, the row kept', () => {
      // No. WhatsApp, Email, Tanggal bergabung, Waktu, Tanggal lahir, Jenis kelamin, Bulan bergabung di perusahaan.
      const bad: [cells: string, field: string, column: string][] = [
        ['nomor saya,b@k.test,,,,,', 'phone', 'No. WhatsApp'],
        [',b@k.test,01/01/2030,,,,', 'joinDate', 'Tanggal bergabung'],
        [',b@k.test,,Kadang,,,', 'workStatus', 'Waktu'],
        [',b@k.test,,,15/05/2015,,', 'dateOfBirth', 'Tanggal lahir'],
        [',b@k.test,,,,X,', 'gender', 'Jenis kelamin'],
        [',b@k.test,,,,,13/2020', 'companyJoinMonth', 'Bulan bergabung di perusahaan'],
      ];
      for (const [cells, field, column] of bad) {
        const [row] = parseRoster(`${H}\n7001,Budi,Agent,7000,${cells}\n`).rows;
        expect(row.problems).toEqual([]);
        expect(row).toMatchObject({ [field]: null, agentCode: '7001', fullName: 'Budi', role: 'Agent', email: 'b@k.test' });
        expect(row.warnings.map((w) => w.column)).toEqual([column]);
      }
    });

    it('P19.12-T7 AC-2 a bad required cell still skips the row: Kode agen, Nama and Peran stay problems', () => {
      const { rows } = parseRoster(`${H}\nAB-1,,,7000,nomor saya,b@k.test,,,,,\n`);
      expect(rows[0].problems.map((p) => p.column)).toEqual(['Kode agen', 'Nama', 'Peran']);
      expect(rows[0].warnings.map((w) => w.column)).toEqual(['No. WhatsApp']);
    });

    it('P19.12-T7 AC-1 reads L and P as male and female, in any case, as it reads Laki-laki and Male', () => {
      const gender = (typed: string) => parseRoster(`${H}\n7001,Budi,Agent,7000,,b@k.test,,,,${typed},\n`).rows[0];
      expect(gender('L')).toMatchObject({ gender: 'male', warnings: [] });
      expect(gender('l')).toMatchObject({ gender: 'male', warnings: [] });
      expect(gender(' P ')).toMatchObject({ gender: 'female', warnings: [] });
      expect(gender('p')).toMatchObject({ gender: 'female', warnings: [] });
      expect(gender('Laki-laki')).toMatchObject({ gender: 'male' });
      expect(gender('Male')).toMatchObject({ gender: 'male' });
      expect(gender('Perempuan')).toMatchObject({ gender: 'female' });
      expect(gender('LP')).toMatchObject({ gender: null });
    });

    it('P19.3-T4 AC-8 the join date is no later than the office’s today and no earlier than 1980', () => {
      // P19.12-T7 AC-2: a warning, the date left empty — the import's day, as a blank one is.
      const after = parseRoster(`${H}\n7001,Budi,Agent,7000,,,27/10/2026,,,,\n`).rows[0];
      expect(after.warnings[0].message).toBe('The join date cannot be after today.');
      expect(after.joinDate).toBeNull();
      expect(parseRoster(`${H}\n7001,Budi,Agent,7000,,,26/10/2026,,,,\n`).rows[0]).toMatchObject({ joinDate: '2026-10-26', warnings: [] });
      expect(parseRoster(`${H}\n7001,Budi,Agent,7000,,,01/01/1979,,,,\n`).rows[0].warnings[0].message)
        .toBe('The join date cannot be before 1980.');
    });

    it('P19.3-T4 AC-8 the code-format check is ADR-0158 §4’s, with today’s message, until a template holds a pattern', () => {
      expect(parseRoster(`${H}\nPRU-1,Budi,Agent,7000,,,,,,,\n`).rows[0].problems)
        .toEqual([{ line: 2, column: 'Kode agen', message: '"PRU-1" is not an agent code. Use digits only, 3 to 32 of them.' }]);
      // A3's 7-digit `7004510` is skipped only once the template's `agentCodePattern` asks for 8 (Phase 19.5, OD-266).
      expect(parseRoster(`${H}\n7004510,Tono Wijaya,Agent,70045001,,,,,,,\n`).rows[0].problems).toEqual([]);
    });

    it('P19.5-T1 AC-11 checks a code with the template’s own format once it publishes one: A3’s 7-digit code skipped for 8', () => {
      const eight = { test: (code: string) => /^[0-9]{8}$/.test(code), example: '70012345' };
      const parsed = parse(`${H}\n7004510,Tono Wijaya,Agent,70045001,,,,,,,\n${RAHMAT}\n`, TODAY, eight);
      expect(parsed.rows[0].problems.map((p) => [p.column, english(p.message), indonesian(p.message)])).toEqual([[
        'Kode agen',
        '"7004510" does not match this company\u2019s agent code format, for example 70012345.'.replace('\u2019', "'"),
        '"7004510" tidak cocok dengan format kode agen perusahaan ini, contohnya 70012345.',
      ]]);
      expect(parsed.rows[1].problems).toEqual([]);
      // A format with letters lets a code the global digits-only pattern refuses.
      const letters = { test: (code: string) => /^[A-Z0-9-]{1,32}$/.test(code), example: 'KPM-1' };
      expect(parse(`${H}\nPRU-1,Budi,Agent,7000,,,,,,,\n`, TODAY, letters).rows[0].problems).toEqual([]);
    });

    it('P19.3-T4 AC-8 an address twice in the file skips the later row, pointing at the first', () => {
      const { rows } = parseRoster(`${H}\n7001,A,Agent,7000,,a@k.test,,,,,\n7002,B,Agent,7000,,A@k.test,,,,,\n`);
      expect(rows[1].problems).toEqual([{ line: 3, column: 'Email', message: 'Already on line 2.' }]);
    });

    it('P19.3-T4 AC-8 writes each problem in Indonesian too, the file’s own words kept', () => {
      const { rows } = parse(`${H}\n,,,7000,12ab,,,sometimes,,L-P,\n`, TODAY);
      expect(rows[0].problems.map((p) => indonesian(p.message))).toEqual([
        'Kode agen wajib diisi.', 'Nama wajib diisi.', 'Peran wajib diisi.',
      ]);
      expect(rows[0].warnings.map((p) => indonesian(p.message))).toEqual([
        '"12ab" bukan nomor WhatsApp.',
        '"sometimes" bukan status kerja. Gunakan Full-time atau Part-time.',
        '"L-P" bukan jenis kelamin. Gunakan L atau P, Laki-laki atau Perempuan, atau male atau female.',
      ]);
      expect(indonesian(parse('Nama\nBudi\n', TODAY).issues[0].message))
        .toBe('Kolom Kode agen, Peran tidak ditemukan. Unduh template dan pakai header-nya.');
    });
  });

  describe('the shapes a day and a month are written in', () => {
    it('reads A3’s DD/MM/YYYY, ISO, and a workbook’s whole day for a month', () => {
      expect(isoDay('02/03/2015')).toBe('2015-03-02');
      expect(isoDay('2/3/2015')).toBe('2015-03-02');
      expect(isoDay('2015-03-02')).toBe('2015-03-02');
      expect(isoDay('March 2')).toBe('March 2');
      expect(isoMonth('2012-03')).toBe('2012-03');
      expect(isoMonth('03/2012')).toBe('2012-03');
      expect(isoMonth('2012-03-01')).toBe('2012-03');
      expect(isoMonth('soon')).toBe('soon');
    });
  });

  describe('AC-10 the skipped rows, as a file', () => {
    it('P19.3-T4 AC-10 writes the same columns and an Alasan column, each row as the file had it, in its order', () => {
      const csv = skippedRowsCsv(['Kode agen', 'Nama', 'Peran'], [
        { cells: ['70045006', 'Desi Anggraeni', 'Agen Senior'], reason: 'Peran "Agen Senior" tidak ada. Pakai: Agent, AAB, AB.' },
        { cells: ['70045009', 'Puspita, Sari', 'Agent'], reason: 'Kode upline 70049999 tidak ada di file atau di KPM ini.' },
      ]);
      expect(csv).toBe([
        'Kode agen,Nama,Peran,Alasan',
        '70045006,Desi Anggraeni,Agen Senior,"Peran ""Agen Senior"" tidak ada. Pakai: Agent, AAB, AB."',
        '70045009,"Puspita, Sari",Agent,Kode upline 70049999 tidak ada di file atau di KPM ini.',
        '',
      ].join('\n'));
      // Fixed and uploaded again as it is, it reads: `Alasan` is set aside, and the rows are the rows.
      const again = parseRoster(csv);
      expect(again.issues).toEqual([]);
      expect(again.rows.map((r) => [r.agentCode, r.fullName, r.role])).toEqual([
        ['70045006', 'Desi Anggraeni', 'Agen Senior'], ['70045009', 'Puspita, Sari', 'Agent'],
      ]);
    });
  });

  describe('AC-11 nobody reads a password', () => {
    it('P19.3-T4 AC-11 the file module makes no password: the generator the commit screen showed is gone', () => {
      expect(Object.keys(rosterCsv)).not.toContain('generateTemporaryPassword');
    });
  });
});
