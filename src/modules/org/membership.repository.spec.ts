import mongoose from 'mongoose';
import { RequestContext } from '@/common/context/request-context';
import { MissingTenantContextError } from '@/common/tenancy/tenant-scope.error';
import { clearCollections, startMongo, stopMongo } from '../../../test/mongo';
import { MembershipRepository } from './membership.repository';
import { Membership, MembershipSchema } from './membership.schema';

/**
 * **The named unscoped count refuses everyone but the Super Admin** (invariant §1; ADR-0156 §5). It answers how many
 * live members stand on a rung across every office of the company, so its only caller is the ladder's editor; anyone
 * else meets the tenancy backstop before the database is asked anything.
 */
describe('MembershipRepository.countHoldingRungAcrossTenants', () => {
  // No model method is reachable before the guard: a stub that throws if touched proves it.
  const untouchable = new Proxy({}, { get: () => { throw new Error('the model was asked'); } });
  const repository = new MembershipRepository(untouchable as never);

  it('P18.5-T1 AC-2 refuses a caller who is not a Super Admin, asking the database nothing', async () => {
    const member = new RequestContext('66f00000000000000000aa02', 'none', null);
    await expect(repository.countHoldingRungAcrossTenants(member, '66f0000000000000000000d1'))
      .rejects.toBeInstanceOf(MissingTenantContextError);
  });
});

/**
 * **The named cross-tenant reads Phase 19 added** (invariant §1; `named-cross-tenant-reads.tenancy.spec.ts` registers
 * who calls each): *All members*' list (P19.4-T3 AC-1, ADR-0207 §2), the template's agent-code test (P19.5-T1 AC-11,
 * ADR-0214 §7) and a linked login's office (UI-169 item 5, ADR-0199 §1). Each is narrowed to what it names — the offices
 * named, or the one login — and the two a Super Admin calls refuse anybody else before the database is asked anything.
 */
