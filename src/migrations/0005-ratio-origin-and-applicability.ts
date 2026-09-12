import mongoose from 'mongoose';
import { SEED_RATIO_DEFINITIONS } from '@/domain/constants';

/**
 * Backfill `origin` and `appliesToOrgLevelCodes` on every existing ratio (P4-T15).
 *
 * Both fields have schema defaults, so a row written before this migration reads as
 * `origin: 'office'` with no applicability — and that default is wrong in exactly the way
 * that matters. Every ratio in every office today came from provisioning, so leaving them
 * as `office` would make all five formulas editable in precisely the offices that already
 * exist, which is the thing ADR-0021 decided against.
 *
 * **The five seeded codes become `platform`; anything else stays `office`.** Matching by
 * code rather than by "everything that exists today" is deliberate: an office may already
 * have created its own ratio between P4-T2 and now, and that one is genuinely theirs.
 *
 * The two recruitment ratios also take their ADR-0020 applicability, so the offices that
 * exist behave identically to the ones provisioned after this.
 *
 * Idempotent: a row whose `origin` already matches is left alone, and applicability is
 * only written where it is still empty — an Owner who has already narrowed a ratio is not
 * overwritten by a seed default.
 */
export async function up(
  db: mongoose.mongo.Db,
): Promise<{ platform: number; office: number; scoped: number }> {
  const seeded = new Map(SEED_RATIO_DEFINITIONS.map((r) => [r.code, r]));
  const ratios = db.collection('ratioDefinitions');
  const rows = await ratios.find({}).toArray();

  let platform = 0;
  let office = 0;
  let scoped = 0;

  for (const row of rows) {
    const seed = seeded.get(String(row.code));
    const origin = seed ? 'platform' : 'office';
    const set: Record<string, unknown> = {};

    if (row.origin !== origin) set.origin = origin;

    const rungs = seed?.appliesToOrgLevelCodes ?? [];
    const current = Array.isArray(row.appliesToOrgLevelCodes) ? row.appliesToOrgLevelCodes : [];
    if (rungs.length && current.length === 0) set.appliesToOrgLevelCodes = [...rungs];

    if (Object.keys(set).length === 0) continue;
    await ratios.updateOne({ _id: row._id }, { $set: set });

    if (set.origin === 'platform') platform += 1;
    if (set.origin === 'office') office += 1;
    if (set.appliesToOrgLevelCodes) scoped += 1;
  }

  return { platform, office, scoped };
}
