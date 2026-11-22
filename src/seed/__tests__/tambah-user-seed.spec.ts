import mongoose from 'mongoose';
import { FixedClock } from '@/common/clock/clock.port';
import { INVITES } from '@/domain/constants';
import { UserInvitation, UserInvitationSchema } from '@/modules/org/user-invitation.schema';
import { clearCollections, startMongo, stopMongo } from '../../../test/mongo';
import { seedTambahUserFixture, TAMBAH_USER_SEED } from '../tambah-user-fixture';

const NOW = new Date('2026-11-22T03:00:00Z');
const KPM = '66f0000000000000000004a7';

/**
 * ***Menunggu*'s *Diundang*, seeded** (P19.28-T5 AC-1; ADR-0286): the fixture alone — one invitation of *Tambah user*,
 * waiting since two days ago, its link a hash nobody holds — and written once however often the seed runs. Fajar
 * (*Belum ada KPM*) and the three *Keluar* people are `demo.ts`'s own, read by the seeds' own specs.
 */
describe('P19.28-T5 the Tambah user seed', () => {
  beforeAll(startMongo);
  afterAll(stopMongo);
  beforeEach(clearCollections);

  it('P19.28-T5 AC-1 one Diundang invitation to 0417, an Agent under its AAB, sent two days ago — written once', async () => {
    const deps = {
      clock: new FixedClock(NOW), kpmId: KPM, leaderMembershipId: 'sari', invitedByUserId: 'wilson', invitedByMembershipId: 'm-wilson',
    };
    expect((await seedTambahUserFixture(deps)).written).toBe(1);
    expect((await seedTambahUserFixture(deps)).written).toBe(0);
    const rows = await mongoose.model(UserInvitation.name, UserInvitationSchema).find({}).lean().exec();
    const invitedAt = new Date(NOW.getTime() - 2 * 86_400_000);
    expect(rows).toEqual([expect.objectContaining({
      kpmId: KPM, fullName: TAMBAH_USER_SEED.invited.fullName, phone: '+6281388004410', status: 'pending',
      orgLevelCode: 'AGENT', roleClass: 'agent', leaderMembershipId: 'sari', makeOwner: false, invitedAt,
      expiresAt: new Date(invitedAt.getTime() + INVITES.EXPIRY_DAYS * 86_400_000), tokenHash: expect.stringMatching(/^[0-9a-f]{64}$/),
    })]);
    expect(TAMBAH_USER_SEED.left).toHaveLength(3);
  });
});
