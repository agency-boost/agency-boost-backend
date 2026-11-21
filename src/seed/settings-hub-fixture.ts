import mongoose from 'mongoose';
import type { Clock } from '@/common/clock/clock.port';

/** The edit the fixture makes: a described activity type, which agents read only once *Activity types* is published. */
export const SETTINGS_HUB_DEMO = Object.freeze({
  typeCode: 'SELL_FOLLOWUP',
  description: 'Pertemuan lanjutan setelah presentasi penjualan: menjawab pertanyaan dan menyepakati langkah berikutnya.',
});

/**
 * **The Pengaturan hub with something to act on** (P19.21-T2 AC-1, AC-2; ADR-0274 §5, §6): KPM 0417's *Activity types*
 * holds a change made after its last publish — *Diskusi follow up* given a description, as an Owner would through
 * the page — so `owner@kpm0417.test` sees the hub's orange bar (*"Activity types punya perubahan yang belum
 * diterbitkan."* + *Terbitkan*), the row's *Belum diterbitkan*, and on Activity types its own bar *"Draf. Agent masih
 * memakai versi n."*. Every other setting reads as published. The hub's other statuses come from what the seed holds
 * already: scripts waiting (`sales-tools-fixture.ts`), pitch materials not uploaded, no logo (0417 keeps AgencyBoost's
 * look; 0555 is the branded one).
 *
 * **Written like the service writes it**: the live row moves to its next `version`, which is what the publish gate
 * compares (P5-T11); the snapshot is never touched. **Re-runnable**: a row whose version already differs from the
 * published copy's is left as it is, so a second run adds nothing and an Owner who published since keeps that.
 */
export async function seedSettingsHubFixture(
  { kpmId, clock }: { kpmId: string; clock: Clock },
): Promise<{ edited: boolean }> {
  const db = mongoose.connection;
  const snapshot = await db.collection('configSnapshots')
    .find({ kpmId, deletedAt: null }).sort({ version: -1 }).limit(1).next() as
    { payload?: { activity?: { types?: { id?: string; code?: string; version?: number }[] }[] } } | null;
  const type = await db.collection('activityTypes')
    .findOne({ kpmId, code: SETTINGS_HUB_DEMO.typeCode, status: 'active', deletedAt: null });
  if (!snapshot || !type) return { edited: false };

  const published = (snapshot.payload?.activity ?? []).flatMap((c) => c.types ?? [])
    .find((t) => t.code === SETTINGS_HUB_DEMO.typeCode);
  if (!published || published.version !== type.version) return { edited: false };

  await db.collection('activityTypes').updateOne(
    { _id: type._id, kpmId, version: type.version },
    { $set: { description: SETTINGS_HUB_DEMO.description, updatedAt: clock.now() }, $inc: { version: 1 } },
  );
  return { edited: true };
}
