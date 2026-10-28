import { rejoinedOn, type RejoinFacts } from './rejoined';

const day = (iso: string) => new Date(`${iso}T03:00:00Z`);
const row = (over: Partial<RejoinFacts> & Pick<RejoinFacts, 'id'>): RejoinFacts => ({
  userId: 'u-yanti', status: 'active', joinDate: null, startedAt: day('2026-01-01'), ...over,
});

/**
 * **Who came back, and when** (P18.97-T4 AC-3, ADR-0176 §5; UI-024). Yanti in 0417's seed: one membership removed, one
 * active — the directory read *Active* beside a *Removed (2)* tab and the client took her for a removed member shown
 * as active.
 */
describe('rejoinedOn (P18.97-T4 AC-3)', () => {
  const first = row({ id: 'm1', status: 'removed', joinDate: '2026-08-29', startedAt: day('2026-08-29') });
  const back = row({ id: 'm2', status: 'active', joinDate: '2026-09-30', startedAt: day('2026-09-30') });

  it('P18.97-T4 AC-3 marks the live membership that follows a removed one with its own join date', () => {
    expect(rejoinedOn(back, [first, back])).toBe('2026-09-30');
  });

  it('P18.97-T4 AC-3 marks the removed one with the day the person came back', () => {
    expect(rejoinedOn(first, [first, back])).toBe('2026-09-30');
  });

  it('P18.97-T4 AC-3 marks nobody who never left, nor a removed member who has not come back', () => {
    expect(rejoinedOn(back, [back])).toBeNull();
    expect(rejoinedOn(first, [first])).toBeNull();
    // Another person's removed membership says nothing about this one.
    expect(rejoinedOn(back, [{ ...first, userId: 'u-other' }, back])).toBeNull();
  });

  it('P18.97-T4 AC-3 is not a return until somebody lets them back in: a pending membership reads none', () => {
    const waiting = row({ id: 'm2', status: 'pending', joinDate: null, startedAt: day('2026-10-01') });
    expect(rejoinedOn(waiting, [first, waiting])).toBeNull();
    expect(rejoinedOn(first, [first, waiting])).toBeNull();
  });

  it('P18.97-T4 AC-3 reads each removed membership against the one after it, for somebody who left twice', () => {
    const second = row({ id: 'm2', status: 'removed', joinDate: '2026-06-01', startedAt: day('2026-06-01') });
    const earliest = row({ id: 'm0', status: 'removed', joinDate: '2026-02-01', startedAt: day('2026-02-01') });
    const now = row({ id: 'm3', status: 'active', joinDate: '2026-10-01', startedAt: day('2026-10-01') });
    const all = [now, second, earliest];
    expect(rejoinedOn(earliest, all)).toBe('2026-06-01');
    expect(rejoinedOn(second, all)).toBe('2026-10-01');
    expect(rejoinedOn(now, all)).toBe('2026-10-01');
  });

  it('P18.97-T4 AC-3 orders two memberships begun at one instant by their ids, and counts each once', () => {
    const at = day('2026-09-01');
    const a = row({ id: 'a1', status: 'removed', joinDate: '2026-09-01', startedAt: at });
    const b = row({ id: 'b2', status: 'active', joinDate: '2026-09-01', startedAt: at });
    expect(rejoinedOn(a, [b, a, a])).toBe('2026-09-01');
    expect(rejoinedOn(b, [b, a])).toBe('2026-09-01');
    // The member alone, not among the siblings read: it is still placed, and nothing came before it.
    expect(rejoinedOn(b, [])).toBeNull();
  });
});
