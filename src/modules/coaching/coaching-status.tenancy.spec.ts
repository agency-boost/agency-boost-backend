import { FixedClock } from '@/common/clock/clock.port';
import { RequestContext } from '@/common/context/request-context';
import { TenantDay } from '@/modules/tenants/tenant-day.service';
import { clearCollections, startMongo, stopMongo } from '../../../test/mongo';
import { configModule } from '../../../test/config-module';

/** 10:00 on Friday 20 November 2026 in Jakarta. */
const NOW = new Date('2026-11-20T03:00:00Z');
const KPM_A = '66f0000000000000000000a1';
const KPM_B = '66f0000000000000000000b1';
const COMPANY = '66f0000000000000000000c1';
const AB = '66f00000000000000000ab01';
const RINA = '66f00000000000000000a901';
const BUDI = '66f00000000000000000a902';
const DEWI = '66f00000000000000000a903';

const leader = (kpmId = KPM_A) => new RequestContext('u-ab', 'none', {
  membershipId: AB, kpmId, orgLevelCode: 'AB', hierarchyRole: 'ab',
  status: 'active', isKpmOwner: false, isKpmAdmin: false, directCount: 3,
} as never);

/**
 * **`CoachingReadings.statusOf`: the coaching status tile, with the last 1-on-1** (P19.17-T1 AC-5; ADR-0267 §5): red
 * never, green up to 14 days, yellow after — from the latest session finalized at least once, in the office's calendar,
 * within the office.
 */
describe('the coaching status tile, read (P19.17-T1 AC-5)', () => {
  let wired: ReturnType<typeof configModule>;
  let days: TenantDay;
  const clock = () => wired.clock as FixedClock;

  beforeAll(async () => {
    await startMongo();
    wired = configModule(NOW);
    days = new TenantDay(wired.kpms as never, wired.clock);
  });
  afterAll(stopMongo);
  beforeEach(async () => {
    clock().set(NOW);
    await clearCollections();
    await (wired.kpms as { create: (d: unknown) => Promise<unknown> }).create([
      { _id: KPM_A, companyId: COMPANY, code: '0417', branchName: 'A', timezone: 'Asia/Jakarta' },
      { _id: KPM_B, companyId: COMPANY, code: '0555', branchName: 'B', timezone: 'Asia/Jakarta' },
    ]);
  });

  const session = (coachee: string, date: string | null, over: Record<string, unknown> = {}, ctx = leader()) =>
    wired.coachingSessions.create(ctx, {
      coachMembershipId: AB, coacheeMembershipId: coachee,
      status: date === null ? 'draft' : 'finalized', date,
      frozenAt: date === null ? null : new Date(`${date}T03:00:00Z`),
      finalizedAt: date === null ? null : new Date(`${date}T03:00:00Z`),
      finalizedByMembershipId: date === null ? null : AB,
      version: date === null ? 2 : 3,
      ...over,
    } as never);

  const status = async (ids: string[], ctx = leader()) => wired.coachingReadings.statusOf(ctx, ids, await days.office(ctx));

  it('P19.17-T1 AC-5 is never, recent at 14 days, lapsed at 15 — with the session’s day and coach', async () => {
    const fourteen = await session(RINA, '2026-11-06');
    await session(BUDI, '2026-11-05');
    // A draft is no 1-on-1.
    await session(DEWI, null);

    const read = await status([RINA, BUDI, DEWI]);
    expect(read.get(RINA)).toEqual({
      last: { sessionId: String(fourteen._id), date: '2026-11-06', coachMembershipId: AB },
      daysSinceLastCoaching: 14, status: 'recent',
    });
    expect(read.get(BUDI)).toMatchObject({ daysSinceLastCoaching: 15, status: 'lapsed' });
    expect(read.get(DEWI)).toEqual({ last: null, daysSinceLastCoaching: null, status: 'never' });
  });

  it('P19.17-T1 AC-5 counts days in the office’s calendar: at 23:30 WIB the day has not turned', async () => {
    await session(RINA, '2026-11-06');
    clock().set(new Date('2026-11-20T16:30:00Z'));
    expect((await status([RINA])).get(RINA)).toMatchObject({ daysSinceLastCoaching: 14, status: 'recent' });
    clock().set(new Date('2026-11-20T17:30:00Z'));
    expect((await status([RINA])).get(RINA)).toMatchObject({ daysSinceLastCoaching: 15, status: 'lapsed' });
  });

  it('P19.17-T1 AC-5 never reads another office’s sessions (cross-tenant)', async () => {
    await session(RINA, '2026-11-19', {}, leader(KPM_B));
    expect((await status([RINA])).get(RINA)).toMatchObject({ status: 'never' });
    expect((await status([RINA], leader(KPM_B))).get(RINA)).toMatchObject({ daysSinceLastCoaching: 1, status: 'recent' });
  });
});
