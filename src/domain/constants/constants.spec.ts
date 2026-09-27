import {
  ACTIVATION,
  CASCADE_ACTIVITY_CODES,
  ASSET_LIMITS,
  PRODUCTION,
  PRODUCTION_UPLOAD,
  ACTIVITY,
  GOAL_DEFAULTS,
  PERFORMANCE,
  RATIO_BENCHMARKS,
  TIME,
  DEFAULT_CURRENCY,
  DEFAULT_ORG_LADDER,
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

  /**
   * Invariant §4 in three assertions. The prototype's footnote reads "Maps to activities #3, #4, #6
   * in Activity Management" (`Overall.html:3064`, `:5967`), and those numbers are **display order**,
   * which an office can drag. These pin the codes the cascade actually binds to, against the table in
   * `metrics-and-definitions.md` — a test that compares the constant to itself pins nothing.
   */
  describe('the goal cascade binds to codes (Overall.html:3064, :5967)', () => {
    it('pins the leads stage to LEADS_CONTACTED', () => {
      expect(CASCADE_ACTIVITY_CODES.leadsCode).toBe('LEADS_CONTACTED');
    });
    it('pins the appointments stage to SELL_PRESENTATION', () => {
      expect(CASCADE_ACTIVITY_CODES.appointmentsCode).toBe('SELL_PRESENTATION');
    });
    it('pins the closings stage to SELL_SUBMISSION', () => {
      expect(CASCADE_ACTIVITY_CODES.closingsCode).toBe('SELL_SUBMISSION');
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
      // ADR-0042: the current calendar month, plus this many days into the next.
      expect(ACTIVITY.BACKDATE_GRACE_DAYS).toBe(7);
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

    // The ladder every company starts with. Junior first, and the codes are the
    // `HierarchyRole` values upper-cased — that one-to-one is what lets the enum keep
    // working while `orgLevelId` becomes the stored truth (ADR-0012 §3).
    expect(DEFAULT_ORG_LADDER.map((l) => l.code)).toEqual(['AGENT', 'AAB', 'AB']);
    expect(DEFAULT_ORG_LADDER.map((l) => l.displayOrder)).toEqual([1, 2, 3]);
    expect(DEFAULT_ORG_LADDER.map((l) => l.code.toLowerCase())).toEqual(['agent', 'aab', 'ab']);

    // Three registry rows that named no test until the Phase 3.5 exit re-review. The rule
    // is that every number in `metrics-and-definitions.md` is pinned by a test that fails
    // if it drifts, and these three were the exceptions.
    expect(PERFORMANCE.COMPLIANCE_WINDOW_DAYS).toBe(7);
    // The cap is on a *percentage*, and is deliberately not the same constant as the
    // 0–999 activity-count clamp even though both read 999 — `metrics:1450` says so.
    expect(PERFORMANCE.ATTAINMENT_PCT_CAP).toBe(999);
    expect(DEFAULT_CURRENCY).toBe('IDR');
  });

  describe('the monthly production upload (P9-T3)', () => {
    it('pins the ceiling at 1 MiB — ten thousand rows of the template, more than any office', () => {
      expect(PRODUCTION_UPLOAD.MAX_BYTES).toBe(1024 * 1024);
      expect(PRODUCTION_UPLOAD.MAX_BYTES).toBe(1_048_576);
    });

    it('pins a half-written import as stranded after ten minutes (P9-T4)', () => {
      expect(PRODUCTION_UPLOAD.STRANDED_AFTER_MINUTES).toBe(10);
    });

    it('locks a month seven days after it ends — the activity window’s number, as ADR-0050 decided', () => {
      expect(PRODUCTION.LOCK_GRACE_DAYS).toBe(7);
      expect(PRODUCTION.LOCK_GRACE_DAYS).toBe(ACTIVITY.BACKDATE_GRACE_DAYS);
    });
  });

  describe('upload limits (ADR-0032, ADR-0040)', () => {
    /*
     * These lived in `modules/assets/storage.port.ts` and were in no registry at all until the
     * Phase 5 exit review — a threshold outside `domain/constants/` is one that can be
     * re-declared without anybody noticing, which is the whole of invariant §7.
     */
    it('pins the ceiling at 25 MB, above which material is a link rather than an upload', () => {
      expect(ASSET_LIMITS.MAX_BYTES).toBe(25 * 1024 * 1024);
      expect(ASSET_LIMITS.MAX_BYTES).toBe(26_214_400);
    });

    it('pins the signed-URL life at 300 seconds', () => {
      expect(ASSET_LIMITS.SIGNED_URL_TTL_SECONDS).toBe(300);
    });

    it('pins the accepted types, so widening the list is a deliberate change', () => {
      expect([...ASSET_LIMITS.ALLOWED_MIME_TYPES]).toEqual([
        'image/jpeg', 'image/png', 'image/webp',
        'application/pdf',
        'video/mp4',
        'text/csv', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      ]);
    });
  });
});
