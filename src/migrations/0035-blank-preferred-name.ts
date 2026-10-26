import mongoose from 'mongoose';

export interface BlankPreferredNameResult {
  /** Accounts whose empty or blank preferred name became `null`. */
  cleared: number;
}

/**
 * **A blank preferred name is no name** (P18.8-T15 AC-1, the client's UI review, UI-005).
 *
 * The profile sent `''` for an empty *Preferred name* and `PATCH /auth/me` stored it, so every screen that
 * read `preferredName ?? fullName` printed nothing in the header and the rosters. The API stores `null` for
 * an empty one from the deploy that brings this; this repairs the accounts that saved one before it: an
 * empty string, or nothing but whitespace, becomes `null`. A real preferred name is not touched, padded or not
 * — the reads trim it.
 *
 * **Idempotent.** The filter matches only a blank string, and `null` is not a string, so a second run finds
 * nothing. On an empty database `updateMany` matches nothing and writes nothing.
 */
export async function up(db: mongoose.mongo.Db): Promise<BlankPreferredNameResult> {
  const result = await db.collection('users').updateMany(
    { preferredName: { $type: 'string', $regex: /^\s*$/ } },
    { $set: { preferredName: null } },
  );
  return { cleared: result.modifiedCount };
}
