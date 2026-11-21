import mongoose from 'mongoose';
import type { Clock } from '@/common/clock/clock.port';
import { MembershipHistory, MembershipHistorySchema } from '@/modules/org/membership-history.schema';
import { Membership, MembershipSchema } from '@/modules/org/membership.schema';
import { RosterImportRecord, RosterImportRecordSchema } from '@/modules/tenants/roster-import-record.schema';
import { User, UserSchema } from '@/modules/users/user.schema';
import { seedObjectId } from './coaching-fixture';

/**
 * **People, seeded** (P19.20; ADR-0273): what the four pages need that no other fixture leaves behind, in office 0417.
 *
 * | Signed in as | Sees |
 * |---|---|
 * | `owner@kpm0417.test` | *All members* › *Riwayat*: **Hendra Wijaya** *Pindah unit* (from SATRIA NUGRAHA to YOSEF TAMBUNAN, 35 days ago) and *Dikeluarkan* (9 days ago), beside the role changes and removals the seed already writes. *Menunggu*: Agus's move request for Dimas (`leader-change-fixture.ts`) and **Fajar Nugroho**, *Sudah daftar, belum masuk unit* (`demo.ts`). *KPM admins*: **Maya Halim** and **Satria Nugraha**, *admin sejak …, diberikan oleh WILSON TANOTO*. *Import people* › *Riwayat unggah*: **anggota_okt_2026.xlsx** — 3 baru, 1 diperbarui, by the Owner, 18 days ago |
 * | `admin@kpm0417.test` | the same, *KPM admins* read-only |
 *
 * Members with blanks (*+ Isi* in the member sheet) are `member-page-fixture.ts`'s; the test accounts `test-accounts-fixture.ts`'s.
 *
 * **Written once, until `--reset`.** Every row's `_id` is derived (`seedObjectId`) or found by what it is, so a re-run
 * writes nothing; a grant revoked in a walk stays revoked.
 */

const RECOMPILE = { overwriteModels: true } as const;
const DAY_MS = 86_400_000;

export const PEOPLE_SEED = {
  moved: {
    email: 'hendra.wijaya@kpm0417.test', fullName: 'Hendra Wijaya', agentCode: '87031',
    joinedDaysAgo: 70, movedDaysAgo: 35, removedDaysAgo: 9,
    reason: 'Pindah ke unit Yosef, lebih dekat rumah.',
  },
  admin: { fullName: 'Satria Nugraha', sinceDaysAgo: 40 },
  importRow: { fileName: 'anggota_okt_2026.xlsx', created: 3, updated: 1, daysAgo: 18 },
} as const;

interface Placed {
  id: string;
  ancestorIds: string[];
  depth: number;
}

export interface PeopleFixtureDeps {
  clock: Clock;
  kpmId: string;
  owner: Placed & { userId: string };
  /** `demo.ts`'s own account writer: an address it made before is found, and nothing is written. */
  user: (email: string, fullName: string, opts: { agentCode: string; pronoun: 'he' | 'she' }) => Promise<{ _id: unknown }>;
  /** `demo.ts`'s own placer, under the leader named, removed some days ago. */
  placeRemoved: (userId: string, leader: Placed, joinedDaysAgo: number, removedDaysAgo: number) => Promise<Placed>;
}

export interface PeopleFixture {
  written: number;
  guide: string;
}

