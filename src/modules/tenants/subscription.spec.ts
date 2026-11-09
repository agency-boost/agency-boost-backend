import { FixedClock } from '@/common/clock/clock.port';
import { SUBSCRIPTION } from '@/domain/constants';
import {
  isEnded, subscriptionStateOf, subscriptionStateOn, validateSubscription, type SubscriptionInput,
} from './subscription';

/**
 * An office's subscription as rules (ADR-0112, P13.2-T3 AC-1, AC-3, AC-4): the ended rule on office
 * dates, and the validation the write holds a subscription to.
 */
describe('the ended rule (ADR-0112 §3)', () => {
  const ending = (endDate: string | null, keepActiveAfterEnd = false) => ({ endDate, keepActiveAfterEnd });

  it('no end date is no end: none, whatever today is', () => {
    expect(subscriptionStateOn(null, '2026-10-07')).toBe('none');
    expect(subscriptionStateOn(undefined, '2026-10-07')).toBe('none');
    expect(subscriptionStateOn(ending(null), '2099-01-01')).toBe('none');
  });

  it('the end date itself is served: it is the last day the office can be used', () => {
    expect(subscriptionStateOn(ending('2026-10-07'), '2026-10-06')).toBe('active');
    expect(subscriptionStateOn(ending('2026-10-07'), '2026-10-07')).toBe('active');
  });

  it('ended from the next office day, unless kept active', () => {
    expect(subscriptionStateOn(ending('2026-10-07'), '2026-10-08')).toBe('ended');
    expect(subscriptionStateOn(ending('2026-10-07', true), '2026-10-08')).toBe('ended_kept_active');
  });

  it('compares across a month and a year end', () => {
    expect(subscriptionStateOn(ending('2026-12-31'), '2027-01-01')).toBe('ended');
    expect(subscriptionStateOn(ending('2026-09-30'), '2026-10-01')).toBe('ended');
  });
});

/**
 * **AC-4: the end on office dates.** The rule reads the office's today in its own zone through the
 * clock port, so the process's zone changes nothing: with it in UTC, Jakarta or New York, an office
 * whose end date is 30 September is served until 16:59:59 UTC on the 30th and refused from 17:00 UTC —
 * 00:00 on 1 October in Jakarta.
 */
describe.each(['UTC', 'Asia/Jakarta', 'America/New_York'])('the end, with the process clock in %s (AC-4)', (zone) => {
  const original = process.env.TZ;
  beforeAll(() => { process.env.TZ = zone; });
  afterAll(() => { process.env.TZ = original; });

  const office = {
    timezone: 'Asia/Jakarta',
    subscription: {
      startDate: '2026-01-01', endDate: '2026-09-30', pricePerLeaderMinor: null,
      currency: 'IDR' as const, maxLeaders: null, keepActiveAfterEnd: false,
    },
  };

  it('serves the office at the first minute of its end date in Jakarta', () => {
    const clock = new FixedClock(new Date('2026-09-29T17:00:00Z'));
    expect(subscriptionStateOf(office, clock)).toBe('active');
  });

  it('serves the office at 23:59:59 on its end date in Jakarta (16:59:59 UTC)', () => {
    const clock = new FixedClock(new Date('2026-09-30T16:59:59Z'));
    expect(subscriptionStateOf(office, clock)).toBe('active');
    expect(isEnded(office, clock)).toBe(false);
  });

  it('refuses from 00:00 the next day in Jakarta (17:00 UTC on the end date)', () => {
    const clock = new FixedClock(new Date('2026-09-30T17:00:00Z'));
    expect(subscriptionStateOf(office, clock)).toBe('ended');
    expect(isEnded(office, clock)).toBe(true);
  });

  it('keeps an office kept active open past the same instant', () => {
    const clock = new FixedClock(new Date('2026-09-30T17:00:00Z'));
    const kept = { ...office, subscription: { ...office.subscription, keepActiveAfterEnd: true } };
    expect(subscriptionStateOf(kept, clock)).toBe('ended_kept_active');
    expect(isEnded(kept, clock)).toBe(false);
  });

  it('reads an office with no timezone in the platform default, never the process zone', () => {
    const clock = new FixedClock(new Date('2026-09-30T17:00:00Z'));
    expect(subscriptionStateOf({ ...office, timezone: null }, clock)).toBe('ended');
  });
});

