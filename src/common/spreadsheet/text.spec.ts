import type { DomainException } from '@/common/errors/domain.exception';
import { readerIn } from '@/common/i18n/reader';
import { decodeText, decodeWindows1252 } from './text';

const utf8 = (s: string) => new TextEncoder().encode(s);

/**
 * A CSV's bytes as text (ADR-0052), shared by the Data upload and the roster's file since ADR-0184. The Data upload's
 * own spec reads the same rules through `decodeUpload`.
 */
describe('a CSV’s bytes as text', () => {
  it('reads UTF-8, dropping a byte-order mark', () => {
    expect(decodeText(Uint8Array.from([0xef, 0xbb, 0xbf, ...utf8('Agus — 88001')]))).toEqual({ text: 'Agus — 88001', encoding: 'utf-8' });
    expect(decodeText(utf8('Rina'))).toEqual({ text: 'Rina', encoding: 'utf-8' });
  });

  it('reads Windows-1252 when the bytes are not UTF-8 — a spreadsheet’s plain “CSV” save', () => {
    expect(decodeText(Uint8Array.from([...utf8('Puspita '), 0x96, ...utf8(' Sari')])))
      .toEqual({ text: 'Puspita – Sari', encoding: 'windows-1252' });
    expect(decodeWindows1252(Uint8Array.from([0x80, 0x81]))).toBe('€\u0081');
  });

  it('reads no bytes as no text: whether an empty file is a refusal is the caller’s to say', () => {
    expect(decodeText(new Uint8Array(0))).toEqual({ text: '', encoding: 'utf-8' });
  });

  it('refuses a NUL byte, which no text file has, saying a workbook or a CSV will do — in both languages', () => {
    const binary = Uint8Array.from([0x25, 0x50, 0x44, 0x46, 0x00]);
    expect(() => decodeText(binary)).toThrow(expect.objectContaining({
      code: 'UPLOAD_MALFORMED_CSV',
      status: 422,
      message: 'This is neither a text file nor an Excel workbook. Upload the filled template as .xlsx or .csv.',
    }));
    try {
      decodeText(binary);
    } catch (err) {
      expect((err as DomainException).messageFor(readerIn('id')))
        .toBe('Ini bukan file teks maupun workbook Excel. Unggah template yang sudah diisi sebagai .xlsx atau .csv.');
    }
  });
});
