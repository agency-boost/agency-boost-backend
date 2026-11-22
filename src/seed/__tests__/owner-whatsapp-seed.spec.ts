import mongoose from 'mongoose';
import { FixedClock } from '@/common/clock/clock.port';
import { clearCollections, startMongo, stopMongo } from '../../../test/mongo';
import { seedDemo } from '../demo';
import { OWNER_WHATSAPP_SEED } from '../owner-whatsapp-invite-fixture';

const RUN_MS = 240_000;
const quiet = () => undefined;
const NOW = new Date('2026-11-20T03:00:00Z');

/**
 * **Two KPMs whose Owner waits for a WhatsApp invitation** (P19.23-T2 AC-3; OD-420; `owner-whatsapp-invite-fixture.ts`):
 * 0418's Owner is named with a WhatsApp number and no account, and the account he would sign up with is there; 0419's
 * Owner has an account that has never signed in. Both KPMs are provisioned, so their pages are not empty.
 */
describe('P19.23-T2 AC-3 the owner-invitation seed', () => {
  const clock = new FixedClock(NOW);
  const db = () => mongoose.connection.db!;

  beforeAll(async () => {
    await startMongo();
    await clearCollections();
    await seedDemo({ clock, log: quiet });
  }, RUN_MS);
  afterAll(stopMongo);

  const kpmOf = (code: string) => db().collection('kpms').findOne({ code, deletedAt: null });

  it('P19.23-T2 AC-3 0418 waits for BUDI HARTONO, named with WhatsApp only, and no link has gone yet', async () => {
    const kpm = (await kpmOf(OWNER_WHATSAPP_SEED.pending.code))!;
    expect(kpm.ownerUserId).toBeNull();
    expect(kpm.pendingOwner).toEqual({ fullName: 'BUDI HARTONO', phone: '+6281234567890', agentCode: null });
    expect(await db().collection('activityTypes').countDocuments({ kpmId: String(kpm._id) })).toBeGreaterThan(0);
    const budi = (await db().collection('users').findOne({ email: OWNER_WHATSAPP_SEED.pending.claimer.email }))!;
    expect(budi).toMatchObject({ companyId: String(kpm.companyId), agentCode: '81941', platformRole: 'none' });
    expect(budi.emailVerifiedAt).toBeTruthy();
    expect(await db().collection('memberships').countDocuments({ userId: String(budi._id) })).toBe(0);
  });

  it('P19.23-T2 AC-3 0419’s Owner has an account that has never signed in, the KPM’s root AB', async () => {
    const kpm = (await kpmOf(OWNER_WHATSAPP_SEED.neverSignedIn.code))!;
    const rina = (await db().collection('users').findOne({ email: OWNER_WHATSAPP_SEED.neverSignedIn.owner.email }))!;
    expect(kpm.ownerUserId).toBe(String(rina._id));
    expect(rina.lastLoginAt ?? null).toBeNull();
    expect(await db().collection('memberships').findOne({ kpmId: String(kpm._id), userId: String(rina._id) }))
      .toMatchObject({ status: 'active', role: 'ab', leaderId: null });
  });
});
