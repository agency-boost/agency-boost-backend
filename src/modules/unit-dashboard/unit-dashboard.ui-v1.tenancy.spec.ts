import mongoose from 'mongoose';
import { clearCollections, startMongo, stopMongo } from '../../../test/mongo';
import { configModule } from '../../../test/config-module';
import {
  buildCoachingOffice, KPM_A, KPM_B, ROSTER_NOW, ROSTER_TODAY, type CoachingOffice, type Who,
} from '../../../test/coaching-office';
import { seedUnitLeads } from '../../../test/unit-office';
import type { UnitDashboardView, UnitGroup, UnitRow } from './unit-dashboard.service';

const rowsOf = (group: UnitGroup): UnitRow[] => [group.head, ...group.members, ...group.units.flatMap(rowsOf)];
const everyRow = (view: UnitDashboardView): UnitRow[] => [...view.yourUnit.rows, ...view.units.flatMap(rowsOf)];

/**
 * **The Unit Dashboard's UI V1 reads** (Phase 18.99 T4; `functional/unit-dashboard.md`, *UI V1 (2026-10-30)*) on real
 * rows, office 0417 (KPM A) beside 0555 (KPM B): *Closing* per person and *Last updated* (UI-028), and the *Activities*
 * tab's table and ratios (UI-001) — with its reach, its refusals and its tenant boundary. The office is
 * `test/coaching-office.ts`'s; *today* is Monday 14 September 2026 in Jakarta.
 */
