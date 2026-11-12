import mongoose from 'mongoose';
import type { Clock } from '@/common/clock/clock.port';

/**
 * **The member page's *Diundang* and *Lengkapi data*, seeded** (P19.12-T5; ADR-0248 §3, §4; the client's TI-1, TI-2):
 * the two things the client met on members they had just imported, which a fresh seed otherwise never shows — everybody
 * the seed places records the four (`personal-fixture.ts`), and nobody was ever invited.
 *
 * Run **after the sign-ins** (`reporting-fixture.ts`: in 0417 every seventh member, by agent sequence, has never signed
 * in). Of those, the first two who are not in `spare` — the coaching cast, the Owner and the Admin, whose pages other
 * walks read — are the ones touched:
 *
 * | Who | What the Owner sees |
 * |---|---|
 * | the first | ***Diundang*** on the Directory row and the member page: an invitation went 3 days ago (`invitedAt`), no sign-in yet. **Their birth date, gender, company join month and work status are blank** — *Data pribadi* reads *4 belum dicatat*, and *Lengkapi data* opens on those four |
 * | the second | ***Diundang***: invited yesterday, everything recorded |
 *
 * Everybody else who never signed in reads ***Belum diundang***; everybody who has, *Aktif*.
 *
 * **Idempotent, and the same people every run**: the sign-ins it reads are written only where none is, `invitedAt` only
 * where none is, and the blanking is the same four fields on the same person — the seed's `user()` and `place()` give an
 * earlier run's account its four back first, and this takes them away again. A walk that signs in as the first stops
 * them being chosen on the next run, which then picks the next one and leaves the first as the walk made them.
 */
export interface MemberPageFixtureDeps {
  clock: Clock;
  kpmId: string;
  /** Emails never touched: the people other fixtures and walks read. */
  spare: ReadonlySet<string>;
}

export interface MemberPageFixture {
  /** The two invited, by email: the first is the one whose data is blank. */
  invited: string[];
  /** The member whose four are blank, by email — `null` when the office has nobody who never signed in. */
  blank: string | null;
  guide: string;
}

const DAY_MS = 86_400_000;

export async function seedMemberPageFixture(deps: MemberPageFixtureDeps): Promise<MemberPageFixture> {
  const db = mongoose.connection.db!;
  const now = deps.clock.now();
  const kpm = await db.collection('kpms').findOne({ _id: new mongoose.Types.ObjectId(deps.kpmId) });
  const rows = await db.collection('memberships')
    .find({ kpmId: deps.kpmId, status: 'active', deletedAt: null }, { projection: { userId: 1, adminAccess: 1, invitedAt: 1 } })
    .sort({ agentSeq: 1 })
    .toArray();
  const accounts = await db.collection('users')
    .find({ _id: { $in: rows.map((r) => new mongoose.Types.ObjectId(String(r.userId))) } }, { projection: { email: 1, lastLoginAt: 1 } })
    .toArray();
  const byId = new Map(accounts.map((a) => [String(a._id), a]));

  const chosen = rows
    .map((row) => ({ row, account: byId.get(String(row.userId)) }))
    .filter(({ row, account }) => account && !account.lastLoginAt
      && !deps.spare.has(String(account.email))
      && String(row.userId) !== String(kpm?.ownerUserId ?? '')
      && row.adminAccess?.isKpmAdmin !== true)
    .slice(0, 2);

  for (const [i, { row }] of chosen.entries()) {
    await db.collection('memberships').updateOne(
      { _id: row._id, invitedAt: null },
      { $set: { invitedAt: new Date(now.getTime() - (i === 0 ? 3 : 1) * DAY_MS) } },
    );
  }
  const first = chosen[0];
  if (first) {
    await db.collection('users').updateOne(
      { _id: first.account!._id },
      { $set: { dateOfBirth: null, gender: null, companyJoinMonth: null } },
    );
    await db.collection('memberships').updateOne({ _id: first.row._id }, { $set: { workStatus: null } });
  }

  const invited = chosen.map(({ account }) => String(account!.email));
  const blank = invited[0] ?? null;
  return {
    invited,
    blank,
    guide: blank
      ? `The member page (P19.12-T5): ${invited.join(' and ')} read Diundang — invited, never signed in; ${blank}'s `
        + 'birth date, gender, company join month and work status are blank, so Data pribadi offers Lengkapi data. '
        + 'Everybody else in 0417 who never signed in reads Belum diundang. Sign in as owner@kpm0417.test → People.'
      : 'The member page (P19.12-T5): nobody in 0417 is left who never signed in, so nobody reads Diundang.',
  };
}
