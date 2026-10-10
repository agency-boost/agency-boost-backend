import mongoose from 'mongoose';
import { MOC_PERSISTENCY_MIN_PCT } from '@/domain/constants';

/** What one run did. Printed by `run.ts`, so the deploy log is the record of it. */
export interface MocPersistencyResult {
  /** MOC rules given the persistency criterion this run. */
  added: number;
  /** MOC rules that already carried it — a second run, or a company created since. */
  current: number;
  /** Rules whose `waitingOnMetrics` named a metric registered since, cleared of it. */
  cleared: number;
}

/** The criterion the seeded rules lacked (`KPM_Owner.html:1248`, `:3305`, `:3313`; §B.6). */
const CRITERION = {
  metricKey: 'MOC_PERSISTENCY', comparator: 'gte', value: MOC_PERSISTENCY_MIN_PCT, unit: 'percentage',
} as const;

/**
 * MOC's inputs, registered by Phase 18 (D-registry). A rule's `waitingOnMetrics` listed them while nothing
 * computed them; once registered, a rule no longer waits on them. Written out, not read from the registry, so
 * this migration says the same thing on every run, whatever the registry becomes.
 */
const REGISTERED_BY_THIS_PHASE = ['NET_APE', 'MONTHLY2_AA', 'MONTHLY2_AA_DU', 'MONTHLY2_AA_DG', 'DIRECT_AB_COUNT', 'MOC_PERSISTENCY'];

/**
 * **The persistency criterion, for every company's seeded MOC rules** (Phase 18, P18-T2 AC-4; OD-22 → option 1,
 * D-moc).
 *
 * The prototype states MOC with rolling persistency at 75% for both rungs — *"Rolling Persistency DU ≥ 75%"* for
 * an AAB, *"DU/DG ≥ 75%"* on the AB's standard path (`KPM_Owner.html:1248`, the dialog `:3305`, `:3313`) — and
 * the rules P5-T7 seeded left it out. `SEED_MOC_RULES` carries it now, for a company created from here on; this
 * gives it to every company's existing rules: **the first group** of each live rule of kind `moc` — the AB's
 * three-criteria path, and the AAB's only group — gains `MOC_PERSISTENCY ≥ MOC_PERSISTENCY_MIN_PCT`, and the
 * rule stops listing the metrics this phase registered as ones it waits on.
 *
 * **Touches no office**: carrier rules are the company's (ADR-0026). **Idempotent**: a rule whose first group
 * names `MOC_PERSISTENCY` already is left as it is — a second run, a company created since, or a threshold a
 * platform operator changed by hand — so a deployment never overwrites one.
 */
export async function up(db: mongoose.mongo.Db, now: Date): Promise<MocPersistencyResult> {
  const rules = db.collection('qualificationRules');
  const result: MocPersistencyResult = { added: 0, current: 0, cleared: 0 };

  const rows = await rules
    .find({ kind: 'moc', deletedAt: null }, { projection: { criteriaGroups: 1, waitingOnMetrics: 1 } })
    .sort({ _id: 1 })
    .toArray();

  for (const rule of rows) {
    const groups = (rule.criteriaGroups ?? []) as { criteria?: { metricKey: string }[] }[];
    const waiting = (rule.waitingOnMetrics ?? []) as string[];
    const stillWaiting = waiting.filter((key) => !REGISTERED_BY_THIS_PHASE.includes(key));
    const set: Record<string, unknown> = {};
    if (stillWaiting.length !== waiting.length) {
      set.waitingOnMetrics = stillWaiting;
      result.cleared += 1;
    }
    if (groups.length > 0 && !(groups[0].criteria ?? []).some((c) => c.metricKey === CRITERION.metricKey)) {
      set['criteriaGroups.0.criteria'] = [...(groups[0].criteria ?? []), { ...CRITERION }];
      result.added += 1;
    } else {
      result.current += 1;
    }
    // Timestamps by hand: this update has no Mongoose in between to stamp it.
    if (Object.keys(set).length > 0) await rules.updateOne({ _id: rule._id }, { $set: { ...set, updatedAt: now } });
  }

  return result;
}
