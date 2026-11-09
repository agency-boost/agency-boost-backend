import { HttpStatus } from '@nestjs/common';
import { DateTime } from 'luxon';
import type { Clock } from '@/common/clock/clock.port';
import { DomainException } from '@/common/errors/domain.exception';
import { ErrorCode } from '@/common/errors/error-codes';
import type { Sentence } from '@/common/i18n/sentence';
import {
  DEFAULT_TENANT_TIMEZONE, SUBSCRIPTION, SUBSCRIPTION_PLANS, type SubscriptionPlan,
} from '@/domain/constants';
import type { KpmSubscription } from './kpm.schema';
import { TENANTS_REFUSALS } from './tenants.messages';

/**
 * An office's subscription, as rules (ADR-0112). Pure: the dates in, the state out — so the one
 * rule that cuts a real office off is tested without a database, and read the same way by the
 * request path, the console's list and the office directory.
 */

/**
 * Where an office stands against its end date, computed on the server from **the office's today**:
 *
 * - `none` — no end date (no subscription, or one with no dates): it works as offices always have;
 * - `active` — an end date that is today or later;
 * - `ended` — the end date has passed and *keep active* is off: every member is refused;
 * - `ended_kept_active` — the end date has passed and *keep active* is on: nobody is refused.
 */
export type SubscriptionState = 'none' | 'active' | 'ended' | 'ended_kept_active';

/**
 * **The ended rule** (ADR-0112 §3): the end date is the last day the office can be used, so it is
 * ended from the next office day. Office dates compare as strings because they are `YYYY-MM-DD`.
 */
export function subscriptionStateOn(
  subscription: Pick<KpmSubscription, 'endDate' | 'keepActiveAfterEnd'> | null | undefined,
  today: string,
): SubscriptionState {
  const endDate = subscription?.endDate ?? null;
  if (!endDate) return 'none';
  if (today <= endDate) return 'active';
  return subscription?.keepActiveAfterEnd ? 'ended_kept_active' : 'ended';
}

/**
 * The same, for an office row and the clock: today is read in **the office's** zone (`kpms.timezone`),
 * never the server's (invariant §9, ADR-0016). With the process clock in UTC, Jakarta or New York, an
 * office whose end date is the 30th is served until 17:00 UTC on the 30th — midnight in Jakarta.
 */
export function subscriptionStateOf(
  kpm: { subscription?: KpmSubscription | null; timezone?: string | null },
  clock: Clock,
): SubscriptionState {
  return subscriptionStateOn(
    kpm.subscription ?? null,
    clock.localDateFor(kpm.timezone ?? DEFAULT_TENANT_TIMEZONE),
  );
}

/** Refused, to a member and to an outsider alike: an ended office that is not kept active. */
export function isEnded(
  kpm: { subscription?: KpmSubscription | null; timezone?: string | null },
  clock: Clock,
): boolean {
  return subscriptionStateOf(kpm, clock) === 'ended';
}

/** What `PATCH /admin/tenants/:kpmId/subscription` takes: every field present, nulls allowed but one. */
export interface SubscriptionInput {
  startDate: string | null;
  endDate: string | null;
  pricePerLeaderMinor: number | null;
  maxLeaders: number | null;
  keepActiveAfterEnd: boolean;
  /**
   * *Paket* (ADR-0211 §1; P19.4-T3): `six_months`, `annual` or `null`. **Absent keeps the plan the office has** — an
   * older client that sends the five fields alone changes no plan; `null` clears it.
   */
  plan?: SubscriptionPlan | null;
}

/** A real calendar date in `YYYY-MM-DD`: `2026-02-30` has the shape and is no day. */
function isOfficeDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  return DateTime.fromFormat(value, 'yyyy-MM-dd', { zone: 'utc' }).isValid;
}

