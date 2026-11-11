import mongoose from 'mongoose';
import { RequestContext } from '@/common/context/request-context';
import { Group, GroupSchema } from '@/modules/org/group.schema';
import { GroupService } from '@/modules/org/group.service';
import { MemberNames } from '@/modules/org/member-names.service';
import { GroupRepository } from '@/modules/org/org.repositories';
import { TenantDay } from '@/modules/tenants/tenant-day.service';
import { clearCollections, startMongo, stopMongo } from '../../../test/mongo';
import { configModule } from '../../../test/config-module';
import {
  buildCoachingOffice, COMPANY, KPM_A, KPM_B, ROSTER_NOW, type CoachingOffice,
} from '../../../test/coaching-office';
import type { UnitDashboardView, UnitGroup, UnitRow } from './unit-dashboard.service';
import { UnitPotensiService } from './unit-potensi.service';

const rowsOf = (g: UnitGroup): UnitRow[] => [g.head, ...g.members, ...g.units.flatMap(rowsOf)];
const everyRow = (v: UnitDashboardView): UnitRow[] => [...v.yourUnit.rows, ...v.units.flatMap(rowsOf), ...(v.unled?.rows ?? [])];
const names = (v: UnitDashboardView) => everyRow(v).map((r) => r.name).sort();

/**
 * **The Unit Dashboard's three views, read** (P19.12-T6; the client's message of 11 November 2026, items 5 and 7;
 * ADR-0249). The coaching office (`test/coaching-office.ts`), and below Agus **an AB of his own** — Hadi, with an agent —
 * and in office A **somebody with no leader**, Nora. So:
 *
 * ```
 * OWNER Wilson ─┬─ ADMIN Maya (AB)                    every one of Wilson's reports is an AB:
 *               ├─ AGUS (AB) ─┬─ … his eleven          his own direct group is himself
 *               │             └─ HADI (AB) ── HANA      an AB below Agus: not his AAB
 *               └─ PEER_AB ── PEER_AAB ── PEER_AGENT
 * NORA (agent, no leader)
 * ```
 */
