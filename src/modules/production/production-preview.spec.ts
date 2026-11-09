import { Workbook } from 'exceljs';
import type { DomainException } from '@/common/errors/domain.exception';
import { readerIn, SOURCE_READER, type Reader } from '@/common/i18n/reader';
import { english, indonesian } from '../../../test/i18n';
import {
  agentCodePattern, analyticsConfigV1, type AdvancedAnalyticsConfig, type UploadField,
} from '@/modules/config/analytics-config';
import type { LinearPattern } from '@/modules/config/linear-pattern';
import {
  buildPreview, headerKey, layoutOf, matchCode, readCell, readFileUpload, readNumber, readUpload, type PreviewCell,
  type PreviewRow, type RosterMember, type RowRules, type StoredFigures,
} from './production-preview';
import { TEMPLATE_HEADER_V1, TEMPLATE_HEADER_V2, templateHeader } from './production-template';

/** A value read, its reason in English: what the import says after the cell (`readCell`, `readNumber`). */
const said = (read: ReturnType<typeof readCell>) => ('reason' in read ? { reason: english(read.reason) } : read);

/** A code matched, its reason in English. */
const matched = (code: string, roster: readonly RosterMember[]) => {
  const match = matchCode(code, roster);
  return { ...match, reason: english(match.reason) };
};

/** The refusal a call throws, for its words in either language. */
const refusalOf = (fn: () => unknown): DomainException => {
  try {
    fn();
  } catch (err) {
    return err as DomainException;
  }
  throw new Error('nothing was refused');
};

const utf8 = (s: string) => new TextEncoder().encode(s);

const ROSTER: RosterMember[] = [
  { membershipId: 'm-rina', agentCode: 'PRU-001', name: 'Rina Wijaya' },
  { membershipId: 'm-budi', agentCode: 'PRU-002', name: 'Budi Santoso' },
  { membershipId: 'm-sari', agentCode: '00088213', name: 'Sari Dewi' },
  { membershipId: 'm-agus', agentCode: 'PRU-009', name: 'Agus Pratama', leader: true },
];

/** Version 1 of a template: today's seven columns, from Jan 2024. */
const V1 = (): AdvancedAnalyticsConfig => analyticsConfigV1({ effectiveFrom: '2024-01' });
const field = (kode: string, over: Partial<UploadField> = {}): UploadField => ({
  kode, system: false, label: { id: kode, en: kode }, labelAliases: [], unit: 'count', ytd: 'sum', min: 0, max: null,
  required: false, rows: 'all', effectiveFrom: '2024-01', tip: { id: '', en: '' }, ...over,
});
/** AT-1's column: *Komisi tahun pertama* `FYC`, Rp juta, uploaded YTD, required, from Dec 2026. */
const FYC = field('FYC', {
  label: { id: 'Komisi tahun pertama', en: 'First-year commission' }, unit: 'rp_million', ytd: 'upload', required: true,
  effectiveFrom: '2026-12',
});
/** Version 2: version 1 with FYC added. */
const V2 = (): AdvancedAnalyticsConfig => ({ ...V1(), uploadFields: [...V1().uploadFields, FYC] });

const HEADER = templateHeader(V1(), 'en');
const NO_RULES: RowRules = { pattern: null, example: '', unknownAgent: 'reject', ytdTolerancePct: 1 };
const rule = (pattern: string): LinearPattern => {
  const compiled = agentCodePattern(pattern);
  if (!('pattern' in compiled)) throw new Error(pattern);
  return compiled.pattern;
};

const NOTHING: StoredFigures = { values: {}, ytdValues: {}, previousYtd: {} };

/** A data row under `header`: the code, the name, and each cell by its key — `APE`, `FYC_YTD`. */
const rowUnder = (keys: readonly (string | null)[]) =>
  (code: string, name: string, cells: Record<string, string> = {}) =>
    [code, name, ...keys.slice(2).map((k) => (k ? cells[k] ?? '' : ''))];
const KEYS_V1 = ['', '', 'APE', 'PERSISTENCY', 'RECRUITMENT', 'NEW_ACTIVE_AGENTS', 'FYP', 'POLICY_COUNT', 'UNIT_PERSISTENCY'];
const row = rowUnder(KEYS_V1);

const records = (...rows: string[][]) => rows.map((cells, i) => ({ line: i + 2, cells }));

