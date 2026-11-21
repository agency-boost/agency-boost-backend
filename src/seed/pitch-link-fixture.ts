import mongoose from 'mongoose';
import type { Clock } from '@/common/clock/clock.port';
import { AuditLog, AuditLogSchema } from '@/modules/audit/audit-log.schema';
import { RecruitmentPitchSlot, RecruitmentPitchSlotSchema } from '@/modules/recruitment/recruitment-pitch.schema';
import { seedObjectId } from './coaching-fixture';

const RECOMPILE = { overwriteModels: true } as const;

/** An address on the reserved example domain: a demonstration, never a real page of anybody's. */
export const SEED_PITCH_LINK = 'https://example.com/profil-agensi-bsd-city';

/**
 * **0417's *Agency Profile* given as a link** (P19.21-T3 AC-6, ADR-0274): so *Pengaturan › Recruitment pitch* shows a
 * material that is a link — *"Link · 15 Nov 2026"*, *Siap* — beside the files `recruitment-fixture.ts` stores and the
 * slots it leaves empty, and an agent's *Pitch Materials* opens it in a new tab. A link needs no storage, so this runs
 * whether or not storage is configured. Written once: a slot the office holds anything in is left as it is.
 */
export async function seedPitchLinkFixture(deps: {
  clock: Clock;
  kpmId: string;
  owner: { membershipId: string; userId: string };
}): Promise<{ written: number }> {
  const Slots = mongoose.model(RecruitmentPitchSlot.name, RecruitmentPitchSlotSchema, undefined, RECOMPILE);
  const Audit = mongoose.model(AuditLog.name, AuditLogSchema, undefined, RECOMPILE);
  if (await Slots.exists({ kpmId: deps.kpmId, slot: 'agency', deletedAt: null })) return { written: 0 };

  const at = new Date(deps.clock.now().getTime() - 5 * 86_400_000);
  const _id = seedObjectId('pitch-link-fixture', '0417', 'agency');
  await Slots.create({
    _id, kpmId: deps.kpmId, slot: 'agency', storageKey: null, fileName: null, mimeType: null, bytes: null,
    linkUrl: SEED_PITCH_LINK, uploadedAt: at, uploadedByMembershipId: deps.owner.membershipId, confirmations: [],
    version: 1, deletedAt: null, createdBy: deps.owner.membershipId, updatedBy: deps.owner.membershipId,
  });
  await Audit.create({
    kpmId: deps.kpmId, actorUserId: deps.owner.userId, actorMembershipId: deps.owner.membershipId,
    action: 'recruitment_pitch.linked', targetCollection: 'kpmRecruitmentPitchDocuments', targetId: _id,
    before: null, after: { slot: 'agency', linkUrl: SEED_PITCH_LINK, version: 1, clearedItems: [] },
    createdAt: at, updatedAt: at,
  });
  return { written: 1 };
}
