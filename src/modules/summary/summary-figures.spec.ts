import { madeFigures, monthlyApeTarget, paceFor, periodFigures, ytdBeforeThisMonth } from './summary-figures';

const RP = 100; // minor units per rupiah
const M = 1_000_000 * RP;

/** The Personal Summary's arithmetic (P10-T4). */
describe('the Personal Summary’s figures (P10-T4)', () => {
  describe('AC-1, AC-3, AC-5 — a period’s goal against what was produced', () => {
    it('measures attainment, the gap and the policies still needed', () => {
      expect(periodFigures(100 * M, 45 * M, 18 * M)).toEqual({
        targetMinor: 100 * M, actualMinor: 45 * M, attainmentPct: 45, gapMinor: 55 * M, overMinor: 0,
        policiesNeeded: 4, targetMet: false,
      });
    });

    it('says the target is met, with how far over, and needs nothing more', () => {
      expect(periodFigures(100 * M, 130 * M, 18 * M)).toMatchObject({
        attainmentPct: 130, gapMinor: 0, overMinor: 30 * M, policiesNeeded: 0, targetMet: true,
      });
    });

    it('caps the printed attainment at 999', () => {
      expect(periodFigures(1 * M, 50 * M, 18 * M).attainmentPct).toBe(999);
    });

    it('AC-5: has no attainment without a goal — null, not 0%', () => {
      expect(periodFigures(null, 45 * M, 18 * M)).toMatchObject({ targetMinor: null, attainmentPct: null, gapMinor: null });
      expect(periodFigures(0, 45 * M, 18 * M)).toMatchObject({ targetMinor: null, attainmentPct: null });
    });

    it('has no attainment without an actual — a month not uploaded is not a month of nothing', () => {
      expect(periodFigures(100 * M, null, 18 * M)).toMatchObject({
        targetMinor: 100 * M, actualMinor: null, attainmentPct: null, gapMinor: null, policiesNeeded: null, targetMet: false,
      });
    });

    it('does not divide by a zero case size', () => {
      expect(periodFigures(100 * M, 45 * M, 0).policiesNeeded).toBeNull();
    });
  });

  describe('AC-1 — this month’s target, fixed against this month’s own figure (ADR-0056)', () => {
    it('divides what last month left by the months left including this one', () => {
      // October: 500M a year, 200M through September, three months left including October.
      expect(monthlyApeTarget(500 * M, 200 * M, 10)).toBe(100 * M);
    });

    it('is the whole year over twelve in January, and never below zero once the year is made', () => {
      expect(monthlyApeTarget(600 * M, 0, 1)).toBe(50 * M);
      expect(monthlyApeTarget(500 * M, 700 * M, 6)).toBe(0);
    });

    it('rounds to a whole minor unit — money is never a float', () => {
      expect(Number.isInteger(monthlyApeTarget(100 * M + 1, 0, 6))).toBe(true);
    });
  });

  describe('AC-1 — the year to date before this month, never zero for want of a file (ADR-0056)', () => {
    const before = (over: Record<string, unknown>) => ytdBeforeThisMonth({
      month: 9, throughLastMonthMinor: null, thisMonth: null, ownFigureMinor: null, ...over,
    });

    it('takes the office’s year to date through last month first', () => {
      expect(before({ throughLastMonthMinor: 200 * M, thisMonth: { ytdMinor: 999 * M, monthlyMinor: 1 }, ownFigureMinor: 5 })).toBe(200 * M);
    });

    it('takes this month’s year to date less this month when this month’s file is the first', () => {
      expect(before({ thisMonth: { ytdMinor: 510 * M, monthlyMinor: 30 * M } })).toBe(480 * M);
    });

    it('takes the agent’s own figure when nothing is uploaded at all', () => {
      expect(before({ ownFigureMinor: 120 * M })).toBe(120 * M);
    });

    it('is zero in January, whatever is held, and only where nothing at all is known', () => {
      expect(before({ month: 1, throughLastMonthMinor: 50 * M, ownFigureMinor: 9 })).toBe(0);
      expect(before({})).toBe(0);
    });
  });

  it('AC-3: a month whose target was made before it began is met, and needs nothing (ADR-0047)', () => {
    expect(madeFigures(30 * M)).toEqual({
      targetMinor: 0, actualMinor: 30 * M, attainmentPct: null, gapMinor: 0, overMinor: 30 * M, policiesNeeded: 0, targetMet: true,
    });
    expect(madeFigures(null)).toMatchObject({ targetMet: true, overMinor: null });
  });

  describe('AC-4 — the pace (ADR-0057)', () => {
    it('runs this month’s closings forward at their daily rate, and says what each week left needs', () => {
      // The 14th of a 30-day month: 2 closings, a target of 6. Seventeen days left, today included.
      expect(paceFor({ closingTarget: 6, closingsLogged: 2, dayOfMonth: 14, daysInMonth: 30, apeTargetMet: false }))
        .toEqual({
          closingTarget: 6, closingsLogged: 2, dayOfMonth: 14, daysInMonth: 30,
          projected: 4, weeksLeft: 3, neededPerWeek: 2, targetMet: false,
        });
    });

    it('does not project before the 7th — a run-rate over three days is noise', () => {
      expect(paceFor({ closingTarget: 6, closingsLogged: 1, dayOfMonth: 2, daysInMonth: 30, apeTargetMet: false }).projected)
        .toBeNull();
      expect(paceFor({ closingTarget: 6, closingsLogged: 1, dayOfMonth: 7, daysInMonth: 30, apeTargetMet: false }).projected)
        .toBe(4);
    });

    it('never divides by zero weeks — the last day of the month is one week left', () => {
      expect(paceFor({ closingTarget: 6, closingsLogged: 2, dayOfMonth: 30, daysInMonth: 30, apeTargetMet: false }))
        .toMatchObject({ weeksLeft: 1, neededPerWeek: 4 });
    });

    it('asks for no more closings once the closing target is logged — but that is not the APE target reached', () => {
      // Closings are the agent's count; APE is the carrier's. Reached means the APE gap is zero.
      expect(paceFor({ closingTarget: 6, closingsLogged: 7, dayOfMonth: 20, daysInMonth: 30, apeTargetMet: false }))
        .toMatchObject({ targetMet: false, neededPerWeek: 0, projected: 11 });
    });

    it('reads the APE target reached — this month’s or the year’s — as met, whatever the closings say (ADR-0047)', () => {
      expect(paceFor({ closingTarget: 0, closingsLogged: 0, dayOfMonth: 20, daysInMonth: 30, apeTargetMet: true }))
        .toMatchObject({ targetMet: true, neededPerWeek: 0 });
    });
  });
});