describe('the Unit Dashboard, UI V1 (Phase 18.99 T4)', () => {
  let wired: ReturnType<typeof configModule>;
  let office: CoachingOffice;
  const db = () => mongoose.connection.db!;

  beforeAll(async () => {
    await startMongo();
    wired = configModule(ROSTER_NOW);
    await clearCollections();
    office = await buildCoachingOffice(wired);
    await seedUnitLeads(office);

    // Closings (O-4): sales leads moved to *Paid and issued*, each on its first move there.
    let n = 0;
    const paid = (who: Who, at: string, over: Record<string, unknown> = {}, kpmId = KPM_A) => {
      n += 1;
      return {
        kpmId, ownerMembershipId: office.id[who], type: 'sales', name: `Closed ${n}`, statusCode: 'PAID_AND_ISSUED',
        outcome: null, commitments: [], nextActionDate: null, version: 1, deletedAt: null,
        dateRegistered: new Date('2026-08-01T02:00:00Z'), contact: { phone: null, email: null },
        transitions: [{ toStatusCode: 'PAID_AND_ISSUED', at: new Date(at), byMembershipId: office.id[who] }],
        ...over,
      };
    };
    await db().collection('leads').insertMany([
      paid('INDAH', '2026-09-05T03:00:00Z'),
      paid('INDAH', '2026-08-20T03:00:00Z'),
      // 00:30 on 1 September in Jakarta: this month's, though August's in UTC.
      paid('RINA', '2026-08-31T17:30:00Z'),
      paid('RINA', '2026-09-13T03:00:00Z'),
      // A recruitment lead is a person joining, not a case; a deleted lead is no lead.
      paid('DIMAS', '2026-09-05T03:00:00Z', { type: 'recruitment' }),
      paid('DIMAS', '2026-09-05T03:00:00Z', { deletedAt: new Date('2026-09-06T03:00:00Z') }),
      paid('B_AGENT', '2026-09-05T03:00:00Z', {}, KPM_B),
    ]);
  }, 120_000);
  afterAll(stopMongo);

  const read = (who: Who, query: Parameters<typeof wired.unitDashboard.read>[1] = {}) =>
    wired.unitDashboard.read(office.as(who), query);
  const activities = (who: Who, query: Parameters<typeof wired.unitActivities.read>[1] = {}) =>
    wired.unitActivities.read(office.as(who), query);
  const closingsOf = (view: UnitDashboardView) =>
    Object.fromEntries(everyRow(view).filter((r) => r.closings > 0).map((r) => [r.name, r.closings]));

  describe('UI-028 Closing per person (O-4)', () => {
    it('UI-028 counts each person’s sales leads that reached Paid and issued this month, on the office’s calendar', async () => {
      const view = await read('AGUS');
      expect(closingsOf(view)).toEqual({ 'Indah Permatasari': 1, 'Rina Wijaya': 2 });
    });

    it('UI-028 follows the period: the last 7 days, and the year to date', async () => {
      expect(closingsOf(await read('AGUS', { period: '7d' }))).toEqual({ 'Rina Wijaya': 1 });
      expect(closingsOf(await read('AGUS', { period: 'year' }))).toEqual({ 'Indah Permatasari': 2, 'Rina Wijaya': 2 });
    });

    it('UI-028 a total’s Closing is its rows’: Your Unit holds Indah’s, Sari’s unit Rina’s', async () => {
      const view = await read('AGUS');
      expect(view.yourUnit.total.closings).toBe(1);
      expect(view.units.find((u) => u.head.name === 'Sari Puspita')!.total.closings).toBe(2);
    });

    it('UI-028 the other leads columns stay the leads module’s counts, as /leads counts them', async () => {
      const rows = everyRow(await read('AGUS'));
      const counts = await wired.leadReadings.countsOfMany(office.as('AGUS'), rows.map((r) => r.membershipId), { month: '2026-09' });
      for (const row of rows) expect({ who: row.name, counts: row.leadsCounts }).toEqual({ who: row.name, counts: counts.get(row.membershipId) });
    });

    it('UI-028 cross-tenant: office B’s closing is in office B’s figures and nowhere in office A’s', async () => {
      const b = await read('B_AB');
      expect(closingsOf(b)).toEqual({ 'Bayu Saputra': 1 });
      expect(JSON.stringify(await read('OWNER'))).not.toContain(office.id.B_AGENT);
    });
  });

  describe('UI-028 Last updated: the latest production import', () => {
    const batch = (kpmId: string, status: string, committedAt: string | null) => ({
      kpmId, month: '2026-09', status, filename: 'x.csv', fileSha256: 'x', templateVersion: 1, encoding: 'utf-8',
      delimiter: ',', basedOnRevision: 0, monthRevision: 1, rowCount: 1, writtenRowCount: 1, cellCount: 1, issueCount: 0,
      startedAt: new Date('2026-09-01T00:00:00Z'), committedAt: committedAt ? new Date(committedAt) : null, deletedAt: null,
    });

    it('UI-028 is null while the office has imported nothing', async () => {
      expect((await read('AGUS')).lastUpload).toBeNull();
      expect((await read('INDAH')).lastUpload).toBeNull();
    });

    it('UI-028 is the office’s day of its newest standing import — not a reverted one, not another office’s', async () => {
      await db().collection('dataUploadBatches').insertMany([
        // 01:00 on 11 September in Jakarta.
        batch(KPM_A, 'committed', '2026-09-10T18:00:00Z'),
        batch(KPM_A, 'committed', '2026-09-02T03:00:00Z'),
        batch(KPM_A, 'reverted', '2026-09-12T03:00:00Z'),
        batch(KPM_A, 'pending', null),
        batch(KPM_B, 'committed', '2026-09-13T03:00:00Z'),
      ]);
      expect((await read('AGUS')).lastUpload).toBe('2026-09-11');
      // The same date on every unit of the office, and on an empty one.
      expect((await read('SARI')).lastUpload).toBe('2026-09-11');
      expect((await read('INDAH')).lastUpload).toBe('2026-09-11');
      expect((await read('B_AB')).lastUpload).toBe('2026-09-13');
    });
  });

  describe('UI-001 the Activities tab', () => {
    it('UI-001 a week runs Monday to Sunday: the week before today’s, with › to the current one', async () => {
      const view = await activities('AGUS', { span: 'week', date: '2026-09-10' });
      expect(view.period).toEqual({
        span: 'week', from: '2026-09-07', to: '2026-09-13', current: false, previous: '2026-09-06', next: ROSTER_TODAY,
      });
      const indah = view.people.find((p) => p.membershipId === office.id.INDAH)!;
      // Indah logged on the 7th to the 10th: 2 and 37 a day.
      expect(indah.counts).toEqual([{ code: 'LEADS_CONTACTED', count: 8 }, { code: 'RECRUIT_FOLLOWUP', count: 148 }]);
      expect(indah.total).toBe(156);
    });

    it('UI-001 the current week by default; the month is its calendar month, with no ›', async () => {
      expect((await activities('AGUS')).period).toMatchObject({ span: 'week', from: ROSTER_TODAY, to: '2026-09-20', current: true, next: null });
      const month = await activities('AGUS', { span: 'month' });
      expect(month.period).toMatchObject({ from: '2026-09-01', to: '2026-09-30', current: true, next: null, previous: '2026-08-31' });
      expect(month.people.find((p) => p.membershipId === office.id.RINA)!.counts)
        .toEqual([{ code: 'DEV_COACHING_RECEIVED', count: 14 }, { code: 'RECRUIT_FOLLOWUP', count: 742 }]);
    });

    it('UI-001 one column per person in the roster’s order; the Unit is Your Unit’s rows', async () => {
      const [view, dashboard] = await Promise.all([activities('AGUS', { span: 'month' }), read('AGUS')]);
      expect(view.people.map((p) => p.membershipId)).toEqual(everyRow(dashboard).map((r) => r.membershipId));
      expect(view.people.filter((p) => p.inUnit).map((p) => p.membershipId))
        .toEqual(dashboard.yourUnit.rows.map((r) => r.membershipId));
      expect(view.people[0]).toMatchObject({ membershipId: office.id.AGUS, isReader: true, name: 'Agus Salim' });
    });

    it('UI-001 the Total column equals the sum of the person columns, for the Unit and for the Group', async () => {
      const view = await activities('AGUS', { span: 'month' });
      const totalOf = (people: typeof view.people) => {
        const byCode = new Map<string, number>();
        for (const p of people) for (const c of p.counts) byCode.set(c.code, (byCode.get(c.code) ?? 0) + c.count);
        return {
          counts: [...byCode].sort(([a], [b]) => a.localeCompare(b)).map(([code, count]) => ({ code, count })),
          total: people.reduce((s, p) => s + p.total, 0),
        };
      };
      expect(view.totals.unit).toEqual(totalOf(view.people.filter((p) => p.inUnit)));
      expect(view.totals.group).toEqual(totalOf(view.people));
      // Each person's total is their counts summed.
      for (const p of view.people) expect(p.total).toBe(p.counts.reduce((s, c) => s + c.count, 0));
      // Rina recruits in Sari's unit: the Group counts her, the Unit does not.
      expect(view.totals.group.total).toBeGreaterThan(view.totals.unit.total);
    });

    it('UI-001 the sections are the office’s, in its order, every active type listed', async () => {
      const view = await activities('AGUS');
      const listed = view.sections.flatMap((s) => s.types.map((t) => t.code));
      expect(listed).toEqual(expect.arrayContaining(['LEADS_CONTACTED', 'SELL_PRESENTATION', 'SELL_SUBMISSION', 'RECRUIT_FOLLOWUP']));
      expect(new Set(listed).size).toBe(listed.length);
      expect(view.sections.every((s) => s.status === 'active' && s.types.length > 0)).toBe(true);
      expect(view.sections.every((s) => s.types.every((t) => t.status === 'active'))).toBe(true);
    });

    it('UI-001 an archived type or section stays only while the period holds a count against it (ADR-0163 §6)', async () => {
      const archive = (collection: string, codes: string[], status: 'archived' | 'active') => db().collection(collection)
        .updateMany({ kpmId: KPM_A, code: { $in: codes } }, { $set: { status, archivedAt: status === 'archived' ? ROSTER_NOW : null } });
      const week = { span: 'week', date: '2026-09-10' } as const;
      const counted = new Set((await activities('AGUS', week)).people.flatMap((p) => p.counts.map((c) => c.code)));
      // The week before today's: Indah's follow-ups are counted; nobody logged an agent code or a team activity.
      expect([...counted]).toEqual(expect.arrayContaining(['RECRUIT_FOLLOWUP']));
      expect([counted.has('RECRUIT_AGENT_CODE'), counted.has('DEV_TEAM_ACTIVITY')]).toEqual([false, false]);

      await archive('activityTypes', ['RECRUIT_FOLLOWUP', 'RECRUIT_AGENT_CODE'], 'archived');
      await archive('activityCategories', ['RECRUITMENT', 'TEAM_DEVELOPMENT'], 'archived');
      try {
        const view = await activities('AGUS', week);
        const recruitment = view.sections.find((s) => s.code === 'RECRUITMENT');
        // Archived, and kept for the count against it; its archived type with nothing counted is gone.
        expect(recruitment).toMatchObject({ status: 'archived' });
        expect(recruitment!.types.map((t) => [t.code, t.status])).toEqual([['RECRUIT_PRESENTATION', 'active'], ['RECRUIT_FOLLOWUP', 'archived']]);
        // An archived section with nothing counted is not drawn at all.
        expect(view.sections.map((s) => s.code)).not.toContain('TEAM_DEVELOPMENT');
        // What is counted is unchanged by archiving: the follow-ups are still Indah's.
        expect(view.people.find((p) => p.membershipId === office.id.INDAH)!.counts)
          .toEqual(expect.arrayContaining([{ code: 'RECRUIT_FOLLOWUP', count: 148 }]));
      } finally {
        await archive('activityTypes', ['RECRUIT_FOLLOWUP', 'RECRUIT_AGENT_CODE'], 'active');
        await archive('activityCategories', ['RECRUITMENT', 'TEAM_DEVELOPMENT'], 'active');
      }
      expect((await activities('AGUS', week)).sections.map((s) => s.code)).toEqual(expect.arrayContaining(['RECRUITMENT', 'TEAM_DEVELOPMENT']));
    });

    it('UI-001 a person whose name is not on file is an empty name, the head included; their column and counts stay', async () => {
      const userOf = async (who: Who) => {
        const membership = await db().collection('memberships').findOne({ _id: new mongoose.Types.ObjectId(office.id[who]) });
        return { _id: new mongoose.Types.ObjectId(String(membership!.userId)) };
      };
      const [agus, indah] = [await userOf('AGUS'), await userOf('INDAH')];
      const before = await activities('AGUS', { span: 'month' });
      await db().collection('users').updateMany({ _id: { $in: [agus._id, indah._id] } }, { $set: { fullName: '' } });
      try {
        const view = await activities('AGUS', { span: 'month' });
        expect(view.head).toMatchObject({ membershipId: office.id.AGUS, name: '', isReader: true });
        const column = (v: typeof view, who: Who) => v.people.find((p) => p.membershipId === office.id[who])!;
        expect(column(view, 'AGUS').name).toBe('');
        expect(column(view, 'INDAH')).toEqual({ ...column(before, 'INDAH'), name: '' });
        expect(view.totals).toEqual(before.totals);
      } finally {
        await db().collection('users').updateOne(agus, { $set: { fullName: office.name.AGUS } });
        await db().collection('users').updateOne(indah, { $set: { fullName: office.name.INDAH } });
      }
    });

    it('UI-001 a read that asks for nothing is the current week, as the tab opens', async () => {
      const opened = await wired.unitActivities.read(office.as('AGUS'));
      expect(opened.period).toMatchObject({ span: 'week', from: ROSTER_TODAY, to: '2026-09-20', current: true });
      expect(opened.people.map((p) => p.membershipId)).toEqual((await activities('AGUS', { span: 'week' })).people.map((p) => p.membershipId));
    });

    it('UI-001 the ratios are the Ratio page’s logic over the same people and window: one person’s set is GET /activity/ratios', async () => {
      const ctx = office.as('AGUS');
      const one = await wired.activityLogs.ratiosOfSets(ctx, { indah: [office.id.INDAH] }, 'AGENT');
      const page = await wired.activityLogs.ratiosOf(ctx, { membershipId: office.id.INDAH, orgLevelCode: 'AGENT' });
      expect({ from: one.from, to: one.to, days: one.days, ratios: one.ratios.indah })
        .toEqual({ from: page.from, to: page.to, days: page.days, ratios: page.ratios });
    });

    it('UI-001 the Unit’s and the Group’s ratios sum their people’s counts, over the last 30 days whatever the period', async () => {
      const ctx = office.as('AGUS');
      const view = await activities('AGUS', { span: 'week', date: '2026-08-05' });
      expect(view.ratios).toMatchObject({ from: '2026-08-16', to: ROSTER_TODAY, days: 30 });
      for (const scope of ['unit', 'group'] as const) {
        const ids = view.people.filter((p) => scope === 'group' || p.inUnit).map((p) => p.membershipId);
        const each = await Promise.all(ids.map((id) => wired.activityLogs.ratiosOf(ctx, { membershipId: id, orgLevelCode: 'AB' })));
        for (const ratio of view.ratios[scope]) {
          const mine = each.map((e) => e.ratios.find((r) => r.code === ratio.code)!);
          expect({ scope, code: ratio.code, n: ratio.numeratorCount, d: ratio.denominatorCount }).toEqual({
            scope, code: ratio.code,
            n: mine.reduce((s, r) => s + r.numeratorCount, 0),
            d: mine.reduce((s, r) => s + r.denominatorCount, 0),
          });
        }
      }
      // The switch changes them: Rina's recruiting is in the Group's and not the Unit's.
      expect(view.ratios.group).not.toEqual(view.ratios.unit);
    });

    it('UI-001 one entry per person shown other than the reader, surface unit_dashboard, over the days disclosed', async () => {
      await db().collection('auditLog').deleteMany({});
      const view = await activities('AGUS', { span: 'week', date: '2026-09-10' });
      const entries = await db().collection('auditLog').find({ action: 'activity_log.read_raw' }).toArray();
      expect(entries.map((e) => e.targetMembershipId).sort())
        .toEqual(view.people.filter((p) => !p.isReader).map((p) => p.membershipId).sort());
      for (const entry of entries) {
        expect(entry).toMatchObject({ kpmId: KPM_A, after: { surface: 'unit_dashboard', from: '2026-08-16', to: ROSTER_TODAY } });
      }
    });

    it('UI-001 refuses a day after today, and a day that is not one', async () => {
      await expect(activities('AGUS', { date: '2026-09-15' })).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
      await expect(activities('AGUS', { date: '2026-02-30' })).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
    });
  });

  describe('UI-001 the Activities tab’s reach and tenant boundary', () => {
    it('UI-001 an AAB reads their own group; an AB a unit below them with for', async () => {
      expect((await activities('SARI')).people.map((p) => p.name))
        .toEqual(['Sari Puspita', 'Budi Santoso', 'Rina Wijaya', 'Nina Lestari', 'Dodi Kurniawan']);
      const nina = await activities('AGUS', { for: office.id.NINA });
      expect(nina.head).toEqual({ membershipId: office.id.NINA, name: 'Nina Lestari', isReader: false });
      expect(nina.people.map((p) => p.name)).toEqual(['Nina Lestari', 'Dodi Kurniawan']);
    });

    it('UI-001 somebody who leads nobody is answered an empty unit, never refused, and nothing is recorded', async () => {
      await db().collection('auditLog').deleteMany({});
      const view = await activities('INDAH');
      expect(view).toMatchObject({ empty: true, people: [], totals: { unit: { counts: [], total: 0 }, group: { counts: [], total: 0 } } });
      expect(await db().collection('auditLog').countDocuments({})).toBe(0);
    });

    it('UI-001 outside the reach is 404: somebody who leads nobody, a peer’s unit, another office’s leader', async () => {
      for (const named of ['INDAH', 'PEER_AB', 'B_AB', 'AGUS'] as const) {
        await expect(activities('AGUS', { for: office.id[named] })).rejects.toMatchObject({ code: 'NOT_FOUND' });
      }
      await expect(activities('SARI', { for: office.id.AGUS })).rejects.toMatchObject({ code: 'NOT_FOUND' });
    });

    it('L8 an Agent who leads people reads their own downline’s counts — it is their Unit Dashboard — audited unit_dashboard', async () => {
      await db().collection('auditLog').deleteMany({});
      const view = await activities('LUKAS', { span: 'month' });
      expect(view.head).toEqual({ membershipId: office.id.LUKAS, name: 'Lukas Hartono', isReader: true });
      expect(view.people.map((p) => p.name)).toEqual(['Lukas Hartono', 'Tari Anggraini']);
      const entries = await db().collection('auditLog').find({ action: 'activity_log.read_raw' }).toArray();
      expect(entries.map((e) => e.targetMembershipId)).toEqual([office.id.TARI]);
      expect(entries[0]).toMatchObject({ after: { surface: 'unit_dashboard' } });
      // Nobody above or beside them.
      await expect(activities('LUKAS', { for: office.id.AGUS })).rejects.toMatchObject({ code: 'NOT_FOUND' });
    });

    it('L7 an AAB naming a peer AAB is 404 — Dewi beside her under Agus, Putu under another AB — and nothing is recorded', async () => {
      await db().collection('auditLog').deleteMany({});
      for (const peer of ['DEWI', 'PEER_AAB'] as const) {
        await expect(activities('SARI', { for: office.id[peer] })).rejects.toMatchObject({ code: 'NOT_FOUND' });
      }
      expect(await db().collection('auditLog').countDocuments({})).toBe(0);
      // Her own nested unit is hers to read.
      expect((await activities('SARI', { for: office.id.NINA })).people.map((p) => p.name)).toEqual(['Nina Lestari', 'Dodi Kurniawan']);
    });

    it('UI-001 cross-tenant: office B’s leader reads office B’s people and counts, never office A’s', async () => {
      const b = await activities('B_AB', { span: 'month' });
      expect(b.people.map((p) => p.name)).toEqual(['Lina Marlina', 'Bayu Saputra']);
      const json = JSON.stringify(b);
      for (const who of ['AGUS', 'INDAH', 'RINA'] as const) expect(json).not.toContain(office.id[who]);
      expect(b.totals.group.total).toBe(0);
      // And office A's owner, reading the whole office's leaders, never office B's.
      await expect(activities('OWNER', { for: office.id.B_AB })).rejects.toMatchObject({ code: 'NOT_FOUND' });
    });
  });
});
