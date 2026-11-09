import { countsForProduction, newHireBeforeFirstSale, type ProductionStanding } from './counts-for-production';

const DAY = '2026-10-08';
const member = (over: Partial<ProductionStanding>): ProductionStanding => ({ joinedAs: 'new_hire', firstSaleDate: null, ...over });

describe('COUNTS_FOR_PRODUCTION (ADR-0172 §2, P18.8-T5)', () => {
  it('P18.8-T5 AC-2 an existing agent always counts, with a first sale or none', () => {
    expect(countsForProduction(member({ joinedAs: 'existing_agent', firstSaleDate: null }), DAY)).toBe(true);
    expect(countsForProduction(member({ joinedAs: 'existing_agent', firstSaleDate: '2026-10-20' }), DAY)).toBe(true);
  });

  it('P18.8-T5 AC-2 a membership not classified yet is nobody’s new hire, and counts', () => {
    expect(countsForProduction(member({ joinedAs: null }), DAY)).toBe(true);
  });

  it('P18.8-T5 AC-2 a new hire with no first sale does not count', () => {
    expect(countsForProduction(member({ firstSaleDate: null }), DAY)).toBe(false);
  });

  it('P18.8-T5 AC-2 a new hire counts from their first sale’s day: not the day before, on it, and after it', () => {
    expect(countsForProduction(member({ firstSaleDate: '2026-10-09' }), DAY)).toBe(false);
    expect(countsForProduction(member({ firstSaleDate: DAY }), DAY)).toBe(true);
    expect(countsForProduction(member({ firstSaleDate: '2026-09-28' }), DAY)).toBe(true);
  });

  it('P18.8-T5 AC-2 compares office dates as the calendar does, across a month and a year', () => {
    expect(countsForProduction(member({ firstSaleDate: '2026-09-30' }), '2026-10-01')).toBe(true);
    expect(countsForProduction(member({ firstSaleDate: '2027-01-01' }), '2026-12-31')).toBe(false);
  });

  it('P18.8-T5 AC-3 the New hire tag is the rule’s other side, never a second rule', () => {
    for (const m of [
      member({}), member({ firstSaleDate: DAY }), member({ firstSaleDate: '2026-10-09' }),
      member({ joinedAs: 'existing_agent' }), member({ joinedAs: null }),
    ]) {
      expect(newHireBeforeFirstSale(m, DAY)).toBe(!countsForProduction(m, DAY));
    }
    expect(newHireBeforeFirstSale(member({}), DAY)).toBe(true);
    expect(newHireBeforeFirstSale(member({ firstSaleDate: DAY }), DAY)).toBe(false);
  });
});
