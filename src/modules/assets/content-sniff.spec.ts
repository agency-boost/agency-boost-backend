import { ASSET_LIMITS } from '@/domain/constants';
import { OCTET_STREAM, SNIFF_SAMPLE_BYTES, SNIFFED_TYPES, sniffedContentType } from './content-sniff';

const XLSX = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
const bytes = (...values: number[]) => Buffer.from(values);
const text = (value: string) => Buffer.from(value, 'latin1');

/** What each accepted type's first bytes look like, as a real file of that type opens. */
const SAMPLES: Record<string, Buffer> = {
  'image/jpeg': bytes(0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46),
  'image/png': bytes(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d),
  'image/webp': Buffer.concat([text('RIFF'), bytes(0x24, 0x00, 0x00, 0x00), text('WEBPVP8 ')]),
  'application/pdf': text('%PDF-1.4\n%\xe2\xe3\xcf\xd3\n'),
  'video/mp4': Buffer.concat([bytes(0x00, 0x00, 0x00, 0x20), text('ftypisom'), bytes(0x00, 0x00, 0x02, 0x00)]),
  'text/csv': text('nama,kode_agen,ape\nRina,AG-0417-01,18000000\n'),
  [XLSX]: Buffer.concat([bytes(0x50, 0x4b, 0x03, 0x04, 0x14, 0x00, 0x06, 0x00), text('[Content_Types].xml')]),
};
/** Every type bytes alone identify: all of them but CSV, which only a claim can name. */
const BINARY = Object.keys(SAMPLES).filter((t) => t !== 'text/csv');

/** A Windows executable's first bytes — the file a renamed `.pdf` is in the live suite's case. */
const EXE = Buffer.concat([text('MZ'), bytes(0x90, 0x00, 0x03, 0x00, 0x00, 0x00, 0x04, 0x00)]);

