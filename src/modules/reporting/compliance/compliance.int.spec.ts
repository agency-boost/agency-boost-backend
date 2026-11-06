import mongoose from 'mongoose';
import { RequestContext } from '@/common/context/request-context';
import { SUBJECT_READ_ACTION } from '@/modules/audit/subject-read-audit';
import { declaredPermissions, session, SUPER_ADMIN } from '../../../../test/http-permissions';
import {
  KPM_A, LISTED, ROSTER_NOW, seedTreeRecords, startComplianceHarness, stopComplianceHarness, TODAY,
  type ComplianceHarness, type ComplianceWho,
} from '../../../../test/compliance-office';
import { COMPLIANCE_CATEGORIES } from './compliance-category';
import { ComplianceController } from './compliance.controller';
import type { ComplianceRow, ComplianceSection, ComplianceView } from './compliance.service';

const M = 1_000_000 * 100;

/**
 * **The Owner's compliance tree over HTTP** (P18.3-T1 AC-1 to AC-9; exit tests 2 and 3), with the real
 * `PermissionsGuard`, the production pipe and the real readers over `test/compliance-office.ts` and its
 * `seedTreeRecords`. Isolation is `compliance.tenancy.spec.ts`; the owning surfaces' figures,
 * `compliance.reconciliation.int.spec.ts`; the query count, `compliance.performance.spec.ts`.
 *
 * | Who | Training (`PROSPECT_LIST`) | Goal 2026 | Last logged | Activation |
 * |---|---|---|---|---|
 * | INDAH | every module *Done* (14 Sep) | set | 10 Sep | — |
 * | DIMAS | *In progress* | set | 10 Sep | — |
 * | RINA | *Done* at 23:59 on 10 Sep | set | 14 Sep | open, from 1 Aug |
 * | BUDI | *Done* at 00:01 on 11 Sep | — | — | open, from 1 May: overdue |
 * | SARI | — | saved with a zero target: not set | — | — |
 * | DODI | — | — | — | graduated 20 May |
 * | TARI | — | — | — | expired: started 2 Jan, ended 2 Jul |
 * | PEER_AAB | — | — | 8 Sep: the window's first day | — |
 * | PEER_AGENT | — | — | 7 Sep: a day before it | open, from today |
 * | ORPHAN (unplaced) | every module *Done* | set | 12 Sep | graduated |
 */
