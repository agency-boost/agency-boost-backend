import { Workbook } from 'exceljs';
import { strToU8, zipSync } from 'fflate';
import sharp from 'sharp';
import { DomainException } from '@/common/errors/domain.exception';
import { INTAKE } from '@/domain/constants';
import { checkRow } from './illustration-check';
import { columnLetter, docxText, gridText, kindOf, prepareUpload, readableOf, Unreadable } from './intake-files';

/**
 * **P19.15-T3 AC-1 — an upload's files, typed from their bytes and made readable** (ADR-0259 §2): Excel, CSV, PDF,
 * pictures, Word and ZIP; a ZIP inside a ZIP refused; what Claude does not read natively converted with no new dependency.
 */

const pdf = Buffer.from('%PDF-1.4\n1 0 obj<<>>endobj\n%%EOF');
const docx = (body: string) => Buffer.from(zipSync({
  '[Content_Types].xml': strToU8('<Types/>'),
  'word/document.xml': strToU8(`<w:document><w:body>${body}</w:body></w:document>`),
}));
const upload = (originalname: string, buffer: Buffer, mimetype = '') => ({ originalname, buffer, mimetype, size: buffer.length });

async function workbook(): Promise<Buffer> {
  const wb = new Workbook();
  const sheet = wb.addWorksheet('Tarif');
  sheet.addRow(['Usia', 'L', 'P']);
  sheet.addRow([30, 1.25, 1.1]);
  sheet.mergeCells('A4:C4');
  sheet.getCell('A4').value = 'Catatan';
  return Buffer.from(await wb.xlsx.writeBuffer());
}

describe('P19.15-T3 AC-1 the kinds read, from the bytes (intake-files.ts)', () => {
  it('tells a workbook, a Word file and a ZIP apart by their own directory, and the rest by signature', async () => {
    expect(kindOf('x.xlsx', '', await workbook())).toBe('xlsx');
    expect(kindOf('x.docx', '', docx('<w:p><w:r><w:t>hai</w:t></w:r></w:p>'))).toBe('docx');
    expect(kindOf('x.zip', '', Buffer.from(zipSync({ 'a.pdf': pdf })))).toBe('zip');
    expect(kindOf('x.pdf', '', pdf)).toBe('pdf');
    expect(kindOf('foto.jpg', '', Buffer.from([0xff, 0xd8, 0xff, 0xe0]))).toBe('image');
    expect(kindOf('tarif.csv', '', Buffer.from('Usia;L\n30;1,25'))).toBe('csv');
    // A renamed executable is not what its name says; a CSV is only ever one by name or claim.
    expect(kindOf('tarif.pdf', '', Buffer.from('MZ\0\0'))).toBeNull();
    expect(kindOf('notes.bin', '', Buffer.from('Usia;L'))).toBeNull();
  });

  it('unpacks a ZIP into its files, skipping folders and hidden files, and refuses a ZIP inside it', () => {
    const zip = Buffer.from(zipSync({ 'tarif.pdf': pdf, '__MACOSX/._tarif.pdf': strToU8('x'), 'folder/': new Uint8Array() }));
    const files = prepareUpload([upload('kiriman.zip', zip)]);
    expect(files.map((f) => [f.name, f.kind, f.fromZip])).toEqual([['kiriman.zip › tarif.pdf', 'pdf', 'kiriman.zip']]);

    const nested = Buffer.from(zipSync({ 'inner.zip': zipSync({ 'a.pdf': pdf }) }));
    expect(() => prepareUpload([upload('luar.zip', nested)])).toThrow(DomainException);
    try { prepareUpload([upload('luar.zip', nested)]); } catch (e) {
      expect((e as DomainException).getResponse()).toMatchObject({ code: 'ASSET_TYPE_NOT_ALLOWED', details: { name: 'luar.zip › inner.zip' } });
    }
  });

  it('refuses no file, too many files, and a file of a kind not read, naming it', () => {
    const code = (fn: () => unknown) => { try { fn(); } catch (e) { return ((e as DomainException).getResponse() as { code: string }).code; } return null; };
    expect(code(() => prepareUpload([]))).toBe('VALIDATION_FAILED');
    expect(code(() => prepareUpload(Array.from({ length: INTAKE.FILES_MAX + 1 }, (_, i) => upload(`${i}.pdf`, pdf))))).toBe('VALIDATION_FAILED');
    expect(code(() => prepareUpload([upload('virus.exe', Buffer.from('MZ\0\0'))]))).toBe('ASSET_TYPE_NOT_ALLOWED');
  });
});

