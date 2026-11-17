import mongoose from 'mongoose';

export interface NewHireByCompanyYearResult {
  /** New hires whose company month is in another year than their join date: now existing agents. */
  reclassified: number;
  /** New hires whose company month is in their join date's year: they stay new hires. */
  kept: number;
  /** New hires with no company month on file, or none readable: left as the 90-day rule made them. */
  noMonth: number;
}

/** A company join month as `users.companyJoinMonth` stores it, `YYYY-MM`. */
const MONTH = /^\d{4}-\d{2}$/;

const asId = (id: string): mongoose.Types.ObjectId | string =>
  (mongoose.isValidObjectId(id) ? new mongoose.Types.ObjectId(id) : id);

/**
 * **A new hire is somebody who joined the company the year they joined the office** (P19.16-T2 AC-2; ADR-0264, the
 * client's request of 17 November: *"New hire if they joined the company this year"*). Until now `joinedAs` came from
 * the office join date alone (ADR-0169 §3: within 90 days of the day it was set), so an office opened in November made
 * everybody who registered into it a new hire, tenured agents included. For every membership classified `new_hire`
 * whose person has a company join month on file (`users.companyJoinMonth`):
 *
 * - **a month in another year than the join date** — joined the insurer before the year they joined the office, or a
 *   join date a leader set years back — becomes `existing_agent`, the value it replaced kept as `migrated0064` for `down`;
 * - **a month in the join date's year** stays `new_hire`.
 *
 * **Only downward.** An `existing_agent` the new rule would call a new hire — a join date a leader set more than 90 days
 * back, in the year the person joined the company — is left as it is: making them one now would start a 3M clock whose
 * 90 days are already behind them (ADR-0171), and nobody asked for it. **No month, no change**: the 90-day rule's answer
 * stands. A membership whose person has no account (an invitation not yet taken) has no month either.
 *
 * Every office's memberships, removed and soft-deleted ones too — a report about the past reads them — each write
 * carrying its `kpmId` (invariant §1). `users` is global (ADR-0002) and only read. **Idempotent**: a second run finds no
 * new hire with a month in another year, and writes nothing. On an empty database it reads nothing and creates no collection.
 */
export async function up(db: mongoose.mongo.Db): Promise<NewHireByCompanyYearResult> {
  const memberships = db.collection('memberships');
  const users = db.collection('users');
  const result: NewHireByCompanyYearResult = { reclassified: 0, kept: 0, noMonth: 0 };

  const hires = await memberships
    .find({ joinedAs: 'new_hire' }, { projection: { kpmId: 1, userId: 1, joinDate: 1 } })
    .toArray();
  const userIds = [...new Set(hires.map((h) => (h.userId ? String(h.userId) : null)).filter((u): u is string => u !== null))];
  const months = new Map<string, string>();
  if (userIds.length > 0) {
    const found = await users
      .find({ _id: { $in: userIds.map(asId) as never[] } }, { projection: { companyJoinMonth: 1 } })
      .toArray();
    for (const u of found) {
      if (typeof u.companyJoinMonth === 'string' && MONTH.test(u.companyJoinMonth)) months.set(String(u._id), u.companyJoinMonth);
    }
  }

  for (const hire of hires) {
    const month = hire.userId ? months.get(String(hire.userId)) : undefined;
    const joinDate = typeof hire.joinDate === 'string' ? hire.joinDate : null;
    if (!month || !joinDate) {
      result.noMonth += 1;
      continue;
    }
    if (month.slice(0, 4) === joinDate.slice(0, 4)) {
      result.kept += 1;
      continue;
    }
    await memberships.updateOne(
      { _id: hire._id, kpmId: hire.kpmId, joinedAs: 'new_hire' },
      { $set: { joinedAs: 'existing_agent', migrated0064: { joinedAs: 'new_hire' } } },
    );
    result.reclassified += 1;
  }
  return result;
}

/** **Before ADR-0264**: every membership `up` reclassified is a new hire again, and the kept value goes. */
export async function down(db: mongoose.mongo.Db): Promise<{ restored: number }> {
  const written = await db.collection('memberships').updateMany(
    { 'migrated0064.joinedAs': 'new_hire' },
    { $set: { joinedAs: 'new_hire' }, $unset: { migrated0064: '' } },
  );
  return { restored: written.modifiedCount };
}
