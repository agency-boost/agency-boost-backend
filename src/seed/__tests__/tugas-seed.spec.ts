import mongoose from 'mongoose';
import { FixedClock } from '@/common/clock/clock.port';
import { RequestContext } from '@/common/context/request-context';
import { addDays } from '@/common/time/local-day';
import type { CalendarAutoItems } from '@/modules/calendar/calendar-auto-items';
import { clearCollections, startMongo, stopMongo } from '../../../test/mongo';
import { configModule } from '../../../test/config-module';
import { seedDemo } from '../demo';
import { TUGAS_LEADS } from '../tugas-fixture';

const RUN_MS = 240_000;
const quiet = () => undefined;
const col = (name: string) => mongoose.connection.db!.collection(name);

async function as(email: string): Promise<RequestContext> {
  const kpm = await col('kpms').findOne({ code: '0417' });
  const account = await col('users').findOne({ email });
  const member = (await col('memberships').findOne({ kpmId: String(kpm!._id), userId: String(account!._id), status: 'active' }))!;
  const direct = await col('memberships').countDocuments({ leaderId: String(member._id), status: 'active' });
  return new RequestContext(String(member.userId), 'none', {
    membershipId: String(member._id), kpmId: member.kpmId, orgLevelCode: member.orgLevelCode,
    hierarchyRole: member.role, status: 'active', isKpmOwner: false, isKpmAdmin: false, directCount: direct,
  } as never);
}

/**
 * **P19.1-T3 AC-12 — this week's *Tugas*, seeded** (`tugas-fixture.ts`): a run on a **Saturday**, the day the run's
 * *today*-relative dates leave least of the week, read back through the Calendar's own `tasksOf`. Agus's and Rina's
 * fixture leads land on Monday to Friday of the week holding the run, whatever weekday it is.
 */
describe('P19.1-T3 AC-12 the Tugas seed — a run at 10:00 on Saturday 7 November 2026 in Jakarta', () => {
  const clock = new FixedClock(new Date('2026-11-07T03:00:00Z'));
  const MONDAY = '2026-11-02';
  let wired: ReturnType<typeof configModule>;

  beforeAll(async () => {
    await startMongo();
    await clearCollections();
    await seedDemo({ clock, log: quiet });
    wired = configModule(clock.now());
    await Promise.all(mongoose.modelNames().map((name) => mongoose.model(name).init()));
  }, RUN_MS);
  afterAll(stopMongo);

  const daysWithTugas = async (email: string) => {
    const ctx = await as(email);
    // The Calendar's own reader of *Tugas*, as `GET /calendar` asks it.
    const auto = (wired.calendar as unknown as { auto: CalendarAutoItems }).auto;
    const tasks = await auto.tasksOf(ctx, ctx.membershipId!, MONDAY, addDays(MONDAY, 6));
    return { tasks, days: [...new Set(tasks.map((t) => t.date))].sort() };
  };

  it('P19.1-T3 AC-12 Agus has Tugas on Monday, Tuesday and Thursday of this week, from his leads', async () => {
    const { tasks, days } = await daysWithTugas('agus@kpm0417.test');
    expect(days).toEqual(expect.arrayContaining([MONDAY, addDays(MONDAY, 1), addDays(MONDAY, 3)]));
    for (const seed of TUGAS_LEADS.filter((s) => s.owner === 'agus')) {
      expect(tasks).toContainEqual(expect.objectContaining({ source: 'lead', name: seed.name, date: addDays(MONDAY, seed.offset), note: seed.note }));
    }
  });

  it('P19.1-T3 AC-12 Rina has Tugas on Monday, Wednesday and Friday of this week', async () => {
    const { days } = await daysWithTugas('rina@kpm0417.test');
    expect(days).toEqual(expect.arrayContaining([MONDAY, addDays(MONDAY, 2), addDays(MONDAY, 4)]));
    expect(days.length).toBeGreaterThanOrEqual(3);
  });

  it('a second run writes nothing', async () => {
    const before = await col('leads').countDocuments({});
    await seedDemo({ clock, log: quiet });
    expect(await col('leads').countDocuments({})).toBe(before);
  }, RUN_MS);
});
