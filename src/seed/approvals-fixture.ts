import mongoose from 'mongoose';

/**
 * ***Persetujuan*'s decided rows, of both kinds** (P19.23-T3 AC-2; ADR-0277; the Super Admin spec §8 *"Sudah diputuskan:
 * result (Disetujui / Ditolak), who decided and when"*).
 *
 * The rest of the queue is seeded where it always was: three KPM requests waiting, one approved and one declined
 * (`demo.ts`), and 0603's leaders past its limit — three approved, Rizky waiting (`subscription-fixture.ts`). What no
 * fixture had is **a leader-limit request that was declined**, so *Sudah diputuskan* showed *Ditolak* for KPM requests
 * alone. This adds one: an earlier request about Rizky, declined three weeks ago by the platform's operator with the
 * reason the office was sent, before the one he waits on now.
 *
 * | Signed in as | Sees on `/admin/approvals` |
 * |---|---|
 * | `superadmin@agencyboost.test` | *Menunggu*: Bandung Kota, Surabaya Timur, Bekasi Utara (KPM baru) and Rizky (leader past the limit); *Sudah diputuskan*: Kelapa Gading (Disetujui), Medan Selatan (Ditolak), three leaders of 0603 (Disetujui) and Rizky's first request (Ditolak) |
 *
 * **Written once.** A declined request about the subject already there is found, and nothing is written.
 */
export interface ApprovalsFixtureDeps {
  LeaderLimitRequests: mongoose.Model<never>;
  superAdminUserId: string;
  daysAgo: (days: number) => Date;
}

export interface ApprovalsFixture {
  /** The declined request's id, or `null` where 0603 holds no waiting request to start from. */
  declinedLeaderLimitRequestId: string | null;
  guide: string;
}

export async function seedApprovalsFixture(deps: ApprovalsFixtureDeps): Promise<ApprovalsFixture> {
  const Requests = deps.LeaderLimitRequests as unknown as mongoose.Model<Record<string, unknown>>;
  // Rizky's request, as `subscription-fixture.ts` writes it: the one waiting in 0603.
  const waiting = await Requests.findOne({ status: 'pending', deletedAt: null }).sort({ createdAt: -1 }).lean().exec() as
    { kpmId: string; subjectMembershipId: string; requestedByMembershipId: string } | null;
  if (!waiting) return { declinedLeaderLimitRequestId: null, guide: 'approvals: no waiting leader-limit request to follow' };

  const found = await Requests.findOne({
    kpmId: waiting.kpmId, subjectMembershipId: waiting.subjectMembershipId, status: 'declined',
  }).lean().exec() as { _id: unknown } | null;
  if (found) return { declinedLeaderLimitRequestId: String(found._id), guide: 'approvals: declined leader-limit request kept' };

  const created = await Requests.create({
    kpmId: waiting.kpmId,
    subjectMembershipId: waiting.subjectMembershipId,
    action: 'promote',
    fromOrgLevelCode: 'AGENT',
    toOrgLevelCode: 'AAB',
    joinRequestId: null,
    leaderMembershipId: null,
    reason: 'Sudah membina dua agen baru',
    requestedByMembershipId: waiting.requestedByMembershipId,
    status: 'declined',
    decidedAt: deps.daysAgo(21),
    decidedByUserId: deps.superAdminUserId,
    declineReason: 'Naikkan paket saat perpanjangan berikutnya, lalu ajukan lagi.',
    createdAt: deps.daysAgo(23),
    deletedAt: null,
    createdBy: waiting.requestedByMembershipId,
    updatedBy: null,
  });
  return {
    declinedLeaderLimitRequestId: String(created._id),
    guide: 'approvals: one declined leader-limit request about Rizky (0603), for Persetujuan › Sudah diputuskan',
  };
}
