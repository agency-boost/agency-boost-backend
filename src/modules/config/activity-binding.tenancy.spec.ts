import mongoose from 'mongoose';
import { RequestContext } from '@/common/context/request-context';
import { PERFORMANCE } from '@/domain/constants';
import { clearCollections, startMongo, stopMongo, syncIndexes } from '../../../test/mongo';
import { configModule, provisionOffice } from '../../../test/config-module';
import { SUPER_ADMIN } from '../../../test/http-permissions';
import {
  buildCoachingOffice, COMPANY, KPM_A, KPM_B, ROSTER_TODAY, type CoachingOffice,
} from '../../../test/coaching-office';
import type { EvaluatedCampaignInput } from '@/modules/campaigns/campaign-evaluation';
import type { UnitDashboardView, UnitGroup, UnitRow } from '@/modules/unit-dashboard/unit-dashboard.service';

const TODAY = { leads: ['LEADS_CONTACTED'], appointments: ['SELL_PRESENTATION'], closings: ['SELL_SUBMISSION'] };
const wib = (local: string) => new Date(`${local}+07:00`);
const rowsOf = (group: UnitGroup): UnitRow[] => [group.head, ...group.members, ...group.units.flatMap(rowsOf)];
const everyRow = (view: UnitDashboardView): UnitRow[] => [...view.yourUnit.rows, ...view.units.flatMap(rowsOf)];

/**
 * **The activity binding on real rows** (P18.9-T2, ADR-0163): the coaching office of `test/coaching-office.ts` —
 * Rina logs 53 `RECRUIT_FOLLOWUP` a day and no cascade code, Dimas 2 `SELL_PRESENTATION` and 41 `RECRUIT_FOLLOWUP`
 * on ten days — read through every cascade reader the binding replaced: the Summary, coaching's week, the Unit
 * Dashboard, pace status, the measured rates, the goal's own answer and the campaigns' touches. Office 0555 (B) is
 * provisioned beside it, and nothing done to one reaches the other.
 */
