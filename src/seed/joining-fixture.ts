import { createHash } from 'node:crypto';
import mongoose from 'mongoose';
import type { Clock } from '@/common/clock/clock.port';
import { DEFAULT_TENANT_TIMEZONE, INVITES } from '@/domain/constants';
import { MemberInvite, MemberInviteSchema } from '@/modules/org/member-invite.schema';
import { inviteTokenHash } from '@/modules/org/invites.service';
import { TransferRequest, TransferRequestSchema } from '@/modules/org/transfer-request.schema';
import { NotificationTemplate } from '@/modules/notifications/notification.types';
import { seedObjectId } from './coaching-fixture';

/**
 * **Adding an agent, seeded** (P18.96-T3; ADR-0170; `functional/org-hierarchy.md`, *Adding an agent*): what *+ Add
 * agent* leaves behind that no other fixture does, in office 0417.
 *
 * | Signed in as | Sees |
 * |---|---|
 * | `agus@kpm0417.test` (AB) | `/new-hires` › *Waiting to join*: **Yusuf Hidayat**, *Invited, waiting to join* (code 80777, joined today), with *Resend* and *Cancel invite*; and **Raka Aditama**, *Transfer requested* — the name Agus typed, and *The office decides*: nothing of Satria Nugraha's unit, where Raka still is. Not Rudi Hartono: his invite was cancelled |
 * | `owner@kpm0417.test`, `admin@kpm0417.test` | *All Members* › *Pending* › *Transfer requests*: Agus asking for Raka, from Satria Nugraha's unit, with *Approve* and *Decline*; the bell's notice of it |
 * | a new person opening the printed link | `/register?invite=…`: *"You're joining Agus Prasetyo's team · KPM 0417"*, code 80777 and today's join date read-only |
 *
 * **Putri Anggraini and Fajar Nugroho stay leaderless** — Putri with her request to Sari, Fajar in the untagged pool —
 * so *+ Add agent* with either one's agent code shows the *linked* outcome in a walk (`demo.ts` places them).
 *
 * **Written once, until `--reset`.** Every row's `_id` is derived (`seedObjectId`), and so is the pending invite's
 * token — which the product never keeps, only its hash — so the guide can print a link that opens it. A re-run finds
 * every row and writes nothing; a row somebody accepted, resent or cancelled in a walk is left as they left it.
 */

const RECOMPILE = { overwriteModels: true } as const;
const DAY_MS = 86_400_000;

/** The two invites and the transfer, as the guide and the seed's spec name them. */
export const JOINING_SEED = {
  invite: { fullName: 'Yusuf Hidayat', agentCode: '80777', phone: '0812-8077-7001' },
  cancelled: { fullName: 'Rudi Hartono', agentCode: '80778', phone: '0812-8077-8002', invitedDaysAgo: 6, cancelledDaysAgo: 2 },
  /** Raka Aditama, an Agent in Satria Nugraha's agency (`reporting-fixture.ts`), asked for by Agus yesterday. */
  transfer: { requestedDaysAgo: 1 },
} as const;

/** The pending invite's token: `{kpmId}.{secret}`, the secret derived so a re-run prints the same link. */
export function joiningInviteToken(kpmId: string): string {
  const secret = createHash('sha256').update(['joining-fixture', 'invite-token', kpmId].join('|')).digest('base64url');
  return `${kpmId}.${secret}`;
}

export const joiningRowId = (kpmId: string, row: 'invite' | 'cancelled' | 'transfer') => seedObjectId('joining-fixture', row, kpmId);

export interface JoiningFixtureDeps {
  clock: Clock;
  kpmId: string;
  companyId: string;
  agus: { membershipId: string };
  raka: { membershipId: string };
  satria: { membershipId: string };
  /** The office's deciders, told of the transfer as `TransfersService.request` tells them. */
  deciders: { userId: string; membershipId: string }[];
  /** `demo.ts`'s own notice writer: keyed on what the notice says, so a re-run writes none. */
  notify: (
    to: { userId: string; membershipId: string | null },
    templateId: string,
    payload: Record<string, unknown>,
    opts: { sentDaysAgo: number },
  ) => Promise<void>;
}

export interface JoiningFixture {
  /** Rows this run wrote: three on a fresh seed, none on a re-run. */
  written: number;
  /** Where the pending invite's link points, from the app's root. */
  invitePath: string;
}

