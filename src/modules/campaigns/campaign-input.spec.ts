import { CAMPAIGN_EVALUATION_PHASE, CAMPAIGN_METRICS, METRIC_REGISTRY, metricByKey } from '@/domain/constants';
import * as metricsModule from '@/domain/constants/metrics';
import { checkCampaign, checkCampaignShape, type CampaignShape } from './campaign-input';

const whole = (over: Record<string, unknown> = {}) => ({
  code: 'YEAR_END_DRIVE',
  title: 'Year-End Star Club Drive',
  startsAt: '2026-10-01T00:00:00Z',
  endsAt: '2026-12-31T16:59:59Z',
  reward: 'Extra unit budget',
  requirements: [{ metricKey: 'APE_ACHIEVED', comparator: 'gte', value: 50_000_000_000 }],
  ...over,
});

/**
 * Every violation `checkCampaign` raised, joined — it collects them all before it throws.
 *
 * The violations are returned as written rather than as JSON: the messages quote the offending
 * value, and stringifying them escapes those quotes into something no assertion reads naturally.
 */
const refusal = (body: unknown, opts: { partial?: boolean } = {}): string => {
  try {
    checkCampaign(body, opts);
  } catch (err) {
    const response = (err as { getResponse?: () => unknown }).getResponse?.();
    const violations = (response as { error?: { details?: { violations?: string[] } } })
      ?.error?.details?.violations
      ?? (response as { details?: { violations?: string[] } })?.details?.violations;
    return (violations ?? [String((err as Error).message)]).join(' | ');
  }
  throw new Error('checkCampaign accepted a body the test expected it to refuse');
};

/**
 * Reading one campaign off the wire (P5-T7).
 *
 * `campaign.tenancy.spec.ts` proves the metric rules — AC-1's "name a metric this product can
 * compute" — through the service. What had no test at all was this file's **other** half: the
 * shape checks that run before any metric is looked up. Each one stops a record that would
 * otherwise be stored and then misread, and every branch below was unexercised until the Phase 5
 * exit review asked why `campaigns` sat at 77% on a module full of rules.
 */
