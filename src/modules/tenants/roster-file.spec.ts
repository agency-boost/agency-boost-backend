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

describe('the roster as a file (ADR-0184)', () => {
  describe('one sheet row as one line the parser splits back', () => {
    it('leaves a plain row as it is', () => {
      expect(csvLineOf(['Agus Prasetyo', 'agus@k.test', '88001', 'AB', ''])).toBe('Agus Prasetyo,agus@k.test,88001,AB,');
    });

    it('quotes a comma and a quote, doubling the quote', () => {
      expect(csvLineOf(['Puspita, Sari', 'Pak "Budi"'])).toBe('"Puspita, Sari","Pak ""Budi"""');
    });

    it('quotes a cell that starts with #, so a person is never read as a comment', () => {
      expect(csvLineOf(['#1 Agent', 'x'])).toBe('"#1 Agent",x');
      expect(parseRoster(`${ROSTER_TEMPLATE_HEADER}\n${csvLineOf(['#1 Agent', 'a@k.test', '881', 'agent', '', '1990-03-15', '2021-07', 'full-time', 'male'])}`, TODAY).rows[0].fullName)
        .toBe('#1 Agent');
    });

    it('makes a line break or a tab in a cell a space: one row stays one line, and the file stays comma-separated', () => {
      expect(csvLineOf(['Rina\nWijaya', 'a\tb'])).toBe('Rina Wijaya,a b');
    });
  });

  describe('a CSV file', () => {
    it('is read as UTF-8, its byte-order mark dropped', async () => {
      await expect(rosterTextOf(Uint8Array.from([0xef, 0xbb, 0xbf, ...utf8('fullName\nRina')]))).resolves.toBe('fullName\nRina');
    });

    it('is read as Windows-1252 when it is not UTF-8 — a spreadsheet’s plain CSV save', async () => {
      await expect(rosterTextOf(Uint8Array.from([...utf8('Andr'), 0xe9]))).resolves.toBe('André');
    });

    it('is refused when it is neither text nor a workbook', async () => {
      await expect(rosterTextOf(Uint8Array.from([0x25, 0x50, 0x44, 0x46, 0x00]))).rejects.toMatchObject({ code: 'UPLOAD_MALFORMED_CSV' });
    });
  });

  describe('the Excel template', () => {
    it('is a guide sheet in the reader’s language and a Data sheet holding the header alone', async () => {
      const id = await open(await rosterWorkbook(readerIn('id'), null));
      expect(id.worksheets.map((s) => s.name)).toEqual(['Petunjuk', 'Data']);
      const data = id.getWorksheet('Data')!;
      expect((data.getRow(1).values as unknown[]).slice(1)).toEqual([...ROSTER_COLUMNS]);
      expect(data.actualRowCount).toBe(1);

      const en = await open(await rosterWorkbook(readerIn('en'), null));
      expect(en.worksheets.map((s) => s.name)).toEqual(['Guide', 'Data']);
    });

    it('says what each column takes, the one left empty, and that nothing is emailed', async () => {
      const guide = texts((await open(await rosterWorkbook(readerIn('en'), null))).getWorksheet('Guide')!);
      expect(guide).toEqual(expect.arrayContaining([
        'AgencyBoost — the roster template',
        'The agent code of the leader they report to. Leave it empty for somebody who reports to nobody.',
        'The code of their rung on your company’s ladder: AB, AAB or Agent, or a rung the company added.',
        'YYYY-MM-DD, like 1990-03-15. They must be at least 18.',
        'YYYY-MM, like 2021-07: the month they joined the insurer.',
        'The code their insurer issued: digits only, 3 to 32 of them, unique within the insurer.',
        '• One person per row: an email or an agent code appears once in the file.',
      ]));
      // Nothing emails the password (OD-45); the importing admin passes it on.
      expect(guide.join(' ')).toContain('You send them their password yourself');
    });

    it('shows the three worked examples under the header, a chain by code — in the guide, never in the data', async () => {
      const workbook = await open(await rosterWorkbook(readerIn('id'), null));
      const guide = texts(workbook.getWorksheet('Petunjuk')!);
      expect(guide).toEqual(expect.arrayContaining(['Agus Prasetyo', 'Puspita, Sari', 'Rina Wijaya', '88001', '88002']));
      expect(guide).toContain('Kode agen leader orang tersebut. Kosongkan untuk orang yang tidak melapor kepada siapa pun.');
      expect(texts(workbook.getWorksheet('Data')!)).not.toContain('Agus Prasetyo');
    });

    it('offers the company ladder’s rungs as a dropdown when the office is known, and names them in the guide', async () => {
      const workbook = await open(await rosterWorkbook(readerIn('en'), ['AAB', 'AB', 'AGENT', 'SM']));
      const data = workbook.getWorksheet('Data')!;
      expect(data.getCell('D2').dataValidation).toMatchObject({ type: 'list', formulae: ['"AAB,AB,AGENT,SM"'] });
      expect(data.getCell(`D${ROSTER_FILL_ROWS + 1}`).dataValidation).toMatchObject({ type: 'list' });
      expect(texts(workbook.getWorksheet('Guide')!))
        .toContain('The code of their rung on your company’s ladder: AAB, AB, AGENT, SM. Choose it from the list.');
    });

    it('leaves the role free text without an office, and always offers the two fixed choices', async () => {
      const data = (await open(await rosterWorkbook(readerIn('en'), null))).getWorksheet('Data')!;
      expect(data.getCell('D2').dataValidation).toBeUndefined();
      expect(data.getCell('H2').dataValidation).toMatchObject({ formulae: ['"full-time,part-time"'] });
      expect(data.getCell('I2').dataValidation).toMatchObject({ formulae: ['"male,female"'] });
    });

    it('formats the code and date columns as text', async () => {
      const data = (await open(await rosterWorkbook(readerIn('en'), null))).getWorksheet('Data')!;
      expect([3, 5, 6, 7].map((c) => data.getColumn(c).numFmt)).toEqual(['@', '@', '@', '@']);
      expect(data.getColumn(1).numFmt).toBeUndefined();
    });
  });

  describe('the round trip: download, fill in, upload', () => {
    it('reads a filled template back as the rows a paste would be, each on the line its row is', async () => {
      const workbook = await open(await rosterWorkbook(readerIn('id'), ['AAB', 'AB', 'AGENT']));
      const data = workbook.getWorksheet('Data')!;
      data.getRow(2).values = ['Agus Prasetyo', 'agus@k.test', '00088001', 'AB', '', '1984-05-12', '2012-03', 'full-time', 'male'];
      // Row 3 left blank, as people do. Row 4: a name with a comma, an address Excel made a link, a code typed into a
      // cell with leading zeros kept as text, and a month pasted in from another sheet — a date, with its date format.
      data.getRow(4).values = [
        'Puspita, Sari', { text: 'sari@k.test', hyperlink: 'mailto:sari@k.test' }, '00088002', 'AAB', '00088001',
        '1990-11-02', new Date(Date.UTC(2016, 7, 1)), 'full-time', 'female',
      ];
      data.getCell('G4').numFmt = 'mmm-yy';
      const filled = new Uint8Array(await workbook.xlsx.writeBuffer());

      const text = await rosterTextOf(filled);
      const { rows, issues } = parseRoster(text, TODAY);
      expect(issues).toEqual([]);
      expect(rows.map((r) => [r.line, r.fullName, r.email, r.agentCode, r.leaderAgentCode, r.companyJoinMonth])).toEqual([
        [2, 'Agus Prasetyo', 'agus@k.test', '00088001', '', '2012-03'],
        [4, 'Puspita, Sari', 'sari@k.test', '00088002', '00088001', '2016-08'],
      ]);
    });

    it('finds the roster in a workbook whose tab was renamed, by its header, beside a sheet of notes', async () => {
      const workbook = new Workbook();
      workbook.addWorksheet('Catatan').addRow(['remember to ask Sari']);
      const mine = workbook.addWorksheet('Agustus');
      mine.addRow([...ROSTER_COLUMNS]);
      mine.addRow(['Agus Prasetyo', 'agus@k.test', '88001', 'AB', '', '1984-05-12', '2012-03', 'full-time', 'male']);
      const { rows, issues } = parseRoster(await rosterTextOf(new Uint8Array(await workbook.xlsx.writeBuffer())), TODAY);
      expect(issues).toEqual([]);
      expect(rows.map((r) => [r.line, r.agentCode])).toEqual([[2, '88001']]);
    });

    it('answers a row’s problem on the row the sheet shows', async () => {
      const workbook = await open(await rosterWorkbook(readerIn('en'), null));
      workbook.getWorksheet('Data')!.getRow(7).values = ['Rina', 'not-an-email', '88003', 'agent', '', '1998-07-21', '2024-01', 'part-time', 'female'];
      const { issues } = parseRoster(await rosterTextOf(new Uint8Array(await workbook.xlsx.writeBuffer())), TODAY);
      expect(issues.map((i) => [i.line, i.column])).toEqual([[7, 'email']]);
    });
  });
});