const preview = (
  rows: string[][],
  opts: {
    header?: readonly string[]; config?: AdvancedAnalyticsConfig; month?: string; delimiter?: ',' | ';' | '\t';
    stored?: Record<string, Partial<StoredFigures>>; held?: Record<string, Partial<StoredFigures>>;
    rules?: Partial<RowRules>; reader?: Reader;
  } = {},
) => {
  const header = opts.header ?? HEADER;
  const config = opts.config ?? V1();
  const month = opts.month ?? '2026-09';
  const reader = opts.reader ?? SOURCE_READER;
  const layout = layoutOf(header, config, month, reader);
  return {
    layout,
    ...buildPreview({
      records: records(...rows), delimiter: opts.delimiter ?? ',', header, layout, month, roster: ROSTER,
      stored: (id) => ({ ...NOTHING, ...opts.stored?.[id] }),
      heldStored: (code) => ({ ...NOTHING, ...opts.held?.[code] }),
      rules: { ...NO_RULES, ...opts.rules },
    }, reader),
  };
};

const cell = (r: PreviewRow, key: string): PreviewCell =>
  r.cells.find((c) => `${c.kode}${c.ytd ? '_YTD' : ''}` === key)!;

describe('the preview (P9-T3; read against the template since P19.5-T2)', () => {
  /**
   * **P19.5-T2 AC-2, AT-4 — a header is matched column by column** (ADR-0214 §5, amending ADR-0052): `[KODE]`, then the
   * ID label, the EN label and the aliases, whatever the case; a file headed any of those ways imports the same values.
   */
  describe('P19.5-T2 AC-2, AT-4 — matching a header', () => {
    const valuesOf = (header: string[]) => {
      const { rows } = preview([['PRU-001', 'Rina', '1.5', '92', '2']], { header: ['Agent Code', 'Agent Name', ...header] });
      return rows[0].cells.filter((c) => c.status === 'new').map((c) => [c.kode, c.after]);
    };
    const expected = [['APE', 150_000_000], ['PERSISTENCY', 92], ['RECRUITMENT', 2]];

    it('AT-4 by [KODE], whatever the words before it', () => {
      expect(valuesOf(['Anything [APE]', 'x [persistency]', 'Rekrut [RECRUITMENT]'])).toEqual(expected);
    });

    it('AT-4 by the ID label, the EN label, and a trailing unit set aside — case-insensitive', () => {
      expect(valuesOf(['ape (rp juta)', 'PERSISTENSI ROLLING (%)', 'Rekrutmen'])).toEqual(expected);
      expect(valuesOf(['APE (Rp M)', 'Rolling persistency', 'recruitment'])).toEqual(expected);
    });

    it('AT-4 by an alias: today’s v1 header (“APE (Rp M) — This Month” …) still imports', () => {
      expect(valuesOf(['APE (Rp M) — This Month', 'Rolling Persistency (%) — This Month', 'Recruitment — This Month'])).toEqual(expected);
    });

    it('AA UI-024 a file headed “Rekrutmen” imports after the column is renamed “Rekrut baru”', () => {
      const config = V1();
      const at = config.uploadFields.findIndex((f) => f.kode === 'RECRUITMENT');
      config.uploadFields[at] = { ...config.uploadFields[at], label: { id: 'Rekrut baru', en: 'New recruits' }, labelAliases: [...config.uploadFields[at].labelAliases, 'Rekrutmen', 'Recruitment'] };
      const { rows } = preview([['PRU-001', 'Rina', '2']], { config, header: ['Agent Code', 'Agent Name', 'Rekrutmen'] });
      expect(cell(rows[0], 'RECRUITMENT')).toMatchObject({ status: 'new', after: 2 });
    });

    it('reads through what a spreadsheet does to a header: case, spacing, dashes, mojibake, a byte-order mark', () => {
      const saved = ['﻿agent code', 'AGENT  NAME', '  APE (RP M) – THIS MONTH ', 'Recruitment â€” This Month'];
      const { rows } = preview([['PRU-001', 'Rina', '1', '3']], { header: saved });
      expect(rows[0].cells.map((c) => [c.kode, c.after])).toEqual([['APE', 100_000_000], ['RECRUITMENT', 3]]);
      expect(headerKey('  APE (Rp M) — This Month ')).toBe('ape (rp m) - this month');
    });

    it('P19.5-T2 AC-2 UPLOAD_TEMPLATE_MISMATCH only for no Agent Code column, no column read, or two headers on one kode', () => {
      const refusal = (header: string[]) => refusalOf(() => layoutOf(header, V1(), '2026-09', SOURCE_READER));
      expect(refusal(['Agent Name', 'APE [APE]'])).toMatchObject({ code: 'UPLOAD_TEMPLATE_MISMATCH', details: { column: 'Agent Code' } });
      expect(refusal(['Agent Code', 'Agent Name', 'Recruits', 'Cases'])).toMatchObject({ code: 'UPLOAD_TEMPLATE_MISMATCH' });
      const two = refusal(['Agent Code', 'APE [APE]', 'APE (Rp M) — This Month']);
      expect(two).toMatchObject({ code: 'UPLOAD_TEMPLATE_MISMATCH', details: { kode: 'APE', columns: [2, 3] } });
      expect(two.messageFor(readerIn('id'))).toContain('sama-sama terbaca sebagai APE');
      expect(refusal([]).message).toContain('no Agent Code column');
    });
  });

  /** **P19.5-T2 AC-3, AT-3, AA UI-013 — a file from an older template version imports.** */
  describe('P19.5-T2 AC-3, AT-3, AA UI-013 — old files', () => {
    it('AT-3 a v1 file after v2: the new column is empty with the warning, and no row is skipped — a required one included', () => {
      const { rows, layout, summary } = preview(
        [row('PRU-001', 'Rina', { APE: '1' }), row('PRU-002', 'Budi', { APE: '2' })],
        { config: V2(), month: '2026-12', reader: readerIn('id') },
      );
      expect(layout.notes.filter((n) => n.code === 'column_missing').map((n) => n.message)).toEqual([
        'Kolom Komisi tahun pertama kosong di file ini. Baris tetap diimpor.',
        'Kolom Komisi tahun pertama YTD kosong di file ini. Baris tetap diimpor.',
      ]);
      expect(summary).toMatchObject({ rows: 2, ready: 2, refused: 0 });
      expect(rows[0].cells.find((c) => c.kode === 'FYC')).toBeUndefined();
    });

    it('AA UI-013 a file with an archived [FYP] imports, and FYP is not stored: “Kolom FYP tidak dipakai lagi”', () => {
      const config = V1();
      const fyp = config.uploadFields.find((f) => f.kode === 'FYP')!;
      config.uploadFields = config.uploadFields.filter((f) => f.kode !== 'FYP');
      config.archivedFields = [fyp];
      const { rows, layout } = preview(
        [['PRU-001', 'Rina', '1', '9']], { config, header: ['Agent Code', 'Agent Name', 'APE (Rp M) [APE]', 'FYP (Rp M) [FYP]'], reader: readerIn('id') },
      );
      expect(layout.notes).toEqual(expect.arrayContaining([
        expect.objectContaining({ code: 'column_retired', kode: 'FYP', message: 'Kolom FYP tidak dipakai lagi' }),
      ]));
      expect(rows[0].cells.map((c) => c.kode)).toEqual(['APE']);
    });

    it('ignores an unknown [KODE] and a header matching nothing, saying so; an issued YTD of a summed column is not stored', () => {
      const { layout, rows } = preview(
        [['PRU-001', 'Rina', '1', '5', '7', '9']],
        { header: ['Agent Code', 'Agent Name', 'APE [APE]', 'Bonus [BONUS]', 'Catatan', 'APE (Rp M) — YTD'], reader: readerIn('id') },
      );
      expect(layout.notes.map((n) => [n.code, n.message])).toEqual(expect.arrayContaining([
        ['column_retired', 'Kolom Bonus [BONUS] tidak dipakai lagi'],
        ['column_unknown', 'Kolom Catatan tidak dikenali'],
        ['column_retired', 'Kolom APE YTD tidak dipakai lagi'],
      ]));
      expect(rows[0].cells.map((c) => `${c.kode}${c.ytd ? '_YTD' : ''}`)).toEqual(['APE']);
    });

    it('P19.3-T1 a version 2 file (fifteen columns) previews by kode, Unit Persistency on a leader’s row', () => {
      const line = ['PRU-009', 'Agus', '1', '90', '0', '0', '0.5', '1', '9', '90', '0', '0', '4', '5', '82.5'];
      const { rows } = preview([line], { header: TEMPLATE_HEADER_V2 });
      expect(cell(rows[0], 'UNIT_PERSISTENCY')).toMatchObject({ status: 'new', after: 82.5 });
      expect(cell(rows[0], 'APE')).toMatchObject({ after: 100_000_000 });
      expect(rows[0].cells.some((c) => c.ytd)).toBe(false);
    });
  });

  /** **P19.5-T2 AC-4, R2, AT-1, AT-2, AA UI-010 — a column counts from its start month.** */
  describe('P19.5-T2 AC-4, R2 — effectiveFrom', () => {
    it('AT-2 re-uploading Jan 2025 from a file without FYC skips no row', () => {
      const { summary, layout } = preview([row('PRU-001', 'Rina', { APE: '1' })], { config: V2(), month: '2025-01' });
      expect(summary).toMatchObject({ ready: 1, refused: 0 });
      // FYC is not in force in Jan 2025: nothing is said of it missing.
      expect(layout.notes.filter((n) => n.kode === 'FYC')).toEqual([]);
    });

    it('AA UI-010 a column before its start is not read for the month, and the preview says when it starts', () => {
      const header = [...HEADER, 'Komisi tahun pertama (Rp juta) [FYC]'];
      const { rows, layout } = preview(
        [[...row('PRU-001', 'Rina', { APE: '1' }), '5']], { config: V2(), header, month: '2026-11', reader: readerIn('id') },
      );
      expect(rows[0].cells.find((c) => c.kode === 'FYC')).toBeUndefined();
      expect(layout.notes).toEqual(expect.arrayContaining([
        expect.objectContaining({ code: 'column_not_in_force', kode: 'FYC', message: 'Kolom Komisi tahun pertama berlaku mulai Des 2026, jadi tidak diimpor untuk bulan ini.' }),
      ]));
    });
  });

  /** **P19.5-T2 AC-5 — a row's checks** (ADR-0214 §5), in their order. */
  describe('P19.5-T2 AC-5 — the row’s checks', () => {
    it('AC-5 a value outside the column’s minimum or maximum is refused for that cell, with the reason; the row imports', () => {
      const config = V1();
      config.uploadFields = config.uploadFields.map((f) => (f.kode === 'RECRUITMENT' ? { ...f, max: 10 } : f));
      const { rows } = preview([row('PRU-001', 'Rina', { APE: '1', RECRUITMENT: '11', PERSISTENCY: '-1' })], { config });
      expect(rows[0].status).toBe('ready');
      expect(cell(rows[0], 'APE').status).toBe('new');
      expect(cell(rows[0], 'RECRUITMENT').status).toBe('refused');
      expect(rows[0].issues.map((i) => [i.code, i.kode, i.message])).toEqual([
        ['UPLOAD_VALUE_OUT_OF_RANGE', 'PERSISTENCY', 'Rolling persistency (%) [PERSISTENCY]: “-1” is negative.'],
        ['UPLOAD_VALUE_OUT_OF_RANGE', 'RECRUITMENT', 'Recruitment [RECRUITMENT]: “11” is above this column\'s maximum, 10.'],
      ]);
    });

    it('AC-5 R2 a blank in a required column the file carries skips the row: “<label> wajib diisi”', () => {
      const config = V1();
      config.uploadFields = config.uploadFields.map((f) => (f.kode === 'POLICY_COUNT' ? { ...f, required: true } : f));
      const { rows } = preview([row('PRU-001', 'Rina', { APE: '1' }), row('PRU-002', 'Budi', { APE: '1', POLICY_COUNT: '2' })], {
        config, reader: readerIn('id'),
      });
      expect(rows[0]).toMatchObject({ status: 'refused', cells: [] });
      expect(rows[0].issues).toEqual([{ code: 'UPLOAD_REQUIRED_BLANK', kode: 'POLICY_COUNT', ytd: false, message: 'Jumlah polis (case issued) wajib diisi' }]);
      expect(rows[1].status).toBe('ready');
    });

    it('AC-5 a required leaders’ column asks only a leader’s row', () => {
      const config = V1();
      config.uploadFields = config.uploadFields.map((f) => (f.kode === 'UNIT_PERSISTENCY' ? { ...f, required: true } : f));
      const { rows } = preview([row('PRU-001', 'Rina', { APE: '1' }), row('PRU-009', 'Agus', { APE: '1' })], { config });
      expect(rows.map((r) => r.status)).toEqual(['ready', 'refused']);
      expect(rows[1].issues[0].code).toBe('UPLOAD_REQUIRED_BLANK');
    });

    it('AC-5 ADR-0214 §7 an unregistered code not in the template’s format is refused, naming the example', () => {
      const { rows } = preview([row('ABC', 'Somebody', { APE: '1' })], {
        rules: { pattern: rule('^[0-9]{8}$'), example: '70012345', unknownAgent: 'flag' }, reader: readerIn('id'),
      });
      expect(rows[0].status).toBe('refused');
      expect(rows[0].issues[0]).toMatchObject({
        code: 'UPLOAD_AGENT_CODE_PATTERN', message: 'Kode ini tidak sesuai format kode agen di template KPM ini — contohnya 70012345.',
      });
    });

    it('AC-5 a member’s code is the member’s: a code a spreadsheet stripped of zeros is not refused for the format', () => {
      const { rows } = preview([row('88213', 'Sari', { APE: '1' })], { rules: { pattern: rule('^[0-9]{8}$'), example: '70012345' } });
      expect(rows[0]).toMatchObject({ status: 'ready', membershipId: 'm-sari', codeRecovered: true });
    });

    it('AC-5 ADR-0214 §8 an unregistered code is held as Belum terdaftar under flag, and refused under reject', () => {
      const flag = preview([row('70019999', 'Dewi Baru', { APE: '1', POLICY_COUNT: '1' })], {
        rules: { pattern: rule('^[0-9]{8}$'), example: '70012345', unknownAgent: 'flag' },
      });
      expect(flag.rows[0]).toMatchObject({ status: 'held', membershipId: null, fileName: 'Dewi Baru', issues: [] });
      expect(cell(flag.rows[0], 'APE')).toMatchObject({ status: 'new', after: 100_000_000 });
      expect(flag.summary).toMatchObject({ held: 1, ready: 0, refused: 0 });

      const reject = preview([row('70019999', 'Dewi Baru', { APE: '1' })], { rules: { unknownAgent: 'reject' } });
      expect(reject.rows[0]).toMatchObject({ status: 'refused' });
      expect(reject.rows[0].issues[0]).toMatchObject({ code: 'UPLOAD_UNKNOWN_AGENT_CODE', message: 'No active member of this office has this code.' });
    });

    it('AC-5 a held code is compared with what is held for it; a held code listed twice refuses both rows', () => {
      const { rows } = preview([row('70019999', 'Dewi', { APE: '2' })], {
        rules: { unknownAgent: 'flag' }, held: { '70019999': { values: { APE: 100_000_000 } } },
      });
      expect(cell(rows[0], 'APE')).toMatchObject({ status: 'changed', before: 100_000_000, after: 200_000_000 });
      const twice = preview([row('70019999', 'Dewi', { APE: '2' }), row('70019999', 'Dewi', { APE: '3' })], { rules: { unknownAgent: 'flag' } });
      expect(twice.rows.map((r) => [r.status, r.issues[0]?.code])).toEqual([
        ['refused', 'UPLOAD_DUPLICATE_AGENT_CODE'], ['refused', 'UPLOAD_DUPLICATE_AGENT_CODE'],
      ]);
    });

    it('AC-5 a code a spreadsheet rewrote is refused even under flag — it is not held', () => {
      const { rows } = preview([row('8.8213E+04', 'X', { APE: '1' })], { rules: { unknownAgent: 'flag' } });
      expect(rows[0].issues[0]).toMatchObject({ code: 'UPLOAD_UNKNOWN_AGENT_CODE' });
    });

    it('P19.3-T1 a leaders’ column on an agent’s row is refused for that cell; the row’s other figures import', () => {
      const { rows } = preview([row('PRU-001', 'Rina', { APE: '1', UNIT_PERSISTENCY: '80' })]);
      expect(rows[0].status).toBe('ready');
      expect(cell(rows[0], 'UNIT_PERSISTENCY').status).toBe('refused');
      expect(rows[0].issues[0]).toMatchObject({ code: 'UPLOAD_LEADER_ONLY_VALUE', kode: 'UNIT_PERSISTENCY' });
    });
  });

  /** **P19.5-T2 AC-7 — an uploaded YTD is checked** (ADR-0214 §5 step 7), `ytdTolerancePct` of it. */
  describe('P19.5-T2 AC-7 — a ytd:upload column’s check', () => {
    const header = ['Agent Code', 'Agent Name', 'Komisi tahun pertama (Rp juta) [FYC]', 'Komisi tahun pertama YTD [FYC_YTD]'];
    const config = () => { const c = V2(); c.uploadFields = c.uploadFields.map((f) => (f.kode === 'FYC' ? { ...f, effectiveFrom: '2026-01', required: false } : f)); return c; };

    it('AC-7 refuses a YTD that is not last month’s plus this month’s; the month still imports', () => {
      const { rows } = preview([['PRU-001', 'Rina', '2', '9']], {
        header, config: config(), month: '2026-03', stored: { 'm-rina': { previousYtd: { FYC: 500_000_000 } } }, reader: readerIn('id'),
      });
      expect(cell(rows[0], 'FYC')).toMatchObject({ status: 'new', after: 200_000_000 });
      expect(cell(rows[0], 'FYC_YTD')).toMatchObject({ status: 'refused', after: null });
      expect(rows[0].issues[0]).toMatchObject({ code: 'UPLOAD_YTD_MISMATCH', kode: 'FYC', ytd: true });
      expect(rows[0].issues[0].message).toContain('bukan YTD bulan lalu ditambah angka bulan ini (7)');
    });

    it('AC-7 accepts one that adds up, within ytdTolerancePct', () => {
      const { rows } = preview([['PRU-001', 'Rina', '2', '7.05']], {
        header, config: config(), month: '2026-03', stored: { 'm-rina': { previousYtd: { FYC: 500_000_000 } } },
      });
      expect(cell(rows[0], 'FYC_YTD')).toMatchObject({ status: 'new', after: 705_000_000 });
    });

    it('AC-7 January’s YTD equals its month; with no earlier month held, nothing is checked', () => {
      const jan = preview([['PRU-001', 'Rina', '2', '3']], { header, config: config(), month: '2026-01' });
      expect(cell(jan.rows[0], 'FYC_YTD').status).toBe('refused');
      const none = preview([['PRU-001', 'Rina', '2', '30']], { header, config: config(), month: '2026-05' });
      expect(cell(none.rows[0], 'FYC_YTD')).toMatchObject({ status: 'new', after: 3_000_000_000 });
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
      expect('reason' in read && english(read.reason)).toContain(reason);
    });

    it('P18.10-T5 says why in Indonesian too, the end of a sentence after the cell', () => {
      const why = (raw: string, mark: ',' | '.') => {
        const read = readNumber(raw, mark, false);
        return 'reason' in read ? indonesian(read.reason) : null;
      };
      expect(why('1.500', ',')).toBe('memakai “.”, padahal di file ini tanda desimalnya “,”. Tulis tanpa pemisah ribuan.');
      expect(why('abc', '.')).toBe('bukan angka.');
    });
  });

  describe('AC-5, AC-7 — a value, in the unit it is stored in (P19.5-T2: its column’s)', () => {
    const [ape, persistency, recruitment] = V1().uploadFields;
    it('turns Rp juta into integer sen: 1.5 is Rp 1,500,000 is 150,000,000 sen', () => {
      expect(said(readCell(ape, '1.5', '.'))).toEqual({ value: 150_000_000 });
      expect(said(readCell(ape, '0,29', ','))).toEqual({ value: 29_000_000 });
    });

    it('holds a percentage to 0–100 and takes a % after it, and only there', () => {
      expect(said(readCell(persistency, '85%', '.'))).toEqual({ value: 85 });
      expect(said(readCell(persistency, '92.5', '.'))).toEqual({ value: 92.5 });
      expect(said(readCell(persistency, '140', '.'))).toEqual({ reason: expect.stringContaining('above 100') });
      expect('reason' in readCell(recruitment, '85%', '.')).toBe(true);
    });

    it('refuses a negative figure where the minimum is 0, a fraction of a count, and money no integer can hold', () => {
      expect(said(readCell(ape, '-1', '.'))).toEqual({ reason: 'is negative.' });
      expect(said(readCell(recruitment, '1,5', ','))).toEqual({ reason: 'is not a whole number — this column counts.' });
      expect(said(readCell(ape, '999999999999', '.'))).toEqual({ reason: expect.stringContaining('larger') });
    });

    it('P19.5-T2 AC-5 checks a column’s own limits, in its unit — Rp juta for money', () => {
      expect(said(readCell({ unit: 'rp_million', min: 1, max: 500 }, '0.5', '.'))).toEqual({ reason: 'is below this column\'s minimum, 1.' });
      expect(said(readCell({ unit: 'rp_million', min: 1, max: 500 }, '501', '.'))).toEqual({ reason: 'is above this column\'s maximum, 500.' });
      expect(said(readCell({ unit: 'count', min: null, max: null }, '-2', '.'))).toEqual({ value: -2 });
    });
  });

  describe('AC-6 — the agent code, and only the code', () => {
    it('matches exactly, ignoring letter case', () => {
      expect(matchCode('pru-001', ROSTER)).toMatchObject({ member: ROSTER[0], recovered: false, reason: null });
    });

    it('recovers an all-digit code a spreadsheet stripped of its zeros, when one member fits', () => {
      expect(matchCode('88213', ROSTER)).toMatchObject({ member: ROSTER[2], recovered: true });
    });

    it('does not guess when two members fit', () => {
      const two = [...ROSTER, { membershipId: 'm-x', agentCode: '088213', name: 'X' }];
      expect(matched('88213', two)).toMatchObject({ member: null, reason: expect.stringContaining('not guessed') });
    });

    it.each([
      ['8.8213E+04', 'scientific notation'],
      ['12-05', 'a date'],
      ['Des-26', 'a date'],
      ['PRU-999', 'No active member of this office has this code.'],
      ['', 'no agent code'],
    ])('refuses %j, saying %j', (code, reason) => {
      expect(matched(code, ROSTER)).toMatchObject({ member: null, reason: expect.stringContaining(reason) });
    });

    it('never reads the name: a different name still matches, and says so', () => {
      const { rows } = preview([row('PRU-001', 'Somebody Else', { APE: '1' })]);
      expect(rows[0]).toMatchObject({ status: 'ready', membershipId: 'm-rina', nameDiffers: true });
      const quoted = preview([row('PRU-001', "'rina   WIJAYA")]);
      expect(quoted.rows[0].nameDiffers).toBe(false);
    });
  });

  describe('AC-4 — a row that cannot be one member is refused, and the rest previews', () => {
    it('refuses both rows of an agent listed twice — which one is right is not guessed', () => {
      const { rows } = preview([row('PRU-001', 'Rina', { APE: '1' }), row('pru-001', 'Rina', { APE: '2' }), row('PRU-002', 'Budi', { APE: '3' })]);
      expect(rows.map((r) => r.status)).toEqual(['refused', 'refused', 'ready']);
      expect(rows[0].issues[0].message).toContain('also on line 3');
    });

    it('refuses a row with more cells than the header — a comma outside quotes', () => {
      const { rows } = preview([[...row('PRU-001', 'Rina'), '1', '2']]);
      expect(rows[0].issues[0].code).toBe('UPLOAD_MALFORMED_CSV');
    });

    it('reads a short row as blanks, and skips a row with nothing in it', () => {
      const { rows, summary } = preview([['PRU-001', 'Rina', '1'], ['', '', '']]);
      expect(summary.rows).toBe(1);
      expect(cell(rows[0], 'APE').after).toBe(100_000_000);
      expect(cell(rows[0], 'FYP').status).toBe('not_provided');
    });
  });

  describe('AC-8, AC-9 — a diff against what is stored, never a file echoed', () => {
    const stored = { 'm-rina': { values: { APE: 100_000_000, FYP: 50_000_000, POLICY_COUNT: 1 } } };

    it('says new, changed and unchanged against the stored figure', () => {
      const { rows, summary } = preview([row('PRU-001', 'Rina', { APE: '1', POLICY_COUNT: '2', RECRUITMENT: '1' })], { stored });
      expect(cell(rows[0], 'APE')).toMatchObject({ status: 'unchanged', before: 100_000_000, after: 100_000_000 });
      expect(cell(rows[0], 'POLICY_COUNT')).toMatchObject({ status: 'changed', before: 1, after: 2 });
      expect(cell(rows[0], 'RECRUITMENT')).toMatchObject({ status: 'new', before: null, after: 1 });
      expect(summary).toMatchObject({ newCells: 1, changedCells: 1, unchangedCells: 1 });
    });

    it('previews a blank cell as not provided, keeping what is stored — never as a figure cleared', () => {
      const { rows } = preview([row('PRU-001', 'Rina')], { stored });
      expect(cell(rows[0], 'FYP')).toMatchObject({ status: 'not_provided', before: 50_000_000, after: null });
    });

    it('counts the active members the file does not list — they keep what they have', () => {
      expect(preview([row('PRU-001', 'Rina')]).summary.notInFile).toBe(3);
    });
  });

  describe('AC-11 — a file that came back through a spreadsheet (ADR-0052)', () => {
    it('reads Excel under Indonesian settings: ; delimiter, decimal commas, Windows-1252, CRLF — a version 1 header', () => {
      const header = TEMPLATE_HEADER_V1.join(';');
      const line = ['00088213', 'Sari Dewi', '1,5', '92,5', '1', '0', '0,75', '3', '4,5', '90', '2', '1', '2,25', '9'].join(';');
      const text = `${header}\r\n${line.replace('00088213', '88213')}\r\n;;;;;;;;;;;;;\r\n`;
      // A plain "CSV" save: the em dash is 0x97, which is not UTF-8.
      const bytes = Uint8Array.from([...text].flatMap((ch) => (ch === '—' ? [0x97] : [...utf8(ch)])));

      const read = readUpload(bytes);
      expect(read).toMatchObject({ encoding: 'windows-1252', delimiter: ';' });
      const layout = layoutOf(read.header, V1(), '2026-09', SOURCE_READER);
      const { rows, summary } = buildPreview({
        records: read.records, delimiter: read.delimiter, header: read.header, layout, month: '2026-09', roster: ROSTER,
        stored: () => NOTHING, rules: NO_RULES,
      }, SOURCE_READER);
      expect(summary).toMatchObject({ rows: 1, ready: 1, refused: 0, newCells: 6, refusedCells: 0 });
      expect(rows[0]).toMatchObject({ membershipId: 'm-sari', codeRecovered: true, resolvedAgentCode: '00088213' });
      expect(cell(rows[0], 'APE').after).toBe(150_000_000);
      expect(cell(rows[0], 'PERSISTENCY').after).toBe(92.5);
    });

    it('refuses a file of blank lines as empty', () => {
      const empty = refusalOf(() => readUpload(utf8('\n\n  \n')));
      expect(empty.code).toBe('UPLOAD_MALFORMED_CSV');
      expect([empty.message, empty.messageFor(readerIn('id'))]).toEqual(['The file is empty.', 'File ini kosong.']);
    });
  });

  /** **ADR-0184: an Excel workbook, read through the same checks.** */
  describe('ADR-0184 — a filled Excel template', () => {
    const workbook = async (rows: (string | number)[][], header: readonly string[] = HEADER, sheet = 'Data') => {
      const book = new Workbook();
      const data = book.addWorksheet(sheet);
      data.getColumn(1).numFmt = '@';
      data.addRow([...header]);
      rows.forEach((cells, i) => { data.getRow(i + 2).values = cells as never; });
      return new Uint8Array(await book.xlsx.writeBuffer());
    };

    it('reads the Data sheet: numbers as numbers, a code’s zeros kept, each record numbered as the sheet numbers it', async () => {
      const read = await readFileUpload(await workbook([[], ['00088213', 'Sari Dewi', 1.5, 92]]));
      expect(read).toMatchObject({ format: 'xlsx', encoding: 'utf-8', delimiter: ',', header: HEADER });
      expect(read.records.map((r) => r.line)).toEqual([2, 3]);
      expect(read.records[1].cells.slice(0, 4)).toEqual(['00088213', 'Sari Dewi', '1.5', '92']);
    });

    it('finds the upload’s sheet by its Agent Code header when the tab was renamed', async () => {
      const read = await readFileUpload(await workbook([], HEADER, 'Agustus'));
      expect(read).toMatchObject({ format: 'xlsx', records: [] });
    });

    it('refuses a workbook with nothing in its Data sheet as empty', async () => {
      const book = new Workbook();
      book.addWorksheet('Data');
      await expect(readFileUpload(new Uint8Array(await book.xlsx.writeBuffer())))
        .rejects.toMatchObject({ code: 'UPLOAD_MALFORMED_CSV', message: 'The file is empty.' });
    });

    it('reads anything that is not a ZIP as a CSV, as before', async () => {
      await expect(readFileUpload(utf8(`${HEADER.join(',')}\nPRU-001,"Rina Wijaya",1.5`)))
        .resolves.toMatchObject({ format: 'csv', encoding: 'utf-8', delimiter: ',' });
    });
  });
});
