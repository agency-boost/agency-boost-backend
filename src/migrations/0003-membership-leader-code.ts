import mongoose from 'mongoose';
import { emptyIfMissing } from './missing-collection';
import { generateLeaderCode } from '@/modules/org/leader-code';

/**
 * Give every membership its leader code (P3.2-T1).
 *
 * The code moved from `inviteCodes` onto the membership: one per person, generated with
 * it, never reissued and never withdrawn. Rows written before that have none.
 *
 * **A leader's live invite code is carried over rather than replaced.** Somebody has that
 * string written on a card or sitting in a WhatsApp thread, and generating a fresh one
 * would break every link already shared for no reason anybody could see. Only where a
 * membership has no live invite — most of them — is a new code generated.
 *
 * `inviteCodes` is left in place. Dropping a collection is a deliberate operation with a
 * backup behind it, not something a migration does on the way past; nothing reads it any
 * more, and an operator can drop it once they are satisfied.
 *
 * Idempotent: it touches only memberships with no code yet.
 */
export async function up(
  db: mongoose.mongo.Db,
  now: Date,
): Promise<{ carried: number; generated: number; skipped: number }> {
  const memberships = await db
    .collection('memberships')
    .find({ $or: [{ leaderCode: { $exists: false } }, { leaderCode: null }] })
    .toArray();

  // Every code already spoken for, so neither a carry-over nor a generated one collides.
  const taken = new Set<string>(
    (await db
      .collection('memberships')
      .find({ leaderCode: { $type: 'string' } }, { projection: { leaderCode: 1 } })
      .toArray()
    ).map((m) => String(m.leaderCode)),
  );

  let carried = 0;
  let generated = 0;
  let skipped = 0;

  for (const membership of memberships) {
    // The oldest live invite they issued: if they made several, the one most likely to be
    // out in the world is the first they shared.
    // No `inviteCodes` collection is no invite; any other failure stops the migration (P18.4-T1).
    const invite = await emptyIfMissing(db
      .collection('inviteCodes')
      .find({
        issuedByMembershipId: String(membership._id),
        deletedAt: null,
        revokedAt: null,
      })
      .sort({ createdAt: 1 })
      .limit(1)
      .toArray());

    let code = invite[0]?.code ? String(invite[0].code).toUpperCase() : null;
    if (code && taken.has(code)) code = null; // Somebody else already has it; generate.
    if (code) carried += 1;

    if (!code) {
      // Five attempts against a space of 32^6. Not a real limit — a way of failing loudly
      // if the generator ever stops being random, rather than looping for ever.
      for (let attempt = 0; attempt < 5 && !code; attempt += 1) {
        const candidate = generateLeaderCode();
        if (!taken.has(candidate)) code = candidate;
      }
      if (!code) {
        skipped += 1;
        continue;
      }
      generated += 1;
    }

    taken.add(code);
    await db
      .collection('memberships')
      .updateOne({ _id: membership._id }, { $set: { leaderCode: code, updatedAt: now } });
  }

  return { carried, generated, skipped };
}
