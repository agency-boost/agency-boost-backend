import mongoose from 'mongoose';
import type { Clock } from '@/common/clock/clock.port';
import { Kpm, KpmSchema } from '@/modules/tenants/kpm.schema';
import { firstOwnerOf, isOwnerOf, ownerEntry } from '@/modules/tenants/kpm-owners';
import { SUBSCRIPTION_FIXTURE_PEOPLE, SUBSCRIPTION_OFFICES } from './subscription-fixture';

/**
 * **A KPM with two owners, one of them invited** (P19.27-T6 AC-1; [ADR-0285](../../../docs/04-adr/0285-a-kpm-has-one-or-more-owners.md);
 * F-2 (21 Nov), the stop motion's section C — whose example data this KPM is), so *KPM Owner · n*, *Tambah owner* and
 * *Hapus sebagai owner* can be walked from the Super Admin's KPM page and from an owner's People › KPM admins.
 *
 * | Who | In **0602 Bekasi Barat Branch** (Prudential; `subscription-fixture.ts`) |
 * |---|---|
 * | **YOHANES SAPUTRA** (`owner@kpm0602.test`), AB | the first owner, as the subscription fixture made him |
 * | **SINTA MAHARANI** (`aab@kpm0602.test`), AAB | **the second owner**, since today, added by Yohanes; **invited** (*Diundang*): invited today and never signed in, so her ⋯ offers *Kirim ulang undangan* |
 * | **JOKO PRASETYO** (`agent@kpm0602.test`), agent | a member, not an owner: the one *Tambah owner* lists |
 *
 * **Written once, until `--reset`**: Sinta is added, invited and her sign-in cleared only while she is not an owner — a
 * later run writes nothing. Run after `subscription-fixture.ts`, which makes the KPM and its people, and after the
 * reporting fixture's sign-ins. The KPM's first owner, and so its *ownerState*, its issues and every member count, are
 * unchanged; *Belum pernah masuk* counts one more 0602 account.
 */
export const KPM_OWNERS_SEED = {
  code: '0602',
  second: SUBSCRIPTION_FIXTURE_PEOPLE.aab0602,
} as const;

export interface KpmOwnersFixture {
  kpmId: string | null;
  guide: string;
}

export async function seedKpmOwnersFixture(deps: { clock: Clock }): Promise<KpmOwnersFixture> {
  const Kpms = mongoose.models[Kpm.name] ?? mongoose.model(Kpm.name, KpmSchema);
  const db = mongoose.connection.db!;
  const kpmId = String(SUBSCRIPTION_OFFICES['0602']._id);
  const kpm = await Kpms.findOne({ _id: kpmId, deletedAt: null }).lean().exec() as { owners?: never[] } | null;
  const sinta = await db.collection('users').findOne({ email: KPM_OWNERS_SEED.second.email, deletedAt: null }, { projection: { lastLoginAt: 1 } });
  const first = firstOwnerOf(kpm);
  if (!kpm || !sinta || !first) return { kpmId: null, guide: 'Several owners (P19.27): KPM 0602 or Sinta not found; nothing written.' };

  const now = deps.clock.now();
  const sintaId = String(sinta._id);
  if (!isOwnerOf(kpm, sintaId)) {
    await Kpms.updateOne(
      { _id: kpmId, 'owners.userId': { $ne: sintaId } },
      { $push: { owners: ownerEntry(sintaId, now, first.userId) } },
    ).exec();
    /*
     * *Diundang*: invited today and never signed in. The run that makes her an owner is the one that says so — the
     * reporting fixture's sign-ins reach every 0602 account first — and a later run never writes over a sign-in.
     */
    // Not hers yet (OD-475): no sign-in, and no address proven — what an owner named for somebody carries.
    await db.collection('users').updateOne({ _id: sinta._id }, { $set: { lastLoginAt: null, emailVerifiedAt: null } });
    await db.collection('memberships').updateOne(
      { kpmId, userId: sintaId, status: 'active', deletedAt: null },
      { $set: { invitedAt: now } },
    );
  }

  return {
    kpmId,
    guide: `Several owners (P19.27, ADR-0285): KPM 0602 Bekasi Barat has two owners — owner@kpm0602.test and `
      + `${KPM_OWNERS_SEED.second.email} (invited today, never signed in: Kirim ulang undangan) — and agent@kpm0602.test, a `
      + 'member Tambah owner lists. Hapus sebagai owner on either works; on the last one it is greyed out.',
  };
}
