import { Injectable, Optional } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { Clock } from '@/common/clock/clock.port';
import { RequestContext } from '@/common/context/request-context';
import { ANALYTICS, DEFAULT_TENANT_TIMEZONE, LEADER_CLASSES } from '@/domain/constants';
import { memberAt, type CountedMembership } from '@/domain/metrics/office-headcount';
import type { AdvancedAnalyticsConfig, UploadField } from '@/modules/config/analytics-config';
import { AnalyticsConfigReader, type PublishedAnalyticsConfig } from '@/modules/config/analytics-config.reader';
import { platformAnalyticsConfig } from '@/modules/config/analytics-config';
import { MembershipRepository } from '@/modules/org/membership.repository';
import { Kpm } from '@/modules/tenants/kpm.schema';
import { MonthlyAgentDataRepository, type KodeRow } from './monthly-agent-data.repository';
import { columnsInForce } from './upload-columns';

/*
 * **`UPLOAD_MONTH_COMPLETE`, the required history and `COLUMN_YEAR_TO_DATE`'s missing months** (P19.5-T2 AC-6, AC-7,
 * AC-8; ADR-0214 §10, §11; `metrics-and-definitions.md` §A.15).
 */

/** A month as the completeness reads it: never uploaded, uploaded below `completePct`, or complete. */
export type MonthFillStatus = 'missing' | 'incomplete' | 'complete';

export interface MonthFill {
  month: string;
  /** `OFFICE_HEADCOUNT` on the month's last day (D3): the members the share is of. */
  members: number;
  /** Those of them with a value in every column in force that month (a leaders' column on AB and AAB rows only). */
  filled: number;
  status: MonthFillStatus;
}

/** A member as the completeness counts them: when they were here, and whether a leaders' column is theirs to fill. */
export interface FillPerson {
  membershipId: string;
  leader: boolean;
  counted: CountedMembership;
}

/**
 * **`UPLOAD_MONTH_COMPLETE`** (ADR-0214 §11): a month is complete when at least `completePct` % of the KPM's members on
 * its last day have a value in every column in force that month.
 *
 * - **A column is in force** from its `effectiveFrom` (R2): an earlier month neither asks for it nor loses its status.
 * - **A `rows: 'leaders'` column** counts only for AB and AAB rows.
 * - **A month no row holds a figure in is `missing`**; one uploaded below the share is `incomplete`. Both read *Belum
 *   lengkap* in a year to date.
 * - A *Belum terdaftar* row counts in nothing (§8): it is not a member, so it is in neither side of the share.
 *
 * Pure: the configuration, the people, the rows and each month's end in; a status per month out.
 */
export function monthFill(
  config: AdvancedAnalyticsConfig,
  month: string,
  people: readonly FillPerson[],
  rows: readonly KodeRow[],
  endOfMonth: Date,
): MonthFill {
  const columns = columnsInForce(config, month);
  const byMember = new Map(rows.filter((r) => r.month === month).map((r) => [r.membershipId, r]));
  const uploaded = [...byMember.values()].some((row) => columns.some((c) => row.values[c.kode]?.value != null));
  const members = people.filter((p) => memberAt(p.counted, endOfMonth));
  const isFilled = (person: FillPerson) => {
    const row = byMember.get(person.membershipId);
    if (!row) return false;
    return columns.every((c: UploadField) => (c.rows === 'leaders' && !person.leader) || row.values[c.kode]?.value != null);
  };
  const filled = members.filter(isFilled).length;
  const status: MonthFillStatus = !uploaded ? 'missing'
    : members.length === 0 || filled * 100 >= config.uploadRules.completePct * members.length ? 'complete'
      : 'incomplete';
  return { month, members: members.length, filled, status };
}

/** Every `YYYY-MM` from `from` to `to`, both included. */
export function monthsBetween(from: string, to: string): string[] {
  const out: string[] = [];
  let [y, m] = [Number(from.slice(0, 4)), Number(from.slice(5, 7))];
  const [ty, tm] = [Number(to.slice(0, 4)), Number(to.slice(5, 7))];
  while (y < ty || (y === ty && m <= tm)) {
    out.push(`${y}-${String(m).padStart(2, '0')}`);
    m += 1;
    if (m === 13) { m = 1; y += 1; }
  }
  return out;
}

/** `month` moved by `by` months. */
export function shiftMonth(month: string, by: number): string {
  const total = Number(month.slice(0, 4)) * 12 + Number(month.slice(5, 7)) - 1 + by;
  return `${Math.floor(total / 12)}-${String((total % 12) + 1).padStart(2, '0')}`;
}

/**
 * **The required history** (R5, AA UI-016, AT-9; ADR-0214 §11): the KPM's first month is the month of `kpms.createdAt` in
 * its zone — the month UI-150 uses — and the history runs from `historyMonthsBeforeJoin` (12) months before it to the
 * month before it. Earlier months are optional and never shown as missing.
 */
