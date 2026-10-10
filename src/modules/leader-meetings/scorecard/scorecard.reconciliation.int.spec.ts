import mongoose from 'mongoose';
import { monthlyActiveAgent } from '@/domain/metrics/monthly-active-agent';
import { memberAt, officeHeadcount } from '@/domain/metrics/office-headcount';
import { MonthlyAgentData } from '@/modules/production/monthly-agent-data.schema';
import { MonthlyAgentDataRepository } from '@/modules/production/monthly-agent-data.repository';
import { VALUE_COLUMNS } from '@/modules/production/production-preview';
import { TEMPLATE_HEADER_V1 } from '@/modules/production/production-template';
import type { KpmAnalyticsView } from '@/modules/reporting/kpm-analytics.service';
import { clearCollections, startMongo, stopMongo } from '../../../../test/mongo';
import { configModule } from '../../../../test/config-module';
import { KPM_A, ROSTER_NOW, type Who } from '../../../../test/coaching-office';
import { buildReportingOffice, type ReportingOffice } from '../../../../test/reporting-office';
import { LeaderScorecardService } from './scorecard.service';
import type { ColumnKey, ComputedScorecard, RowKey, ScorecardCell } from './scorecard.types';

const M = 1_000_000 * 100;
const JAKARTA = 'Asia/Jakarta';
/** In two days: live, its periods ending today, 14 September 2026. */
const MEETING = '2026-09-16';
const LAST_YEAR = Array.from({ length: 12 }, (_, i) => `2025-${String(i + 1).padStart(2, '0')}`);
const THIS_YEAR = Array.from({ length: 9 }, (_, i) => `2026-${String(i + 1).padStart(2, '0')}`);
/** The end of a local day, and of a month, in Jakarta: 00:00 the next day, as `Clock` gives it. */
const endOfDay = (day: string) => new Date(new Date(`${day}T00:00:00+07:00`).getTime() + 86_400_000);
const startOf = (month: string) => new Date(`${month}-01T00:00:00+07:00`);
const endOfMonthOf = (month: string) => {
  const [y, m] = month.split('-').map(Number);
  return new Date(`${new Date(Date.UTC(y, m, 1)).toISOString().slice(0, 10)}T00:00:00+07:00`);
};

/** A member's month of the office's file, as the month table serves it — or, for a leaver, as their row holds it. */
interface FileRow {
  membershipId: string;
  ape: number | null;
  ytd: number | null;
  policies: number | null;
  newAA: number | null;
  maa: boolean | null;
}
interface MembershipRow { _id: unknown; status: 'active' | 'pending' | 'removed'; joinedAt: Date | null; removedAt: Date | null; orgLevelCode: string }

/**
 * **Exit test 1 of Phase 18.1** (P18.1-T2 AC-4): every cell the forum computes equals **Phase 18's figure for the same
 * scope and period, from the surface that owns it** — the headcount and its composition the Overview's
 * (`KpmOverviewService`), the year to date the Overview's, a month's production, policies, new active agents and
 * Monthly Active Agents the month table's (`ProductionService.readMonth`, a leaver's rows beside it as OD-74 keeps
 * them), the month's APE the analytics' chart, and the month's active count the analytics' total row
 * (`KpmAnalyticsService`) — over Phase 18's reporting office with last year on file, and through **a member joining,
 * a member removed mid-month (OD-74) and a month's file arriving**.
 */
