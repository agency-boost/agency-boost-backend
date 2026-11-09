import mongoose from 'mongoose';

export interface KpmCodeUniqueAmongLiveResult {
  /** Whether the old index — unique over every office, deleted ones included — was there and was dropped. */
  dropped: boolean;
  /** Whether the new one — unique among live offices only — was built by this run. */
  created: boolean;
}

/** The index Mongoose named for `{ companyId: 1, code: 1 }` before P19-T3. */
const OLD = 'companyId_1_code_1';
/** `kpm.schema.ts`'s name for its replacement. */
const NEW = 'one_live_code_per_company';

/**
 * **A KPM code is unique among an insurer's live offices** (P19-T3, ADR-0191 §3, §5). Until now the index counted
 * deleted offices too, so a code an approval used and then undid — or an empty office the Super Admin deleted — was
 * held for ever: every check reads `deletedAt: null` and said *free*, and the write then failed the index as a 500.
 *
 * Drops `companyId_1_code_1` and builds `one_live_code_per_company`, the same keys, unique where `deletedAt` is
 * `null`. Built before the API starts so the refusal never lapses; on a database whose offices already break the new
 * rule nothing could — the old index was stricter.
 *
 * **Idempotent and forward-only**: a second run finds the old index gone and the new one there, and does nothing. On a
 * database with no `kpms` collection it does nothing; the API builds the index when it creates the collection.
 */
export async function up(db: mongoose.mongo.Db): Promise<KpmCodeUniqueAmongLiveResult> {
  const exists = (await db.listCollections({ name: 'kpms' }, { nameOnly: true }).toArray()).length > 0;
  if (!exists) return { dropped: false, created: false };

  const kpms = db.collection('kpms');
  const names = (await kpms.indexes()).map((index) => String(index.name));

  // The new one first: there is never a moment without a code rule.
  let created = false;
  if (!names.includes(NEW)) {
    await kpms.createIndex(
      { companyId: 1, code: 1 },
      { unique: true, name: NEW, partialFilterExpression: { deletedAt: null } },
    );
    created = true;
  }

  let dropped = false;
  if (names.includes(OLD)) {
    await kpms.dropIndex(OLD);
    dropped = true;
  }
  return { dropped, created };
}
