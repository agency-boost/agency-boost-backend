import { firstOwnerOf, type WithOwners } from '@/modules/tenants/kpm-owners';
import mongoose from 'mongoose';
import type { Clock } from '@/common/clock/clock.port';
import { DEFAULT_TENANT_TIMEZONE } from '@/domain/constants';
import { shiftMonth } from '@/modules/production/upload-completeness';

/** The two agent codes this month's file names that nobody in 0417 holds yet — *Belum jadi anggota* (P19.21-T1 AC-6). */
export const DATA_UPLOAD_NOT_YET_MEMBERS = [
  { agentCode: '91200451', fileName: 'Rudi Hartono', apeMinor: 1_240_000 * 100, policies: 1 },
  { agentCode: '91200452', fileName: 'Lina Marpaung', apeMinor: 615_800 * 100, policies: 1 },
] as const;

/**
 * **Data upload, seeded so every state of the page shows in a browser** (P19.21-T1; ADR-0274). Run after the demo's
 * own production (this month's standing file, its correction by hand, last month's held *80999*) and **before** the
 * reporting fixture writes its year of files, so that two months it would fill stay missing.
 *
 * | Sign in as `owner@kpm0417.test`, open *Data upload* | What it shows |
 * |---|---|
 * | *Pilih bulan* · 2024 | every month red — data is required from January 2024 and none was ever sent |
 * | *Pilih bulan* · last year | green but **Mar** and **Jul**, red: never uploaded, still open — *Unggah data* works on them |
 * | this month | the standing file, one APE corrected by hand with a reason (✎, *dari file*), and **two *Belum jadi anggota* rows** — RUDI HARTONO 91200451 and LINA MARPAUNG 91200452 — in their section and filter; *Riwayat unggah* says "n ke anggota · 2 belum jadi anggota" |
 * | anywhere | the *FMT …* and *TES IMPOR …* test accounts under Agus are members but never a row, never counted |
 *
 * **Idempotent**: each write is skipped when its row is there, and a month somebody has uploaded into is theirs.
 */
export async function seedDataUploadFixture(deps: { clock: Clock; kpmCode: string }): Promise<{ guide: string; written: number }> {
  const db = mongoose.connection.db!;
  const kpm = await db.collection('kpms').findOne({ code: deps.kpmCode, deletedAt: null }, { projection: { _id: 1, owners: 1 } });
  if (!kpm) return { guide: `Data upload (P19.21-T1): no KPM ${deps.kpmCode}; nothing written.`, written: 0 };
  const kpmId = String(kpm._id);
  const today = deps.clock.localDateFor(DEFAULT_TENANT_TIMEZONE);
  const thisMonth = today.slice(0, 7);
  const lastYear = String(Number(today.slice(0, 4)) - 1);
  const owner = await db.collection('memberships').findOne(
    { kpmId, status: 'active', deletedAt: null, ...(firstOwnerOf(kpm as WithOwners) ? { userId: firstOwnerOf(kpm as WithOwners)!.userId } : {}) },
    { projection: { _id: 1 } },
  );
  const by = owner ? String(owner._id) : null;
  const now = deps.clock.now();
  let written = 0;

  // ---- Two months of last year never uploaded: a month row with nothing in it, so the year of files passes them by.
  for (const month of [`${lastYear}-03`, `${lastYear}-07`]) {
    const taken = (await db.collection('dataUploadBatches').findOne({ kpmId, month }))
      ?? (await db.collection('productionMonths').findOne({ kpmId, month }));
    if (taken) continue;
    await db.collection('productionMonths').insertOne({
      kpmId, month, revision: 0, lockOverride: null, firstWrittenOn: null, asOf: null, deletedAt: null,
      createdBy: by, updatedBy: by, createdAt: now, updatedAt: now,
    });
    written += 1;
  }

  // ---- This month's standing file names two codes nobody holds yet: kept, listed, counted in nothing.
  const [standing] = await db.collection('dataUploadBatches')
    .find({ kpmId, month: thisMonth, status: 'committed', deletedAt: null }).sort({ monthRevision: -1 }).limit(1).toArray();
  if (standing) {
    const batchId = String(standing._id);
    let added = 0;
    let line = (await db.collection('dataUploadRows').countDocuments({ batchId })) + 2;
    for (const person of DATA_UPLOAD_NOT_YET_MEMBERS) {
      const there = await db.collection('unregisteredAgentData').findOne({ kpmId, agentCode: person.agentCode, month: thisMonth });
      if (there) continue;
      const cell = (value: number) => ({
        value, provenance: 'imported', sourceBatchId: batchId, correctedBy: null, correctedAt: null, reason: null, replacedValue: null,
      });
      await db.collection('unregisteredAgentData').insertOne({
        kpmId, agentCode: person.agentCode, fileName: person.fileName, month: thisMonth,
        values: { APE: cell(person.apeMinor), FYP: cell(Math.round(person.apeMinor * 0.3)), POLICY_COUNT: cell(person.policies) },
        ytdValues: {}, templateId: null, templateVersion: 1, asOf: standing.asOf ?? null, sourceBatchId: batchId, status: 'held',
        movedToMembershipId: null, movedAt: null, deletedAt: null, createdBy: by, updatedBy: by, createdAt: now, updatedAt: now,
      });
      await db.collection('dataUploadRows').insertOne({
        kpmId, batchId, month: thisMonth, line, agentCode: person.agentCode, membershipId: null, status: 'held',
        heldAgentCode: person.agentCode, heldRowExisted: false,
        values: { APE: person.apeMinor, FYP: Math.round(person.apeMinor * 0.3), POLICY_COUNT: person.policies },
        previousValues: { APE: null, FYP: null, POLICY_COUNT: null }, issues: [], deletedAt: null,
        createdBy: by, updatedBy: by, createdAt: now, updatedAt: now,
      });
      line += 1;
      added += 1;
      written += 2;
    }
    if (added > 0) {
      const members = (standing.memberRowCount as number | null | undefined)
        ?? Math.max(0, (standing.writtenRowCount as number) - ((standing.heldRowCount as number | undefined) ?? 0));
      await db.collection('dataUploadBatches').updateOne({ _id: standing._id }, {
        $set: { memberRowCount: members },
        $inc: { heldRowCount: added, rowCount: added, writtenRowCount: added, cellCount: added * 3 },
      });
    }
  }

  return {
    guide: `Data upload (P19.21-T1): sign in as owner@${deps.kpmCode}.test → Data upload. ${lastYear}: Mar and Jul missing `
      + `(still open); ${shiftMonth(thisMonth, 0)}: RUDI HARTONO 91200451 and LINA MARPAUNG 91200452 under Belum jadi anggota, `
      + 'one APE corrected by hand; test accounts never listed.',
    written,
  };
}
