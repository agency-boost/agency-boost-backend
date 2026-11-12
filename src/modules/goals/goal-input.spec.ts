import type { DomainException } from '@/common/errors/domain.exception';
import type { Sentence } from '@/common/i18n/sentence';
import { indonesianAll } from '../../../test/i18n';
import { englishAll } from '../../../test/i18n';
import { checkGoal, checkMonthApe, GOAL_BOUNDS, officialWrittenAt, typedApeOf, typedByAfter, typedInForce } from './goal-input';

/**
 * What a goal's fields may hold (P8-T1).
 *
 * Pure, so every rule is exercised without a database (ADR-0030). **The cascade is not here** —
 * whether the numbers make sense together is P8-T2's; this is the older question of whether each
 * one is a number at all, and in the unit this product stores it in.
 */
describe('a goal’s fields', () => {
  const ok = {
    period: '2026',
    mode: 'direct',
    annualApeTargetMinor: 500_000_000_00,
    savingsTargetMinor: 50_000_000_00,
    commissionRatePct: 10,
    monthsLeft: 3.2,
    apeAchievedMinor: 0,
    caseSizeMinor: 18_000_000_00,
    leadsToApptPct: 30,
    closingRatePct: 30,
  };

  it('takes a complete plan unchanged', () => {
    expect(checkGoal(ok)).toEqual(ok);
  });

  it('S1 takes a plan that leaves the APE produced out — the stored figure is kept — and refuses any other money field left out', () => {
    const { apeAchievedMinor, ...rest } = ok;
    expect(apeAchievedMinor).toBe(0);
    expect(checkGoal(rest)).toEqual(rest);
    const { caseSizeMinor: _case, ...noCase } = ok;
    expect(() => checkGoal(noCase)).toThrow(/caseSizeMinor is required/);
  });

  describe('the period is a year, not a code', () => {
    it('takes four digits', () => {
      expect(checkGoal({ ...ok, period: '2027' }).period).toBe('2027');
    });

    it.each(['26', '2026-Q1', 'FY2026', '', 'twenty-six'])('refuses %p', (period) => {
      expect(() => checkGoal({ ...ok, period })).toThrow(/calendar year/);
    });

    it('refuses a missing one, because it is half the uniqueness key', () => {
      const { period, ...rest } = ok;
      expect(period).toBe('2026');
      expect(() => checkGoal(rest)).toThrow(/period is required/);
    });
  });

  describe('money is whole sen', () => {
    it.each([
      'annualApeTargetMinor', 'savingsTargetMinor', 'apeAchievedMinor', 'caseSizeMinor',
    ])('refuses a fraction of a sen on %s', (field) => {
      // A fraction here is not a rounding question: somebody handed major units to a field that
      // stores minor ones, and no amount of rounding makes that the number they meant.
      expect(() => checkGoal({ ...ok, [field]: 1_000.5 })).toThrow(/whole number/);
    });

    it('refuses a negative target', () => {
      expect(() => checkGoal({ ...ok, annualApeTargetMinor: -1 })).toThrow(/must be a number/);
    });

    it('stays below the point integers stop being exact', () => {
      // Past MAX_SAFE_INTEGER a figure silently loses its last digits. The bound is a test rather
      // than only a comment because the first version of it was set *above* the limit it names.
      expect(GOAL_BOUNDS.money.max).toBeLessThan(Number.MAX_SAFE_INTEGER);
      expect(() => checkGoal({ ...ok, annualApeTargetMinor: GOAL_BOUNDS.money.max + 1 }))
        .toThrow(/must be a number/);
    });
  });

  describe('percentages take decimals, which the prototype cannot (I-108)', () => {
    it.each(['commissionRatePct', 'leadsToApptPct', 'closingRatePct'])('takes 12.5 on %s', (field) => {
      /*
       * `parseNum` strips every non-digit, so `12.5` becomes `125`: a commission rate of twelve and
       * a half per cent read as a hundred and twenty-five, and a plan built on a tenfold error.
       * That is a defect rather than a simplification, and this is the regression test for it.
       */
      expect(checkGoal({ ...ok, [field]: 12.5 })[field as 'commissionRatePct']).toBe(12.5);
    });

    it('refuses a negative one, because no percentage is', () => {
      expect(() => checkGoal({ ...ok, closingRatePct: -1 })).toThrow(/must be a percentage/);
    });

    it('lets 101 through, because the ceiling belongs to the cascade', () => {
      // Shape here, semantics there: `goal-cascade.ts` refuses it with GOAL_INVALID_ASSUMPTION so
      // the screen can point at the field. One rule, in the module that needs it (AC-7).
      expect(checkGoal({ ...ok, closingRatePct: 101 }).closingRatePct).toBe(101);
    });
  });

  describe('months left', () => {
    it('takes a decimal, because 4.3 months is a real answer', () => {
      expect(checkGoal({ ...ok, monthsLeft: 4.3 }).monthsLeft).toBe(4.3);
    });

    it('refuses zero, which would divide the cascade by nothing', () => {
      expect(() => checkGoal({ ...ok, monthsLeft: 0 })).toThrow(/from 0.1 to 120/);
    });
  });

  describe('mode', () => {
    it('takes the two the screen offers', () => {
      expect(checkGoal({ ...ok, mode: 'from_savings' }).mode).toBe('from_savings');
    });

    it('refuses anything else', () => {
      expect(() => checkGoal({ ...ok, mode: 'guess' })).toThrow(/must be one of/);
    });
  });

  describe('a partial patch', () => {
    it('requires nothing, and keeps what it was given', () => {
      expect(checkGoal({ apeAchievedMinor: 12_000_000_00 }, { partial: true }))
        .toEqual({ apeAchievedMinor: 12_000_000_00 });
    });

    it('still refuses a bad value', () => {
      expect(() => checkGoal({ closingRatePct: 'thirty' }, { partial: true }))
        .toThrow(/must be a percentage/);
    });
  });

  it('refuses a field nobody defined, rather than dropping it', () => {
    expect(() => checkGoal({ ...ok, snapshot: { policiesPerMonth: 6 } }))
      .toThrow(/snapshot/);
  });

  it('gathers every violation, so a form with three mistakes hears about three', () => {
    try {
      checkGoal({ ...ok, period: 'x', closingRatePct: 'thirty', monthsLeft: 0 });
      throw new Error('should have refused');
    } catch (err) {
      expect((err as { details: { violations: string[] } }).details.violations).toHaveLength(3);
    }
  });

  it('P18.10-T5 AC-3 says every violation in Indonesian too, a decimal written the Indonesian way', () => {
    try {
      const { period: _period, ...rest } = ok;
      checkGoal({ ...rest, caseSizeMinor: 1_000.5, closingRatePct: 'thirty' });
      throw new Error('should have refused');
    } catch (err) {
      expect(indonesianAll((err as DomainException).givenDetails!.violations as Sentence[])).toEqual([
        'period wajib diisi.',
        'caseSizeMinor dalam satuan sen IDR dan harus berupa bilangan bulat.',
        'closingRatePct harus berupa persentase, ditulis sebagai angka seperti 30 atau 12,5.',
      ]);
    }
    try {
      checkGoal({ ...ok, period: '26' });
      throw new Error('should have refused');
    } catch (err) {
      expect(indonesianAll((err as DomainException).givenDetails!.violations as Sentence[]))
        .toEqual(['period harus berupa tahun kalender, dengan format YYYY.']);
    }
  });
});

