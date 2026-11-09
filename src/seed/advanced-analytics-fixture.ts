import mongoose from 'mongoose';
import type { Clock } from '@/common/clock/clock.port';
import { DEFAULT_TENANT_TIMEZONE, QUANT, QUANT_METRICS, type QuantMetric } from '@/domain/constants';
import { latestRunPeriodEnd, plusMonths } from '@/domain/metrics/quant';
import { seedObjectId } from './coaching-fixture';

/**
 * **P19.5-T3 — the KPM's *Advanced analytics* page, seeded** (ADR-0215; `functional/advanced-analytics.md`), so every
 * section of 0417's page shows something a reviewer can check, each with its test (`advanced-analytics-seed.spec.ts`).
 *
 * | What | Where | What a reviewer sees |
 * |---|---|---|
 * | MAPA targets for this year's months so far: *APE* and *FLC* | `analyticsTargets` (`mapa`) | *MAPA driver*'s target cells filled; later months *TBD* |
 * | Agus's agency's targets, 4 and 8 | `analyticsTargets` (`subgroup`) | *Perbaikan sub-group*: Agus's row on its own targets, every other head the template's 3 and 6 |
 * | The company's other KPMs' runs for the latest period, frozen: 0555, 0601 and 0602 complete, 0603 incomplete | `quantRuns` | *Analitik kuantitatif*'s latest run: a median from three peers on every metric; 0603 left out |
 * | 0417's run for the period before, frozen, complete, its medians stored — A2 on two peers | `quantRuns` | Picking the earlier run: every chip — above, in line, below — and *"Belum cukup KPM pembanding (2 dari 3)"* on A2 |
 *
 * **0417's latest run is not seeded**: the page computes it from 0417's own file on its first read — the seeded file
 * leaves months below `completePct`, so its values read *Belum lengkap* and take no chip (AT-6). **The peers' runs and
 * 0417's earlier run are demonstration figures**, written frozen because no seeded office holds a complete file for
 * those months; a frozen run is never recomputed, so they stand as written. Demographics, *Event* and the survey tabs
 * read what the other fixtures already seed (the personal data of ADR-0158, the events' feedback, the survey runs).
 *
 * Idempotent: every row has a fixed `_id` from `seedObjectId`, and a row already there is left as it is.
 */
export interface AdvancedAnalyticsFixture {
  /** The latest run's period, and the one before it. */
  periods: { latest: string; previous: string };
  guide: string;
}

const M = 1_000_000 * 100;

/** A frozen run's values: every metric complete at `value(metric)`, or incomplete with its period's March missing. */
function values(periodEnd: string, value: (metric: QuantMetric) => number | null, complete = true) {
  return Object.fromEntries(QUANT_METRICS.map(({ metric }) => [metric, {
    value: value(metric), complete, missingMonths: complete ? [] : [`${periodEnd.slice(0, 4)}-03`], reason: null,
  }]));
}

/** A peer's figure, per metric: ratios near 1 to 3, shares in percent, A2 in agents, D1 in minor units. */
function peerFigure(metric: QuantMetric, k: number): number {
  switch (metric) {
    case 'QUANT_ANNUAL_ACTIVE_NET_GROWTH': return 2 + k;
    case 'NEW_AGENT_ACTIVATION_3M_PCT': return 40 + 5 * k;
    case 'QUANT_ACTIVATION_12M_PCT': return 60 + 5 * k;
    case 'QUANT_TENURED_ACTIVE_PCT': return 55 + 5 * k;
    case 'AVERAGE_CASE_SIZE_REALISED': return (14 + k) * M;
    case 'QUANT_AVG_ACTIVE_MONTHS': return 4 + k / 2;
    default: return 1.5 + k / 2;
  }
}

