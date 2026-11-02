import { Workbook } from 'exceljs';
import { strToU8, unzipSync, zipSync } from 'fflate';
import { SPREADSHEET } from '@/domain/constants';
import { cellText, plainNumber, readXlsx } from './read-xlsx';

/** A workbook made here, as its bytes. */
async function book(build: (workbook: Workbook) => void): Promise<Uint8Array> {
  const workbook = new Workbook();
  build(workbook);
  return new Uint8Array(await workbook.xlsx.writeBuffer());
}

const HEADER = ['code', 'name', 'joined'];
const isHeader = (cells: readonly string[]) => cells.join(',') === HEADER.join(',');

describe('reading a workbook (ADR-0184)', () => {
  describe('which sheet', () => {
    it('reads the sheet called Data, whatever comes before it', async () => {
      const bytes = await book((wb) => {
        wb.addWorksheet('Petunjuk').addRow(['How to fill it in']);
        const data = wb.addWorksheet('Data');
        data.addRow(HEADER);
        data.addRow(['88001', 'Agus', '2012-03']);
      });
      await expect(readXlsx(bytes, { isHeader })).resolves.toEqual({
        sheet: 'Data',
        rows: [HEADER, ['88001', 'Agus', '2012-03']],
      });
    });

    it('finds Data in any case, with spaces round it', async () => {
      const bytes = await book((wb) => {
        wb.addWorksheet('Guide').addRow(['x']);
        wb.addWorksheet(' DATA ').addRow(HEADER);
      });
      expect((await readXlsx(bytes, { isHeader })).sheet).toBe(' DATA ');
    });

    it('with no Data sheet, reads the first sheet that starts with the header — a renamed tab', async () => {
      const bytes = await book((wb) => {
        wb.addWorksheet('Notes').addRow(['my notes']);
        const mine = wb.addWorksheet('Sheet2');
        mine.addRow([]);
        mine.addRow(HEADER);
      });
      expect((await readXlsx(bytes, { isHeader })).sheet).toBe('Sheet2');
    });

    it('judges a sheet by its first row alone, and a value far to its right does not make it the header', async () => {
      const bytes = await book((wb) => {
        const notes = wb.addWorksheet('Notes');
        notes.addRow(['code', null, 'joined']).getCell(SPREADSHEET.MAX_COLUMNS + 1).value = 'far';
        notes.addRow(HEADER);
        const mine = wb.addWorksheet('Mine');
        mine.addRow(HEADER);
        mine.addRow(['88001', 'Agus', '2012-03']);
      });
      expect((await readXlsx(bytes, { isHeader })).sheet).toBe('Mine');
    });

    it('with one sheet, reads it whatever it is called — its columns are the import’s to judge', async () => {
      const bytes = await book((wb) => { wb.addWorksheet('Sheet1').addRow(['Agent', 'Name']); });
      await expect(readXlsx(bytes, { isHeader })).resolves.toEqual({ sheet: 'Sheet1', rows: [['Agent', 'Name']] });
    });

    it('refuses a workbook of several sheets, none called Data and none with the header — the wrong sheet', async () => {
      const bytes = await book((wb) => {
        wb.addWorksheet('Sheet1').addRow(['Agent', 'Name']);
        wb.addWorksheet('Sheet2');
      });
      await expect(readXlsx(bytes, { isHeader })).rejects.toMatchObject({
        code: 'UPLOAD_MALFORMED_CSV',
        status: 422,
        details: { sheet: SPREADSHEET.DATA_SHEET },
        message: 'The workbook has no sheet called “Data”, and none of its sheets starts with the template’s header. '
          + 'Fill in the template’s Data sheet and upload that.',
      });
    });
  });

  describe('the rows', () => {
    it('numbers each row as the sheet does: a blank row stays, empty, so the next keeps its number', async () => {
      const bytes = await book((wb) => {
        const data = wb.addWorksheet('Data');
        data.getCell('A1').value = 'code';
        data.getCell('A4').value = '88001';
        data.getCell('C4').value = 'x';
      });
      expect((await readXlsx(bytes, { isHeader })).rows).toEqual([['code'], [], [], ['88001', '', 'x']]);
    });

    it('reads an empty Data sheet as no rows', async () => {
      const bytes = await book((wb) => { wb.addWorksheet('Data'); });
      expect((await readXlsx(bytes, { isHeader })).rows).toEqual([]);
    });

    it(`refuses a sheet past ${SPREADSHEET.MAX_ROWS} rows, 413`, async () => {
      const bytes = await book((wb) => {
        const data = wb.addWorksheet('Data');
        data.getCell('A1').value = 'code';
        data.getCell(`A${SPREADSHEET.MAX_ROWS + 1}`).value = 'one too many';
      });
      await expect(readXlsx(bytes, { isHeader })).rejects.toMatchObject({
        code: 'ASSET_TOO_LARGE',
        status: 413,
        details: { maxRows: SPREADSHEET.MAX_ROWS },
        message: 'The sheet has more than 10000 rows. The template has one row per person — check this is the right file.',
      });
    });

    it(`reads row ${SPREADSHEET.MAX_ROWS}, the last allowed`, async () => {
      const bytes = await book((wb) => { wb.addWorksheet('Data').getCell(`A${SPREADSHEET.MAX_ROWS}`).value = 'last'; });
      const { rows } = await readXlsx(bytes, { isHeader });
      expect(rows).toHaveLength(SPREADSHEET.MAX_ROWS);
      expect(rows[SPREADSHEET.MAX_ROWS - 1]).toEqual(['last']);
    });

    it(`refuses a value past column ${SPREADSHEET.MAX_COLUMNS} — a row is as wide as its last value`, async () => {
      const bytes = await book((wb) => { wb.addWorksheet('Data').getRow(2).getCell(SPREADSHEET.MAX_COLUMNS + 1).value = 'far'; });
      await expect(readXlsx(bytes, { isHeader })).rejects.toMatchObject({
        code: 'ASSET_TOO_LARGE', details: { maxColumns: SPREADSHEET.MAX_COLUMNS },
      });
    });
  });

  describe('each cell, as the text a CSV of the sheet would hold', () => {
    it('keeps a code’s leading zeros in a text cell, and reads a number without them', async () => {
      const bytes = await book((wb) => {
        const data = wb.addWorksheet('Data');
        data.getColumn(1).numFmt = '@';
        data.addRow(['00088213', 88213]);
      });
      expect((await readXlsx(bytes, { isHeader })).rows).toEqual([['00088213', '88213']]);
    });

    it('writes a date YYYY-MM-DD, and YYYY-MM in a month column', async () => {
      const bytes = await book((wb) => {
        wb.addWorksheet('Data').addRow([new Date(Date.UTC(1990, 2, 15)), new Date(Date.UTC(2021, 6, 1)), '2021-07']);
      });
      expect((await readXlsx(bytes, { isHeader, monthColumns: [1] })).rows).toEqual([['1990-03-15', '2021-07', '2021-07']]);
    });

    it('reads what each kind of cell shows', async () => {
      const bytes = await book((wb) => {
        const data = wb.addWorksheet('Data');
        data.addRow([
          { richText: [{ text: 'Rina ', font: { bold: true } }, { text: 'Wijaya' }] },
          { text: 'rina@k.test', hyperlink: 'mailto:rina@k.test' },
          { formula: 'A9+1', result: 0.1 + 0.2 },
          { formula: 'A9/0', result: { error: '#DIV/0!' } },
          true,
          false,
          1.5,
        ]);
        data.getCell('H1').value = 0.85;
        data.getCell('H1').numFmt = '0%';
      });
      expect((await readXlsx(bytes, { isHeader })).rows).toEqual([
        ['Rina Wijaya', 'rina@k.test', '0.3', '#DIV/0!', 'TRUE', 'FALSE', '1.5', '85%'],
      ]);
    });

    it('writes nothing for an empty cell, and for a date that is no date', () => {
      expect(cellText({ value: null, numFmt: '' }, false)).toBe('');
      expect(cellText({ value: undefined as never, numFmt: '' }, false)).toBe('');
      expect(cellText({ value: new Date(Number.NaN), numFmt: '' }, false)).toBe('');
      expect(cellText({ value: { formula: 'X1' }, numFmt: '' }, false)).toBe('');
      expect(cellText({ value: {} as never, numFmt: '' }, false)).toBe('');
    });

    it('writes a number as a person types it: no binary tail, no exponent', () => {
      expect(plainNumber(0.1 + 0.2)).toBe('0.3');
      expect(plainNumber(1.5)).toBe('1.5');
      expect(plainNumber(-12)).toBe('-12');
      expect(plainNumber(1e-7)).toBe('0.0000001');
      expect(plainNumber(-2.5e-7)).toBe('-0.00000025');
      expect(plainNumber(1e21)).toBe('1000000000000000000000');
      expect(plainNumber(Number.POSITIVE_INFINITY)).toBe('Infinity');
    });
  });

  describe('what is not a workbook', () => {
    it('refuses bytes that are not a ZIP at all — a non-ZIP file', async () => {
      await expect(readXlsx(strToU8('code,name\n88001,Agus\n'), { isHeader }))
        .rejects.toMatchObject({ code: 'UPLOAD_MALFORMED_CSV' });
    });

    it('refuses a ZIP that holds no workbook', async () => {
      await expect(readXlsx(zipSync({ 'notes.txt': strToU8('hello') }), { isHeader }))
        .rejects.toMatchObject({ code: 'UPLOAD_MALFORMED_CSV' });
    });

    it('refuses a workbook whose sheet says it is smaller than it is: cut at its word, it no longer parses', async () => {
      const bytes = await book((wb) => {
        const data = wb.addWorksheet('Data');
        for (let i = 0; i < 200; i += 1) data.addRow([`row ${i}`, 'x'.repeat(50)]);
      });
      const parts = unzipSync(bytes);
      const name = Object.keys(parts).find((n) => n.startsWith('xl/worksheets/sheet'))!;
      // Repacked with the sheet's directory entry claiming a tenth of its size, as a hostile archive would.
      const repacked = zipSync(parts, { level: 6 });
      const view = new DataView(repacked.buffer, repacked.byteOffset, repacked.byteLength);
      let end = repacked.length - 22;
      while (view.getUint32(end, true) !== 0x06054b50) end -= 1;
      let entry = view.getUint32(end + 16, true);
      for (;;) {
        const nameLength = view.getUint16(entry + 28, true);
        const entryName = new TextDecoder().decode(repacked.subarray(entry + 46, entry + 46 + nameLength));
        if (entryName === name) break;
        entry += 46 + nameLength + view.getUint16(entry + 30, true) + view.getUint16(entry + 32, true);
      }
      view.setUint32(entry + 24, Math.floor(parts[name].length / 10), true);
      await expect(readXlsx(repacked, { isHeader })).rejects.toMatchObject({ code: 'UPLOAD_MALFORMED_CSV' });
    });

    it('refuses a zip bomb before opening it', async () => {
      const zip = zipSync({ 'xl/worksheets/sheet1.xml': new Uint8Array(30 * 1024 * 1024) }, { level: 9 });
      await expect(readXlsx(zip, { isHeader })).rejects.toMatchObject({ code: 'ASSET_TOO_LARGE', status: 413 });
    });
  });
});
