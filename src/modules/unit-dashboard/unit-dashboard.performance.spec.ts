import mongoose from 'mongoose';
import { byKode } from '@/modules/production/upload-columns';
import { RequestContext } from '@/common/context/request-context';
import { clearCollections, startMongo, stopMongo } from '../../../test/mongo';
import { configModule, provisionOffice } from '../../../test/config-module';
import type { UnitDashboardView } from './unit-dashboard.service';

/** 10:00 on 14 September in Jakarta: eight months on file, a fortnight of September logged. */
const NOW = new Date('2026-09-14T03:00:00Z');
const KPM_A = '66f0000000000000000000a1';
const COMPANY = '66f0000000000000000000c1';
const M = 1_000_000 * 100;

/** The 500-member ceiling (`performance-and-scale.md`): one AB, ten AABs, forty-nine agents under each. */
const UNITS = 10;
const PER_UNIT = 49;
const DAYS = 14;
const MONTHS = ['01', '02', '03', '04', '05', '06', '07', '08', '09'].map((m) => `2026-${m}`);

const ctxFor = (membershipId: string, rung: 'AB' | 'AAB') => new RequestContext(`u-${membershipId}`, 'none', {
  membershipId, kpmId: KPM_A, orgLevelCode: rung, hierarchyRole: rung.toLowerCase(),
  status: 'active', isKpmOwner: false, isKpmAdmin: false, directCount: rung === 'AB' ? UNITS : PER_UNIT,
} as never);

/**
 * **The Unit Dashboard read, measured** (P15-T1 AC-8, D-api): computed on each read and not paginated, so
 * its cost is **a fixed number of queries whatever the roster's size** — none per person — and *Open Unit
 * Dashboard (50 people) < 2 s* (`performance-and-scale.md`). The read at the 500-member ceiling is recorded
 * for P18-T7, which hardens it.
 */