describe('P18.7-T2 content sniffing — the accepted type a file’s first bytes are (ADR-0040, ADR-0153, review L6)', () => {
  it('P18.7-T2 holds a signature for exactly ALLOWED_MIME_TYPES: no accepted type unchecked, none checked that is not accepted', () => {
    expect([...SNIFFED_TYPES].sort()).toEqual([...ASSET_LIMITS.ALLOWED_MIME_TYPES].sort());
    expect(new Set(SNIFFED_TYPES).size).toBe(SNIFFED_TYPES.length);
    expect(Object.keys(SAMPLES).sort()).toEqual([...ASSET_LIMITS.ALLOWED_MIME_TYPES].sort());
  });

  it('P18.7-T2 reads a 4 KB sample — enough for every signature, never the whole file', () => {
    expect(SNIFF_SAMPLE_BYTES).toBe(4096);
  });

  it.each(Object.entries(SAMPLES))('P18.7-T2 confirms %s claimed as itself', (mimeType, sample) => {
    expect(sniffedContentType(mimeType, sample)).toBe(mimeType);
  });

  describe('L6: the bytes win over the claim, and the route’s list decides', () => {
    it('P18.7-T2 a PNG or a WebP saved as .jpg is reported as what it is', () => {
      expect(sniffedContentType('image/jpeg', SAMPLES['image/png'])).toBe('image/png');
      expect(sniffedContentType('image/jpeg', SAMPLES['image/webp'])).toBe('image/webp');
      expect(sniffedContentType('image/png', SAMPLES['image/jpeg'])).toBe('image/jpeg');
    });

    it('P18.7-T2 a JPEG claimed as a PDF is reported as a JPEG — which a PDF-only route then refuses', () => {
      expect(sniffedContentType('application/pdf', SAMPLES['image/jpeg'])).toBe('image/jpeg');
    });

    it.each(BINARY.flatMap((type) => [...ASSET_LIMITS.ALLOWED_MIME_TYPES, '', 'application/x-unknown']
      .filter((claim) => claim !== type).map((claim) => [type, claim])))(
      'P18.7-T2 identifies %s from its bytes under the claim %j',
      (type, claim) => {
        expect(sniffedContentType(claim, SAMPLES[type])).toBe(type);
      },
    );

    it('P18.7-T2 a file claimed as CSV whose bytes are a binary type is that type', () => {
      expect(sniffedContentType('text/csv', SAMPLES['image/png'])).toBe('image/png');
      expect(sniffedContentType('text/csv', SAMPLES[XLSX])).toBe(XLSX);
    });

    it('P18.7-T2 never detects a CSV under another claim: text has no signature, only the claim names it', () => {
      for (const claim of ['application/pdf', 'image/jpeg', XLSX, 'text/plain', '']) {
        expect(sniffedContentType(claim, SAMPLES['text/csv'])).toBe(OCTET_STREAM);
      }
    });
  });

  it.each([...ASSET_LIMITS.ALLOWED_MIME_TYPES, 'application/x-msdownload', ''].map((t) => [t]))(
    'P18.7-T2 refuses an executable claimed as %j: octet-stream, which every allow-list refuses at confirm',
    (claim) => {
      expect(sniffedContentType(claim, EXE)).toBe(OCTET_STREAM);
      expect(ASSET_LIMITS.ALLOWED_MIME_TYPES).not.toContain(OCTET_STREAM);
    },
  );

  it.each(ASSET_LIMITS.ALLOWED_MIME_TYPES.map((t) => [t]))('P18.7-T2 refuses an empty sample claimed as %s', (claim) => {
    expect(sniffedContentType(claim, Buffer.alloc(0))).toBe(OCTET_STREAM);
  });

  it('P18.7-T2 refuses bytes that are no accepted type, whatever the claim', () => {
    expect(sniffedContentType('text/html', text('<html></html>'))).toBe(OCTET_STREAM);
    expect(sniffedContentType('image/jpeg', text('GIF89a'))).toBe(OCTET_STREAM);
    expect(sniffedContentType('constructor', text('plain words'))).toBe(OCTET_STREAM);
  });

  describe('the order the signatures are tried', () => {
    it('P18.7-T2 an anchored signature beats the text %PDF- further in', () => {
      const zip = Buffer.concat([bytes(0x50, 0x4b, 0x03, 0x04, 0x14, 0x00), text('notes/%PDF-1.4.txt')]);
      expect(sniffedContentType('application/pdf', zip)).toBe(XLSX);
      const jpeg = Buffer.concat([SAMPLES['image/jpeg'], text('Exif comment: %PDF-')]);
      expect(sniffedContentType('application/pdf', jpeg)).toBe('image/jpeg');
    });

    it('P18.7-T2 a text file claimed as CSV with %PDF- in its first 1024 bytes reads as a PDF — the bytes win, and the route decides', () => {
      expect(sniffedContentType('text/csv', text('nama,catatan\nRina,%PDF-1.4 attached\n'))).toBe('application/pdf');
    });
  });

  describe('each signature’s edges', () => {
    it('P18.7-T2 a PDF header anywhere in the first 1024 bytes, and not after', () => {
      expect(sniffedContentType('application/pdf', Buffer.concat([Buffer.alloc(1019, 0x20), text('%PDF-')]))).toBe('application/pdf');
      expect(sniffedContentType('application/pdf', Buffer.concat([Buffer.alloc(1020, 0x20), text('%PDF-1.7')]))).toBe(OCTET_STREAM);
      expect(sniffedContentType('application/pdf', text('%PDF'))).toBe(OCTET_STREAM);
    });

    it('P18.7-T2 a WebP needs both RIFF and WEBP — a WAV is RIFF too', () => {
      expect(sniffedContentType('image/webp', Buffer.concat([text('RIFF'), bytes(0, 0, 0, 0), text('WAVE')]))).toBe(OCTET_STREAM);
      expect(sniffedContentType('image/webp', text('RIFF'))).toBe(OCTET_STREAM);
    });

    it('P18.7-T2 an MP4’s ftyp at offset 4 exactly', () => {
      expect(sniffedContentType('video/mp4', text('ftypisom'))).toBe(OCTET_STREAM);
      expect(sniffedContentType('video/mp4', bytes(0, 0, 0))).toBe(OCTET_STREAM);
    });

    it('P18.7-T2 a JPEG and a PNG truncated before their signature ends are not either', () => {
      expect(sniffedContentType('image/jpeg', bytes(0xff, 0xd8))).toBe(OCTET_STREAM);
      expect(sniffedContentType('image/png', bytes(0x89, 0x50, 0x4e, 0x47))).toBe(OCTET_STREAM);
    });

    it('P18.7-T2 a CSV with a NUL byte anywhere in the sample is binary, not text', () => {
      expect(sniffedContentType('text/csv', Buffer.concat([text('a,b\n'), bytes(0x00), text('c,d\n')]))).toBe(OCTET_STREAM);
      // UTF-8 names, as an office's roster carries them, are still text.
      expect(sniffedContentType('text/csv', Buffer.from('nama\nSiti Nurhaliza — Café\n', 'utf8'))).toBe('text/csv');
    });

    it('P18.7-T2 any zip passes as a spreadsheet at this layer — the documented limit', () => {
      const docx = Buffer.concat([bytes(0x50, 0x4b, 0x03, 0x04, 0x14, 0x00), text('word/document.xml')]);
      expect(sniffedContentType(XLSX, docx)).toBe(XLSX);
      expect(sniffedContentType(XLSX, bytes(0x50, 0x4b, 0x05, 0x06))).toBe(OCTET_STREAM);
    });
  });
});
