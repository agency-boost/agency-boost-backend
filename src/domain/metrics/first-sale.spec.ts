import { earlierFirstSale, fileSaleWithdrawn, firstSaleOf, nthClosingOf, type FirstSale, type SaleEvidence } from './first-sale';

const closing = (date: string, recordId: string, logged = false) => ({ date, recordId, logged });
const month = (m: string, recordId: string, policies = 1) => ({ month: m, recordId, policies });
const evidence = (over: Partial<SaleEvidence> = {}): SaleEvidence => ({ joinDate: '2026-07-15', closings: [], fileMonths: [], ...over });

/** `FIRST_SALE_DATE` (ADR-0171 §1, P18.96-T4 AC-1): the earliest of a lead, a manual tick, and — failing both — the file. */
describe('firstSaleOf — FIRST_SALE_DATE (ADR-0171 §1)', () => {
  it('P18.96-T4 AC-1 is the earliest closing since joining, from the lead', () => {
    expect(firstSaleOf(evidence({ closings: [closing('2026-08-20', 'b'), closing('2026-08-10', 'a')] }))).toEqual({
      date: '2026-08-10', source: 'lead', recordCollection: 'leads', recordId: 'a',
    });
  });

  it('P18.96-T4 AC-1 a closing logged by a checklist tick is manual, and the earlier of the two wins', () => {
    expect(firstSaleOf(evidence({ closings: [closing('2026-08-20', 'lead'), closing('2026-08-05', 'tick', true)] })))
      .toMatchObject({ date: '2026-08-05', source: 'manual', recordId: 'tick' });
    // On one day, the leads flow's closing before the logged one: it is the data.
    expect(firstSaleOf(evidence({ closings: [closing('2026-08-05', 'tick', true), closing('2026-08-05', 'lead')] })))
      .toMatchObject({ source: 'lead', recordId: 'lead' });
  });

  it('P18.96-T4 AC-1 failing both, the first month the file shows a policy, from its first day — or the join date in the join month', () => {
    expect(firstSaleOf(evidence({ fileMonths: [month('2026-09', 'sep'), month('2026-08', 'aug')] }))).toEqual({
      date: '2026-08-01', source: 'monthly_file', recordCollection: 'monthlyAgentData', recordId: 'aug',
    });
    expect(firstSaleOf(evidence({ fileMonths: [month('2026-07', 'jul')] }))).toMatchObject({ date: '2026-07-15', source: 'monthly_file' });
    // A month with no policy is no sale.
    expect(firstSaleOf(evidence({ fileMonths: [month('2026-08', 'aug', 0)] }))).toBeNull();
  });

  it('P18.96-T4 AC-1 the file is the fallback, not a candidate: a closing after the file’s month still wins', () => {
    expect(firstSaleOf(evidence({ closings: [closing('2026-09-20', 'late')], fileMonths: [month('2026-08', 'aug')] })))
      .toMatchObject({ date: '2026-09-20', source: 'lead' });
  });

  it('P18.96-T4 AC-1 counts nothing before the join date: an earlier closing, or an earlier month', () => {
    expect(firstSaleOf(evidence({ closings: [closing('2026-07-14', 'x')], fileMonths: [month('2026-06', 'jun')] }))).toBeNull();
    expect(firstSaleOf(evidence({ joinDate: '2026-07-15', closings: [closing('2026-07-15', 'day1')] })))
      .toMatchObject({ date: '2026-07-15' });
  });

  it('P18.96-T4 AC-1 a member with no join date yet counts everything', () => {
    expect(firstSaleOf(evidence({ joinDate: null, closings: [closing('2020-01-02', 'old')] }))).toMatchObject({ date: '2020-01-02' });
    expect(firstSaleOf(evidence({ joinDate: null, fileMonths: [month('2020-01', 'jan')] }))).toMatchObject({ date: '2020-01-01' });
  });

  it('P18.96-T4 AC-4 dataOnly leaves a logged closing out, and falls to the file', () => {
    const e = evidence({ closings: [closing('2026-08-05', 'tick', true)], fileMonths: [month('2026-09', 'sep')] });
    expect(firstSaleOf(e)).toMatchObject({ source: 'manual' });
    expect(firstSaleOf(e, { dataOnly: true })).toMatchObject({ date: '2026-09-01', source: 'monthly_file' });
    expect(firstSaleOf(evidence({ closings: [closing('2026-08-05', 'tick', true)] }), { dataOnly: true })).toBeNull();
  });

  it('P18.96-T4 AC-1 has nothing to say with no evidence', () => {
    expect(firstSaleOf(evidence())).toBeNull();
  });
});

