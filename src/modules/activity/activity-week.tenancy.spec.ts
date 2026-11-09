import mongoose from 'mongoose';
import { FixedClock } from '@/common/clock/clock.port';
import { subPeriodActivityTarget } from '@/domain/metrics/sub-period-activity-target';
import { SUBJECT_READ_ACTION } from '@/modules/audit/subject-read-audit';
import { clearCollections, startMongo, stopMongo } from '../../../test/mongo';
import { configModule } from '../../../test/config-module';
import {
  buildCoachingOffice, KPM_A, ROSTER_NOW, type CoachingOffice, type Who,
} from '../../../test/coaching-office';

const M = 1_000_000 * 100;

/**
 * **`SUB_PERIOD_ACTIVITY_TARGET`, as `GET /activity/summary` serves it** (P11-T4 AC-4, AC-6;
 * `metrics-and-definitions.md` §A.4).
 *
 * The 7-day targets are this month's `SUMMARY_ACTIVITY_TARGET`s pro-rated: so this spec holds them to the
 * Summary's own *Monthly* targets for the same person, read through `GET /summary?for=`'s service, rather
 * than to numbers worked out a second time beside it — the session's Activity card and the coachee's
 * Summary tab must never disagree about the month. Then the edges the Summary has: a year already met, and
 * January, which has no last month.
 */
