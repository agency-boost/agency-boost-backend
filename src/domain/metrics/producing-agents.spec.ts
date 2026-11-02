import type { CountedMembership } from './office-headcount';
import { belongedDuring, producingAgents } from './producing-agents';

const at = (iso: string) => new Date(iso);
/** September 2026 in Jakarta: 1 September 00:00 to 1 October 00:00, local. */
const SEP = { start: at('2026-08-31T17:00:00Z'), end: at('2026-09-30T17:00:00Z') };

const m = (over: Partial<CountedMembership>): CountedMembership => ({
  status: 'active', joinedAt: at('2026-01-02T02:00:00Z'), removedAt: null, ...over,
});
const during = (membership: CountedMembership) => belongedDuring(membership, SEP.start, SEP.end);

describe('PRODUCING_AGENTS (P18.1-T1 AC-4; OD-144, ADR-0136)', () => {
  describe('belonged to the office in the month', () => {
    it('P18.1-T1 AC-4 a member here all month, or since before it with no join date on the row', () => {
      expect(during(m({}))).toBe(true);
      expect(during(m({ joinedAt: null }))).toBe(true);
    });

    it('P18.1-T1 AC-4 a member who joined in the month belonged to it; one who joined after it ended did not', () => {
      expect(during(m({ joinedAt: at('2026-09-30T16:59:00Z') }))).toBe(true);
      expect(during(m({ joinedAt: SEP.end }))).toBe(false);
    });

    it('P18.1-T1 AC-4 a member removed during the month belonged to it (OD-74); one removed before it began did not', () => {
      expect(during(m({ status: 'removed', removedAt: at('2026-09-12T03:00:00Z') }))).toBe(true);
      expect(during(m({ status: 'removed', removedAt: SEP.start }))).toBe(false);
      expect(during(m({ status: 'removed', removedAt: null }))).toBe(false);
    });

    it('P18.96-T5 AC-1 by the join date, joinedAt only where there is none (ADR-0172 §1)', () => {
      // Started on 20 September, let in on 3 October: September is one of theirs; August is not.
      const hire = m({ joinDateStart: at('2026-09-19T17:00:00Z'), joinedAt: at('2026-10-03T03:00:00Z') });
      expect(during(hire)).toBe(true);
      expect(belongedDuring(hire, at('2026-07-31T17:00:00Z'), SEP.start)).toBe(false);
      // A join date after the month, whatever the stamp says.
      expect(during(m({ joinDateStart: SEP.end, joinedAt: at('2026-09-02T03:00:00Z') }))).toBe(false);
    });

    it('P18.1-T1 AC-4 a pending membership never belonged', () => {
      expect(during(m({ status: 'pending', joinedAt: null }))).toBe(false);
    });
  });

  it('P18.1-T1 AC-4 counts the members active in at least one month held that they belonged in, each once', () => {
    expect(producingAgents([[true, true], [false, true], [false, false], [null, null], []], 2)).toBe(2);
  });

  it('P18.1-T1 AC-4 is pending — null, never 0 — when no month of the period is held', () => {
    expect(producingAgents([[], []], 0)).toBeNull();
    expect(producingAgents([], 3)).toBe(0);
  });
});
