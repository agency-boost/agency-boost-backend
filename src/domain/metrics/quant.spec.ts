import { QUANT_METRICS } from '@/domain/constants';
import {
  activationWithin, isRunPeriodEnd, latestRunPeriodEnd, oneDecimal, plusMonths, peerMedian, peerStatus, periodMonths,
  quantValues, type QuantCell, type QuantMember, type QuantMonth,
} from './quant';

/** A month in UTC, for the pure function: its bounds are whatever the caller gives. */
const at = (day: string) => new Date(`${day}T00:00:00Z`);
const nextMonth = (m: string) => plusMonths(m, 1);

function months(from: string, to: string, over: (m: string) => Partial<QuantMonth> = () => ({})): Map<string, QuantMonth> {
  const out = new Map<string, QuantMonth>();
  for (let m = from; m <= to; m = nextMonth(m)) {
    out.set(m, {
      month: m, start: at(`${m}-01`), endExclusive: at(`${nextMonth(m)}-01`), held: true, policiesHeld: true, complete: true,
      apeMinor: 0, policies: 0, recruitment: 0, ...over(m),
    });
  }
  return out;
}

const member = (id: string, role: QuantMember['role'], joinDate: string, extra: Partial<QuantMember> = {}): QuantMember => ({
  membershipId: id, role, joinDate, newHire: false,
  counted: { status: 'active', joinedAt: null, joinDateStart: at(joinDate), removedAt: null }, ...extra,
});

describe('P19.5-T3 the Quant metrics (ADR-0215 §6; §A.15)', () => {
  // Two leaders and three agents; the office's file Jul 2024 to Jun 2026, every month complete.
  const people = [
    member('ab', 'ab', '2015-01-01'),
    member('aab', 'aab', '2020-01-01'),
    member('a1', 'agent', '2023-01-10'),
    member('a2', 'agent', '2026-02-10', { newHire: true }),
    member('a3', 'agent', '2026-03-05', { newHire: true }),
  ];
  const file = months('2024-07', '2026-06', (m) => ({
    recruitment: m >= '2026-01' ? 2 : 1, apeMinor: 1_000, policies: 4,
  }));
  const cells = new Map<string, QuantCell>();
  for (const m of file.keys()) {
    cells.set(`ab|${m}`, { apeMinor: 500, policies: 2, recruitment: null });
    if (m >= '2025-07') cells.set(`a1|${m}`, { apeMinor: m.endsWith('-01') ? 500 : 0, policies: m.endsWith('-01') ? 2 : 0, recruitment: null });
  }
  cells.set('a2|2026-04', { apeMinor: 300, policies: 1, recruitment: null });
  const input = {
    periodEnd: '2026-06', endOfPeriod: at('2026-07-01'), tenuredBefore: at('2025-06-30'),
    members: people, months: file, cell: (id: string, m: string) => cells.get(`${id}|${m}`),
  };

  it('P19.5-T3 AC-6 computes the ten metrics, A1 to D1, over January to June', () => {
    const v = quantValues(input);
    expect(Object.keys(v).sort()).toEqual(QUANT_METRICS.map((q) => q.metric).sort());
    // A1: 2 recruits × 6 months over 2 leaders.
    expect(v.QUANT_RECRUITS_PER_LEADER).toEqual({ value: 6, complete: true, missingMonths: [], reason: null });
    // A2: last 12 the AB and a1 and a2 active (3); the 12 before the AB alone (1).
    expect(v.QUANT_ANNUAL_ACTIVE_NET_GROWTH.value).toBe(2);
    // A3: producing agents in the period — the AB, a1 (January), a2 (April) — over 2 leaders.
    expect(v.QUANT_ACTIVE_PER_LEADER.value).toBe(1.5);
    // B1: the two new hires, a2 activated in its window, a3 not (Mar to Jun all held, no policy).
    expect(v.NEW_AGENT_ACTIVATION_3M_PCT.value).toBe(50);
    // B3: joined before 30 Jun 2025 and here at the end — AB, AAB, a1 — active in the period: AB and a1.
    expect(v.QUANT_TENURED_ACTIVE_PCT.value).toBe(67);
    // C3: in the last 12 months the AB 12, a1 1, a2 1: mean 4.7.
    expect(v.QUANT_AVG_ACTIVE_MONTHS.value).toBe(4.7);
    // D1: 1 000 ÷ 4 per month, whole minor units.
    expect(v.AVERAGE_CASE_SIZE_REALISED.value).toBe(250);
    expect(v.CASES_PER_PRODUCING_AGENT.value).not.toBeNull();
  });

  it('P19.5-T3 AC-6 A1, A3 and C1 are — with no leader, never 0', () => {
    const v = quantValues({ ...input, members: people.filter((p) => p.role === 'agent') });
    for (const metric of ['QUANT_RECRUITS_PER_LEADER', 'QUANT_ACTIVE_PER_LEADER', 'QUANT_AVG_MAA_PER_LEADER'] as const) {
      expect(v[metric]).toMatchObject({ value: null, reason: 'no_leader' });
    }
  });

  it('P19.5-T3 AC-6 A2 reads Belum cukup data unless all 24 months are held', () => {
    const short = new Map([...file].map(([m, f]) => [m, m < '2025-01' ? { ...f, held: false, complete: false } : f]));
    expect(quantValues({ ...input, months: short }).QUANT_ANNUAL_ACTIVE_NET_GROWTH)
      .toMatchObject({ value: null, reason: 'not_enough_data', complete: false });
  });

  it('P19.5-T3 AC-5 AT-6 a month not complete makes every metric reading it incomplete, naming the month', () => {
    const march = new Map([...file].map(([m, f]) => [m, m === '2026-03' ? { ...f, complete: false } : f]));
    const v = quantValues({ ...input, months: march });
    expect(v.QUANT_RECRUITS_PER_LEADER).toMatchObject({ complete: false, missingMonths: ['2026-03'] });
    expect(v.AVERAGE_CASE_SIZE_REALISED.complete).toBe(false);
  });

  it('P19.5-T3 B2 activates within the join month and the 12 after; undecided while a month is unheld', () => {
    const held = (policies: number | null) => () => ({ held: true, policies });
    expect(activationWithin('2026-01-15', 12, held(0))).toBe('not_activated');
    expect(activationWithin('2026-01-15', 12, (m) => ({ held: true, policies: m === '2027-01' ? 1 : 0 }))).toBe('activated');
    expect(activationWithin('2026-01-15', 12, (m) => ({ held: m < '2026-12', policies: 0 }))).toBe('undecided');
  });

  it('P19.5-T3 AC-9 runs end in June and December; the latest is the last ended', () => {
    expect(isRunPeriodEnd('2026-06')).toBe(true);
    expect(isRunPeriodEnd('2026-07')).toBe(false);
    expect(latestRunPeriodEnd('2026-07')).toBe('2026-06');
    expect(latestRunPeriodEnd('2026-06')).toBe('2025-12');
    expect(latestRunPeriodEnd('2027-01')).toBe('2026-12');
    expect(periodMonths('2026-06')).toEqual(['2026-01', '2026-02', '2026-03', '2026-04', '2026-05', '2026-06']);
    expect(oneDecimal(4.666)).toBe(4.7);
  });
});