export async function seedPeopleFixture(deps: PeopleFixtureDeps): Promise<PeopleFixture> {
  const { clock, kpmId, owner } = deps;
  const Users = mongoose.models[User.name] ?? mongoose.model(User.name, UserSchema);
  const Members = mongoose.model(Membership.name, MembershipSchema, undefined, RECOMPILE);
  const History = mongoose.model(MembershipHistory.name, MembershipHistorySchema, undefined, RECOMPILE);
  const Imports = mongoose.model(RosterImportRecord.name, RosterImportRecordSchema, undefined, RECOMPILE);
  const daysAgo = (days: number) => new Date(clock.now().getTime() - days * DAY_MS);
  let written = 0;

  /** An active member of 0417, by their name. */
  const memberNamed = async (fullName: string) => {
    const account = await Users.findOne({ fullName }).select('_id').lean<{ _id: unknown }>().exec();
    if (!account) return null;
    return Members.findOne({ kpmId, userId: String(account._id), status: 'active' }).exec();
  };
  const satria = await memberNamed(PEOPLE_SEED.admin.fullName);
  const yosef = await memberNamed('Yosef Tambunan');

  // ── Riwayat: a move and a removal, Hendra's ────────────────────────────────────────────────────────────────────
  const seed = PEOPLE_SEED.moved;
  const before = await Users.exists({ email: seed.email }).exec();
  if (!before && satria && yosef) {
    const account = await deps.user(seed.email, seed.fullName, { agentCode: seed.agentCode, pronoun: 'he' });
    const placed = await deps.placeRemoved(
      String(account._id),
      { id: String(satria._id), ancestorIds: (satria.ancestorIds ?? []).map(String), depth: satria.depth },
      seed.joinedDaysAgo,
      seed.removedDaysAgo,
    );
    // The chain as `HierarchyService.reparent` would have written it: the `joined` edge under Satria closed at the move,
    // the move open until the removal closed it. The membership names Yosef, whose unit he left.
    const movedAt = daysAgo(seed.movedDaysAgo);
    const removedAt = daysAgo(seed.removedDaysAgo);
    await History.updateOne({ kpmId, membershipId: placed.id, eventType: 'joined' }, { $set: { validTo: movedAt } }).exec();
    await History.create({
      kpmId, membershipId: placed.id, eventType: 're_parented', fromRole: 'agent', toRole: 'agent',
      fromLeaderId: String(satria._id), toLeaderId: String(yosef._id), validFrom: movedAt, validTo: removedAt,
      actorMembershipId: owner.id, actorUserId: owner.userId, reason: seed.reason,
    });
    await Members.updateOne(
      { _id: placed.id },
      { $set: { leaderId: String(yosef._id), ancestorIds: [...(yosef.ancestorIds ?? []).map(String), String(yosef._id)], depth: yosef.depth + 1 } },
    ).exec();
    written += 1;
  }

  // ── KPM admins: a second Admin ─────────────────────────────────────────────────────────────────────────────────
  if (satria && !satria.adminAccess?.isKpmAdmin
    && !(await History.exists({ kpmId, membershipId: String(satria._id), eventType: { $in: ['admin_granted', 'admin_revoked'] } }).exec())) {
    const since = daysAgo(PEOPLE_SEED.admin.sinceDaysAgo);
    await Members.updateOne({ _id: satria._id }, {
      $set: { adminAccess: { isKpmAdmin: true, grantedByUserId: owner.userId, grantedAt: since, revokedAt: null } },
    }).exec();
    await History.create({
      kpmId, membershipId: String(satria._id), eventType: 'admin_granted', validFrom: since, validTo: null,
      actorMembershipId: owner.id, actorUserId: owner.userId,
    });
    written += 1;
  }

  // ── Import people › Riwayat unggah ─────────────────────────────────────────────────────────────────────────────
  const importId = seedObjectId('people-fixture', 'import', kpmId);
  if (!(await Imports.exists({ _id: new mongoose.Types.ObjectId(importId) }).exec())) {
    const at = daysAgo(PEOPLE_SEED.importRow.daysAgo);
    await Imports.collection.insertOne({
      _id: new mongoose.Types.ObjectId(importId), kpmId, fileName: PEOPLE_SEED.importRow.fileName,
      created: PEOPLE_SEED.importRow.created, updated: PEOPLE_SEED.importRow.updated, invited: 0, skipped: 0,
      actorMembershipId: owner.id, actorUserId: owner.userId, importedAt: at, deletedAt: null,
      createdBy: owner.id, updatedBy: owner.id, createdAt: at, updatedAt: at, version: 0,
    });
    written += 1;
  }

  const guide = `
  PEOPLE in 0417  (P19.20, ADR-0273; src/seed/people-fixture.ts)
    owner@kpm0417.test  /people/members  Riwayat: ${seed.fullName} — Pindah unit (Satria → Yosef) and Dikeluarkan;
                        Menunggu: Dimas's move request, Fajar Nugroho (Sudah daftar, belum masuk unit · Pilih leader)
                        /people/admins   Maya Halim and ${PEOPLE_SEED.admin.fullName}, each with Cabut
                        /people/import   Riwayat unggah: ${PEOPLE_SEED.importRow.fileName} — ${PEOPLE_SEED.importRow.created} baru, ${PEOPLE_SEED.importRow.updated} diperbarui
    admin@kpm0417.test  the same; KPM admins read-only
`;
  return { written, guide };
}
