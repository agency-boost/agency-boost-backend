import mongoose from 'mongoose';
import { up as kpmSetupRunningOffices } from '@/migrations/0052-kpm-setup-running-offices';

/**
 * **The KPM setup card, seeded** (P19.3-T2; UI-149, Overview R2) — both states of the Overview's top, so each can be
 * reviewed in a browser:
 *
 * | Who | What they see on `/kpm/overview` |
 * |---|---|
 * | `owner@kpm0417.test` (Wilson Tanoto), `admin@kpm0417.test` | **No card**: 0417 is running — members, a year of files, this month's target — so `0052-kpm-setup-running-offices` marks its four settings pages, and the first Overview read stores *all seven done* |
 * | `owner@kpm0701.test` (Hadi Gunawan) | ***Siapkan KPM · 2 dari 7***: *Branch info* marked *Sudah sesuai* by Hadi, and *Impor anggota* ticked by Nadia Putri; *Activity types*, *Activation checklist*, *Products*, *Unggah produksi* and *Atur target rekrutmen* open — each opens its page, and step 6 Data upload on this month |
 *
 * 0555 is running too (two months' files, two members), and has no card. **Idempotent**: the migration keeps a mark
 * that is there, and 0701's is written only while it is not.
 */
export async function seedSetupMarks(now: Date): Promise<{ running: number; setupOffice: string | null }> {
  const db = mongoose.connection.db!;
  const { marked, current } = await kpmSetupRunningOffices(db, now);
  const kpm = await db.collection('kpms').findOne({ code: '0701', deletedAt: null }, { projection: { ownerUserId: 1 } });
  if (!kpm) return { running: marked + current, setupOffice: null };
  const kpmId = String(kpm._id);
  const owner = await db.collection('memberships').findOne(
    { kpmId, status: 'active', deletedAt: null, ...(kpm.ownerUserId ? { userId: kpm.ownerUserId } : { role: 'ab' }) },
    { projection: { _id: 1 } },
  );
  await db.collection('kpmSetupMarks').updateOne(
    { kpmId, mark: 'branch-info', deletedAt: null },
    {
      $setOnInsert: {
        kpmId, mark: 'branch-info', via: 'reviewed', at: now, by: owner ? String(owner._id) : null, deletedAt: null,
        createdBy: owner ? String(owner._id) : null, updatedBy: null, createdAt: now, updatedAt: now, version: 0,
      },
    },
    { upsert: true },
  );
  return { running: marked + current, setupOffice: '0701' };
}
