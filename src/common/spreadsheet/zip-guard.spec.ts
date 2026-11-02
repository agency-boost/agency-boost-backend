import { strToU8, unzipSync, zipSync } from 'fflate';
import type { DomainException } from '@/common/errors/domain.exception';
import { readerIn } from '@/common/i18n/reader';
import { SPREADSHEET } from '@/domain/constants';
import { checkZip, listZip, looksLikeZip, unpackWithinLimits } from './zip-guard';

/** What a refusal says to an Indonesian reader. */
const inIndonesian = (fn: () => unknown): string => {
  try {
    fn();
  } catch (err) {
    return (err as DomainException).messageFor(readerIn('id'));
  }
  throw new Error('nothing was refused');
};

/**
 * **A zip bomb, made here**: 30 MiB of zeros, deflated as hard as it goes, which is about thirty kilobytes on the wire —
 * a thousand to one, and past `SPREADSHEET.MAX_UNCOMPRESSED_BYTES` once unpacked.
 */
const bomb = () => zipSync({ 'xl/worksheets/sheet1.xml': new Uint8Array(30 * 1024 * 1024) }, { level: 9 });

/** The offset of the archive's end-of-central-directory record, and from it the directory's. */
function directoryOf(zip: Uint8Array): { view: DataView; directory: number } {
  const view = new DataView(zip.buffer, zip.byteOffset, zip.byteLength);
  let end = zip.length - 22;
  while (view.getUint32(end, true) !== 0x06054b50) end -= 1;
  return { view, directory: view.getUint32(end + 16, true) };
}

/**
 * **A bomb that lies**: the directory and the local header both say its one part unpacks to `declared` bytes, and its
 * stream unpacks to what `bytes` was. The declared check passes it; what matters is what reading it then does.
 */
function lying(bytes: Uint8Array, declared: number): Uint8Array {
  const zip = zipSync({ 'xl/worksheets/sheet1.xml': bytes }, { level: 9 });
  const { view, directory } = directoryOf(zip);
  view.setUint32(directory + 24, declared, true); // the central directory's uncompressed size
  view.setUint32(22, declared, true); // the local header's
  return zip;
}

