import { HttpStatus, Injectable } from '@nestjs/common';
import { RequestContext } from '@/common/context/request-context';
import { DomainException, NoMembershipException } from '@/common/errors/domain.exception';
import { ErrorCode } from '@/common/errors/error-codes';
import { MemberNames } from '@/modules/org/member-names.service';
import { MembershipRepository } from '@/modules/org/membership.repository';
import { MonthlyAgentDataRepository } from './monthly-agent-data.repository';
import {
  MetricValue, MonthlyAgentDataDocument, PRODUCTION_METRICS, type ProductionMetric, type Provenance,
} from './monthly-agent-data.schema';
import { MONTH_PATTERN } from './production-units';

/** One figure on the wire: what it is, and which writer put it there. */
export interface MetricCell {
  value: number | null;
  provenance: Provenance | null;
}

/** One agent's row: the two cadences of each of the six metrics. */
export interface MonthRow {
  membershipId: string;
  agentCode: string;
  name: string;
  metrics: Record<ProductionMetric, { monthly: MetricCell; ytd: MetricCell }>;
}

export interface MonthView {
  month: string;
  rows: MonthRow[];
  /** How many of the rows hold at least one figure. Zero is *nothing uploaded yet*. */
  withData: number;
}

const EMPTY: MetricCell = { value: null, provenance: null };

/**
 * The office's production, month by month (P9-T1).
 *
 * **This task reads; the tasks after it write.** The month table is the surface every later task
 * builds on — the template lists its rows, the preview diffs against it, a commit fills it, a
 * correction changes one cell of it — so it exists first, empty, which is the honest state before an
 * upload and is itself worth seeing.
 *
 * **Every active member is a row, whether or not anything has been uploaded for them.** The table
 * answers *what does the office know about each person this month*, and *nothing* is an answer:
 * a row of `null` cells says the carrier has not reported this person, where a missing row would
 * say the person is not here. The prototype's template does the same — one row per agent, twelve
 * empty fields.
 *
 * **Nothing here is derived.** The prototype paints an *Active (MAA)* column from these cells, and
 * it is the third competing definition of *active agent* in the product (OD-21). This service hands
 * back the cells and their provenance and computes nothing from them, so a definition is not shipped
 * before it is decided (invariant §8).
 */
@Injectable()
export class ProductionService {
  constructor(
    private readonly data: MonthlyAgentDataRepository,
    private readonly memberships: MembershipRepository,
    private readonly names: MemberNames,
  ) {}

  async readMonth(ctx: RequestContext, month: string): Promise<MonthView> {
    // Refused by name, before any repository is reached. §3.9 grants a Super Admin `all`, and the
    // guard lets them through — but the office is resolved from the caller's membership, which they
    // have none of. The repository would refuse too, as an internal error nobody can branch on.
    if (!ctx.kpmId) throw new NoMembershipException();
    if (!MONTH_PATTERN.test(month)) {
      throw new DomainException(
        ErrorCode.VALIDATION_FAILED,
        `${month} is not a month. Use YYYY-MM.`,
        HttpStatus.BAD_REQUEST,
        { month },
      );
    }

    // Everybody here now, in the order the roster shows them. Pending members have registered and
    // nothing more; a removed one is not here. Both are the directory's own rule.
    const members = await this.memberships.find(
      ctx, { status: 'active' }, { sort: { agentSeq: 1 } },
    );
    const ids = members.map((m) => String(m._id));

    const [names, rows] = await Promise.all([
      this.names.byMembershipId(ctx, ids),
      this.data.find(ctx, { month, membershipId: { $in: ids } }),
    ]);
    const byMember = new Map(rows.map((r) => [r.membershipId, r]));

    const view = members.map((m): MonthRow => {
      const id = String(m._id);
      const row = byMember.get(id);
      return {
        membershipId: id,
        agentCode: (m as { agentCode?: string }).agentCode ?? '',
        name: names.get(id) ?? '',
        metrics: metricsOf(row),
      };
    });

    return {
      month,
      rows: view,
      withData: view.filter((r) => hasAnyFigure(r)).length,
    };
  }
}

/** Twelve cells from a row, or twelve empty ones from no row. */
function metricsOf(row: MonthlyAgentDataDocument | undefined): MonthRow['metrics'] {
  const out = {} as MonthRow['metrics'];
  for (const metric of PRODUCTION_METRICS) {
    out[metric] = {
      monthly: cellOf(row?.[`${metric}Monthly`]),
      ytd: cellOf(row?.[`${metric}Ytd`]),
    };
  }
  return out;
}

/**
 * `undefined` is not a case: Mongoose applies a subdocument's defaults on hydration, so a stored cell
 * always carries `value: null` at the least. An arm for it would be one nothing could ever take.
 */
function cellOf(stored: MetricValue | undefined): MetricCell {
  if (!stored || stored.value === null) return EMPTY;
  return { value: stored.value, provenance: stored.provenance };
}

function hasAnyFigure(row: MonthRow): boolean {
  return PRODUCTION_METRICS.some(
    (m) => row.metrics[m].monthly.value !== null || row.metrics[m].ytd.value !== null,
  );
}
