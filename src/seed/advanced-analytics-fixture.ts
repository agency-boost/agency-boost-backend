import mongoose from 'mongoose';
import type { Clock } from '@/common/clock/clock.port';
import { DEFAULT_TENANT_TIMEZONE, QUANT, QUANT_METRICS, type QuantMetric } from '@/domain/constants';
import { latestRunPeriodEnd, periodMonths, plusMonths } from '@/domain/metrics/quant';
import { seedObjectId } from './coaching-fixture';

/**
 * **The KPM's *Advanced analytics* page, seeded** (P19.5-T3; P19.22, ADR-0275; `functional/advanced-analytics.md`), so every
 * tab of 0417's page shows something a reviewer can check, each with its test (`advanced-analytics-seed.spec.ts`).
 *
 * | What | Where | What a reviewer sees |
 * |---|---|---|
 * | The company's other KPMs' runs for the latest half-year **and the one before**, frozen: 0555, 0601 and 0602 complete, 0603 incomplete | `quantRuns` | *Analisa kuantitatif*: a peer median from three peers on every metric, in both half-years; 0603 left out |
 * | 0417's run for the half-year before, frozen, complete, its medians stored — A2 on two peers | `quantRuns` | The latest half-year's *Semester lalu* ▲/▼; picking the earlier one: every chip — above, in line, below — and *"Belum cukup KPM pembanding (2 dari 3)"* on A2 |
 *
 * **0417's latest run is not seeded**: the page computes it, and its distribution per leader, from 0417's own file on its
 * first read. **The peers' runs and 0417's earlier run are demonstration figures**, written frozen because no seeded office
 * holds a complete file for those months; a frozen run is never recomputed, so they stand as written. Each carries the
 * first month of its half-year (`fromMonth`): a December run is July to December (ADR-0275 §4).
 *
 * The other tabs read what the other fixtures seed: *Demografi* the personal data of ADR-0158 and the join dates — a join
 * date is on file for the new hires only, so *Perlu melengkapi* has people in it; *MAPA driver* the production file from
 * January of last year (`data-upload-fixture.ts`, `production-figures.ts`), the new hires and the AB groups' targets;
 * *Informal group* the groups and targets of `informal-groups-fixture.ts`. *Changed 2026-11-20 (P19.22):* the typed MAPA
 * targets and the leaders' yearly sub-group targets are no longer seeded — nothing reads them (ADR-0270, ADR-0275 §3).
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
  /** P19.13-T3: Sari and Dewi too, whose targets *Core leaders & groups* shows set (ADR-0253 §4). */
  office0417: { kpmId: string; agus: string; owner: string; sari?: string; dewi?: string };
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

  // ---- The peers' runs for the latest half-year and the one before, frozen: three complete, the last incomplete (left out
  // of 0417's median). Each over its own half-year (`fromMonth`, ADR-0275 §4).
  for (const period of [latest, previous]) {
    for (const [i, peer] of deps.peers.entries()) {
      const complete = i < 3;
      await once('quantRuns', {
        _id: oid(peer.kpmId, 'quant', period), kpmId: peer.kpmId, companyId, periodEnd: period, fromMonth: periodMonths(period)[0],
        values: values(period, (metric) => peerFigure(metric, i), complete), peers: null,
        computedAt: freezesAt(period), freezesAt: freezesAt(period), frozenAt: freezesAt(period), lateWriteAt: null, ...stamp,
      });
    }
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
    _id: oid(kpm0417, 'quant', previous), kpmId: kpm0417, companyId, periodEnd: previous, fromMonth: periodMonths(previous)[0],
    values: values(previous, (metric) => own[metric] ?? null), peers: medians,
    computedAt: freezesAt(previous), freezesAt: freezesAt(previous), frozenAt: freezesAt(previous), lateWriteAt: null, ...stamp,
  });

  return {
    periods: { latest, previous },
    guide: `
Advanced analytics (P19.22; sign in as the 0417 owner, KPM → Advanced analytics):
  Demografi            the members' personal data (ADR-0158); join dates on file for the new hires only, so Perlu
                       melengkapi lists people — Unduh daftar (CSV), fill Tanggal bergabung, Upload
  MAPA driver          the production file from January of last year; Rekrut = new hires; Target bulanan from the AB
                       groups' targets (Informal group) and Goal Setting ÷ 12
  Analisa kuantitatif  ${latest}: 0417 computed live with its distribution per leader, medians from ${deps.peers.slice(0, 3).map((p) => p.code).join(', ')};
                       Semester lalu from ${previous}, 0417's frozen demonstration run — every chip; A2 short of peers (2 dari 3)
  Informal group       Top Producers 2026, Mentoring Agen Baru, LEADER MUDA (empty) and Tanpa group, each AB group's
                       four drivers; tap a pill for the people behind it
  The peers' runs and 0417's ${previous} run are demonstration figures, frozen (from src/seed/advanced-analytics-fixture.ts)
`,
  };
}
