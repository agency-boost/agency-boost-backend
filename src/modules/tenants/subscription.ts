import { HttpStatus } from '@nestjs/common';
import { DateTime } from 'luxon';
import type { Clock } from '@/common/clock/clock.port';
import { DomainException } from '@/common/errors/domain.exception';
import { ErrorCode } from '@/common/errors/error-codes';
import { formatNumber, formatRupiah } from '@/common/format/format';
import { DEFAULT_TENANT_TIMEZONE, SUBSCRIPTION } from '@/domain/constants';
import type { KpmSubscription } from './kpm.schema';

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
}

/** A real calendar date in `YYYY-MM-DD`: `2026-02-30` has the shape and is no day. */
function isOfficeDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  return DateTime.fromFormat(value, 'yyyy-MM-dd', { zone: 'utc' }).isValid;
}

/**
 * Rupiah as the dialog shows it, `Rp 100.000.000`: **in full**, through the shared formatter (ADR-0167 §1) — the
 * refusals are read by the Super Admin under the field they typed rupiah into, so a bound is written in the digits
 * they type, and in rupiah — never sen, the unit the API carries. Every bound is whole rupiah, so nothing rounds.
 */
const rupiah = (minor: number): string => formatRupiah(minor);

/** `10000` as `10.000`, the grouping the console's number fields use (`id-ID`, ADR-0167 §1). */
const grouped = (value: number): string => formatNumber(value);

function refuse(field: string, message: string): DomainException {
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
    throw refuse('startDate', 'The start date is not a real day.');
  }
  if (endDate !== null && !isOfficeDate(endDate)) {
    throw refuse('endDate', 'The end date is not a real day.');
  }
  if ((startDate === null) !== (endDate === null)) {
    throw refuse(
      startDate === null ? 'startDate' : 'endDate',
      'Enter a start date and an end date, or neither.',
    );
  }
  if (startDate !== null && endDate !== null && endDate < startDate) {
    throw refuse('endDate', 'The end date must be on or after the start date.');
  }

  if (pricePerLeaderMinor !== null) {
    if (
      !Number.isSafeInteger(pricePerLeaderMinor)
      || pricePerLeaderMinor < 0
      || pricePerLeaderMinor > SUBSCRIPTION.PRICE_PER_LEADER_MAX_MINOR
    ) {
      throw refuse(
        'pricePerLeaderMinor',
        `The price per leader must be from ${rupiah(0)} to ${rupiah(SUBSCRIPTION.PRICE_PER_LEADER_MAX_MINOR)} a month.`,
      );
    }
    if (pricePerLeaderMinor % SUBSCRIPTION.PRICE_STEP_MINOR !== 0) {
      throw refuse('pricePerLeaderMinor', 'The price per leader must be whole rupiah, with no sen.');
    }
  }

  if (maxLeaders !== null && (
    !Number.isSafeInteger(maxLeaders)
    || maxLeaders < SUBSCRIPTION.MAX_LEADERS_MIN
    || maxLeaders > SUBSCRIPTION.MAX_LEADERS_MAX
  )) {
    throw refuse(
      'maxLeaders',
      `The leader limit must be a whole number from ${grouped(SUBSCRIPTION.MAX_LEADERS_MIN)} to `
        + `${grouped(SUBSCRIPTION.MAX_LEADERS_MAX)}, or empty for no limit.`,
    );
  }

  if (typeof keepActiveAfterEnd !== 'boolean') {
    throw refuse('keepActiveAfterEnd', 'Keep active after the end date must be on or off.');
  }

  return {
    startDate, endDate, pricePerLeaderMinor, currency: 'IDR', maxLeaders, keepActiveAfterEnd,
  };
}