/**
 * **Whose typed APE produced a save keeps** (ADR-0075, partly reversed by ADR-0183): the member's own, always; a coach's
 * — anybody `goal:update` lets save the plan — while the office holds no figure; nobody else's once it does.
 */
describe('typedApeOf — the APE produced a save keeps (ADR-0183)', () => {
  const M = 1_000_000 * 100;
  const HELD = { minor: 240 * M, provenance: 'imported', month: '2026-09' };

  it('ADR-0075 keeps the member’s own typing on their own plan, with or without an office figure', () => {
    expect(typedApeOf({ own: true, held: null, asked: 130 * M, stored: 120 * M })).toBe(130 * M);
    expect(typedApeOf({ own: true, held: HELD, asked: 130 * M, stored: 120 * M })).toBe(130 * M);
  });

  it('ADR-0183 keeps a coach’s typing on somebody else’s plan while the office holds no figure', () => {
    expect(typedApeOf({ own: false, held: null, asked: 75 * M, stored: 120 * M })).toBe(75 * M);
    // Zero is a figure, typed: a leader clearing a wrong one.
    expect(typedApeOf({ own: false, held: null, asked: 0, stored: 120 * M })).toBe(0);
  });

  it('ADR-0183 ignores a coach’s typing once the office holds a figure, uploaded or corrected: the stored one is kept', () => {
    expect(typedApeOf({ own: false, held: HELD, asked: 999 * M, stored: 120 * M })).toBe(120 * M);
    expect(typedApeOf({ own: false, held: { ...HELD, provenance: 'corrected' }, asked: 999 * M, stored: 0 })).toBe(0);
  });

  it('S1 keeps the stored figure when the body leaves it out — the coach’s save, the member’s, with or without a figure held', () => {
    for (const own of [true, false]) {
      for (const held of [null, HELD]) {
        expect(typedApeOf({ own, held, asked: undefined, stored: 120 * M })).toBe(120 * M);
      }
    }
    // A plan nobody has saved stores nothing: the default 0.
    expect(typedApeOf({ own: false, held: null, asked: undefined, stored: 0 })).toBe(0);
  });
});

