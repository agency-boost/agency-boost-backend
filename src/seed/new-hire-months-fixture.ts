import mongoose from 'mongoose';

/** A company join month as `users.companyJoinMonth` stores it, `YYYY-MM`. */
const MONTH = /^\d{4}-\d{2}$/;

export interface NewHireMonthsFixture {
  /** Accounts whose company join month was moved to agree with how the seed classified their membership. */
  aligned: number;
  guide: string;
}

/**
 * **Every seeded person's company join month agrees with whether they are a new hire** (P19.16-T2 AC-3; ADR-0264). The
 * seed places its people with `joinedAs` written out — the New Hires walk's cast `new_hire`, everybody else
 * `existing_agent` — and gives every account a company join month derived from its email (`personal-fixture.ts`), in
 * 2025 or before. Under ADR-0264 a new hire joined the company the year they joined the office, so the two disagreed for
 * every seeded new hire, and migration 0064 would make each an existing agent on the next deploy to staging:
 *
 * - **a new hire** whose month is in another year than their join date takes **their join date's month** — *Bergabung
 *   di Prudential* reads the month they joined 0417, as it does for a real recruit;
 * - **an existing agent** whose month is in their join date's year takes **the same month a year before their
 *   join date** — they were with the insurer before the office.
 *
 * A blank month is left blank: *Lengkapi data*'s demo (`member-page-fixture.ts`) blanks one on purpose, and runs after.
 * Run **after every placement**, since the seed's `user()` gives an earlier run's account its derived month back first.
 * **Idempotent**: a second run finds every month agreeing, and writes nothing. Only the demo's own offices are read.
 */
export async function seedNewHireMonthsFixture(deps: { kpmIds: readonly string[] }): Promise<NewHireMonthsFixture> {
  const db = mongoose.connection.db!;
  const rows = await db.collection('memberships')
    .find(
      { kpmId: { $in: [...deps.kpmIds] }, joinedAs: { $in: ['new_hire', 'existing_agent'] }, joinDate: { $type: 'string' }, userId: { $ne: null } },
      { projection: { userId: 1, joinedAs: 1, joinDate: 1 } },
    )
    .toArray();
  const accounts = await db.collection('users')
    .find(
      { _id: { $in: rows.map((r) => (mongoose.isValidObjectId(String(r.userId)) ? new mongoose.Types.ObjectId(String(r.userId)) : r.userId)) } },
      { projection: { companyJoinMonth: 1 } },
    )
    .toArray();
  const monthOf = new Map(accounts.map((a) => [String(a._id), a.companyJoinMonth as unknown]));

  let aligned = 0;
  const written = new Set<string>();
  for (const row of rows) {
    const userId = String(row.userId);
    const month = monthOf.get(userId);
    // One account, one month: the first membership read decides for somebody in two offices.
    if (written.has(userId) || typeof month !== 'string' || !MONTH.test(month)) continue;
    const joinDate = String(row.joinDate);
    const joinYear = Number(joinDate.slice(0, 4));
    const monthYear = Number(month.slice(0, 4));
    let next: string | null = null;
    if (row.joinedAs === 'new_hire' && monthYear !== joinYear) next = joinDate.slice(0, 7);
    if (row.joinedAs === 'existing_agent' && monthYear === joinYear) next = `${joinYear - 1}-${joinDate.slice(5, 7)}`;
    if (next === null) continue;
    await db.collection('users').updateOne({ _id: accounts.find((a) => String(a._id) === userId)!._id }, { $set: { companyJoinMonth: next } });
    monthOf.set(userId, next);
    written.add(userId);
    aligned += 1;
  }
  return {
    aligned,
    guide: `New hires and company join months (ADR-0264): ${aligned} account(s) aligned — every seeded new hire joined `
      + 'Prudential the month they joined the office, every existing agent a year or more before.',
  };
}