export async function seedJoiningFixture(deps: JoiningFixtureDeps): Promise<JoiningFixture> {
  const { clock, kpmId, companyId } = deps;
  const Invites = mongoose.model(MemberInvite.name, MemberInviteSchema, undefined, RECOMPILE);
  const Transfers = mongoose.model(TransferRequest.name, TransferRequestSchema, undefined, RECOMPILE);
  const now = clock.now();
  const today = clock.localDateFor(DEFAULT_TENANT_TIMEZONE, now);
  const daysAgo = (n: number) => new Date(now.getTime() - n * DAY_MS);
  let written = 0;

  const base = {
    kpmId, companyId, leaderMembershipId: deps.agus.membershipId, invitedByMembershipId: deps.agus.membershipId,
    existingAccount: false, resentAt: null, acceptedMembershipId: null, acceptedAt: null, deletedAt: null,
    createdBy: deps.agus.membershipId, updatedBy: deps.agus.membershipId,
  };

  // ---- Yusuf: invited today, waiting to join.
  const token = joiningInviteToken(kpmId);
  const inviteId = joiningRowId(kpmId, 'invite');
  if (!(await Invites.exists({ _id: new mongoose.Types.ObjectId(inviteId) }).exec())) {
    await Invites.collection.insertOne({
      _id: new mongoose.Types.ObjectId(inviteId), ...base, ...JOINING_SEED.invite,
      joinDate: today, tokenHash: inviteTokenHash(token), status: 'pending',
      expiresAt: new Date(now.getTime() + INVITES.EXPIRY_DAYS * DAY_MS),
      cancelledAt: null, cancelledByMembershipId: null, createdAt: now, updatedAt: now, version: 0,
    });
    written += 1;
  }

  // ---- Rudi: invited six days ago and cancelled two days ago, so he is in no list and no count.
  const cancelledId = joiningRowId(kpmId, 'cancelled');
  if (!(await Invites.exists({ _id: new mongoose.Types.ObjectId(cancelledId) }).exec())) {
    const { invitedDaysAgo, cancelledDaysAgo, ...fields } = JOINING_SEED.cancelled;
    const invitedAt = daysAgo(invitedDaysAgo);
    await Invites.collection.insertOne({
      _id: new mongoose.Types.ObjectId(cancelledId), ...base, ...fields,
      joinDate: clock.localDateFor(DEFAULT_TENANT_TIMEZONE, invitedAt),
      tokenHash: inviteTokenHash(`${kpmId}.${seedObjectId('joining-fixture', 'cancelled-token', kpmId)}`),
      status: 'cancelled', expiresAt: new Date(invitedAt.getTime() + INVITES.EXPIRY_DAYS * DAY_MS),
      cancelledAt: daysAgo(cancelledDaysAgo), cancelledByMembershipId: deps.agus.membershipId,
      createdAt: invitedAt, updatedAt: daysAgo(cancelledDaysAgo), version: 0,
    });
    written += 1;
  }

  // ---- Raka: Agus asked for him yesterday; he reports to Satria until the Owner or an Admin decides.
  const transferId = joiningRowId(kpmId, 'transfer');
  if (!(await Transfers.exists({ _id: new mongoose.Types.ObjectId(transferId) }).exec())) {
    const at = daysAgo(JOINING_SEED.transfer.requestedDaysAgo);
    await Transfers.collection.insertOne({
      _id: new mongoose.Types.ObjectId(transferId), kpmId,
      membershipId: deps.raka.membershipId, fromLeaderId: deps.satria.membershipId, toLeaderId: deps.agus.membershipId,
      requestedByMembershipId: deps.agus.membershipId,
      // The name Agus typed in *+ Add agent* — all he is shown of the person (the P18.96 exit review, M3).
      requestedName: 'Raka Aditama',
      status: 'pending', decidedAt: null, decidedByMembershipId: null,
      reason: null, deletedAt: null, createdBy: deps.agus.membershipId, updatedBy: deps.agus.membershipId,
      createdAt: at, updatedAt: at, version: 0,
    });
    written += 1;
  }
  for (const decider of deps.deciders) {
    await deps.notify(decider, NotificationTemplate.TRANSFER_REQUEST_RECEIVED, {
      transferId, requesterName: 'Agus Prasetyo', memberName: 'Raka Aditama',
    }, { sentDaysAgo: JOINING_SEED.transfer.requestedDaysAgo });
  }

  return { written, invitePath: `/register?invite=${encodeURIComponent(token)}` };
}
