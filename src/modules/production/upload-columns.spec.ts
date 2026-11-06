import { english } from '../../../test/i18n';
import { analyticsConfigV1 } from '@/modules/config/analytics-config';
import {
  byKode, cellKey, cellPath, columnsInForce, fieldInForce, inForce, keyOfLegacy, LEGACY_CELLS, outsideLimits, parseCellKey,
  refusalForField, rekeyByKode, toFile, toStored,
} from './upload-columns';
import {
  historyOf, missingMonthsOf, monthFill, monthsBetween, shiftMonth, type FillPerson, type MonthFill,
} from './upload-completeness';
import type { KodeRow } from './monthly-agent-data.repository';
import type { MetricValue } from './monthly-agent-data.schema';

const M = 1_000_000 * 100;
const V1 = () => analyticsConfigV1({ effectiveFrom: '2024-01' });

/** **The Data upload's columns, by kode** (P19.5-T2; ADR-0214 §5, §9) — the pure half, pinned. */
describe('upload columns (P19.5-T2)', () => {
  it('P19.5-T2 AC-1 names a cell by its kode, and an uploaded year to date by <KODE>_YTD; stores it in values or ytdValues', () => {
    expect([cellKey('APE', false), cellKey('KOMISI', true)]).toEqual(['APE', 'KOMISI_YTD']);
    expect([parseCellKey('APE'), parseCellKey('KOMISI_YTD')]).toEqual([{ kode: 'APE', ytd: false }, { kode: 'KOMISI', ytd: true }]);
    expect([cellPath('APE', false), cellPath('KOMISI', true)]).toEqual(['values.APE', 'ytdValues.KOMISI']);
  });

  it('P19.5-T2 AC-4 R2 a column is in force from its effectiveFrom on — before it the month asks nothing of it', () => {
    const config = V1();
    config.uploadFields.push({ ...config.uploadFields[0], kode: 'FYC', system: false, effectiveFrom: '2026-12' });
    expect(inForce({ effectiveFrom: '2026-12' }, '2026-11')).toBe(false);
    expect(inForce({ effectiveFrom: '2026-12' }, '2026-12')).toBe(true);
    expect(columnsInForce(config, '2026-11').map((f) => f.kode)).not.toContain('FYC');
    expect(columnsInForce(config, '2026-12').map((f) => f.kode)).toContain('FYC');
    // ADR-0214 §6: a custom kode the template does not hold, or not yet, reads nothing — never 0.
    expect(fieldInForce(config, 'FYC', '2026-11')).toBeNull();
    expect(fieldInForce(config, 'BONUS', '2026-12')).toBeNull();
    expect(fieldInForce(config, 'PERSISTENCY', '2026-12')?.kode).toBe('PERSISTENCY');
  });

  it('P19.5-T2 AC-5 checks a value against its column’s own limits, in the column’s unit; money in sen, compared in Rp juta', () => {
    const money = { unit: 'rp_million' as const, min: 0, max: 500 };
    expect(toStored('rp_million', 1.5)).toBe(150_000_000);
    expect(toFile('rp_million', 150_000_000)).toBe(1.5);
    expect(refusalForField(money, 500 * M)).toBeNull();
    expect(english(refusalForField(money, 501 * M))).toBe('is above this column\'s maximum, 500.');
    expect(english(refusalForField(money, -1))).toBe('is negative.');
    expect(english(refusalForField(money, 1.5))).toBe('is a fraction of a sen.');
    expect(english(refusalForField({ unit: 'count', min: 1, max: null }, 0))).toBe('is below this column\'s minimum, 1.');
    expect(english(refusalForField({ unit: 'count', min: null, max: null }, 2.5))).toBe('is not a whole number — this column counts.');
    expect(english(refusalForField({ unit: 'percent', min: 0, max: 100 }, 105))).toBe('is above 100 — persistency is a percentage.');
    expect(english(refusalForField({ unit: 'percent', min: null, max: null }, 101))).toBe('is above 100 — persistency is a percentage.');
    expect(english(refusalForField({ unit: 'count', min: null, max: null }, Number.NaN))).toBe('is not a number.');
  });

  it('P19.5-T2 AC-11 AA UI-025 knows a stored value outside the limits now — flagged, never changed', () => {
    expect(outsideLimits({ unit: 'percent', min: 0, max: 100 }, 105)).toBe(true);
    expect(outsideLimits({ unit: 'percent', min: 0, max: 100 }, 100)).toBe(false);
    expect(outsideLimits({ unit: 'rp_million', min: 1, max: null }, 50 * M)).toBe(false);
  });

  it('P19.5-T2 AC-15 moves every legacy cell whole to its kode; a cell with neither a value nor a provenance is left out', () => {
    expect(Object.keys(LEGACY_CELLS)).toHaveLength(13);
    const corrected: Partial<MetricValue> = { value: 5, provenance: 'corrected', correctedBy: 'm', reason: 'r', replacedValue: 4 };
    const moved = byKode({
      apeMonthly: { value: 1, provenance: 'imported', sourceBatchId: 'b' }, apeYtd: { value: 9, provenance: 'imported' },
      policyCountMonthly: corrected, unitPersistencyMonthly: { value: 80, provenance: 'imported' },
      fypMonthly: { value: null, provenance: null }, persistencyYtd: null, other: { value: 3, provenance: 'imported' },
    });
    expect(moved).toEqual({
      values: { APE: { value: 1, provenance: 'imported', sourceBatchId: 'b' }, POLICY_COUNT: corrected, UNIT_PERSISTENCY: { value: 80, provenance: 'imported' } },
      ytdValues: { APE: { value: 9, provenance: 'imported' } },
    });
    // A figure emptied by hand moves: nothing held, and somebody decided so.
    expect(byKode({ apeMonthly: { value: null, provenance: 'corrected' } }).values.APE).toEqual({ value: null, provenance: 'corrected' });
  });

  it('P19.5-T2 AC-15 re-keys a batch row by kode, so a revert of an older import still puts back what it replaced', () => {
    expect(rekeyByKode({ apeMonthly: 1, apeYtd: 9, unitPersistencyMonthly: 80, APE: 2 })).toEqual({ APE: 2, APE_YTD: 9, UNIT_PERSISTENCY: 80 });
    expect(keyOfLegacy('recruitmentYtd')).toBe('RECRUITMENT_YTD');
    expect(rekeyByKode(null)).toEqual({});
  });
});

