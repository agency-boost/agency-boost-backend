import { decodeUpload, decodeWindows1252, delimiterOf, parseCsv } from './production-csv';

const utf8 = (s: string) => new TextEncoder().encode(s);
const bytes = (...b: number[]) => Uint8Array.from(b);

/** P9-T3 AC-1, AC-3, AC-11 — form: encoding, delimiter, fields. */
describe('reading the bytes (ADR-0052)', () => {
  describe('the encoding', () => {
    it('reads UTF-8, and strips the byte-order mark the template is issued with', () => {
      const withMark = Uint8Array.from([0xef, 0xbb, 0xbf, ...utf8('Agent Code — x')]);
      expect(decodeUpload(withMark)).toEqual({ text: 'Agent Code — x', encoding: 'utf-8' });
    });

    it('reads Windows-1252 when the bytes are not UTF-8 — a spreadsheet’s plain “CSV” save', () => {
      // `0x97` is the em dash in Windows-1252, and a lone continuation byte in UTF-8.
      const ansi = Uint8Array.from([...utf8('APE (Rp M) '), 0x97, ...utf8(' YTD')]);
      expect(decodeUpload(ansi)).toEqual({ text: 'APE (Rp M) — YTD', encoding: 'windows-1252' });
    });

    it('maps Windows-1252’s own characters, not Latin-1’s controls', () => {
      // € ‚ ‘ ’ “ ” – — ™ — the bytes a spreadsheet writes for the punctuation people type.
      expect(decodeWindows1252(bytes(0x80, 0x82, 0x91, 0x92, 0x93, 0x94, 0x96, 0x97, 0x99)))
        .toBe('\u20ac\u201a\u2018\u2019\u201c\u201d\u2013\u2014\u2122');
      expect(decodeWindows1252(utf8('Rina Wijaya'))).toBe('Rina Wijaya');
      expect(decodeWindows1252(bytes(0xe9, 0x81))).toBe('\u00e9\u0081');
    });

    it('refuses an empty file', () => {
      expect(() => decodeUpload(bytes())).toThrow(expect.objectContaining({ code: 'UPLOAD_MALFORMED_CSV' }));
    });

    it('refuses a workbook, saying to save it as CSV', () => {
      expect(() => decodeUpload(bytes(0x50, 0x4b, 0x03, 0x04, 0x14)))
        .toThrow(expect.objectContaining({ code: 'UPLOAD_MALFORMED_CSV', message: expect.stringContaining('save it as CSV') }));
    });

    it('refuses anything with a NUL byte — no text file has one', () => {
      expect(() => decodeUpload(bytes(0x41, 0x00, 0x42)))
        .toThrow(expect.objectContaining({ code: 'UPLOAD_MALFORMED_CSV', message: expect.stringContaining('not a text file') }));
    });
  });

  describe('the delimiter, decided once from the header line', () => {
    it.each([
      ['Agent Code,Agent Name,APE', ','],
      ['Agent Code;Agent Name;APE', ';'],
      ['Agent Code\tAgent Name\tAPE', '\t'],
    ])('%j is %j', (line, expected) => {
      expect(delimiterOf(`${line}\nPRU-001,x,1`)).toBe(expected);
    });

    it('counts only outside quotes, and only the first line', () => {
      expect(delimiterOf('"a;b;c";"d"\nx,y,z,w,v')).toBe(';');
    });

    it('is a comma when the line has none of the three', () => {
      expect(delimiterOf('Agent Code')).toBe(',');
    });
  });

  describe('fields, RFC 4180 (AC-1)', () => {
    it('keeps a comma inside quotes in one field — the case the template’s own names produce', () => {
      expect(parseCsv('PRU-001,"Wijaya, Rina",1.5', ',')).toEqual([
        { line: 1, cells: ['PRU-001', 'Wijaya, Rina', '1.5'] },
      ]);
    });

    it('reads a doubled quote as one', () => {
      expect(parseCsv('"Pak ""Budi"""', ',')[0].cells).toEqual(['Pak "Budi"']);
    });

    it('reads a line break inside quotes as part of the field, and numbers the next record after it', () => {
      expect(parseCsv('a,"one\ntwo"\nb,c', ',')).toEqual([
        { line: 1, cells: ['a', 'one\ntwo'] },
        { line: 3, cells: ['b', 'c'] },
      ]);
    });

    it('reads \\n, \\r\\n and a bare \\r as one line break each', () => {
      expect(parseCsv('a\r\nb\rc\nd', ',').map((r) => [r.line, r.cells[0]])).toEqual([[1, 'a'], [2, 'b'], [3, 'c'], [4, 'd']]);
    });

    it('does not invent a record after a final line break', () => {
      expect(parseCsv('a,b\r\n', ',')).toHaveLength(1);
    });

    it('keeps a stray quote inside an unquoted field rather than refusing the file', () => {
      expect(parseCsv('5" screen,x', ',')[0].cells).toEqual(['5" screen', 'x']);
    });

    it('splits on the delimiter it is given and no other', () => {
      expect(parseCsv('a;1,5;b', ';')[0].cells).toEqual(['a', '1,5', 'b']);
    });

    it('refuses a quote that is never closed, naming the line it opened on (AC-3)', () => {
      expect(() => parseCsv('a,b\nc,"never\nclosed', ','))
        .toThrow(expect.objectContaining({ code: 'UPLOAD_MALFORMED_CSV', details: { line: 2 } }));
    });
  });
});