describe('typedByAfter — who typed the figure a plan stores (S2)', () => {
  it('S2 names the saver when the save changed the figure, the member or a coach alike', () => {
    expect(typedByAfter({ before: 100, after: 150, savedBy: 'coach', typedBefore: null })).toBe('coach');
    expect(typedByAfter({ before: 100, after: 150, savedBy: 'member', typedBefore: 'coach' })).toBe('member');
  });

  it('S2 keeps whoever typed it when the save left the figure as it was', () => {
    expect(typedByAfter({ before: 150, after: 150, savedBy: 'member', typedBefore: 'coach' })).toBe('coach');
    // A row from before the field: nobody recorded, which reads as the member.
    expect(typedByAfter({ before: 150, after: 150, savedBy: 'coach', typedBefore: undefined })).toBeNull();
  });
});

/**
 * **P19.8-T5 — the newer wins** (ADR-0230 §6; OQ3, OD-279's default): which of the typed figure and the office's year to
 * date the member's own screens measure against, and when the office last wrote it.
 */
describe('P19.8-T5 typedInForce and officialWrittenAt — the newer wins (ADR-0230 §6)', () => {
  const at = (iso: string) => new Date(iso);
  const IMPORT = at('2026-10-05T03:00:00Z');

  it('P19.8-T5 AC-5 OD-279 a figure typed after the office last wrote the year is in force; one typed before it is not', () => {
    expect(typedInForce({ typedMinor: 67, typedAt: at('2026-10-06T03:00:00Z'), held: true, officialAt: IMPORT })).toBe(true);
    expect(typedInForce({ typedMinor: 67, typedAt: at('2026-10-04T03:00:00Z'), held: true, officialAt: IMPORT })).toBe(false);
    // The same moment is not newer: the office's figure stays.
    expect(typedInForce({ typedMinor: 67, typedAt: IMPORT, held: true, officialAt: IMPORT })).toBe(false);
  });

  it('P19.8-T5 AC-4 nothing typed is never in force; with no office figure a typed one always is', () => {
    expect(typedInForce({ typedMinor: 0, typedAt: at('2026-10-06T03:00:00Z'), held: true, officialAt: IMPORT })).toBe(false);
    expect(typedInForce({ typedMinor: 0, typedAt: null, held: false, officialAt: null })).toBe(false);
    expect(typedInForce({ typedMinor: 67, typedAt: null, held: false, officialAt: null })).toBe(true);
  });

  it('P19.8-T5 AC-5 a moment either side does not know leaves the office’s figure in force (ADR-0195 §3)', () => {
    expect(typedInForce({ typedMinor: 67, typedAt: null, held: true, officialAt: IMPORT })).toBe(false);
    expect(typedInForce({ typedMinor: 67, typedAt: at('2026-10-06T03:00:00Z'), held: true, officialAt: null })).toBe(false);
  });

  it('P19.8-T5 AC-5 the office’s write is the later of its newest correction and its latest import', () => {
    const corrected = at('2026-10-07T03:00:00Z');
    expect(officialWrittenAt(corrected, IMPORT)).toBe(corrected);
    expect(officialWrittenAt(at('2026-09-01T03:00:00Z'), IMPORT)).toBe(IMPORT);
    expect(officialWrittenAt(null, IMPORT)).toBe(IMPORT);
    expect(officialWrittenAt(corrected, null)).toBe(corrected);
    expect(officialWrittenAt(null, null)).toBeNull();
  });

  it('P19.8-T5 AC-4 checkGoal reads apeAchievedMinor: null as the typed figure cleared — 0, nothing typed', () => {
    const base = {
      period: '2026', mode: 'direct', annualApeTargetMinor: 500_000_000_00, savingsTargetMinor: 50_000_000_00,
      commissionRatePct: 10, monthsLeft: null, caseSizeMinor: 18_000_000_00, leadsToApptPct: 30, closingRatePct: 30,
    };
    expect(checkGoal({ ...base, apeAchievedMinor: null }).apeAchievedMinor).toBe(0);
    expect(checkGoal(base)).not.toHaveProperty('apeAchievedMinor');
    expect(() => checkGoal({ ...base, apeAchievedMinor: 'x' })).toThrow();
  });
});

