import {
  ACTIVATION,
  ACTIVITY,
  GOAL_DEFAULTS,
  PERFORMANCE,
  RATIO_BENCHMARKS,
  TIME,
  DEFAULT_TENANT_TIMEZONE,
  MINOR_UNITS_PER_MAJOR,
} from './index';

/**
 * These tests exist to fail when a number drifts. Every value here is documented in
 * docs/00-product/metrics-and-definitions.md with a prototype citation; changing one
 * without changing the documentation should break the build.
 */
describe('domain constants', () => {
  describe('ratio benchmarks (Overall.html:5208-5273)', () => {
    it('pins the selling success rate at 15%', () => {
      expect(RATIO_BENCHMARKS.SELLING_SUCCESS_RATE).toBe(0.15);
    });
    it('pins the recruitment success rate at 15%', () => {
      expect(RATIO_BENCHMARKS.RECRUITMENT_SUCCESS_RATE).toBe(0.15);
    });
    it('pins leads per activity at 0.30', () => {
      expect(RATIO_BENCHMARKS.LEADS_PER_ACTIVITY).toBe(0.3);
    });
    it('pins meeting per approach at 1.50', () => {
      expect(RATIO_BENCHMARKS.MEETING_PER_APPROACH).toBe(1.5);
    });
    it('pins the selling/recruitment balance band at ±30 points', () => {
      expect(RATIO_BENCHMARKS.BALANCE_BAND_PP).toBe(30);
    });
  });

  describe('goal defaults (Overall.html:2872-2996)', () => {
    it('pins the default case size at Rp 18,000,000 expressed in minor units', () => {
      expect(GOAL_DEFAULTS.CASE_SIZE_MINOR).toBe(18_000_000 * MINOR_UNITS_PER_MAJOR);
    });
    it('pins both conversion assumptions at 30%', () => {
      expect(GOAL_DEFAULTS.LEADS_TO_APPOINTMENT_PCT).toBe(30);
      expect(GOAL_DEFAULTS.CLOSING_RATE_PCT).toBe(30);
    });
    it('pins the commission rate at 10%, which yields the prototype 500M from 50M savings', () => {
      expect(GOAL_DEFAULTS.COMMISSION_RATE_PCT).toBe(10);
      const derived =
        GOAL_DEFAULTS.ANNUAL_SAVINGS_TARGET_MINOR / (GOAL_DEFAULTS.COMMISSION_RATE_PCT / 100);
      expect(derived).toBe(GOAL_DEFAULTS.ANNUAL_APE_TARGET_MINOR);
    });
    it('clamps months-left to a floor so the cascade cannot divide by zero', () => {
      expect(GOAL_DEFAULTS.MONTHS_LEFT_MIN).toBe(0.1);
      expect(GOAL_DEFAULTS.MONTHS_LEFT_MIN).toBeGreaterThan(0);
    });
  });

  describe('time conversion (Overall.html:5751, :5818, :7023)', () => {
    it('pins the projection constants', () => {
      expect(TIME.AVG_DAYS_PER_MONTH).toBe(30.44);
      expect(TIME.WEEKS_PER_MONTH).toBe(4.33);
      expect(TIME.MONTHS_PER_YEAR).toBe(12);
      expect(TIME.MS_PER_DAY).toBe(86_400_000);
    });
    it('keeps the two month constants mutually consistent to within a day', () => {
      expect(TIME.AVG_DAYS_PER_MONTH / 7).toBeCloseTo(TIME.WEEKS_PER_MONTH, 1);
    });
  });

  describe('activity and activation', () => {
    it('pins the per-item daily count range at 0..999', () => {
      expect(ACTIVITY.COUNT_MIN).toBe(0);
      expect(ACTIVITY.COUNT_MAX).toBe(999);
    });
    it('pins the activation window at 90 days, counted from day 1', () => {
      expect(ACTIVATION.WINDOW_DAYS).toBe(90);
      expect(ACTIVATION.DAY_INDEX_BASE).toBe(1);
    });
  });

  describe('performance thresholds', () => {
    it('pins the on-track pace threshold at 90%', () => {
      expect(PERFORMANCE.ON_TRACK_PACE_THRESHOLD).toBe(0.9);
    });
    it('pins the coaching overdue threshold at 7 days', () => {
      expect(PERFORMANCE.COACHING_OVERDUE_DAYS).toBe(7);
    });
    it('pins the ratio window at 30 days', () => {
      expect(PERFORMANCE.RATIO_WINDOW_DAYS).toBe(30);
    });
  });

  it('defaults tenants to Asia/Jakarta, never UTC', () => {
    expect(DEFAULT_TENANT_TIMEZONE).toBe('Asia/Jakarta');
    expect(DEFAULT_TENANT_TIMEZONE).not.toBe('UTC');
  });
});
