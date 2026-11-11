import { Workbook, type Worksheet } from 'exceljs';
import { readerIn } from '@/common/i18n/reader';
import { csvLineOf, ROSTER_FILL_ROWS, rosterTextOf, rosterWorkbook } from './roster-file';
import { parseRoster, ROSTER_COLUMNS, ROSTER_TEMPLATE_HEADER } from './roster-csv';

const TODAY = '2026-11-01';
const utf8 = (s: string) => new TextEncoder().encode(s);

async function open(bytes: Uint8Array | Buffer): Promise<Workbook> {
  const workbook = new Workbook();
  await workbook.xlsx.load(bytes as unknown as Parameters<Workbook['xlsx']['load']>[0]);
  return workbook;
}

const texts = (sheet: Worksheet) => {
  const out: string[] = [];
  sheet.eachRow((row) => row.eachCell((cell) => { if (typeof cell.value === 'string') out.push(cell.value); }));
  return out;
};

describe('the roster as a file (ADR-0184; A3’s columns since P19.3-T4)', () => {
  describe('one sheet row as one line the parser splits back', () => {
    it('leaves a plain row as it is', () => {
      expect(csvLineOf(['88001', 'Agus Prasetyo', 'AB', ''])).toBe('88001,Agus Prasetyo,AB,');
    });

    it('quotes a comma and a quote, doubling the quote', () => {
      expect(csvLineOf(['Puspita, Sari', 'Pak "Budi"'])).toBe('"Puspita, Sari","Pak ""Budi"""');
    });

    it('quotes a cell that starts with #, so a person is never read as a comment', () => {
      expect(csvLineOf(['#1 Agent', 'x'])).toBe('"#1 Agent",x');
      expect(parseRoster(`${ROSTER_TEMPLATE_HEADER}\n${csvLineOf(['881', '#1 Agent', 'Agent', '880'])}`, TODAY).rows[0].fullName)
        .toBe('#1 Agent');
    });

    it('makes a line break or a tab in a cell a space: one row stays one line, and the file stays comma-separated', () => {
      expect(csvLineOf(['Rina\nWijaya', 'a\tb'])).toBe('Rina Wijaya,a b');
    });
  });

  describe('a CSV file', () => {
    it('is read as UTF-8, its byte-order mark dropped', async () => {
      await expect(rosterTextOf(Uint8Array.from([0xef, 0xbb, 0xbf, ...utf8('Nama\nRina')]))).resolves.toBe('Nama\nRina');
    });

    it('is read as Windows-1252 when it is not UTF-8 — a spreadsheet’s plain CSV save', async () => {
      await expect(rosterTextOf(Uint8Array.from([...utf8('Andr'), 0xe9]))).resolves.toBe('André');
    });

    it('is refused when it is neither text nor a workbook', async () => {
      await expect(rosterTextOf(Uint8Array.from([0x25, 0x50, 0x44, 0x46, 0x00]))).rejects.toMatchObject({ code: 'UPLOAD_MALFORMED_CSV' });
    });
  });

  describe('P19.3-T4 AC-7 the Excel template', () => {
    it('P19.3-T4 AC-7 is a guide sheet in the reader’s language and a Data sheet holding A3’s header alone', async () => {
      const id = await open(await rosterWorkbook(readerIn('id'), null));
      expect(id.worksheets.map((s) => s.name)).toEqual(['Petunjuk', 'Data']);
      const data = id.getWorksheet('Data')!;
      expect((data.getRow(1).values as unknown[]).slice(1)).toEqual([...ROSTER_COLUMNS]);
      expect((data.getRow(1).values as unknown[]).slice(1, 10)).toEqual([
        'Kode agen', 'Nama', 'Peran', 'Kode upline', 'No. WhatsApp', 'Email', 'Tanggal bergabung', 'Waktu', 'Tanggal lahir',
      ]);
      expect(data.actualRowCount).toBe(1);

      const en = await open(await rosterWorkbook(readerIn('en'), null));
      expect(en.worksheets.map((s) => s.name)).toEqual(['Guide', 'Data']);
    });

    it('P19.3-T4 AC-7 says what each column takes: three required, an email for somebody new, an invitation by email', async () => {
      const guide = texts((await open(await rosterWorkbook(readerIn('en'), null))).getWorksheet('Guide')!);
      expect(guide).toEqual(expect.arrayContaining([
        'AgencyBoost — the member template',
        'Their rung on your company’s ladder: Agent, AAB or AB, or a rung the company added.',
        'DD/MM/YYYY, like 15/03/1990. They must be at least 18.',
        'YYYY-MM, like 2021-07: the month they joined the insurer.',
        '• One person per row: an agent code or an email appears once in the file.',
      ]));
      const all = guide.join(' ');
      expect(all).toContain('the invitation to choose a password goes there');
      expect(all).toContain('Without one they are added, and cannot be reminded on WhatsApp yet.');
      // P19.12-T7 AC-2 (ADR-0250 §2): a bad optional cell is left empty; only a required one skips the row.
      expect(all).toContain('An optional cell written wrongly is left empty, with a warning, and the person is still added.');
      expect(all).toContain('is skipped with its reason, and the rest are added together.');
      // P19.12-T7 AC-1 and AC-4: L and P read in a paste; an Agent with no email invited on WhatsApp.
      expect(all).toContain('L or P and Laki-laki or Perempuan are read too.');
      expect(all).toContain('A new Agent with no email but a WhatsApp number is invited on WhatsApp');
      // No password is ever passed on by the importer any more (ADR-0205 §10).
      expect(all).not.toContain('You send them their password yourself');
    });

    it('shows the three worked examples under the header, a chain by code — in the guide, never in the data', async () => {
      const workbook = await open(await rosterWorkbook(readerIn('id'), null));
      const guide = texts(workbook.getWorksheet('Petunjuk')!);
      expect(guide).toEqual(expect.arrayContaining(['Agus Prasetyo', 'Puspita, Sari', 'Rina Wijaya', '88001', '88002']));
      expect(texts(workbook.getWorksheet('Data')!)).not.toContain('Agus Prasetyo');
    });

    it('P19.3-T4 AC-7 offers the company ladder’s rungs as the Peran dropdown when the office is known', async () => {
      const workbook = await open(await rosterWorkbook(readerIn('en'), ['Agent', 'AAB', 'AB', 'SM']));
      const data = workbook.getWorksheet('Data')!;
      expect(data.getCell('C2').dataValidation).toMatchObject({ type: 'list', formulae: ['"Agent,AAB,AB,SM"'] });
      expect(data.getCell(`C${ROSTER_FILL_ROWS + 1}`).dataValidation).toMatchObject({ type: 'list' });
      expect(texts(workbook.getWorksheet('Guide')!))
        .toContain('Their rung on your company’s ladder: Agent, AAB, AB, SM. Choose it from the list.');
    });

    it('P19.3-T4 AC-7 leaves Peran free text without an office, and always offers Waktu’s and Jenis kelamin’s choices', async () => {
      const data = (await open(await rosterWorkbook(readerIn('en'), null))).getWorksheet('Data')!;
      expect(data.getCell('C2').dataValidation).toBeUndefined();
      expect(data.getCell('H2').dataValidation).toMatchObject({ formulae: ['"Full-time,Part-time"'] });
      expect(data.getCell('J2').dataValidation).toMatchObject({ formulae: ['"male,female"'] });
    });

    it('formats the code, phone and date columns as text', async () => {
      const data = (await open(await rosterWorkbook(readerIn('en'), null))).getWorksheet('Data')!;
      expect([1, 4, 5, 7, 9, 11].map((c) => data.getColumn(c).numFmt)).toEqual(['@', '@', '@', '@', '@', '@']);
      expect(data.getColumn(2).numFmt).toBeUndefined();
    });
  });

  describe('the round trip: download, fill in, upload', () => {
    it('reads a filled template back as the rows a paste would be, each on the line its row is', async () => {
      const workbook = await open(await rosterWorkbook(readerIn('id'), ['Agent', 'AAB', 'AB']));
      const data = workbook.getWorksheet('Data')!;
      data.getRow(2).values = [
        '00088001', 'Agus Prasetyo', 'AB', '', '0812 1100 8801', 'agus@k.test', '02/03/2015', 'Full-time', '12/05/1984', 'male', '2012-03',
      ];
      // Row 3 left blank, as people do. Row 4: a name with a comma, an address Excel made a link, a code typed with its
      // leading zeros kept as text, a join day typed as a date, and a month pasted in from another sheet — a date.
      data.getRow(4).values = [
        '00088002', 'Puspita, Sari', 'AAB', '00088001', '', { text: 'sari@k.test', hyperlink: 'mailto:sari@k.test' },
        new Date(Date.UTC(2019, 6, 1)), 'Full-time', '02/11/1990', 'female', new Date(Date.UTC(2016, 7, 1)),
      ];
      data.getCell('G4').numFmt = 'dd/mm/yyyy';
      data.getCell('K4').numFmt = 'mmm-yy';
      const filled = new Uint8Array(await workbook.xlsx.writeBuffer());

      const { rows, issues } = parseRoster(await rosterTextOf(filled), TODAY);
      expect(issues).toEqual([]);
      expect(rows.map((r) => [r.line, r.fullName, r.email, r.agentCode, r.leaderAgentCode, r.joinDate, r.companyJoinMonth, r.problems]))
        .toEqual([
          [2, 'Agus Prasetyo', 'agus@k.test', '00088001', '', '2015-03-02', '2012-03', []],
          [4, 'Puspita, Sari', 'sari@k.test', '00088002', '00088001', '2019-07-01', '2016-08', []],
        ]);
    });

    it('P19.3-T4 AC-7 finds an old workbook by its header, today’s English names, beside a sheet of notes', async () => {
      const workbook = new Workbook();
      workbook.addWorksheet('Catatan').addRow(['remember to ask Sari']);
      const mine = workbook.addWorksheet('Agustus');
      mine.addRow(['fullName', 'email', 'agentCode', 'role', 'leaderAgentCode', 'dateOfBirth', 'companyJoinMonth', 'workStatus', 'gender']);
      mine.addRow(['Agus Prasetyo', 'agus@k.test', '88001', 'AB', '', '1984-05-12', '2012-03', 'full-time', 'male']);
      const { rows, issues } = parseRoster(await rosterTextOf(new Uint8Array(await workbook.xlsx.writeBuffer())), TODAY);
      expect(issues).toEqual([]);
      expect(rows.map((r) => [r.line, r.agentCode, r.problems])).toEqual([[2, '88001', []]]);
    });

    it('answers a row’s problem on the row the sheet shows, naming its cell', async () => {
      const workbook = await open(await rosterWorkbook(readerIn('en'), null));
      workbook.getWorksheet('Data')!.getRow(7).values = ['88003', 'Rina', 'Agent', '88002', '', 'not-an-email'];
      const { rows } = parseRoster(await rosterTextOf(new Uint8Array(await workbook.xlsx.writeBuffer())), TODAY);
      expect(rows.map((r) => [r.line, r.problems.map((p) => p.column)])).toEqual([[7, ['Email']]]);
    });
  });
});