/** **P19.11-T4 — `PUT /goals/:period/ape-month`'s body** (UX-12; UXQ2's default): a month of the plan's year, and its APE. */
describe('P19.11-T4 checkMonthApe', () => {
  const refused = (body: unknown, period = '2026'): string[] => {
    try {
      checkMonthApe(body, period);
    } catch (err) {
      return englishAll((err as DomainException).givenDetails!.violations as Sentence[]);
    }
    throw new Error('accepted');
  };

  it('P19.11-T4 AC-3 takes a month of the year and whole sen — 0 a figure, null a clearing', () => {
    expect(checkMonthApe({ month: '2026-11', apeAchievedMinor: 216_500_000_00 }, '2026')).toEqual({ month: '2026-11', minor: 216_500_000_00 });
    expect(checkMonthApe({ month: '2026-01', apeAchievedMinor: 0 }, '2026')).toEqual({ month: '2026-01', minor: 0 });
    expect(checkMonthApe({ month: '2026-12', apeAchievedMinor: null }, '2026')).toEqual({ month: '2026-12', minor: null });
  });

  it('P19.11-T4 AC-3 refuses a month of another year: it is kept on that year’s plan', () => {
    expect(refused({ month: '2025-12', apeAchievedMinor: 1 })).toEqual([
      "2025-12 is not a month of 2026: a month's APE is kept on the plan for its own year.",
    ]);
  });

  it('P19.11-T4 AC-3 refuses a month that is no YYYY-MM, a missing one, and every figure that is no whole sen', () => {
    for (const month of ['2026-13', '2026-00', '2026-1', '11-2026', 202611]) {
      expect(refused({ month, apeAchievedMinor: 1 })).toEqual(['month must be a calendar month, written YYYY-MM.']);
    }
    expect(refused({ apeAchievedMinor: 1 })).toHaveLength(1);
    for (const apeAchievedMinor of [-1, 1.5, '100', GOAL_BOUNDS.money.max + 1]) {
      expect(refused({ month: '2026-11', apeAchievedMinor })).toHaveLength(1);
    }
    // Missing is not null: a clearing says so.
    expect(refused({ month: '2026-11' })).toHaveLength(1);
  });

  it('P19.11-T4 AC-3 refuses a field nobody defined, and a body that is no object', () => {
    expect(refused({ month: '2026-11', apeAchievedMinor: 1, for: 'x' })).toHaveLength(1);
    expect(refused(null).length).toBeGreaterThan(0);
  });
});
