import mongoose from 'mongoose';
import { User, UserSchema } from '@/modules/users/user.schema';
import { up as testAccounts } from '@/migrations/0065-test-accounts';

/**
 * **Two test accounts in 0417, never shown or counted** (P19.17-T1 AC-1; ADR-0267 §1; `revisions/2026-11-19/
 * DATA-DEFINITIONS.md`, *Who is counted*: staging showed 42 members where 30 are real).
 *
 * The two kinds of row the client named — an *FMT …* account and a *TES IMPOR …* one — placed as agents under Agus, as
 * a real person would be, and then **flagged by migration `0065`'s own rule**, by their names: each account is made
 * without a value for `testAccount` (as every account written before the field), so `0065` decides it and copies the flag
 * onto its membership — a fresh seed and a migrated database say the same thing.
 *
 * | Signed in as | Sees |
 * |---|---|
 * | `agus@kpm0417.test` | the Unit Dashboard, the coaching roster and New Hires list neither — `CoachResolver` leaves test accounts out |
 * | `owner@kpm0417.test` | KPM Overview's and KPM Analytics' head counts leave both out — `OfficePeople` reads no test account |
 *
 * **Written once, until `--reset`.** The accounts go through `demo.ts`'s own writer, which finds an address it made
 * before, and its placement finds a membership it made before; a second run writes nothing. Each brings its own agent
 * code, so the codes the seed counts for everybody else do not move.
 */
export const TEST_ACCOUNTS_SEED = {
  fmt: { email: 'fmt.ujicoba@kpm0417.test', fullName: 'FMT Uji Coba', agentCode: '81931', pronoun: 'he' },
  imported: { email: 'tes.impor@kpm0417.test', fullName: 'TES IMPOR Satu', agentCode: '81932', pronoun: 'she' },
} as const;

export interface TestAccountsFixtureDeps {
  /** `demo.ts`'s own account writer: an address it made before is found, and nothing is written. */
  user: (email: string, fullName: string, opts: { agentCode: string; pronoun: 'he' | 'she' }) => Promise<{ _id: unknown }>;
  /** Places an account as an agent under Agus in 0417, as `demo.ts` places anybody; a membership made before is found. */
  place: (userId: string) => Promise<{ id: string }>;
}

export interface TestAccountsFixture {
  /** The two memberships, flagged. */
  membershipIds: string[];
  /** Accounts this run made: two on a fresh seed, none on a re-run. */
  written: number;
  guide: string;
}

export async function seedTestAccountsFixture(deps: TestAccountsFixtureDeps): Promise<TestAccountsFixture> {
  const Users = mongoose.models[User.name] ?? mongoose.model(User.name, UserSchema);
  const membershipIds: string[] = [];
  let written = 0;

  for (const seed of Object.values(TEST_ACCOUNTS_SEED)) {
    const before = await Users.exists({ email: seed.email }).exec();
    const account = await deps.user(seed.email, seed.fullName, { agentCode: seed.agentCode, pronoun: seed.pronoun });
    if (!before) {
      // As an account written before the flag: no value, so `0065` decides it by its name. Through the driver: the
      // schema's default would write `false`.
      await Users.collection.updateOne({ _id: account._id as mongoose.Types.ObjectId }, { $unset: { testAccount: '' } });
      written += 1;
    }
    membershipIds.push((await deps.place(String(account._id))).id);
  }
  await testAccounts(mongoose.connection.db!);

  const guide = `
  TEST ACCOUNTS in 0417  (P19.17-T1, ADR-0267 §1; src/seed/test-accounts-fixture.ts)
    ${TEST_ACCOUNTS_SEED.fmt.fullName}, ${TEST_ACCOUNTS_SEED.imported.fullName}: agents under Agus, flagged by
    migration 0065 (users.testAccount, copied onto memberships.testAccount) — never listed or counted:
    agus@kpm0417.test    Unit Dashboard, coaching roster, New Hires: neither appears
    owner@kpm0417.test   KPM Overview's head count leaves both out
`;
  return { membershipIds, written, guide };
}