describe('earlierFirstSale — never later (ADR-0171 §1)', () => {
  const at = (date: string) => ({ date, source: 'lead' as const, recordCollection: 'leads' as const, recordId: date });

  it('P18.96-T4 AC-1 moves earlier, and never later', () => {
    expect(earlierFirstSale(at('2026-08-20'), at('2026-08-10'))).toEqual(at('2026-08-10'));
    expect(earlierFirstSale(at('2026-08-10'), at('2026-08-20'))).toEqual(at('2026-08-10'));
    // A day equal to the stored one keeps the stored record.
    const stored = at('2026-08-10');
    expect(earlierFirstSale(stored, { ...at('2026-08-10'), recordId: 'other' })).toBe(stored);
  });

  it('P18.96-T4 AC-1 keeps what is stored when nothing is computed — a deleted lead does not clear it — and takes the first one', () => {
    expect(earlierFirstSale(at('2026-08-10'), null)).toEqual(at('2026-08-10'));
    expect(earlierFirstSale(null, at('2026-08-10'))).toEqual(at('2026-08-10'));
    expect(earlierFirstSale(null, null)).toBeNull();
  });
});

describe('fileSaleWithdrawn — a first sale the file no longer shows (the P18.96 exit review, M4)', () => {
  const fromFile: FirstSale = { date: '2026-07-01', source: 'monthly_file', recordCollection: 'monthlyAgentData', recordId: 'm-jul' };

  it('P18.96-T8 M4 is withdrawn when the month it was read from holds no policy now: reverted, corrected to none, cleared', () => {
    expect(fileSaleWithdrawn(fromFile, [])).toBe(true);
    expect(fileSaleWithdrawn(fromFile, [{ id: 'm-aug', policies: 2 }])).toBe(true);
    expect(fileSaleWithdrawn(fromFile, [{ id: 'm-jul', policies: 0 }])).toBe(true);
  });

  it('P18.96-T8 M4 stands while its month still holds a policy', () => {
    expect(fileSaleWithdrawn(fromFile, [{ id: 'm-jul', policies: 1 }, { id: 'm-aug', policies: 2 }])).toBe(false);
  });

  it('P18.96-T8 M4 never touches a first sale from a closing, nor none at all', () => {
    for (const source of ['lead', 'manual'] as const) {
      expect(fileSaleWithdrawn({ ...fromFile, source, recordCollection: 'leads' }, [])).toBe(false);
    }
    expect(fileSaleWithdrawn(null, [])).toBe(false);
  });
});

describe('nthClosingOf — Reach Independent Agent milestone (P18.96-T4 AC-2)', () => {
  it('P18.96-T4 AC-2 is the third closing of the leads flow since joining, and nothing before it', () => {
    const e = evidence({ closings: [closing('2026-07-01', 'before'), closing('2026-08-01', 'a'), closing('2026-08-10', 'b')] });
    expect(nthClosingOf(e, 3)).toBeNull();
    expect(nthClosingOf({ ...e, closings: [...e.closings, closing('2026-09-01', 'c')] }, 3))
      .toEqual({ date: '2026-09-01', source: 'lead', recordCollection: 'leads', recordId: 'c' });
  });

  it('P18.96-T4 AC-2 leaves logged closings out: they are the ticks’ records, not the data', () => {
    const e = evidence({ closings: [closing('2026-08-01', 'a'), closing('2026-08-02', 'b'), closing('2026-08-03', 'c', true)] });
    expect(nthClosingOf(e, 3)).toBeNull();
  });

  it('P18.96-T4 AC-2 counts the leads alone: the production file’s policies never make the milestone (ADR-0171 §3)', () => {
    const e = evidence({
      closings: [closing('2026-08-01', 'a'), closing('2026-08-02', 'b')],
      fileMonths: [month('2026-08', 'aug', 5)],
    });
    expect(nthClosingOf(e, 3)).toBeNull();
    expect(nthClosingOf({ ...e, closings: [...e.closings, closing('2026-08-15', 'c')] }, 3)).toMatchObject({ source: 'lead', recordId: 'c' });
  });
});