describe('MembershipRepository — the Phase 19 named cross-tenant reads', () => {
  const untouchable = new Proxy({}, { get: () => { throw new Error('the model was asked'); } });
  const guarded = new MembershipRepository(untouchable as never);
  const sa = RequestContext.platform('root');
  /** An Owner of KPM A: in an office, so in no position to read across offices. */
  const owner = new RequestContext('u-owner', 'none', {
    membershipId: 'mem-owner', kpmId: 'kpm-a', orgLevelCode: 'AB', hierarchyRole: 'ab', status: 'active',
    isKpmOwner: true, isKpmAdmin: false, directCount: 0,
  });

  describe('who may ask, before the database is asked', () => {
    it('P19.4-T3 AC-1 listMembershipsAcrossTenants refuses an Owner and a signed-in nobody, asking nothing', async () => {
      for (const ctx of [owner, new RequestContext('u-none', 'none', null)]) {
        await expect(guarded.listMembershipsAcrossTenants(ctx, ['kpm-a'])).rejects.toBeInstanceOf(MissingTenantContextError);
      }
    });

    it('P19.5-T1 AC-11 agentCodesInOfficesAcrossTenants refuses an Owner, asking nothing', async () => {
      await expect(guarded.agentCodesInOfficesAcrossTenants(owner, ['kpm-a'])).rejects.toBeInstanceOf(MissingTenantContextError);
    });

    it('P19.4-T3 AC-1, P19.5-T1 AC-11 no office named is nobody, for the Super Admin too — and no read at all', async () => {
      // An absent filter would be every office on the platform; an empty list names none.
      await expect(guarded.listMembershipsAcrossTenants(sa, [])).resolves.toEqual([]);
      await expect(guarded.agentCodesInOfficesAcrossTenants(sa, [])).resolves.toEqual([]);
      // P13.2-T3 AC-3: *Leaders used* for no office is an empty count, not a count of everyone.
      await expect(guarded.countPerOfficeAcrossTenants(sa, [], { status: 'active' })).resolves.toEqual(new Map());
    });

    it('P18-T8, P13.2-T3 AC-3 the platform’s counts across offices refuse an Owner too, asking nothing', async () => {
      const month = { start: new Date('2026-10-01T00:00:00Z'), endExclusive: new Date('2026-11-01T00:00:00Z') };
      const since = { days7: new Date('2026-10-30T00:00:00Z'), days30: new Date('2026-10-07T00:00:00Z') };
      const reads = [
        () => guarded.countPerOfficeAcrossTenants(owner, ['kpm-a'], {}),
        () => guarded.adoptionPerOfficeAcrossTenants(owner, month),
        () => guarded.signInsPerOfficeAcrossTenants(owner, since),
        () => guarded.distinctAccountsAcrossTenants(owner, [{ kpmId: 'kpm-a', companyId: 'co-1' }], since),
      ];
      for (const read of reads) await expect(read()).rejects.toBeInstanceOf(MissingTenantContextError);
    });
  });

  describe('what each answers, over a real database', () => {
    let repository: MembershipRepository;
    const KPM_A = '66f0000000000000000000a1';
    const KPM_B = '66f0000000000000000000b1';
    const KPM_C = '66f0000000000000000000c1';
    let seq = 0;

    beforeAll(async () => {
      await startMongo();
      repository = new MembershipRepository(mongoose.model(Membership.name, MembershipSchema) as never);
    });
    afterAll(stopMongo);
    beforeEach(async () => {
      await clearCollections();
      seq = 0;
    });

    /** A membership as the hierarchy writes one; `over` replaces any field. */
    async function member(kpmId: string, agentCode: string, over: Record<string, unknown> = {}) {
      seq += 1;
      const row = await mongoose.model(Membership.name).create({
        kpmId, userId: `66f00000000000000000ff${String(seq).padStart(2, '0')}`, role: 'agent', status: 'active',
        agentCode, agentSeq: seq, orgLevelId: 'level-agent', orgLevelCode: 'AGENT', leaderCode: `LC${seq}`,
        ...over,
      });
      return { id: String(row._id), userId: String(row.get('userId')) };
    }

    it('P19.4-T3 AC-1 lists every membership of the offices named — active, pending, removed — and nothing of any other', async () => {
      const active = await member(KPM_A, '7001');
      const pending = await member(KPM_A, '7002', { status: 'pending' });
      const removed = await member(KPM_B, '7003', { status: 'removed', removedAt: new Date('2026-10-01T00:00:00Z') });
      await member(KPM_A, '7004', { deletedAt: new Date('2026-10-02T00:00:00Z') });
      await member(KPM_C, '7005');

      const rows = await repository.listMembershipsAcrossTenants(sa, [KPM_A, KPM_B]);
      expect(rows.map((r) => String(r._id)).sort()).toEqual([active.id, pending.id, removed.id].sort());
      expect(rows.map((r) => r.status).sort()).toEqual(['active', 'pending', 'removed']);
      // The listed fields alone (ADR-0207 §2): never the leader code a joiner presents, nor the tree's path.
      for (const row of rows) {
        expect(row).not.toHaveProperty('leaderCode');
        expect(row).not.toHaveProperty('ancestorIds');
      }
    });

    it('P19.4-T3 AC-1 a filter narrows inside the offices named and never widens past them: kpmId is written last', async () => {
      const a = await member(KPM_A, '7001', { status: 'pending' });
      await member(KPM_A, '7002');
      await member(KPM_C, '7003', { status: 'pending' });

      expect((await repository.listMembershipsAcrossTenants(sa, [KPM_A], { status: 'pending' })).map((r) => String(r._id)))
        .toEqual([a.id]);
      // A filter naming another office still reads the offices the list names: KPM C stays out of reach.
      expect(await repository.listMembershipsAcrossTenants(sa, [KPM_A], { kpmId: KPM_C } as never)).toHaveLength(2);
    });

    it('P19.5-T1 AC-11 answers the codes of the offices named — active, live, distinct and sorted — and no blank one', async () => {
      await member(KPM_A, '70045002');
      await member(KPM_A, '70045001');
      await member(KPM_B, '70045001');
      await member(KPM_B, '70045009', { status: 'pending' });
      await member(KPM_B, '70045008', { status: 'removed' });
      await member(KPM_A, '70045007', { deletedAt: new Date('2026-10-02T00:00:00Z') });
      await member(KPM_C, '70045003');
      // A code nobody can test a pattern on: written raw, as a row from before codes were required would be.
      await mongoose.connection.collection('memberships').insertOne({
        kpmId: KPM_A, userId: 'raw', role: 'agent', status: 'active', agentCode: '   ', deletedAt: null,
      });

      expect(await repository.agentCodesInOfficesAcrossTenants(sa, [KPM_A, KPM_B])).toEqual(['70045001', '70045002']);
    });

    it('P18-T8 adoption counts by office: active by rung, joined by joinedAt and left by removedAt inside the month only', async () => {
      const inMonth = new Date('2026-10-15T00:00:00Z');
      const before = new Date('2026-09-15T00:00:00Z');
      await member(KPM_A, '7001', { joinedAt: inMonth });
      await member(KPM_A, '7002', { joinedAt: before, orgLevelCode: 'AB', role: 'ab' });
      await member(KPM_B, '7003', { joinedAt: before, status: 'removed', removedAt: inMonth });
      await member(KPM_B, '7004', { joinedAt: inMonth, deletedAt: inMonth });

      const counts = await repository.adoptionPerOfficeAcrossTenants(sa, {
        start: new Date('2026-10-01T00:00:00Z'), endExclusive: new Date('2026-11-01T00:00:00Z'),
      });
      expect(counts.byRung.sort((x, y) => x.orgLevelCode.localeCompare(y.orgLevelCode))).toEqual([
        { kpmId: KPM_A, orgLevelCode: 'AB', n: 1 }, { kpmId: KPM_A, orgLevelCode: 'AGENT', n: 1 },
      ]);
      expect(counts.joined).toEqual(new Map([[KPM_A, 1]]));
      expect(counts.left).toEqual(new Map([[KPM_B, 1]]));
    });

    it('P18-T8 accounts across offices nobody is a member of are nought, the platform’s included — never a missing row', async () => {
      await member(KPM_C, '7001');
      const since = { days7: new Date('2026-10-30T00:00:00Z'), days30: new Date('2026-10-07T00:00:00Z') };
      expect(await repository.distinctAccountsAcrossTenants(sa, [{ kpmId: KPM_A, companyId: 'co-1' }], since)).toEqual({
        companies: new Map(), platform: { members: 0, signedIn7d: 0, signedIn30d: 0 },
      });
    });

    describe('a linked login’s office (UI-169 item 5; ADR-0199 §1, §3)', () => {
      it('P19.2-T1 AC-8 answers the office, its status and whether it administers it — an Owner’s Admin flag included', async () => {
        const admin = await member(KPM_A, '7001', {
          adminAccess: { isKpmAdmin: true, grantedByUserId: 'u-owner', grantedAt: new Date('2026-10-01T00:00:00Z'), revokedAt: null },
        });
        const joining = await member(KPM_B, '7002', { status: 'pending' });

        expect(await repository.officeRoleOfLoginAcrossTenants(admin.userId))
          .toEqual({ kpmId: KPM_A, status: 'active', isKpmAdmin: true });
        expect(await repository.officeRoleOfLoginAcrossTenants(joining.userId))
          .toEqual({ kpmId: KPM_B, status: 'pending', isKpmAdmin: false });
      });

      it('P19.2-T1 AC-8 a membership written before admin access existed reads as no Admin, never as an error', async () => {
        await mongoose.connection.collection('memberships').insertOne({
          kpmId: KPM_A, userId: 'u-legacy', role: 'agent', status: 'active', agentCode: '7009', deletedAt: null,
        });
        expect(await repository.officeRoleOfLoginAcrossTenants('u-legacy'))
          .toEqual({ kpmId: KPM_A, status: 'active', isKpmAdmin: false });
      });

      it('P19.2-T1 AC-8 a login with no live office answers nothing: removed, deleted, or never a member', async () => {
        const left = await member(KPM_A, '7001', { status: 'removed' });
        const erased = await member(KPM_A, '7002', { deletedAt: new Date('2026-10-02T00:00:00Z') });
        for (const userId of [left.userId, erased.userId, '66f00000000000000000eeee']) {
          expect(await repository.officeRoleOfLoginAcrossTenants(userId)).toBeNull();
        }
      });
    });
  });
});