/** **`UPLOAD_MONTH_COMPLETE`, the history and the missing months** (P19.5-T2 AC-6, AC-7, AC-8; ADR-0214 §10, §11). */
describe('the completeness of a month, and the history (P19.5-T2)', () => {
  const end = new Date('2026-12-01T00:00:00Z');
  const person = (id: string, leader = false, joined = new Date('2025-01-01T00:00:00Z')): FillPerson => ({
    membershipId: id, leader, counted: { status: 'active', joinedAt: joined, joinDateStart: null, removedAt: null },
  });
  const row = (membershipId: string, month: string, values: Record<string, number | null>): KodeRow => ({
    membershipId, month, asOf: null, ytdValues: {},
    values: Object.fromEntries(Object.entries(values).map(([k, v]) => [k, v === null ? null : { value: v } as MetricValue])),
  });
  const full = { APE: 1, PERSISTENCY: 90, RECRUITMENT: 0, NEW_ACTIVE_AGENTS: 0, FYP: 1, POLICY_COUNT: 1 };

  it('P19.5-T2 AC-6 a month is complete when completePct % of the members have every column in force; missing when nothing is uploaded', () => {
    const config = V1();
    const people = Array.from({ length: 10 }, (_, i) => person(`m${i}`));
    const rows = people.slice(0, 9).map((p) => row(p.membershipId, '2026-11', full));
    expect(monthFill(config, '2026-11', people, rows, end)).toEqual({ month: '2026-11', members: 10, filled: 9, status: 'complete' });
    const eight = rows.slice(0, 8);
    expect(monthFill(config, '2026-11', people, eight, end).status).toBe('incomplete');
    expect(monthFill(config, '2026-11', people, [], end).status).toBe('missing');
    // A member who joined after the month's end is not in its share.
    const late = [...people.slice(0, 9), person('late', false, new Date('2026-12-05T00:00:00Z'))];
    expect(monthFill(config, '2026-11', late, eight, end)).toMatchObject({ members: 9, filled: 8 });
  });

  it('P19.5-T2 AC-6 a leaders’ column counts only on a leader’s row; a column not yet in force counts on none (R2, AT-1)', () => {
    const config = V1();
    config.uploadFields.push({ ...config.uploadFields[0], kode: 'FYC', system: false, effectiveFrom: '2026-12' });
    const agent = person('agent');
    const leader = person('leader', true);
    // Neither holds FYC — it starts in December — and the agent holds no UNIT_PERSISTENCY: both filled in November.
    const rows = [row('agent', '2026-11', full), row('leader', '2026-11', { ...full, UNIT_PERSISTENCY: 80 })];
    expect(monthFill(config, '2026-11', [agent, leader], rows, end)).toMatchObject({ filled: 2, status: 'complete' });
    // The leader without one is not filled.
    expect(monthFill(config, '2026-11', [agent, leader], [rows[0], row('leader', '2026-11', full)], end).filled).toBe(1);
  });

  it('P19.5-T2 AC-8 AT-9 R5 a KPM joining in March 2027 is asked for March 2026 to February 2027, and nothing of 2025', () => {
    expect(historyOf('2027-03')).toEqual({ firstMonth: '2027-03', historyFrom: '2026-03', historyTo: '2027-02' });
    expect(monthsBetween('2026-11', '2027-02')).toEqual(['2026-11', '2026-12', '2027-01', '2027-02']);
    expect([shiftMonth('2027-03', -12), shiftMonth('2026-12', 1), shiftMonth('2026-01', -1)]).toEqual(['2026-03', '2027-01', '2025-12']);
  });

  it('P19.5-T2 AC-7 R4 a column’s year to date is missing each incomplete month from January, its start and the history’s', () => {
    const fills = new Map<string, MonthFill>(
      ['2026-01', '2026-02', '2026-03', '2026-04'].map((m) => [m, { month: m, members: 1, filled: 1, status: 'complete' }]),
    );
    fills.set('2026-03', { month: '2026-03', members: 1, filled: 0, status: 'missing' });
    expect(missingMonthsOf({ effectiveFrom: '2024-01' }, '2026-04', '2025-01', fills)).toEqual(['2026-03']);
    // A column starting in April has nothing missing before it (AT-1).
    expect(missingMonthsOf({ effectiveFrom: '2026-04' }, '2026-04', '2025-01', fills)).toEqual([]);
    // A KPM whose history starts in April is not asked for March (AT-9).
    expect(missingMonthsOf({ effectiveFrom: '2024-01' }, '2026-04', '2026-04', fills)).toEqual([]);
    // A month no fill knows is missing.
    expect(missingMonthsOf({ effectiveFrom: '2024-01' }, '2026-05', '2025-01', fills)).toEqual(['2026-03', '2026-05']);
  });
});
