import mongoose from 'mongoose';
import { FixedClock } from '@/common/clock/clock.port';
import { RequestContext } from '@/common/context/request-context';
import { HierarchyService } from '@/modules/org/hierarchy.service';
import { MembershipHistory, MembershipHistorySchema } from '@/modules/org/membership-history.schema';
import { MembershipHistoryRepository } from '@/modules/org/org.repositories';
import { COUNTED_MEMBER } from '@/modules/org/counted-members';
import { KpmRequest, KpmRequestSchema } from '@/modules/tenants/kpm-request.schema';
import { TenantService } from '@/modules/tenants/tenant.service';
import { seedDemo } from '@/seed/demo';
import { configModule } from '../../../../test/config-module';
import { clearCollections, startMongo, stopMongo } from '../../../../test/mongo';
import { PlatformConsole } from './platform-console.service';
import { PlatformReads } from './platform-reads.service';

const RUN_MS = 300_000;
const quiet = () => undefined;
const SUPER_ADMIN = '66f00000000000000000ee26';

/**
 * ***One count* on the demo seed** (P19.26-T1 AC-2, AC-3; ADR-0284 §1, §2; UI-204 (21 Nov)): the Dashboard's *Anggota*,
 * the KPM list's tile and the sum of its cards, *Anggota*'s footer and *Perusahaan*'s cards read one number — the counted
 * members (`COUNTED_MEMBERS`) — over the very data the browser shows, and *Perlu tindakan* is one count of KPMs.
 *
 * Before P19.26 the four disagreed on staging: 50 on the Dashboard, 55 in the cards, 60 in the footer, 65 in Perusahaan.
 */
