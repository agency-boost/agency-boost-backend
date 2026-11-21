import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { isValidObjectId, Model } from 'mongoose';
import { RequestContext } from '@/common/context/request-context';
import { TenantScopedRepository } from '@/common/tenancy/tenant-scoped.repository';
import { MissingTenantContextError } from '@/common/tenancy/tenant-scope.error';
import { QUANT, QUANT_METRICS, type QuantMetric } from '@/domain/constants';
import { peerMedian } from '@/domain/metrics/quant';
import { Kpm, KpmDocument } from '@/modules/tenants/kpm.schema';
import { AnalyticsTarget, AnalyticsTargetDocument } from './analytics-target.schema';
import { QuantRun, QuantRunDocument, type StoredPeers } from './quant-run.schema';

const DUPLICATE_KEY = 11000;

/** A write that returns the row as it was before it (the audit's *before*), retried once on a first-insert race. */
async function onceMore<T>(write: () => Promise<T>): Promise<T> {
  try {
    return await write();
  } catch (err) {
    if ((err as { code?: number }).code !== DUPLICATE_KEY) throw err;
    return write();
  }
}

/**
 * **`analyticsTargets` behind the chokepoint** (invariant §1; P19.5-T3 AC-4, AC-10): every read and write carries the
 * caller's own `kpmId`, so an office never reads or writes another's target.
 *
 * *Changed 2026-11-20:* **nothing reads or writes it any more** — the MAPA and sub-group targets are the AB groups'
 * (`abGroupTargets`; ADR-0275 §3, ADR-0270 §4), and the collection's rows stay where they are, unread (migration 0069).
 * `mapaFor` and `setMapa` went with their last caller; the class stays because `AdvancedAnalyticsService` keeps its
 * constructor's place (`_targets`).
 */
@Injectable()
export class AnalyticsTargetRepository extends TenantScopedRepository<AnalyticsTargetDocument> {
  constructor(@InjectModel(AnalyticsTarget.name) model: Model<AnalyticsTargetDocument>) {
    super(model, 'analyticsTargets');
  }
}

/**
 * **`quantRuns` behind the chokepoint** (invariant §1; P19.5-T3 AC-7, AC-9), with **the one cross-KPM read a tenant role
 * can trigger** (ADR-0215 §5): `peerMediansAcrossTenants`, named so and registered with its reason in
 * `named-cross-tenant-reads.tenancy.spec.ts`.
 */
@Injectable()
export class QuantRunRepository extends TenantScopedRepository<QuantRunDocument> {
  constructor(
    @InjectModel(QuantRun.name) model: Model<QuantRunDocument>,
    /** The caller's own KPM row — its company — and the company's other KPMs, by id: no figure is read from it. */
    @InjectModel(Kpm.name) private readonly kpms: Model<KpmDocument>,
  ) {
    super(model, 'quantRuns');
  }

  /** The caller's own KPM's company — from the context's KPM, never a parameter — stamped on its runs. */
  async companyOf(ctx: RequestContext): Promise<string> {
    if (!ctx.kpmId) throw new MissingTenantContextError(this.collectionName, 'companyOf');
    const own = await this.kpms.findOne({ _id: ctx.kpmId }, { companyId: 1 }).lean().exec() as { companyId?: string } | null;
    return own?.companyId ?? '';
  }

  /** The KPM's run for a period, `null` before it is first computed. */
  async ofPeriod(ctx: RequestContext, periodEnd: string): Promise<QuantRunDocument | null> {
    return this.findOne(ctx, { periodEnd });
  }

  /** The KPM's runs whose read window (23 months before `periodEnd` to it) holds `month`. */
  async reading(ctx: RequestContext, month: string): Promise<QuantRunDocument[]> {
    const runs = await this.find(ctx, { periodEnd: { $gte: month } });
    return runs.filter((r) => r.periodEnd <= windowEnd(month));
  }

  /** Write a live run's values: refused (`null`) once it has frozen, so a frozen run never moves. */
  async writeLive(
    ctx: RequestContext,
    periodEnd: string,
    fields: { companyId: string; values: QuantRunDocument['values']; computedAt: Date; freezesAt: Date; fromMonth: string },
  ): Promise<QuantRunDocument | null> {
    return onceMore(async () => {
      const existing = await this.findOne(ctx, { periodEnd });
      if (existing?.frozenAt) return null;
      return this.upsertOne(ctx, { periodEnd, frozenAt: null }, {
        $set: {
          companyId: fields.companyId, values: fields.values, computedAt: fields.computedAt, freezesAt: fields.freezesAt,
          fromMonth: fields.fromMonth,
        },
        $setOnInsert: { peers: null, lateWriteAt: null },
      });
    });
  }