describe('the Unit Dashboard, measured (P15-T1 AC-8)', () => {
  let wired: ReturnType<typeof configModule>;
  let ab: string;
  const aabs: string[] = [];

  beforeAll(async () => {
    await startMongo();
    wired = configModule(NOW);
    await clearCollections();
    const db = mongoose.connection.db!;
    await (wired.kpms as { create: (d: unknown) => Promise<unknown> }).create(
      { _id: KPM_A, companyId: COMPANY, code: '0417', branchName: 'A', timezone: 'Asia/Jakarta' },
    );
    await wired.orgLevels.seedDefaultLadder(COMPANY);
    await provisionOffice(wired, KPM_A, COMPANY);

    const users: Record<string, unknown>[] = [];
    const members: Record<string, unknown>[] = [];
    let seq = 0;
    const place = (role: 'ab' | 'aab' | 'agent', leader: string | null, ancestors: string[]) => {
      seq += 1;
      const userId = new mongoose.Types.ObjectId();
      const id = new mongoose.Types.ObjectId();
      users.push({ _id: userId, email: `p${seq}@scale.test`, passwordHash: 'x', fullName: `Person ${String(seq).padStart(3, '0')}`, status: 'active', deletedAt: null });
      members.push({
        _id: id, kpmId: KPM_A, userId: String(userId), agentCode: `S${seq}`, agentSeq: seq, leaderCode: `SC${seq}`,
        orgLevelId: 'x', orgLevelCode: role.toUpperCase(), role, leaderId: leader, ancestorIds: ancestors,
        depth: ancestors.length, status: 'active', deletedAt: null,
      });
      return String(id);
    };
    ab = place('ab', null, []);
    const agents: string[] = [];
    for (let u = 0; u < UNITS; u += 1) {
      const aab = place('aab', ab, [ab]);
      aabs.push(aab);
      for (let a = 0; a < PER_UNIT; a += 1) agents.push(place('agent', aab, [ab, aab]));
    }
    await db.collection('users').insertMany(users);
    await db.collection('memberships').insertMany(members);

    const everyone = [...aabs, ...agents];
    const goals: Record<string, unknown>[] = [];
    const months: Record<string, unknown>[] = [];
    const logs: Record<string, unknown>[] = [];
    const sessions: Record<string, unknown>[] = [];
    const leads: Record<string, unknown>[] = [];
    const cell = (value: number) => ({ value, provenance: 'imported', sourceBatchId: null });
    everyone.forEach((id, i) => {
      goals.push({
        kpmId: KPM_A, membershipId: id, period: '2026', mode: 'direct', annualApeTargetMinor: 500 * M, savingsTargetMinor: 0,
        commissionRatePct: 0, monthsLeftOverride: null, apeAchievedMinor: 0, caseSizeMinor: 18 * M,
        leadsToApptPct: 30, closingRatePct: 30, savedAt: NOW, savedByMembershipId: id, version: 1, deletedAt: null,
        cascadeMapping: { leadsCode: 'LEADS_CONTACTED', appointmentsCode: 'SELL_PRESENTATION', closingsCode: 'SELL_SUBMISSION' },
      });
      MONTHS.forEach((month, m) => months.push({
        // By kode since P19.5-T2: the year to date is the months' sum, which these make 20 M a month (R4).
        kpmId: KPM_A, membershipId: id, month, agentCode: `S${i}`, deletedAt: null, templateVersion: 1,
        ...byKode({ apeMonthly: cell(20 * M), apeYtd: cell(20 * M * (m + 1)) }),
      }));
      for (let d = 1; d <= DAYS; d += 1) {
        logs.push({
          kpmId: KPM_A, membershipId: id, localDate: `2026-09-${String(d).padStart(2, '0')}`, source: 'self',
          enteredByMembershipId: id, version: 1, frozenAt: null, corrections: [], deletedAt: null, totalCount: 3,
          entries: [
            { activityTypeId: 't-l', activityTypeCode: 'LEADS_CONTACTED', count: 1 },
            { activityTypeId: 't-p', activityTypeCode: 'SELL_PRESENTATION', count: 1 },
            { activityTypeId: 't-r', activityTypeCode: 'RECRUIT_FOLLOWUP', count: 1 },
          ],
        });
      }
      for (const date of ['2026-08-31', `2026-09-0${(i % 9) + 1}`]) {
        sessions.push({
          kpmId: KPM_A, coachMembershipId: ab, coacheeMembershipId: id, status: 'finalized', date,
          frozenAt: new Date(`${date}T04:00:00Z`), finalizedAt: new Date(`${date}T04:00:00Z`),
          finalizedByMembershipId: ab, version: 3, lastWeek: null, lastWeekItems: [], tips: [], leadActions: [],
          actionItems: [{ itemId: `${id}-${date}`, text: 'Book two presentations', dueDate: date, carriedFromItemId: null }],
          snapshot: null, corrections: [], deletedAt: null,
        });
      }
      for (let n = 0; n < 4; n += 1) {
        leads.push({
          kpmId: KPM_A, ownerMembershipId: id, type: n % 2 ? 'recruitment' : 'sales', name: `L${n}`, statusCode: null,
          outcome: null, commitments: n < 2 ? [{ month: '2026-09', at: NOW, byMembershipId: id }] : [], version: 1, deletedAt: null,
        });
      }
    });
    await db.collection('goals').insertMany(goals);
    await db.collection('monthlyAgentData').insertMany(months);
    await db.collection('activityLogs').insertMany(logs);
    await db.collection('coachingSessions').insertMany(sessions);
    await db.collection('leads').insertMany(leads);
    await Promise.all(['Membership', 'Goal', 'MonthlyAgentData', 'ActivityLog', 'CoachingSession', 'User', 'Lead']
      .filter((name) => mongoose.modelNames().includes(name))
      .map((name) => mongoose.model(name).syncIndexes()));
  }, 240_000);

  afterAll(async () => {
    mongoose.set('debug', false);
    await stopMongo();
  });

  /** The read, with every query it sends counted. */
  const counted = async (ctx: RequestContext): Promise<{ view: UnitDashboardView; queries: string[] }> => {
    const queries: string[] = [];
    mongoose.set('debug', (collection: string, method: string) => { queries.push(`${collection}.${method}`); });
    try {
      return { view: await wired.unitDashboard.read(ctx), queries };
    } finally {
      mongoose.set('debug', false);
    }
  };

  /** Nearest-rank p95 of twenty reads, as `performance-and-scale.md` states the budget. */
  const p95 = async (ctx: RequestContext): Promise<number> => {
    await wired.unitDashboard.read(ctx);
    const times: number[] = [];
    for (let i = 0; i < 20; i += 1) {
      const started = process.hrtime.bigint();
      await wired.unitDashboard.read(ctx);
      times.push(Number(process.hrtime.bigint() - started) / 1e6);
    }
    times.sort((a, b) => a - b);
    return times[Math.ceil(0.95 * times.length) - 1];
  };

  it('P15-T1 AC-8 reads all five hundred, grouped: the reader alone in Your Unit, ten units of forty-nine', async () => {
    const { view } = await counted(ctxFor(ab, 'AB'));
    expect(view.yourUnit.rows).toHaveLength(1);
    expect(view.units).toHaveLength(UNITS);
    expect(view.units.map((u) => u.members.length)).toEqual(Array(UNITS).fill(PER_UNIT));
    // P19.12-T6: the AABs are the reader's *Grup langsung* outside Your Unit, and no AB is below them.
    expect(view.tiles.team).toEqual({
      total: 1 + UNITS * (PER_UNIT + 1), direct: 1, units: UNITS, underUnits: UNITS * PER_UNIT, newHires: 0,
      aab: UNITS * (PER_UNIT + 1), ab: 0,
    });
  });

  it('P15-T1 AC-8 sends the same queries for fifty people as for five hundred: none per person', async () => {
    const small = await counted(ctxFor(aabs[0], 'AAB'));
    const large = await counted(ctxFor(ab, 'AB'));

    expect(small.view.yourUnit.rows).toHaveLength(PER_UNIT + 1);
    expect(large.queries.sort()).toEqual(small.queries.sort());
    // eslint-disable-next-line no-console
    console.log(`  unit dashboard: ${large.queries.length} queries per read — ${large.queries.join(', ')}`);
    // 31 since P19.12-T6: the head's own groups, read once whatever the roster, for *Grup informal* (ADR-0249).
    expect(large.queries.length).toBeLessThanOrEqual(31);
    // The read entries are one insert, whatever the roster: never one per member shown.
    expect(large.queries.filter((q) => q.startsWith('auditLog.')).length).toBeLessThanOrEqual(1);
  });

  it('P15-T1 AC-8 answers a unit of fifty inside the 2 s budget, and records the ceiling’s cost', async () => {
    const unit = await p95(ctxFor(aabs[0], 'AAB'));
    const ceiling = await p95(ctxFor(ab, 'AB'));
    // eslint-disable-next-line no-console
    console.log(`  unit dashboard p95 of 20: ${PER_UNIT + 1} people ${unit.toFixed(1)} ms; ${1 + UNITS * (PER_UNIT + 1)} people ${ceiling.toFixed(1)} ms`);
    expect(unit).toBeLessThan(2000);
    // The ceiling is recorded for P18-T7, not budgeted here; this bound only catches a read gone per-person.
    expect(ceiling).toBeLessThan(5000);
  }, 120_000);
});
