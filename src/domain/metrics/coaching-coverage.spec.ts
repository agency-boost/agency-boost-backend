import { FixedClock } from '@/common/clock/clock.port';
import { addDays } from '@/common/time/local-day';
import { COACHING } from '@/domain/constants';
import { coachingCoverage, type CoverageSession } from './coaching-coverage';
import { coached30d, coached7d, daysSinceLastCoaching } from './coaching-recency';

const TZ = 'Asia/Jakarta';
const TODAY = '2026-10-02';
const clock = new FixedClock(new Date('2026-10-02T03:00:00Z'));
/** The office's calendar arithmetic, as the readings pass it. */
const days = (from: string, to: string) => clock.daysBetween(TZ, from, to);

const LEADER = 'leader';
/** A session finalized `ago` days before today, about `who`. */
const held = (who: string, ago: number, status: CoverageSession['status'] = 'finalized'): CoverageSession => ({
  coacheeMembershipId: who, status, date: addDays(TODAY, -ago),
});

const coverage = (scope: string[], sessions: CoverageSession[], leader: string | null = LEADER) =>
  coachingCoverage({ scope, leaderMembershipId: leader, sessions, today: TODAY, daysBetween: days });

/**
 * **`COACHING_COVERAGE`, against its definition** (`metrics-and-definitions.md` §A.3, P11-T10 AC-5;
 * the phase file's exit criterion 4): `count(members where COACHED_nD) / count(members in scope)`, rounded
 * to a whole percent, the denominator the scope less its leader, for both windows of
 * `COACHING_COVERAGE_WINDOWS` (§B.4). No route serves it in this phase.
 */
describe('COACHING_COVERAGE (§A.3, P11-T10 AC-5)', () => {
  it('P11-T10 AC-5 answers both windows, the primary first: COACHED_7D, then COACHED_30D', () => {
    const [week, month] = coverage([LEADER, 'a', 'b', 'c', 'd'], [held('a', 0), held('b', 7), held('c', 8), held('d', 31)]);

    expect(COACHING.COVERAGE_WINDOWS).toEqual([7, 30]);
    // `<= 7` spans eight calendar dates: a 1:1 seven days ago is inside, eight days ago is not.
    expect(week).toEqual({ windowDays: 7, coached: 2, members: 4, pct: 50 });
    // Thirty days is inside the safety net, thirty-one is not.
    expect(month).toEqual({ windowDays: 30, coached: 3, members: 4, pct: 75 });
  });

  it('P11-T10 AC-5 is COACHED_nD per member, counted: the same answer the per-member metric gives', () => {
    const scope = ['a', 'b', 'c', 'd', 'e', 'f'];
    const sessions = [held('a', 1), held('b', 6), held('c', 9), held('d', 29), held('e', 30), held('f', 45)];
    const latest = new Map(sessions.map((s) => [s.coacheeMembershipId, s.date]));
    const perMember = scope.map((id) => daysSinceLastCoaching(latest.get(id) ?? null, TODAY, days));

    const [week, month] = coverage(scope, sessions);

    expect(week.coached).toBe(perMember.filter(coached7d).length);
    expect(month.coached).toBe(perMember.filter(coached30d).length);
  });

  it('P11-T10 AC-5 leaves the leader out of the denominator, coached or not: a leader never coaches themselves', () => {
    const [week] = coverage([LEADER, 'a', 'b'], [held(LEADER, 1), held('a', 1)]);

    expect(week).toEqual({ windowDays: 7, coached: 1, members: 2, pct: 50 });
  });

  it('P11-T10 AC-5 the Owner’s office-wide scope has no leader to leave out', () => {
    const [week] = coverage([LEADER, 'a'], [held(LEADER, 1)], null);

    expect(week).toEqual({ windowDays: 7, coached: 1, members: 2, pct: 50 });
  });

  it('P11-T10 AC-5 rounds to a whole percent as the prototype does: 112 / 187 is 60%, 148 / 187 is 79%', () => {
    // `KPM_Owner.html:1014-1020`'s two figures, from `Math.round(coached / team * 100)` (`:3341`).
    const scope = Array.from({ length: 187 }, (_, i) => `m${i}`);
    const sessions = scope.flatMap((id, i) => {
      if (i < 112) return [held(id, 3)];
      if (i < 148) return [held(id, 20)];
      return [];
    });

    const [week, month] = coverage(scope, sessions);

    expect(week).toEqual({ windowDays: 7, coached: 112, members: 187, pct: 60 });
    expect(month).toEqual({ windowDays: 30, coached: 148, members: 187, pct: 79 });
    // A half rounds up: 1 of 8 is 12.5%.
    const eight = Array.from({ length: 8 }, (_, i) => `e${i}`);
    expect(coverage(eight, [held('e0', 0)])[0].pct).toBe(13);
  });

  it('P18.97-T3 F-254 rounds an exact half up in integers: 23 of 40 is 58%, which Math.round(23 / 40 * 100) reads 57', () => {
    const forty = Array.from({ length: 40 }, (_, i) => `f${i}`);
    const [week] = coverage(forty, forty.slice(0, 23).map((id) => held(id, 2)), null);

    expect(Math.round((23 / 40) * 100)).toBe(57);
    expect(week).toEqual({ windowDays: 7, coached: 23, members: 40, pct: 58 });
  });

  it('P11-T10 AC-5 counts finalized sessions only — a reopened one keeps counting from its date, a draft never', () => {
    const [week] = coverage(['a', 'b', 'c'], [
      held('a', 2, 'reopened'),
      { coacheeMembershipId: 'b', status: 'draft', date: null },
      // A draft never has a date; were one to carry one, its status still keeps it out.
      { coacheeMembershipId: 'c', status: 'draft', date: TODAY },
    ]);

    expect(week).toEqual({ windowDays: 7, coached: 1, members: 3, pct: 33 });
  });

  it('P11-T10 AC-5 reads each member’s latest 1:1, whoever led it, and ignores sessions about anybody outside the scope', () => {
    const [week, month] = coverage(['a', 'b'], [held('a', 40), held('a', 3), held('a', 20), held('outsider', 0)]);

    expect(week).toEqual({ windowDays: 7, coached: 1, members: 2, pct: 50 });
    expect(month).toEqual({ windowDays: 30, coached: 1, members: 2, pct: 50 });
  });

  it('P11-T10 AC-5 counts a member listed twice once', () => {
    const [week] = coverage(['a', 'a', 'b'], [held('a', 1)]);

    expect(week).toEqual({ windowDays: 7, coached: 1, members: 2, pct: 50 });
  });

  it('P11-T10 AC-5 a scope of nobody — a leader with no downline — is null, never 0% and never a division by zero', () => {
    for (const result of coverage([LEADER], [held(LEADER, 0)])) {
      expect(result).toMatchObject({ coached: 0, members: 0, pct: null });
    }
    expect(coverage([], []).map((r) => r.pct)).toEqual([null, null]);
  });

  it('P11-T10 AC-5 a scope nobody was coached in is 0% in both windows', () => {
    expect(coverage(['a', 'b'], []).map((r) => r.pct)).toEqual([0, 0]);
  });

  it('P11-T10 AC-5 counts days in the office’s calendar: the day boundary is Jakarta’s, not the server’s', () => {
    // 2026-09-24 is eight calendar days before 2026-10-02 in the office's zone, whatever hour it is.
    const [week, month] = coverage(['a'], [{ coacheeMembershipId: 'a', status: 'finalized', date: '2026-09-24' }]);

    expect(week.coached).toBe(0);
    expect(month.coached).toBe(1);
  });
});
