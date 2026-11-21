import { completenessSummary, fieldCompleteness, isDataComplete, missingFields } from './demographic-completeness';

describe('P19.22-T2 Demografi: data completeness (ADR-0275 §2; §A.15)', () => {
  const full = { role: 'ab', workStatus: 'full_time', dateOfBirth: '1980-01-02', joinDate: '2016-05-01' };
  const members = [
    full,
    { role: 'aab', workStatus: null, dateOfBirth: '1990-01-02', joinDate: '2020-05-01' },
    { role: 'agent', workStatus: 'part_time', dateOfBirth: null, joinDate: null },
    { role: 'agent', workStatus: 'full_time', dateOfBirth: '1999-03-10', joinDate: '2024-07-01' },
  ];

  it('P19.22-T2 AC-1 Data lengkap needs Status kerja, Tanggal lahir and Tanggal bergabung; gender is not required', () => {
    expect(isDataComplete(full)).toBe(true);
    expect(missingFields(members[2])).toEqual(['dateOfBirth', 'joinDate']);
    expect(missingFields({ ...full, workStatus: '' })).toEqual(['workStatus']);
  });

  it('P19.22-T2 AC-1 the summary: Data lengkap and Perlu melengkapi, with their shares', () => {
    expect(completenessSummary(members)).toEqual({ complete: 2, incomplete: 2, completePct: 50, incompletePct: 50 });
    expect(completenessSummary([])).toEqual({ complete: 0, incomplete: 0, completePct: null, incompletePct: null });
  });

  it('P19.22-T2 AC-1 Kelengkapan data per field, overall and Leader vs Agent', () => {
    expect(fieldCompleteness(members)).toEqual([
      { field: 'workStatus', filled: 3, of: 4, pct: 75, leaderPct: 50, agentPct: 100 },
      { field: 'dateOfBirth', filled: 3, of: 4, pct: 75, leaderPct: 100, agentPct: 50 },
      { field: 'joinDate', filled: 3, of: 4, pct: 75, leaderPct: 100, agentPct: 50 },
    ]);
    expect(fieldCompleteness([full])[0]).toMatchObject({ leaderPct: 100, agentPct: null });
  });
});
