import mongoose from 'mongoose';

/**
 * Turn `goals.monthsLeft` into `goals.monthsLeftOverride` (P8-T5).
 *
 * The field was the cascade's divisor **as stored**, and it was served back on every read — so a
 * plan agreed in January with 11.9 months left still claimed 11.9 months in October, and a monthly
 * target a fifth of the truth. The agent was told they were comfortably on track while they were
 * far behind, which is the defect client PRD §17 names.
 *
 * Now `null` means *use the office's calendar* and the number in force is derived on every read.
 *
 * **Every existing row becomes an override**, deliberately. The data does not say whether the
 * figure was the office's default or the agent's own choice — that distinction did not exist —
 * and the two readings differ in what they cost somebody: keeping a stale number they did not
 * choose is a wrong plan they never see, while keeping a figure they *did* choose is what they
 * asked for. Preserving the number is the reading that cannot lose a deliberate decision, and the
 * first save clears it for anybody who did not make one.
 *
 * Idempotent: only rows that still carry the old field are touched, and the `$unset` means a
 * second run matches nothing.
 */
export async function up(db: mongoose.mongo.Db): Promise<{ migrated: number }> {
  const goals = db.collection('goals');
  const rows = await goals
    .find({ monthsLeft: { $exists: true } }, { projection: { monthsLeft: 1 } })
    .toArray();

  for (const row of rows) {
    await goals.updateOne({ _id: row._id }, {
      $set: { monthsLeftOverride: (row.monthsLeft as number) ?? null },
      $unset: { monthsLeft: '' },
    });
  }

  return { migrated: rows.length };
}