describe('P19.15-T3 AC-1 what Claude does not read natively is converted here', () => {
  it('reads a workbook as a grid with each cell’s sheet and address, a merged cell once', async () => {
    const [file] = prepareUpload([upload('tarif.xlsx', await workbook())]);
    const readable = await readableOf(file);
    expect(readable.part).toMatchObject({ kind: 'text', format: 'grid' });
    expect((readable.part as { text: string }).text).toBe('### Sheet "Tarif"\n1 | A=Usia | B=L | C=P\n2 | A=30 | B=1.25 | C=1.1\n4 | A=Catatan');
    expect(readable.grid?.[0].rows[1].cells).toEqual([{ col: 'A', text: '30' }, { col: 'B', text: '1.25' }, { col: 'C', text: '1.1' }]);
  });

  it('reads a CSV the way the Data upload does, and a Word file’s paragraphs and table cells without XML', async () => {
    const [csv] = prepareUpload([upload('tarif.csv', Buffer.from('Usia;L\n30;"1,25"\n'))]);
    expect((await readableOf(csv)).grid?.[0].rows).toEqual([
      { row: 1, cells: [{ col: 'A', text: 'Usia' }, { col: 'B', text: 'L' }] },
      { row: 2, cells: [{ col: 'A', text: '30' }, { col: 'B', text: '1,25' }] },
    ]);
    const text = docxText(docx('<w:p><w:r><w:t>Premi naik 5% &amp; berlaku 1 Des</w:t></w:r></w:p><w:tbl><w:tr><w:tc><w:p><w:r><w:t>Usia</w:t></w:r></w:p></w:tc><w:tc><w:p><w:r><w:t>47</w:t></w:r></w:p></w:tc></w:tr></w:tbl>'));
    expect(text).toContain('Premi naik 5% & berlaku 1 Des');
    expect(text).toContain('Usia\n | 47');
  });

  it('sends a PDF as itself and scales a photo down to the long edge Claude reads in full, never up', async () => {
    const [p] = prepareUpload([upload('tarif.pdf', pdf)]);
    expect((await readableOf(p)).part).toEqual({ kind: 'pdf', name: 'tarif.pdf', base64: pdf.toString('base64') });
    const big = await sharp({ create: { width: 4000, height: 3000, channels: 3, background: '#ffffff' } }).jpeg().toBuffer();
    const [photo] = prepareUpload([upload('foto.jpg', big)]);
    const part = (await readableOf(photo)).part as { base64: string; mediaType: string };
    const meta = await sharp(Buffer.from(part.base64, 'base64')).metadata();
    expect([meta.width, meta.height, part.mediaType]).toEqual([2576, 1932, 'image/jpeg']);
  });

  it('refuses rather than send part of a file past the text bound', async () => {
    const rows = Array.from({ length: INTAKE.CELLS_MAX + 1 }, (_, i) => `${i}`).join('\n');
    const [csv] = prepareUpload([upload('besar.csv', Buffer.from(rows))]);
    await expect(readableOf(csv)).rejects.toEqual(new Unreadable('too_long'));
    expect(gridText([{ name: 's', rows: [{ row: 1, cells: [{ col: 'A', text: 'x' }] }] }])).toBe('### Sheet "s"\n1 | A=x');
  });

  it('names columns as a spreadsheet does', () => {
    expect([1, 26, 27, 52, 703].map(columnLetter)).toEqual(['A', 'Z', 'AA', 'AZ', 'AAA']);
  });
});

describe('P19.15-T2 AC-2 a formula is checked against two printed numbers (illustration-check.ts)', () => {
  const evidence = [
    { page: 3, printedMinor: 50_000_000_000, inputs: { up: 50_000_000_000 } },
    { page: 4, printedMinor: 100_000_000_000, inputs: { up: 100_000_000_000 } },
  ];

  it('matches when both evaluate to the printed amounts within Rp1', () => {
    expect(checkRow('100% × up', evidence, ['up'])).toMatchObject({ state: 'match', reason: null });
    expect(checkRow('100% × up', evidence, ['up'])?.samples.map((s) => s.computedMinor)).toEqual([50_000_000_000, 100_000_000_000]);
  });

  it('flags a formula that does not match, never correcting it', () => {
    expect(checkRow('2 × up', evidence, ['up'])).toMatchObject({ state: 'mismatch', reason: 'differs' });
  });

  it('flags a formula naming an input the product has not, or unreadable; is unchecked with fewer than two numbers', () => {
    expect(checkRow('5% × target_dana', evidence, ['up'])).toMatchObject({ state: 'mismatch', reason: 'name' });
    expect(checkRow('up **', evidence, ['up'])).toMatchObject({ state: 'mismatch', reason: 'grammar' });
    expect(checkRow('100% × up', evidence.slice(0, 1), ['up'])).toMatchObject({ state: 'unchecked', reason: 'few_samples' });
    expect(checkRow(null, evidence, ['up'])).toBeNull();
  });
});
