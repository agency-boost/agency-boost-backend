import mongoose from 'mongoose';
import type { Clock } from '@/common/clock/clock.port';
import { User, UserSchema } from '@/modules/users/user.schema';

/**
 * **Registered, and in no KPM yet — seeded** (P19.12-T2 AC-1, AC-2; ADR-0245 §1; the client's message of 11 November
 * 2026, item 2): the two accounts the client's test made, that *All members* could not find and *Akun terdaftar* lists.
 *
 * | Signed in as | Sees |
 * |---|---|
 * | the Super Admin | *All members* › *Akun terdaftar* › *Tanpa KPM*: **Citra Lestari** (*Belum diverifikasi*, registered and signed in today) and **Hadi Santoso** (*Terverifikasi*, registered two days ago, last signed in yesterday), each *Belum punya KPM* — found by `hadi.leader@` or by *Hadi*; the *Anggota KPM* tab finds neither |
 * | `hadi.leader@agencyboost.test` | `/user-management/kpm`: a leader who registered and has not joined a KPM, no banner |
 * | `citra.baru@agencyboost.test` | the same, under the muted *Email Anda belum diverifikasi · Kirim ulang tautan* line (AC-4) |
 *
 * Beside them the seed's older accounts in no office — Nadia Safitri, Yoga Pratama (unverified) and Rudi Hartono, whose
 * KPM request waits — so the filter reads more than the client's two.
 *
 * **Written once, until `--reset`.** Each is made through `demo.ts`'s own account writer, which finds an address it made
 * before and writes nothing; its registration and sign-in days are set only when it is made, so a sign-in in a walk is
 * kept. Each brings its own agent code, so the codes the seed counts for everybody else do not move.
 */

/** The two accounts, as the guide and the seed's spec name them. */
export const REGISTERED_ACCOUNTS_SEED = {
  /** The client's case (PZ-2): a leader who registered, verified, signed in, and joined no KPM. */
  leader: {
    email: 'hadi.leader@agencyboost.test', fullName: 'Hadi Santoso', pronoun: 'he', agentCode: '81921',
    registeredDaysAgo: 2, signedInDaysAgo: 1, unverified: false,
  },
  /** PZ-6: registered today and signed in by registering, the verification email not opened. */
  unverified: {
    email: 'citra.baru@agencyboost.test', fullName: 'Citra Lestari', pronoun: 'she', agentCode: '81922',
    registeredDaysAgo: 0, signedInDaysAgo: 0, unverified: true,
  },
} as const;

export interface RegisteredAccountsFixtureDeps {
  clock: Clock;
  /** `demo.ts`'s own account writer: an address it made before is found, and nothing is written. */
  user: (
    email: string,
    fullName: string,
    opts: { pronoun: 'he' | 'she'; agentCode: string; unverified: boolean },
  ) => Promise<{ _id: unknown }>;
}

export interface RegisteredAccountsFixture {
  /** Accounts this run made: two on a fresh seed, none on a re-run. */
  written: number;
}

const DAY_MS = 86_400_000;

export async function seedRegisteredAccountsFixture(deps: RegisteredAccountsFixtureDeps): Promise<RegisteredAccountsFixture> {
  const Users = mongoose.models[User.name] ?? mongoose.model(User.name, UserSchema);
  const now = deps.clock.now();
  const daysAgo = (n: number) => new Date(now.getTime() - n * DAY_MS - 60 * 60 * 1000);
  let written = 0;

  for (const seed of Object.values(REGISTERED_ACCOUNTS_SEED)) {
    const before = await Users.exists({ email: seed.email }).exec();
    const account = await deps.user(seed.email, seed.fullName, {
      pronoun: seed.pronoun, agentCode: seed.agentCode, unverified: seed.unverified,
    });
    if (before) continue;
    // Through the driver: `createdAt` is the schema's own stamp, and Mongoose leaves it alone on an update.
    await Users.collection.updateOne({ _id: account._id as mongoose.Types.ObjectId }, {
      $set: { createdAt: daysAgo(seed.registeredDaysAgo), lastLoginAt: daysAgo(seed.signedInDaysAgo) },
    });
    written += 1;
  }
  return { written };
}
