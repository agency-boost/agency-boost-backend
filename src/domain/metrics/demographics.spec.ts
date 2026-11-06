import { DEMOGRAPHICS } from '@/domain/constants';
import { ageBandOf, manpowerByDimension, tenureBandOf, wholeYears, type DemographicsMember } from './demographics';

const at = (day: string) => new Date(`${day}T00:00:00Z`);
const BANDS = { ageBandUpper: DEMOGRAPHICS.AGE_BAND_UPPER_DEFAULT, ageLabelFloor: DEMOGRAPHICS.AGE_LABEL_FLOOR, tenureBands: DEMOGRAPHICS.TENURE_BANDS_DEFAULT };
const RUNGS = [{ code: 'AB', label: 'AB' }, { code: 'AAB', label: 'AAB' }, { code: 'AGENT', label: 'Agen' }];

function person(over: Partial<DemographicsMember>): DemographicsMember {
  return {
    orgLevelCode: 'AGENT', workStatus: 'full_time', gender: 'female', dateOfBirth: '1995-05-05', joinDate: '2020-01-01',
    counted: { status: 'active', joinedAt: null, joinDateStart: at(over.joinDate ?? '2020-01-01'), removedAt: null },
    ...over,
  };
}

describe('P19.5-T3 MANPOWER_BY_DIMENSION — Demographics (ADR-0215 §3; OWN UI-024, R6)', () => {
  it('P19.5-T3 AC-2 OWN Case 6 every dimension sums to manpower, 28; a missing field is Belum diisi, never dropped', () => {
    const members = Array.from({ length: 28 }, (_, i) => i).map((i) => person({
      orgLevelCode: i < 3 ? 'AB' : i < 8 ? 'AAB' : 'AGENT',
      workStatus: i % 7 === 0 ? null : i % 2 === 0 ? 'full_time' : 'part_time',
      gender: i % 5 === 0 ? null : i % 2 === 0 ? 'male' : 'female',
      dateOfBirth: i % 9 === 0 ? null : `${1970 + i}-03-01`,
      joinDate: i % 11 === 0 ? null : `${2012 + (i % 14)}-02-01`,
    }));
    const leaver = person({ counted: { status: 'removed', joinedAt: null, joinDateStart: at('2020-01-01'), removedAt: at('2026-09-01') } });
    const d = manpowerByDimension([...members, leaver], { endOfDay: at('2026-11-01'), lastDay: '2026-10-31' }, RUNGS, BANDS);
    expect(d.manpower).toBe(28);
    for (const dimension of [d.role, d.workStatus, d.gender, d.ageBand, d.tenureBand]) {
      expect(dimension.reduce((sum, row) => sum + row.count, 0)).toBe(28);
    }
    expect(d.role.map((r) => [r.key, r.label, r.count])).toEqual([['AB', 'AB', 3], ['AAB', 'AAB', 5], ['AGENT', 'Agen', 20]]);
    expect(d.gender.find((g) => g.key === 'unset')!.count).toBeGreaterThan(0);
    expect(d.ageBand.find((g) => g.key === 'unset')!.count).toBeGreaterThan(0);
  });

  it('P19.5-T3 AC-2 OWN Case 9 the bands: Gen Z 17–29 · Gen Y 30–45 · Gen X 46+; tenure < 3 · 3–7 · 7–10 · > 10', () => {
    expect(ageBandOf(29, [29, 45])).toBe('gen_z');
    expect(ageBandOf(30, [29, 45])).toBe('gen_y');
    expect(ageBandOf(46, [29, 45])).toBe('gen_x');
    expect(tenureBandOf(2.9, [3, 7, 10])).toBe(0);
    expect(tenureBandOf(7, [3, 7, 10])).toBe(7);
    expect(tenureBandOf(10, [3, 7, 10])).toBe(10);
    expect(wholeYears('1996-11-01', '2026-10-31')).toBe(29);
    expect(wholeYears('1996-10-31', '2026-10-31')).toBe(30);
    const d = manpowerByDimension([person({})], { endOfDay: at('2026-11-01'), lastDay: '2026-10-31' }, RUNGS, BANDS);
    expect(d.ageBand.map((b) => [b.key, b.from ?? null, b.to ?? null])).toEqual([
      ['gen_z', 17, 29], ['gen_y', 30, 45], ['gen_x', 46, null], ['unset', null, null],
    ]);
    expect(d.tenureBand.map((b) => [b.key, b.from ?? null, b.to ?? null])).toEqual([
      ['0', null, 3], ['3', 3, 7], ['7', 7, 10], ['10', 10, null], ['unset', null, null],
    ]);
  });

  it('P19.5-T3 AC-2 a template’s own bands are read: Gen Z to 25', () => {
    const d = manpowerByDimension([person({ dateOfBirth: '1999-01-01' })], { endOfDay: at('2026-11-01'), lastDay: '2026-10-31' }, RUNGS,
      { ...BANDS, ageBandUpper: [25, 40] });
    expect(d.ageBand.find((b) => b.key === 'gen_y')).toMatchObject({ count: 1, from: 26, to: 40 });
  });
});
