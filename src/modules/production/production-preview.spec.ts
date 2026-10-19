import { PRODUCTION_METRICS } from './monthly-agent-data.schema';
import {
  buildPreview, headerKey, matchCode, readCell, readNumber, readUpload, type RosterMember,
  type PreviewCell, type PreviewRow, type StoredFigures, templateVersionOf, VALUE_COLUMNS,
} from './production-preview';
import { TEMPLATE_HEADER_V1 } from './production-template';

const utf8 = (s: string) => new TextEncoder().encode(s);

const ROSTER: RosterMember[] = [
  { membershipId: 'm-rina', agentCode: 'PRU-001', name: 'Rina Wijaya' },
  { membershipId: 'm-budi', agentCode: 'PRU-002', name: 'Budi Santoso' },
  { membershipId: 'm-sari', agentCode: '00088213', name: 'Sari Dewi' },
];

const nothing = (): StoredFigures =>
  Object.fromEntries(PRODUCTION_METRICS.map((m) => [m, { monthly: null, ytd: null }])) as StoredFigures;

/** A data row: the code, the name, and the twelve cells keyed `metric.cadence`. */
const row = (code: string, name: string, cells: Record<string, string> = {}) =>
  [code, name, ...VALUE_COLUMNS.map((c) => cells[`${c.metric}.${c.cadence}`] ?? '')];

const records = (...rows: string[][]) => rows.map((cells, i) => ({ line: i + 2, cells }));

const preview = (
  rows: string[][],
  opts: { delimiter?: ',' | ';' | '\t'; stored?: Record<string, Partial<Record<string, number>>> } = {},
) => buildPreview({
  records: records(...rows),
  delimiter: opts.delimiter ?? ',',
  roster: ROSTER,
  stored: (id) => {
    const s = nothing();
    for (const [key, v] of Object.entries(opts.stored?.[id] ?? {})) {
      const [metric, cadence] = key.split('.') as [keyof StoredFigures, 'monthly' | 'ytd'];
      s[metric][cadence] = v ?? null;
    }
    return s;
  },
});

const cell = (r: PreviewRow, key: string): PreviewCell =>
  r.cells.find((c) => `${c.metric}.${c.cadence}` === key)!;

