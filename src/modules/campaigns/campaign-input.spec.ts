import { CAMPAIGN_EVALUATION_PHASE, METRIC_REGISTRY, metricByKey } from '@/domain/constants';
import { checkCampaign } from './campaign-input';

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
        requirements: [{ metricKey: 'NET_APE', comparator: 'gte', value: 1 }],
      }));

      expect(said).toMatch(/"NET_APE" is not a metric this product measures/);
      expect(said).toMatch(new RegExp(METRIC_REGISTRY[0].key));
    });

    it('refuses a metric nothing measures yet, naming it and no phase', () => {
      const later = METRIC_REGISTRY.find((m) => m.phase > CAMPAIGN_EVALUATION_PHASE);
      // If every metric is computed by now the rule has nothing to guard, and the test should
      // say so rather than quietly pass on an empty search.
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

    it('accepts a coaching metric: coaching (Phase 11) precedes campaign evaluation (14) now (P10.1-T2 AC-7)', () => {
      /*
       * Decided, not inherited. The 2026-09-29 re-plan brought coaching forward from the old
       * plan's 13 to 11 and campaigns from 12 to 14, so these six are measured by the time a
       * campaign is evaluated. Under the old numbers each was refused as not measured yet.
       * `registry.spec.ts` pins the whole set and the difference; this proves the refusal reads it.
       */
      const coaching = [
        'COACHED_7D', 'COACHED_30D', 'DAYS_SINCE_LAST_COACHING', 'COACHING_COVERAGE', 'GOAL_PACE_STATUS', 'PACING_TO_MAA',
      ];
      for (const metricKey of coaching) {
        const read = checkCampaign(whole({ requirements: [{ metricKey, comparator: 'gte', value: 1 }] }));
        expect(read.requirements![0]).toMatchObject({ metricKey, unit: metricByKey(metricKey)!.unit });
      }
    });

    it('still refuses the seven nothing measures by then, each by its name', () => {
      // The unit rollups (Phase 15) and the Owner's reporting metrics (18): refused before the
      // phases moved, refused after. Nothing but the coaching six changed sides.
      const refused = [
        'MAA_COUNT_IN_UNIT', 'ACTIVITY_COMPLIANCE_RATE', 'LEADER_COACHING_FREQUENCY',
        'EVENT_ATTENDANCE_RATE', 'EVENT_NPS', 'MOC_STATUS', 'PRODUCTION_CLUB_TIER',
      ];
      for (const metricKey of refused) {
        expect(refusal(whole({ requirements: [{ metricKey, comparator: 'gte', value: 1 }] })))
          .toContain(`${metricByKey(metricKey)!.name} is not measured yet`);
      }
      // And those are all of them: the refusal and `GET /metrics` draw the same line.
      expect(METRIC_REGISTRY.filter((m) => m.phase > CAMPAIGN_EVALUATION_PHASE).map((m) => m.key).sort())
        .toEqual([...refused].sort());
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
});
