import {
  csvField, csvName, TEMPLATE_HEADER_V1, TEMPLATE_HEADERS, TEMPLATE_VERSION, templateBody,
  templateFilename,
} from './production-template';

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

  describe('AC-3 — the header is the version', () => {
    it('is version 1, and version 1 is exactly this header', () => {
      expect(TEMPLATE_VERSION).toBe(1);
      expect(TEMPLATE_HEADERS[TEMPLATE_VERSION]).toBe(TEMPLATE_HEADER_V1);
    });

    it('writes the header as the file’s first line, cell for cell', () => {
      // The writer's half only. How a file that came back through a spreadsheet is matched — what is
      // forgiven on the way — is OD-75 and P9-T3's; nothing here models the reader.
      expect(templateBody([]).split('\n')[0].split(',')).toEqual([
        'Agent Code', 'Agent Name',
        'APE (Rp M) — This Month', 'Rolling Persistency (%) — This Month', 'Recruitment — This Month',
        'New Active Agents — This Month', 'FYP (Rp M) — This Month', '# of Policy — This Month',
        'APE (Rp M) — YTD', 'Rolling Persistency (%) — YTD', 'Recruitment — YTD',
        'New Active Agents — YTD', 'FYP (Rp M) — YTD', '# of Policy — YTD',
      ]);
    });

    it('quotes no header cell, so the first line is the cells and the commas between them', () => {
      expect(templateBody([]).split('\n')[0]).not.toContain('"');
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
      const [, row] = templateBody([{ agentCode: 'PRU-001', name: '=1+1' }]).split('\n');
      expect(row).toBe('PRU-001,"\'=1+1",,,,,,,,,,,,');
    });
  });

  describe('AC-4 — the body', () => {
    it('is one row per agent: the code, the quoted name, twelve empty fields', () => {
      const body = templateBody([{ agentCode: 'PRU-001', name: 'Rina Wijaya' }]);
      const [, row] = body.split('\n');
      expect(row).toBe('PRU-001,"Rina Wijaya",,,,,,,,,,,,');
      expect(row.split(',')).toHaveLength(14);
    });

    it('writes the agent code exactly as stored — it is the only join key', () => {
      // A spreadsheet may rewrite these on open (leading zeros, an exponent, a date). Recovering
      // from that is the reader's and is OD-75; the writer's half is that nothing is lost here.
      for (const code of ['00088213', '123456789012', '1E5', '12-05', 'PRU.80003/A']) {
        const [, row] = templateBody([{ agentCode: code, name: 'Rina Wijaya' }]).split('\n');
        expect(row.split(',')[0]).toBe(code);
      }
    });

    it('is the header alone for an office with nobody yet', () => {
      expect(templateBody([]).split('\n')).toHaveLength(1);
    });
  });

  describe('AC-5 — the filename is the office, the month and the year (KPM_Owner.html:4721)', () => {
    it('names the file the way the prototype does', () => {
      expect(templateFilename('0417', '2026-09')).toBe('KPM0417-agent-data-Sep-2026.csv');
      expect(templateFilename('0417', '2026-01')).toBe('KPM0417-agent-data-Jan-2026.csv');
      expect(templateFilename('0417', '2025-12')).toBe('KPM0417-agent-data-Dec-2025.csv');
    });
  });
});
