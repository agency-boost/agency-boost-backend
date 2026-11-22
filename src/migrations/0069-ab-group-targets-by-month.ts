import mongoose from 'mongoose';
import { spreadOverYear } from '@/domain/metrics/ab-group-targets';
import { AB_GROUP_TARGET_INDEX } from '@/modules/reporting/ab-group-targets/ab-group-target.schema';

export interface AbGroupTargetsByMonthResult {
  /** Yearly targets of an active AB, carried into the twelve months of their year. */
  carried: number;
  /** Monthly rows written. */
  months: number;
  /** Months that already had a row — somebody's save, or a run before — left as they were. */
  kept: number;
  /** Yearly targets of an AAB: an AAB has no AB group (ADR-0270 §1), so there is nothing to carry them into. */
  droppedAab: number;
  /** Yearly targets of somebody no longer an active AB or AAB of the office: no AB group reads them. */
  droppedGone: number;
}

const asId = (id: string): mongoose.Types.ObjectId | string =>
  (mongoose.isValidObjectId(id) ? new mongoose.Types.ObjectId(id) : id);

/**
 * **Targets are per AB group per month** (P19.17-T4;
 * [ADR-0270](../../../docs/04-adr/0270-informal-groups-belong-to-abs-and-targets-are-set-per-ab-group-per-month.md) §4,
 * §7; OD-387 — reversible). Until now *Perbaikan sub-group* read **a leader's AA and recruitment targets for a year**
 * (`analyticsTargets`, kind `subgroup`, one per `(kpmId, headMembershipId, year)`, ADR-0253 §4). Now the owner sets
 * *Target Active Agent per bulan* and *Target Rekrut per bulan* **per AB group per month** (`abGroupTargets`).
 *
 * For every live `subgroup` row with a year whose leader is **an active AB** of its office:
 *
 * - **each of the twelve months of that year** gets a row: the Active Agent target **as it was** — it was already a
 *   monthly figure (*Target Active Agent per bulan*) — and the Rekrut target **spread over the year**, whole numbers that
 *   add up to the year's (`spreadOverYear`: 6 a year reads 0, 1, 0, 1 …), so January to any month holds the year's share
 *   to it, rounded down;
 * - **a month that already has a row is left as it is** (`$setOnInsert`): a target somebody saved wins.
 *
 * **An AAB's row is dropped** — an AAB has no AB group of their own; they follow their AB — and so is the row of somebody
 * who has left or is no longer a leader; both counted. **The `analyticsTargets` rows stay where they are**, unread, the
 * record of what was typed; `kpmRecruitTargets` is not touched (the KPM Overview's rewrite retires it). Each row written
 * is marked `source: 'migration-0069'`.
 *
 * Each write carries its `kpmId` (invariant §1); the one-per-AB-group-and-month index is built before the first. **Idempotent**:
 * a second run finds every month written, and writes nothing. On a database with no `subgroup` row it reads nothing and
 * creates no collection.
 */
export async function up(db: mongoose.mongo.Db, now: Date): Promise<AbGroupTargetsByMonthResult> {
  const result: AbGroupTargetsByMonthResult = { carried: 0, months: 0, kept: 0, droppedAab: 0, droppedGone: 0 };
  const exists = (await db.listCollections({ name: 'analyticsTargets' }, { nameOnly: true }).toArray()).length > 0;
  if (!exists) return result;
  const yearly = await db.collection('analyticsTargets')
    .find({ kind: 'subgroup', deletedAt: null, year: { $type: 'string' } })
    .sort({ kpmId: 1, headMembershipId: 1, year: 1 })
    .toArray();
  if (yearly.length === 0) return result;

  const targets = db.collection('abGroupTargets');
  const names = (await targets.indexes().catch(() => [])).map((index) => String(index.name));
  if (!names.includes(AB_GROUP_TARGET_INDEX)) {
    await targets.createIndex(
      { kpmId: 1, abMembershipId: 1, month: 1 },
      { unique: true, name: AB_GROUP_TARGET_INDEX, partialFilterExpression: { deletedAt: null } },
    );
  }
  const memberships = db.collection('memberships');

  for (const row of yearly) {
    const head = String(row.headMembershipId ?? '');
    const member = head
      ? await memberships.findOne({ _id: asId(head) as never, kpmId: row.kpmId, deletedAt: null }, { projection: { role: 1, status: 1 } })
      : null;
    if (member === null || member.status !== 'active' || !['ab', 'aab'].includes(String(member.role))) {
      result.droppedGone += 1;
      continue;
    }
    if (member.role !== 'ab') {
      result.droppedAab += 1;
      continue;
    }
    const rekrut = spreadOverYear(Number(row.recTarget ?? 0));
    const activeAgentTarget = Math.max(0, Math.floor(Number(row.aaTarget ?? 0)));
    for (let i = 0; i < 12; i += 1) {
      const month = `${String(row.year)}-${String(i + 1).padStart(2, '0')}`;
      const written = await targets.updateOne(
        { kpmId: row.kpmId, abMembershipId: head, month, deletedAt: null },
        {
          $setOnInsert: {
            kpmId: row.kpmId, abMembershipId: head, month, activeAgentTarget, rekrutTarget: rekrut[i],
            source: 'migration-0069', deletedAt: null, createdBy: null, updatedBy: null, createdAt: now, updatedAt: now,
          },
        },
        { upsert: true },
      );
      if (written.upsertedCount > 0) result.months += 1;
      else result.kept += 1;
    }
    result.carried += 1;
  }
  return result;
}

/** **Before ADR-0270**: the monthly rows this migration wrote and nobody has saved over since are removed. */
export async function down(db: mongoose.mongo.Db): Promise<{ removed: number }> {
  const removed = await db.collection('abGroupTargets').deleteMany({ source: 'migration-0069', updatedBy: null });
  return { removed: removed.deletedCount };
}
