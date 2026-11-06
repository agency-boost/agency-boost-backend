import mongoose from 'mongoose';
import {
  KPM_B, seedTreeRecords, startComplianceHarness, stopComplianceHarness, TODAY, type ComplianceHarness,
} from '../../../../test/compliance-office';
import { COMPLIANCE_CATEGORIES, type ComplianceCategoryKey } from './compliance-category';
import type { ComplianceView } from './compliance.service';

const M = 1_000_000 * 100;

/**
 * **KPM A never reads KPM B** (invariant §1; P18.3-T1 AC-1, a cross-tenant test per category). The tree resolves its
 * office from the reader's membership and every category reads through the tenant-scoped readers of the module that
 * owns its records, so:
 *
 * - **an item names nothing of another office**: 0555's own module, event or campaign asked of 0417 is 404 — the
 *   same answer as an item nobody has, never 403;
 * - **nothing of 0555 reaches 0417's tree**: a heavy dose of 0555 records in every category — training done, goals
 *   set, days logged, activations graduated — changes no chip and no cell of 0417's, and 0555's Owner reads 0555's
 *   members alone, with 0555's own statuses.
 */
describe('the compliance tree, isolated (invariant §1; P18.3-T1 AC-1)', () => {
  let h: ComplianceHarness;
  const db = () => mongoose.connection.db!;
  const T1: ComplianceCategoryKey[] = ['training', 'goals', 'activity', 'activation'];
  const rows = (view: ComplianceView) => view.tree.flatMap((s) => s.units.flatMap((u) => u.rows));

  beforeAll(async () => {
    h = await startComplianceHarness();
    await seedTreeRecords(h);
    // A module 0555 alone offers, published there.
    await h.wired.training.createModule(h.ownerOfB(), {
      code: 'GADING_ONLY', skillCode: 'CLOSING', title: 'Only in 0555', publishState: 'published',
    });
    await h.publish(KPM_B);
  }, 180_000);

  afterAll(() => stopComplianceHarness(h));

  /** Everything 0417's Owner reads, one category at a time — the audit's writes aside. */
  const snapshot = async () => {
    const out: Record<string, unknown> = {};
    for (const category of COMPLIANCE_CATEGORIES) out[category] = await h.compliance.read(h.ctx('OWNER'), { category });
    return out;
  };

  it('P18.3-T1 AC-1 training: 0555’s own module, asked of 0417, is 404 — the answer for a module nobody has', async () => {
    await expect(h.compliance.read(h.ctx('OWNER'), { category: 'training', item: 'GADING_ONLY' }))
      .rejects.toMatchObject({ code: 'NOT_FOUND' });
    await expect(h.compliance.read(h.ctx('OWNER'), { category: 'training', item: 'NOBODY_HAS_IT' }))
      .rejects.toMatchObject({ code: 'NOT_FOUND' });
    // 0555's Owner reads it.
    const view = await h.compliance.read(h.ownerOfB(), { category: 'training', item: 'GADING_ONLY' });
    expect(view.selected).toEqual({ category: 'training', item: 'GADING_ONLY' });
  });

  it('P18.3-T1 AC-1, P18.3-T2 events and campaigns: 0555’s own event and campaign, asked of 0417, are 404', async () => {
    const event = await h.wired.events.create(h.ownerOfB(), {
      code: 'GADING_TALK', typeCode: 'TRAINING', title: 'Gading talk', startsAt: '2026-10-20T02:00:00Z',
      endsAt: '2026-10-20T05:00:00Z', audience: { issuer: 'kpm', scope: 'all_agents' },
    });
    await h.wired.campaigns.create(h.ownerOfB(), {
      code: 'GADING_PUSH', title: 'Gading Push', startsAt: '2026-09-30T17:00:00Z', endsAt: '2026-12-31T16:59:59Z',
      reward: 'Unit budget', requirements: [{ metricKey: 'APE_ACHIEVED', comparator: 'gte', value: 500_000_000 * 100 }],
    });
    for (const [category, item] of [['events', event.id], ['campaigns', 'GADING_PUSH'], ['campaigns', 'gading_push']] as const) {
      await expect(h.compliance.read(h.ctx('OWNER'), { category, item })).rejects.toMatchObject({ code: 'NOT_FOUND' });
    }
    // 0555's Owner reads both, and 0417's lists neither.
    expect((await h.compliance.read(h.ownerOfB(), { category: 'events', item: event.id })).selected)
      .toEqual({ category: 'events', item: event.id });
    expect((await h.compliance.read(h.ownerOfB(), { category: 'campaigns', item: 'GADING_PUSH' })).selected)
      .toEqual({ category: 'campaigns', item: 'GADING_PUSH' });
    const mine = await h.compliance.read(h.ctx('OWNER'), { category: 'events' });
    expect(mine.catalog.events.map((e) => e.id)).not.toContain(event.id);
    expect(mine.catalog.campaigns.map((c) => c.code)).not.toContain('GADING_PUSH');
  });

  it('P18.3-T1 AC-1 a refused cross-office read writes no entry', async () => {
    const before = await db().collection('auditLog').countDocuments({});
    await expect(h.compliance.read(h.ctx('OWNER'), { category: 'training', item: 'GADING_ONLY' })).rejects.toBeTruthy();
    expect(await db().collection('auditLog').countDocuments({})).toBe(before);
  });

  /*
   * Exit review 1: an unscoped reader — one filtering by membership alone — passes the test below, because 0555's rows
   * carry 0555's members. These carry **0417's** membership ids under 0555's `kpmId`: only the office filter keeps them
   * out. Agus has none of his own in any category, so each planted row would move a chip and a cell if it were read.
   */
  it('P18.3-T1 AC-1 exit review 1: rows filed under another office carrying 0417’s membership ids move no chip and no cell', async () => {
    const before = await snapshot();
    const agus = h.id('AGUS');
    const lukas = h.id('LUKAS');
    const planted = { kpmId: KPM_B, plantedBy: 'compliance.tenancy.spec' };
    await db().collection('trainingProgress').insertMany(h.sales.map((moduleCode) => ({
      ...planted, membershipId: agus, moduleCode, status: 'done', startedAt: new Date('2026-09-01T03:00:00Z'),
      completedAt: new Date('2026-09-02T03:00:00Z'), opened: [], version: 1, deletedAt: null,
    })));
    await db().collection('goals').insertOne({
      ...planted, membershipId: agus, period: '2026', mode: 'direct', annualApeTargetMinor: 900 * M, savingsTargetMinor: 0,
      commissionRatePct: 0, monthsLeftOverride: null, apeAchievedMinor: 0, caseSizeMinor: 18 * M, leadsToApptPct: 30,
      closingRatePct: 30, savedAt: new Date('2026-01-05T02:00:00Z'), savedByMembershipId: agus, version: 1, deletedAt: null,
      cascadeMapping: { leadsCode: 'LEADS_CONTACTED', appointmentsCode: 'SELL_PRESENTATION', closingsCode: 'SELL_SUBMISSION' },
    });
    await db().collection('activityLogs').insertOne({
      ...planted, membershipId: agus, localDate: TODAY, entries: [], totalCount: 0, source: 'self',
      enteredByMembershipId: agus, version: 1, frozenAt: null, corrections: [], deletedAt: null,
    });
    const version = await h.col('activationTemplates').findOne({ kpmId: KPM_B, status: 'published' });
    await db().collection('activationProgress').insertMany([agus, lukas].map((membershipId) => ({
      ...planted, membershipId, templateId: String(version!._id), templateVersion: version!.version, startDate: '2026-03-01',
      startCorrectedAt: null, startCorrectedByMembershipId: null, origin: 'joined', items: [], note: null,
      graduatedAt: new Date('2026-05-01T03:00:00Z'), graduatedByMembershipId: membershipId, version: 2, deletedAt: null,
      createdAt: new Date('2026-09-13T03:00:00Z'),
    })));

    try {
      expect(await snapshot()).toEqual(before);
      // And what they would have moved, named: Agus's cells are as his own office's records say.
      const cell = async (category: ComplianceCategoryKey) => rows(await h.compliance.read(h.ctx('OWNER'), { category }))
        .find((r) => r.membershipId === agus)!.cell;
      expect(await cell('training')).toEqual({ status: 'not_started', done: false, on: null });
      expect(await cell('goals')).toEqual({ status: 'not_set', done: false, on: null });
      expect(await cell('activity')).toEqual({ status: 'missed', done: false, on: null });
      expect(await cell('activation')).toEqual({ status: null, done: null, on: null, endedOn: null });
    } finally {
      for (const name of ['trainingProgress', 'goals', 'activityLogs', 'activationProgress']) {
        await db().collection(name).deleteMany({ plantedBy: 'compliance.tenancy.spec' });
      }
    }
  });

  it.each(T1)('P18.3-T1 AC-1 %s: nothing of 0555 reaches 0417’s tree, and 0555’s Owner reads 0555 alone', async (category) => {
    const before = await snapshot();
    // 0555 grows, in every category: twenty Agents under its AB with everything done, set, logged and graduated.
    const bAb = h.id('B_AB');
    const people = Array.from({ length: 20 }, () => String(new mongoose.Types.ObjectId()));
    await db().collection('memberships').insertMany(people.map((id, i) => ({
      _id: new mongoose.Types.ObjectId(id), kpmId: KPM_B, userId: String(new mongoose.Types.ObjectId()), agentCode: `B${category}${i}`,
      agentSeq: 1000 + i, leaderCode: `B${i}${category}`.slice(0, 8), orgLevelId: 'x', orgLevelCode: 'AGENT', role: 'agent',
      leaderId: bAb, ancestorIds: [bAb], depth: 1, status: 'active', joinedAt: new Date('2026-01-02T02:00:00Z'), deletedAt: null,
    })));
    const job = { kpmId: KPM_B };
    await db().collection('trainingProgress').insertMany(people.flatMap((id) => h.sales.map((moduleCode) => ({
      ...job, membershipId: id, moduleCode, status: 'done', startedAt: new Date('2026-09-01T03:00:00Z'),
      completedAt: new Date('2026-09-02T03:00:00Z'), opened: [], version: 1, deletedAt: null,
    }))));
    await db().collection('goals').insertMany(people.map((id) => ({
      ...job, membershipId: id, period: '2026', mode: 'direct', annualApeTargetMinor: 900 * M, savingsTargetMinor: 0,
      commissionRatePct: 0, monthsLeftOverride: null, apeAchievedMinor: 0, caseSizeMinor: 18 * M, leadsToApptPct: 30,
      closingRatePct: 30, savedAt: new Date('2026-01-05T02:00:00Z'), savedByMembershipId: id, version: 1, deletedAt: null,
      cascadeMapping: { leadsCode: 'LEADS_CONTACTED', appointmentsCode: 'SELL_PRESENTATION', closingsCode: 'SELL_SUBMISSION' },
    })));
    await db().collection('activityLogs').insertMany(people.map((id) => ({
      ...job, membershipId: id, localDate: TODAY, entries: [], totalCount: 0, source: 'self',
      enteredByMembershipId: id, version: 1, frozenAt: null, corrections: [], deletedAt: null,
    })));
    const version = await h.col('activationTemplates').findOne({ kpmId: KPM_B, status: 'published' });
    await db().collection('activationProgress').insertMany(people.map((id) => ({
      ...job, membershipId: id, templateId: String(version!._id), templateVersion: version!.version, startDate: '2026-03-01',
      startCorrectedAt: null, startCorrectedByMembershipId: null, origin: 'joined', items: [], note: null,
      graduatedAt: new Date('2026-05-01T03:00:00Z'), graduatedByMembershipId: id, version: 2, deletedAt: null,
      createdAt: new Date('2026-03-01T03:00:00Z'),
    })));

    try {
      const after = await snapshot();
      expect(after).toEqual(before);

      const b = await h.compliance.read(h.ownerOfB(), { category });
      const ids = rows(b).map((r) => r.membershipId);
      expect(ids.sort()).toEqual([bAb, h.id('B_AGENT'), ...people].sort());
      // 0555's records are 0555's: every Agent of the twenty done in their own office's terms.
      const done = rows(b).filter((r) => people.includes(r.membershipId) && r.cell.done === true);
      expect([category, done.length]).toEqual([category, 20]);
    } finally {
      for (const name of ['memberships', 'trainingProgress', 'goals', 'activityLogs', 'activationProgress']) {
        await db().collection(name).deleteMany({ membershipId: { $in: people } });
      }
      await db().collection('memberships').deleteMany({ _id: { $in: people.map((id) => new mongoose.Types.ObjectId(id)) } });
    }
  });
});