/**
 * **The refusals, in both languages** (P18.10-T5 AC-3), each said under the field it names (`details.field`). A bound
 * is rupiah as the dialog shows it, **in full** — `Rp 100.000.000` — through the shared formatter (ADR-0167 §1): the
 * Super Admin reads it under the field they typed rupiah into, so it is written in the digits they type, and in rupiah —
 * never sen, the unit the API carries. Every bound is whole rupiah, so nothing rounds. A count is grouped as the
 * console's number fields group it, `10.000`. Both in the reader's figures (`TENANTS_REFUSALS`).
 */
const SAY = TENANTS_REFUSALS.VALIDATION_FAILED;

function refuse(field: string, message: Sentence<'VALIDATION_FAILED'>): DomainException {
  return new DomainException(
    ErrorCode.VALIDATION_FAILED, message, HttpStatus.BAD_REQUEST, { field },
  );
}

/**
 * **AC-1**, checked whole before anything is written: dates both or neither, real days, the end on or
 * after the start; a price in whole rupiah from 0 to the registered bound; a limit from 1 to the
 * registered bound, or none. The first wrong field is refused `400 VALIDATION_FAILED`, named in
 * `details.field`, with a sentence the dialog shows under that field — in rupiah, never in sen.
 *
 * The DTO refuses a wrong type; **every bound is here** (P13.2 exit review), as is what a decorator
 * cannot say — one field against another, and a date that is shaped right and is no day. The DTO's
 * `@Min`/`@Max` used to answer first, in sen and with no field the dialog could place.
 */
export function validateSubscription(input: SubscriptionInput): KpmSubscription {
  const { startDate, endDate, pricePerLeaderMinor, maxLeaders, keepActiveAfterEnd } = input;

  if (startDate !== null && !isOfficeDate(startDate)) {
    throw refuse('startDate', SAY.startNotADay);
  }
  if (endDate !== null && !isOfficeDate(endDate)) {
    throw refuse('endDate', SAY.endNotADay);
  }
  if ((startDate === null) !== (endDate === null)) {
    throw refuse(startDate === null ? 'startDate' : 'endDate', SAY.datesBothOrNeither);
  }
  if (startDate !== null && endDate !== null && endDate < startDate) {
    throw refuse('endDate', SAY.endBeforeStart);
  }

  if (pricePerLeaderMinor !== null) {
    if (
      !Number.isSafeInteger(pricePerLeaderMinor)
      || pricePerLeaderMinor < 0
      || pricePerLeaderMinor > SUBSCRIPTION.PRICE_PER_LEADER_MAX_MINOR
    ) {
      throw refuse(
        'pricePerLeaderMinor',
        SAY.priceRange({ min: 0, max: SUBSCRIPTION.PRICE_PER_LEADER_MAX_MINOR }),
      );
    }
    if (pricePerLeaderMinor % SUBSCRIPTION.PRICE_STEP_MINOR !== 0) {
      throw refuse('pricePerLeaderMinor', SAY.priceWholeRupiah);
    }
  }

  if (maxLeaders !== null && (
    !Number.isSafeInteger(maxLeaders)
    || maxLeaders < SUBSCRIPTION.MAX_LEADERS_MIN
    || maxLeaders > SUBSCRIPTION.MAX_LEADERS_MAX
  )) {
    throw refuse(
      'maxLeaders',
      SAY.leaderLimitRange({ min: SUBSCRIPTION.MAX_LEADERS_MIN, max: SUBSCRIPTION.MAX_LEADERS_MAX }),
    );
  }

  if (typeof keepActiveAfterEnd !== 'boolean') {
    throw refuse('keepActiveAfterEnd', SAY.keepActiveOnOrOff);
  }

  const { plan } = input;
  if (plan !== undefined && plan !== null && !(SUBSCRIPTION_PLANS as readonly string[]).includes(plan)) {
    throw refuse('plan', SAY.planOneOf);
  }

  return {
    startDate, endDate, pricePerLeaderMinor, currency: 'IDR', maxLeaders, keepActiveAfterEnd,
    // Absent is left for the caller to keep the stored plan (`TenantService.updateSubscription`); here it is none.
    plan: plan ?? null,
  };
}
