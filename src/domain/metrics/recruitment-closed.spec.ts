import { recruitmentClosedIn } from './recruitment-closed';

describe('RECRUITMENT_CLOSED_LAST_MONTH (D-recruit)', () => {
  const sep = { start: new Date('2026-08-31T17:00:00Z'), endExclusive: new Date('2026-09-30T17:00:00Z') };

  it('P18-T1 AC-6 counts recruitment leads closed won inside the month, in the office’s zone', () => {
    expect(recruitmentClosedIn([
      { type: 'recruitment', outcome: 'won', outcomeAt: new Date('2026-09-10T03:00:00Z') },
      { type: 'recruitment', outcome: 'won', outcomeAt: new Date('2026-08-31T17:00:00Z') },
      { type: 'recruitment', outcome: 'won', outcomeAt: new Date('2026-09-30T17:00:00Z') }, // 1 Oct in Jakarta
      { type: 'recruitment', outcome: 'lost', outcomeAt: new Date('2026-09-10T03:00:00Z') },
      { type: 'sales', outcome: 'won', outcomeAt: new Date('2026-09-10T03:00:00Z') },
      { type: 'recruitment', outcome: 'won', outcomeAt: null },
      { type: 'recruitment', outcome: null, outcomeAt: null },
    ], sep)).toBe(2);
  });
});
