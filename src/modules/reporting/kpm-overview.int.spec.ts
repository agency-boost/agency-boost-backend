import mongoose from 'mongoose';
import { RequestContext } from '@/common/context/request-context';
import { KPM_REPORTING } from '@/domain/constants';
import { SUBJECT_READ_ACTION } from '@/modules/audit/subject-read-audit';
import { declaredPermissions, SUPER_ADMIN } from '../../../test/http-permissions';
import {
  KPM_A, seedTreeRecords, startComplianceHarness, stopComplianceHarness, type ComplianceHarness, type ComplianceWho,
} from '../../../test/compliance-office';
import { ComplianceController } from './compliance/compliance.controller';
import { KpmOverviewController } from './reporting.controller';

const M = 1_000_000 * 100;

/**
 * **The KPM Overview, second version, over HTTP** (P19.19-T1 to T4; ADR-0272): `GET /kpm/overview`,
 * `GET /kpm/overview/performance` and `GET /kpm/overview/compliance` with the real `PermissionsGuard`, the production pipe
 * and the real services over the compliance harness's office (0417 on 14 September 2026, Oscar unplaced, and 0555).
 *
 * The office, as these tests read it: *Circle* holds Agus's AB group (Agus, Dewi, Nina, Dodi, Sari, Budi, Rina, Dimas,
 * Indah, Lukas, Tari — eleven); *Tanpa group* holds Hendra's (Hendra, Putu, Yusuf), Maya's, Wilson's and Oscar (under no
 * AB) — six. Seventeen counted, Fajar (removed) and every test account never.
 */
