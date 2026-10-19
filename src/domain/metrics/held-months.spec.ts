import {
  averageCaseSizeRealised, caseSubmissions, maaMonthlyAvg, newActiveAgentsMonthlyAvg,
} from './held-months';

const M = 1_000_000 * 100;

describe('the forum’s figures over the months held (P18.1-T1 AC-3, AC-4; OD-144)', () => {
  it('P18.1-T1 AC-3 New AA (avg. monthly): the file’s NEW_ACTIVE_AGENTS over the months held ÷ the months held, exact', () => {
    expect(newActiveAgentsMonthlyAvg([2, null, 3, 0])).toBe(5 / 3);
    expect(newActiveAgentsMonthlyAvg([4])).toBe(4);
  });

  it('P18.1-T1 AC-3 New AA (avg. monthly) is pending with no month held — never 0', () => {
    expect(newActiveAgentsMonthlyAvg([null, null])).toBeNull();
    expect(newActiveAgentsMonthlyAvg([])).toBeNull();
  });

  it('P18.1-T1 AC-4 Avg. Monthly AA: MAA_COUNT_IN_UNIT of each month held, averaged; a month not held leaves it', () => {
    expect(maaMonthlyAvg([12, 8, null])).toBe(10);
    expect(maaMonthlyAvg([0, 0])).toBe(0);
    expect(maaMonthlyAvg([null])).toBeNull();
  });

  it('P18.1-T1 AC-4 Case submission: the file’s policy count summed over the months held; pending with none', () => {
    expect(caseSubmissions([27, null, 25, 0])).toBe(52);
    expect(caseSubmissions([0])).toBe(0);
    expect(caseSubmissions([null, null])).toBeNull();
  });

  describe('Average Case Size (AC-4)', () => {
    it('P18.1-T1 AC-4 is APE ÷ policies over the same months — those holding both — in whole minor units', () => {
      expect(averageCaseSizeRealised([
        { apeMinor: 40 * M, policies: 2 }, { apeMinor: 20 * M, policies: 1 },
        // APE without its policy count, and a policy count without APE: neither month is read.
        { apeMinor: 99 * M, policies: null }, { apeMinor: null, policies: 7 },
      ])).toBe(20 * M);
      expect(averageCaseSizeRealised([{ apeMinor: 10 * M + 1, policies: 3 }])).toBe(Math.round((10 * M + 1) / 3));
    });

    it('P18.1-T1 AC-4 is none — drawn —, never a division by zero — over no policies in months that are held', () => {
      expect(averageCaseSizeRealised([{ apeMinor: 0, policies: 0 }, { apeMinor: 5 * M, policies: 0 }])).toBe('none');
    });

    it('P18.1-T1 AC-4 is pending when no month holds both', () => {
      expect(averageCaseSizeRealised([{ apeMinor: 5 * M, policies: null }])).toBeNull();
      expect(averageCaseSizeRealised([])).toBeNull();
    });
  });
});
