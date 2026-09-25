import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { Clock } from '@/common/clock/clock.port';
import { RequestContext } from '@/common/context/request-context';
import { localDayOf, type LocalDate } from '@/common/time/local-day';
import { DEFAULT_TENANT_TIMEZONE } from '@/domain/constants';
import { Kpm } from './kpm.schema';

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
 */
/** What day it is where the work happens, and the zone that decided it. */
export interface OfficeDay {
  readonly today: LocalDate;
  readonly timezone: string;
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
    return { today: localDayOf(this.clock.now(), timezone), timezone };
  }
}
