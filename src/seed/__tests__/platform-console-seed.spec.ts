import mongoose from 'mongoose';
import { FixedClock } from '@/common/clock/clock.port';
import { Kpm, KpmSchema } from '@/modules/tenants/kpm.schema';
import { clearCollections, startMongo, stopMongo } from '../../../test/mongo';
import { PLATFORM_CONSOLE_SEED, seedPlatformConsoleFixture } from '../platform-console-fixture';
import { ownersOf } from '../../../test/owners';

const SA = '66f00000000000000000e001';
const SECOND = '66f00000000000000000e002';
const KPM_0417 = '66f0000000000000000004a1';
const [OWNER_A, OWNER_B] = ['66f00000000000000000f001', '66f00000000000000000f002'];

/**
 * ***Platform*'s demo data** (P19.23-T6; `platform-console-fixture.ts`): a change inside a KPM and the platform rows for
 * *Audit log*, a candidate for *Tambah Super Admin*, the WhatsApp number, one announcement in each Owner's notifications —
 * and a second run writes nothing.
 */
describe('the platform console seed (P19.23-T6)', () => {
  const clock = new FixedClock(new Date('2026-11-20T03:00:00Z'));
  const deps = {
    clock, superAdminUserId: SA, secondSuperAdminUserId: SECOND, kpmId: KPM_0417, companyId: 'c1', hash: async (p: string) => `hash:${p}`,
  };

  beforeAll(async () => {
    await startMongo();
    await clearCollections();
    const kpms = mongoose.models[Kpm.name] ?? mongoose.model(Kpm.name, KpmSchema);
    await kpms.create({ _id: KPM_0417, companyId: 'c1', code: '0417', branchName: 'BSD City Branch', owners: ownersOf(OWNER_A), status: 'active' });
    await kpms.create({ companyId: 'c1', code: '0603', branchName: 'Tangerang', owners: ownersOf(OWNER_B), status: 'active' });
    await kpms.create({ companyId: 'c1', code: '0999', branchName: 'Suspended', owners: ownersOf(OWNER_A), status: 'suspended' });
  }, 120_000);

  afterAll(async () => {
    await stopMongo();
  });

  it('P19.23-T6 seeds every section once, and a second run writes nothing', async () => {
    const { guide } = await seedPlatformConsoleFixture(deps);
    const db = mongoose.connection.db!;
    const count = async () => Object.fromEntries(await Promise.all(
      ['users', 'auditLog', 'platformSettings', 'announcements', 'notifications'].map(async (c) => [c, await db.collection(c).countDocuments()]),
    ));
    const first = await count();
    expect(first).toEqual({ users: 1, auditLog: 4, platformSettings: 1, announcements: 1, notifications: 2 });
    // Registered, as *Tambah Super Admin* needs (ADR-0279): a company and its code, and the four (P18.5-T4); in no KPM.
    expect(await db.collection('users').findOne({})).toMatchObject({
      email: PLATFORM_CONSOLE_SEED.candidate.email, platformRole: 'none', companyId: 'c1',
      agentCode: PLATFORM_CONSOLE_SEED.candidate.agentCode, gender: 'male', emailVerifiedAt: expect.any(Date),
    });
    expect(await db.collection('auditLog').findOne({ kpmId: KPM_0417 })).toMatchObject({
      actorUserId: SA, action: 'kpm_overview.recruit_target_set', before: { target: 6 }, after: { target: 8 },
    });
    expect(await db.collection('platformSettings').findOne({})).toMatchObject({ whatsappNumber: '+628112000300' });
    // Each live, active KPM's Owner once: 0417's and 0603's, not the suspended one's twice.
    const notices = await db.collection('notifications').find().toArray();
    expect(notices.map((n) => n.userId).sort()).toEqual([OWNER_A, OWNER_B]);
    expect(guide).toContain('Platform (P19.23-T6)');

    await seedPlatformConsoleFixture(deps);
    expect(await count()).toEqual(first);
  });
});
