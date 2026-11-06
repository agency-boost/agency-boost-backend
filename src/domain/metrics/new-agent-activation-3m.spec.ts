import { NEW_AGENT_ACTIVATION_MONTHS_AFTER_JOIN } from '@/domain/constants';
import { activation3MOf, activation3MShare, newHireStatusOf } from './activation-3m';
import {
  newAgentActivationOf, newAgentActivationShare, newAgentActivationWindow, type WindowMonth,
} from './new-agent-activation-3m';

/** A file: the months held, and the hire's policies in some of them. */
const fileOf = (held: readonly string[], policies: Record<string, number | null> = {}) =>
  (month: string): WindowMonth => ({ held: held.includes(month), policies: policies[month] ?? null });

/**
 * **P19.3-T1 AC-7 — `NEW_AGENT_ACTIVATION_3M_PCT`, the forum's *3M new agent %*** (ADR-0202 §1; the data sources' D7):
 * a policy in the office's file in the join month or the three months after it; undecided until every window month is
 * held or one shows a policy; New Hires' *Teraktivasi* (`ACTIVATION_3M`) left as it is.
 */
describe('P19.3-T1 AC-7 NEW_AGENT_ACTIVATION_3M_PCT — a first policy in the join month or the three after (D7)', () => {
  it('P19.3-T1 AC-7 the window is the join month and the three calendar months after it, across a year’s end', () => {
    expect(NEW_AGENT_ACTIVATION_MONTHS_AFTER_JOIN).toBe(3);
    expect(newAgentActivationWindow('2026-01-31')).toEqual(['2026-01', '2026-02', '2026-03', '2026-04']);
    expect(newAgentActivationWindow('2025-11-01')).toEqual(['2025-11', '2025-12', '2026-01', '2026-02']);
    expect(newAgentActivationWindow('2026-12-15')).toEqual(['2026-12', '2027-01', '2027-02', '2027-03']);
  });

  it('P19.3-T1 AC-7 activated by a policy in any held month of the window — the fourth included, a gap before it not waited on', () => {
    const window = ['2026-02', '2026-03', '2026-04', '2026-05'];
    expect(newAgentActivationOf('2026-02-01', fileOf(window, { '2026-05': 1 }))).toBe('activated');
    expect(newAgentActivationOf('2026-02-01', fileOf(window, { '2026-02': 3 }))).toBe('activated');
    // March not held, May shows one: activated, whatever March would have said.
    expect(newAgentActivationOf('2026-02-01', fileOf(['2026-02', '2026-04', '2026-05'], { '2026-05': 1 }))).toBe('activated');
  });

  it('P19.3-T1 AC-7 a policy after the window, or in a month not held, does not activate; APE alone never does', () => {
    const held = ['2026-01', '2026-02', '2026-03', '2026-04', '2026-05'];
    // Joined 31 January: the window is January to April, and May's policy is the fifth month.
    expect(newAgentActivationOf('2026-01-31', fileOf(held, { '2026-05': 2 }))).toBe('not_activated');
    // A figure for a month the office's file does not hold is no figure.
    expect(newAgentActivationOf('2026-01-31', fileOf(['2026-01', '2026-02', '2026-03'], { '2026-04': 1 }))).toBe('undecided');
    // Zero policies, and a row with no policy count, show none.
    expect(newAgentActivationOf('2026-01-31', fileOf(held, { '2026-02': 0, '2026-03': null }))).toBe('not_activated');
  });

  it('P19.3-T1 AC-7 not activated only once every window month is held; undecided before that', () => {
    expect(newAgentActivationOf('2026-09-25', fileOf(['2026-09']))).toBe('undecided');
    expect(newAgentActivationOf('2026-09-25', fileOf(['2026-09', '2026-10', '2026-11', '2026-12']))).toBe('not_activated');
  });

  it('P19.3-T1 AC-7 the share: activated over the decided, whole and half up; pending while nobody is decided', () => {
    expect(newAgentActivationShare(['activated', 'not_activated', 'activated', 'undecided'])).toEqual({
      activated: 2, notActivated: 1, undecided: 1, pct: 67,
    });
    expect(newAgentActivationShare(['activated', 'not_activated'])).toMatchObject({ pct: 50 });
    expect(newAgentActivationShare(['undecided', 'undecided'])).toMatchObject({ pct: null });
    expect(newAgentActivationShare([])).toMatchObject({ pct: null, activated: 0, notActivated: 0, undecided: 0 });
    expect(newAgentActivationShare(['not_activated'])).toMatchObject({ pct: 0 });
  });

  it('P19.3-T1 AC-7 one person, two results: activated on the forum by a policy in month four, Teraktivasi late on New Hires', () => {
    // Joined 1 February: day 90 is 1 May. Her first paid-and-issued case is on 20 May (day 109), and the office's file
    // shows her policy in May — the fourth month of D7's window.
    const joinDate = '2026-02-01';
    const firstSaleDate = '2026-05-20';
    const d7 = newAgentActivationOf(joinDate, fileOf(['2026-02', '2026-03', '2026-04', '2026-05'], { '2026-05': 1 }));
    const newHires = activation3MOf({ joinDate, firstSaleDate, locked: null }, '2026-10-10');
    expect(d7).toBe('activated');
    // ADR-0171, unchanged: past day 90 with no sale by then — not activated, and the late sale is *Teraktivasi* in amber
    // (*lewat 3M*), in neither part of New Hires' share.
    expect(newHires).toBe('not_activated');
    expect(newHireStatusOf(newHires, firstSaleDate)).toBe('activated_late');
    expect(activation3MShare([{ result: newHires, firstSaleDate }]).pct).toBeNull();
    expect(newAgentActivationShare([d7]).pct).toBe(100);
  });

  it('P19.3-T1 AC-7 and the other way round: Teraktivasi by day 90 on New Hires, not yet on the forum while the file is silent', () => {
    // A paid-and-issued case on day 30, the office's file not uploaded past the join month.
    const joinDate = '2026-08-10';
    const firstSaleDate = '2026-09-08';
    expect(activation3MOf({ joinDate, firstSaleDate, locked: null }, '2026-10-10')).toBe('activated');
    expect(newAgentActivationOf(joinDate, fileOf(['2026-08']))).toBe('undecided');
  });
});