export function historyOf(firstMonth: string, monthsBefore: number = ANALYTICS.HISTORY_MONTHS_BEFORE_JOIN): {
  firstMonth: string; historyFrom: string; historyTo: string;
} {
  return { firstMonth, historyFrom: shiftMonth(firstMonth, -monthsBefore), historyTo: shiftMonth(firstMonth, -1) };
}

/**
 * **A column's year to date is missing these months** (R4, ADR-0214 §10): each month from the later of its January, the
 * column's `effectiveFrom` and the KPM's history start, to the month itself, that is not complete. Empty is complete.
 */
export function missingMonthsOf(
  field: Pick<UploadField, 'effectiveFrom'>, month: string, historyFrom: string, fills: ReadonlyMap<string, MonthFill>,
): string[] {
  const january = `${month.slice(0, 4)}-01`;
  const from = [january, field.effectiveFrom, historyFrom].sort().at(-1) as string;
  if (from > month) return [];
  return monthsBetween(from, month).filter((m) => fills.get(m)?.status !== 'complete');
}

/** What the month read and the readers of a month's completeness get: the configuration, the history and each month's fill. */
export interface OfficeFill {
  config: PublishedAnalyticsConfig;
  firstMonth: string;
  historyFrom: string;
  fills: Map<string, MonthFill>;
}

/**
 * **The office's months, as complete or not** (`UPLOAD_MONTH_COMPLETE`), read once for a range: the KPM's configuration
 * (live, ADR-0214 §3), its people with their join and removal dates (`OFFICE_HEADCOUNT`), and its rows by kode. What
 * the month read, the YTD cells' *Belum lengkap* and the history grid read; tenant-scoped throughout.
 */
@Injectable()
export class UploadCompleteness {
  constructor(
    private readonly data: MonthlyAgentDataRepository,
    private readonly memberships: MembershipRepository,
    @InjectModel(Kpm.name) private readonly kpms: Model<Kpm>,
    private readonly clock: Clock,
    @Optional() private readonly analytics?: AnalyticsConfigReader,
  ) {}

  /** The configuration the KPM reads now: the platform's where this was built without the reader. */
  async configFor(ctx: RequestContext): Promise<PublishedAnalyticsConfig> {
    return this.analytics
      ? this.analytics.publishedFor(ctx)
      : { templateId: null, templateName: null, version: 1, config: platformAnalyticsConfig() };
  }

  /** The KPM's first month and timezone, from its own row. */
  async office(ctx: RequestContext): Promise<{ timezone: string; firstMonth: string }> {
    const row = await this.kpms.findById(ctx.kpmId).select('createdAt timezone').lean().exec() as
      { createdAt?: Date; timezone?: string } | null;
    const timezone = row?.timezone ?? DEFAULT_TENANT_TIMEZONE;
    const today = this.clock.localDateFor(timezone);
    const created = row?.createdAt ? this.clock.localDateFor(timezone, row.createdAt) : today;
    // Never later than today: a clock set back in a test reads an office made today as new today.
    return { timezone, firstMonth: (created < today ? created : today).slice(0, 7) };
  }

  /** Each month of `[from, to]`, as complete or not, with the configuration and the history it was read against. */
  async forRange(
    ctx: RequestContext, range: { from: string; to: string }, given?: PublishedAnalyticsConfig,
  ): Promise<OfficeFill> {
    const [config, office] = await Promise.all([given ? Promise.resolve(given) : this.configFor(ctx), this.office(ctx)]);
    const people = await this.people(ctx, office.timezone);
    const { historyFrom } = historyOf(office.firstMonth, config.config.uploadRules.historyMonthsBeforeJoin);
    const kodes = config.config.uploadFields.map((f) => f.kode);
    const rows = await this.data.findByKode(ctx, { month: { $gte: range.from, $lte: range.to } }, kodes);
    const fills = new Map<string, MonthFill>();
    for (const month of monthsBetween(range.from, range.to)) {
      const last = shiftMonth(month, 1);
      const endOfMonth = this.clock.startOfLocalDay(office.timezone, `${last}-01`);
      fills.set(month, monthFill(config.config, month, people, rows, endOfMonth));
    }
    return { config, firstMonth: office.firstMonth, historyFrom, fills };
  }

  /** The office's members as the headcount counts them — every status but pending — and which are leaders. */
  private async people(ctx: RequestContext, timezone: string): Promise<FillPerson[]> {
    const members = await this.memberships.find(ctx, { status: { $in: ['active', 'removed'] } }, {
      projection: { status: 1, joinedAt: 1, joinDate: 1, removedAt: 1, role: 1 },
    });
    return members.map((m) => {
      const row = m as unknown as {
        _id: unknown; status: 'active' | 'removed'; joinedAt?: Date | null; joinDate?: string | null; removedAt?: Date | null;
        role?: string | null;
      };
      return {
        membershipId: String(row._id),
        leader: (LEADER_CLASSES as readonly string[]).includes(row.role ?? ''),
        counted: {
          status: row.status,
          joinedAt: row.joinedAt ?? null,
          joinDateStart: row.joinDate ? this.clock.startOfLocalDay(timezone, row.joinDate) : null,
          removedAt: row.removedAt ?? null,
        },
      };
    });
  }
}
