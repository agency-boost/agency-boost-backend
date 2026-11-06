import mongoose from 'mongoose';
import { defaultBinding } from '@/modules/config/activity-binding';

/**
 * **Every office and every template binds today's codes** (ADR-0163 §1, P18.6-T2 AC-1).
 *
 * The goal cascade, the summary, the pace, the Unit Dashboard, the measured rates and the campaigns' touches read
 * the office's activity binding from P18.6-T2 on — and until then they counted `LEADS_CONTACTED`,
 * `SELL_PRESENTATION` and `SELL_SUBMISSION` by constant. So the binding every office and template is given here is
 * exactly those three, one per role (`defaultBinding()`), and nothing anybody sees moves on the day it runs.
 *
 * - **The working copy** (`activityBindings`): a row for every office that has none, version 1 — what
 *   provisioning writes for a new office.
 * - **Each office's newest published snapshot** (`configSnapshots`, `payload.activityBinding`), where it carries
 *   none — the record of the binding in force, as a publish now renders it. Older snapshots are history and are
 *   left as they were.
 * - **Every Company template** of kind `activity_taxonomy`, draft and published, where its payload carries no
 *   `bindings` — so a template says what its offices count, and the Super Admin can change it there.
 *
 * **Idempotent**: each write is guarded on the absence of what it writes, so a second run changes nothing. An empty
 * database has no office, snapshot or template, and the run writes nothing (`migrations.empty-db.spec.ts`).
 */
export async function up(
  db: mongoose.mongo.Db, now: Date,
): Promise<{ offices: number; snapshots: number; templates: number }> {
  const bindings = db.collection('activityBindings');
  const offices = await db.collection('kpms').find({ deletedAt: null }, { projection: { _id: 1 } }).toArray();

  let officesWritten = 0;
  for (const { _id } of offices) {
    const kpmId = String(_id);
    const written = await bindings.updateOne(
      { kpmId, deletedAt: null },
      {
        $setOnInsert: {
          kpmId, ...defaultBinding(), version: 1, status: 'active', archivedAt: null, deletedAt: null,
          createdBy: null, updatedBy: null, createdAt: now, updatedAt: now,
        },
      },
      { upsert: true },
    );
    if (written.upsertedCount > 0) officesWritten += 1;
  }

  // Each office's newest snapshot, given the binding the office holds — its own row, which the loop above made
  // sure of, so the record and the working copy agree.
  const snapshots = db.collection('configSnapshots');
  let snapshotsWritten = 0;
  for (const kpmId of await snapshots.distinct('kpmId', { deletedAt: null })) {
    const [newest] = await snapshots.find({ kpmId, deletedAt: null }).sort({ version: -1 }).limit(1).toArray();
    if (!newest || (newest.payload as Record<string, unknown> | undefined)?.activityBinding !== undefined) continue;
    const row = await bindings.findOne({ kpmId, deletedAt: null });
    const binding = row
      ? { leads: row.leads, appointments: row.appointments, closings: row.closings, version: row.version }
      : { ...defaultBinding(), version: 0 };
    const updatedAt = row?.updatedAt instanceof Date ? row.updatedAt.toISOString() : null;
    const written = await snapshots.updateOne(
      { _id: newest._id, 'payload.activityBinding': { $exists: false } },
      { $set: { 'payload.activityBinding': { ...binding, updatedAt } } },
    );
    snapshotsWritten += written.modifiedCount;
  }

  const templates = await db.collection('companyTemplates').updateMany(
    { kind: 'activity_taxonomy', deletedAt: null, 'payload.bindings': { $exists: false } },
    { $set: { 'payload.bindings': defaultBinding() } },
  );

  return { offices: officesWritten, snapshots: snapshotsWritten, templates: templates.modifiedCount };
}
