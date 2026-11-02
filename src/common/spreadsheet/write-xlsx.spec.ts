import { Workbook, type Worksheet } from 'exceljs';
import { readerIn } from '@/common/i18n/reader';
import { readXlsx } from './read-xlsx';
import { writeWorkbook, type TemplateWorkbook } from './write-xlsx';

const HEADER = ['code', 'name', 'joined', 'status'];

const spec = (language: 'en' | 'id', over: Partial<TemplateWorkbook['data']> = {}): TemplateWorkbook => ({
  reader: readerIn(language),
  guide: {
    title: 'The test template',
    steps: ['Fill in the Data sheet.', 'Upload it.'],
    columns: [
      { name: 'code', required: true, holds: 'Digits only.', example: '00088213' },
      { name: 'name', required: true, holds: 'Their name.', example: 'Rina' },
      { name: 'joined', required: false, holds: 'YYYY-MM.', example: '2021-07' },
    ],
    rules: ['One per row.', 'Do not rename the sheet.'],
    examples: [['88001', 'Agus', '2012-03', 'on']],
  },
  data: {
    header: HEADER,
    rows: [['00088213', 'Rina']],
    widths: [14, 28],
    textColumns: [0, 2],
    lists: [{ column: 3, values: ['on', 'off'] }],
    fillRows: 10,
    ...over,
  },
});

async function opened(t: TemplateWorkbook): Promise<Workbook> {
  const workbook = new Workbook();
  await workbook.xlsx.load((await writeWorkbook(t)) as unknown as Parameters<Workbook['xlsx']['load']>[0]);
  return workbook;
}

/** Every row of a sheet as its cells' values. */
const values = (sheet: Worksheet) => {
  const rows: unknown[][] = [];
  sheet.eachRow({ includeEmpty: true }, (row) => { rows.push((row.values as unknown[]).slice(1)); });
  return rows;
};

describe('writing a template workbook (ADR-0184)', () => {
  it('has two sheets: the guide, named in the reader’s language and opening first, then Data', async () => {
    expect((await opened(spec('id'))).worksheets.map((s) => s.name)).toEqual(['Petunjuk', 'Data']);
    const english = await opened(spec('en'));
    expect(english.worksheets.map((s) => s.name)).toEqual(['Guide', 'Data']);
    expect(english.views[0].activeTab).toBe(0);
  });

  describe('the guide', () => {
    it('holds the title, the steps, the column table, the rules and the examples — and no data', async () => {
      const guide = (await opened(spec('en'))).getWorksheet('Guide')!;
      expect(values(guide).map((row) => row.filter((v) => v !== undefined))).toEqual([
        ['The test template'],
        [],
        ['How to fill it in'],
        ['1. Fill in the Data sheet.'],
        ['2. Upload it.'],
        [],
        ['The Data sheet’s columns, in order'],
        ['Column', 'Required?', 'What to enter', 'Example'],
        ['code', 'Yes', 'Digits only.', '00088213'],
        ['name', 'Yes', 'Their name.', 'Rina'],
        ['joined', 'No', 'YYYY-MM.', '2021-07'],
        [],
        ['Rules'],
        ['• One per row.'],
        ['• Do not rename the sheet.'],
        [],
        ['Example rows'],
        HEADER,
        ['88001', 'Agus', '2012-03', 'on'],
      ]);
      expect(guide.getCell('A1').font.bold).toBe(true);
      expect(guide.getCell('A8').font.bold).toBe(true);
    });

    it('writes its headings in Indonesian for an Indonesian reader', async () => {
      const guide = (await opened(spec('id'))).getWorksheet('Petunjuk')!;
      const cells = values(guide).flat().filter((v) => typeof v === 'string');
      expect(cells).toEqual(expect.arrayContaining([
        'Cara mengisi', 'Kolom di sheet Data, berurutan', 'Kolom', 'Wajib?', 'Isi', 'Contoh', 'Ya', 'Tidak', 'Aturan',
        'Contoh baris',
      ]));
    });

    it('leaves the examples out when there are none', async () => {
      const t = spec('en');
      const guide = (await opened({ ...t, guide: { ...t.guide, examples: [] } })).getWorksheet('Guide')!;
      expect(values(guide).flat()).not.toContain('Example rows');
    });
  });

  describe('the Data sheet', () => {
    it('holds the header, bold and frozen, each cell noting what its column holds, then the rows', async () => {
      const data = (await opened(spec('en'))).getWorksheet('Data')!;
      expect(values(data)).toEqual([HEADER, ['00088213', 'Rina']]);
      expect(data.getCell('A1').font.bold).toBe(true);
      expect(data.views[0]).toMatchObject({ state: 'frozen', ySplit: 1 });
      expect(data.getCell('A1').note).toBe('Digits only.');
      expect(data.getCell('C1').note).toBe('YYYY-MM.');
      // A column the guide does not describe carries no note.
      expect(data.getCell('D1').note).toBeUndefined();
    });

    it('formats code and date columns as text, so a typed value stays as typed', async () => {
      const data = (await opened(spec('en'))).getWorksheet('Data')!;
      expect(data.getColumn(1).numFmt).toBe('@');
      expect(data.getColumn(3).numFmt).toBe('@');
      expect(data.getColumn(2).numFmt).toBeUndefined();
      expect(data.getColumn(1).width).toBe(14);
      expect(data.getColumn(4).width).toBe(12);
    });

    it('offers a dropdown for a column with fixed values, as far as the fill rows reach', async () => {
      const data = (await opened(spec('id'))).getWorksheet('Data')!;
      expect(data.getCell('D2').dataValidation).toMatchObject({
        type: 'list', formulae: ['"on,off"'], allowBlank: true, showErrorMessage: true, errorStyle: 'stop',
        error: 'Pilih salah satu nilai di daftar.', errorTitle: 'Tidak ada di daftar',
      });
      expect(data.getCell('D11').dataValidation).toMatchObject({ type: 'list' });
      expect(data.getCell('D12').dataValidation).toBeUndefined();
      expect(data.getCell('C2').dataValidation).toBeUndefined();
    });

    it('leaves off a list longer than a spreadsheet allows inline, and an empty one', async () => {
      const long = Array.from({ length: 60 }, (_, i) => `RUNG_${i}`);
      const data = (await opened(spec('en', { lists: [{ column: 3, values: long }, { column: 2, values: [] }] })))
        .getWorksheet('Data')!;
      expect(data.getCell('D2').dataValidation).toBeUndefined();
      expect(data.getCell('C2').dataValidation).toBeUndefined();
    });

    it('needs nothing but a header: no rows, no widths, no lists', async () => {
      const data = (await opened(spec('en', { rows: undefined, widths: undefined, textColumns: undefined, lists: undefined })))
        .getWorksheet('Data')!;
      expect(values(data)).toEqual([HEADER]);
      expect(data.getColumn(2).width).toBe(12);
    });
  });

  it('reads back as the rows it was written with: the round trip an upload makes', async () => {
    const bytes = await writeWorkbook(spec('id'));
    await expect(readXlsx(bytes, { isHeader: () => false })).resolves.toEqual({
      sheet: 'Data', rows: [HEADER, ['00088213', 'Rina']],
    });
  });
});