describe('the ZIP guard (ADR-0184)', () => {
  describe('telling a ZIP from text', () => {
    it('knows a ZIP by its first local header, PK 03 04', () => {
      expect(looksLikeZip(zipSync({ 'a.txt': strToU8('a') }))).toBe(true);
      expect(looksLikeZip(strToU8('Agent Code,Agent Name'))).toBe(false);
      expect(looksLikeZip(Uint8Array.from([0x50, 0x4b]))).toBe(false);
      expect(looksLikeZip(new Uint8Array(0))).toBe(false);
    });
  });

  describe('the declared sizes, read before anything is inflated', () => {
    it('lists each part with what it says it unpacks to, inflating nothing', () => {
      const parts = listZip(bomb());
      expect(parts).toEqual([
        { name: 'xl/worksheets/sheet1.xml', compressedSize: expect.any(Number), size: 30 * 1024 * 1024 },
      ]);
      // A thousand to one: the reason a byte ceiling on the upload says nothing about what is inside it.
      expect(parts[0].compressedSize).toBeLessThan(64 * 1024);
    });

    it('refuses a zip bomb before inflating it, with ASSET_TOO_LARGE naming the bound', () => {
      const zip = bomb();
      expect(zip.length).toBeLessThan(64 * 1024);
      expect(() => checkZip(zip)).toThrow(expect.objectContaining({
        code: 'ASSET_TOO_LARGE',
        details: { maxUncompressedBytes: SPREADSHEET.MAX_UNCOMPRESSED_BYTES },
        message: 'The workbook unpacks to more than 25 MB. A filled template is well under one — check this is the right file.',
      }));
      expect(inIndonesian(() => checkZip(zip)))
        .toBe('Workbook ini lebih dari 25 MB setelah dibuka. Template yang sudah diisi jauh di bawah 1 MB — periksa apakah ini file yang benar.');
    });

    it('refuses it from the directory alone: a bomb whose stream is garbage is refused for its size, not its stream', () => {
      // Had the guard inflated the part, the garbage would have been the refusal. It never reaches it.
      const zip = bomb();
      const { view } = directoryOf(zip);
      const dataStart = 30 + view.getUint16(26, true) + view.getUint16(28, true);
      zip.fill(0xff, dataStart, dataStart + 64);
      expect(() => checkZip(zip)).toThrow(expect.objectContaining({ code: 'ASSET_TOO_LARGE' }));
      expect(() => unpackWithinLimits(zip)).toThrow(expect.objectContaining({ code: 'ASSET_TOO_LARGE' }));
    });

    it('refuses more parts than a workbook has, as the directory is walked', () => {
      const many = Object.fromEntries(
        Array.from({ length: SPREADSHEET.MAX_ENTRIES + 1 }, (_, i) => [`part-${i}.xml`, strToU8('x')]),
      );
      expect(() => listZip(zipSync(many, { level: 0 }))).toThrow(expect.objectContaining({
        code: 'ASSET_TOO_LARGE',
        details: { maxEntries: SPREADSHEET.MAX_ENTRIES },
        message: 'The workbook holds more than 1000 parts. A filled template holds about a dozen — check this is the right file.',
      }));
    });

    it('lets through what a workbook is: a few parts, well under the bound', () => {
      const zip = zipSync({ 'a.xml': strToU8('<a/>'), 'b.xml': strToU8('<b/>') });
      expect(checkZip(zip).map((p) => [p.name, p.size])).toEqual([['a.xml', 4], ['b.xml', 4]]);
    });
  });

  describe('what is not a ZIP, or not a whole one', () => {
    it('answers bytes that start like a ZIP and are not one as not a workbook, 422', () => {
      const broken = Uint8Array.from([0x50, 0x4b, 0x03, 0x04, 0x00, 0x01]);
      expect(() => listZip(broken)).toThrow(expect.objectContaining({
        code: 'UPLOAD_MALFORMED_CSV',
        status: 422,
        message: 'This file looks like a workbook but cannot be opened as one. Save it again from the spreadsheet as Excel '
          + '(.xlsx) or as CSV, and upload that.',
      }));
      expect(inIndonesian(() => listZip(broken))).toBe(
        'File ini tampak seperti workbook tetapi tidak dapat dibuka. Simpan ulang dari spreadsheet sebagai Excel (.xlsx) '
          + 'atau CSV, lalu unggah file itu.',
      );
    });

    it('answers a text file the same way: it has no directory to read', () => {
      expect(() => listZip(strToU8('Agent Code,Agent Name\n'))).toThrow(expect.objectContaining({ code: 'UPLOAD_MALFORMED_CSV' }));
    });

    it('answers an archive whose part cannot be inflated as not a workbook', () => {
      const zip = zipSync({ 'a.xml': new Uint8Array(4096).fill(0x41) }, { level: 9 });
      const { view } = directoryOf(zip);
      const dataStart = 30 + view.getUint16(26, true) + view.getUint16(28, true);
      zip[dataStart] = 0xff; // a block type deflate does not have
      expect(() => unpackWithinLimits(zip)).toThrow(expect.objectContaining({ code: 'UPLOAD_MALFORMED_CSV' }));
    });
  });

  describe('unpacking within the limits', () => {
    it('hands on the same parts, stored, so nothing downstream inflates anything', () => {
      const zip = zipSync({ 'xl/a.xml': strToU8('<a>one</a>'), 'xl/b.xml': strToU8('<b>two</b>') }, { level: 9 });
      const repacked = unpackWithinLimits(zip);
      expect(unzipSync(repacked)).toEqual({ 'xl/a.xml': strToU8('<a>one</a>'), 'xl/b.xml': strToU8('<b>two</b>') });
      // Stored: each part occupies what it unpacks to.
      expect(listZip(repacked).every((p) => p.compressedSize === p.size)).toBe(true);
    });

    it('cuts a part that understates its size at what it declared — memory never grows past the check', () => {
      // A hundred megabytes of zeros that say they are a kilobyte. JSZip, which `exceljs` reads with, would inflate the
      // stream whole; here it stops at the kilobyte.
      const zip = lying(new Uint8Array(100 * 1024 * 1024), 1024);
      expect(checkZip(zip)[0].size).toBe(1024);
      const repacked = unpackWithinLimits(zip);
      expect(listZip(repacked)).toEqual([{ name: 'xl/worksheets/sheet1.xml', compressedSize: 1024, size: 1024 }]);
      expect(repacked.length).toBeLessThan(2048);
    });
  });
});
