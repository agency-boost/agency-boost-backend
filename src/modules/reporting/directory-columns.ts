import { Injectable } from '@nestjs/common';
import { Clock } from '@/common/clock/clock.port';
import { RequestContext } from '@/common/context/request-context';
import type { LocalDate } from '@/common/time/local-day';
import { ActivityReadings } from '@/modules/activity/activity-readings';
import { SubjectReadAudit } from '@/modules/audit/subject-read-audit';
import { CoachingReadings } from '@/modules/coaching/coaching-readings';
import type { DirectoryMember, DirectoryPage } from '@/modules/org/directory.service';
import { TenantDay } from '@/modules/tenants/tenant-day.service';

/** The directory's two columns (`KPM_Owner.html:1834`, `:4490-4519`), on each row. */
export interface DirectoryActivityColumns {
  /** The member's latest day logged, in the office's calendar; `null` is *Never*. */
  lastActivityOn: LocalDate | null;
  /** Whole days from it to today in the office's calendar: 0 is *Today*, `n` is *"{n} days ago"*. */
  lastActivityDays: number | null;
  /** `DAYS_SINCE_LAST_COACHING`, as the coaching roster serves it; `null` is *Never*, a member with no 1:1. */
  lastCoachedDays: number | null;
}

/** A row of the roster: an active member's carries the two columns; a pending or removed one's does not. */
export type DirectoryRow = DirectoryMember & Partial<DirectoryActivityColumns>;

/**
 * ***Last activity* and *Last coached*** (Phase 18, P18-T1; D-directory): the two columns of All members the
 * prototype draws and Phase 3 left out because their data did not exist — the *"full list on the People
 * screen"* the Overview's not-logged card points at.
 *
 * **Each from the function its owner serves it with**: the latest day logged from `ActivityReadings` (the fact
 * `ACTIVITY_COMPLIANCE_7D` reads — any saved day, ADR-0042), and `DAYS_SINCE_LAST_COACHING` from
 * `CoachingReadings.recencyOf`, the roster's own. Two reads for a page, whatever its length.
 *
 * **The page's read is recorded** (D-audit): one §3.5 entry per member on it other than the reader, surface
 * `directory`, in one insert, failing open — the page discloses each one's latest day logged and last 1:1.
 *
 * **Active members only** (the Phase 18 exit review, B1): the *Pending* and *Removed* tabs draw neither column,
 * and a member who has left is history a former leader no longer reaches — `CoachResolver` refuses them every
 * other subject read. So a pending or removed row carries no column, is read for nothing and writes no entry.
 */
@Injectable()
export class DirectoryColumns {
  constructor(
    private readonly activity: ActivityReadings,
    private readonly sessions: CoachingReadings,
    private readonly days: TenantDay,
    private readonly clock: Clock,
    private readonly subjectReads: SubjectReadAudit,
  ) {}

  async decorate(ctx: RequestContext, page: DirectoryPage): Promise<Omit<DirectoryPage, 'members'> & { members: DirectoryRow[] }> {
    const active = page.members.filter((m) => m.status === 'active');
    if (active.length === 0) return { ...page, members: [...page.members] };
    const day = await this.days.for(ctx);
    const ids = active.map((m) => m.membershipId);
    const [latest, recency] = await Promise.all([
      this.activity.lastLoggedOnMany(ctx, ids),
      this.sessions.recencyOf(ctx, ids, day),
    ]);
    const members = page.members.map((member): DirectoryRow => {
      if (member.status !== 'active') return member;
      const last = latest.get(member.membershipId) ?? null;
      return {
        ...member,
        lastActivityOn: last,
        lastActivityDays: last === null ? null : this.clock.daysBetween(day.timezone, last, day.today),
        lastCoachedDays: recency.get(member.membershipId)!.daysSinceLastCoaching,
      };
    });
    await this.subjectReads.recordMany(ctx, active, 'directory', { from: null, to: day.today });
    return { ...page, members };
  }
}
