import { createHash, randomBytes } from 'node:crypto';
import mongoose from 'mongoose';
import type { Clock } from '@/common/clock/clock.port';
import { INVITES } from '@/domain/constants';
import { UserInvitation, UserInvitationSchema } from '@/modules/org/user-invitation.schema';
import { seedObjectId } from './coaching-fixture';

const RECOMPILE = { overwriteModels: true } as const;
const DAY_MS = 86_400_000;

/**
 * ***Tambah user* and *Masukkan*, seeded** (P19.28-T5 AC-1; ADR-0286): what Anggota's three chips show on the demo, so
 * the sheet, the pills and their actions can be reviewed in a browser.
 *
 * - ***Diundang*** — one invitation of *Tambah user*, written here: **Wulan Permata**, an Agent under Sari Puspita in KPM
 *   0417 (BSD City Branch), sent two days ago and not accepted. Nobody holds its link — only a hash is kept — so the demo
 *   resends it (⋯ *Kirim ulang*) to get one.
 * - ***Belum ada KPM*** — **Fajar Nugroho** (`untagged@kpm0417.test`), registered to 0417 and placed by nobody: `demo.ts`
 *   has seeded him since Phase 3. *Masukkan* prefills BSD City Branch (OD-441).
 * - ***Keluar*** — Gilang Saputra (`reporting-fixture.ts`), Tari Wulandari (`activation-3m-fixture.ts`) and Hendra
 *   Wijaya (`people-fixture.ts`), each a membership that ended, already seeded.
 *
 * Idempotent: the invitation has a fixed `_id`, and a row already there is left as it is.
 */
export const TAMBAH_USER_SEED = {
  invited: { fullName: 'Wulan Permata', phone: '+6281388004410', invitedDaysAgo: 2 },
  unplaced: { fullName: 'Fajar Nugroho', email: 'untagged@kpm0417.test' },
  left: ['Gilang Saputra', 'Tari Wulandari', 'Hendra Wijaya'],
} as const;

export interface TambahUserFixtureDeps {
  clock: Clock;
  /** KPM 0417. */
  kpmId: string;
  /** Sari Puspita's membership: the AAB the invitation names as the leader. */
  leaderMembershipId: string;
  /** Who sent it: the Owner of 0417. */
  invitedByUserId: string;
  invitedByMembershipId: string;
}

export async function seedTambahUserFixture(deps: TambahUserFixtureDeps): Promise<{ written: number; guide: string }> {
  const Invitations = mongoose.model(UserInvitation.name, UserInvitationSchema, undefined, RECOMPILE);
  const id = new mongoose.Types.ObjectId(seedObjectId('tambah-user-fixture', 'invited', deps.kpmId));
  let written = 0;
  if (!(await Invitations.exists({ _id: id }).exec())) {
    const seed = TAMBAH_USER_SEED.invited;
    const invitedAt = new Date(deps.clock.now().getTime() - seed.invitedDaysAgo * DAY_MS);
    await Invitations.create({
      _id: id,
      kpmId: deps.kpmId,
      fullName: seed.fullName,
      phone: seed.phone,
      email: null,
      userId: null,
      orgLevelCode: 'AGENT',
      roleClass: 'agent',
      leaderMembershipId: deps.leaderMembershipId,
      makeOwner: false,
      newKpm: false,
      invitedByUserId: deps.invitedByUserId,
      invitedByMembershipId: deps.invitedByMembershipId,
      // A link nobody holds: the hash of a secret dropped at once. *Kirim ulang* makes one to share.
      tokenHash: createHash('sha256').update(`${deps.kpmId}.${randomBytes(24).toString('base64url')}`).digest('hex'),
      status: 'pending',
      invitedAt,
      expiresAt: new Date(invitedAt.getTime() + INVITES.EXPIRY_DAYS * DAY_MS),
      deletedAt: null,
      createdBy: deps.invitedByMembershipId,
      updatedBy: deps.invitedByMembershipId,
    });
    written += 1;
  }
  const guide = [
    `Tambah user (${written} written) — Anggota's chips, as the Super Admin (/admin/members):`,
    `    Menunggu: ${TAMBAH_USER_SEED.invited.fullName} — Diundang · ${TAMBAH_USER_SEED.invited.invitedDaysAgo} days ago, `
      + 'BSD City Branch, ⋯ Kirim ulang · Batalkan;',
    `              ${TAMBAH_USER_SEED.unplaced.fullName} (${TAMBAH_USER_SEED.unplaced.email}) — Belum ada KPM, `
      + 'Masukkan (BSD City Branch prefilled; or ＋ KPM baru);',
    `    Keluar: ${TAMBAH_USER_SEED.left.join(', ')}.`,
    '    ＋ Tambah user floats over the list; a KPM page\'s Anggota card and All members\' Undang anggota open it too.',
  ].join('\n');
  return { written, guide };
}
