import { leaderCoachingFrequency, type FrequencySession } from './leader-coaching-frequency';

const daysBetween = (from: string, to: string) => Math.round((Date.parse(to) - Date.parse(from)) / 86_400_000);
const s = (coach: string, coachee: string, date: string | null, status: FrequencySession['status'] = 'finalized'): FrequencySession =>
  ({ coachMembershipId: coach, coacheeMembershipId: coachee, status, date });

describe('LEADER_COACHING_FREQUENCY (§A.3, D-coverage)', () => {
  const base = { leaderMembershipId: 'L', downline: ['L', 'a', 'b', 'c', 'd'], windowDays: 7, today: '2026-10-09', daysBetween };

  it('P18-T1 AC-5 the distinct members of the leader’s downline they coached in the window, over the downline', () => {
    expect(leaderCoachingFrequency({
      ...base,
      sessions: [
        s('L', 'a', '2026-10-08'), s('L', 'a', '2026-10-02'), // twice is one person
        s('L', 'b', '2026-10-02'), // eight days ago counts: today and the seven before it
        s('L', 'c', '2026-10-01'), // nine days ago does not
        s('X', 'd', '2026-10-09'), // somebody else's 1:1 is coverage, not this leader's
        s('L', 'outsider', '2026-10-09'), // not their downline
        s('L', 'd', null, 'draft'),
        s('L', 'd', '2026-10-09', 'draft'),
      ],
    })).toEqual({ teamSize: 4, coached: 2, pct: 50 });
  });

  it('P18-T1 AC-5 a reopened session keeps counting from its date (ADR-0079)', () => {
    expect(leaderCoachingFrequency({ ...base, sessions: [s('L', 'a', '2026-10-05', 'reopened')] }).coached).toBe(1);
  });

  it('P18-T1 AC-9 a downline of nobody is null, never 0%', () => {
    expect(leaderCoachingFrequency({ ...base, downline: ['L'], sessions: [] })).toEqual({ teamSize: 0, coached: 0, pct: null });
  });
});