describe('the forum’s scorecard reconciles with Phase 18’s figures (P18.1-T2 AC-4, exit test 1)', () => {
  let wired: ReturnType<typeof configModule>;
  let office: ReportingOffice;
  let scorecard: LeaderScorecardService;
  const db = () => mongoose.connection.db!;
  const owner = () => office.as('OWNER');
  const oid = (id: string) => new mongoose.Types.ObjectId(id);

  beforeAll(async () => {
    await startMongo();
    wired = configModule(ROSTER_NOW);
    await clearCollections();
    office = await buildReportingOffice(wired);

    // Last year on file: three members here since 2024, and a member who left last June.
    const cell = (value: number) => ({ value, provenance: 'imported', sourceBatchId: null });
    for (const who of ['INDAH', 'AGUS', 'SARI'] as const) {
      await db().collection('memberships').updateOne({ _id: oid(office.id[who]) }, { $set: { joinedAt: new Date('2024-06-01T03:00:00Z') } });
    }
    const leaver = new mongoose.Types.ObjectId();
    await db().collection('memberships').insertOne({
      _id: leaver, kpmId: KPM_A, userId: String(new mongoose.Types.ObjectId()), agentCode: 'PRU-70999', agentSeq: 199,
      leaderCode: 'LEFT2025', orgLevelId: 'x', orgLevelCode: 'AGENT', role: 'agent', leaderId: office.id.AGUS,
      ancestorIds: [office.id.OWNER, office.id.AGUS], depth: 2, status: 'removed',
      joinedAt: new Date('2024-06-01T03:00:00Z'), removedAt: new Date('2025-06-15T03:00:00Z'), deletedAt: null,
    });
    const year: Record<string, { ape: number; pol: number; nAA: number; to?: string }> = {
      [office.id.INDAH]: { ape: 20, pol: 1, nAA: 1 },
      [office.id.AGUS]: { ape: 30, pol: 2, nAA: 0 },
      [office.id.SARI]: { ape: 0, pol: 0, nAA: 0 },
      [String(leaver)]: { ape: 5, pol: 1, nAA: 1, to: '2025-06' },
    };
    await db().collection('monthlyAgentData').insertMany(Object.entries(year).flatMap(([membershipId, f]) =>
      LAST_YEAR.filter((month) => month <= (f.to ?? '2025-12')).map((month) => ({
        kpmId: KPM_A, membershipId, month, agentCode: 'x', deletedAt: null,
        apeMonthly: cell(f.ape * M), apeYtd: cell(f.ape * M * Number(month.slice(5))),
        policyCountMonthly: cell(f.pol), newActiveAgentsMonthly: cell(f.nAA),
      }))));
    // This year's August and September: new active agents on the file for two of the members held.
    for (const who of ['INDAH', 'AGUS'] as const) {
      await db().collection('monthlyAgentData').updateMany(
        { membershipId: office.id[who], month: { $in: ['2026-08', '2026-09'] } },
        { $set: { newActiveAgentsMonthly: cell(who === 'INDAH' ? 1 : 2) } },
      );
    }

    scorecard = new LeaderScorecardService(
      wired.officePeople, wired.productionReadings,
      new MonthlyAgentDataRepository(mongoose.model(MonthlyAgentData.name) as never), wired.activationRows, wired.clock,
    );
  }, 120_000);

  afterAll(stopMongo);

  /** A month of the office's file: the month table's rows, and each leaver's row beside them (OD-74). */
  async function fileOf(month: string): Promise<FileRow[]> {
    const table = (await wired.production.readMonth(owner(), month)).rows.map((r): FileRow => ({
      membershipId: r.membershipId,
      ape: r.metrics.ape.monthly.value, ytd: r.metrics.ape.ytd.value,
      policies: r.metrics.policyCount.monthly.value, newAA: r.metrics.newActiveAgents.monthly.value,
      maa: r.monthlyActiveAgent,
    }));
    const leavers = await db().collection('memberships').find({ kpmId: KPM_A, status: 'removed' }).toArray();
    const theirs = await db().collection('monthlyAgentData')
      .find({ kpmId: KPM_A, month, deletedAt: null, membershipId: { $in: leavers.map((l) => String(l._id)) } }).toArray();
    const listed = new Set(table.map((r) => r.membershipId));
    const leaverRows = theirs.filter((r) => !listed.has(r.membershipId)).map((r): FileRow => ({
      membershipId: r.membershipId, ape: r.apeMonthly?.value ?? null, ytd: r.apeYtd?.value ?? null,
      policies: r.policyCountMonthly?.value ?? null, newAA: r.newActiveAgentsMonthly?.value ?? null,
      maa: monthlyActiveAgent(r.apeMonthly?.value ?? null, r.policyCountMonthly?.value ?? null),
    }));
    return [...table.filter((r) => r.ape !== null || r.ytd !== null || r.policies !== null || r.newAA !== null), ...leaverRows];
  }

  const sum = (values: (number | null)[]) => {
    const held = values.filter((v): v is number => v !== null);
    return held.length === 0 ? null : held.reduce((a, b) => a + b, 0);
  };

  async function reconciles(label: string) {
    const at = (what: string) => `${label}: ${what}`;
    const card: ComputedScorecard = await scorecard.compute({ kpmId: KPM_A, timezone: JAKARTA, meetingDate: MEETING });
    const c = (key: RowKey, column: ColumnKey): ScorecardCell => card.rows.find((r) => r.key === key)!.cells[column];
    const value = (key: RowKey, column: ColumnKey) => {
      const got = c(key, column);
      return got.kind === 'figure' ? got.value : got.kind;
    };
    const overview = await wired.kpmOverview.read(owner());
    const now = await wired.kpmAnalytics.read(owner(), { period: 'this_month' }) as KpmAnalyticsView;
    const then = await wired.kpmAnalytics.read(owner(), { period: 'previous_month' }) as KpmAnalyticsView;
    const memberships = (await db().collection('memberships').find({ kpmId: KPM_A, deletedAt: null }).toArray())
      .map((m): MembershipRow => ({ _id: m._id, status: m.status, joinedAt: m.joinedAt ?? null, removedAt: m.removedAt ?? null, orgLevelCode: m.orgLevelCode }));
    const files = new Map<string, FileRow[]>();
    for (const month of [...LAST_YEAR, ...THIS_YEAR]) files.set(month, await fileOf(month));
    const held = (month: string) => files.get(month)!.some((r) => r.ape !== null || r.ytd !== null);

    // ---- The headcount and the chips: the Overview's, today.
    expect([at('chips'), card.chips]).toEqual([at('chips'), {
      manpower: overview.composition.total,
      agents: overview.composition.rungs.find((r) => r.code === 'AGENT')?.count ?? 0,
      ab: overview.composition.rungs.find((r) => r.code === 'AB')?.count ?? 0,
      units: overview.composition.rungs.find((r) => r.code === 'AB')?.count ?? 0,
      aab: overview.composition.rungs.find((r) => r.code === 'AAB')?.count ?? 0,
    }]);
    expect([at('manpower'), value('manpower', 'thisMonth'), value('manpower', 'ytd')])
      .toEqual([at('manpower'), overview.composition.total, overview.composition.total]);
    // An earlier period's last day: OFFICE_HEADCOUNT on the office's memberships, the Overview's function.
    for (const [column, day] of [['fy', '2025-12-31'], ['thisMonthLastYear', '2025-09-30'], ['lastMonth', '2026-08-31']] as const) {
      expect([at(`manpower ${column}`), value('manpower', column)]).toEqual([at(`manpower ${column}`), officeHeadcount(memberships, endOfDay(day))]);
    }

    // ---- APE: the Overview's year to date; a month the office's file — the chart's, and the table's with its leavers.
    expect([at('APE YTD'), value('ape', 'ytd')]).toEqual([at('APE YTD'), overview.production.ytd.achievedMinor ?? 'pending']);
    expect([at('APE last month = the chart'), value('ape', 'lastMonth')])
      .toEqual([at('APE last month = the chart'), now.monthly.find((m) => m.month === '2026-08')?.apeMinor ?? 'pending']);
    for (const [column, month] of [['thisMonth', '2026-09'], ['lastMonth', '2026-08'], ['thisMonthLastYear', '2025-09']] as const) {
      expect([at(`APE ${month}`), value('ape', column)]).toEqual([at(`APE ${month}`), sum(files.get(month)!.map((r) => r.ape)) ?? 'pending']);
    }
    // FY: each member's latest year to date of last year, from the tables, a leaver's included.
    const latestYtd = new Map<string, number>();
    for (const month of LAST_YEAR) for (const r of files.get(month)!) if (r.ytd !== null) latestYtd.set(r.membershipId, r.ytd);
    expect([at('APE FY'), value('ape', 'fy')]).toEqual([at('APE FY'), sum([...latestYtd.values()]) ?? 'pending']);

    // ---- Avg. Monthly AA: the analytics' total row's *Active this month* and *last month*, and their mean.
    expect([at('MAA this month'), value('avg_monthly_aa', 'thisMonth')]).toEqual([at('MAA this month'), now.total.activeAgents ?? 'pending']);
    expect([at('MAA last month'), value('avg_monthly_aa', 'lastMonth')]).toEqual([at('MAA last month'), then.total.activeAgents ?? 'pending']);
    // Each held month's count, from the table: its members on its last day (today, for this one) showing ✓.
    const maaIn = (month: string, end: Date) => files.get(month)!.filter((r) => r.maa === true
      && memberships.some((m) => String(m._id) === r.membershipId && memberAt(m, end))).length;
    const endOf = (month: string) => (month === '2026-09' ? endOfDay('2026-09-14') : endOfMonthOf(month));
    // This year's held months: August and September the analytics' own counts, any other the table's.
    const countOf = (m: string) => (m === '2026-09' ? now.total.activeAgents! : m === '2026-08' ? then.total.activeAgents! : maaIn(m, endOf(m)));
    const thisYearHeld = THIS_YEAR.filter(held);
    expect(thisYearHeld).toEqual(expect.arrayContaining(['2026-08', '2026-09']));
    expect([at('MAA YTD = the analytics’ months'), value('avg_monthly_aa', 'ytd')])
      .toEqual([at('MAA YTD = the analytics’ months'), thisYearHeld.reduce((n, m) => n + countOf(m), 0) / thisYearHeld.length]);
    const lastYearHeld = LAST_YEAR.filter(held);
    expect([at('MAA FY'), value('avg_monthly_aa', 'fy')]).toEqual([
      at('MAA FY'), lastYearHeld.reduce((n, m) => n + maaIn(m, endOf(m)), 0) / lastYearHeld.length,
    ]);
    expect([at('MAA months agree'), maaIn('2026-09', endOf('2026-09')), maaIn('2026-08', endOf('2026-08'))])
      .toEqual([at('MAA months agree'), now.total.activeAgents, then.total.activeAgents]);

    // ---- Case submission and New AA: the table's policies and new active agents, with its leavers.
    const perMonth = (pick: (r: FileRow) => number | null) => (month: string) => sum(files.get(month)!.map(pick));
    const policies = perMonth((r) => r.policies);
    const newAA = perMonth((r) => r.newAA);
    for (const [column, month] of [['thisMonth', '2026-09'], ['lastMonth', '2026-08'], ['thisMonthLastYear', '2025-09']] as const) {
      expect([at(`policies ${month}`), value('case_submission', column)]).toEqual([at(`policies ${month}`), policies(month) ?? 'pending']);
      expect([at(`new AA ${month}`), value('new_aa', column)]).toEqual([at(`new AA ${month}`), newAA(month) ?? 'pending']);
    }
    for (const [column, months] of [['fy', LAST_YEAR], ['ytd', THIS_YEAR]] as const) {
      expect([at(`policies ${column}`), value('case_submission', column)])
        .toEqual([at(`policies ${column}`), sum(months.map(policies)) ?? 'pending']);
      const carried = months.map(newAA).filter((v): v is number => v !== null);
      expect([at(`new AA ${column}`), value('new_aa', column)])
        .toEqual([at(`new AA ${column}`), carried.length === 0 ? 'pending' : carried.reduce((a, b) => a + b, 0) / carried.length]);
      // Average Case Size: the same months' APE over their policies.
      const both = months.filter((m) => sum(files.get(m)!.map((r) => r.ape)) !== null && policies(m) !== null);
      const pols = both.reduce((n, m) => n + policies(m)!, 0);
      const ape = both.reduce((n, m) => n + sum(files.get(m)!.map((r) => r.ape))!, 0);
      expect([at(`case size ${column}`), value('average_case_size', column)])
        .toEqual([at(`case size ${column}`), both.length === 0 ? 'pending' : pols === 0 ? 'none' : Math.round(ape / pols)]);
      // Producing agents: a ✓ in a held month the member belonged to the office in — joined before it ended, not
      // removed before it began — each member once.
      const producing = new Set(months.filter(held).flatMap((m) => files.get(m)!.filter((r) => {
        const member = memberships.find((x) => String(x._id) === r.membershipId);
        return r.maa === true && member !== undefined
          && (member.joinedAt === null || member.joinedAt < endOf(m))
          && (member.status === 'active' || (member.removedAt !== null && member.removedAt > startOf(m)));
      }).map((r) => r.membershipId)));
      expect([at(`producing ${column}`), value('producing_agents', column)])
        .toEqual([at(`producing ${column}`), months.some(held) ? producing.size : 'pending']);
    }

    // ---- FLC: pending everywhere (OD-26).
    expect([at('FLC'), Object.values(card.rows.find((r) => r.key === 'flc')!.cells).map((x) => x.kind)])
      .toEqual([at('FLC'), Array(5).fill('pending')]);
    return card;
  }

  it('P18.1-T2 AC-4 exit test 1 over the office as it stands', async () => {
    const card = await reconciles('as it stands');
    // The office holds August and September this year, and last year whole: what reconciled are figures, not two
    // *pending data* agreeing — FLC and This Month's new active agents aside, which nothing on file carries.
    const kinds = Object.fromEntries(card.rows.map((r) => [r.key, Object.values(r.cells).map((x) => x.kind).join(' ')]));
    expect(kinds).toEqual({
      ape: 'figure figure figure figure figure',
      manpower: 'figure figure figure figure figure',
      flc: 'pending pending pending pending pending',
      producing_agents: 'figure figure blocked blocked blocked',
      new_aa: 'figure figure figure figure figure',
      new_agent_3m: 'pending pending blocked blocked blocked',
      avg_monthly_aa: 'figure figure figure figure figure',
      case_submission: 'figure figure figure figure figure',
      average_case_size: 'figure figure blocked blocked blocked',
    });
  }, 120_000);

  it('P18.1-T2 AC-4 exit test 1 through a member joining, a member removed mid-month (OD-74), and a month’s file arriving', async () => {
    // A member joins this month, under Sari, with production on September's file.
    const sari = await db().collection('memberships').findOne({ _id: oid(office.id.SARI) });
    const joined = new mongoose.Types.ObjectId();
    const userId = new mongoose.Types.ObjectId();
    await db().collection('users').insertOne({ _id: userId, email: 'nadia@score.test', passwordHash: 'x', fullName: 'Nadia Putri', status: 'active', deletedAt: null });
    await db().collection('memberships').insertOne({
      _id: joined, kpmId: KPM_A, userId: String(userId), agentCode: 'PRU-79999', agentSeq: 99, leaderCode: 'NEWJOIN1', orgLevelId: 'x',
      orgLevelCode: 'AGENT', role: 'agent', leaderId: office.id.SARI, ancestorIds: [...sari!.ancestorIds, office.id.SARI], depth: 3,
      status: 'active', joinedAt: new Date('2026-09-08T03:00:00Z'), removedAt: null, deletedAt: null,
    });
    await db().collection('monthlyAgentData').insertOne({
      kpmId: KPM_A, membershipId: String(joined), month: '2026-09', agentCode: 'PRU-79999', deletedAt: null,
      apeMonthly: { value: 7 * M, provenance: 'imported', sourceBatchId: null }, apeYtd: { value: 7 * M, provenance: 'imported', sourceBatchId: null },
      policyCountMonthly: { value: 1, provenance: 'imported', sourceBatchId: null },
    });
    const before = await scorecard.compute({ kpmId: KPM_A, timezone: JAKARTA, meetingDate: MEETING });
    const after = await reconciles('after a join');
    expect(after.chips.manpower).toBe(before.chips.manpower);

    // A member with production leaves mid-month: out of every count of people, their production the office's.
    await db().collection('memberships').updateOne(
      { _id: oid(office.id.DIMAS) }, { $set: { status: 'removed', removedAt: new Date('2026-09-11T03:00:00Z') } },
    );
    const removed = await reconciles('after a removal mid-month');
    expect(removed.chips.manpower).toBe(after.chips.manpower - 1);
    expect(removed.rows.find((r) => r.key === 'ape')!.cells.ytd).toEqual(after.rows.find((r) => r.key === 'ape')!.cells.ytd);

    // A month's file arriving: July, where there was none — reopened first, its window long closed.
    const agentCodeOf = async (who: Who) => (await db().collection('memberships').findOne({ _id: oid(office.id[who]) }))!.agentCode as string;
    const file = {
      buffer: Buffer.from([
        TEMPLATE_HEADER_V1.join(','),
        ...(await Promise.all(([['INDAH', { 'ape.monthly': '30', 'ape.ytd': '140', 'policyCount.monthly': '2', 'newActiveAgents.monthly': '1' }],
          ['RINA', { 'ape.monthly': '10', 'ape.ytd': '150', 'policyCount.monthly': '1' }]] as [Who, Record<string, string>][])
          .map(async ([who, cells]) => [await agentCodeOf(who), '"x"', ...VALUE_COLUMNS.map((v) => cells[`${v.metric}.${v.cadence}`] ?? '')].join(',')))),
      ].join('\n')),
      originalname: 'july.csv',
      size: 0,
    };
    await wired.productionMonths.reopen(owner(), '2026-07');
    const preview = await wired.production.preview(owner(), '2026-07', file);
    await wired.productionImport.commit(owner(), '2026-07', String(preview.revision), file);
    const july = await reconciles('after a month’s file arrived');
    const ytd = (card: ComputedScorecard, key: RowKey) => card.rows.find((r) => r.key === key)!.cells.ytd as { leavesOut: string[] };
    // July is held now: no cell of the year leaves it out any more.
    expect(ytd(removed, 'case_submission').leavesOut).toContain('2026-07');
    expect(ytd(july, 'case_submission').leavesOut).not.toContain('2026-07');
  }, 180_000);
});
