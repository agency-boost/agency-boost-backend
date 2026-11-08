import mongoose from 'mongoose';
import { FixedClock } from '@/common/clock/clock.port';
import { RequestContext } from '@/common/context/request-context';
import { HomeService, type HomeView } from '@/modules/home/home.service';
import { LeadRepository } from '@/modules/leads/lead.repository';
import { Lead, LeadSchema } from '@/modules/leads/lead.schema';
import { TenantDay } from '@/modules/tenants/tenant-day.service';
import { clearCollections, startMongo, stopMongo } from '../../../test/mongo';
import { configModule } from '../../../test/config-module';
import { seedDemo } from '../demo';
import { HOME_TODAY_LEAD } from '../home-fixture';

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
 * **P19.8-T2 AC-11 — Home's demo, seeded** (`home-fixture.ts`): a run at 10:00 on Saturday 7 November 2026 in Jakarta,
 * read back through `HomeService` itself — the AB's lead due today and an entry of his ahead, with an end time; his team
 * report with orange counts and grey ✕ rows, and, the day after the run, a day reported yesterday only; the AAB who leads
 * nobody at zero; an Agent with no leader block.
 */
describe('P19.8-T2 AC-11 the Home seed — a run at 10:00 on Saturday 7 November 2026 in Jakarta', () => {
  const clock = new FixedClock(new Date('2026-11-07T03:00:00Z'));
  let wired: ReturnType<typeof configModule>;
  let home: HomeService;

  beforeAll(async () => {
    await startMongo();
    await clearCollections();
    await seedDemo({ clock, log: quiet });
    wired = configModule(clock.now());
    await Promise.all(mongoose.modelNames().map((name) => mongoose.model(name).init()));
    home = new HomeService(
      new TenantDay(wired.kpms as never, wired.clock),
      wired.unitDashboard,
      wired.paceStatus,
      wired.coachingReadings,
      wired.activityReadings,
      wired.memberships,
      new LeadRepository(mongoose.model(Lead.name, LeadSchema) as never),
      wired.leadReadings,
      wired.calendar,
      wired.subjectReads,
      { linksFor: async () => new Map() } as never,
      wired.clock,
      wired.users as never,
      wired.orgLevels,
      wired.newHires,
    );
  }, RUN_MS);
  afterAll(stopMongo);

  const read = async (email: string): Promise<HomeView> => home.read(await as(email));

  it('P19.8-T2 AC-11 Agus: a lead’s next action today first, and an entry of his ahead, with an end time, that the Calendar’s detail opens', async () => {
    const view = await read('agus@kpm0417.test');
    expect(view.today).toBe('2026-11-07');
    expect(view.actions[0]).toMatchObject({ kind: 'lead', name: HOME_TODAY_LEAD.name, note: HOME_TODAY_LEAD.note });
    const ahead = view.actions.find((a) => a.kind === 'agenda' && a.source === 'entry');
    expect(ahead).toBeDefined();
    const entry = await wired.calendar.readOne(await as('agus@kpm0417.test'), (ahead as { id: string }).id);
    expect(entry.readerIs).toBe('organiser');
    expect(entry.end).toEqual(expect.stringMatching(/^\d\d:\d\d$/));
    expect(view.leads).toBeGreaterThan(0);
  });

  it('P19.8-T2 AC-11 Agus’s team report: orange counts and grey ✕ rows on the run’s day, more than five people', async () => {
    const team = (await read('agus@kpm0417.test')).leader!.team;
    expect(team.length).toBeGreaterThan(5);
    const named = (name: string) => team.find((p) => p.name === name)!;
    // Budi last logged nine days ago, Dewi saved a day of zeroes yesterday: a ✕ both days.
    for (const name of ['Budi Santoso', 'Dewi Lestari']) {
      const person = named(name);
      expect({ name, yesterday: (person.yesterday ?? 0) > 0, today: (person.today ?? 0) > 0 }).toEqual({ name, yesterday: false, today: false });
    }
    expect(team.some((p) => (p.today ?? 0) > 0 && (p.yesterday ?? 0) > 0)).toBe(true);
  });

  it('P19.9-T1 AC-5 P19.9-T2 AC-2 Agus’s Leads is his own open list’s total, and his Group names AABs and Agents', async () => {
    const view = await read('agus@kpm0417.test');
    const own = await wired.leadRecords.list(await as('agus@kpm0417.test'), { scope: 'own', outcome: 'open' });
    expect(view.leads).toBeGreaterThan(0);
    expect(view.leads).toBe(own.total);
    // *Tim* holds his downline's leads, more of them than his own: the filter has something to show.
    const team = await wired.leadRecords.list(await as('agus@kpm0417.test'), { scope: 'team', outcome: 'open' });
    expect(team.total).toBeGreaterThan(own.total);
    expect(new Set(view.leader!.team.map((p) => p.rung.code))).toEqual(new Set(['AAB', 'AGENT']));
  });

  it('P19.8-T2 AC-11 the day after the run, somebody reported yesterday only', async () => {
    (wired.clock as FixedClock).set(new Date('2026-11-08T03:00:00Z'));
    try {
      const team = (await read('agus@kpm0417.test')).leader!.team;
      expect(team.some((p) => (p.yesterday ?? 0) > 0 && !((p.today ?? 0) > 0))).toBe(true);
    } finally {
      (wired.clock as FixedClock).set(clock.now());
    }
  });

  it('P19.8-T2 AC-11 Dewi, an AAB who leads nobody, gets the leader block at zero; Rina, an Agent, none', async () => {
    const dewi = await read('dewi@kpm0417.test');
    expect(dewi.leader).toEqual({
      activeAgent: { count: 0, of: 0, unit: { count: 0, of: 0 }, aab: { count: 0, of: 0 } },
      coached7d: { count: 0, of: 0, unit: { count: 0, of: 0 }, aab: { count: 0, of: 0 } },
      team: [],
    });
    expect(dewi.newHires).toBe(0);
    const rina = await read('rina@kpm0417.test');
    expect(rina.leader).toBeNull();
    expect(rina.newHires).toBe(0);
  });

  it('a second run writes nothing', async () => {
    const before = await col('leads').countDocuments({});
    await seedDemo({ clock, log: quiet });
    expect(await col('leads').countDocuments({})).toBe(before);
  }, RUN_MS);
});