describe('validating a subscription (AC-1)', () => {
  const valid: SubscriptionInput = {
    startDate: '2026-10-01', endDate: '2027-09-30', pricePerLeaderMinor: 350_000_00,
    maxLeaders: 10, keepActiveAfterEnd: false,
  };
  const refusedOn = (input: Partial<SubscriptionInput>) => {
    try {
      validateSubscription({ ...valid, ...input } as SubscriptionInput);
    } catch (err) {
      const e = err as { code: string; details: { field: string }; getStatus: () => number };
      return { code: e.code, field: e.details.field, status: e.getStatus() };
    }
    return null;
  };

  it('keeps a valid subscription, IDR its currency', () => {
    // No plan sent is none here; the service keeps the office's own (P19.4-T3, ADR-0211 §1).
    expect(validateSubscription(valid)).toEqual({ ...valid, currency: 'IDR', plan: null });
  });

  it('P19.4-T3 AC-10 takes a plan, six months or annual, or none', () => {
    expect(validateSubscription({ ...valid, plan: 'six_months' }).plan).toBe('six_months');
    expect(validateSubscription({ ...valid, plan: 'annual' }).plan).toBe('annual');
    expect(validateSubscription({ ...valid, plan: null }).plan).toBeNull();
    expect(refusedOn({ plan: 'monthly' as never })).toEqual({ code: 'VALIDATION_FAILED', field: 'plan', status: 400 });
  });

  it('takes no subscription at all: every field empty, keep active off', () => {
    expect(validateSubscription({
      startDate: null, endDate: null, pricePerLeaderMinor: null, maxLeaders: null, keepActiveAfterEnd: false,
    })).toMatchObject({ startDate: null, endDate: null, maxLeaders: null });
  });

  it('takes a start and an end on the same day', () => {
    expect(validateSubscription({ ...valid, startDate: '2026-10-01', endDate: '2026-10-01' }).endDate).toBe('2026-10-01');
  });

  it.each([
    ['a start with no end', { endDate: null }, 'endDate'],
    ['an end with no start', { startDate: null }, 'startDate'],
    ['an end before the start', { startDate: '2026-10-02', endDate: '2026-10-01' }, 'endDate'],
    ['a start that is no day', { startDate: '2026-02-30' }, 'startDate'],
    ['an end in the wrong shape', { endDate: '30/09/2027' }, 'endDate'],
    ['a negative price', { pricePerLeaderMinor: -100 }, 'pricePerLeaderMinor'],
    ['a price over the bound', { pricePerLeaderMinor: SUBSCRIPTION.PRICE_PER_LEADER_MAX_MINOR + 100 }, 'pricePerLeaderMinor'],
    ['a fraction of a rupiah', { pricePerLeaderMinor: 350_000_50 }, 'pricePerLeaderMinor'],
    ['a fractional price', { pricePerLeaderMinor: 1.5 }, 'pricePerLeaderMinor'],
    ['a limit of 0', { maxLeaders: 0 }, 'maxLeaders'],
    ['a limit over the bound', { maxLeaders: SUBSCRIPTION.MAX_LEADERS_MAX + 1 }, 'maxLeaders'],
    ['a fractional limit', { maxLeaders: 2.5 }, 'maxLeaders'],
    ['keep active that is not a switch', { keepActiveAfterEnd: null as unknown as boolean }, 'keepActiveAfterEnd'],
  ])('refuses %s, 400 VALIDATION_FAILED naming the field', (_what, input, field) => {
    expect(refusedOn(input)).toEqual({ code: 'VALIDATION_FAILED', field, status: 400 });
  });

  /*
   * **Plain words, in rupiah** (P13.2 exit review): the dialog shows each refusal under its field, to a
   * Super Admin who typed rupiah. It read *"pricePerLeaderMinor must not be greater than 10000000000"*.
   */
  it.each([
    [{ pricePerLeaderMinor: SUBSCRIPTION.PRICE_PER_LEADER_MAX_MINOR + 100 }, 'The price per leader must be from Rp 0 to Rp 100.000.000 a month.'],
    [{ pricePerLeaderMinor: -100 }, 'The price per leader must be from Rp 0 to Rp 100.000.000 a month.'],
    [{ pricePerLeaderMinor: 350_000_50 }, 'The price per leader must be whole rupiah, with no sen.'],
    [{ maxLeaders: 0 }, 'The leader limit must be a whole number from 1 to 10.000, or empty for no limit.'],
    [{ startDate: '2026-02-30' }, 'The start date is not a real day.'],
    [{ endDate: '2026-02-30' }, 'The end date is not a real day.'],
    [{ endDate: null }, 'Enter a start date and an end date, or neither.'],
    [{ startDate: '2026-10-02', endDate: '2026-10-01' }, 'The end date must be on or after the start date.'],
    [{ keepActiveAfterEnd: null as unknown as boolean }, 'Keep active after the end date must be on or off.'],
  ])('exit review: says %j in plain words', (input, message) => {
    expect(() => validateSubscription({ ...valid, ...input } as SubscriptionInput)).toThrow(message);
  });

  it('takes the bounds themselves: Rp 0, the price ceiling, 1 leader and the leader ceiling', () => {
    expect(refusedOn({ pricePerLeaderMinor: 0, maxLeaders: 1 })).toBeNull();
    expect(refusedOn({
      pricePerLeaderMinor: SUBSCRIPTION.PRICE_PER_LEADER_MAX_MINOR, maxLeaders: SUBSCRIPTION.MAX_LEADERS_MAX,
    })).toBeNull();
  });
});
