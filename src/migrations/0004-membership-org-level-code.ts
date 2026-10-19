import mongoose from 'mongoose';

/**
 * Copy each membership's ladder **code** onto the row (P4-T9).
 *
 * `orgLevelCode` is what a permission grant is compared against since P4-T9, and it is
 * denormalised precisely so `ContextResolver` does not pay a third lookup on every
 * request. A membership without it resolves a context with no rung, which every hierarchy
 * grant then denies — so this runs before the code that reads it, not after.
 *
 * **`directCounts` is rewritten at the same time**, from `{ ab, aab, agent, total }` to
 * keys that are ladder codes. Leaving the old shape would read as zero for every rung: the
 * old keys are lower case and nothing looks for them any more, so a leader with four
 * reports would show as leading nobody on every screen that breaks the number down.
 *
 * Idempotent: a row that already has a code is left alone, and the counts are recomputed
 * from the codes rather than translated, so running it twice changes nothing.
 */
export async function up(
  db: mongoose.mongo.Db,
): Promise<{ coded: number; recounted: number }> {
  const levels = await db.collection('companyOrgLevels')
    .find({ deletedAt: null }).toArray();
  const codeById = new Map(levels.map((l: Record<string, unknown>) => [String(l._id), String(l.code)]));

  const memberships = db.collection('memberships');
  const rows = await memberships.find({}).toArray();
  let coded = 0;
  let recounted = 0;

  for (const row of rows) {
    const code = codeById.get(String(row.orgLevelId))
      // A row whose level has been archived out from under it: the enum is still
      // one-to-one with the ladder in v1, so it is the honest fallback rather than a
      // membership left with no rung at all.
      ?? String(row.role ?? '').toUpperCase();
    if (!code) continue;
    if (row.orgLevelCode === code) continue;
    await memberships.updateOne({ _id: row._id }, { $set: { orgLevelCode: code } });
    coded += 1;
  }

  // Recompute every leader's breakdown from the codes just written.
  const withCodes = await memberships.find({}).toArray();
  const byId = new Map(withCodes.map((m: Record<string, unknown>) => [String(m._id), m]));
  const ladderByCompany = new Map<string, string[]>();
  for (const level of levels) {
    const key = String(level.companyId);
    if (level.status !== 'active') continue;
    ladderByCompany.set(key, [...(ladderByCompany.get(key) ?? []), String(level.code)]);
  }
  const kpms = await db.collection('kpms').find({}).toArray();
  const companyByKpm = new Map(
    kpms.map((k: Record<string, unknown>) => [String(k._id), String(k.companyId)]),
  );

  for (const leader of withCodes) {
    const directs = withCodes.filter(
      (m) => String(m.leaderId ?? '') === String(leader._id) && m.status === 'active',
    );
    const ladder = ladderByCompany.get(companyByKpm.get(String(leader.kpmId)) ?? '') ?? [];
    const counts: Record<string, number> = { total: directs.length };
    for (const code of ladder) counts[code] = 0;
    for (const d of directs) {
      const code = String(byId.get(String(d._id))?.orgLevelCode ?? '');
      if (code) counts[code] = (counts[code] ?? 0) + 1;
    }
    await memberships.updateOne({ _id: leader._id }, { $set: { directCounts: counts } });
    recounted += 1;
  }

  return { coded, recounted };
}
