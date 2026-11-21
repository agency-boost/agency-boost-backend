import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { Clock } from '@/common/clock/clock.port';
import { RequestContext } from '@/common/context/request-context';
import { BILLING_LAPSE_SUSPENSION_REASON, DEFAULT_TENANT_TIMEZONE } from '@/domain/constants';
import { AuditService } from '@/modules/audit/audit.service';
import { Kpm, KpmDocument } from '@/modules/tenants/kpm.schema';
import { graceEndsOn, isPastGraceOn } from '@/modules/tenants/subscription';

/** One KPM the run suspended. */
export interface LapsedKpm {
  kpmId: string;
  code: string;
  branch: string;
  endDate: string;
  graceEndedOn: string;
}

export interface LapseReport {
  /** The day the run read as today, when one was named; otherwise each KPM's own. */
  today: string | null;
  checked: number;
  suspended: LapsedKpm[];
}

/** The job's name, as its audit rows carry it (`job:subscription-lapse`). */
export const LAPSE_JOB = 'subscription-lapse';

/**
 * **The automatic suspension** (P19.23-T5 AC-5; ADR-0279 §5): every active KPM whose period ended more than
 * `BILLING.GRACE_DAYS` (7) office days ago, not kept active and not renewed, is suspended — its members then read
 * *KPM ditangguhkan* (`TENANT_SUSPENDED`). Run once a day by the daily run, `cli/subscription-lapses.ts`.
 *
 * - **Today is each KPM's** — its own zone through the clock port, never the server's — unless the run names one.
 * - **A renewal wins a race**: the suspension is written only while the KPM is still active with the end date it was
 *   read with, so a package confirmed between the read and the write is never suspended.
 * - **Safe to repeat**: a suspended KPM is not active, so a second run on the same day suspends nobody again.
 * - Each suspension is audited in the KPM's own log, by `job:subscription-lapse`, with the end date and the grace.
 */
@Injectable()
export class SubscriptionLapseService {
  constructor(
    @InjectModel(Kpm.name) private readonly kpms: Model<KpmDocument>,
    private readonly audit: AuditService,
    private readonly clock: Clock,
  ) {}

  async run(today?: string): Promise<LapseReport> {
    const candidates = await this.kpms.find({
      deletedAt: null,
      status: 'active',
      'subscription.endDate': { $ne: null },
      'subscription.keepActiveAfterEnd': { $ne: true },
    }).exec();

    const suspended: LapsedKpm[] = [];
    for (const kpm of candidates) {
      const day = today ?? this.clock.localDateFor(kpm.timezone ?? DEFAULT_TENANT_TIMEZONE);
      if (!isPastGraceOn(kpm.subscription, day)) continue;
      const endDate = kpm.subscription!.endDate!;
      const written = await this.kpms.findOneAndUpdate(
        { _id: kpm._id, deletedAt: null, status: 'active', 'subscription.endDate': endDate },
        { $set: { status: 'suspended', suspendedAt: this.clock.now(), suspendedReason: BILLING_LAPSE_SUSPENSION_REASON } },
        { new: true },
      ).exec();
      if (!written) continue;
      const lapsed = {
        kpmId: String(kpm._id), code: kpm.code, branch: kpm.branchName, endDate, graceEndedOn: graceEndsOn(endDate),
      };
      await this.audit.record(RequestContext.forJob(lapsed.kpmId, LAPSE_JOB), {
        action: 'kpm.suspended',
        targetCollection: 'kpms',
        targetId: lapsed.kpmId,
        before: { status: 'active' },
        after: {
          status: 'suspended', reason: BILLING_LAPSE_SUSPENSION_REASON, endDate, graceEndedOn: lapsed.graceEndedOn,
        },
      });
      suspended.push(lapsed);
    }
    return { today: today ?? null, checked: candidates.length, suspended };
  }
}
