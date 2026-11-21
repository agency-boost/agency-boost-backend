import mongoose from 'mongoose';
import { FixedClock } from '@/common/clock/clock.port';
import { CONSOLE } from '@/domain/constants';
import { clearCollections, startMongo, stopMongo } from '../../../test/mongo';
import { seedDemo } from '../demo';

const RUN_MS = 300_000;
const quiet = () => undefined;

/**
 * **The console's Dashboard has something to show** (P19.23-T1, T2; ADR-0277; the brief's *Seed*): after the demo seed,
 * several insurers hold KPMs; the active KPMs' *Pakai 14 hari terakhir* spreads across the colour scale; one KPM's Owner
 * waits uninvited and the KPMs' months are uploaded unevenly; approvals wait and some are decided. Read off the seeded
 * rows the way `GET /admin/dashboard` reads them — active memberships, test accounts never, a day saved within 14 days.
 */
describe('the demo seed for the Super Admin console (P19.23-T1)', () => {
  const clock = new FixedClock(new Date('2026-11-20T03:00:00Z'));
  const db = () => mongoose.connection.db!;

  beforeAll(async () => {
    await startMongo();
    await clearCollections();
    await seedDemo({ clock, log: quiet });
  }, RUN_MS);
  afterAll(stopMongo);

  it('P19.23-T1 AC-4 several insurers hold KPMs, and the active KPMs’ use spreads across green, yellow and red', async () => {
    const kpms = await db().collection('kpms').find({ deletedAt: null, status: 'active' }).toArray();
    expect(new Set(kpms.map((k) => k.companyId)).size).toBeGreaterThanOrEqual(2);
    const since = '2026-11-06';
    const tones = new Set<string>();
    for (const kpm of kpms) {
      const members = await db().collection('memberships')
        .find({ kpmId: String(kpm._id), status: 'active', deletedAt: null, testAccount: { $ne: true } }).toArray();
      if (members.length === 0) continue;
      const used = await db().collection('activityLogs').distinct('membershipId', {
        kpmId: String(kpm._id), membershipId: { $in: members.map((m) => String(m._id)) }, localDate: { $gte: since }, deletedAt: null,
      });
      const pct = Math.round((used.length / members.length) * 100);
      tones.add(pct >= CONSOLE.SCALE.GREEN_FROM_PCT ? 'green' : pct >= CONSOLE.SCALE.YELLOW_FROM_PCT ? 'amber' : 'red');
    }
    expect([...tones].sort()).toEqual(['amber', 'green', 'red']);
  }, RUN_MS);

  it('P19.23-T1 AC-3 something needs action: an Owner who waits uninvited, and approvals waiting beside decided ones', async () => {
    expect(await db().collection('kpms').countDocuments({ deletedAt: null, ownerUserId: null, 'pendingOwner.fullName': { $exists: true } }))
      .toBeGreaterThan(0);
    expect(await db().collection('kpmRequests').countDocuments({ status: 'pending', deletedAt: null })).toBeGreaterThan(0);
    expect(await db().collection('kpmRequests').countDocuments({ status: { $in: ['approved', 'declined'] }, deletedAt: null }))
      .toBeGreaterThan(0);
    expect(await db().collection('leaderLimitRequests').countDocuments({ status: 'pending', deletedAt: null })).toBeGreaterThan(0);
  });
});
