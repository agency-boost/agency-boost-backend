import mongoose from 'mongoose';

/** What one run did. Printed by `run.ts`, so the deploy log is the record of it. */
export interface MocApeKeyResult {
  /** Live `moc` rules whose criteria named `NET_APE`, renamed this run. */
  rules: number;
  /** `campaign_kinds` templates, draft or published, whose `moc` rules named it, renamed this run. */
  templates: number;
  /** `moc` rules and templates that named it no longer — a second run, or written since. */
  current: number;
}

/** The key retired and the key that took its place, written out so this says the same thing on every run. */
const FROM = 'NET_APE';
const TO = 'MOC_APE';

interface HeldCriterion { metricKey?: unknown }
interface HeldGroup { criteria?: HeldCriterion[] }
interface HeldRule { kind?: unknown; criteriaGroups?: HeldGroup[] }

/** Each group's criteria with `NET_APE` renamed, and whether anything was. Nothing else of a criterion is touched. */
function renamed(groups: readonly HeldGroup[]): { groups: HeldGroup[]; changed: boolean } {
  let changed = false;
  const out = groups.map((group) => ({
    ...group,
    criteria: (group.criteria ?? []).map((criterion) => {
      if (criterion?.metricKey !== FROM) return criterion;
      changed = true;
      return { ...criterion, metricKey: TO };
    }),
  }));
  return { groups: out, changed };
}

/**
 * **APE is APE: the MOC rules' `NET_APE` becomes `MOC_APE`, in place** (P19.3-T1; ADR-0201 §1, the owner's data sources'
 * D5, *"There is no 'Net APE' anywhere. MOC's APE criterion uses uploaded APE"*).
 *
 * `NET_APE` is retired from the registry (`metrics.ts`), and its definition carries on, unchanged, as `MOC_APE`. The
 * seeded MOC rules — every company's `qualificationRules` of kind `moc`, and the `campaign_kinds` company templates, draft
 * and published, that a company's rules are published from (ADR-0026) — named the old key. This renames it in each
 * criterion that holds it, and nothing else:
 *
 * - **A rename, not a new bar**: the comparator, the threshold, the unit and every other criterion are kept, and no
 *   `effectiveFrom` is written (ADR-0026's dating is for a carrier revising its bar).
 * - **`waitingOnMetrics` is recomputed**: `NET_APE` leaves it — a key nobody registers is not something a rule waits on —
 *   and nothing else in it moves. It has been empty since `0026-moc-persistency`.
 * - **Only the `moc` kind**: a production club or a promotion path that names the key is a rule nobody seeded, and is left
 *   as it is (a stored key is read as `MOC_APE` anyway, `RENAMED_METRIC_KEYS`). A soft-deleted rule is not touched.
 * - **Touches no office**: carrier rules and their templates are the company's.
 *
 * **Idempotent**: a rule or template naming `NET_APE` no longer is `current`. Timestamps by hand: no Mongoose in between.
 * Prints `{ rules, templates, current }`.
 */
export async function up(db: mongoose.mongo.Db, now: Date): Promise<MocApeKeyResult> {
  const result: MocApeKeyResult = { rules: 0, templates: 0, current: 0 };

  const rules = db.collection('qualificationRules');
  for (const rule of await rules
    .find({ kind: 'moc', deletedAt: null }, { projection: { criteriaGroups: 1, waitingOnMetrics: 1 } })
    .sort({ _id: 1 })
    .toArray()) {
    const { groups, changed } = renamed((rule.criteriaGroups ?? []) as HeldGroup[]);
    const waiting = (rule.waitingOnMetrics ?? []) as string[];
    const stillWaiting = waiting.filter((key) => key !== FROM);
    if (!changed && stillWaiting.length === waiting.length) {
      result.current += 1;
      continue;
    }
    await rules.updateOne(
      { _id: rule._id },
      { $set: { criteriaGroups: groups, waitingOnMetrics: stillWaiting, updatedAt: now } },
    );
    result.rules += 1;
  }

  const templates = db.collection('companyTemplates');
  for (const template of await templates
    .find({ kind: 'campaign_kinds', deletedAt: null }, { projection: { payload: 1 } })
    .sort({ _id: 1 })
    .toArray()) {
    const held = (template.payload as { rules?: unknown } | undefined)?.rules;
    if (!Array.isArray(held)) continue;
    let changed = false;
    const next = (held as HeldRule[]).map((rule) => {
      if (rule?.kind !== 'moc' || !Array.isArray(rule.criteriaGroups)) return rule;
      const out = renamed(rule.criteriaGroups);
      if (!out.changed) return rule;
      changed = true;
      return { ...rule, criteriaGroups: out.groups };
    });
    if (!changed) {
      result.current += 1;
      continue;
    }
    // No version moves: an office built from this template reads as built from the same version.
    await templates.updateOne({ _id: template._id }, { $set: { 'payload.rules': next, updatedAt: now } });
    result.templates += 1;
  }

  return result;
}
