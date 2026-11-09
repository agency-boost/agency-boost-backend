import type mongoose from 'mongoose';

/** Who the audit rows name: a job, as `RequestContext.forJob` names one. */
export const VIEW_AS_ONLY_ACTOR = 'job:migration-0055-view-as-only';

/** Why each session was ended, on its row and on its `impersonation.ended` entry (ADR-0206 §5). */
export const VIEW_AS_ONLY_REASON = 'view_as_only';

export interface ViewAsOnlyResult {
  /** Open sessions ended: started as a setup session, or elevated to write. */
  ended: number;
}

/**
 * **Sessions open at the deploy that could write are ended** (P19.4-T2 AC-1; ADR-0206 §5; UI-151). View-as only looks
 * from this release: no setup session, no write elevation, and `ViewOnlySessionGuard` refuses every write of a session.
 * A session already running when it ships was started under the old rules, so it is ended here rather than left to
 * write — or to be refused mid-task without being told why.
 *
 * - **Which rows:** not ended (`endedAt: null`), not deleted, and either `purpose: 'setup'` or `readOnly: false` (one a
 *   second Super Admin elevated). A support session that only looks is left running: nothing about it changes.
 * - **What it writes:** `endedAt` at the deploy's time and `endReason: 'view_as_only'` on the row; and
 *   `impersonation.ended` in the session's office (`kpmId`, `null` for a person in none), naming the person acted as —
 *   as `ImpersonationService.end` writes it — with `after: { reason: 'view_as_only', sessionId }`. The actor is this
 *   job; the Super Admin who ran the session is `effectiveUserId`'s counterpart on the start entry, and is named here
 *   too, as `after.startedBy`.
 * - **History is kept.** `purpose`, `readOnly`, `writeScope` and the elevation fields stay on each row as they were:
 *   rows and audit entries are append-only.
 * - **An expired row is ended too.** It is dead already (`liveSession` reads the expiry), but leaving it open would
 *   leave a session that wrote with no recorded end, and the Owner's log would show a start with no finish.
 *
 * **Idempotent**: it reads only rows still open, and ends each; a second run finds none and writes nothing. On an
 * empty database there is nothing to read.
 */
export async function up(db: mongoose.mongo.Db, now: Date): Promise<ViewAsOnlyResult> {
  const sessions = db.collection('impersonationSessions');
  const audit = db.collection('auditLog');
  const open = await sessions.find({
    endedAt: null,
    deletedAt: null,
    $or: [{ purpose: 'setup' }, { readOnly: false }],
  }).toArray();

  let ended = 0;
  for (const row of open) {
    // Ended only if still open, so a run racing the operator's own end writes one end, not two.
    const { modifiedCount } = await sessions.updateOne(
      { _id: row._id, endedAt: null },
      { $set: { endedAt: now, endReason: VIEW_AS_ONLY_REASON, updatedAt: now } },
    );
    if (modifiedCount === 0) continue;
    ended += 1;
    await audit.insertOne({
      kpmId: row.kpmId ?? null,
      actorUserId: VIEW_AS_ONLY_ACTOR,
      effectiveUserId: VIEW_AS_ONLY_ACTOR,
      actorMembershipId: null,
      action: 'impersonation.ended',
      targetCollection: 'users',
      targetId: String(row.effectiveUserId),
      targetMembershipId: null,
      before: null,
      after: { reason: VIEW_AS_ONLY_REASON, sessionId: String(row._id), startedBy: String(row.realActorUserId) },
      onBehalfOf: false,
      ip: null,
      userAgent: null,
      createdAt: now,
      updatedAt: now,
    });
  }
  return { ended };
}