describe('the activity binding (P18.9-T2, ADR-0163)', () => {
  let wired: ReturnType<typeof configModule>;
  let office: CoachingOffice;
  const db = () => mongoose.connection.db!;
  const B_OWNER = () => new RequestContext('u-b-owner', 'none', {
    membershipId: new mongoose.Types.ObjectId().toString(), kpmId: KPM_B, orgLevelCode: 'AB', hierarchyRole: 'ab',
    status: 'active', isKpmOwner: true, isKpmAdmin: false, directCount: 0,
  } as never);
  const rebind = (kpmId: string, binding: Record<string, string[]>) =>
    wired.activityBindings.updateForOffice(SUPER_ADMIN, kpmId, binding);
  const subject = (who: 'RINA' | 'DIMAS' | 'INDAH') => ({ membershipId: office.id[who], orgLevelCode: 'AGENT' });
  const leadsOf = (targets: { key: string; logged: number; codes?: string[] }[]) => targets.find((t) => t.key === 'leads')!;

  beforeAll(async () => {
    await startMongo();
    await syncIndexes();
    wired = configModule(new Date('2026-09-14T03:00:00Z'));
    await clearCollections();
    office = await buildCoachingOffice(wired);
    await provisionOffice(wired, KPM_B, COMPANY);
  }, 120_000);
  afterAll(stopMongo);

  it('P18.9-T2 AC-1 an office provisioned from the defaults binds today’s three codes, at version 1', async () => {
    expect(await wired.activityBindings.readOwn(office.as('OWNER'))).toMatchObject({ ...TODAY, version: 1 });
    expect(await wired.activityBindings.resolveCascadeBinding(B_OWNER())).toEqual(TODAY);
  });

  describe('AC-2: a role bound to [A, B] counts both, at every reader', () => {
    let before: {
      summary: Awaited<ReturnType<typeof wired.summary.read>>;
      week: Awaited<ReturnType<typeof wired.activityLogs.weekOf>>;
      unit: UnitDashboardView;
      pace: Awaited<ReturnType<typeof wired.paceStatus.paceOf>>;
      measured: Awaited<ReturnType<typeof wired.goals.readOrDefaults>>['measured'];
      goals: unknown[];
      sessions: unknown[];
    };
    const paceOf = () => wired.paceStatus.paceOf(office.as('OWNER'), [office.id.RINA], {
      today: ROSTER_TODAY, month: '2026-09', onTrackRatio: PERFORMANCE.ON_TRACK_PACE_THRESHOLD,
    });
    const touches = (code: string) => wired.campaignEvaluation.evaluate(office.as('OWNER'), [{
      code, version: 1, window: 'campaign_dates', startsAt: wib('2026-09-01T00:00:00'), endsAt: wib('2026-09-30T23:59:59.999'),
      appliesToOrgLevelCodes: [], requirements: [{ metricKey: 'CASCADE_ACTIVITY_TOUCHES', comparator: 'gte', value: 100 }],
      frozenWindows: [],
    } as EvaluatedCampaignInput], [office.id.RINA]).then((m) => m.get(code)!.members.get(office.id.RINA)!.rows[0]);

    beforeAll(async () => {
      before = {
        summary: await wired.summary.read(office.as('RINA')),
        week: await wired.activityLogs.weekOf(office.as('OWNER'), subject('RINA')),
        unit: await wired.unitDashboard.read(office.as('SARI'), { period: 'month' }),
        pace: await paceOf(),
        measured: (await wired.goals.readOrDefaults(office.as('DIMAS'), '2026')).measured,
        goals: await db().collection('goals').find({}).sort({ _id: 1 }).toArray(),
        sessions: await db().collection('coachingSessions').find({}).sort({ _id: 1 }).toArray(),
      };
      expect((await touches('TOUCHES_BEFORE')).current).toBe(0);
      // Set appointment is replaced by a follow-up: the old code keeps counting, and the new one counts too.
      await rebind(KPM_A, { ...TODAY, leads: ['LEADS_CONTACTED', 'RECRUIT_FOLLOWUP'] });
    });

    it('P18.9-T2 AC-2 the Summary’s Set appointment target sums both codes, and says which', async () => {
      expect(leadsOf(before.summary.activity.monthly.targets)).toMatchObject({ logged: 0, codes: ['LEADS_CONTACTED'] });
      const after = await wired.summary.read(office.as('RINA'));
      // 53 a day, 1 to 14 September.
      expect(leadsOf(after.activity.monthly.targets)).toMatchObject({
        key: 'leads', code: 'LEADS_CONTACTED', codes: ['LEADS_CONTACTED', 'RECRUIT_FOLLOWUP'], logged: 742,
      });
      // The Recruitment tile holds a bound code now, so the target chip counts it and the tile is not repeated.
      expect(after.activity.monthly.sections.map((s) => s.code)).not.toContain('RECRUITMENT');
    });

    it('P18.9-T2 AC-2 coaching’s week counts both, over its last 7 days', async () => {
      expect(leadsOf(before.week.targets).logged).toBe(0);
      const after = await wired.activityLogs.weekOf(office.as('OWNER'), subject('RINA'));
      expect(leadsOf(after.targets)).toMatchObject({ logged: 53 * 7, codes: ['LEADS_CONTACTED', 'RECRUIT_FOLLOWUP'] });
    });

    it('P18.9-T2 AC-2 the Unit Dashboard’s activity cells count both', async () => {
      const rina = (view: UnitDashboardView) => everyRow(view).find((r) => r.membershipId === office.id.RINA)!;
      expect(rina(before.unit).activity.leads.logged).toBe(0);
      const after = await wired.unitDashboard.read(office.as('SARI'), { period: 'month' });
      expect(rina(after).activity.leads.logged).toBe(742);
      expect(rina(after).activity.touches.logged).toBe(742);
    });

    it('P18.9-T2 AC-2 pace status counts both: Rina, who logged no cascade code, now paces', async () => {
      expect(before.pace.get(office.id.RINA)).toMatchObject({ status: 'needs_attention', pacingToMaa: false });
      expect((await paceOf()).get(office.id.RINA)).toMatchObject({ pacingToMaa: true });
      expect((await paceOf()).get(office.id.RINA)!.status).not.toBe('needs_attention');
    });

    it('P18.9-T2 AC-2 the measured rates divide by both', async () => {
      // Dimas: 20 meetings over no Set appointment — not enough data — then over 410.
      expect(before.measured).toMatchObject({ leadToAppointmentRate: null });
      const after = await wired.goals.readOrDefaults(office.as('DIMAS'), '2026');
      expect(after.measured).toMatchObject({ leadToAppointmentRate: 20 / 410 });
      // The goal screen’s chips read the binding from the same answer.
      expect(after.cascadeBinding).toEqual({ ...TODAY, leads: ['LEADS_CONTACTED', 'RECRUIT_FOLLOWUP'] });
    });

    it('P18.9-T2 AC-2 the campaigns’ cascade touches count both', async () => {
      expect(await touches('TOUCHES_AFTER')).toMatchObject({ current: 742, state: 'met' });
    });

    it('P18.9-T2 AC-6 a goal’s stored cascadeMapping and every coaching snapshot are unchanged by a rebind', async () => {
      expect(await db().collection('goals').find({}).sort({ _id: 1 }).toArray()).toEqual(before.goals);
      expect(await db().collection('coachingSessions').find({}).sort({ _id: 1 }).toArray()).toEqual(before.sessions);
      const read = await wired.goals.readOrDefaults(office.as('DIMAS'), '2026');
      expect(read.cascadeMapping).toEqual({
        leadsCode: 'LEADS_CONTACTED', appointmentsCode: 'SELL_PRESENTATION', closingsCode: 'SELL_SUBMISSION',
      });
    });

    it('P18.9-T2 AC-2 the pace sentence’s N counts every code bound to Submission polis', async () => {
      expect(before.summary.pace?.closingsLast30Days).toBe(0);
      await rebind(KPM_A, { ...TODAY, closings: ['SELL_SUBMISSION', 'DEV_COACHING_RECEIVED'] });
      // One a day for fourteen days, all inside the last 30.
      expect((await wired.summary.read(office.as('RINA'))).pace?.closingsLast30Days).toBe(14);
      await rebind(KPM_A, TODAY);
    });

    it('P18.9-T2 AC-3 office B is untouched by A’s rebinds', async () => {
      expect(await wired.activityBindings.readOwn(B_OWNER())).toMatchObject({ ...TODAY, version: 1 });
    });
  });

  describe('AC-3: the Super Admin’s write', () => {
    it('P18.9-T2 AC-3 bumps the version and audits activity_binding.updated with before and after, in that office', async () => {
      const start = await wired.activityBindings.readOwn(B_OWNER());
      const saved = await rebind(KPM_B, { ...TODAY, appointments: ['SELL_PRESENTATION', 'SELL_FOLLOWUP'] });
      expect(saved).toMatchObject({ kpmId: KPM_B, appointments: ['SELL_PRESENTATION', 'SELL_FOLLOWUP'], version: start.version + 1 });
      expect(saved.types.map((t) => t.code)).toContain('SELL_FOLLOWUP');
      const entry = await db().collection('auditLog').findOne(
        { action: 'activity_binding.updated', kpmId: KPM_B }, { sort: { _id: -1 } },
      );
      expect(entry).toMatchObject({
        targetCollection: 'activityBindings', targetId: KPM_B,
        before: { appointments: ['SELL_PRESENTATION'], version: start.version },
        after: { appointments: ['SELL_PRESENTATION', 'SELL_FOLLOWUP'], version: start.version + 1 },
      });
      await rebind(KPM_B, TODAY);
    });

    it('P18.9-T2 AC-3 refuses 400 a code the office does not hold — another office’s included — an empty role, and a code in two roles', async () => {
      for (const body of [
        { ...TODAY, leads: ['NOT_A_TYPE'] },
        { ...TODAY, leads: [] },
        { ...TODAY, appointments: ['SELL_SUBMISSION'] },
      ]) {
        await expect(rebind(KPM_B, body)).rejects.toMatchObject({ status: 400 });
      }
      // A type A holds and B does not is not B's to bind.
      const own = await wired.activity.createType(office.as('OWNER'), {
        code: 'A_ONLY_MEETING', categoryCode: 'SELLING', label: 'Meeting at A',
      });
      await expect(rebind(KPM_B, { ...TODAY, appointments: [own.code] })).rejects.toMatchObject({ status: 400 });
      expect(await wired.activityBindings.readOwn(B_OWNER())).toMatchObject(TODAY);
    });

    it('P18.9-T2 AC-3 an unknown office is 404, and a stale version 409', async () => {
      await expect(rebind(new mongoose.Types.ObjectId().toString(), TODAY)).rejects.toMatchObject({ status: 404 });
      await expect(rebind('not-an-id', TODAY)).rejects.toMatchObject({ status: 404 });
      const { version } = await wired.activityBindings.readOwn(B_OWNER());
      await expect(wired.activityBindings.updateForOffice(SUPER_ADMIN, KPM_B, { ...TODAY, expectedVersion: version - 1 }))
        .rejects.toMatchObject({ status: 409, code: 'VERSION_CONFLICT' });
    });

    it('P18.9-T2 AC-6 a plan first saved after a rebind records the binding’s first codes, and keeps them', async () => {
      const M = 1_000_000 * 100;
      await rebind(KPM_A, { ...TODAY, leads: ['RECRUIT_FOLLOWUP', 'LEADS_CONTACTED'] });
      try {
        const saved = await wired.goals.save(office.as('LUKAS'), {
          period: '2026', mode: 'direct', annualApeTargetMinor: 500 * M, savingsTargetMinor: 50 * M, commissionRatePct: 10,
          monthsLeft: 4, apeAchievedMinor: 0, caseSizeMinor: 18 * M, leadsToApptPct: 30, closingRatePct: 30,
        });
        expect(saved.cascadeMapping).toEqual({
          leadsCode: 'RECRUIT_FOLLOWUP', appointmentsCode: 'SELL_PRESENTATION', closingsCode: 'SELL_SUBMISSION',
        });
        expect(saved.cascadeBinding.leads).toEqual(['RECRUIT_FOLLOWUP', 'LEADS_CONTACTED']);
      } finally {
        await rebind(KPM_A, TODAY);
      }
      // The record stands; what the plan counts is the binding now.
      const read = await wired.goals.readOrDefaults(office.as('LUKAS'), '2026');
      expect(read.cascadeMapping.leadsCode).toBe('RECRUIT_FOLLOWUP');
      expect(read.cascadeBinding).toEqual(TODAY);
      await db().collection('goals').deleteOne({ membershipId: office.id.LUKAS });
    });

    it('P18.9-T2 AC-3 an Owner reads their own office’s binding at the admin route, and another office’s is 404', async () => {
      await expect(wired.activityBindings.readForOffice(office.as('OWNER'), KPM_A)).resolves.toMatchObject({ kpmId: KPM_A });
      await expect(wired.activityBindings.readForOffice(office.as('OWNER'), KPM_B)).rejects.toMatchObject({ status: 404 });
      // The write is the Super Admin's: the named method refuses anybody else, whatever the route said.
      await expect(wired.activityBindings.updateForOffice(office.as('OWNER'), KPM_A, TODAY)).rejects.toThrow();
    });
  });

  describe('an office with no binding yet (provisioned before ADR-0163, not yet migrated)', () => {
    it('P18.9-T2 AC-1 counts the default binding at version 0, and its first save writes version 1', async () => {
      await db().collection('activityBindings').deleteMany({ kpmId: KPM_B });
      expect(await wired.activityBindings.readOwn(B_OWNER())).toEqual({ ...TODAY, version: 0, updatedAt: null });
      expect(await wired.activityBindings.resolveCascadeBinding(B_OWNER())).toEqual(TODAY);
      await expect(rebind(KPM_B, TODAY)).resolves.toMatchObject({ ...TODAY, version: 1 });
      expect(await db().collection('activityBindings').countDocuments({ kpmId: KPM_B })).toBe(1);
      expect(await db().collection('activityBindings').findOne({ kpmId: KPM_B }))
        .toMatchObject({ status: 'active', archivedAt: null, deletedAt: null, version: 1 });
    });
  });

  describe('AC-4: a bound type cannot be archived; the platform codes are not reserved in themselves', () => {
    const typeOf = async (code: string) =>
      (await wired.activity.list(B_OWNER(), true)).flatMap((c) => c.types).find((t) => t.code === code)!;
    const sectionOf = async (code: string) => (await wired.activity.list(B_OWNER(), true)).find((c) => c.code === code)!;

    it('P18.9-T2 AC-4 refuses 409 ACTIVITY_TYPE_BOUND, naming the role, and archives once unbound', async () => {
      // Sales meeting is replaced: the new type is bound beside the old, and the old one cannot go yet.
      const meeting = await wired.activity.createType(B_OWNER(), { code: 'SALES_MEETING', categoryCode: 'SELLING', label: 'Sales meeting' });
      await rebind(KPM_B, { ...TODAY, appointments: ['SELL_PRESENTATION', 'SALES_MEETING'] });
      await expect(wired.activity.archiveType(B_OWNER(), (await typeOf('SELL_PRESENTATION')).id)).rejects.toMatchObject({
        status: 409, code: 'ACTIVITY_TYPE_BOUND', details: { codes: ['SELL_PRESENTATION'], roles: ['Sales meeting'] },
      });
      await expect(wired.activity.archiveType(B_OWNER(), meeting.id)).rejects.toMatchObject({ code: 'ACTIVITY_TYPE_BOUND' });
      // The section holding them, too.
      await expect(wired.activity.archiveCategory(B_OWNER(), (await sectionOf('SELLING')).id)).rejects.toMatchObject({
        code: 'ACTIVITY_TYPE_BOUND',
        details: { codes: expect.arrayContaining(['SELL_PRESENTATION', 'SELL_SUBMISSION', 'SALES_MEETING']) },
      });

      // Unbound, the platform's own code archives like any other type.
      await rebind(KPM_B, { ...TODAY, appointments: ['SALES_MEETING'] });
      await expect(wired.activity.archiveType(B_OWNER(), (await typeOf('SELL_PRESENTATION')).id))
        .resolves.toMatchObject({ code: 'SELL_PRESENTATION', status: 'archived' });
      // And, archived, it may still be bound: its history counts.
      await expect(rebind(KPM_B, { ...TODAY, appointments: ['SELL_PRESENTATION', 'SALES_MEETING'] })).resolves.toMatchObject({
        appointments: ['SELL_PRESENTATION', 'SALES_MEETING'],
      });
    });

    it('P18.9-T2 AC-4 the staged batch refuses it before anything of the batch is written', async () => {
      const followUp = await typeOf('SELL_FOLLOWUP');
      const meeting = await typeOf('SALES_MEETING');
      await expect(wired.changes.apply(B_OWNER(), [
        { op: 'type.update', id: followUp.id, expectedVersion: followUp.version, body: { label: 'Tindak lanjut' } },
        { op: 'type.archive', id: meeting.id, expectedVersion: meeting.version },
      ])).rejects.toMatchObject({
        code: 'ACTIVITY_TYPE_BOUND', status: 409,
        message: expect.stringMatching(/^Change 2 \(type\.archive\): “Sales meeting” cannot be archived/),
      });
      expect((await typeOf('SELL_FOLLOWUP')).label).toBe(followUp.label);
    });
  });

  describe('AC-5: a summary tile keeps an archived section’s types for a period holding counts for them', () => {
    it('P18.9-T2 AC-5 Development keeps the archived section’s counted type, and drops the one with nothing', async () => {
      const day = (localDate: string, counts: Record<string, number>) => db().collection('activityLogs').insertOne({
        kpmId: KPM_B, membershipId: office.id.B_AGENT, localDate,
        entries: Object.entries(counts).map(([code, count]) => ({ activityTypeId: `t-${code}`, activityTypeCode: code, count })),
        totalCount: 0, source: 'self', version: 1, frozenAt: null, corrections: [], deletedAt: null,
      } as never);
      await day('2026-09-05', { DEV_TRAINING_ATTEND: 3, DEV_TEAM_ACTIVITY: 2 });
      const personal = (await wired.activity.list(B_OWNER(), true)).find((c) => c.code === 'PERSONAL_DEVELOPMENT')!;
      await wired.activity.archiveCategory(B_OWNER(), personal.id);

      const development = (await wired.summary.read(office.as('B_AGENT'))).activity.monthly.sections
        .find((s) => s.code === 'DEVELOPMENT');
      expect(development).toEqual({
        code: 'DEVELOPMENT', label: 'Development', total: 5,
        rows: [
          { code: 'DEV_TRAINING_ATTEND', label: expect.any(String), count: 3 },
          { code: 'DEV_TEAM_ACTIVITY', label: expect.any(String), count: 2 },
        ],
      });
      // The year holds the same counts, and the same rows.
      const year = (await wired.summary.read(office.as('B_AGENT'))).activity.yearly.sections.find((s) => s.code === 'DEVELOPMENT');
      expect(year?.rows.map((r) => [r.code, r.count])).toEqual([['DEV_TRAINING_ATTEND', 3], ['DEV_TEAM_ACTIVITY', 2]]);
    });
  });
});