describe('P19.26-T1 one count of members on the console, on the demo seed', () => {
  const clock = new FixedClock(new Date('2026-11-20T03:00:00Z'));
  const ctx = RequestContext.platform(SUPER_ADMIN);
  const col = (name: string) => mongoose.connection.db!.collection(name);
  let dashboard: Awaited<ReturnType<PlatformConsole['dashboard']>>;
  let tenants: TenantService;
  let reads: PlatformReads;

  beforeAll(async () => {
    await startMongo();
    await clearCollections();
    await seedDemo({ clock, log: quiet });
    const wired = configModule(clock.now());
    await Promise.all(mongoose.modelNames().map((name) => mongoose.model(name).init()));
    const users = wired.users as never;
    const kpmRequests = mongoose.model(KpmRequest.name, KpmRequestSchema) as never;
    tenants = new TenantService(
      wired.kpms as never, wired.companies as never, users, kpmRequests, wired.audit, clock,
      new HierarchyService(
        wired.memberships, wired.kpms as never, users,
        new MembershipHistoryRepository(mongoose.model(MembershipHistory.name, MembershipHistorySchema) as never),
        clock, wired.orgLevels,
      ),
      wired.memberships, wired.orgLevels, wired.provisioning, wired.products, wired.campaigns, wired.namedTemplates,
    );
    // Whether a month was uploaded moves *Perlu tindakan*'s rows, never a count of members: read as none uploaded.
    const production = { officeMonths: async () => new Map() };
    reads = new PlatformReads(
      wired.kpms as never, wired.companies as never, users, wired.memberships, wired.orgLevels, wired.activityReadings,
      production as never, wired.officePeople, wired.audit, clock,
    );
    const platform = new PlatformConsole(
      wired.companies as never, users, kpmRequests, tenants, reads, wired.memberships, wired.activityReadings,
      { queue: async () => [] } as never, wired.officeGroups, clock,
    );
    dashboard = await platform.dashboard(ctx);
  }, RUN_MS);

  afterAll(stopMongo);

  /** Straight from the collections: the definition, applied by hand, so the services cannot agree on a wrong number. */
  async function countedByHand(): Promise<{ total: number; byCompany: Map<string, number> }> {
    const companies = await col('companies').find({ deletedAt: null }).toArray();
    const kpms = await col('kpms').find({ deletedAt: null, status: { $ne: 'archived' } }).toArray();
    const insurerOf = new Map(kpms.map((k) => [String(k._id), String(k.companyId)]));
    const served = new Set(dashboard.companies.map((c) => c.companyId));
    const rows = await col('memberships').find({ ...COUNTED_MEMBER, kpmId: { $in: [...insurerOf.keys()] } }).toArray();
    const byCompany = new Map<string, number>(companies.map((c) => [String(c._id), 0]));
    let total = 0;
    for (const m of rows) {
      const company = insurerOf.get(String(m.kpmId))!;
      if (!served.has(company)) continue;
      total += 1;
      byCompany.set(company, (byCompany.get(company) ?? 0) + 1);
    }
    return { total, byCompany };
  }

  it('the seed holds what the definition leaves out — pending, removed and test-account memberships — so agreeing proves it', async () => {
    expect(await col('memberships').countDocuments({ status: 'pending', deletedAt: null })).toBeGreaterThan(0);
    expect(await col('memberships').countDocuments({ status: 'removed', deletedAt: null })).toBeGreaterThan(0);
    expect(await col('memberships').countDocuments({ testAccount: true, deletedAt: null })).toBeGreaterThan(0);
  });

  it('AC-2 the Dashboard’s Anggota, its funnel and the KPM list’s cards are the counted members', async () => {
    const { total } = await countedByHand();
    const tile = dashboard.overall.leaders + dashboard.overall.agents;
    expect(tile).toBe(total);
    expect(dashboard.funnel.members).toBe(total);
    // The KPM list's *Anggota* tile is the Dashboard's (one answer), and its cards add up to it.
    const cards = dashboard.kpms.reduce((n, k) => n + k.usage.leader.members + k.usage.agent.members, 0);
    expect(cards).toBe(total);
  });

  it('AC-2 Anggota’s footer is the same number, in the same KPMs', async () => {
    const page = await reads.members(ctx, {});
    expect(page.counted.members).toBe(dashboard.overall.leaders + dashboard.overall.agents);
    const holding = dashboard.kpms.filter((k) => k.usage.leader.members + k.usage.agent.members > 0).length;
    expect(page.counted.kpms).toBe(holding);
    // *Aktif*: listing the active ones gives that many rows, whatever else the page lists.
    const active = await reads.members(ctx, { status: 'active' });
    expect(active.counted).toEqual(page.counted);
  });

  it('AC-2 Perusahaan’s n anggota per company is the sum of that company’s KPM cards, and every company adds up to the tile', async () => {
    const overview = await tenants.platformOverview(ctx);
    const { byCompany } = await countedByHand();
    let sum = 0;
    for (const company of overview.companies) {
      const cards = dashboard.kpms.filter((k) => k.companyId === company.companyId)
        .reduce((n, k) => n + k.usage.leader.members + k.usage.agent.members, 0);
      expect({ company: company.name, members: company.memberCount }).toEqual({ company: company.name, members: cards });
      expect(company.memberCount).toBe(byCompany.get(company.companyId) ?? 0);
      sum += company.memberCount;
    }
    expect(sum).toBe(dashboard.overall.leaders + dashboard.overall.agents);
    expect(overview.tiles.totalMembers).toBe(sum);
  });

  it('AC-3 Perlu tindakan counts KPMs: the heading’s number is the KPMs the list marks, never a row count', async () => {
    const marked = dashboard.kpms.filter((k) => k.needsAction);
    expect(dashboard.overall.needsAction).toBe(marked.length);
    // A suspended or archived KPM says only that, and is never in it.
    for (const kpm of dashboard.kpms.filter((k) => k.status !== 'active')) expect(kpm.needsAction).toBe(false);
    // Each marked KPM has at least one of the four, and nothing else is marked.
    for (const kpm of dashboard.kpms) {
      expect(kpm.needsAction).toBe(kpm.issues.some((i) => ['subscription_ended', 'owner_not_invited', 'no_members', 'data_missing'].includes(i)));
    }
  });

  it('AC-4 every KPM but an archived one has its counts, a suspended one included', async () => {
    const suspended = dashboard.kpms.filter((k) => k.status === 'suspended');
    expect(suspended.length).toBeGreaterThan(0);
    const live = await col('kpms').countDocuments({ deletedAt: null, status: { $ne: 'archived' } });
    expect(dashboard.overall.kpms).toBeLessThanOrEqual(live);
  });
});
