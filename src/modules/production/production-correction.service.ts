import { HttpStatus, Injectable } from '@nestjs/common';
import { Clock } from '@/common/clock/clock.port';
import { RequestContext } from '@/common/context/request-context';
import { DomainException, NotFoundException } from '@/common/errors/domain.exception';
import { ErrorCode } from '@/common/errors/error-codes';
import { AuditService } from '@/modules/audit/audit.service';
import { MembershipRepository } from '@/modules/org/membership.repository';
import { MonthlyAgentDataRepository } from './monthly-agent-data.repository';
import type { MetricValue, ProductionMetric, Provenance } from './monthly-agent-data.schema';
import type { Cadence } from './production-preview';
import { type MonthState, ProductionMonths } from './production-months.service';
import { breaksYtd, refusalFor } from './production-rules';
import { requireMonth, requireOffice } from './production.service';

export interface CorrectionInput {
  month: string;
  membershipId: string;
  metric: ProductionMetric;
  cadence: Cadence;
  /** In the unit it is stored in — money in sen. `null` clears the figure (AC-4). */
  value: number | null;
  /** The month's revision the reader saw. */
  revision: number;
  reason: string;
}

export interface CorrectionResult {
  membershipId: string;
  metric: ProductionMetric;
  cadence: Cadence;
  /** `false` when the figure already held that value: nothing was written, audited or advanced. */
  changed: boolean;
  before: { value: number | null; provenance: Provenance | null };
  after: { value: number | null; provenance: Provenance | null };
  state: MonthState;
}

/** The six figures as a sentence names them — never in the file's *Rp M*: a correction is typed in rupiah. */
const NAME: Record<ProductionMetric, string> = {
  ape: 'APE', persistency: 'Rolling persistency', recruitment: 'Recruitment',
  newActiveAgents: 'New active agents', fyp: 'FYP', policyCount: '# of policy',
};
const labelOf = (metric: ProductionMetric, cadence: Cadence) =>
  `${NAME[metric]} ${cadence === 'monthly' ? 'this month' : 'year to date'}`;
const fieldOf = (metric: ProductionMetric, cadence: Cadence) =>
  `${metric}${cadence === 'monthly' ? 'Monthly' : 'Ytd'}`;

const REASON_MAX = 500;

/**
 * One figure, corrected by hand (P9-T5).
 *
 * *"Click any number to correct it manually — no need to re-upload for a single fix"* — the
 * prototype's own hint, made safe: **an invalid value is refused with the reason** (the prototype
 * silently turns it into `null`, a figure nobody entered); **every accepted correction is audited**
 * with the figure before and after, who and when; and **it carries a reason**, because a production
 * figure freezes at upload and a change after that is a new version with a why (ADR-0042).
 *
 * **Clearing is possible here and only here** (AC-4, ADR-0051): `value: null` empties the figure, as
 * `corrected`, audited like any other change. No file can.
 *
 * The same rules as the import (`production-rules.ts`), the same lock (ADR-0050), and the same
 * mutex: a correction claims the month's revision like every other write, so it is refused rather
 * than written over a month that moved while the reader looked at it.
 */
@Injectable()
export class ProductionCorrections {
  constructor(
    private readonly months: ProductionMonths,
    private readonly data: MonthlyAgentDataRepository,
    private readonly memberships: MembershipRepository,
    private readonly audit: AuditService,
    private readonly clock: Clock,
  ) {}

  async correct(ctx: RequestContext, input: CorrectionInput): Promise<CorrectionResult> {
    requireOffice(ctx);
    requireMonth(input.month);
    const { month, membershipId, metric, cadence, value } = input;
    const reason = input.reason.trim();
    if (!reason || reason.length > REASON_MAX) {
      throw new DomainException(
        ErrorCode.VALIDATION_FAILED,
        reason ? `Keep the reason under ${REASON_MAX} characters.` : 'Say why the figure is being corrected.',
        HttpStatus.BAD_REQUEST,
        { field: 'reason' },
      );
    }

    const member = await this.memberships.findOne(ctx, { _id: membershipId, status: 'active' });
    if (!member) throw new NotFoundException('Member');

    const state = await this.months.state(ctx, month);
    this.months.refuseIfLocked(state);

    const row = await this.data.findOne(ctx, { membershipId, month });
    const cells = (row ?? {}) as unknown as Record<string, MetricValue | undefined>;
    const field = fieldOf(metric, cadence);
    const before = { value: cells[field]?.value ?? null, provenance: cells[field]?.provenance ?? null };
    const label = labelOf(metric, cadence);

    if (value !== null) {
      const why = refusalFor(metric, value);
      if (why) throw outOfRange(`${label} ${why}`, input);
      const other = cells[fieldOf(metric, cadence === 'monthly' ? 'ytd' : 'monthly')]?.value ?? null;
      const [m, y] = cadence === 'monthly' ? [value, other] : [other, value];
      if (breaksYtd(metric, m, y)) {
        throw outOfRange(cadence === 'monthly'
          ? `${label} would be more than the year to date already held. Correct the year to date first.`
          : `${label} would be less than this month's figure. Correct this month first.`, input);
      }
    }

    if (value === before.value) {
      return { membershipId, metric, cadence, changed: false, before, after: before, state };
    }

    await this.months.claim(ctx, month, input.revision);
    const now = this.clock.now();
    const written = await this.data.upsertOne(ctx, { membershipId, month }, {
      $set: {
        [field]: {
          value, provenance: 'corrected', sourceBatchId: null,
          correctedBy: ctx.membershipId, correctedAt: now, reason,
        },
      },
      $setOnInsert: { agentCode: (member as { agentCode?: string }).agentCode ?? '' },
    });

    await this.audit.record(ctx, {
      action: 'upload.cell_corrected',
      targetCollection: 'monthlyAgentData',
      targetId: String(written._id),
      targetMembershipId: membershipId,
      before: { month, field, ...before, sourceBatchId: cells[field]?.sourceBatchId ?? null },
      after: { month, field, value, provenance: 'corrected', reason },
    });

    return {
      membershipId, metric, cadence, changed: true, before,
      after: { value, provenance: 'corrected' },
      state: await this.months.state(ctx, month),
    };
  }
}

function outOfRange(message: string, input: CorrectionInput): DomainException {
  return new DomainException(
    ErrorCode.UPLOAD_VALUE_OUT_OF_RANGE,
    message,
    HttpStatus.UNPROCESSABLE_ENTITY,
    { metric: input.metric, cadence: input.cadence, value: input.value },
  );
}
