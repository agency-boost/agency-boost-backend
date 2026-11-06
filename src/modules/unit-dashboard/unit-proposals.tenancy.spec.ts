import mongoose from 'mongoose';
import { FixedClock } from '@/common/clock/clock.port';
import { MemberNames } from '@/modules/org/member-names.service';
import { DataUploadBatch, DataUploadBatchSchema } from '@/modules/production/data-upload-batch.schema';
import { DataUploadBatchRepository } from '@/modules/production/data-upload-batch.repository';
import { TenantDay } from '@/modules/tenants/tenant-day.service';
import { clearCollections, startMongo, stopMongo } from '../../../test/mongo';
import { configModule } from '../../../test/config-module';
import {
  AAB, AGENT, NOW, SIBLING, aab, ab, agent, agentB, completeProposal, seedProposalOffice, sibling, type SeededLeads,
} from '../../../test/proposals';
import { UnitDashboardService, type UnitDashboardView, type UnitRow } from './unit-dashboard.service';

/**
 * **P19.7-T2 AC-13 — `PROPOSALS_MADE` on the Unit Dashboard** (ADR-0221 §7; §A.16; decision 4): each person's live
 * proposals first saved as a PDF within the period, summed into the totals — and nothing about any client, product or
 * premium. It rides `unit_dashboard:read`'s reach, so it needs no grant of its own.
 */
describe('P19.7-T2 AC-13 the Unit Dashboard’s Proposal count', () => {
  let wired: ReturnType<typeof configModule>;
  let leads: SeededLeads;
  const clock = () => wired.clock as FixedClock;

  beforeAll(async () => {
    await startMongo();
    wired = configModule(NOW);
  });
  afterAll(stopMongo);
  beforeEach(async () => {
    clock().set(NOW);
    await clearCollections();
    leads = await seedProposalOffice(wired);
  });

  const finished = async (who: typeof agent, leadId: string, at: Date) => {
    clock().set(at);
    const p = await completeProposal(wired, who(), leadId);
    const done = await wired.proposals.done(who(), p.id, p.version);
    clock().set(NOW);
    return done;
  };
  const rows = (view: UnitDashboardView): UnitRow[] => [
    ...view.yourUnit.rows, ...view.units.flatMap(function all(g): UnitRow[] { return [g.head, ...g.members, ...g.units.flatMap(all)]; }),
  ];
  const row = (view: UnitDashboardView, id: string) => rows(view).find((r) => r.membershipId === id)!;

  it('P19.7-T2 AC-13 counts each person’s proposals first saved in the period; a draft never counts (Acc. 22)', async () => {
    await finished(agent, leads.budi, new Date('2026-11-02T03:00:00Z'));
    await finished(agent, leads.budi, new Date('2026-10-20T03:00:00Z'));
    await finished(sibling, leads.siblings, new Date('2026-11-04T03:00:00Z'));
    await wired.proposals.create(agent(), leads.budi);

    const month = await wired.unitDashboard.read(aab(), { period: 'month' });
    expect(row(month, AGENT).proposalsMade).toBe(1);
    expect(row(month, SIBLING).proposalsMade).toBe(1);
    expect(row(month, AAB).proposalsMade).toBe(0);
    const year = await wired.unitDashboard.read(aab(), { period: 'year' });
    expect(row(year, AGENT).proposalsMade).toBe(2);
  });

  it('P19.7-T2 AC-13 sums the rows into the totals, and the AB reads the AAB’s unit the same way', async () => {
    await finished(agent, leads.budi, new Date('2026-11-02T03:00:00Z'));
    await finished(sibling, leads.siblings, new Date('2026-11-03T03:00:00Z'));
    const view = await wired.unitDashboard.read(ab(), { period: 'month' });
    const unit = view.units.find((g) => g.head.membershipId === AAB)!;
    expect(unit.total.proposalsMade).toBe(2);
    expect(view.yourUnit.total.proposalsMade).toBe(0);
  });

  it('P19.7-T2 AC-13 a proposal saved again counts once, in the period of its first save; a deleted one leaves the count', async () => {
    let p = await finished(agent, leads.budi, new Date('2026-10-30T03:00:00Z'));
    p = await wired.proposals.update(agent(), p.id, { expectedVersion: p.version, showTotal: true });
    p = await wired.proposals.done(agent(), p.id, p.version);
    expect(row(await wired.unitDashboard.read(aab(), { period: 'month' }), AGENT).proposalsMade).toBe(0);
    expect(row(await wired.unitDashboard.read(aab(), { period: 'year' }), AGENT).proposalsMade).toBe(1);
    await wired.proposals.remove(agent(), p.id, p.version);
    expect(row(await wired.unitDashboard.read(aab(), { period: 'year' }), AGENT).proposalsMade).toBe(0);
  });

  it('P19.7-T2 AC-13 carries the count and nothing of a proposal: no client, no product, no premium on any row', async () => {
    await finished(agent, leads.budi, new Date('2026-11-02T03:00:00Z'));
    const text = JSON.stringify(await wired.unitDashboard.read(aab(), { period: 'month' }));
    for (const word of ['Pak Budi', 'PRUWell', '50000000']) expect(text).not.toContain(word);
  });

  it('P19.7-T2 AC-13 ADR-0163 §4 built without its two optional readers, every row reads 0 proposals and the activity counts the default binding', async () => {
    await finished(agent, leads.budi, new Date('2026-11-02T03:00:00Z'));
    const batches = mongoose.models[DataUploadBatch.name] ?? mongoose.model(DataUploadBatch.name, DataUploadBatchSchema);
    const bare = new UnitDashboardService(
      wired.coach, new MemberNames(wired.memberships, wired.users as never, wired.avatarLinks), wired.orgLevels,
      new TenantDay(wired.kpms as never, wired.clock), wired.coachingReadings, wired.paceStatus, wired.goals,
      wired.productionReadings, wired.productionMonths, wired.productionCorrections, wired.activityReadings, wired.leadReadings,
      wired.subjectReads, wired.campaignChaseReadings, wired.memberships, new DataUploadBatchRepository(batches as never),
    );
    const full = await wired.unitDashboard.read(aab(), { period: 'month' });
    const without = await bare.read(aab(), { period: 'month' });
    expect(row(full, AGENT).proposalsMade).toBe(1);
    expect(rows(without).map((r) => [r.membershipId, r.proposalsMade])).toEqual(rows(full).map((r) => [r.membershipId, 0]));
    // The office binds the cascade as the defaults do, so its activity cells are the same either way.
    expect(rows(without).map((r) => r.activity)).toEqual(rows(full).map((r) => r.activity));
  });

  it('P19.7-T2 AC-13 another office’s proposals reach no row (cross-tenant)', async () => {
    await finished(agentB, leads.officeB, new Date('2026-11-02T03:00:00Z'));
    const view = await wired.unitDashboard.read(aab(), { period: 'year' });
    expect(rows(view).reduce((sum, r) => sum + r.proposalsMade, 0)).toBe(0);
    expect((await wired.proposalReadings.madeByMany(aab(), [agentB().membershipId!], { from: '2026-01-01', to: '2026-12-31' }, 'Asia/Jakarta')).get(agentB().membershipId!)).toBe(0);
  });
});
