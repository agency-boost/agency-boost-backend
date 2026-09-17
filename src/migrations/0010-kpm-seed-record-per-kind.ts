import mongoose from 'mongoose';

/**
 * Move each office's seed record from one pair to one entry per template kind (P5-T12).
 *
 * `seededFromTemplateId` / `seededFromVersion` were written from the **activity taxonomy's**
 * seed alone, so the pair becomes `seededFrom.activity_taxonomy` — including a null version,
 * which meant, and still means, "built from the platform defaults".
 *
 * **Nothing is inferred for the other kinds.** Which lead pipeline or ratio set an existing
 * office was built from was never recorded. It could be estimated by comparing the office's
 * creation time with each template's `publishedAt`, and it is deliberately not: that would
 * write an inference into a field every reader treats as a record. Those kinds stay absent,
 * and the Company template screen counts such offices as **unrecorded** rather than as behind.
 *
 * An office with neither old field — created before the pair existed — is left untouched:
 * its taxonomy is unrecorded too, which is the truth.
 *
 * Idempotent: only rows still carrying an old field are touched, and an existing
 * `seededFrom.activity_taxonomy` is never overwritten.
 */
export async function up(db: mongoose.mongo.Db): Promise<{ moved: number }> {
  const kpms = db.collection('kpms');
  const rows = await kpms.find(
    { $or: [{ seededFromVersion: { $exists: true } }, { seededFromTemplateId: { $exists: true } }] },
    { projection: { seededFromVersion: 1, seededFromTemplateId: 1, seededFrom: 1 } },
  ).toArray();

  let moved = 0;
  for (const row of rows) {
    const alreadyRecorded = Boolean(
      (row.seededFrom as Record<string, unknown> | undefined)?.activity_taxonomy,
    );
    await kpms.updateOne(
      { _id: row._id },
      {
        ...(alreadyRecorded ? {} : {
          $set: {
            'seededFrom.activity_taxonomy': {
              templateId: typeof row.seededFromTemplateId === 'string' ? row.seededFromTemplateId : null,
              version: typeof row.seededFromVersion === 'number' ? row.seededFromVersion : null,
            },
          },
        }),
        $unset: { seededFromTemplateId: '', seededFromVersion: '' },
      },
    );
    if (!alreadyRecorded) moved += 1;
  }
  return { moved };
}
