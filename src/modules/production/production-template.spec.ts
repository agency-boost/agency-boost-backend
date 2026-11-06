import {
  csvField, csvName, headerOf, TEMPLATE_HEADER_V1, TEMPLATE_HEADER_V2, TEMPLATE_HEADERS, templateBody,
  templateFilename, templateHeader,
} from './production-template';
import { templateWorkbook } from './production-workbook';
import { Workbook } from 'exceljs';
import { readerIn } from '@/common/i18n/reader';
import { analyticsConfigV1, type AdvancedAnalyticsConfig, type UploadField } from '@/modules/config/analytics-config';
import { layoutOf, readFileUpload } from './production-preview';

/** Version 1 of a template, its columns starting Jan 2024. */
const V1 = (): AdvancedAnalyticsConfig => analyticsConfigV1({ effectiveFrom: '2024-01' });
/** Version 1 with a custom column `KOMISI` whose year to date is uploaded, from Dec 2026, required. */
const WITH_KOMISI = (): AdvancedAnalyticsConfig => {
  const config = V1();
  const komisi: UploadField = {
    kode: 'KOMISI', system: false, label: { id: 'Komisi tahun pertama', en: 'First-year commission' }, labelAliases: [],
    unit: 'rp_million', ytd: 'upload', min: 0, max: null, required: true, rows: 'all', effectiveFrom: '2026-12',
    tip: { id: 'Komisi dari laporan perusahaan.', en: 'Commission from the company report.' },
  };
  config.uploadFields.push(komisi);
  return config;
};
const HEADER_EN = templateHeader(V1(), 'en');

/**
 * P9-T2 AC-1, AC-2, AC-3, AC-5 — the file's contract, pinned to the prototype line it came from.
 */
