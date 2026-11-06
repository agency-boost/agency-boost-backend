import mongoose from 'mongoose';
import { RequestContext } from '@/common/context/request-context';
import {
  KPM_A, KPM_B, ROSTER_NOW, seedTreeRecords, startComplianceHarness, stopComplianceHarness,
  type ComplianceHarness, type ComplianceWho,
} from '../../../../test/compliance-office';
import type { ComplianceView } from './compliance.service';

/**
 * **Compliance over one custom group** (P19.3-T3 AC-15, AC-16; UI-152 phase 2, the KPM Overview flow report's R5 and
 * case 13; OD-258): `?group=` on `GET /kpm/analytics/compliance`, over `test/compliance-office.ts` with a *Core Leader*
 * group of three — Agus, Sari and Indah — an archived group, and one of 0555's.
 */
describe('the compliance tree over one custom group (P19.3-T3 AC-15)', () => {
  let h: ComplianceHarness;
  let coreLeader: string;
  let archived: string;
  let ofB: string;
  const read = async (query: Record<string, string> = {}) =>
    (await h.http().get('/kpm/analytics/compliance').query(query).expect(200)).body as ComplianceView;
  const listed = (view: ComplianceView) => view.tree.flatMap((s) => s.units.flatMap((u) => u.rows.map((r) => r.name))).sort();

  beforeAll(async () => {
    h = await startComplianceHarness();
    await seedTreeRecords(h);
    const group = async (kpmId: string, name: string, status: 'active' | 'archived', members: ComplianceWho[]) => {
      const { insertedId } = await h.col('groups').insertOne({
        kpmId, name, ownerMembershipId: h.id('OWNER'), status, archivedAt: status === 'archived' ? ROSTER_NOW : null,
        createdByMembershipId: null, deletedAt: null, createdAt: ROSTER_NOW, updatedAt: ROSTER_NOW,
      });
      const id = String(insertedId);
      await h.col('memberships').updateMany(
        { _id: { $in: members.map((who) => new mongoose.Types.ObjectId(h.id(who))) } }, { $push: { groupIds: id } } as never,
      );
      return id;
    };
    coreLeader = await group(KPM_A, 'Core Leader', 'active', ['AGUS', 'SARI', 'INDAH']);
    archived = await group(KPM_A, 'Old circle', 'archived', ['DIMAS']);
    ofB = await group(KPM_B, 'Lina’s circle', 'active', ['B_AB']);
  }, 180_000);

  afterAll(async () => stopComplianceHarness(h));

  it('P19.3-T3 AC-15 offers the active groups, and with none chosen reads the whole KPM', async () => {
    h.as('OWNER');
    const view = await read();
    expect(view.groups).toEqual([{ groupId: coreLeader, name: 'Core Leader', memberCount: 3 }]);
    expect(view.group).toBeNull();
    expect(view.people).toBe(16);
  });

  it('P19.3-T3 AC-15 (Overview case 13) Core Leader: the tree, the sub-line and the six counts are its three people', async () => {
    h.as('OWNER');
    for (const category of ['training', 'goals', 'activity'] as const) {
      const view = await read({ category, group: coreLeader });
      expect(view.group).toEqual({ groupId: coreLeader, name: 'Core Leader', memberCount: 3 });
      expect(listed(view)).toEqual(['Agus Salim', 'Indah Permatasari', 'Sari Puspita']);
      expect(view.people).toBe(3);
      for (const chip of view.summary.filter((c) => c.category !== 'activation' && c.category !== 'events' && c.category !== 'campaigns')) {
        expect([category, chip.category, chip.of]).toEqual([category, chip.category, 3]);
      }
      // The tile is the list's sum (AC-9), over the group too.
      const training = view.summary.find((c) => c.category === 'training')!;
      if (category === 'training') expect(training.count).toBe(view.tree.reduce((n, s) => n + s.done, 0));
    }
  });

  it('P19.3-T3 AC-16 a Core Leader may name a group; an Agent is refused at the guard', async () => {
    const base = h.ctx('AGUS');
    h.as(new RequestContext(base.userId, 'none', { ...base.membership!, isCoreLeader: true }));
    expect((await read({ group: coreLeader })).people).toBe(3);
    h.as('INDAH');
    expect((await h.http().get('/kpm/analytics/compliance').query({ group: coreLeader }).expect(403)).body.error.code).toBe('PERM_DENIED');
  });

  it('P19.3-T3 AC-15 cross-tenant: another office’s group, an archived one or an unknown id is 404; 0555 cannot read 0417’s', async () => {
    h.as('OWNER');
    for (const id of [ofB, archived, String(new mongoose.Types.ObjectId()), 'nope']) {
      expect((await h.http().get('/kpm/analytics/compliance').query({ group: id }).expect(404)).body.error.code).toBe('NOT_FOUND');
    }
    expect((await h.http().get('/kpm/analytics/compliance').query({ group: 'x'.repeat(65) }).expect(400)).body.error.code)
      .toBe('VALIDATION_FAILED');
    h.as(h.ownerOfB());
    expect((await h.http().get('/kpm/analytics/compliance').query({ group: coreLeader }).expect(404)).body.error.code).toBe('NOT_FOUND');
    expect((await read({ group: ofB })).people).toBe(1);
  });
});
