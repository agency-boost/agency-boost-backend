import { frozenBeforeTheSlide } from '../../../../test/frozen-scorecard';
import { frozenRecord, liveRecord } from './scorecard-record';
import { columnPeriods } from './scorecard.service';
import { COLUMN_KEYS, ROW_KEYS, type ComputedScorecard } from './scorecard.types';

const M = 1_000_000 * 100;

/**
 * **P18.9-T1 AC-19 — a frozen scorecard, read tolerantly** (ADR-0175 §8, ADR-0129 §7; parity I-495): what it lacks
 * reads *—*, what it has that the table no longer draws is kept and not served, its *# of units* is the one it froze
 * with, and nothing is recomputed. The service-level read, which writes nothing, is `leader-meetings.freeze.int.spec.ts`.
 */
describe('P18.9-T1 AC-19 a frozen scorecard, read tolerantly', () => {
  const stored = frozenBeforeTheSlide();
  const record = frozenRecord(stored, '2026-09-12');
  const row = (key: string) => record.rows.find((r) => r.key === key)!;

  it('P18.9-T1 AC-19 the tolerant read serves the current rows in the slide’s order, New AA kept on the meeting and not served', () => {
    expect(record.rows.map((r) => r.key)).toEqual([...ROW_KEYS]);
    expect(record.rows.some((r) => (r.key as string) === 'new_aa')).toBe(false);
    // Kept: the stored shape is not touched by the read.
    expect(stored).toEqual(frozenBeforeTheSlide());
  });

  it('P18.9-T1 AC-19 the tolerant read: the YTD of last year it lacks reads — on every row; every figure it has is the one it froze', () => {
    for (const r of record.rows) {
      expect([r.key, r.cells.ytdLastYear]).toEqual([r.key, { kind: 'unrecorded' }]);
      expect(Object.keys(r.cells)).toEqual([...COLUMN_KEYS]);
    }
    expect(row('ape').cells.fy).toEqual({ kind: 'figure', value: 1_800 * M, leavesOut: ['2025-01'] });
    expect(row('ape').cells.lastMonth).toEqual({ kind: 'pending' });
    expect(row('case_submission').cells.ytd).toEqual({ kind: 'figure', value: 310, leavesOut: ['2026-08'] });
    expect(row('producing_agents').cells.thisMonth).toEqual({ kind: 'blocked' });
  });

  it('P18.9-T1 AC-19 the tolerant read: Cases/producing agents, which it lacks, reads — over the years and Not tracked by the month', () => {
    expect(row('cases_per_producing_agent').cells).toEqual({
      fy: { kind: 'unrecorded' }, ytdLastYear: { kind: 'unrecorded' }, ytd: { kind: 'unrecorded' },
      thisMonthLastYear: { kind: 'blocked' }, lastMonth: { kind: 'blocked' }, thisMonth: { kind: 'blocked' },
    });
    expect(row('cases_per_producing_agent').unit).toBe('ratio');
  });

  it('P18.9-T1 AC-19 the tolerant read: no AS OF reads —; # of units the five it froze with; the periods the meeting’s', () => {
    expect(record.asOf).toEqual({ kind: 'unrecorded' });
    expect(record.chips).toEqual({ manpower: 26, agents: 17, units: 5, ab: 5, aab: 4 });
    expect(record.periods).toEqual(columnPeriods('2026-09-12'));
    expect(record.periods.ytdLastYear).toEqual({ from: '2025-01', to: '2025-09' });
  });

  it('P18.9-T1 AC-19 the tolerant read of a scorecard frozen in today’s shape is that scorecard, AS OF and all', () => {
    const today: ComputedScorecard = {
      periods: columnPeriods('2026-10-27'),
      chips: { manpower: 28, agents: 19, units: 9, ab: 5, aab: 4 },
      rows: ROW_KEYS.map((key) => ({
        key, unit: key === 'ape' ? 'idr_minor' : 'count',
        cells: Object.fromEntries(COLUMN_KEYS.map((c) => [c, { kind: 'figure', value: 1, leavesOut: [] }])) as never,
      })),
      asOf: '2026-10-26',
      definitions: 'data_sources',
    };
    const read = frozenRecord(JSON.parse(JSON.stringify(today)), '2026-10-27');
    expect(read.rows.map((r) => r.cells)).toEqual(today.rows.map((r) => r.cells));
    expect(read.asOf).toEqual({ kind: 'date', date: '2026-10-26' });
    expect(frozenRecord({ ...today, asOf: null }, '2026-10-27').asOf).toEqual({ kind: 'none' });
    expect(liveRecord(today).asOf).toEqual({ kind: 'date', date: '2026-10-26' });
  });

  it('P18.9-T1 AC-19 the tolerant read takes nothing it cannot read as a figure: a broken cell, row or record reads —', () => {
    const broken = frozenRecord({ rows: [{ key: 'ape', cells: { fy: { kind: 'figure', value: 'x' }, ytd: { kind: 'maybe' } } }], chips: {} }, '2026-09-12');
    const ape = broken.rows.find((r) => r.key === 'ape')!;
    expect([ape.cells.fy, ape.cells.ytd]).toEqual([{ kind: 'unrecorded' }, { kind: 'unrecorded' }]);
    expect(broken.chips).toEqual({ manpower: 0, agents: 0, units: 0, ab: 0, aab: 0 });
    expect(frozenRecord(null, '2026-09-12').rows).toHaveLength(ROW_KEYS.length);
    // A figure kept without the months it left out, or with something else in their place, left none out.
    const bare = frozenRecord({ rows: [{ key: 'ape', cells: { fy: { kind: 'figure', value: 7 }, ytd: { kind: 'figure', value: 8, leavesOut: [3, '2026-08'] } } }] }, '2026-09-12');
    const bareApe = bare.rows.find((r) => r.key === 'ape')!;
    expect([bareApe.cells.fy, bareApe.cells.ytd]).toEqual([
      { kind: 'figure', value: 7, leavesOut: [] }, { kind: 'figure', value: 8, leavesOut: ['2026-08'] },
    ]);
  });

  describe('P19.3-T1 AC-7, AC-15 the definitions a frozen scorecard was computed with (ADR-0202 §4, ADR-0203)', () => {
    it('P19.3-T1 AC-7 one frozen before the data sources stores none and reads reference_slide: its footnotes are ADR-0171’s', () => {
      expect(record.definitions).toBe('reference_slide');
      // Whatever else a value says, nobody wrote today's: the older reading.
      expect(frozenRecord({ ...stored, definitions: 'something else' }, '2026-09-12').definitions).toBe('reference_slide');
      expect(frozenRecord(null, '2026-09-12').definitions).toBe('reference_slide');
    });

    it('P19.3-T1 AC-7 one frozen since stores data_sources and reads it back; a live one is data_sources', () => {
      const card: ComputedScorecard = {
        periods: columnPeriods('2026-11-20'),
        chips: { manpower: 28, agents: 19, units: 7, ab: 5, aab: 4 },
        rows: [],
        asOf: '2026-11-03',
        definitions: 'data_sources',
      };
      expect(frozenRecord(JSON.parse(JSON.stringify(card)), '2026-11-20').definitions).toBe('data_sources');
      expect(liveRecord(card).definitions).toBe('data_sources');
    });

    it('P19.3-T1 AC-15 a year-before cell frozen as not uploaded reads back as it froze: —, never pending or a figure', () => {
      const read = frozenRecord({ rows: [{ key: 'flc', cells: { fy: { kind: 'not_uploaded' }, ytdLastYear: { kind: 'not_uploaded' } } }] }, '2026-11-20');
      const flc = read.rows.find((r) => r.key === 'flc')!;
      expect([flc.cells.fy, flc.cells.ytdLastYear]).toEqual([{ kind: 'not_uploaded' }, { kind: 'not_uploaded' }]);
    });
  });
});
