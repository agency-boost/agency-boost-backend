import mongoose from 'mongoose';
import { SEED_RATIO_DEFINITIONS, SEEDED_RATIO_FORMULAS_BEFORE_ADR_0267 } from '@/domain/constants/activity-taxonomy';

export interface SuccessRatesResult {
  /** Office ratio rows moved to the new formula, their standard with them. */
  ratios: number;
  /** Office ratio rows on a formula the Owner chose: left as they are. */
  kept: number;
  /** Offices' newest published snapshots whose ratio moved the same way. */
  snapshots: number;
  /** `ratio_set` company templates, draft and published, whose ratio moved. */
  templates: number;
}

type Side = readonly string[];
interface Move {
  code: keyof typeof SEEDED_RATIO_FORMULAS_BEFORE_ADR_0267;
  before: { numerator: Side; denominator: Side };
  after: { numerator: Side; denominator: Side };
}

/** The two moves: each success rate's formula before ADR-0267, and the seed's now. */
function moves(): Move[] {
  return (Object.keys(SEEDED_RATIO_FORMULAS_BEFORE_ADR_0267) as Move['code'][]).map((code) => {
    const after = SEED_RATIO_DEFINITIONS.find((r) => r.code === code)!;
    return { code, before: SEEDED_RATIO_FORMULAS_BEFORE_ADR_0267[code], after: { numerator: after.numerator, denominator: after.denominator } };
  });
}

/** Two formula sides are the same set of codes: order is display, never meaning (`ratio-diverges.ts`). */
const same = (a: unknown, b: Side): boolean =>
  Array.isArray(a) && a.length === b.length && [...a].map(String).sort().join() === [...b].sort().join();

/** A side recorded as the standard is the old one, or none is recorded (a row or a copy written before ADR-0024). */
const standardIsOld = (standard: unknown, old: Side): boolean => standard === undefined || standard === null || same(standard, old);

/** An element of a snapshot's or a template's `ratios[]` still on the formula `move` replaces, its standard with it. */
function onOldFormula(el: Record<string, unknown>, move: Move): boolean {
  return el.code === move.code && el.origin !== 'office'
    && same(el.numerator, move.before.numerator) && same(el.denominator, move.before.denominator)
    && standardIsOld(el.standardNumerator, move.before.numerator) && standardIsOld(el.standardDenominator, move.before.denominator);
}

/** The element moved: the new formula, and the new standard where it carries one. */
function moved(el: Record<string, unknown>, move: Move): Record<string, unknown> {
  return {
    ...el,
    numerator: [...move.after.numerator],
    denominator: [...move.after.denominator],
    ...('standardNumerator' in el && el.standardNumerator != null ? { standardNumerator: [...move.after.numerator] } : {}),
    ...('standardDenominator' in el && el.standardDenominator != null ? { standardDenominator: [...move.after.denominator] } : {}),
  };
}

/** One document's `ratios[]` at `path` with every element on an old formula moved; `null` when none is. */
function movedArray(ratios: unknown, all: readonly Move[]): Record<string, unknown>[] | null {
  if (!Array.isArray(ratios)) return null;
  let touched = false;
  const out = ratios.map((el: Record<string, unknown>) => {
    const move = all.find((m) => el && typeof el === 'object' && onOldFormula(el, m));
    if (!move) return el;
    touched = true;
    return moved(el, move);
  });
  return touched ? out : null;
}

/**
 * **The success rates count no follow-up** (P19.17-T1 AC-6; ADR-0267 §6; the owner's part D of 19 November 2026):
 * *Selling success rate* = Submission polis ÷ Presentasi penjualan, *Recruitment success rate* = Proses NPA ÷ Presentasi
 * rekrut. A new office is given them by the seed (`SEED_RATIO_DEFINITIONS`); this gives an existing one the same **only
 * where the ratio is still on the standard formula** (ADR-0024: an office owns its copy):
 *
 * - **The working copy** (`ratioDefinitions`, `origin: 'platform'`): a row whose formula *and* recorded standard are both
 *   the old one takes the new formula and the new standard together, so it reads unchanged against its standard. A row
 *   whose formula the Owner changed keeps its formula and its standard — it diverged from the old standard, and is shown
 *   so — and is counted `kept`. Archived rows too; a soft-deleted one is not read.
 * - **Each office's newest published snapshot** (`configSnapshots`, `payload.ratios[]`), element by element by the same
 *   rule, so agents read what the working copy says and no publish bar speaks.
 * - **Every `ratio_set` company template**, draft and published, element by element.
 *
 * By `code` (invariant §4), the two sides compared as sets. **No version moves.** **Idempotent**, and safe on every
 * deploy (no ledger): a moved row's standard is the new formula, so an Owner who later puts follow-ups back is never moved
 * again; nothing the seed writes now is an old formula. A template somebody edits back to the old formula is moved on the
 * next deploy — the owner decided the definition, and a template is the platform's (accepted, as `0033` accepted it).
 * On an empty database it reads nothing and creates no collection.
 */
export async function up(db: mongoose.mongo.Db): Promise<SuccessRatesResult> {
  const all = moves();
  const result: SuccessRatesResult = { ratios: 0, kept: 0, snapshots: 0, templates: 0 };

  const ratios = db.collection('ratioDefinitions');
  const rows = await ratios.find(
    { code: { $in: all.map((m) => m.code) }, origin: 'platform', deletedAt: null },
    { projection: { kpmId: 1, code: 1, numerator: 1, denominator: 1, standardNumerator: 1, standardDenominator: 1 } },
  ).toArray();
  for (const row of rows) {
    const move = all.find((m) => m.code === row.code)!;
    const onOld = same(row.numerator, move.before.numerator) && same(row.denominator, move.before.denominator)
      && standardIsOld(row.standardNumerator, move.before.numerator) && standardIsOld(row.standardDenominator, move.before.denominator);
    if (!onOld) {
      // Already the new formula (a second run, or an office provisioned since) is not an Owner's choice to count.
      if (!(same(row.numerator, move.after.numerator) && same(row.denominator, move.after.denominator))) result.kept += 1;
      continue;
    }
    await ratios.updateOne(
      { _id: row._id, kpmId: row.kpmId },
      {
        $set: {
          numerator: [...move.after.numerator], denominator: [...move.after.denominator],
          standardNumerator: [...move.after.numerator], standardDenominator: [...move.after.denominator],
        },
      },
    );
    result.ratios += 1;
  }

  // Each office's newest snapshot, where it still carries an old formula.
  const snapshots = db.collection('configSnapshots');
  for (const kpmId of await snapshots.distinct('kpmId', { deletedAt: null })) {
    const [newest] = await snapshots.find({ kpmId, deletedAt: null }).sort({ version: -1 }).limit(1).toArray();
    const next = newest ? movedArray((newest.payload as { ratios?: unknown } | undefined)?.ratios, all) : null;
    if (!newest || !next) continue;
    await snapshots.updateOne({ _id: newest._id, kpmId }, { $set: { 'payload.ratios': next } });
    result.snapshots += 1;
  }

  const templates = db.collection('companyTemplates');
  const candidates = await templates.find(
    { kind: 'ratio_set', 'payload.ratios.code': { $in: all.map((m) => m.code) } },
    { projection: { 'payload.ratios': 1 } },
  ).toArray();
  for (const doc of candidates) {
    const next = movedArray((doc.payload as { ratios?: unknown } | undefined)?.ratios, all);
    if (!next) continue;
    await templates.updateOne({ _id: doc._id }, { $set: { 'payload.ratios': next } });
    result.templates += 1;
  }
  return result;
}