export async function seedAdvancedAnalyticsFixture(deps: {
  clock: Clock;
  companyId: string;
  office0417: { kpmId: string; agus: string; owner: string };
  peers: { code: string; kpmId: string }[];
}): Promise<AdvancedAnalyticsFixture> {
  const db = mongoose.connection.db!;
  const { clock, companyId } = deps;
  const today = clock.localDateFor(DEFAULT_TENANT_TIMEZONE);
  const thisMonth = today.slice(0, 7);
  const latest = latestRunPeriodEnd(thisMonth);
  const previous = plusMonths(latest, -6);
  const now = clock.now();
  const freezesAt = (p: string) => clock.startOfLocalDay(DEFAULT_TENANT_TIMEZONE, `${plusMonths(p, 1)}-${String(QUANT.FREEZE_DAY + 1).padStart(2, '0')}`);
  const kpm0417 = deps.office0417.kpmId;
  const once = async (collection: string, row: Record<string, unknown> & { _id: mongoose.Types.ObjectId }) => {
    if (!(await db.collection(collection).findOne({ _id: row._id }))) await db.collection(collection).insertOne(row);
  };
  const oid = (...parts: string[]) => new mongoose.Types.ObjectId(seedObjectId('advanced-analytics-fixture', ...parts));
  const stamp = { deletedAt: null, createdBy: deps.office0417.owner, updatedBy: deps.office0417.owner, createdAt: now, updatedAt: now };

  // ---- MAPA targets: APE and FLC for this year's months so far.
  for (let m = `${thisMonth.slice(0, 4)}-01`; m <= thisMonth; m = plusMonths(m, 1)) {
    await once('analyticsTargets', {
      _id: oid(kpm0417, 'mapa', m, 'ape'), kpmId: kpm0417, kind: 'mapa', month: m, row: 'ape', value: 150 * M,
      headMembershipId: null, aaTarget: null, recTarget: null, ...stamp,
    });
    await once('analyticsTargets', {
      _id: oid(kpm0417, 'mapa', m, 'flc'), kpmId: kpm0417, kind: 'mapa', month: m, row: 'flc', value: 2,
      headMembershipId: null, aaTarget: null, recTarget: null, ...stamp,
    });
  }
  // ---- Agus's agency's targets.
  await once('analyticsTargets', {
    _id: oid(kpm0417, 'subgroup', deps.office0417.agus), kpmId: kpm0417, kind: 'subgroup', month: null, row: null, value: null,
    headMembershipId: deps.office0417.agus, aaTarget: 4, recTarget: 8, ...stamp,
  });

  // ---- The peers' latest runs, frozen: three complete, the last incomplete (left out of 0417's median).
  for (const [i, peer] of deps.peers.entries()) {
    const complete = i < 3;
    await once('quantRuns', {
      _id: oid(peer.kpmId, 'quant', latest), kpmId: peer.kpmId, companyId, periodEnd: latest,
      values: values(latest, (metric) => peerFigure(metric, i), complete), peers: null,
      computedAt: freezesAt(latest), freezesAt: freezesAt(latest), frozenAt: freezesAt(latest), lateWriteAt: null, ...stamp,
    });
  }

  // ---- 0417's previous run, frozen and complete, with the medians it stood against — A2 on two peers only.
  const own: Partial<Record<QuantMetric, number>> = {
    QUANT_RECRUITS_PER_LEADER: 3.1, QUANT_ANNUAL_ACTIVE_NET_GROWTH: 4, QUANT_ACTIVE_PER_LEADER: 1.6,
    NEW_AGENT_ACTIVATION_3M_PCT: 45, QUANT_ACTIVATION_12M_PCT: 52, QUANT_TENURED_ACTIVE_PCT: 70,
    QUANT_AVG_MAA_PER_LEADER: 2.1, CASES_PER_PRODUCING_AGENT: 2, QUANT_AVG_ACTIVE_MONTHS: 4.6,
    AVERAGE_CASE_SIZE_REALISED: 15 * M,
  };
  const medians = Object.fromEntries(QUANT_METRICS.map(({ metric }) => [metric, metric === 'QUANT_ANNUAL_ACTIVE_NET_GROWTH'
    ? { median: null, peers: 2 }
    : { median: peerFigure(metric, 1), peers: 3 }]));
  await once('quantRuns', {
    _id: oid(kpm0417, 'quant', previous), kpmId: kpm0417, companyId, periodEnd: previous,
    values: values(previous, (metric) => own[metric] ?? null), peers: medians,
    computedAt: freezesAt(previous), freezesAt: freezesAt(previous), frozenAt: freezesAt(previous), lateWriteAt: null, ...stamp,
  });

  return {
    periods: { latest, previous },
    guide: `
Advanced analytics (P19.5-T3; sign in as the 0417 owner, KPM → Advanced analytics):
  MAPA driver          APE and FLC targets typed for ${thisMonth.slice(0, 4)} so far; later months TBD
  Analitik kuantitatif ${latest}: 0417 computed live (Belum lengkap, no chip), medians from ${deps.peers.slice(0, 3).map((p) => p.code).join(', ')}
                       ${previous}: 0417's frozen demonstration run — every chip; A2 "Belum cukup KPM pembanding (2 dari 3)"
  Perbaikan sub-group  Agus's agency on its own targets (4 · 8); every other head the template's 3 · 6
  The peers' runs and 0417's ${previous} run are demonstration figures, frozen (from src/seed/advanced-analytics-fixture.ts)
`,
  };
}
