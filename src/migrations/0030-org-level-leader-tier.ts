import mongoose from 'mongoose';
import { LEGACY_TIER_BY_CODE } from '@/domain/constants/leader-tier';

export interface OrgLevelLeaderTierResult {
  /** Rungs given *Senior Leader*: every `AB`. */
  senior: number;
  /** Rungs given *Associate Leader*: every `AAB`. */
  associate: number;
  /** Rungs given *Not a leader*: every other code, `AGENT` and each custom rung. */
  none: number;
  /**
   * Live memberships on a rung outside the default ladder, **left as they are**: their `role` was never derived from
   * a tier, and re-classing anybody is a decision for the Super Admin on `/admin/org-levels`, not for a deploy. In
   * v1 no product path could place a member on such a rung (the role was the code lower-cased, and the enum refused
   * any code but three), so this is expected to be 0; the runner prints it so a non-zero says where to look.
   */
  membersOnCustomRungs: number;
}

/**
 * **Every rung's leader tier** (P18.5-T1, ADR-0156 §1).
 *
 * `companyOrgLevels.leaderTier` decides the class a member is given when placed on the rung, and RBAC, *Leaders
 * used* and the Owner's agency and unit partitions read the class. Until this field, the class was the rung's code
 * lower-cased, so the tiers written here are **the ones that change nobody**: `AB` → `senior`, `AAB` → `associate`,
 * every other code → `null`. Each membership on those rungs already carries the class its rung's tier now gives.
 *
 * The rule is `LEGACY_TIER_BY_CODE`, the same one `tierOfRung` reads a row this has not reached yet by, so the API
 * and this migration cannot disagree about a rung in the window between them. Archived and soft-deleted rungs are
 * given a tier too: an archived rung still renders the people who stood on it.
 *
 * **Idempotent**: only a rung with **no** `leaderTier` field is touched — a `null` the Super Admin set is a value,
 * and is never rewritten. A second run finds nothing. On an empty database it reads nothing and writes nothing.
 */
export async function up(db: mongoose.mongo.Db): Promise<OrgLevelLeaderTierResult> {
  const levels = db.collection('companyOrgLevels');
  const missing = { leaderTier: { $exists: false } };

  const tiered = { senior: 0, associate: 0 };
  for (const [code, tier] of Object.entries(LEGACY_TIER_BY_CODE)) {
    const written = await levels.updateMany({ ...missing, code }, { $set: { leaderTier: tier } });
    tiered[tier] += written.modifiedCount;
  }
  const none = await levels.updateMany(missing, { $set: { leaderTier: null } });

  const membersOnCustomRungs = await db.collection('memberships').countDocuments({
    orgLevelCode: { $nin: ['AGENT', ...Object.keys(LEGACY_TIER_BY_CODE)] },
    status: { $in: ['active', 'pending'] },
    deletedAt: null,
  });

  return { ...tiered, none: none.modifiedCount, membersOnCustomRungs };
}