describe('P19.12-T6 the Unit Dashboard’s views (ADR-0249)', () => {
  let wired: ReturnType<typeof configModule>;
  let office: CoachingOffice;
  let potensi: UnitPotensiService;
  let groups: GroupService;
  const id: Record<'HADI' | 'HANA' | 'NORA', string> = { HADI: '', HANA: '', NORA: '' };
  const db = () => mongoose.connection.db!;
  const oid = (s: string) => new mongoose.Types.ObjectId(s);

  /** A group, written as `GroupService.create` would, in the office given. */
  const group = async (owner: string, name: string, over: Record<string, unknown> = {}, kpmId = KPM_A) => {
    const _id = new mongoose.Types.ObjectId();
    await db().collection('groups').insertOne({
      _id, kpmId, name, ownerMembershipId: owner, status: 'active', archivedAt: null, createdByMembershipId: null,
      deletedAt: null, ...over,
    });
    return String(_id);
  };
  const tag = (membershipId: string, groupIds: string[]) => db().collection('memberships').updateOne(
    { _id: new mongoose.Types.ObjectId(membershipId) }, { $set: { groupIds } },
  );
  const read = (ctx: RequestContext, query: Parameters<typeof wired.unitDashboard.read>[1] = {}) => wired.unitDashboard.read(ctx, query);
  /** Lina, office B's root, as its Owner. */
  const bOwner = () => {
    const b = office.as('B_AB');
    return new RequestContext(b.userId, 'none', { ...b.membership!, isKpmOwner: true });
  };

  beforeAll(async () => {
    await startMongo();
    wired = configModule(ROSTER_NOW);
    await clearCollections();
    office = await buildCoachingOffice(wired);
    const place = async (key: keyof typeof id, fullName: string, role: string, leader: string | null, ancestors: string[]) => {
      const userId = new mongoose.Types.ObjectId();
      await db().collection('users').insertOne({
        _id: userId, email: `${key.toLowerCase()}@views.test`, passwordHash: 'x', fullName, status: 'active',
        platformRole: 'none', companyId: COMPANY, deletedAt: null,
      });
      const membershipId = new mongoose.Types.ObjectId();
      await db().collection('memberships').insertOne({
        _id: membershipId, kpmId: KPM_A, userId: String(userId), agentCode: `V-${key}`, agentSeq: 900 + Object.keys(id).indexOf(key),
        leaderCode: `V${key}`, orgLevelId: 'x', orgLevelCode: role.toUpperCase(), role, leaderId: leader, ancestorIds: ancestors,
        depth: ancestors.length, status: 'active', joinedAt: new Date('2026-01-02T02:00:00Z'), deletedAt: null, groupIds: [],
      });
      id[key] = String(membershipId);
    };
    await place('HADI', 'Hadi Wibowo', 'ab', office.id.AGUS, [office.id.OWNER, office.id.AGUS]);
    await place('HANA', 'Hana Pertiwi', 'agent', id.HADI, [office.id.OWNER, office.id.AGUS, id.HADI]);
    await place('NORA', 'Nora Siregar', 'agent', null, []);
    potensi = new UnitPotensiService(
      wired.unitDashboard, new TenantDay(wired.kpms as never, wired.clock), wired.clock, wired.leadReadings,
      wired.productionReadings, wired.coach, wired.orgLevels, new MemberNames(wired.memberships, wired.users as never),
      wired.memberships, wired.subjectReads, wired.users as never,
    );
    const model = mongoose.models[Group.name] ?? mongoose.model(Group.name, GroupSchema);
    groups = new GroupService(new GroupRepository(model as never), wired.memberships, wired.users as never, wired.audit, wired.clock);
  }, 120_000);
  afterAll(stopMongo);
  afterEach(async () => {
    await db().collection('groups').deleteMany({});
    await db().collection('memberships').updateMany({}, { $set: { groupIds: [] } });
  });

  describe('AC-1 Grup langsung: an AB below is not your AAB (item 5)', () => {
    it('P19.12-T6 AC-1 Agus’s dashboard opens on Grup langsung: his eleven, never Hadi nor Hadi’s agent', async () => {
      const view = await read(office.as('AGUS'));
      expect(view.scope).toBe('direct');
      expect(view.scopes).toEqual({ offered: ['direct', 'informal', 'downline'], default: 'direct' });
      expect(names(view)).not.toEqual(expect.arrayContaining(['Hadi Wibowo']));
      expect(everyRow(view).map((r) => r.membershipId)).not.toContain(id.HANA);
      expect(view.tiles.team).toEqual({ total: 11, direct: 3, units: 3, underUnits: 5, aab: 8, ab: 0, newHires: 0 });
      expect(view.tiles.potentialActive.ab).toEqual({ count: 0, of: 0 });
      expect(view.informal).toBeNull();
      expect(view.unled).toBeNull();
    });

    it('P19.12-T6 AC-1 Semua downline adds Hadi’s unit — counted under AB, never AAB — and the three chips add up', async () => {
      const view = await read(office.as('AGUS'), { scope: 'downline' });
      expect(view.scope).toBe('downline');
      const hadi = view.units.find((u) => u.head.membershipId === id.HADI)!;
      expect(rowsOf(hadi).map((r) => r.name)).toEqual(['Hadi Wibowo', 'Hana Pertiwi']);
      expect(view.tiles.team).toMatchObject({ total: 13, direct: 3, aab: 8, ab: 2 });
      const { team, potentialActive: active } = view.tiles;
      expect(team.direct + team.aab + team.ab).toBe(team.total);
      expect(active.unit.of + active.aab.of + active.ab.of).toBe(active.of);
      expect(active.ab.of).toBe(2);
    });

    it('P19.12-T6 AC-1 Activities’ and Home’s Group is Grup langsung: Hadi is in neither', async () => {
      const people = await wired.unitDashboard.people(office.as('AGUS'));
      expect(people.scope).toBe('direct');
      expect(people.group).toHaveLength(11);
      expect(people.group).not.toContain(id.HADI);
      const activities = await wired.unitActivities.read(office.as('AGUS'), {});
      expect(JSON.stringify(activities)).not.toContain('Hadi Wibowo');
    });
  });

  describe('AC-2, AC-4 Grup informal', () => {
    it('P19.12-T6 AC-4 with nothing tagged it is Grup langsung, and says one AB below is not in a group — no names to an AB', async () => {
      const view = await read(office.as('AGUS'), { scope: 'informal' });
      expect(view.scope).toBe('informal');
      expect(everyRow(view)).toHaveLength(11);
      expect(view.informal).toEqual({ groups: [], absNotInGroup: 1, abs: null, canTag: false });
    });

    it('P19.12-T6 AC-2 Hadi tagged into Agus’s live group brings Hadi and his agent; the line reads 0', async () => {
      const mine = await group(office.id.AGUS, 'Agus Circle');
      await tag(id.HADI, [mine]);
      const view = await read(office.as('AGUS'), { scope: 'informal' });
      expect(everyRow(view).map((r) => r.membershipId)).toEqual(expect.arrayContaining([id.HADI, id.HANA]));
      expect(view.tiles.team).toMatchObject({ total: 13, ab: 2 });
      expect(view.informal).toMatchObject({ groups: [{ groupId: mine, name: 'Agus Circle' }], absNotInGroup: 0 });
    });

    it('P19.12-T6 AC-2 an archived group, or somebody else’s, tags nobody into Agus’s view', async () => {
      const archived = await group(office.id.AGUS, 'Old circle', { status: 'archived', archivedAt: ROSTER_NOW });
      const saris = await group(office.id.SARI, 'Sari Circle');
      await tag(id.HADI, [archived, saris]);
      const view = await read(office.as('AGUS'), { scope: 'informal' });
      expect(everyRow(view).map((r) => r.membershipId)).not.toContain(id.HADI);
      expect(view.informal).toMatchObject({ groups: [], absNotInGroup: 1 });
    });

    it('P19.12-T6 AC-2 a tag never widens reach (P3-T9 AC-1): Sari’s group holding a peer AB shows Sari nobody new', async () => {
      const saris = await group(office.id.SARI, 'Sari Circle');
      await tag(office.id.PEER_AB, [saris]);
      await tag(office.id.PEER_AGENT, [saris]);
      const before = await read(office.as('SARI'));
      const view = await read(office.as('SARI'), { scope: 'informal' });
      expect(view.scope).toBe('informal');
      expect(names(view)).toEqual(names(before));
      // And nobody else's reach moves either: Agus still reads his eleven.
      expect(everyRow(await read(office.as('AGUS')))).toHaveLength(11);
    });

    it('P19.12-T6 AC-2 cross-tenant: office B’s group, even naming Agus its owner and tagging Hadi, is never read', async () => {
      const forged = await group(office.id.AGUS, 'Forged', {}, KPM_B);
      await tag(id.HADI, [forged]);
      const view = await read(office.as('AGUS'), { scope: 'informal' });
      expect(view.informal).toMatchObject({ groups: [], absNotInGroup: 1 });
      expect(everyRow(view).map((r) => r.membershipId)).not.toContain(id.HADI);
    });

    it('P19.12-T6 AC-4 the Owner reading Agus’s unit is named the AB to tag, and may tag', async () => {
      const view = await read(office.as('OWNER'), { for: office.id.AGUS, scope: 'informal' });
      expect(view.readOnly).toBe(true);
      expect(view.informal).toEqual({ groups: [], absNotInGroup: 1, abs: [{ membershipId: id.HADI, name: 'Hadi Wibowo' }], canTag: true });
    });

    it('P19.12-T6 AC-4 two ABs of one name are named in one order — by id, not by who joined first — so two reads never shuffle them', async () => {
      // A namesake below Agus who joined after Hadi (a later `agentSeq`) on a smaller id.
      const twin = '5f00000000000000000000a5';
      const userId = new mongoose.Types.ObjectId();
      await db().collection('users').insertOne({
        _id: userId, email: 'twin@views.test', passwordHash: 'x', fullName: 'Hadi Wibowo', status: 'active',
        platformRole: 'none', companyId: COMPANY, deletedAt: null,
      });
      await db().collection('memberships').insertOne({
        _id: oid(twin), kpmId: KPM_A, userId: String(userId), agentCode: 'V-TWIN', agentSeq: 950, leaderCode: 'VTWIN',
        orgLevelId: 'x', orgLevelCode: 'AB', role: 'ab', leaderId: office.id.AGUS, ancestorIds: [office.id.OWNER, office.id.AGUS],
        depth: 2, status: 'active', joinedAt: new Date('2026-03-02T02:00:00Z'), deletedAt: null, groupIds: [],
      });
      try {
        const first = await read(office.as('OWNER'), { for: office.id.AGUS, scope: 'informal' });
        expect(first.informal).toEqual({
          groups: [], absNotInGroup: 2, canTag: true,
          abs: [{ membershipId: twin, name: 'Hadi Wibowo' }, { membershipId: id.HADI, name: 'Hadi Wibowo' }],
        });
        expect((await read(office.as('OWNER'), { for: office.id.AGUS, scope: 'informal' })).informal).toEqual(first.informal);
      } finally {
        await db().collection('memberships').deleteOne({ _id: oid(twin) });
        await db().collection('users').deleteOne({ _id: userId });
      }
    });

    it('P19.12-T6 AC-4 an AB whose account is gone is still named to tag — blank, never dropped — so the names and the count agree', async () => {
      const hadi = await db().collection('memberships').findOne({ _id: oid(id.HADI) });
      const account = await db().collection('users').findOne({ _id: oid(String(hadi!.userId)) });
      await db().collection('users').deleteOne({ _id: account!._id });
      try {
        const view = await read(office.as('OWNER'), { for: office.id.AGUS, scope: 'informal' });
        expect(view.informal).toEqual({ groups: [], absNotInGroup: 1, abs: [{ membershipId: id.HADI, name: '' }], canTag: true });
      } finally {
        await db().collection('users').insertOne(account!);
      }
    });
  });

  describe('AC-2 the Owner and the Admin: Semua downline is the office', () => {
    it('P19.12-T6 AC-2 the Owner opens on the whole office, Nora under Belum punya leader', async () => {
      const view = await read(office.as('OWNER'));
      expect(view.scope).toBe('downline');
      expect(view.scopes).toEqual({ offered: ['direct', 'informal', 'downline'], default: 'downline' });
      expect(view.unled?.rows.map((r) => r.name)).toEqual(['Nora Siregar']);
      expect(everyRow(view)).toHaveLength(19);
      expect(view.tiles.team.total).toBe(19);
      // Wilson leads only ABs: Grup langsung is himself — an empty unit, honestly.
      const direct = await read(office.as('OWNER'), { scope: 'direct' });
      expect(direct).toMatchObject({ scope: 'direct', empty: true });
    });

    it('P19.12-T6 AC-2 the Admin above nobody opens on the office; Grup langsung is not offered, and asking falls back', async () => {
      const view = await read(office.as('ADMIN'), { scope: 'direct' });
      expect(view.scope).toBe('downline');
      expect(view.scopes).toEqual({ offered: ['informal', 'downline'], default: 'downline' });
      expect(everyRow(view)).toHaveLength(19);
      expect(view.informal).toBeNull();
    });

    it('P19.12-T6 AC-2 any `for` view opens on Grup langsung', async () => {
      const view = await read(office.as('OWNER'), { for: office.id.AGUS });
      expect(view).toMatchObject({ scope: 'direct', scopes: { default: 'direct' }, readOnly: true });
      expect(everyRow(view)).toHaveLength(11);
      expect(everyRow(await read(office.as('OWNER'), { for: office.id.AGUS, scope: 'downline' }))).toHaveLength(13);
    });

    it('P19.12-T6 AC-2 an office where nobody has a leader yet: the Owner, leading nobody, is offered Semua downline alone — Unit Anda is herself, everybody else under Belum punya leader', async () => {
      // Office B with Bayu's upline still blank, as an import can leave it.
      const bayu = { _id: oid(office.id.B_AGENT) };
      await db().collection('memberships').updateOne(bayu, { $set: { leaderId: null, ancestorIds: [], depth: 0 } });
      try {
        const view = await read(bOwner());
        expect(view).toMatchObject({ scope: 'downline', scopes: { offered: ['downline'], default: 'downline' }, empty: false });
        expect(view.yourUnit.rows.map((r) => r.name)).toEqual(['Lina Marlina']);
        expect(view.units).toEqual([]);
        expect(view.unled?.rows.map((r) => r.name)).toEqual(['Bayu Saputra']);
        // ADR-0249 §3: office-wide, Belum punya leader counts under the AB chip, and the three add up to the tile.
        expect(view.tiles.team).toMatchObject({ total: 2, direct: 1, units: 0, aab: 0, ab: 1 });
        // The Potensi tab, the same people: her own card, then a card with no leader.
        const cards = await potensi.read(bOwner());
        expect(cards.units.map((u) => [u.kind, u.leader?.name ?? null, u.people.map((p) => p.name)])).toEqual([
          ['direct', 'Lina Marlina', ['Lina Marlina']], ['unled', null, ['Bayu Saputra']],
        ]);
      } finally {
        await db().collection('memberships').updateOne(bayu, { $set: { leaderId: office.id.B_AB, ancestorIds: [office.id.B_AB], depth: 1 } });
      }
    });

    it('P19.12-T6 AC-2 cross-tenant: office B’s Owner, office-wide, never sees office A; A’s member by `for` is 404', async () => {
      const view = await read(bOwner());
      expect(view.scope).toBe('downline');
      expect(everyRow(view).map((r) => r.name)).toEqual(['Lina Marlina', 'Bayu Saputra']);
      await expect(read(bOwner(), { for: office.id.AGUS })).rejects.toMatchObject({ status: 404 });
      await expect(read(office.as('OWNER'), { for: office.id.B_AB, scope: 'downline' })).rejects.toMatchObject({ status: 404 });
    });
  });

  describe('AC-2 the Potensi tab follows the view', () => {
    it('P19.12-T6 AC-2 Agus’s cards leave Hadi out by default and hold his card in Semua downline', async () => {
      const direct = await potensi.read(office.as('AGUS'));
      expect(direct.scope).toBe('direct');
      expect(direct.units.flatMap((u) => u.people).map((p) => p.membershipId)).not.toContain(id.HADI);
      const all = await potensi.read(office.as('AGUS'), { scope: 'downline' });
      expect(all.units.find((u) => u.leader?.membershipId === id.HADI)?.people.map((p) => p.name)).toEqual(['Hadi Wibowo', 'Hana Pertiwi']);
    });

    it('P19.12-T6 AC-2 the Owner’s cards end with Belum punya leader, a card with no leader', async () => {
      const view = await potensi.read(office.as('OWNER'));
      const last = view.units[view.units.length - 1];
      expect(last).toMatchObject({ kind: 'unled', leader: null });
      expect(last.people.map((p) => p.name)).toEqual(['Nora Siregar']);
      expect(view.units.flatMap((u) => u.people)).toHaveLength(19);
    });
  });

  describe('AC-4 + Tambah ke grup: POST /members/groups/:groupId/members', () => {
    it('P19.12-T6 AC-4 the Owner tags the ABs at once: each once, one audit entry each, and the line reads 0', async () => {
      const mine = await group(office.id.AGUS, 'Agus Circle');
      const result = await groups.addMembers(office.as('OWNER'), mine, [id.HADI, id.HADI]);
      expect(result).toEqual({ groupId: mine, name: 'Agus Circle', added: 1, memberCount: 1 });
      // Again: nobody new, nothing written.
      expect((await groups.addMembers(office.as('OWNER'), mine, [id.HADI])).added).toBe(0);
      const entries = await db().collection('auditLog').find({ action: 'member.tagged', targetId: id.HADI }).toArray();
      expect(entries).toHaveLength(1);
      expect(entries[0]).toMatchObject({ kpmId: KPM_A, before: { groupIds: [] }, after: { groupIds: [mine] } });
      expect((await read(office.as('AGUS'), { scope: 'informal' })).informal?.absNotInGroup).toBe(0);
    });

    it('P19.12-T6 AC-4 another office’s group, an archived one or a member outside the office is 404, and nothing is tagged', async () => {
      const mine = await group(office.id.AGUS, 'Agus Circle');
      const archived = await group(office.id.AGUS, 'Old', { status: 'archived' });
      const theirs = await group(office.id.B_AB, 'B Circle', {}, KPM_B);
      const audited = await db().collection('auditLog').countDocuments({ action: 'member.tagged' });
      await expect(groups.addMembers(office.as('OWNER'), theirs, [id.HADI])).rejects.toMatchObject({ status: 404 });
      await expect(groups.addMembers(office.as('OWNER'), archived, [id.HADI])).rejects.toMatchObject({ status: 404 });
      await expect(groups.addMembers(office.as('OWNER'), mine, [id.HADI, office.id.B_AGENT])).rejects.toMatchObject({ status: 404 });
      await expect(groups.addMembers(office.as('OWNER'), mine, [id.HADI, office.id.LEFT])).rejects.toMatchObject({ status: 404 });
      await expect(groups.addMembers(office.as('OWNER'), mine, [id.HADI, 'not-an-id'])).rejects.toMatchObject({ status: 404 });
      const hadi = await db().collection('memberships').findOne({ _id: new mongoose.Types.ObjectId(id.HADI) });
      expect(hadi?.groupIds).toEqual([]);
      expect(await db().collection('auditLog').countDocuments({ action: 'member.tagged' })).toBe(audited);
    });
  });
});
