import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { Clock } from '@/common/clock/clock.port';
import { RequestContext } from '@/common/context/request-context';
import { localDayOf, type LocalDate } from '@/common/time/local-day';
import { DEFAULT_TENANT_TIMEZONE } from '@/domain/constants';
import { DEFAULT_KPM_SETTINGS, Kpm, type KpmSettings } from './kpm.schema';

/**
 * What day it is **in the office**, for services that need only that.
 *
 * Invariant §9: a day boundary computed in the server's clock is a bug. `local-day.ts` does the
 * arithmetic and takes the zone explicitly; this is the piece that answers *which zone*, from
 * `kpms.timezone` rather than from the process, the browser, or a constant.
 *
 * **v1 runs every office on Asia/Jakarta (ADR-0016), and the indirection stays anyway.** The thing
 * the invariant guards against is the *server's* clock, and that is true whether there is one
 * tenant zone or twenty — reading the constant instead of the column is exactly how the defect
 * comes back, and it comes back invisibly because every test passes in one zone.
 *
 * **`ActivityService.office()` is the other reader and is deliberately not merged into this.** It
 * fetches the timezone and the office's four numeric settings in one query, and every one of its
 * methods needs both; routing it through here would cost it a second round trip per request to
 * remove a duplication that is two lines. If a third reader wants the settings too, that is the
 * moment to make this return them.
 *
 * *2026-10-02 (P11-T6):* the coaching roster is that third reader — its *overdue* is the office's
 * `coachingOverdueDays` and its *On track* the office's `onTrackPaceThreshold` — so `office()` returns
 * the day and the settings from one read. `ActivityService.office()` keeps its own, for the reason above.
 */
/** What day it is where the work happens, and the zone that decided it. */
export interface OfficeDay {
  readonly today: LocalDate;
  /** `YYYY-MM` — the office's calendar month, which is the first seven characters of its day. */
  readonly month: string;
  readonly timezone: string;
}

/** The office's day, its knobs, and the company whose ladder names its rungs. */
export interface Office extends OfficeDay {
  /** Every knob, each falling back to the platform default where the office's row holds none. */
  readonly settings: KpmSettings;
  /** `null` only for an office that is not there. */
  readonly companyId: string | null;
}

@Injectable()
export class TenantDay {
  constructor(
    @InjectModel(Kpm.name) private readonly kpms: Model<Kpm>,
    private readonly clock: Clock,
  ) {}

  /**
   * The office's zone, or the platform default when the row names none.
   *
   * **No `NotFoundException` for a missing office**, unlike `ActivityService.office()`: the
   * callers here have already read a tenant-scoped document, so the office demonstrably exists
   * and a second lookup failing means the row predates the column rather than that the tenant is
   * gone. Refusing the whole request over a *derived label* would turn a cosmetic gap into an
   * outage.
   */
  async timezoneOf(ctx: RequestContext): Promise<string> {
    if (!ctx.kpmId) return DEFAULT_TENANT_TIMEZONE;
    const kpm = await this.kpms.findById(ctx.kpmId).select('timezone').lean().exec();
    return (kpm as { timezone?: string } | null)?.timezone ?? DEFAULT_TENANT_TIMEZONE;
  }

  /**
   * The office's today, and the zone it was resolved in.
   *
   * Both, because a caller that says *"overdue"* usually also has to say *by how much*, and the
   * day count is calendar arithmetic that has to happen in the same zone — `Clock.daysBetween`
   * takes the zone for exactly that reason. Returning one and making the caller fetch the other
   * is two round trips to answer one question.
   */
  async for(ctx: RequestContext): Promise<OfficeDay> {
    const timezone = await this.timezoneOf(ctx);
    const today = localDayOf(this.clock.now(), timezone);
    // The month is the day's first seven characters rather than a second computation: two ways to
    // answer *which month is it in Jakarta* is one way too many, and they drift at the boundary.
    return { today, month: today.slice(0, 7), timezone };
  }

  /**
   * **The office's day and the month it opened**, from one read (P18.5-T11, ADR-0161 §4): the range a reader may
   * look back over on the Personal Summary, from the office's first month to this one.
   *
   * The first month is the month the office's record was created in, **in the office's own zone** — an office
   * created at 00:30 on 1 February in Jakarta opened in February, though it is still 31 January in UTC. It is
   * never later than this month: a record stamped by a clock ahead of the request's (a test's, or a seed run on
   * another day) still leaves the current month to read. A row with no stamp opened this month.
   */
  async calendar(ctx: RequestContext): Promise<OfficeDay & { readonly firstMonth: string }> {
    const row = ctx.kpmId
      ? await this.kpms.findById(ctx.kpmId).select('timezone createdAt').lean().exec()
      : null;
    const kpm = row as { timezone?: string; createdAt?: Date } | null;
    const timezone = kpm?.timezone ?? DEFAULT_TENANT_TIMEZONE;
    const today = localDayOf(this.clock.now(), timezone);
    const month = today.slice(0, 7);
    const opened = kpm?.createdAt ? localDayOf(kpm.createdAt, timezone).slice(0, 7) : month;
    // `YYYY-MM` sorts as the calendar does, so the earlier string is the earlier month.
    return { today, month, timezone, firstMonth: opened < month ? opened : month };
  }

  /**
   * The office's day **and its settings**, from one read (P11-T6).
   *
   * Each knob falls back to the platform default, `DEFAULT_KPM_SETTINGS`, where the office's row holds
   * none — an office provisioned before the knob existed — exactly as `ActivityService.office()` falls
   * back, from the same constants (invariant §7). Degrades like `for` rather than throwing: the caller
   * has resolved the office from the caller's membership, so a missing row is a row that predates a
   * column, not a tenant that is gone.
   */
  async office(ctx: RequestContext): Promise<Office> {
    const row = ctx.kpmId
      ? await this.kpms.findById(ctx.kpmId).select('timezone settings companyId').lean().exec()
      : null;
    const kpm = row as { timezone?: string; settings?: Partial<Record<keyof KpmSettings, number>>; companyId?: string } | null;
    const timezone = kpm?.timezone ?? DEFAULT_TENANT_TIMEZONE;
    const today = localDayOf(this.clock.now(), timezone);
    const stored = kpm?.settings ?? {};
    const settings = Object.fromEntries(
      (Object.keys(DEFAULT_KPM_SETTINGS) as (keyof KpmSettings)[])
        .map((key) => [key, stored[key] ?? DEFAULT_KPM_SETTINGS[key]]),
    ) as unknown as KpmSettings;
    return { today, month: today.slice(0, 7), timezone, settings, companyId: kpm?.companyId ?? null };
  }
}