describe('P11-T4 AC-4 — the week’s targets are the month’s, pro-rated', () => {
  let wired: ReturnType<typeof configModule>;
  let office: CoachingOffice;
  const db = () => mongoose.connection.db!;

  beforeAll(async () => {
    await startMongo();
    wired = configModule(ROSTER_NOW);
    await clearCollections();
    office = await buildCoachingOffice(wired);
  }, 120_000);

  afterAll(stopMongo);

  afterEach(() => (wired.clock as FixedClock).set(ROSTER_NOW));

  /** The Summary's *Monthly* targets for `who`, as their coach reads them, pro-rated by the metric's own function. */
  const proRatedSummary = async (who: Who) => {
    const summary = await wired.summary.read(office.as('AGUS'), office.id[who]);
    const [leads, appointments, policies] = summary.activity.monthly.targets.map((t) => t.target);
    return leads === null
      ? null
      : subPeriodActivityTarget({ leads, appointments: appointments!, policies: policies! });
  };
  const weekTargets = async (who: Who) =>
    (await wired.activityLogs.summary(office.as('AGUS'), { membershipId: office.id[who] })).targets;

  it.each(['INDAH', 'DIMAS', 'RINA'] as Who[])(
    'P11-T4 AC-4 serves %s’s week the Summary’s monthly targets, pro-rated — never a second calculation',
    async (who) => {
      const expected = await proRatedSummary(who);

      expect(expected).toEqual({ leads: 13, appointments: 4, policies: 1 });
      expect((await weekTargets(who)).map((t) => t.target))
        .toEqual([expected!.leads, expected!.appointments, expected!.policies]);
    },
  );

  it('P11-T4 AC-4 asks nothing of a week whose month needs nothing more: the year was met before it began (ADR-0047)', async () => {
    // Budi's Rp 500 M goal, and Rp 600 M on file through August — P19.5-T2 (ADR-0214 §10): the months' sum, January's
    // Rp 550 M and August's Rp 50 M, where the file's YTD column carried it before.
    const [goal] = await db().collection('goals').find({ membershipId: office.id.INDAH }).toArray();
    const { _id: _ignored, ...copy } = goal;
    await db().collection('goals').insertOne({ ...copy, membershipId: office.id.BUDI });
    await db().collection('monthlyAgentData').insertMany(([['2026-01', 550], ['2026-08', 50]] as const).map(([month, ape]) => ({
      kpmId: KPM_A, membershipId: office.id.BUDI, month, agentCode: 'BUDI', deletedAt: null, templateVersion: 1,
      values: { APE: { value: ape * M, provenance: 'imported', sourceBatchId: null } },
    })));

    expect(await proRatedSummary('BUDI')).toEqual({ leads: 0, appointments: 0, policies: 0 });
    expect((await weekTargets('BUDI')).map((t) => t.target)).toEqual([0, 0, 0]);
  });

  it('P11-T4 AC-4 in January, with no last month, still serves the Summary’s month pro-rated', async () => {
    (wired.clock as FixedClock).set(new Date('2026-01-14T03:00:00Z'));
    const expected = await proRatedSummary('INDAH');

    // Rp 500 M over twelve months, at Rp 18 M a case, 30% and 30%.
    expect(expected).not.toBeNull();
    expect((await weekTargets('INDAH')).map((t) => t.target))
      .toEqual([expected!.leads, expected!.appointments, expected!.policies]);
  });

  it('P11-T4 AC-4 counts against the office’s bound codes, never a position (invariant §4, ADR-0163)', async () => {
    const bindings = () => db().collection('activityBindings');
    await bindings().updateOne({ kpmId: KPM_A, deletedAt: null }, { $set: { leads: ['LEADS_GEN_ACTIVITY'] } });
    try {
      const [leads] = await weekTargets('DIMAS');
      expect(leads).toMatchObject({ key: 'leads', code: 'LEADS_GEN_ACTIVITY', codes: ['LEADS_GEN_ACTIVITY'], logged: 0 });
    } finally {
      await bindings().updateOne({ kpmId: KPM_A, deletedAt: null }, { $set: { leads: ['LEADS_CONTACTED'] } });
    }
  });

  it('P11-T4 AC-4 draws the subject’s tiles on the subject’s rung, not the reader’s (ADR-0020)', async () => {
    // The office shows Recruitment to its leaders only: Rina, an agent, has no such tile; Sari, an AAB, has.
    await db().collection('activityCategories').updateOne(
      { kpmId: KPM_A, code: 'RECRUITMENT' }, { $set: { appliesToOrgLevelCodes: ['AB', 'AAB'] } },
    );
    try {
      const tiles = async (who: Who) =>
        (await wired.activityLogs.summary(office.as('AGUS'), { membershipId: office.id[who] })).sections.map((s) => s.code);
      expect(await tiles('RINA')).toEqual(['DEVELOPMENT']);
      expect(await tiles('SARI')).toEqual(['RECRUITMENT', 'DEVELOPMENT']);
    } finally {
      await db().collection('activityCategories').updateOne(
        { kpmId: KPM_A, code: 'RECRUITMENT' }, { $set: { appliesToOrgLevelCodes: [] } },
      );
    }
  });

  it('P11-T4 groups the tiles exactly as the Summary does, over the week’s counts', async () => {
    const summary = await wired.summary.read(office.as('AGUS'), office.id.RINA);
    const week = await wired.activityLogs.summary(office.as('AGUS'), { membershipId: office.id.RINA });
    const shape = (sections: { code: string; label: string; rows: { code: string }[] }[]) =>
      sections.map((s) => [s.code, s.label, s.rows.map((r) => r.code)]);

    expect(shape(week.sections)).toEqual(shape(summary.activity.monthly.sections));
    // Rina logs 53 follow-ups and one coaching received a day: seven days of each in the week.
    expect(week.sections.find((s) => s.code === 'RECRUITMENT')!.total).toBe(7 * 53);
    expect(week.sections.find((s) => s.code === 'DEVELOPMENT')!.total).toBe(7);
  });

  describe('`weekOf`, the internal the session’s snapshot reads', () => {
    it('P11-T4 answers what `GET /activity/summary` answers for the last 7 days, and writes no entry', async () => {
      await db().collection('auditLog').deleteMany({});
      const subject = { membershipId: office.id.INDAH, orgLevelCode: 'AGENT' };

      const internal = await wired.activityLogs.weekOf(office.as('AGUS'), subject);
      expect(await db().collection('auditLog').countDocuments({ action: SUBJECT_READ_ACTION })).toBe(0);

      const routed = await wired.activityLogs.summary(office.as('AGUS'), { membershipId: office.id.INDAH });
      expect(internal).toEqual(routed);
      expect(await db().collection('auditLog').countDocuments({ action: SUBJECT_READ_ACTION })).toBe(1);
    });
  });

  describe('across offices (invariant §1)', () => {
    it('P11-T4 AC-5 refuses office B a member of office A as not found, on both reads', async () => {
      await expect(wired.activityLogs.summary(office.as('B_AB'), { membershipId: office.id.INDAH }))
        .rejects.toMatchObject({ code: 'NOT_FOUND', status: 404 });
      await expect(wired.activityLogs.ratios(office.as('B_AB'), office.id.INDAH))
        .rejects.toMatchObject({ code: 'NOT_FOUND', status: 404 });
    });
  });
});
