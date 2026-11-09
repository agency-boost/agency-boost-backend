import { SystemClock } from '@/common/clock/clock.port';
import {
  aaThisMonth, leadPotensiThisMonth, openAtEndOf, personPotensi, rekrutThisMonth, wonIn, type PotensiLead, type PotensiMonth,
} from './potensi';

const clock = new SystemClock();
const monthOf = (month: string): PotensiMonth => ({ month, ...clock.monthBounds('Asia/Jakarta', month) });
const NOV = monthOf('2026-11');
const OCT = monthOf('2026-10');

const lead = (over: Partial<PotensiLead> = {}): PotensiLead => ({
  type: 'sales', outcome: null, outcomeAt: null, commitments: [], ...over,
});

/** 30 November 23:59 and 1 December 00:00 in Jakarta (UTC+7). */
const LAST_MINUTE_OF_NOV = new Date('2026-11-30T16:59:00Z');
const FIRST_MINUTE_OF_DEC = new Date('2026-11-30T17:00:00Z');

describe('the Potensi tab’s figures (P19.1-T6, ADR-0193)', () => {
  it('P19.1-T6 AC-12 the month’s bounds are the office’s: 00:00 WIB on the 1st is the next month', () => {
    expect(NOV.start.toISOString()).toBe('2026-10-31T17:00:00.000Z');
    expect(NOV.endExclusive.toISOString()).toBe(FIRST_MINUTE_OF_DEC.toISOString());
    expect(wonIn(lead({ outcome: 'won', outcomeAt: LAST_MINUTE_OF_NOV }), NOV)).toBe(true);
    expect(wonIn(lead({ outcome: 'won', outcomeAt: FIRST_MINUTE_OF_DEC }), NOV)).toBe(false);
    // 06:00 WIB on 1 November is 23:00 UTC on 31 October: November's, though October's in UTC.
    expect(wonIn(lead({ outcome: 'won', outcomeAt: new Date('2026-10-31T23:00:00Z') }), NOV)).toBe(true);
    expect(wonIn(lead({ outcome: 'won', outcomeAt: new Date('2026-10-31T23:00:00Z') }), OCT)).toBe(false);
  });

  it('LEAD_POTENSI_THIS_MONTH is a commitment entry for the month, and only that month', () => {
    expect(leadPotensiThisMonth(lead({ commitments: [{ month: '2026-11' }] }), '2026-11')).toBe(true);
    expect(leadPotensiThisMonth(lead({ commitments: [{ month: '2026-11' }] }), '2026-12')).toBe(false);
    expect(leadPotensiThisMonth(lead({ commitments: null }), '2026-11')).toBe(false);
  });

  it('a lead marked lost, or won, is no longer open; one closed after a past month was open at its end', () => {
    expect(openAtEndOf(lead(), NOV)).toBe(true);
    expect(openAtEndOf(lead({ outcome: 'lost', outcomeAt: new Date('2026-11-05T03:00:00Z') }), NOV)).toBe(false);
    expect(openAtEndOf(lead({ outcome: 'won', outcomeAt: new Date('2026-11-05T03:00:00Z') }), OCT)).toBe(true);
    expect(openAtEndOf(lead({ outcome: 'won', outcomeAt: null }), OCT)).toBe(false);
  });

  it('P19.1-T6 AC-5 n potensi counts switched-on sales leads still open; a won one becomes the ✓, not a potensi', () => {
    const p = personPotensi([
      lead({ commitments: [{ month: '2026-11' }] }),
      lead({ commitments: [{ month: '2026-11' }], outcome: 'won', outcomeAt: new Date('2026-11-12T03:00:00Z') }),
      lead({ commitments: [{ month: '2026-10' }] }),
      lead({ outcome: 'won', outcomeAt: new Date('2026-11-02T03:00:00Z') }),
    ], NOV);
    expect(p.sales).toEqual({ potensi: 1, switched: 2, won: 2 });
    expect(p.recruitment).toEqual({ potensi: 0, switched: 0, won: 0 });
  });

  it('P19.1-T6 AC-7 a recruitment lead switched off is left out of n potensi; a rekrut counts whether switched or not', () => {
    const p = personPotensi([
      lead({ type: 'recruitment', commitments: [{ month: '2026-11' }] }),
      lead({ type: 'recruitment' }),
      lead({ type: 'recruitment', outcome: 'won', outcomeAt: new Date('2026-11-18T03:00:00Z') }),
      lead({ type: 'recruitment', commitments: [{ month: '2026-11' }], outcome: 'won', outcomeAt: new Date('2026-11-20T03:00:00Z') }),
      // A lead with no type is on neither tile.
      lead({ type: null, commitments: [{ month: '2026-11' }] }),
    ], NOV);
    expect(p.recruitment).toEqual({ potensi: 1, switched: 2, won: 2 });
    expect(rekrutThisMonth(p)).toBe(2);
    expect(p.sales.switched).toBe(0);
  });

  it('P19.1-T6 AC-9 November still reads on 1 December: its switches, and what became of them', () => {
    const leads = [
      lead({ commitments: [{ month: '2026-11' }], outcome: 'won', outcomeAt: new Date('2026-11-20T03:00:00Z') }),
      lead({ commitments: [{ month: '2026-11' }] }),
    ];
    expect(personPotensi(leads, NOV).sales).toEqual({ potensi: 1, switched: 2, won: 1 });
    // December: nothing switched on for it.
    expect(personPotensi(leads, monthOf('2026-12')).sales).toEqual({ potensi: 0, switched: 0, won: 0 });
  });

  it('P19.1-T6 AC-12 AA_THIS_MONTH by each path of OD-249: a sales lead marked Berhasil, or policies on the month’s row', () => {
    expect(aaThisMonth(1, null)).toBe(true);
    expect(aaThisMonth(0, 2)).toBe(true);
    expect(aaThisMonth(0, 0)).toBe(false);
    // A month the office holds no figure for is not a case.
    expect(aaThisMonth(0, null)).toBe(false);
  });
});