describe('the preview (P9-T3)', () => {
  describe('AC-2 — the header, cell by cell (ADR-0052)', () => {
    it('knows the template it issued', () => {
      expect(templateVersionOf([...TEMPLATE_HEADER_V1])).toBe(1);
    });

    it('reads through what a spreadsheet does to it: case, spacing, dashes, trailing empty cells', () => {
      const saved = TEMPLATE_HEADER_V1.map((h) => `  ${h.toUpperCase().replace('—', '–')} `);
      expect(templateVersionOf([...saved, '', ' '])).toBe(1);
    });

    it('reads an em dash that was decoded as Windows-1252 and saved again — â€”', () => {
      expect(headerKey('APE (Rp M) â€” This Month')).toBe(headerKey('APE (Rp M) — This Month'));
      expect(templateVersionOf(TEMPLATE_HEADER_V1.map((h) => h.replace('—', 'â€”')))).toBe(1);
    });

    it('refuses a renamed column, naming it — and nothing is previewed', () => {
      const renamed = [...TEMPLATE_HEADER_V1];
      renamed[4] = 'Recruits — This Month';
      expect(() => templateVersionOf(renamed)).toThrow(expect.objectContaining({
        code: 'UPLOAD_TEMPLATE_MISMATCH',
        details: { column: 5, expected: 'Recruitment — This Month', found: 'Recruits — This Month' },
      }));
    });

    it('refuses a missing column, and an extra one', () => {
      expect(() => templateVersionOf(TEMPLATE_HEADER_V1.slice(0, 13)))
        .toThrow(expect.objectContaining({ code: 'UPLOAD_TEMPLATE_MISMATCH', details: expect.objectContaining({ column: 14, found: null }) }));
      expect(() => templateVersionOf([...TEMPLATE_HEADER_V1, 'Notes']))
        .toThrow(expect.objectContaining({ code: 'UPLOAD_TEMPLATE_MISMATCH', details: expect.objectContaining({ column: 15, found: 'Notes' }) }));
    });

    it('refuses two columns swapped — the prototype would have imported them into each other’s fields', () => {
      const swapped = [...TEMPLATE_HEADER_V1];
      [swapped[2], swapped[3]] = [swapped[3], swapped[2]];
      expect(() => templateVersionOf(swapped)).toThrow(expect.objectContaining({ code: 'UPLOAD_TEMPLATE_MISMATCH' }));
    });

    it('refuses a file with no header at all, pointing at column 1', () => {
      expect(() => templateVersionOf(row('PRU-001', 'Rina Wijaya')))
        .toThrow(expect.objectContaining({ details: expect.objectContaining({ column: 1, found: 'PRU-001' }) }));
    });
  });

  describe('a number: the decimal mark follows the delimiter (ADR-0052)', () => {
    it.each([
      ['1.5', '.', 1.5], ['1,5', ',', 1.5], ['  12 ', '.', 12], ['0', ',', 0], ['-3', '.', -3], ['+2', '.', 2],
    ])('%j with “%s” is %d', (raw, mark, value) => {
      expect(readNumber(raw, mark as ',' | '.', false)).toEqual({ value });
    });

    it.each([
      ['1.500', ',', 'in this file the decimal mark is “,”'],
      ['1,5', '.', 'in this file the decimal mark is “.”'],
      ['1.234,5', ',', 'both'],
      ['1 500', '.', 'not a number'],
      ['abc', '.', 'not a number'],
      ['1.5E+3', '.', 'not a number'],
    ])('refuses %j with “%s”', (raw, mark, reason) => {
      const read = readNumber(raw, mark as ',' | '.', false);
      expect('reason' in read && read.reason).toContain(reason);
    });

    it('takes a % after a persistency figure, and only there', () => {
      expect(readCell('persistency', '85%', '.')).toEqual({ value: 85 });
      expect('reason' in readCell('recruitment', '85%', '.')).toBe(true);
    });
  });

  describe('AC-5, AC-7 — a value, in the unit it is stored in', () => {
    it('turns Rp M into integer sen: 1.5 is Rp 1,500,000 is 150,000,000 sen', () => {
      expect(readCell('ape', '1.5', '.')).toEqual({ value: 150_000_000 });
      expect(readCell('fyp', '0,29', ',')).toEqual({ value: 29_000_000 });
      expect(readCell('ape', '1200', '.')).toEqual({ value: 120_000_000_000 });
    });

    it('holds persistency to 0–100', () => {
      expect(readCell('persistency', '100', '.')).toEqual({ value: 100 });
      expect(readCell('persistency', '92.5', '.')).toEqual({ value: 92.5 });
      expect(readCell('persistency', '140', '.')).toEqual({ reason: expect.stringContaining('above 100') });
    });

    it('refuses a negative figure anywhere', () => {
      for (const m of PRODUCTION_METRICS) expect(readCell(m, '-1', '.')).toEqual({ reason: 'is negative.' });
    });

    it('refuses a fraction of a person or a policy', () => {
      expect(readCell('policyCount', '2.5', '.')).toEqual({ reason: expect.stringContaining('policies') });
      expect(readCell('recruitment', '1,5', ',')).toEqual({ reason: expect.stringContaining('people') });
      expect(readCell('newActiveAgents', '3,0', ',')).toEqual({ value: 3 });
    });

    it('refuses money no integer can hold', () => {
      expect(readCell('ape', '999999999999', '.')).toEqual({ reason: expect.stringContaining('larger') });
    });
  });

  describe('AC-6 — the agent code, and only the code', () => {
    it('matches exactly, ignoring letter case', () => {
      expect(matchCode('pru-001', ROSTER)).toMatchObject({ member: ROSTER[0], recovered: false });
    });

    it('recovers an all-digit code a spreadsheet stripped of its zeros, when one member fits', () => {
      expect(matchCode('88213', ROSTER)).toMatchObject({ member: ROSTER[2], recovered: true });
    });

    it('does not guess when two members fit', () => {
      const two = [...ROSTER, { membershipId: 'm-x', agentCode: '088213', name: 'X' }];
      expect(matchCode('88213', two)).toMatchObject({ member: null, reason: expect.stringContaining('not guessed') });
    });

    it.each([
      ['8.8213E+04', 'scientific notation'],
      ['12-05', 'a date'],
      ['5-Dec', 'a date'],
      ['Des-26', 'a date'],
      ['PRU-999', 'No active member of this office has this code.'],
      ['', 'no agent code'],
    ])('refuses %j, saying %j', (code, reason) => {
      expect(matchCode(code, ROSTER)).toMatchObject({ member: null, reason: expect.stringContaining(reason) });
    });

    it('never reads the name: a different name still matches, and says so', () => {
      const { rows } = preview([row('PRU-001', 'Somebody Else', { 'ape.monthly': '1' })]);
      expect(rows[0]).toMatchObject({ status: 'ready', membershipId: 'm-rina', nameDiffers: true });
      expect(cell(rows[0], 'ape.monthly').status).toBe('new');
    });

    it('does not call a name different for the apostrophe the template writes, or for case and spacing', () => {
      const { rows } = preview([row('PRU-001', "'rina   WIJAYA")]);
      expect(rows[0].nameDiffers).toBe(false);
    });
  });

  describe('AC-4 — a row that cannot be one member is refused, and the rest previews', () => {
    it('refuses an unknown code for that row only', () => {
      const { rows, summary } = preview([
        row('PRU-999', 'Nobody', { 'ape.monthly': '1' }),
        row('PRU-001', 'Rina Wijaya', { 'ape.monthly': '1' }),
      ]);
      expect(rows[0]).toMatchObject({ status: 'refused', cells: [], issues: [{ code: 'UPLOAD_UNKNOWN_AGENT_CODE' }] });
      expect(rows[1].status).toBe('ready');
      expect(summary).toMatchObject({ rows: 2, ready: 1, refused: 1 });
    });

    it('refuses both rows of an agent listed twice — which one is right is not guessed', () => {
      const { rows } = preview([
        row('00088213', 'Sari Dewi', { 'ape.monthly': '1' }),
        row('PRU-001', 'Rina Wijaya'),
        row('88213', 'Sari Dewi', { 'ape.monthly': '2' }),
      ]);
      expect(rows[0]).toMatchObject({ status: 'refused', issues: [{ code: 'UPLOAD_DUPLICATE_AGENT_CODE', message: expect.stringContaining('line 4') }] });
      expect(rows[2]).toMatchObject({ status: 'refused', issues: [{ code: 'UPLOAD_DUPLICATE_AGENT_CODE', message: expect.stringContaining('line 2') }] });
      expect(rows[1].status).toBe('ready');
    });

    it('refuses a row with more cells than the template — a comma outside quotes', () => {
      const { rows } = preview([['PRU-001', 'Wijaya', ' Rina', ...Array(12).fill('1')]]);
      expect(rows[0]).toMatchObject({ status: 'refused', issues: [{ code: 'UPLOAD_MALFORMED_CSV', message: expect.stringContaining('15 cells') }] });
    });

    it('reads a short row as blanks, and ignores empty cells past the fourteenth', () => {
      const { rows } = preview([['PRU-001', 'Rina', '1'], [...row('PRU-002', 'Budi'), '', '']]);
      expect(rows.map((r) => r.status)).toEqual(['ready', 'ready']);
      expect(cell(rows[0], 'ape.monthly').status).toBe('new');
      expect(cell(rows[0], 'fyp.ytd').status).toBe('not_provided');
    });

    it('skips a row with nothing in it', () => {
      expect(preview([row('', ''), row('PRU-001', 'Rina')]).summary.rows).toBe(1);
    });
  });

  describe('AC-5 — a bad cell is refused, and the row’s other values survive', () => {
    it('keeps eleven good values beside one bad one', () => {
      const cells = Object.fromEntries(VALUE_COLUMNS.map((c) => [`${c.metric}.${c.cadence}`, '1']));
      cells['persistency.monthly'] = '140';
      const { rows, summary } = preview([row('PRU-001', 'Rina', cells)]);
      expect(rows[0].status).toBe('ready');
      expect(cell(rows[0], 'persistency.monthly')).toMatchObject({ status: 'refused', raw: '140', after: null });
      expect(rows[0].issues).toEqual([expect.objectContaining({
        code: 'UPLOAD_VALUE_OUT_OF_RANGE', metric: 'persistency', cadence: 'monthly',
        message: 'Rolling Persistency (%) — This Month: “140” is above 100 — persistency is a percentage.',
      })]);
      expect(summary).toMatchObject({ newCells: 11, refusedCells: 1 });
    });
  });

  describe('YTD is a sum of months, so it cannot be less than this month', () => {
    it('refuses a YTD below the month in the same file, and holds the month back with it', () => {
      const { rows } = preview([row('PRU-001', 'Rina', { 'policyCount.monthly': '5', 'policyCount.ytd': '3' })]);
      expect(cell(rows[0], 'policyCount.ytd').status).toBe('refused');
      expect(cell(rows[0], 'policyCount.monthly').status).toBe('refused');
      expect(rows[0].issues.map((i) => i.message)).toEqual([
        '# of Policy — YTD: “3” is less than this month’s “5” — the year so far includes this month.',
        '# of Policy — This Month: “5” is held back with its YTD, which is refused.',
      ]);
    });

    it('compares against what is stored when the file gives only one of the two', () => {
      const { rows } = preview(
        [row('PRU-001', 'Rina', { 'ape.monthly': '2', 'recruitment.ytd': '1' })],
        { stored: { 'm-rina': { 'ape.ytd': 150_000_000, 'recruitment.monthly': 2 } } },
      );
      expect(cell(rows[0], 'ape.monthly').status).toBe('refused');
      expect(rows[0].issues[0].message).toContain('more than the year to date already held, 1.5');
      expect(cell(rows[0], 'recruitment.ytd').status).toBe('refused');
    });

    it('does not apply to persistency, which is a rate', () => {
      const { rows } = preview([row('PRU-001', 'Rina', { 'persistency.monthly': '95', 'persistency.ytd': '80' })]);
      expect(rows[0].issues).toEqual([]);
    });

    it('accepts a YTD equal to the month — January', () => {
      expect(preview([row('PRU-001', 'Rina', { 'ape.monthly': '2', 'ape.ytd': '2' })]).rows[0].issues).toEqual([]);
    });
  });

  describe('AC-8, AC-9 — a diff against what is stored, never a file echoed', () => {
    const stored = { 'm-rina': { 'ape.monthly': 100_000_000, 'ape.ytd': 500_000_000, 'fyp.monthly': 50_000_000 } };

    it('says new, changed and unchanged against the stored figure', () => {
      const { rows, summary } = preview(
        [row('PRU-001', 'Rina', { 'ape.monthly': '1', 'ape.ytd': '6', 'policyCount.monthly': '2' })],
        { stored },
      );
      expect(cell(rows[0], 'ape.monthly')).toMatchObject({ status: 'unchanged', before: 100_000_000, after: 100_000_000 });
      expect(cell(rows[0], 'ape.ytd')).toMatchObject({ status: 'changed', before: 500_000_000, after: 600_000_000 });
      expect(cell(rows[0], 'policyCount.monthly')).toMatchObject({ status: 'new', before: null, after: 2 });
      expect(summary).toMatchObject({ newCells: 1, changedCells: 1, unchangedCells: 1 });
    });

    it('previews a blank cell as not provided, keeping what is stored — never as a figure cleared', () => {
      const { rows } = preview([row('PRU-001', 'Rina')], { stored });
      expect(cell(rows[0], 'fyp.monthly')).toMatchObject({ status: 'not_provided', before: 50_000_000, after: null });
      expect(rows[0].cells.every((c) => c.status === 'not_provided')).toBe(true);
    });

    it('counts the active members the file does not list — they keep what they have', () => {
      expect(preview([row('PRU-001', 'Rina')]).summary.notInFile).toBe(2);
    });
  });

  describe('AC-11 — a file that came back through a spreadsheet (ADR-0052)', () => {
    it('reads Excel under Indonesian settings: ; delimiter, decimal commas, Windows-1252, CRLF, no quotes', () => {
      const header = TEMPLATE_HEADER_V1.join(';');
      const line = ['00088213', 'Sari Dewi', '1,5', '92,5', '1', '0', '0,75', '3', '4,5', '90', '2', '1', '2,25', '9'].join(';');
      const text = `${header}\r\n${line.replace('00088213', '88213')}\r\n;;;;;;;;;;;;;\r\n`;
      // A plain "CSV" save: the em dash is 0x97, which is not UTF-8.
      const bytes = Uint8Array.from([...text].flatMap((ch) => (ch === '—' ? [0x97] : [...utf8(ch)])));

      const read = readUpload(bytes);
      expect(read).toMatchObject({ encoding: 'windows-1252', delimiter: ';', templateVersion: 1 });

      const { rows, summary } = buildPreview({ records: read.records, delimiter: read.delimiter, roster: ROSTER, stored: nothing });
      expect(summary).toMatchObject({ rows: 1, ready: 1, refused: 0, newCells: 12, refusedCells: 0 });
      expect(rows[0]).toMatchObject({ membershipId: 'm-sari', codeRecovered: true, resolvedAgentCode: '00088213' });
      expect(cell(rows[0], 'ape.monthly').after).toBe(150_000_000);
      expect(cell(rows[0], 'persistency.monthly').after).toBe(92.5);
    });

    it('reads the template as issued, byte-order mark and all', () => {
      const text = `﻿${TEMPLATE_HEADER_V1.join(',')}\nPRU-001,"Rina Wijaya",1.5,,,,,,,,,,,`;
      expect(readUpload(utf8(text))).toMatchObject({ encoding: 'utf-8', delimiter: ',', templateVersion: 1 });
    });

    it('refuses a file of blank lines as empty', () => {
      expect(() => readUpload(utf8('\n\n  \n'))).toThrow(expect.objectContaining({ code: 'UPLOAD_MALFORMED_CSV' }));
    });
  });
});
