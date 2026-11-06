import { countedFrom, memberAt, officeHeadcount, officeNewMembers, type CountedMembership } from './office-headcount';
import { rateOver } from './rate';

const at = (iso: string) => new Date(iso);
/** The end of 30 September in Jakarta: 1 October 00:00 local. */
const END_OF_SEP_30 = at('2026-09-30T17:00:00Z');

const m = (over: Partial<CountedMembership>): CountedMembership => ({
  status: 'active', joinedAt: at('2026-01-02T02:00:00Z'), removedAt: null, ...over,
});

describe('OFFICE_HEADCOUNT and OFFICE_NEW_MEMBERS_THIS_MONTH (OD-24, OD-74)', () => {
  it('P18-T6 AC-5 counts the active memberships on the period’s last day: every rung, the Owner and the Admins as members', () => {
    expect(officeHeadcount([m({}), m({}), m({})], END_OF_SEP_30)).toBe(3);
  });

  it('P18-T6 AC-5 never counts a pending membership', () => {
    expect(memberAt(m({ status: 'pending', joinedAt: null }), END_OF_SEP_30)).toBe(false);
  });

  it('P18-T6 AC-5 counts a leaver only before they left (OD-74), and never one with no removal date', () => {
    const left = m({ status: 'removed', removedAt: at('2026-09-15T05:00:00Z') });
    expect(memberAt(left, at('2026-09-14T17:00:00Z'))).toBe(true);
    expect(memberAt(left, at('2026-09-15T17:00:00Z'))).toBe(false);
    expect(memberAt(left, END_OF_SEP_30)).toBe(false);
    expect(memberAt(m({ status: 'removed', removedAt: null }), END_OF_SEP_30)).toBe(false);
  });

  it('P18-T6 AC-5 does not count somebody who joined after the day ended; counts an active row older than joinedAt', () => {
    expect(memberAt(m({ joinedAt: at('2026-10-01T03:00:00Z') }), END_OF_SEP_30)).toBe(false);
    expect(memberAt(m({ joinedAt: END_OF_SEP_30 }), END_OF_SEP_30)).toBe(false);
    expect(memberAt(m({ joinedAt: null }), END_OF_SEP_30)).toBe(true);
  });

  it('P18-T1 AC-3 new this month: members now whose membership began this month, a rejoiner on their new membership', () => {
    const monthStart = at('2026-08-31T17:00:00Z');
    const rows = [
      m({ joinedAt: at('2026-09-03T03:00:00Z') }),
      m({ joinedAt: at('2026-08-31T16:59:00Z') }),
      m({ status: 'removed', joinedAt: at('2026-09-02T03:00:00Z'), removedAt: at('2026-09-20T03:00:00Z') }),
      m({ joinedAt: null }),
    ];
    expect(officeNewMembers(rows, monthStart, END_OF_SEP_30)).toBe(1);
  });

  /**
   * **ADR-0172 §1, P18.8-T5 AC-1** — a member counts from their join date, an office date the reader gives as the instant
   * its day begins (`joinDateStart`); `joinedAt`, the system's stamp, only where there is none.
   */
  describe('from the join date (ADR-0172 §1)', () => {
    /** 1 October 00:00 in Jakarta: the first instant of a join date of 2026-10-01. */
    const OCT_1 = at('2026-09-30T17:00:00Z');
    const SEP_20 = at('2026-09-19T17:00:00Z');

    it('P18.8-T5 AC-1 a new hire approved after they started counts from the day they started, not the approval', () => {
      // Started on 20 September, let in on 3 October: in September's headcount.
      const hire = m({ joinDateStart: SEP_20, joinedAt: at('2026-10-03T03:00:00Z') });
      expect(countedFrom(hire)).toEqual(SEP_20);
      expect(memberAt(hire, END_OF_SEP_30)).toBe(true);
      expect(memberAt(hire, at('2026-09-19T17:00:00Z'))).toBe(false);
      expect(officeHeadcount([hire, m({})], END_OF_SEP_30)).toBe(2);
    });

    it('P18.8-T5 AC-1 a join date after the day is not a member then, whenever the system let them in', () => {
      expect(memberAt(m({ joinDateStart: OCT_1, joinedAt: at('2026-09-02T03:00:00Z') }), END_OF_SEP_30)).toBe(false);
      expect(memberAt(m({ joinDateStart: OCT_1 }), at('2026-10-01T17:00:00Z'))).toBe(true);
    });

    it('P18.8-T5 AC-1 a row with no join date counts from joinedAt, as before', () => {
      expect(countedFrom(m({ joinDateStart: null }))).toEqual(at('2026-01-02T02:00:00Z'));
      expect(memberAt(m({ joinDateStart: null, joinedAt: at('2026-10-01T03:00:00Z') }), END_OF_SEP_30)).toBe(false);
      expect(memberAt(m({ joinDateStart: undefined, joinedAt: null }), END_OF_SEP_30)).toBe(true);
    });

    it('P18.8-T5 AC-1 a leaver still leaves on their removal, whatever their join date (ADR-0136)', () => {
      const left = m({ status: 'removed', joinDateStart: SEP_20, removedAt: at('2026-09-25T03:00:00Z') });
      expect(memberAt(left, at('2026-09-24T17:00:00Z'))).toBe(true);
      expect(memberAt(left, END_OF_SEP_30)).toBe(false);
    });

    it('P18.8-T5 AC-1 new this month is by the join date: an existing agent added today with an old one is not new', () => {
      const monthStart = at('2026-08-31T17:00:00Z');
      const rows = [
        m({ joinDateStart: at('2015-03-01T17:00:00Z'), joinedAt: at('2026-09-29T03:00:00Z') }),
        m({ joinDateStart: SEP_20, joinedAt: at('2026-09-25T03:00:00Z') }),
        m({ joinDateStart: at('2026-08-24T17:00:00Z'), joinedAt: at('2026-09-02T03:00:00Z') }),
      ];
      expect(officeNewMembers(rows, monthStart, END_OF_SEP_30)).toBe(1);
      expect(officeHeadcount(rows, END_OF_SEP_30)).toBe(3);
    });
  });

  it('P18-T1 AC-9 a rate over nobody is null, never 0% and never a division by zero; rounded half up', () => {
    expect(rateOver(0, 0)).toEqual({ count: 0, of: 0, pct: null });
    expect(rateOver(118, 187)).toEqual({ count: 118, of: 187, pct: 63 });
    expect(rateOver(1, 8)).toEqual({ count: 1, of: 8, pct: 13 });
  });
});
