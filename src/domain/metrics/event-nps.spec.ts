import { EVENT_FEEDBACK_TEXT_MAX, NPS } from '@/domain/constants';
import { eventNps, isNpsScore, npsBucket } from './event-nps';

describe('EVENT_NPS (P18.5-T6 AC-6)', () => {
  it('P18.5-T6 AC-6 pins the NPS constants and the feedback text limit (invariant §7)', () => {
    expect(NPS).toEqual({ SCALE_MIN: 0, SCALE_MAX: 10, PROMOTER_MIN: 9, DETRACTOR_MAX: 6 });
    expect(EVENT_FEEDBACK_TEXT_MAX).toBe(1000);
  });

  it('P18.5-T6 AC-6 the Town Hall’s eight answers give 0, as drawn (KPM_Owner.html:2990-2998)', () => {
    expect(eventNps([10, 9, 9, 8, 7, 6, 5, 4])).toEqual({ nps: 0, n: 8, promoters: 3, passives: 2, detractors: 3 });
  });

  it('P18.5-T6 AC-6 one rounding: n = 7, P = 4, D = 2 gives 29, not the double rounding’s 28', () => {
    const scores = [10, 9, 9, 10, 7, 3, 0];
    expect(eventNps(scores).nps).toBe(29);
    // The registry's old formula, for the record of why it was replaced.
    expect(Math.round((4 / 7) * 100) - Math.round((2 / 7) * 100)).toBe(28);
  });

  it('P18.5-T6 AC-6 all detractors is −100, all promoters 100', () => {
    expect(eventNps([0, 3, 6]).nps).toBe(-100);
    expect(eventNps([9, 10]).nps).toBe(100);
  });

  it('P18.5-T6 AC-6 null with no response — never 0', () => {
    expect(eventNps([])).toEqual({ nps: null, n: 0, promoters: 0, passives: 0, detractors: 0 });
  });

  it('P18.5-T6 AC-6 never a signed zero, and rounds half toward +∞ as the prototype’s Math.round does', () => {
    // One detractor among 201: 100·(−1)/201 ≈ −0.5, which `Math.round` makes −0.
    expect(Object.is(eventNps([5, ...Array<number>(200).fill(7)]).nps, -0)).toBe(false);
    expect(eventNps([5, ...Array<number>(200).fill(7)]).nps).toBe(0);
    // The prototype's `Math.round`, kept (the exit review): a half rounds toward +∞, so at n = 8 P − D = −1 is
    // −12.5 → −12 and P − D = +1 is +12.5 → +13 — asymmetric, and the Owner's card has always read it so.
    expect(eventNps([9, 5, 6, 7, 7, 7, 7, 8]).nps).toBe(-12);
    expect(eventNps([9, 10, 5, 7, 7, 7, 7, 8]).nps).toBe(13);
  });

  it('P18.5-T6 AC-6 buckets a score: 9–10 promoter, 7–8 passive, 0–6 detractor', () => {
    expect([0, 6, 7, 8, 9, 10].map(npsBucket)).toEqual(['detractor', 'detractor', 'passive', 'passive', 'promoter', 'promoter']);
  });

  it('P18.5-T6 AC-3 a score is a whole number from 0 to 10', () => {
    expect([0, 10, 5].every(isNpsScore)).toBe(true);
    expect([-1, 11, 5.5, '7', null, undefined, Number.NaN].some(isNpsScore)).toBe(false);
  });
});