describe('the KPM Overview, second version, over HTTP (P19.19)', () => {
  let h: ComplianceHarness;
  let circle: string;
  const http = () => h.http();
  const as = (who: ComplianceWho | RequestContext) => h.as(who);
  const asCore = (who: 'AGUS' | 'SARI') => {
    const plain = h.ctx(who);
    as(new RequestContext(plain.userId, 'none', { ...plain.membership!, isCoreLeader: true } as never));
  };
  const saInside = (kpmId = KPM_A) => RequestContext.superAdminInKpm(RequestContext.platform('u-root'), kpmId);
  const names = (people: { membershipId: string }[]) => people.map((p) => p.membershipId);

  beforeAll(async () => {
    h = await startComplianceHarness();
    await seedTreeRecords(h);
    // Dewi logged on 20 August (inside the 30 days, 25 days ago: lapsed); Lukas on 1 July (outside them, lapsed).
    const day = (who: ComplianceWho, localDate: string) => ({
      kpmId: KPM_A, membershipId: h.id(who), localDate, entries: [], totalCount: 0, source: 'self',
      enteredByMembershipId: h.id(who), version: 1, frozenAt: null, corrections: [], deletedAt: null,
    });
    await h.col('activityLogs').insertMany([day('DEWI', '2026-08-20'), day('LUKAS', '2026-07-01')]);
    // *Circle*: Agus's informal group.
    const { insertedId } = await h.col('groups').insertOne({
      kpmId: KPM_A, name: 'Circle', leaderMembershipIds: [h.id('AGUS')], status: 'active', archivedAt: null, deletedAt: null,
    });
    circle = String(insertedId);
    await h.col('memberships').updateOne({ _id: new mongoose.Types.ObjectId(h.id('AGUS')) }, { $set: { groupIds: [circle] } });
    // Dimas manages his leads: two open, each with a next action ahead.
    await h.col('leads').insertMany(['A', 'B'].map((n) => ({
      kpmId: KPM_A, ownerMembershipId: h.id('DIMAS'), type: 'sales', name: `Prospect ${n}`, statusCode: null, outcome: null,
      outcomeAt: null, commitments: [], version: 1, deletedAt: null, nextActionDate: '2026-09-20', nextActionNote: 'Call',
      dateRegistered: new Date('2026-09-01T03:00:00Z'), contact: { phone: null, email: null },
    })));
    // September's recruits: one Indah registered (left since — still a recruit), one Wilson registered, and one test account.
    let seq = 0;
    const recruit = (registeredBy: string | null, extra: Record<string, unknown> = {}) => ({
      kpmId: KPM_A, userId: String(new mongoose.Types.ObjectId()), agentCode: `PRU-R${(seq += 1)}`, leaderCode: `LR${seq}`,
      role: 'agent', orgLevelCode: 'AGENT', leaderId: null, ancestorIds: [], depth: 0, status: 'removed',
      removedAt: new Date('2026-09-12T03:00:00Z'), joinedAs: 'new_hire', joinDate: '2026-09-05', registeredByMembershipId: registeredBy,
      deletedAt: null, ...extra,
    });
    await h.col('memberships').insertMany([
      recruit(h.id('INDAH')), recruit(h.id('OWNER')), recruit(h.id('INDAH'), { testAccount: true }),
    ]);
    // Agus's AB group's targets for September.
    await h.wired.abGroupTargets.set(h.ctx('OWNER'), h.id('AGUS'), { month: '2026-09', activeAgentTarget: 6, rekrutTarget: 3 });
  }, 180_000);
  afterAll(async () => stopComplianceHarness(h));

  it('P19.19-T4 AC-1 declares kpm_overview:read on every route; the analytics’ and the target’s grants are gone', () => {
    expect(declaredPermissions(KpmOverviewController)).toEqual({ read: 'kpm_overview:read', performance: 'kpm_overview:read' });
    expect(declaredPermissions(ComplianceController)).toEqual({ read: 'kpm_overview:read' });
  });

  describe('GET /kpm/overview (T1, T3 AC-1)', () => {
    it('P19.19-T1 AC-2 positive: the Owner reads Pakai over the last 30 days — of everybody, the leaders and the agents', async () => {
      as('OWNER');
      const view = (await http().get('/kpm/overview').expect(200)).body;
      expect(view).toMatchObject({
        office: { code: '0417' }, today: '2026-09-14', month: '2026-09', usageWindow: { from: '2026-08-16', to: '2026-09-14' },
        group: null,
        // Indah, Dimas, Rina, Dewi, Putu, Yusuf, Oscar of seventeen; Dewi and Putu of the eight leaders.
        usage: { total: { used: 7, of: 17, pct: 41 }, leaders: { used: 2, of: 8, pct: 25 }, agents: { used: 5, of: 9, pct: 56 } },
      });
      expect(view.groups).toEqual([
        { groupId: circle, name: 'Circle', people: 11 },
        { groupId: null, name: null, people: 6 },
      ]);
      expect(view.usage.byGroup).toEqual([
        {
          groupId: circle, name: 'Circle',
          total: { used: 4, of: 11, pct: 36 }, leaders: { used: 1, of: 4, pct: 25 }, agents: { used: 3, of: 7, pct: 43 },
        },
        {
          groupId: null, name: null,
          total: { used: 3, of: 6, pct: 50 }, leaders: { used: 1, of: 4, pct: 25 }, agents: { used: 2, of: 2, pct: 100 },
        },
      ]);
    });

    it('P19.19-T1 AC-3 the tree: group → AB → AAB with their agents → the AB’s own agents, each indented, A to Z', async () => {
      as('OWNER');
      const { people } = (await http().get('/kpm/overview').expect(200)).body;
      expect(people.map((p: { membershipId: string; depth: number }) => [p.membershipId, p.depth])).toEqual([
        [h.id('AGUS'), 0], [h.id('DEWI'), 1], [h.id('NINA'), 1], [h.id('DODI'), 2], [h.id('SARI'), 1], [h.id('BUDI'), 2],
        [h.id('RINA'), 2], [h.id('DIMAS'), 1], [h.id('INDAH'), 1], [h.id('LUKAS'), 1], [h.id('TARI'), 1],
        [h.id('PEER_AB'), 0], [h.id('PEER_AAB'), 1], [h.id('PEER_AGENT'), 2], [h.id('ADMIN'), 0], [h.id('OWNER'), 0],
        [h.id('ORPHAN'), 0],
      ]);
      const dodi = people.find((p: { membershipId: string }) => p.membershipId === h.id('DODI'));
      expect(dodi).toMatchObject({
        role: 'agent', groupId: circle, abMembershipId: h.id('AGUS'), leaderIds: [h.id('AGUS'), h.id('SARI'), h.id('NINA')],
      });
      expect(people.find((p: { membershipId: string }) => p.membershipId === h.id('ORPHAN')))
        .toMatchObject({ groupId: null, abMembershipId: null, leaderIds: [] });
      expect(people.find((p: { membershipId: string }) => p.membershipId === h.id('SARI'))).toMatchObject({ role: 'aab' });
    });

    it('P19.19-T1 AC-3, AC-4 each person’s usage and coaching status, from the 19 November definitions (14 days)', async () => {
      as('OWNER');
      const { people } = (await http().get('/kpm/overview').expect(200)).body;
      const of = (who: ComplianceWho) => people.find((p: { membershipId: string }) => p.membershipId === h.id(who));
      expect(of('RINA').usage).toEqual({ status: 'recent', days: 0, usedInWindow: true });
      expect(of('INDAH').usage).toEqual({ status: 'recent', days: 4, usedInWindow: true });
      expect(of('DEWI').usage).toEqual({ status: 'lapsed', days: 25, usedInWindow: true });
      expect(of('LUKAS').usage).toEqual({ status: 'lapsed', days: 75, usedInWindow: false });
      expect(of('NINA').usage).toEqual({ status: 'never', days: null, usedInWindow: false });
      expect(of('INDAH').coaching).toEqual({ status: 'recent', days: 4 });
      expect(of('SARI').coaching).toEqual({ status: 'recent', days: 12 });
      expect(of('NINA').coaching).toEqual({ status: 'never', days: null });
    });

    it('P19.19-T3 AC-1 Produksi 6 bulan: April to September, a month with no file null; the month’s APE over the people', async () => {
      as('OWNER');
      const { production } = (await http().get('/kpm/overview').expect(200)).body;
      expect(production).toEqual({
        currency: 'IDR',
        months: [
          { month: '2026-04', apeMinor: null }, { month: '2026-05', apeMinor: null }, { month: '2026-06', apeMinor: null },
          { month: '2026-07', apeMinor: null },
          // Indah, Dimas, Rina and Sari 20 M each and Agus 30 M; then 80 + 20 + 80 + 90 + 30.
          { month: '2026-08', apeMinor: 110 * M }, { month: '2026-09', apeMinor: 300 * M },
        ],
      });
    });

    it('P19.19-T1 AC-2 a group filters the whole page; none is Tanpa group; an unknown one 404', async () => {
      as('OWNER');
      const one = (await http().get(`/kpm/overview?group=${circle}`).expect(200)).body;
      expect(one.group).toEqual({ groupId: circle, name: 'Circle' });
      expect(one.usage.total).toEqual({ used: 4, of: 11, pct: 36 });
      expect(one.usage.byGroup.map((g: { name: string }) => g.name)).toEqual(['Circle']);
      expect(one.people).toHaveLength(11);
      // Only Agus's AB group's September: Agus 30 M and his team's 270 M.
      expect(one.production.months[5]).toEqual({ month: '2026-09', apeMinor: 300 * M });
      const none = (await http().get('/kpm/overview?group=none').expect(200)).body;
      expect(none.group).toEqual({ groupId: null, name: null });
      expect(none.people.map((p: { membershipId: string }) => p.membershipId)).toContain(h.id('ORPHAN'));
      expect(none.production.months[5].apeMinor).toBe(0);
      expect((await http().get(`/kpm/overview?group=${new mongoose.Types.ObjectId()}`).expect(404)).body.error.code).toBe('NOT_FOUND');
    });

    it('P19.19-T1 validation: any other parameter is 400, named', async () => {
      as('OWNER');
      const res = await http().get('/kpm/overview?period=this_month').expect(400);
      expect(res.body.error.code).toBe('VALIDATION_FAILED');
    });

    it('P19.19-T3 AC-2 a test account is never listed or counted', async () => {
      await h.col('memberships').updateOne({ _id: new mongoose.Types.ObjectId(h.id('DODI')) }, { $set: { testAccount: true } });
      try {
        as('OWNER');
        const view = (await http().get('/kpm/overview').expect(200)).body;
        expect(names(view.people)).not.toContain(h.id('DODI'));
        expect(view.usage.total.of).toBe(16);
      } finally {
        await h.col('memberships').updateOne({ _id: new mongoose.Types.ObjectId(h.id('DODI')) }, { $unset: { testAccount: '' } });
      }
    });

    it('P19.19-T1 a read records each person listed as read, the reader’s own row aside', async () => {
      await h.col('auditLog').deleteMany({ action: SUBJECT_READ_ACTION, 'after.surface': 'kpm_overview' });
      as('OWNER');
      await http().get('/kpm/overview').expect(200);
      expect(await h.col('auditLog').countDocuments({ action: SUBJECT_READ_ACTION, 'after.surface': 'kpm_overview' })).toBe(16);
    });
  });

  describe('GET /kpm/overview/performance (T2)', () => {
    it('P19.19-T2 AC-2 Total KPM, each informal group’s total and each AB group: APE, Active Agent and Rekrut beside their targets', async () => {
      as('OWNER');
      const view = (await http().get('/kpm/overview/performance').expect(200)).body;
      expect(view).toMatchObject({ month: '2026-09', currentMonth: '2026-09', held: true, group: null, canWrite: true });
      expect(view.groups.map((g: { group: { name: string } | null }) => g.group?.name ?? null)).toEqual(['Circle', null]);
      const agus = view.groups[0].abGroups[0];
      expect(agus).toMatchObject({
        abMembershipId: h.id('AGUS'), people: 11, activeAgentTarget: 6, rekrutTarget: 3, apeTargetMinor: 125 * M,
        // 300 M of 125 M; Agus, Indah, Dimas, Rina and Sari produced; Indah's recruit.
        actual: { apeMinor: 300 * M, apePct: 240, activeAgents: 5, rekrut: 1 },
      });
      expect(view.groups[0].totals.actual).toEqual(agus.actual);
      const wilson = view.groups[1].abGroups.find((r: { abMembershipId: string }) => r.abMembershipId === h.id('OWNER'));
      expect(wilson.actual).toEqual({ apeMinor: 0, apePct: null, activeAgents: 0, rekrut: 1 });
      // Every recruit of the office: Indah's, Wilson's, and Yusuf — who joined on 14 September, credited to nobody.
      expect(view.total.actual).toMatchObject({ apeMinor: 300 * M, activeAgents: 5, rekrut: 3 });
      expect(view.total).toMatchObject({ activeAgentTarget: 6, rekrutTarget: 3 });
    });

    it('P19.19-T2 AC-1 an earlier month reads its own figures; a month not uploaded reads null, never 0', async () => {
      as('OWNER');
      const august = (await http().get('/kpm/overview/performance?month=2026-08').expect(200)).body;
      expect(august.groups[0].abGroups[0].actual).toMatchObject({ apeMinor: 110 * M, activeAgents: 5, rekrut: 0 });
      // Targets are saved for September: August has none to carry.
      expect(august.groups[0].abGroups[0]).toMatchObject({ activeAgentTarget: null, source: 'none' });
      const june = (await http().get('/kpm/overview/performance?month=2026-06').expect(200)).body;
      expect(june).toMatchObject({ held: false, total: { actual: { apeMinor: null, apePct: null, activeAgents: null } } });
    });

    it('P19.19-T2 validation: a month that is no month is 400; one before January 2024 is 422', async () => {
      as('OWNER');
      expect((await http().get('/kpm/overview/performance?month=2026-13').expect(400)).body.error.code).toBe('VALIDATION_FAILED');
      expect((await http().get('/kpm/overview/performance?month=2023-12').expect(422)).body.error.code).toBe('AB_GROUP_TARGET_MONTH_CLOSED');
    });

    it('P19.19-T1 AC-2 the group filter keeps one informal group; the total stays the KPM’s; an unknown one 404', async () => {
      as('OWNER');
      const view = (await http().get('/kpm/overview/performance?group=none').expect(200)).body;
      expect(view.group).toEqual({ groupId: null, name: null });
      expect(view.groups.map((g: { group: unknown }) => g.group)).toEqual([null]);
      expect(view.total.actual.rekrut).toBe(3);
      // *Circle* named: its card alone, under its name; *Total KPM* still the KPM's.
      const one = (await http().get(`/kpm/overview/performance?group=${circle}`).expect(200)).body;
      expect(one.group).toEqual({ groupId: circle, name: 'Circle' });
      expect(one.groups.map((g: { group: { name: string } | null }) => g.group?.name ?? null)).toEqual(['Circle']);
      expect(one.groups[0].abGroups.map((r: { abMembershipId: string }) => r.abMembershipId)).toEqual([h.id('AGUS')]);
      expect(one.total.actual).toEqual(view.total.actual);
      await http().get(`/kpm/overview/performance?group=${new mongoose.Types.ObjectId()}`).expect(404);
    });

    it('P19.19-T2 AC-3 after a target is saved the row and the totals read it', async () => {
      as('OWNER');
      await h.wired.abGroupTargets.set(h.ctx('OWNER'), h.id('OWNER'), { month: '2026-09', activeAgentTarget: 2, rekrutTarget: 1 });
      const view = (await http().get('/kpm/overview/performance').expect(200)).body;
      expect(view.groups[1].abGroups.find((r: { abMembershipId: string }) => r.abMembershipId === h.id('OWNER')))
        .toMatchObject({ activeAgentTarget: 2, rekrutTarget: 1, source: 'set' });
      expect(view.total).toMatchObject({ activeAgentTarget: 8, rekrutTarget: 4 });
    });
  });

  describe('GET /kpm/overview/compliance (T3)', () => {
    it('P19.19-T3 AC-2 seven cards, lowest first, with the 34 / 67 splits; no card opened, nothing listed', async () => {
      as('OWNER');
      const view = (await http().get('/kpm/overview/compliance').expect(200)).body;
      expect(view.thresholds).toEqual({ lowBelowPct: KPM_REPORTING.COMPLIANCE_LOW_BELOW_PCT, highFromPct: KPM_REPORTING.COMPLIANCE_HIGH_FROM_PCT });
      expect(view.thresholds).toEqual({ lowBelowPct: 34, highFromPct: 67 });
      expect(view.cards.map((c: { category: string }) => c.category).sort())
        .toEqual(['activation', 'activity', 'campaigns', 'events', 'goals', 'leads', 'training']);
      const pcts = view.cards.map((c: { pct: number | null }) => c.pct).filter((p: number | null) => p !== null);
      expect(pcts).toEqual([...pcts].sort((a: number, b: number) => a - b));
      // Goal Setting over the seventeen: Indah, Dimas, Rina and Oscar hold a goal (Sari's is zero).
      expect(view.cards.find((c: { category: string }) => c.category === 'goals')).toEqual({ category: 'goals', count: 4, of: 17, pct: 24 });
      expect(view.selected).toBeNull();
    });

    it('P19.19-T3 AC-2, AC-3 Leads Mgmt: every open lead with a next action ahead is done; the card is the cells’ sum', async () => {
      as('OWNER');
      const view = (await http().get('/kpm/overview/compliance?category=leads').expect(200)).body;
      const cell = (who: ComplianceWho) => view.selected.cells.find((c: { membershipId: string }) => c.membershipId === h.id(who));
      expect(cell('DIMAS')).toMatchObject({ status: 'managed', done: true });
      expect(cell('RINA')).toMatchObject({ status: 'needs_next_action', done: false });
      expect(cell('ORPHAN')).toMatchObject({ status: 'no_leads', done: false });
      expect(view.selected).toMatchObject({ category: 'leads', item: null, of: 17 });
      expect(view.selected.cells).toHaveLength(17);
      const card = view.cards.find((c: { category: string }) => c.category === 'leads');
      expect(card).toMatchObject({ count: view.selected.done, of: 17 });
    });

    it('P19.19-T3 AC-3 Events and Campaigns open on every item at once — the card’s own figure', async () => {
      as('OWNER');
      for (const category of ['events', 'campaigns'] as const) {
        const view = (await http().get(`/kpm/overview/compliance?category=${category}`).expect(200)).body;
        const card = view.cards.find((c: { category: string }) => c.category === category);
        expect(view.selected).toMatchObject({ category, item: null, done: card.count, of: card.of });
      }
    });

    it('P19.19-T3 AC-3 Training opens on its first module, the card’s; another module is per module', async () => {
      as('OWNER');
      const view = (await http().get('/kpm/overview/compliance?category=training').expect(200)).body;
      const card = view.cards.find((c: { category: string }) => c.category === 'training');
      expect(view.selected).toMatchObject({ category: 'training', item: h.sales[0], done: card.count, of: card.of });
      await http().get('/kpm/overview/compliance?category=training&item=NOT_A_MODULE').expect(404);
    });

    it('P19.19-T3 validation: an item on a single-item card, or without one, is 400; an unknown card 400', async () => {
      as('OWNER');
      for (const path of ['category=leads&item=X', 'item=X', 'category=nope']) {
        expect((await http().get(`/kpm/overview/compliance?${path}`).expect(400)).body.error.code).toBe('VALIDATION_FAILED');
      }
    });

    it('P19.19-T1 AC-2 a group: the cards over its people', async () => {
      as('OWNER');
      const view = (await http().get(`/kpm/overview/compliance?group=${circle}&category=goals`).expect(200)).body;
      expect(view.group).toEqual({ groupId: circle, name: 'Circle' });
      expect(view.selected.cells).toHaveLength(11);
      expect(view.cards.find((c: { category: string }) => c.category === 'goals')).toMatchObject({ count: 3, of: 11 });
    });
  });

  describe('who reads it (ADR-0268 §1)', () => {
    const PATHS = ['/kpm/overview', '/kpm/overview/performance', '/kpm/overview/compliance'];

    it.each(['OWNER', 'ADMIN'] as const)('P19.19-T1 positive: %s reads all three', async (who) => {
      as(who);
      for (const path of PATHS) await http().get(path).expect(200);
    });

    it('P19.19-T1 positive: a core leader reads the whole KPM', async () => {
      asCore('AGUS');
      const view = (await http().get('/kpm/overview').expect(200)).body;
      expect(view.usage.total.of).toBe(17);
      for (const path of PATHS.slice(1)) await http().get(path).expect(200);
    });

    it('P19.19-T1 positive: the Super Admin inside the KPM reads it as its Owner', async () => {
      as(saInside());
      for (const path of PATHS) await http().get(path).expect(200);
    });

    it.each(['AGUS', 'SARI', 'INDAH'] as const)('P19.19-T1 negative: %s — an AB, an AAB, an Agent, none a steward — is refused 403', async (who) => {
      as(who);
      for (const path of PATHS) {
        expect((await http().get(path).expect(403)).body.error).toMatchObject({ code: 'PERM_DENIED' });
      }
    });

    it('P19.19-T1 negative: a Super Admin who has not entered a KPM has none', async () => {
      as(SUPER_ADMIN);
      for (const path of PATHS) expect((await http().get(path).expect(403)).body.error.code).toBe('TENANT_NO_MEMBERSHIP');
    });

    it('P19.19-T1 cross-tenant: 0555’s Owner reads 0555 alone, and 0417’s group is 404 to them', async () => {
      as(h.ownerOfB());
      const view = (await http().get('/kpm/overview').expect(200)).body;
      expect(view.people.every((p: { membershipId: string }) => [h.id('B_AB'), h.id('B_AGENT')].includes(p.membershipId))).toBe(true);
      expect(view.usage.total.of).toBe(2);
      await http().get(`/kpm/overview?group=${circle}`).expect(404);
      await http().get(`/kpm/overview/performance?group=${circle}`).expect(404);
      await http().get(`/kpm/overview/compliance?group=${circle}`).expect(404);
      const perf = (await http().get('/kpm/overview/performance').expect(200)).body;
      expect(perf.total.actual.rekrut).toBe(0);
      expect(perf.groups.flatMap((g: { abGroups: { abMembershipId: string }[] }) => g.abGroups.map((r) => r.abMembershipId)))
        .toEqual([h.id('B_AB')]);
    });
  });
});