  /** Freeze a live run as it stands: its values, and the medians read now. Idempotent — a frozen run is left. */
  async freeze(
    ctx: RequestContext, periodEnd: string, fields: { values: QuantRunDocument['values']; peers: Record<QuantMetric, StoredPeers>; at: Date },
  ): Promise<void> {
    await this.model.updateOne(
      this.scope(ctx, 'freeze', { periodEnd, frozenAt: null }),
      { $set: { values: fields.values, peers: fields.peers, frozenAt: fields.at, computedAt: fields.at, updatedBy: ctx.membershipId } },
    ).exec();
  }

  /** *"Data diunggah setelah periode dikunci"*: a write into a frozen run's months. The first such write is kept. */
  async markLateWrite(ctx: RequestContext, ids: readonly string[], at: Date): Promise<void> {
    if (ids.length === 0) return;
    await this.model.updateMany(
      this.scope(ctx, 'markLateWrite', { _id: { $in: ids.filter((id) => isValidObjectId(id)) }, frozenAt: { $ne: null }, lateWriteAt: null }),
      { $set: { lateWriteAt: at } },
    ).exec();
  }

  /**
   * **`peerMediansAcrossTenants` — the peer median, a named unscoped aggregate** (R3, D4; ADR-0215 §5; P19.5-T3 AC-7).
   *
   * - **Who:** every other live KPM of the caller's own company — `status: 'active'` and not deleted, so an archived or a
   *   suspended office's last runs never move a median (ADR-0215 §5, amended 2026-11-06) — the company read from the
   *   caller's KPM row, from the request's context, never a parameter — on any template.
   * - **What:** for each metric, the values of those KPMs' runs for `periodEnd` that hold it **complete**; their median
   *   (`peerMedian`) from `QUANT.MIN_PEERS` of them, else `null`; and how many there were.
   * - **Returns** `{ [metric]: { median, peers } }` and nothing else: no `kpmId`, code, name, template or single value.
   *
   * Walks `quantRuns` by the company's KPM ids, `kpmId` leading its index (invariant §1). A tenant role's context only:
   * the Super Admin reads it through a platform read's context, which names the KPM.
   */
  async peerMediansAcrossTenants(
    ctx: RequestContext, periodEnd: string, fromMonth: string = `${periodEnd.slice(0, 4)}-01`,
  ): Promise<Record<QuantMetric, StoredPeers>> {
    if (!ctx.kpmId) throw new MissingTenantContextError(this.collectionName, 'peerMediansAcrossTenants');
    const own = await this.kpms.findOne({ _id: ctx.kpmId }, { companyId: 1 }).lean().exec() as { companyId?: string } | null;
    const empty = Object.fromEntries(QUANT_METRICS.map(({ metric }) => [metric, { median: null, peers: 0 }])) as Record<QuantMetric, StoredPeers>;
    if (!own?.companyId) return empty;
    const others = await this.kpms
      .find({ companyId: own.companyId, status: 'active', deletedAt: null, _id: { $ne: ctx.kpmId } }, { _id: 1 }).lean().exec();
    const ids = others.map((k) => String(k._id));
    if (ids.length === 0) return empty;
    const found = await this.model
      .find({ kpmId: { $in: ids }, periodEnd, deletedAt: null }, { values: 1, fromMonth: 1 }).lean().exec() as {
        values?: QuantRunDocument['values']; fromMonth?: string | null;
      }[];
    // P19.22-T4 (ADR-0275 §4): only the runs over the same months — a December run frozen before the half-years held the
    // whole year (`fromMonth` absent: January), and is never a half-year's peer.
    const runs = found.filter((r) => (r.fromMonth ?? `${periodEnd.slice(0, 4)}-01`) === fromMonth);
    return Object.fromEntries(QUANT_METRICS.map(({ metric }) => {
      const values = runs
        .map((r) => r.values?.[metric])
        .filter((v): v is NonNullable<typeof v> => v !== undefined && v.complete === true && typeof v.value === 'number')
        .map((v) => v.value as number);
      return [metric, { median: peerMedian(values, QUANT.MIN_PEERS), peers: values.length }];
    })) as Record<QuantMetric, StoredPeers>;
  }
}

/** The last run period a write into `month` reaches: 23 months after it. */
function windowEnd(month: string): string {
  const index = Number(month.slice(0, 4)) * 12 + Number(month.slice(5, 7)) - 1 + QUANT.GROWTH_MONTHS - 1;
  return `${Math.floor(index / 12)}-${String((index % 12) + 1).padStart(2, '0')}`;
}