describe('reading one campaign (P5-T7)', () => {
  it('accepts a whole campaign, and copies the unit from the registry', () => {
    const read = checkCampaign(whole());

    expect(read.code).toBe('YEAR_END_DRIVE');
    // Never from the caller: a client sending its own could label sen as rupiah.
    expect(read.requirements![0]).toMatchObject({ metricKey: 'APE_ACHIEVED', unit: 'idr_minor' });
  });

  describe('the window', () => {
    it('refuses an end that is not after the start, equal ends included', () => {
      // A campaign that ends when it starts is one nobody can qualify in, stored as though
      // somebody could — the same class of silent failure as an uncomputed metric.
      expect(refusal(whole({ endsAt: '2026-10-01T00:00:00Z' })))
        .toMatch(/endsAt must be after startsAt/);
      expect(refusal(whole({ endsAt: '2026-09-30T00:00:00Z' })))
        .toMatch(/endsAt must be after startsAt/);
    });

    it('refuses a date it cannot read, naming which one', () => {
      expect(refusal(whole({ startsAt: 'tomorrow' }))).toMatch(/startsAt is not a date and time/);
      expect(refusal(whole({ endsAt: '31/12/2026' }))).toMatch(/endsAt is not a date and time/);
    });

    it('asks for both on a create and for neither on a patch', () => {
      expect(refusal({ code: 'X', title: 'X' })).toMatch(/startsAt is required/);
      expect(checkCampaign({ title: 'Renamed' }, { partial: true }))
        .toEqual({ title: 'Renamed' });
    });
  });

  describe('the requirements', () => {
    // One test below moves `CAMPAIGN_EVALUATION_PHASE` with `replaceProperty`; this puts it back.
    afterEach(() => jest.restoreAllMocks());

    it('refuses a requirements value that is not a list', () => {
      expect(refusal(whole({ requirements: { metricKey: 'APE_ACHIEVED' } })))
        .toMatch(/requirements must be a list/);
    });

    it('refuses a row that is not an object of fields, naming which row', () => {
      for (const bad of [null, 'APE_ACHIEVED', 42, ['APE_ACHIEVED']]) {
        expect(refusal(whole({ requirements: [bad] })))
          .toMatch(/Requirement 1 must be an object of fields/);
      }
    });

    it('refuses a value that is not a number', () => {
      expect(refusal(whole({
        requirements: [{ metricKey: 'APE_ACHIEVED', comparator: 'gte', value: 'lots' }],
      }))).toMatch(/Requirement 1: value must be a number/);
    });

    it('refuses money that is not whole sen (invariant §9)', () => {
      expect(refusal(whole({
        requirements: [{ metricKey: 'APE_ACHIEVED', comparator: 'gte', value: 1.5 }],
      }))).toMatch(/is money, so it is whole sen/);
    });

    it('refuses a comparator the product does not have', () => {
      expect(refusal(whole({
        requirements: [{ metricKey: 'APE_ACHIEVED', comparator: 'roughly', value: 1 }],
      }))).toMatch(/comparator is one of/);
    });

    it('names the alternatives when the metric is not one, rather than leaving a guess', () => {
      const said = refusal(whole({
        // `NET_APE` was the example until Phase 18 registered it (D-registry); FLC's count is not one (OD-26).
        requirements: [{ metricKey: 'FLC_COUNT', comparator: 'gte', value: 1 }],
      }));

      expect(said).toMatch(/"FLC_COUNT" is not a metric this product measures/);
      // P18.5-T8 AC-1: the alternatives are what a campaign may name, not every metric.
      expect(said).toMatch(new RegExp(CAMPAIGN_METRICS[0].key));
      expect(said).not.toContain('MONTHLY_ACTIVE_AGENT');
    });

    it('refuses a metric nothing measures yet, naming it and no phase', () => {
      /*
       * Since the 2026-10-08 re-plan campaigns are evaluated in 18.5, after every metric registered
       * today, so nothing real is refused as not measured yet (`registry.spec.ts` pins the empty set).
       * The rule stays for a metric registered after campaign evaluation, and is proven here with the
       * evaluation placed before the latest metric. `CAMPAIGN_EVALUATION_PHASE` is read where it is
       * declared, so this moves it for `checkCampaign` too; `restoreAllMocks` puts it back.
       */
      // *Amended 2026-10-10 (P18.6-T1):* over the metrics a campaign may require — Phase 18.6 registers two reporting
      // rates after campaign evaluation, `requirable: false`, which no requirement names and the refusal never reaches.
      const requirable = METRIC_REGISTRY.filter((m) => m.requirable !== false);
      expect(requirable.find((m) => m.phase > CAMPAIGN_EVALUATION_PHASE)).toBeUndefined();
      const latest = Math.max(...requirable.map((m) => m.phase));
      jest.replaceProperty(metricsModule as { CAMPAIGN_EVALUATION_PHASE: number }, 'CAMPAIGN_EVALUATION_PHASE', latest - 1);
      const later = METRIC_REGISTRY.find((m) => m.phase === latest && m.requirable !== false);
      expect(later).toBeTruthy();

      const said = refusal(whole({
        requirements: [{ metricKey: later!.key, comparator: 'gte', value: 1 }],
      }));
      expect(said).toContain(`${later!.name} is not measured yet`);
      expect(said).toMatch(/could never\s+qualify anybody/);
      // An Owner reads this. It said *"not computed until phase 14, and campaigns are evaluated
      // from phase 12"*: our schedule, which the reader can do nothing with — and wrong the day
      // the roadmap moved (P10.1-T2 AC-3, ADR-0062 §3).
      expect(said).not.toMatch(/phase/i);
      // Nor a bare number after the metric's name. The *Requirement 1* before it is the row.
      expect(said.slice(said.indexOf(later!.name) + later!.name.length)).not.toMatch(/\d/);
    });

    it('P18.5-T8 AC-1 accepts every metric of the evaluable set, copying its unit (D-evaluable)', () => {
      for (const { key: metricKey } of CAMPAIGN_METRICS) {
        const read = checkCampaign(whole({ requirements: [{ metricKey, comparator: 'gte', value: 1 }] }));
        expect(read.requirements![0]).toMatchObject({ metricKey, unit: metricByKey(metricKey)!.unit });
      }
    });

    it('P18.5-T8 AC-1 refuses what nobody achieves over a window — a target, an enum, a toggle, a per-event rate — naming what may be', () => {
      /*
       * *Amended 2026-10-10 (D-evaluable):* until P18.5-T8 a campaign could name any of the sixty requirable metrics —
       * the six coaching metrics since P10.1-T2 AC-7, and the unit rollups and the Owner's reporting metrics since the
       * 2026-10-08 re-plan. Measured is not enough: a coaching recency, a target, a pace status, a training toggle or
       * an event's NPS is nothing a member achieves over a campaign's window. A stored one reads *Not measured yet*.
       */
      for (const metricKey of [
        'COACHED_7D', 'GOAL_PACE_STATUS', 'PACING_TO_MAA', 'SUB_PERIOD_ACTIVITY_TARGET', 'APE_TARGET',
        'TRAINING_COMPLETION_PCT', 'EVENT_ATTENDANCE_RATE', 'EVENT_NPS', 'MOC_STATUS', 'PRODUCTION_CLUB_TIER',
        'CAMPAIGN_QUALIFICATION_STATUS', 'ACTIVITY_COMPLIANCE_RATE', 'LEADER_COACHING_FREQUENCY',
      ]) {
        const said = refusal(whole({ requirements: [{ metricKey, comparator: 'gte', value: 1 }] }));
        expect([metricKey, said]).toEqual([metricKey, expect.stringContaining(
          `${metricByKey(metricKey)!.name} is not something a campaign can measure`,
        )]);
        expect(said).toContain(metricByKey('APE_ACHIEVED')!.name);
        expect(said).not.toMatch(/phase/i);
      }
      // And nothing a campaign may require is left on the far side of the phase line: the refusal and `GET /metrics`
      // (which lists the requirable metrics) draw the same one.
      expect(METRIC_REGISTRY.filter((m) => m.requirable !== false && m.phase > CAMPAIGN_EVALUATION_PHASE)).toEqual([]);
    });

    it('P13.2-T4: refuses Leaders used — an office’s count, not anybody’s work — and never offers it', () => {
      const said = refusal(whole({ requirements: [{ metricKey: 'LEADERS_USED', comparator: 'lte', value: 10 }] }));
      expect(said).toContain('Leaders used counts the office, not anybody’s work');
      expect(said).not.toMatch(/LEADER_LIMIT|phase/i);
      // Nor is it among the alternatives an unknown key is answered with.
      expect(refusal(whole({ requirements: [{ metricKey: 'NOPE', comparator: 'gte', value: 1 }] })))
        .not.toContain('LEADERS_USED');
    });

    it('collects every violation rather than stopping at the first', () => {
      // ADR-0030: an edit that half-saved leaves nobody able to find out which half.
      const said = refusal(whole({
        endsAt: '2026-09-01T00:00:00Z',
        requirements: [{ metricKey: 'NOPE', comparator: 'roughly', value: 'lots' }],
      }));

      expect(said).toMatch(/endsAt must be after startsAt/);
      expect(said).toMatch(/is not a metric this product measures/);
      expect(said).toMatch(/comparator is one of/);
      expect(said).toMatch(/value must be a number/);
    });
  });

  describe('P18.5-T7 AC-9 the card’s fields (D-fields)', () => {
    it('P18.5-T7 AC-9 reads the kind, section, window, rungs, poster and blurb, and none is required', () => {
      const read = checkCampaign(whole({
        kind: 'structural', subtype: 'ongoing', window: 'calendar_year', appliesToOrgLevelCodes: ['agent', 'AAB', 'AAB'],
        poster: { emoji: '🏆', color: 'gold' }, blurb: '  Standing production benchmark.  ', endsAt: null,
      }));
      expect(read).toMatchObject({
        kind: 'structural', subtype: 'ongoing', window: 'calendar_year', appliesToOrgLevelCodes: ['AGENT', 'AAB'],
        poster: { emoji: '🏆', color: 'gold' }, blurb: 'Standing production benchmark.', endsAt: null,
      });
      expect(checkCampaign(whole())).not.toHaveProperty('kind');
      expect(checkCampaign({ subtype: null }, { partial: true })).toEqual({ subtype: null });
    });

    it('P18.5-T7 AC-9 refuses each new field by name when it is not one', () => {
      const said = refusal(whole({
        kind: 'annual', subtype: 'trip', window: 'per_month', appliesToOrgLevelCodes: 'AGENT', blurb: 'x'.repeat(201),
      }));
      expect(said).toMatch(/kind must be one of seasonal, structural/);
      expect(said).toMatch(/subtype must be one of promotion, ongoing/);
      expect(said).toMatch(/window must be one of campaign_dates, calendar_year, rolling_12m/);
      expect(said).toMatch(/appliesToOrgLevelCodes must be a list of codes/);
      expect(said).toMatch(/blurb must be 0–200 characters/);
    });

    it('P18.5-T7 AC-9 takes a poster as one emoji and a palette colour — never a hex, a word or markup', () => {
      for (const poster of [
        { emoji: '🚀', color: '#F2994A' }, { emoji: 'Rocket', color: 'amber' }, { emoji: '<b>', color: 'amber' },
        { emoji: '', color: 'navy' }, 'rocket', null, { emoji: '🚀', color: 'navy', size: 2 },
      ]) {
        expect(refusal(whole({ poster }))).toMatch(/poster/);
      }
      expect(checkCampaign(whole({ poster: { emoji: '🎖️', color: 'navy-soft' } })).poster).toEqual({ emoji: '🎖️', color: 'navy-soft' });
    });

    it('P18.5-T8 review item 9 refuses a figure asked for twice, an unknown one included, and a row missing its metric', () => {
      expect(refusal(whole({ requirements: [{ metricKey: 'NOPE', comparator: 'gte', value: 1 }, { metricKey: 'nope', comparator: 'gte', value: 2 }] })))
        .toMatch(/Requirement 2: NOPE is asked for already/);
      expect(refusal(whole({ requirements: [{ comparator: 'gte', value: 1 }] }))).toMatch(/"" is not a metric this product measures/);
      expect(refusal(whole({ requirements: [{ metricKey: 'APE_ACHIEVED', value: 1 }] }))).toMatch(/comparator is one of/);
    });

    it('P18.5-T8 review item 10 keeps a stored requirement sent back unchanged, by metric, comparator and value', () => {
      const keep = [{ metricKey: 'EVENT_NPS', comparator: 'gte' as const, value: 50, unit: 'score' }];
      expect(checkCampaign({ requirements: [{ metricKey: 'event_nps', comparator: 'gte', value: 50 }] }, { partial: true, keep }).requirements)
        .toEqual(keep);
      expect(refusal({ requirements: [{ metricKey: 'EVENT_NPS', comparator: 'gte', value: 60 }] })).toMatch(/not something a campaign can measure/);
    });

    it('P18.5-T7 AC-9 reads a description, refuses a body that is not an object, and a poster whose emoji is not text', () => {
      expect(checkCampaign(whole({ description: '  The office’s own.  ' })).description).toBe('The office’s own.');
      expect(refusal(null)).toMatch(/must be an object of fields|is required/);
      expect(refusal(whole({ poster: { emoji: 7, color: 'navy' } }))).toMatch(/poster.emoji is one emoji/);
    });

    it('P18.5-T7 AC-5 reserves CHASING: the chases read’s address, never a campaign’s', () => {
      expect(refusal(whole({ code: 'chasing' }))).toMatch(/CHASING is a word the Campaigns pages use/);
    });

    it('P18.5-T7 AC-9 lets a structural campaign end nowhere: endsAt null, and an unreadable end refused', () => {
      expect(checkCampaign(whole({ endsAt: null })).endsAt).toBeNull();
      expect(refusal(whole({ endsAt: 'never' }))).toMatch(/endsAt is not a date and time/);
    });
  });

  describe('P18.5-T7 AC-9, P18.5-T8 AC-2 a campaign across its fields', () => {
    const JKT = { timezone: 'Asia/Jakarta', rungCodes: ['AB', 'AAB', 'AGENT'] };
    const wib = (local: string) => new Date(`${local}+07:00`);
    const shape = (over: Partial<CampaignShape> = {}): CampaignShape => ({
      kind: 'seasonal', subtype: null, window: 'campaign_dates', startsAt: wib('2026-07-01T00:00:00'),
      endsAt: wib('2026-09-30T23:59:00'), requirements: [{ metricKey: 'APE_ACHIEVED' }], appliesToOrgLevelCodes: [], ...over,
    });
    const refused = (s: CampaignShape): string => {
      try {
        checkCampaignShape(s, JKT);
      } catch (err) {
        const response = (err as { getResponse?: () => unknown }).getResponse?.() as { details?: { violations?: string[] } };
        return (response?.details?.violations ?? [String(err)]).join(' | ');
      }
      throw new Error('checkCampaignShape accepted a campaign the test expected it to refuse');
    };

    it('P18.5-T8 AC-2 takes a seasonal campaign over whole office months, and a structural one with no end', () => {
      expect(() => checkCampaignShape(shape(), JKT)).not.toThrow();
      expect(() => checkCampaignShape(shape({
        kind: 'structural', subtype: 'promotion', window: 'rolling_12m', endsAt: null, appliesToOrgLevelCodes: ['AAB'],
      }), JKT)).not.toThrow();
    });

    it('P18.5-T8 AC-2 refuses a file metric over part of a month, with the sentence — and lets activity take any days', () => {
      expect(refused(shape({ startsAt: wib('2026-08-15T00:00:00'), endsAt: wib('2026-09-15T23:59:00') })))
        .toContain('A campaign asking for figures from the monthly production file runs in whole months: start it on the 1st and end it on the last day of a month.');
      expect(() => checkCampaignShape(shape({
        startsAt: wib('2026-08-15T00:00:00'), endsAt: wib('2026-09-15T23:59:00'), requirements: [{ metricKey: 'RECRUITMENT_SUCCESS_RATE' }],
      }), JKT)).not.toThrow();
    });

    it('P18.5-T7 AC-9 refuses a seasonal campaign with no end, another window or a subtype; a structural one without a section or with its dates', () => {
      expect(refused(shape({ endsAt: null }))).toMatch(/A seasonal campaign needs an end/);
      expect(refused(shape({ window: 'calendar_year' }))).toMatch(/window is campaign_dates/);
      expect(refused(shape({ subtype: 'ongoing' }))).toMatch(/Only a structural campaign has a subtype/);
      expect(refused(shape({ kind: 'structural', window: 'calendar_year', endsAt: null }))).toMatch(/subtype is required/);
      expect(refused(shape({ kind: 'structural', subtype: 'ongoing' }))).toMatch(/read over calendar_year or rolling_12m/);
    });

    it('P18.5-T7 AC-9 names a rung the company’s ladder does not have', () => {
      expect(refused(shape({ appliesToOrgLevelCodes: ['AGENT', 'SENIOR_AB'] }))).toMatch(/SENIOR_AB is not a rung of your company's ladder/);
      expect(refused(shape({ appliesToOrgLevelCodes: ['X1', 'X2'] }))).toMatch(/X1, X2 are not rungs/);
    });
  });
});
