import mongoose from 'mongoose';
import { PasswordService } from '@/modules/auth/password.service';
import { isOwnerOf } from '@/modules/tenants/kpm-owners';

/**
 * **One account on a temporary password** (P19.30-T4 AC-1; ADR-0288 §1, §4): what the *Akun & password* PDF leaves an
 * account in, seeded so the walk can sign in with it and meet `/choose-a-password` — every other route answering `403
 * AUTH_PASSWORD_CHANGE_REQUIRED` — without downloading a PDF first.
 *
 * | Who | Password | What they see |
 * |---|---|---|
 * | the first member of 0417 who has never signed in and was never invited (on a fresh seed, the guide names them) | `TEMPORARY_DEMO_PASSWORD` (*Sementara7*) | sign in → *Buat kata sandi Anda sendiri*; choose one, and they are in |
 *
 * **A demo credential, never a real one**: the password is written here for the walk and is in `local-development.md`
 * with the demo's other logins. It is the shape a real one has (ten characters, no look-alike), but chosen, not drawn.
 *
 * **The PDF re-issues it**: 0417's Owner downloading *Akun & password* gives this person a fresh password too, and this
 * one stops working — as for anybody listed. Run the seed again to have it back.
 *
 * Run **after the sign-ins and the member page's two invitations** (`member-page-fixture.ts`): it spares the people other
 * walks read (`spare`), the owners and the Admins, and the two *Diundang* members. **Idempotent**: the same person every
 * run, put back on the demo password with no sign-in, until a walk chooses a password for them — that makes the account
 * theirs, and the next run picks the next one, leaving the first as the walk made them.
 */
export const TEMPORARY_DEMO_PASSWORD = 'Sementara7';

export interface TemporaryPasswordFixtureDeps {
  kpmId: string;
  spare: ReadonlySet<string>;
}

export interface TemporaryPasswordFixture {
  /** The account's email, or `null` when 0417 has nobody left who never signed in. */
  email: string | null;
  guide: string;
}

export async function seedTemporaryPasswordFixture(deps: TemporaryPasswordFixtureDeps): Promise<TemporaryPasswordFixture> {
  const db = mongoose.connection.db!;
  const kpm = await db.collection('kpms').findOne({ _id: new mongoose.Types.ObjectId(deps.kpmId) });
  const rows = await db.collection('memberships')
    .find(
      { kpmId: deps.kpmId, status: 'active', deletedAt: null, invitedAt: null, testAccount: { $ne: true } },
      { projection: { userId: 1, adminAccess: 1 } },
    )
    .sort({ agentSeq: 1 })
    .toArray();
  const accounts = await db.collection('users')
    .find(
      { _id: { $in: rows.map((r) => new mongoose.Types.ObjectId(String(r.userId))) }, deletedAt: null },
      { projection: { email: 1, lastLoginAt: 1, emailVerifiedAt: 1, mustChangePassword: 1 } },
    )
    .toArray();
  const byId = new Map(accounts.map((a) => [String(a._id), a]));
  const candidates = rows
    .map((row) => ({ row, account: byId.get(String(row.userId)) }))
    .filter(({ row, account }) => account
      && !deps.spare.has(String(account.email))
      && !isOwnerOf(kpm as never, String(row.userId))
      && row.adminAccess?.isKpmAdmin !== true);
  /*
   * The one an earlier run left on the demo password first — a later run's sign-ins may have stamped it (the reporting
   * fixture signs in, where none is, members a later fixture made) — else the first who never signed in with no proven
   * address. A walk that chose a password made that account its person's own, so the next run picks the next one.
   */
  const chosen = candidates.find(({ account }) => account!.mustChangePassword === true)
    ?? candidates.find(({ account }) => !account!.lastLoginAt && !account!.emailVerifiedAt);
  if (!chosen?.account) {
    return { email: null, guide: 'A temporary password (P19.30-T4): nobody in 0417 is left who never signed in.' };
  }
  await db.collection('users').updateOne(
    { _id: chosen.account._id },
    // As the PDF leaves an account nobody has signed in to yet: the demo password, the gate, no sign-in, no proven address.
    {
      $set: {
        passwordHash: await new PasswordService().hash(TEMPORARY_DEMO_PASSWORD), mustChangePassword: true,
        lastLoginAt: null, emailVerifiedAt: null,
      },
    },
  );
  const email = String(chosen.account.email);
  return {
    email,
    guide: `A temporary password (P19.30-T4; ADR-0288): ${email} · ${TEMPORARY_DEMO_PASSWORD} signs in to `
      + 'Buat kata sandi Anda sendiri (/choose-a-password) and nothing else, until they choose their own. 0417’s Owner’s Akun & password PDF lists them '
      + '(and gives them a fresh password, so this one then stops working).',
  };
}
