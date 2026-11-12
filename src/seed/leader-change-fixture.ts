import mongoose from 'mongoose';
import type { Clock } from '@/common/clock/clock.port';
import { NotificationTemplate } from '@/modules/notifications/notification.types';
import { TransferRequest, TransferRequestSchema } from '@/modules/org/transfer-request.schema';
import { seedObjectId } from './coaching-fixture';

/**
 * **Changing who somebody reports to, seeded** (P19.12-T4; ADR-0247; the client's message of 11 November 2026, items 4
 * and 8; `functional/org-hierarchy.md`, *Changing a leader*): what no other fixture leaves behind — a leader's move to a
 * leader **outside their tree**, waiting on the office. One row in office 0417; nobody moves, and no count changes.
 *
 * | Signed in as | Sees |
 * |---|---|
 * | `agus@kpm0417.test` (AB) | `/user-management/add` › *Tim Anda*: **Dimas Pratama**, *Menunggu persetujuan pemindahan ke Yosef Tambunan* with *Batalkan*. **Sari Puspita** (AAB): *Agent · AAB · AB*, AAB checked — an AB leader sets AB on a direct report (AB under AB). *Pindahkan ke leader lain* on anybody's sheet: *Di tim Anda* (Sari, Dewi, Arief) moves at once; *Leader lain · perlu persetujuan Owner/Admin* (Maya Halim, Wilson, Yosef, Satria) asks |
 * | `owner@kpm0417.test`, `admin@kpm0417.test` | *All Members* › *Pending* › *Permintaan pemindahan*: **"Agus Prasetyo meminta memindahkan Dimas Pratama ke unit Yosef Tambunan"**, with Agus's note, beside Raka's *+ Add agent* request (`joining-fixture.ts`); the bell's notice of it. *Tim Anda* as the Owner: **Maya Halim**, an AB, with *AB* checked among *Agent · AAB · AB* — the client's item 4. *Ganti* on *Melapor ke* on any member's page |
 * | `sari@kpm0417.test` (AAB) | *Tim Anda*: *Agent · AAB* for Rina and Budi — nothing above her own rung |
 *
 * **Written once, until `--reset`.** The row's `_id` is derived (`seedObjectId`), so a re-run finds it and writes nothing;
 * a request somebody approved, declined or cancelled in a walk is left as they left it.
 */

const RECOMPILE = { overwriteModels: true } as const;
const DAY_MS = 86_400_000;

/** The waiting move, as the guide and the seed's spec name it. */
export const LEADER_CHANGE_SEED = {
  move: {
    /** As Agus typed it in the picker. */
    note: 'Dimas tinggal dekat kantor Pak Yosef dan ingin dibina di sana.',
    requestedDaysAgo: 2,
  },
} as const;

export const leaderChangeRowId = (kpmId: string) => seedObjectId('leader-change-fixture', 'move', kpmId);

export interface LeaderChangeFixtureDeps {
  clock: Clock;
  kpmId: string;
  /** Agus, the AB who asks. */
  agus: { membershipId: string; fullName: string };
  /** Dimas, one of Agus's direct agents (`coaching-cast.ts`). */
  dimas: { membershipId: string; fullName: string };
  /** Yosef, an AB under the Owner, outside Agus's tree (`reporting-fixture.ts`). */
  yosef: { membershipId: string; fullName: string };
  /** The office's deciders, told as `TransfersService.requestMove` tells them. */
  deciders: { userId: string; membershipId: string }[];
  /** `demo.ts`'s own notice writer: keyed on what the notice says, so a re-run writes none. */
  notify: (
    to: { userId: string; membershipId: string | null },
    templateId: string,
    payload: Record<string, unknown>,
    opts: { sentDaysAgo: number },
  ) => Promise<void>;
}

export interface LeaderChangeFixture {
  /** Rows this run wrote: one on a fresh seed, none on a re-run. */
  written: number;
  guide: string;
}

export async function seedLeaderChangeFixture(deps: LeaderChangeFixtureDeps): Promise<LeaderChangeFixture> {
  const { clock, kpmId, agus, dimas, yosef } = deps;
  const Transfers = mongoose.model(TransferRequest.name, TransferRequestSchema, undefined, RECOMPILE);
  const at = new Date(clock.now().getTime() - LEADER_CHANGE_SEED.move.requestedDaysAgo * DAY_MS);
  const transferId = leaderChangeRowId(kpmId);
  let written = 0;

  // One waiting per member: a walk that already asked for Dimas keeps its own request, and this writes none.
  const waiting = await Transfers.exists({ kpmId, membershipId: dimas.membershipId, status: 'pending', deletedAt: null }).exec();
  if (!waiting && !(await Transfers.exists({ _id: new mongoose.Types.ObjectId(transferId) }).exec())) {
    await Transfers.collection.insertOne({
      _id: new mongoose.Types.ObjectId(transferId), kpmId, kind: 'move',
      membershipId: dimas.membershipId, fromLeaderId: agus.membershipId, toLeaderId: yosef.membershipId,
      requestedByMembershipId: agus.membershipId, requestedName: null, note: LEADER_CHANGE_SEED.move.note,
      status: 'pending', decidedAt: null, decidedByMembershipId: null,
      reason: null, deletedAt: null, createdBy: agus.membershipId, updatedBy: agus.membershipId,
      createdAt: at, updatedAt: at, version: 0,
    });
    written += 1;
  }
  for (const decider of deps.deciders) {
    await deps.notify(decider, NotificationTemplate.TRANSFER_REQUEST_RECEIVED, {
      transferId, kind: 'move', requesterName: agus.fullName, memberName: dimas.fullName, toLeaderName: yosef.fullName,
    }, { sentDaysAgo: LEADER_CHANGE_SEED.move.requestedDaysAgo });
  }

  const guide = `
  CHANGING A LEADER  (P19.12-T4; src/seed/leader-change-fixture.ts)
    agus@kpm0417.test            /user-management/add › Tim Anda: ${dimas.fullName} "Menunggu persetujuan pemindahan
                                 ke ${yosef.fullName}" with Batalkan; Sari's role sheet offers Agent · AAB · AB;
                                 Pindahkan ke leader lain: own tree at once, ABs elsewhere by request
    owner@kpm0417.test           /people/members?tab=pending › Permintaan pemindahan: "${agus.fullName} meminta
    admin@kpm0417.test           memindahkan ${dimas.fullName} ke unit ${yosef.fullName}", with his note;
                                 Tim Anda as the Owner: Maya Halim (AB) with AB checked; Ganti on Melapor ke
    sari@kpm0417.test            Tim Anda: Agent · AAB only — nothing above her own rung
`;
  return { written, guide };
}