describe('the template (P9-T2)', () => {
  describe('AC-1 — the header is the prototype’s, in the prototype’s order (KPM_Owner.html:4681-4690)', () => {
    it('opens with the code and the name', () => {
      expect(TEMPLATE_HEADER_V1.slice(0, 2)).toEqual(['Agent Code', 'Agent Name']);
    });

    it('carries the six metrics monthly first, then the same six as YTD — fourteen columns', () => {
      expect(TEMPLATE_HEADER_V1).toEqual([
        'Agent Code', 'Agent Name',
        'APE (Rp M) — This Month', 'Rolling Persistency (%) — This Month', 'Recruitment — This Month',
        'New Active Agents — This Month', 'FYP (Rp M) — This Month', '# of Policy — This Month',
        'APE (Rp M) — YTD', 'Rolling Persistency (%) — YTD', 'Recruitment — YTD',
        'New Active Agents — YTD', 'FYP (Rp M) — YTD', '# of Policy — YTD',
      ]);
    });

    it('separates a label from its cadence with the prototype’s em dash, U+2014 (:4687-4688)', () => {
      // Pinned by code point: an en dash or a hyphen looks the same in a review and is another header.
      const separators = TEMPLATE_HEADER_V1.slice(2).map((h) => h.replace(/ (This Month|YTD)$/, '').slice(-1));
      expect(separators.map((c) => c.codePointAt(0))).toEqual(Array(12).fill(0x2014));
    });

    it('keeps Rp M in the label — the file is for the person filling it in, the store is not', () => {
      expect(TEMPLATE_HEADER_V1.filter((h) => h.includes('Rp M'))).toHaveLength(4);
    });
  });

  describe('AC-3 — the headers issued before P19.5-T2 are kept, as aliases', () => {
    it('version 1 is exactly this header — still read, never edited', () => {
      expect(TEMPLATE_HEADERS[1]).toBe(TEMPLATE_HEADER_V1);
    });

    it('P19.3-T1 AC-6 version 2 was version 1’s fourteen columns, then Unit Persistency (%) — This Month (ADR-0201 §2)', () => {
      expect(TEMPLATE_HEADERS[2]).toBe(TEMPLATE_HEADER_V2);
      expect(TEMPLATE_HEADER_V2.slice(0, TEMPLATE_HEADER_V1.length)).toEqual([...TEMPLATE_HEADER_V1]);
      expect(TEMPLATE_HEADER_V2.slice(TEMPLATE_HEADER_V1.length)).toEqual(['Unit Persistency (%) — This Month']);
    });

    it('P19.5-T2 AC-2 each issued header still reads as its kode: version 1 and 2 files keep importing (ADR-0214 §5)', () => {
      const layout = layoutOf(TEMPLATE_HEADER_V2, V1(), '2026-09', readerIn('en'));
      expect(layout.columns.map((c) => `${c.field.kode}${c.ytd ? '_YTD' : ''}`)).toEqual([
        'APE', 'PERSISTENCY', 'RECRUITMENT', 'NEW_ACTIVE_AGENTS', 'FYP', 'POLICY_COUNT', 'UNIT_PERSISTENCY',
      ]);
      // The six YTD columns are calculated now (R4): read as no longer used, never stored.
      expect(layout.notes.filter((n) => n.code === 'column_retired')).toHaveLength(6);
    });
  });

  describe('P19.5-T2 AC-1 — the header is the KPM’s template’s (ADR-0214 §5)', () => {
    it('opens with Agent Code and Agent Name, then <label> (<unit>) [KODE] for each column, in its order', () => {
      expect(HEADER_EN).toEqual([
        'Agent Code', 'Agent Name', 'APE (Rp M) [APE]', 'Rolling persistency (%) [PERSISTENCY]', 'Recruitment [RECRUITMENT]',
        'New active agents [NEW_ACTIVE_AGENTS]', 'FYP (Rp M) [FYP]', '# of policy (case issued) [POLICY_COUNT]',
        'Unit persistency (%) [UNIT_PERSISTENCY]',
      ]);
    });

    it('names a column in the reader’s language — Rp juta in Indonesian — and the [KODE] the same in both', () => {
      expect(templateHeader(V1(), 'id').slice(2, 4)).toEqual(['APE (Rp juta) [APE]', 'Persistensi rolling (%) [PERSISTENCY]']);
    });

    it('adds <label> YTD [KODE_YTD] for a column whose year to date is uploaded, and none for a summed one', () => {
      const header = templateHeader(WITH_KOMISI(), 'id');
      expect(header.slice(-2)).toEqual(['Komisi tahun pertama (Rp juta) [KOMISI]', 'Komisi tahun pertama YTD [KOMISI_YTD]']);
      expect(header.filter((h) => h.includes('YTD'))).toHaveLength(1);
    });

    it('AA UI-024 a renamed system column keeps its kode: APE bersih (Rp juta) [APE]', () => {
      const config = V1();
      config.uploadFields[0] = { ...config.uploadFields[0], label: { id: 'APE bersih', en: 'Net APE' } };
      expect(headerOf(config.uploadFields[0], false, 'id')).toBe('APE bersih (Rp juta) [APE]');
    });

    it('writes the header as the file’s first line, cell for cell, quoting none', () => {
      expect(templateBody(HEADER_EN, []).split('\n')[0].split(',')).toEqual(HEADER_EN);
      expect(templateBody(HEADER_EN, []).split('\n')[0]).not.toContain('"');
    });
  });

  describe('AC-2 — a name survives a comma, a quote and a line break', () => {
    it('quotes a field only when it has to, and doubles a quote inside it (RFC 4180)', () => {
      expect(csvField('PRU-001')).toBe('PRU-001');
      expect(csvField('Wijaya, Rina')).toBe('"Wijaya, Rina"');
      expect(csvField('Pak "Budi" Santoso')).toBe('"Pak ""Budi"" Santoso"');
      expect(csvField('a\nb')).toBe('"a\nb"');
    });

    it('always quotes a name, so the column reads as one kind of thing (:4714)', () => {
      expect(csvName('Rina Wijaya')).toBe('"Rina Wijaya"');
      expect(csvName('Wijaya, Rina')).toBe('"Wijaya, Rina"');
    });

    it('doubles a quote inside a name, which the prototype leaves bare (:4714)', () => {
      // The prototype writes `"${name}"` and escapes nothing. Its own `split(',')` tolerates that;
      // a conforming reader — a spreadsheet, or the parser P9-T3 builds — does not.
      expect(csvName('Sdri. "Maya" Puspita')).toBe('"Sdri. ""Maya"" Puspita"');
    });

    it('keeps a name on one line, whatever was stored', () => {
      expect(csvName('Rina\nWijaya')).toBe('"Rina Wijaya"');
      expect(csvName('Rina \r\n Wijaya')).toBe('"Rina Wijaya"');
      expect(csvName('\tRina Wijaya ')).toBe('"Rina Wijaya"');
    });
  });

  describe('a name is never a formula', () => {
    it.each([
      ['=HYPERLINK("https://example.test","Rina")', '"\'=HYPERLINK(""https://example.test"",""Rina"")"'],
      ['+62 812 0000', '"\'+62 812 0000"'],
      ['-Rina', '"\'-Rina"'],
      ['@SUM(1+1)', '"\'@SUM(1+1)"'],
    ])('reads %s as text', (stored, written) => {
      expect(csvName(stored)).toBe(written);
    });

    it('is not fooled by whitespace in front of it', () => {
      expect(csvName(' \t=1+1')).toBe('"\'=1+1"');
    });

    it('leaves a name that only contains those characters alone', () => {
      expect(csvName('Rina-Wijaya')).toBe('"Rina-Wijaya"');
      expect(csvName('a=b')).toBe('"a=b"');
    });

    it('reaches the file: the row carries the inert name', () => {
      const [, row] = templateBody(HEADER_EN, [{ agentCode: 'PRU-001', name: '=1+1' }]).split('\n');
      expect(row).toBe('PRU-001,"\'=1+1",,,,,,,');
    });
  });

  describe('AC-4 — the body', () => {
    it('is one row per agent: the code, the quoted name, an empty field per column of the template', () => {
      const body = templateBody(HEADER_EN, [{ agentCode: 'PRU-001', name: 'Rina Wijaya' }]);
      const [, row] = body.split('\n');
      expect(row).toBe('PRU-001,"Rina Wijaya",,,,,,,');
      expect(row.split(',')).toHaveLength(HEADER_EN.length);
    });

    it('writes the agent code exactly as stored — it is the only join key', () => {
      // A spreadsheet may rewrite these on open (leading zeros, an exponent, a date). Recovering
      // from that is the reader's, under ADR-0052; the writer's half is that nothing is lost here.
      for (const code of ['00088213', '123456789012', '1E5', '12-05', 'PRU.80003/A']) {
        const [, row] = templateBody(HEADER_EN, [{ agentCode: code, name: 'Rina Wijaya' }]).split('\n');
        expect(row.split(',')[0]).toBe(code);
      }
    });

    it('is the header alone for an office with nobody yet', () => {
      expect(templateBody(HEADER_EN, []).split('\n')).toHaveLength(1);
    });
  });

  describe('P19.5-T2 AC-1 — the filename is <kpmCode>-agent-data-<YYYY-MM>.csv (spec §4, Agent code)', () => {
    it('names the file by the office’s code and the month', () => {
      expect(templateFilename('0417', '2026-09')).toBe('0417-agent-data-2026-09.csv');
      expect(templateFilename('0417', '2026-01')).toBe('0417-agent-data-2026-01.csv');
      expect(templateFilename('0417', '2025-12')).toBe('0417-agent-data-2025-12.csv');
    });
  });

  /**
   * **ADR-0184: the same file as an Excel workbook** — the guide on its own sheet, and the Data sheet holding exactly
   * the CSV's header and rows. Read back through the same reader an upload goes through: the round trip.
   */
  describe('ADR-0184 — the template as a workbook', () => {
    const ROWS = [
      { agentCode: '00088213', name: 'Sari Dewi' },
      { agentCode: 'PRU-001', name: '=HYPERLINK("x")\nWijaya' },
    ];
    const open = async (bytes: Buffer) => {
      const workbook = new Workbook();
      await workbook.xlsx.load(bytes as unknown as Parameters<Workbook['xlsx']['load']>[0]);
      return workbook;
    };

    it('is named as the CSV is, with .xlsx', () => {
      expect(templateFilename('0417', '2026-09', 'xlsx')).toBe('0417-agent-data-2026-09.xlsx');
    });

    it('holds the guide in the reader’s language, then a Data sheet with the CSV’s header and one row per agent', async () => {
      const workbook = await open(await templateWorkbook(V1(), ROWS, '2026-09', readerIn('id')));
      expect(workbook.worksheets.map((s) => s.name)).toEqual(['Petunjuk', 'Data']);
      const data = workbook.getWorksheet('Data')!;
      expect((data.getRow(1).values as unknown[]).slice(1)).toEqual(templateHeader(V1(), 'id'));
      expect(data.getColumn(1).numFmt).toBe('@');
      expect(data.actualRowCount).toBe(3);
    });

    it('writes a name as one line of text — a string is never a formula in a workbook, so it needs no apostrophe', async () => {
      const data = (await open(await templateWorkbook(V1(), ROWS, '2026-09', readerIn('en')))).getWorksheet('Data')!;
      expect(data.getCell('B3').value).toBe('=HYPERLINK("x") Wijaya');
      expect(data.getCell('B3').formula).toBeUndefined();
    });

    it('P19.5-T2 AC-1 the Petunjuk lists each column’s unit, whether it is required and from when, its start and its tip', async () => {
      const guide = (await open(await templateWorkbook(WITH_KOMISI(), ROWS, '2026-12', readerIn('id')))).getWorksheet('Petunjuk')!;
      const words: string[] = [];
      guide.eachRow((row) => row.eachCell((c) => { if (typeof c.value === 'string') words.push(c.value); }));
      expect(words).toEqual(expect.arrayContaining([
        'AgencyBoost — template produksi bulanan, Des 2026',
        'APE (Rp juta) [APE]',
        'Komisi tahun pertama (Rp juta) [KOMISI]',
        'Komisi tahun pertama YTD [KOMISI_YTD]',
        'Dalam juta rupiah: 1,5 berarti Rp 1.500.000. Bulan ini saja. Wajib diisi untuk setiap agen mulai Des 2026. '
          + 'Berlaku mulai Des 2026. Komisi dari laporan perusahaan.',
        '1,5',
      ]));
      const all = words.join(' ');
      expect(all).toContain('Hanya untuk baris AB dan AAB');
      expect(all).toContain('File sebagian tidak masalah');
      expect(all).toContain('pertahankan [KODE]');
    });

    it('P19.5-T2 AC-1 a column not yet in force for the month says so, and the guide is in English for an English reader', async () => {
      const guide = (await open(await templateWorkbook(WITH_KOMISI(), ROWS, '2026-11', readerIn('en')))).worksheets[0];
      const words: string[] = [];
      guide.eachRow((row) => row.eachCell((c) => { if (typeof c.value === 'string') words.push(c.value); }));
      expect(words.join(' ')).toContain('Not yet in force for this month: leave it empty.');
      expect(words).toContain('First-year commission (Rp M) [KOMISI]');
    });

    it('reads back as the template it is: the round trip a filled file makes', async () => {
      const bytes = await templateWorkbook(V1(), ROWS, '2026-09', readerIn('en'));
      const read = await readFileUpload(new Uint8Array(bytes));
      expect(read).toMatchObject({ format: 'xlsx', header: templateHeader(V1(), 'en') });
      expect(read.records.map((r) => r.cells.slice(0, 2))).toEqual([
        ['00088213', 'Sari Dewi'], ['PRU-001', '=HYPERLINK("x") Wijaya'],
      ]);
    });
  });
});