describe('P19.5-T3 the peers (R3, D4; ADR-0215 §5)', () => {
  it('P19.5-T3 AC-7 AT-7 the median needs three peers; with two it is null', () => {
    expect(peerMedian([4, 9])).toBeNull();
    expect(peerMedian([4, 9, 1])).toBe(4);
    expect(peerMedian([4, 9, 1, 3])).toBe(3.5);
  });

  it('P19.5-T3 AC-8 above or below by more than the band, else in line; A2 by agents; no chip when incomplete', () => {
    const pct = { kind: 'pct' as const, size: 5 };
    expect(peerStatus({ value: 10.6, complete: true }, 10, pct)).toBe('above');
    expect(peerStatus({ value: 10.5, complete: true }, 10, pct)).toBe('in_line');
    expect(peerStatus({ value: 9.4, complete: true }, 10, pct)).toBe('below');
    expect(peerStatus({ value: 1, complete: true }, 0, pct)).toBe('above');
    expect(peerStatus({ value: 0, complete: true }, 0, pct)).toBe('in_line');
    expect(peerStatus({ value: 13, complete: true }, 10, { kind: 'absolute', size: 2 })).toBe('above');
    expect(peerStatus({ value: 12, complete: true }, 10, { kind: 'absolute', size: 2 })).toBe('in_line');
    expect(peerStatus({ value: 10.6, complete: false }, 10, pct)).toBeNull();
    expect(peerStatus({ value: 10.6, complete: true }, null, pct)).toBeNull();
  });

  it('P19.5-T3 AC-8 R6 a colour-only band re-colours the same stored value', () => {
    expect(peerStatus({ value: 10.6, complete: true }, 10, { kind: 'pct', size: 5 })).toBe('above');
    expect(peerStatus({ value: 10.6, complete: true }, 10, { kind: 'pct', size: 10 })).toBe('in_line');
  });
});
