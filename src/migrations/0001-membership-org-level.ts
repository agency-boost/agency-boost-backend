import mongoose from 'mongoose';

/**
 * Backfill `memberships.orgLevelId` (P3.5-T8).
 *
 * Every membership references the rung it stands on. Rows written before the reference
 * existed have none, and `role` is the only thing that says where those people stand — so
 * this resolves each one against its office's company ladder, by the same
 * `role.toUpperCase() === code` rule every write now uses.
 *
 * **A company with no ladder gets one first.** `DEFAULT_ORG_LADDER` is what
 * `createCompany` seeds now, and a company created before that has nothing to resolve
 * against.
 *
 * Idempotent: it touches only rows where the field is missing, and it skips a company
 * whose ladder already exists. Forward-only — there is no `down`, by convention.
 */
export async function up(
  db: mongoose.mongo.Db,
  /**
   * Required, not defaulted. A migration has no request context and therefore no injected
   * `Clock`, but the reason the port exists still holds — a test has to be able to say
   * what "now" was — so the runner reads `SystemClock`, which is the one sanctioned place
   * the wall clock is touched.
   */
  now: Date,
): Promise<{ ladders: number; memberships: number }> {
  const DEFAULT_LADDER = [
    { code: 'AGENT', label: 'Agent', displayOrder: 1 },
    { code: 'AAB', label: 'AAB', displayOrder: 2 },
    { code: 'AB', label: 'AB', displayOrder: 3 },
  ];

  const companies = await db.collection('companies').find({ deletedAt: null }).toArray();
  let ladders = 0;
  for (const company of companies) {
    for (const rung of DEFAULT_LADDER) {
      const exists = await db
        .collection('companyOrgLevels')
        .findOne({ companyId: String(company._id), code: rung.code, deletedAt: null });
      if (exists) continue;
      await db.collection('companyOrgLevels').insertOne({
        ...rung,
        companyId: String(company._id),
        status: 'active',
        archivedAt: null,
        deletedAt: null,
        createdAt: now,
        updatedAt: now,
        version: 0,
      });
      ladders += 1;
    }
  }

  // kpmId → companyId, so each membership resolves against the right ladder.
  const kpms = await db.collection('kpms').find({}).toArray();
  const companyOf = new Map(kpms.map((k) => [String(k._id), String(k.companyId)]));

  const levels = await db.collection('companyOrgLevels').find({ deletedAt: null }).toArray();
  const levelOf = new Map(levels.map((l) => [`${String(l.companyId)}:${String(l.code)}`, String(l._id)]));

  const stale = await db
    .collection('memberships')
    .find({ $or: [{ orgLevelId: { $exists: false } }, { orgLevelId: null }] })
    .toArray();

  let memberships = 0;
  for (const member of stale) {
    const companyId = companyOf.get(String(member.kpmId));
    const orgLevelId = companyId
      ? levelOf.get(`${companyId}:${String(member.role).toUpperCase()}`)
      : undefined;
    if (!orgLevelId) {
      // Loud rather than silent. A membership whose office or rung cannot be found is a
      // data problem somebody has to look at, not something to paper over with a null.
      throw new Error(
        `Cannot resolve a rung for membership ${String(member._id)} ` +
          `(kpm ${String(member.kpmId)}, role ${String(member.role)})`,
      );
    }
    await db.collection('memberships').updateOne({ _id: member._id }, { $set: { orgLevelId } });
    memberships += 1;
  }

  return { ladders, memberships };
}