describe('the Owner’s compliance tree over HTTP (P18.3-T1)', () => {
  let h: ComplianceHarness;
  const http = () => h.http();
  const db = () => mongoose.connection.db!;
  const read = async (query: Record<string, string> = {}) =>
    (await http().get('/kpm/analytics/compliance').query(query).expect(200)).body as ComplianceView;
  const reads = (surface: string) => db().collection('auditLog').countDocuments({ action: SUBJECT_READ_ACTION, 'after.surface': surface });
  const auditCount = () => db().collection('auditLog').countDocuments({});
  const mark = async (): Promise<mongoose.Types.ObjectId | null> =>
    (await db().collection('auditLog').find({}).sort({ _id: -1 }).limit(1).next())?._id ?? null;
  const entriesSince = async (since: mongoose.Types.ObjectId | null) => db().collection('auditLog')
    .find({ action: SUBJECT_READ_ACTION, ...(since === null ? {} : { _id: { $gt: since } }) }).toArray();
  const rows = (view: ComplianceView): ComplianceRow[] => view.tree.flatMap((s) => s.units.flatMap((u) => u.rows));
  const cellOf = (view: ComplianceView, who: ComplianceWho) => rows(view).find((r) => r.membershipId === h.id(who))!.cell;
  const chip = (view: ComplianceView, category: string) => view.summary.find((c) => c.category === category)!;

  beforeAll(async () => {
    h = await startComplianceHarness();
    await seedTreeRecords(h);
  }, 180_000);

  afterAll(() => stopComplianceHarness(h));

  beforeEach(() => {
    h.clock.set(ROSTER_NOW);
    h.as('OWNER');
  });

  it('declares one route, under the analytics’ own permission', () => {
    expect(declaredPermissions(ComplianceController)).toEqual({ read: 'kpm_analytics:read' });
  });

  describe('P18.3-T1 AC-1 — who reads', () => {
    it('P18.3-T1 AC-1 positive: the Owner and the Admin read their office', async () => {
      for (const who of ['OWNER', 'ADMIN'] as const) {
        h.as(who);
        const view = await read();
        expect([who, view.today, view.people, view.units]).toEqual([who, TODAY, 16, 4]);
      }
      // An Owner or an Admin standing on no rung reads it too: the grant is theirs, not the rung's.
      for (const who of ['OWNER', 'ADMIN'] as const) {
        h.as(h.officeOnly(who));
        expect((await read()).people).toBe(16);
      }
    });

    it('P18.3-T1 AC-1 negative: RINA, an Agent, is refused by the guard and writes nothing', async () => {
      h.as('RINA');
      const before = await auditCount();
      const res = await http().get('/kpm/analytics/compliance').query({ category: 'activity' }).expect(403);
      expect(res.body.error).toMatchObject({ code: 'PERM_DENIED', details: { permission: 'kpm_analytics:read' } });
      expect(await auditCount()).toBe(before);
    });

    it.each(['AGUS', 'SARI'] as const)('P18.5-T5 AC-6 negative: %s, a leader not tagged Core Leader, is answered 404 and writes nothing', async (who) => {
      h.as(who);
      const before = await auditCount();
      const res = await http().get('/kpm/analytics/compliance').query({ category: 'activity' }).expect(404);
      expect(res.body.error.code).toBe('NOT_FOUND');
      expect(await auditCount()).toBe(before);
    });

    it.each(['AGUS', 'SARI'] as const)('P18.5-T5 AC-4 positive: %s, a Core Leader, reads the whole office’s tree, read-only (ADR-0159 §2)', async (who) => {
      const owners = await read({ category: 'goals' });
      const base = h.ctx(who);
      h.as(new RequestContext(base.userId, 'none', { ...base.membership!, isCoreLeader: true }));
      const view = await read({ category: 'goals' });
      expect([view.people, view.units]).toEqual([owners.people, owners.units]);
      expect(rows(view).map((r) => r.membershipId).sort()).toEqual(rows(owners).map((r) => r.membershipId).sort());
      // Read-only: no override offered (`campaign_qualification:override` is no field role's).
      expect(view.can.override).toBe(false);
    });

    it('P18.3-T1 AC-1 negative: a Super Admin outside a support session belongs to no office', async () => {
      session.current = SUPER_ADMIN;
      const before = await auditCount();
      expect((await http().get('/kpm/analytics/compliance').expect(403)).body.error.code).toBe('TENANT_NO_MEMBERSHIP');
      expect(await auditCount()).toBe(before);
    });

    it('P18.3-T1 AC-1 a read-only support session reads the tree as the Owner: both actors on the entries, no override, no link written', async () => {
      const rina = () => h.col('activationProgress').findOne({ membershipId: h.id('RINA') });
      await h.col('activationProgress').updateOne(
        { membershipId: h.id('RINA') }, { $set: { 'items.$[].done': false, 'items.$[].source': null } },
      );
      const before = await rina();
      h.as(h.supporting('OWNER', true));
      const since = await mark();
      const view = await read({ category: 'activation' });
      // RINA's goal and lead meet two links: met in memory for the answer, written nowhere (N3).
      expect(cellOf(view, 'RINA')).toEqual({ status: 'in_progress', done: false, on: null, endedOn: null });
      expect(await rina()).toEqual(before);
      expect(view.can.override).toBe(false);
      const entries = await entriesSince(since);
      expect(entries).toHaveLength(5);
      for (const entry of entries) {
        expect(entry).toMatchObject({ actorUserId: 'u-support', effectiveUserId: h.ctx('OWNER').userId, after: { surface: 'activation' } });
      }
      // The Owner's own next read heals them.
      h.as('OWNER');
      await read({ category: 'activation' });
      expect((await rina())!.items.filter((i: { done: boolean }) => i.done).length).toBeGreaterThan(0);
    });

    it('P18.3-T1 AC-1 an elevated support session reads as the Owner, both actors on its entries, and may override', async () => {
      h.as(h.supporting('OWNER', false));
      const since = await mark();
      const view = await read({ category: 'activity' });
      expect(view.can.override).toBe(true);
      const entries = await entriesSince(since);
      expect(entries).toHaveLength(15);
      expect(entries.every((e) => e.actorUserId === 'u-support' && e.effectiveUserId === h.ctx('OWNER').userId)).toBe(true);
    });

    it.each([
      ['an unknown category', { category: 'coaching' }, 'category'],
      ['a category in another case', { category: 'Training' }, 'category'],
      ['an item on goals', { category: 'goals', item: '2026' }, 'item'],
      ['an item on activity', { category: 'activity', item: 'week' }, 'item'],
      ['an item on activation', { category: 'activation', item: 'x' }, 'item'],
      ['an empty item', { item: '' }, 'item'],
      ['an item over 100 characters', { item: 'X'.repeat(101) }, 'item'],
      ['two items', { item: ['PROSPECT_LIST', 'CLIENT_RETENTION'] }, 'item'],
      ['a parameter of any other name', { period: 'this_month' }, 'period'],
    ])('P18.3-T1 AC-1 %s is 400 VALIDATION_FAILED, named in details, and writes nothing', async (_, query, named) => {
      const before = await auditCount();
      const res = await http().get('/kpm/analytics/compliance').query(query).expect(400);
      expect(res.body.error.code).toBe('VALIDATION_FAILED');
      expect(JSON.stringify(res.body.error.details)).toContain(named);
      expect(await auditCount()).toBe(before);
    });

    it('P18.10-T5 AC-7 refuses an item on a one-item category in Indonesian, and a module not offered', async () => {
      const said = 'item tidak diterima oleh kategori goals: kategori ini hanya memiliki satu item.';
      const refused = await http().get('/kpm/analytics/compliance').set('Accept-Language', 'id')
        .query({ category: 'goals', item: '2026' }).expect(400);
      expect(refused.body.error).toMatchObject({ code: 'VALIDATION_FAILED', message: said, details: { violations: [said] } });
      expect((await http().get('/kpm/analytics/compliance').query({ category: 'goals', item: '2026' }).expect(400)).body.error.message)
        .toBe('item is not taken by category goals: it has one item only.');
      const missing = await http().get('/kpm/analytics/compliance').set('Accept-Language', 'id')
        .query({ category: 'training', item: 'NOT_A_MODULE' }).expect(404);
      expect(missing.body.error).toMatchObject({ code: 'NOT_FOUND', message: 'Modul training tidak ditemukan.' });
    });

    it('P18.3-T1 AC-1 a module the office does not offer is 404, and writes nothing', async () => {
      const before = await auditCount();
      for (const item of ['NOT_A_MODULE', 'prospect_list']) {
        const res = await http().get('/kpm/analytics/compliance').query({ category: 'training', item }).expect(404);
        expect(res.body.error.code).toBe('NOT_FOUND');
      }
      expect(await auditCount()).toBe(before);
    });

    it('P18.3-T1 AC-1 exit review 5: a refused item is refused before any other chip reads — no link completion written', async () => {
      // Rina's goal and lead meet two of her activation's links, which the Activation chip writes when it reads.
      await h.col('activationProgress').updateOne(
        { membershipId: h.id('RINA') }, { $set: { 'items.$[].done': false, 'items.$[].source': null } },
      );
      const rina = () => h.col('activationProgress').findOne({ membershipId: h.id('RINA') });
      const before = await rina();
      await http().get('/kpm/analytics/compliance').query({ category: 'training', item: 'NOT_A_MODULE' }).expect(404);
      expect(await rina()).toEqual(before);
      // A read that is answered heals them, as every reader of the activation does.
      await read({ category: 'training' });
      expect((await rina())!.items.some((i: { done: boolean }) => i.done)).toBe(true);
    });

    it('P18.3-T1 AC-7 exit review 8: a link the Owner’s read completes is attributed to its record’s author — the hire — never to the reader', async () => {
      await h.col('activationProgress').updateOne(
        { membershipId: h.id('RINA') },
        { $set: { 'items.$[].done': false, 'items.$[].source': null, 'items.$[].doneByMembershipId': null } },
      );
      await read({ category: 'activation' });
      const items = (await h.col('activationProgress').findOne({ membershipId: h.id('RINA') }))!.items as
        { code: string; done: boolean; source: string | null; doneByMembershipId: string | null }[];
      const goal = items.find((i) => i.code === 'GOAL_SETTING')!;
      // Rina saved her own goal: the link is hers, done by the link, as her own read would have written it.
      expect(goal).toMatchObject({ done: true, source: 'link', doneByMembershipId: h.id('RINA') });
      for (const item of items.filter((i) => i.done)) {
        expect([item.code, item.source, item.doneByMembershipId === h.id('OWNER')]).toEqual([item.code, 'link', false]);
      }
    });
  });

  describe('P18.3-T1 AC-2, AC-3 — the read’s shape and the summary', () => {
    it('P18.3-T1 AC-2 the sub-line’s two counts, six chips in order, the catalog, the selection, the tree and what the reader may do', async () => {
      const view = await read();
      expect(Object.keys(view).sort()).toEqual([
        'can', 'catalog', 'group', 'groups', 'people', 'selected', 'summary', 'thresholds', 'today', 'tree', 'units',
      ]);
      expect({ today: view.today, people: view.people, units: view.units }).toEqual({ today: TODAY, people: 16, units: 4 });
      expect(view.summary.map((c) => c.category)).toEqual([...COMPLIANCE_CATEGORIES]);
      expect(view.selected).toEqual({ category: 'training', item: 'PROSPECT_LIST' });
      expect(view.catalog.goals).toEqual({ year: '2026' });
      expect(Array.isArray(view.catalog.events) && Array.isArray(view.catalog.campaigns)).toBe(true);
      expect(view.can).toEqual({ override: true });
      // The people the sub-line counts are the rows the tree draws.
      expect(rows(view)).toHaveLength(view.people);
      expect(view.tree).toHaveLength(view.units);
    });

    it('P18.3-T1 AC-3 every chip is computed on every read, whatever is selected — done over those it applies to (D-chips)', async () => {
      // P19.3-T3 AC-9: Training counts the first module, PROSPECT_LIST, whichever tab is read — three have done it.
      const expected = {
        training: { count: 3, of: 16 },
        goals: { count: 3, of: 16 },
        activity: { count: 4, of: 16 },
        activation: { count: 1, of: 5 },
      };
      for (const category of ['training', 'goals', 'activity', 'activation'] as const) {
        const view = await read({ category });
        for (const [key, want] of Object.entries(expected)) {
          expect([category, key, chip(view, key)]).toEqual([category, key, { category: key, ...want }]);
        }
      }
    });

    it('P18.3-T1 AC-2 the selection survives: the same query reads the same item', async () => {
      const first = await read({ category: 'training', item: 'CLIENT_RETENTION' });
      const again = await read({ category: 'training', item: 'CLIENT_RETENTION' });
      expect(first.selected).toEqual({ category: 'training', item: 'CLIENT_RETENTION' });
      expect(again.tree).toEqual(first.tree);
    });
  });

  describe('P18.3-T1 AC-8 — the tree', () => {
    it('P18.3-T1 AC-8 one section per AB agency, A to Z; the AB’s own card, then each AAB who leads somebody; the head first', async () => {
      const view = await read({ category: 'goals' });
      const shape = view.tree.map((s: ComplianceSection) => ({
        head: s.head.name,
        units: s.units.map((u) => ({ head: u.head.name, rung: u.rung, rows: u.rows.map((r) => `${r.name}${r.personal ? ' *' : ''}`) })),
      }));
      expect(shape).toEqual([
        {
          head: 'Agus Salim',
          units: [
            {
              head: 'Agus Salim', rung: 'AB',
              rows: ['Agus Salim *', 'Dewi Lestari', 'Dimas Pratama', 'Indah Permatasari', 'Lukas Hartono', 'Tari Anggraini'],
            },
            { head: 'Nina Lestari', rung: 'AAB', rows: ['Nina Lestari *', 'Dodi Kurniawan'] },
            { head: 'Sari Puspita', rung: 'AAB', rows: ['Sari Puspita *', 'Budi Santoso', 'Rina Wijaya'] },
          ],
        },
        {
          head: 'Hendra Gunawan',
          units: [
            { head: 'Hendra Gunawan', rung: 'AB', rows: ['Hendra Gunawan *'] },
            { head: 'Putu Ayu', rung: 'AAB', rows: ['Putu Ayu *', 'Yusuf Ramadhan'] },
          ],
        },
        { head: 'Maya Kusuma', units: [{ head: 'Maya Kusuma', rung: 'AB', rows: ['Maya Kusuma *'] }] },
        { head: 'Wilson Tanoto', units: [{ head: 'Wilson Tanoto', rung: 'AB', rows: ['Wilson Tanoto *'] }] },
      ]);
    });

    it('P18.3-T1 AC-8 an unplaced member is in no row and no chip; a leaver and another office’s members in none', async () => {
      const view = await read();
      const ids = rows(view).map((r) => r.membershipId).sort();
      expect(ids).toEqual(LISTED.map((who) => h.id(who)).sort());
      for (const who of ['ORPHAN', 'LEFT', 'B_AB', 'B_AGENT'] as const) expect(ids).not.toContain(h.id(who));
    });

    it('P18.3-T1 AC-8 `leads` marks who heads anybody — their name opens the Unit Dashboard', async () => {
      const view = await read();
      const leading = rows(view).filter((r) => r.leads).map((r) => r.name).sort();
      expect(leading).toEqual(['Agus Salim', 'Hendra Gunawan', 'Lukas Hartono', 'Nina Lestari', 'Putu Ayu', 'Sari Puspita', 'Wilson Tanoto']);
      expect(view.tree.map((s) => [s.head.name, s.head.leads])).toEqual([
        ['Agus Salim', true], ['Hendra Gunawan', true], ['Maya Kusuma', false], ['Wilson Tanoto', true],
      ]);
    });

    it('UI-109 serves where a bar turns red and green, the registry’s 50% and 80%, so the phone re-declares neither', async () => {
      const view = await read({ category: 'training' });
      expect(view.thresholds).toEqual({ lowBelowPct: 50, highFromPct: 80 });
    });

    it('P18.3-T1 AC-8 a card counts the rows the item applies to; a section, its cards', async () => {
      const view = await read({ category: 'activation' });
      const agus = view.tree[0];
      // Activation applies to hires only: Tari (expired) on the AB's card, Dodi on Nina's, Rina and Budi on Sari's.
      expect(agus.units.map((u) => [u.head.name, u.done, u.of])).toEqual([
        ['Agus Salim', 0, 1], ['Nina Lestari', 1, 1], ['Sari Puspita', 0, 2],
      ]);
      expect([agus.done, agus.of]).toEqual([1, 4]);
      expect(view.tree.map((s) => [s.head.name, s.done, s.of])).toEqual([
        ['Agus Salim', 1, 4], ['Hendra Gunawan', 0, 1], ['Maya Kusuma', 0, 0], ['Wilson Tanoto', 0, 0],
      ]);
    });
  });

  describe('P18.3-T1 AC-4 — Training', () => {
    it('P18.3-T1 AC-4 the office’s categories in order, an empty one included; the skills holding a module; their modules', async () => {
      const { catalog } = await read();
      expect(catalog.training.map((c) => [c.code, c.skills.length])).toEqual([
        ['SALES', 6], ['PRODUCT', 0], ['RECRUITING', 0], ['TEAM_MANAGEMENT', 0], ['MOTIVATION', 0], ['SOFT_SKILLS', 0], ['COMPANY_AND_KPM', 0],
      ]);
      expect(catalog.training[0].skills[0]).toEqual({
        code: 'PROSPECTING', label: 'Pencarian prospek',
        modules: [
          { code: 'PROSPECT_LIST', title: 'Menyusun daftar prospek Anda' },
          { code: 'REFERRAL_GENERATION', title: 'Teknik mendapatkan referensi' },
          { code: 'COLD_APPROACH_SCRIPTS', title: 'Script pendekatan prospek baru' },
        ],
      });
      expect(catalog.training.flatMap((c) => c.skills.flatMap((s) => s.modules.map((m) => m.code)))).toEqual(h.sales);
    });

    it('P18.3-T1 AC-4 Completed with the office day it was marked done — 23:59 and 00:01 in Jakarta — In progress, Not started', async () => {
      const view = await read({ category: 'training', item: 'PROSPECT_LIST' });
      expect(cellOf(view, 'INDAH')).toEqual({ status: 'done', done: true, on: TODAY });
      expect(cellOf(view, 'RINA')).toEqual({ status: 'done', done: true, on: '2026-09-10' });
      expect(cellOf(view, 'BUDI')).toEqual({ status: 'done', done: true, on: '2026-09-11' });
      expect(cellOf(view, 'DIMAS')).toEqual({ status: 'in_progress', done: false, on: null });
      expect(cellOf(view, 'SARI')).toEqual({ status: 'not_started', done: false, on: null });
      // Another module: only Indah has done it.
      const other = await read({ category: 'training', item: 'CLIENT_RETENTION' });
      expect(rows(other).filter((r) => r.cell.done).map((r) => r.name)).toEqual(['Indah Permatasari']);
    });

    it('P19.3-T3 AC-9 the chip follows the module the list shows — Oscar’s ten, unplaced, count for nothing', async () => {
      // UI-093: *"Training tile 2 / 28 vs list 12 / 28"*. The tile is the list's sum, module by module.
      for (const item of ['PROSPECT_LIST', 'CLIENT_RETENTION']) {
        const view = await read({ category: 'training', item });
        const done = view.tree.reduce((n, section) => n + section.done, 0);
        const of = view.tree.reduce((n, section) => n + section.of, 0);
        expect([item, chip(view, 'training')]).toEqual([item, { category: 'training', count: done, of }]);
      }
      expect(chip(await read(), 'training')).toEqual({ category: 'training', count: 3, of: 16 });
      expect(chip(await read({ category: 'training', item: 'CLIENT_RETENTION' }), 'training'))
        .toEqual({ category: 'training', count: 1, of: 16 });
    });
  });

  describe('P18.3-T1 AC-5 — Goal Setting', () => {
    it('P18.3-T1 AC-5 Set with the day it was saved, Not set — a goal saved with a zero target is none (OD-160)', async () => {
      const view = await read({ category: 'goals' });
      expect(view.selected).toEqual({ category: 'goals', item: null });
      expect(cellOf(view, 'INDAH')).toEqual({ status: 'set', done: true, on: '2026-01-05' });
      expect(cellOf(view, 'SARI')).toEqual({ status: 'not_set', done: false, on: null });
      expect(cellOf(view, 'OWNER')).toEqual({ status: 'not_set', done: false, on: null });
      expect(rows(view).filter((r) => r.cell.done).map((r) => r.name).sort()).toEqual(['Dimas Pratama', 'Indah Permatasari', 'Rina Wijaya']);
    });

    it('P18.3-T1 AC-5 a goal saved at 00:30 Jakarta time is that day’s, not the UTC day before', async () => {
      // Sari's goal was saved at 17:30 UTC on 3 February — 00:30 on 4 February in Jakarta. Given a target, it is set.
      await h.col('goals').updateOne({ membershipId: h.id('SARI') }, { $set: { annualApeTargetMinor: 100 * M } });
      try {
        expect(cellOf(await read({ category: 'goals' }), 'SARI')).toEqual({ status: 'set', done: true, on: '2026-02-04' });
      } finally {
        await h.col('goals').updateOne({ membershipId: h.id('SARI') }, { $set: { annualApeTargetMinor: 0 } });
      }
    });

    it('P18.3-T1 AC-5 writes no §3.5 entry: a goal is no activity record', async () => {
      const before = await auditCount();
      await read({ category: 'goals' });
      expect(await auditCount()).toBe(before);
    });
  });

  describe('P18.3-T1 AC-6 — Activity Mgmt', () => {
    it('P18.3-T1 AC-6 Logged with the latest day, Missed — over the last 7 days, today included', async () => {
      const view = await read({ category: 'activity' });
      expect(cellOf(view, 'RINA')).toEqual({ status: 'logged', done: true, on: TODAY });
      expect(cellOf(view, 'INDAH')).toEqual({ status: 'logged', done: true, on: '2026-09-10' });
      expect(cellOf(view, 'PEER_AAB')).toEqual({ status: 'logged', done: true, on: '2026-09-08' });
      expect(cellOf(view, 'PEER_AGENT')).toEqual({ status: 'missed', done: false, on: null });
      expect(cellOf(view, 'AGUS')).toEqual({ status: 'missed', done: false, on: null });
    });

    it('P18.3-T1 AC-6 the day boundary is Jakarta’s: at 23:59 on the 14th 8 September is in the window, at 00:01 on the 15th it is not', async () => {
      h.clock.set(new Date('2026-09-14T16:59:00Z'));
      let view = await read({ category: 'activity' });
      expect([view.today, cellOf(view, 'PEER_AAB').status]).toEqual(['2026-09-14', 'logged']);
      h.clock.set(new Date('2026-09-14T17:01:00Z'));
      view = await read({ category: 'activity' });
      expect([view.today, cellOf(view, 'PEER_AAB').status]).toEqual(['2026-09-15', 'missed']);
      expect(chip(view, 'activity')).toEqual({ category: 'activity', count: 3, of: 16 });
    });
  });

  describe('P18.3-T1 AC-7 — Activation (OD-158, OD-159)', () => {
    it('P18.3-T1 AC-7 Completed with the day, In progress, Overdue — an expired one with its end — and — for nobody’s', async () => {
      const view = await read({ category: 'activation' });
      expect(cellOf(view, 'DODI')).toEqual({ status: 'completed', done: true, on: '2026-05-20', endedOn: null });
      expect(cellOf(view, 'RINA')).toEqual({ status: 'in_progress', done: false, on: null, endedOn: null });
      expect(cellOf(view, 'PEER_AGENT')).toEqual({ status: 'in_progress', done: false, on: null, endedOn: null });
      expect(cellOf(view, 'BUDI')).toEqual({ status: 'overdue', done: false, on: null, endedOn: null });
      expect(cellOf(view, 'TARI')).toEqual({ status: 'overdue', done: false, on: null, endedOn: '2026-07-02' });
      expect(cellOf(view, 'LUKAS')).toEqual({ status: null, done: null, on: null, endedOn: null });
    });

    it('P18.3-T1 AC-7 exit test 3: the chip is ACTIVATION_COMPLETION_RATE over the members with an activation', async () => {
      // Dodi of Rina, Budi, Dodi, Tari and Yusuf; Oscar's graduation, unplaced, counts for nothing.
      expect(chip(await read({ category: 'activation' }), 'activation')).toEqual({ category: 'activation', count: 1, of: 5 });
    });

    it('P18.3-T1 AC-7 exit test 2: an Admin who leads nobody reads every hire’s status here, and is refused the roster and the detail', async () => {
      h.as('ADMIN');
      const view = await read({ category: 'activation' });
      expect(rows(view).filter((r) => r.cell.status !== null).map((r) => r.name).sort())
        .toEqual(['Budi Santoso', 'Dodi Kurniawan', 'Rina Wijaya', 'Tari Anggraini', 'Yusuf Ramadhan']);
      // Maya stands on the AB rung, so she holds a leader's grant — and coaches nobody: nothing is answered (404).
      expect((await http().get('/new-hires').expect(404)).body.error.code).toBe('NOT_FOUND');
      expect((await http().get(`/new-hires/${h.id('RINA')}`).expect(404)).body.error.code).toBe('NOT_FOUND');
      // As the Admin and the Owner alone, standing on no rung, they hold no activation grant at all (OD-158).
      for (const who of ['ADMIN', 'OWNER'] as const) {
        h.as(h.officeOnly(who));
        expect((await http().get('/new-hires').expect(403)).body.error.code).toBe('PERM_DENIED');
        expect((await http().get(`/new-hires/${h.id('RINA')}`).expect(403)).body.error.code).toBe('PERM_DENIED');
        expect(rows(await read({ category: 'activation' })).filter((r) => r.cell.status !== null)).toHaveLength(5);
      }
    });
  });

  describe('P18.3-T1 AC-9 — the audit (D-audit-tree)', () => {
    const owner = () => ({ actorMembershipId: h.id('OWNER'), actorUserId: h.ctx('OWNER').userId, effectiveUserId: null });
    const others = () => LISTED.filter((who) => who !== 'OWNER');

    it('P18.3-T1 AC-9 Activity: one entry per member listed but the reader, `kpm_compliance`, from the whole record, one insert', async () => {
      const since = await mark();
      // Exit review 4: one insert, proved at the seam and at the audit service — one call each, carrying every entry.
      const seam = jest.spyOn(h.wired.subjectReads, 'recordMany');
      const inserts = jest.spyOn(h.wired.audit, 'recordMany');
      const single = jest.spyOn(h.wired.audit, 'record');
      try {
        await read({ category: 'activity' });
        expect(seam).toHaveBeenCalledTimes(1);
        expect(inserts).toHaveBeenCalledTimes(1);
        expect((inserts.mock.calls[0][1] as unknown[]).length).toBe(15);
        expect(single).not.toHaveBeenCalled();
      } finally {
        seam.mockRestore();
        inserts.mockRestore();
        single.mockRestore();
      }
      const entries = await entriesSince(since);
      expect(entries.map((e) => e.targetMembershipId).sort()).toEqual(others().map((who) => h.id(who)).sort());
      for (const entry of entries) {
        expect(entry).toMatchObject({
          kpmId: KPM_A, targetCollection: 'memberships', targetId: entry.targetMembershipId, ...owner(),
          after: { surface: 'kpm_compliance', from: null, to: TODAY },
        });
      }
    });

    it('P18.3-T1 AC-9 Activation: one per member listed with an activation, `activation`, from its start date', async () => {
      const since = await mark();
      await read({ category: 'activation' });
      const entries = await entriesSince(since);
      const starts: Partial<Record<ComplianceWho, string>> = {
        RINA: '2026-08-01', BUDI: '2026-05-01', DODI: '2026-03-01', TARI: '2026-01-02', PEER_AGENT: TODAY,
      };
      expect(entries.map((e) => [e.targetMembershipId, e.after]).sort()).toEqual(
        (Object.entries(starts) as [ComplianceWho, string][])
          .map(([who, from]) => [h.id(who), { surface: 'activation', from, to: TODAY }]).sort(),
      );
    });

    it('P18.3-T1 AC-9 Training: one per member listed but the reader, `training`, from the whole record', async () => {
      const before = await reads('training');
      const since = await mark();
      await read({ category: 'training', item: 'CLIENT_RETENTION' });
      expect(await reads('training')).toBe(before + 15);
      for (const entry of await entriesSince(since)) expect(entry.after).toEqual({ surface: 'training', from: null, to: TODAY });
    });

    it('P18.3-T1 AC-9 a reader listed is never their own subject: the Admin’s read skips the Admin, not the Owner', async () => {
      h.as('ADMIN');
      const since = await mark();
      await read({ category: 'activity' });
      const targets = (await entriesSince(since)).map((e) => e.targetMembershipId);
      expect(targets).not.toContain(h.id('ADMIN'));
      expect(targets).toContain(h.id('OWNER'));
    });

    it('P18.3-T1 AC-9 goals, events and campaigns write none: no §3.5 entry, whatever the chips read', async () => {
      const since = await mark();
      for (const category of ['goals', 'events', 'campaigns']) await read({ category });
      expect(await entriesSince(since)).toEqual([]);
    });
  });

  it('serves no field the contract does not name on a T1 cell', async () => {
    for (const category of ['training', 'goals', 'activity'] as const) {
      const view = await read({ category });
      for (const row of rows(view)) expect([category, Object.keys(row.cell).sort()]).toEqual([category, ['done', 'on', 'status']]);
    }
    for (const row of rows(await read({ category: 'activation' }))) {
      expect(Object.keys(row.cell).sort()).toEqual(['done', 'endedOn', 'on', 'status']);
    }
  });

  it('answers a context with no office before reading anything', async () => {
    await expect(h.compliance.read(RequestContext.platform('root'))).rejects.toMatchObject({ code: 'TENANT_NO_MEMBERSHIP' });
  });
});
