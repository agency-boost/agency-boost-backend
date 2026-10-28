import mongoose from 'mongoose';
import { FixedClock } from '@/common/clock/clock.port';
import { RequestContext } from '@/common/context/request-context';
import { MonthlyAgentData } from '@/modules/production/monthly-agent-data.schema';
import { MonthlyAgentDataRepository } from '@/modules/production/monthly-agent-data.repository';
import { clearCollections, startMongo, stopMongo } from '../../../../test/mongo';
import { configModule, provisionOffice } from '../../../../test/config-module';
import { LeaderScorecardService } from './scorecard.service';
import type { ColumnKey, ComputedScorecard, RowKey, ScorecardCell } from './scorecard.types';

/** 10:00 on Saturday 10 October 2026 in Jakarta. */
const NOW = new Date('2026-10-10T03:00:00Z');
const JAKARTA = 'Asia/Jakarta';
const KPM_A = '66f00000000000000000a181';
const KPM_B = '66f00000000000000000b181';
const KPM_C = '66f00000000000000000c181';
const KPM_D = '66f00000000000000000d181';
const KPM_E = '66f00000000000000000e181';
const COMPANY = '66f00000000000000000c0c1';
const M = 1_000_000 * 100;

/** The months the office's file holds: last year whole, this year to July, then September — August and October not. */
const HELD = [
  ...Array.from({ length: 12 }, (_, i) => `2025-${String(i + 1).padStart(2, '0')}`),
  ...Array.from({ length: 7 }, (_, i) => `2026-${String(i + 1).padStart(2, '0')}`),
  '2026-09',
];

type Key =
  | 'OWNER' | 'AAB' | 'AG' | 'H25' | 'H25Q' | 'LEFT' | 'LEFT_QUIET' | 'LATE' | 'EARLY' | 'NEW_JUL' | 'NEW_SEP'
  | 'B_OWNER' | 'B_HIRE' | 'C_OWNER' | 'D_OWNER' | 'E_OWNER' | 'E_QUIET' | 'E_ACTIVE';

/** A month on the file: APE in Rp M, policies, and the file's new active agents (`null` not carried). */
interface Fig { ape: number; pol: number | null; nAA: number | null }

interface Plan {
  kpmId: string;
  role: 'ab' | 'aab' | 'agent';
  leader: Key | null;
  joined: string;
  removed?: string;
  /** Their month, where it is not 0 APE and 0 policies; `false` for somebody on no file. */
  fig?: ((month: string) => Partial<Fig> | null) | false;
  /** The months they are on the file, where not every month held from their join. */
  only?: string[];
  /** A start a leader corrected to (OD-118), for a row: before the join, here. */
  start?: string;
  /** How their activation is written: by the activation module as a placement starts it, or as a row. */
  activation?: 'joined' | 'row';
  /** P18.96-T6: a new hire (ADR-0169) — every one with an activation, and NEW_SEP — and their first sale's office day. */
  newHire?: true;
  sale?: string;
}

/**
 * **The office** — 0417's shape, small enough to count by hand:
 *
 * - the Owner (AB) at Rp 10 M and one policy every month held, the file's one new active agent with it; an AAB
 *   with nothing; an Agent at Rp 5 M and two policies;
 * - last year's hires: H25 (March, active in June, their fourth month), H25Q (April, active only in August, their
 *   fifth), LEFT (May, removed mid-June, active in June) and LEFT_QUIET (May, removed in June, never active);
 * - this year's: LATE joined at **23:59 on 31 January** and EARLY at **00:01 on 1 February**, Jakarta time, both
 *   active only in May; NEW_JUL (July, whose August is not held) active in September; NEW_SEP on 25 September, with
 *   no activation;
 * - office 0555 (B): a hire last year never active, and this year's files at Rp 999 M — never in A's figures; and an
 *   office with no file at all (C).
 */
const PLAN: Record<Key, Plan> = {
  OWNER: { kpmId: KPM_A, role: 'ab', leader: null, joined: '2024-01-02T02:00:00Z', fig: () => ({ ape: 10, pol: 1, nAA: 1 }) },
  AAB: { kpmId: KPM_A, role: 'aab', leader: 'OWNER', joined: '2024-01-02T02:00:00Z' },
  AG: { kpmId: KPM_A, role: 'agent', leader: 'AAB', joined: '2024-01-02T02:00:00Z', fig: () => ({ ape: 5, pol: 2 }) },
  H25: { kpmId: KPM_A, role: 'agent', leader: 'AAB', joined: '2025-03-10T03:00:00Z', fig: (m) => (m === '2025-06' ? { ape: 3, pol: 1 } : null), activation: 'row', sale: '2025-06-01' },
  H25Q: { kpmId: KPM_A, role: 'agent', leader: 'AAB', joined: '2025-04-07T03:00:00Z', fig: (m) => (m === '2025-08' ? { ape: 1, pol: 1 } : null), activation: 'row', sale: '2025-08-01' },
  LEFT: {
    kpmId: KPM_A, role: 'agent', leader: 'AAB', joined: '2025-05-05T03:00:00Z', removed: '2025-06-15T03:00:00Z',
    fig: (m) => (m === '2025-06' ? { ape: 2, pol: 1 } : null), activation: 'row', sale: '2025-06-01',
  },
  LEFT_QUIET: { kpmId: KPM_A, role: 'agent', leader: 'AAB', joined: '2025-05-06T03:00:00Z', removed: '2025-06-20T03:00:00Z', activation: 'row' },
  LATE: { kpmId: KPM_A, role: 'agent', leader: 'OWNER', joined: '2026-01-31T16:59:00Z', fig: (m) => (m === '2026-05' ? { ape: 4, pol: 1 } : null), activation: 'joined', sale: '2026-05-01' },
  EARLY: { kpmId: KPM_A, role: 'agent', leader: 'OWNER', joined: '2026-01-31T17:01:00Z', fig: (m) => (m === '2026-05' ? { ape: 4, pol: 1 } : null), activation: 'joined', sale: '2026-05-01' },
  NEW_JUL: { kpmId: KPM_A, role: 'agent', leader: 'OWNER', joined: '2026-07-20T03:00:00Z', fig: (m) => (m === '2026-09' ? { ape: 6, pol: 1 } : null), activation: 'joined', sale: '2026-09-01' },
  NEW_SEP: { kpmId: KPM_A, role: 'agent', leader: 'OWNER', joined: '2026-09-25T03:00:00Z', newHire: true },
  B_OWNER: { kpmId: KPM_B, role: 'ab', leader: null, joined: '2024-01-02T02:00:00Z', fig: (m) => (m.startsWith('2026') ? { ape: 999, pol: 9, nAA: 9 } : null) },
  B_HIRE: { kpmId: KPM_B, role: 'agent', leader: 'B_OWNER', joined: '2025-02-03T03:00:00Z', activation: 'row' },
  C_OWNER: { kpmId: KPM_C, role: 'ab', leader: null, joined: '2024-01-02T02:00:00Z', fig: false },
  // A file carrying APE and no policy count (ADR-0051): September held for APE, not for policies.
  D_OWNER: { kpmId: KPM_D, role: 'ab', leader: null, joined: '2024-01-02T02:00:00Z', fig: () => ({ ape: 8, pol: null }), only: ['2026-09'] },
  // Two hires who joined on 10 September last year, their starts corrected back into August (OD-118): one quiet, one
  // active in October.
  E_OWNER: { kpmId: KPM_E, role: 'ab', leader: null, joined: '2024-01-02T02:00:00Z', fig: () => ({ ape: 10, pol: 1 }) },
  E_QUIET: { kpmId: KPM_E, role: 'agent', leader: 'E_OWNER', joined: '2025-09-10T03:00:00Z', start: '2025-08-20', activation: 'row' },
  E_ACTIVE: {
    kpmId: KPM_E, role: 'agent', leader: 'E_OWNER', joined: '2025-09-10T03:00:00Z', start: '2025-08-25', activation: 'row',
    fig: (m) => (m === '2025-10' ? { ape: 3, pol: 1 } : null), sale: '2025-10-01',
  },
};

describe('the forum’s scorecard, computed (P18.1-T1, P18.1-T2 AC-4; OD-144, ADR-0129)', () => {
  let wired: ReturnType<typeof configModule>;
  let scorecard: LeaderScorecardService;
  const id = {} as Record<Key, string>;
  const db = () => mongoose.connection.db!;
  const clock = () => wired.clock as FixedClock;
  const compute = (meetingDate: string, kpmId = KPM_A) => scorecard.compute({ kpmId, timezone: JAKARTA, meetingDate });

  beforeAll(async () => {
    await startMongo();
    wired = configModule(NOW);
    await clearCollections();
    await (wired.kpms as { create: (d: unknown) => Promise<unknown> }).create([KPM_A, KPM_B, KPM_C, KPM_D, KPM_E].map((kpmId, i) => ({
      _id: kpmId, companyId: COMPANY, code: ['0417', '0555', '0701', '0702', '0703'][i], branchName: 'Branch', timezone: JAKARTA,
    })));
    await wired.orgLevels.seedDefaultLadder(COMPANY);
    for (const kpmId of [KPM_A, KPM_B]) await provisionOffice(wired, kpmId, COMPANY);

    let seq = 0;
    for (const [key, p] of Object.entries(PLAN) as [Key, Plan][]) {
      seq += 1;
      const userId = new mongoose.Types.ObjectId();
      await db().collection('users').insertOne({
        _id: userId, email: `${key.toLowerCase()}@score.test`, passwordHash: 'x', fullName: key, status: 'active', deletedAt: null,
      });
      const leader = p.leader === null ? null : id[p.leader];
      const above = leader === null ? [] : [
        ...((await db().collection('memberships').findOne({ _id: new mongoose.Types.ObjectId(leader) }))!.ancestorIds as string[]), leader,
      ];
      const membershipId = new mongoose.Types.ObjectId();
      await db().collection('memberships').insertOne({
        _id: membershipId, kpmId: p.kpmId, userId: String(userId), agentCode: `S${seq}`, agentSeq: seq, leaderCode: `SC${seq}`,
        orgLevelId: 'x', orgLevelCode: p.role.toUpperCase(), role: p.role, leaderId: leader, ancestorIds: above, depth: above.length,
        directCounts: { total: 0 }, subtreeCount: 0, status: p.removed ? 'removed' : 'active',
        joinedAt: new Date(p.joined), removedAt: p.removed ? new Date(p.removed) : null, deletedAt: null,
        // As a placement writes them since P18.96-T2 (ADR-0169): joined that day in the office's calendar, and a new
        // hire when the activation module is to start their activation — it starts a new hire's alone.
        joinDate: clock().localDateFor(JAKARTA, new Date(p.joined)),
        // P18.96-T6: every hire with an activation is a new hire, as migration 0040 makes them, with the first sale the
        // file gives them (`FIRST_SALE_DATE`) — written as it stood, so no write after day 90 is needed to find it.
        joinedAs: p.activation || p.newHire ? 'new_hire' : 'existing_agent',
        firstSaleDate: p.sale ?? null, firstSaleSource: p.sale ? 'monthly_file' : null,
      });
      id[key] = String(membershipId);
    }

    // The file: a row a month held, from the month each joined to the month each left.
    const cell = (value: number | null) => ({ value, provenance: value === null ? null : 'imported', sourceBatchId: null });
    const rows: Record<string, unknown>[] = [];
    for (const [key, p] of Object.entries(PLAN) as [Key, Plan][]) {
      if (p.fig === false) continue;
      const from = clock().localDateFor(JAKARTA, new Date(p.joined)).slice(0, 7);
      const to = p.removed ? clock().localDateFor(JAKARTA, new Date(p.removed)).slice(0, 7) : '9999-12';
      const ytd = new Map<string, number>();
      for (const month of HELD.filter((m) => m >= from && m <= to && (p.only?.includes(m) ?? true))) {
        const fig: Fig = { ape: 0, pol: 0, nAA: month === '2026-09' ? null : 0, ...(p.fig?.(month) ?? {}) };
        const year = month.slice(0, 4);
        ytd.set(year, (ytd.get(year) ?? 0) + fig.ape);
        rows.push({
          kpmId: p.kpmId, membershipId: id[key], month, agentCode: key, deletedAt: null,
          apeMonthly: cell(fig.ape * M), apeYtd: cell(ytd.get(year)! * M), policyCountMonthly: cell(fig.pol),
          newActiveAgentsMonthly: cell(month === '2026-09' ? null : fig.nAA),
        });
      }
    }
    await db().collection('monthlyAgentData').insertMany(rows);

    // The activations: this year's started by the activation module as a placement starts them, from the join instant.
    for (const [key, p] of Object.entries(PLAN) as [Key, Plan][]) {
      if (p.activation === 'joined') {
        await wired.activationProgress.joined(RequestContext.forJob(p.kpmId, 'scorecard-spec'), id[key]);
      } else if (p.activation === 'row') {
        await db().collection('activationProgress').insertOne({
          kpmId: p.kpmId, membershipId: id[key], templateId: 'x', templateVersion: 1,
          startDate: p.start ?? clock().localDateFor(JAKARTA, new Date(p.joined)),
          startCorrectedAt: p.start ? NOW : null, startCorrectedByMembershipId: p.start ? id[p.leader!] : null,
          origin: 'backfill', items: [], note: null, graduatedAt: null, graduatedByMembershipId: null, version: 1, deletedAt: null,
        });
      }
    }

    scorecard = new LeaderScorecardService(
      wired.officePeople, wired.productionReadings,
      new MonthlyAgentDataRepository(mongoose.model(MonthlyAgentData.name) as never), wired.memberships, wired.clock,
    );
  }, 120_000);

  afterEach(() => clock().set(NOW));
  afterAll(stopMongo);

  const row = (card: ComputedScorecard, key: RowKey) => card.rows.find((r) => r.key === key)!;
  const cell = (card: ComputedScorecard, key: RowKey, column: ColumnKey): ScorecardCell => row(card, key).cells[column];
  const fig = (value: number, leavesOut: string[] = []): ScorecardCell => ({ kind: 'figure', value, leavesOut });
  const PENDING = { kind: 'pending' };
  const BLOCKED = { kind: 'blocked' };

  it('P18.1-T1 AC-2 the activation module starts LATE’s and EARLY’s activations on either side of midnight, Jakarta time', async () => {
    const starts = await db().collection('activationProgress')
      .find({ membershipId: { $in: [id.LATE, id.EARLY] } }).sort({ startDate: 1 }).toArray();
    expect(starts.map((a) => [a.membershipId, a.startDate])).toEqual([[id.LATE, '2026-01-31'], [id.EARLY, '2026-02-01']]);
  });

  describe('a meeting in three days: live, its periods ending today', () => {
    let card: ComputedScorecard;
    beforeAll(async () => { card = await compute('2026-10-13'); });

    it('P18.1-T2 AC-4 names the five periods from the meeting’s date, FY and YTD its years', () => {
      expect(card.periods).toEqual({ fy: '2025', ytd: '2026', thisMonthLastYear: '2025-10', lastMonth: '2026-09', thisMonth: '2026-10' });
    });

    it('P18.1-T2 AC-4 serves the nine rows in the prototype’s order, each with its unit', () => {
      expect(card.rows.map((r) => [r.key, r.unit])).toEqual([
        ['ape', 'idr_minor'], ['manpower', 'count'], ['flc', 'count'], ['producing_agents', 'count'], ['new_aa', 'count'],
        ['new_agent_3m', 'percentage'], ['avg_monthly_aa', 'count'], ['case_submission', 'count'], ['average_case_size', 'idr_minor'],
      ]);
    });

    it('P18.1-T2 AC-4 the chips: the headcount today and its members by rung code, a unit per AB', () => {
      expect(card.chips).toEqual({ manpower: 9, agents: 7, units: 1, ab: 1, aab: 1 });
      expect(cell(card, 'manpower', 'thisMonth')).toEqual(fig(card.chips.manpower));
    });

    it('P18.1-T2 AC-4 Manpower: OFFICE_HEADCOUNT on each period’s last day — the leavers out from the day they left', () => {
      expect(row(card, 'manpower').cells).toEqual({
        fy: fig(5), ytd: fig(9), thisMonthLastYear: fig(5), lastMonth: fig(9), thisMonth: fig(9),
      });
    });

    it('P18.1-T2 AC-4 APE: the year to date through the period, a leaver’s kept; a month the office’s file summed', () => {
      expect(row(card, 'ape').cells).toEqual({
        fy: fig(186 * M),
        // The carrier's year to date holds August; October, after the latest month held, is the office's current
        // month — its file not due yet — so nothing is named.
        ytd: fig(134 * M),
        thisMonthLastYear: fig(15 * M),
        lastMonth: fig(21 * M),
        thisMonth: PENDING,
      });
    });

    it('P18.1-T2 AC-4 FLC is pending data in every column (OD-26)', () => {
      expect(Object.values(row(card, 'flc').cells)).toEqual(Array(5).fill(PENDING));
    });

    it('P18.1-T2 AC-4 the three rows the prototype blocks are blocked in the three single months', () => {
      for (const key of ['producing_agents', 'new_agent_3m', 'average_case_size'] as const) {
        expect([key, cell(card, key, 'thisMonthLastYear'), cell(card, key, 'lastMonth'), cell(card, key, 'thisMonth')])
          .toEqual([key, BLOCKED, BLOCKED, BLOCKED]);
      }
    });

    it('P18.1-T1 AC-4 Producing agents: active in a held month they belonged in — LEFT in the June they left in', () => {
      expect(cell(card, 'producing_agents', 'fy')).toEqual(fig(5));
      expect(cell(card, 'producing_agents', 'ytd')).toEqual(fig(5, ['2026-08']));
    });

    it('P18.1-T1 AC-3 New AA (avg. monthly): the file’s count over the months that carry it, ÷ those months', () => {
      expect(row(card, 'new_aa').cells).toEqual({
        fy: fig(1),
        // September's file carries no new active agents: it is left out with August, which is not held.
        ytd: fig(1, ['2026-08', '2026-09']),
        thisMonthLastYear: fig(1),
        lastMonth: PENDING,
        thisMonth: PENDING,
      });
    });

    it('P18.1-T1 AC-4 Avg. Monthly AA: each month’s MAA_COUNT_IN_UNIT over its members on its last day, averaged', () => {
      expect(row(card, 'avg_monthly_aa').cells).toEqual({
        // June counts H25 and not LEFT, removed on the 15th; August H25Q.
        fy: fig(26 / 12),
        // May counts LATE and EARLY; September NEW_JUL.
        ytd: fig(19 / 8, ['2026-08']),
        thisMonthLastYear: fig(2),
        lastMonth: fig(3),
        thisMonth: PENDING,
      });
    });

    it('P18.1-T1 AC-4 Case submission: the file’s policies over the months held, a leaver’s kept', () => {
      expect(row(card, 'case_submission').cells).toEqual({
        fy: fig(39), ytd: fig(27, ['2026-08']), thisMonthLastYear: fig(3), lastMonth: fig(4), thisMonth: PENDING,
      });
    });

    it('P18.1-T1 AC-4 Average Case Size: APE ÷ policies over the same months, in whole minor units', () => {
      expect(cell(card, 'average_case_size', 'fy')).toEqual(fig(Math.round((186 * M) / 39)));
      expect(cell(card, 'average_case_size', 'ytd')).toEqual(fig(Math.round((134 * M) / 27), ['2026-08']));
    });

    /*
     * P18.96-T6 (ADR-0171 §2): *3M new agent %* is `ACTIVATION_3M_PCT` — the year's new hires by their join date, a first
     * sale by day 90 activated — not the retired four months of the file. It names no month: nothing waits on one.
     */
    it('P18.96-T6 AC-2 3M new agent %: last year 2 of 4 — H25 and LEFT sold by day 90, H25Q on day 117, LEFT_QUIET never', () => {
      // LEFT was removed in June, after selling: a removal is not leaving, and the 90 days decided it.
      expect(cell(card, 'new_agent_3m', 'fy')).toEqual(fig(50));
    });

    it('P18.96-T6 AC-2 3M new agent %: this year 1 of 2 — EARLY’s first sale is day 90, LATE’s the same day is day 91; NEW_JUL in progress', () => {
      // LATE joined at 23:59 on 31 January and EARLY at 00:01 on 1 February, Jakarta: 1 May is day 91 and day 90.
      expect(cell(card, 'new_agent_3m', 'ytd')).toEqual(fig(50));
    });
  });

  it('P18.1-T2 AC-4 a meeting already past: its periods end on its date — a member who joined after it is not counted', async () => {
    const card = await compute('2026-09-20');
    expect(card.periods).toMatchObject({ lastMonth: '2026-08', thisMonth: '2026-09' });
    expect(card.chips.manpower).toBe(8);
    expect(cell(card, 'manpower', 'thisMonth')).toEqual(fig(8));
    // August is not held: pending, never 0.
    expect(cell(card, 'ape', 'lastMonth')).toEqual(PENDING);
    expect(cell(card, 'ape', 'thisMonth')).toEqual(fig(21 * M));
    // Through September, the latest month held: nothing after it to leave out.
    expect(cell(card, 'ape', 'ytd')).toEqual(fig(134 * M));
    expect(cell(card, 'case_submission', 'ytd')).toEqual(fig(27, ['2026-08']));
  });

  it('P18.1-T2 AC-4 a meeting in another year: FY and YTD name its years; a period that has not begun is pending', async () => {
    const card = await compute('2027-01-05');
    expect(card.periods).toEqual({ fy: '2026', ytd: '2027', thisMonthLastYear: '2026-01', lastMonth: '2026-12', thisMonth: '2027-01' });
    // FY 2026 runs to today: the year to date as it stands.
    expect(cell(card, 'ape', 'fy')).toEqual(fig(134 * M));
    // P18.96-T6: 2026's new hires as they stand today — EARLY activated, LATE not, two in progress.
    expect(cell(card, 'new_agent_3m', 'fy')).toEqual(fig(50));
    expect(cell(card, 'ape', 'thisMonthLastYear')).toEqual(fig(15 * M));
    for (const key of ['ape', 'new_aa', 'avg_monthly_aa', 'case_submission'] as const) {
      expect([key, cell(card, key, 'ytd'), cell(card, key, 'lastMonth'), cell(card, key, 'thisMonth')]).toEqual([key, PENDING, PENDING, PENDING]);
    }
    for (const key of ['producing_agents', 'new_agent_3m', 'average_case_size'] as const) {
      expect([key, cell(card, key, 'ytd')]).toEqual([key, PENDING]);
    }
    // A point-in-time figure is taken on the period's end, today: the headcount now.
    expect(cell(card, 'manpower', 'ytd')).toEqual(fig(9));
    expect(card.chips.manpower).toBe(9);
  });

  it('P18.1-T2 AC-4 a meeting at the year’s start, read after it: YTD is its two days, Last Month last December', async () => {
    clock().set(new Date('2026-01-05T03:00:00Z'));
    const card = await compute('2026-01-02');
    expect(card.periods).toEqual({ fy: '2025', ytd: '2026', thisMonthLastYear: '2025-01', lastMonth: '2025-12', thisMonth: '2026-01' });
    expect(cell(card, 'ape', 'fy')).toEqual(fig(186 * M));
    expect(cell(card, 'ape', 'ytd')).toEqual(fig(15 * M));
    expect(cell(card, 'ape', 'lastMonth')).toEqual(fig(15 * M));
    expect(cell(card, 'manpower', 'ytd')).toEqual(fig(5));
    expect(cell(card, 'avg_monthly_aa', 'thisMonth')).toEqual(fig(2));
    // Nobody started on 1 or 2 January: the cohort is empty, pending.
    expect(cell(card, 'new_agent_3m', 'ytd')).toEqual(PENDING);
    // P18.96-T6: 2025's four as they stood on 5 January, every one past day 90.
    expect(cell(card, 'new_agent_3m', 'fy')).toEqual(fig(50));
  });

  it('P18.96-T6 AC-2 another office’s new hire never in this office’s figure; theirs not activated, a decided 0%', async () => {
    const card = await compute('2026-10-13', KPM_B);
    expect(cell(card, 'new_agent_3m', 'fy')).toEqual(fig(0));
    // Held months with no policy at all: a ratio over nothing — none, never a division by zero.
    expect(cell(card, 'average_case_size', 'fy')).toEqual({ kind: 'none' });
    expect(cell(card, 'case_submission', 'fy')).toEqual(fig(0));
    expect(card.chips).toEqual({ manpower: 2, agents: 1, units: 1, ab: 1, aab: 0 });
  });

  it('P18.1-T2 AC-4 an office with no file: every figure from it pending, never 0; the headcount still counted', async () => {
    const card = await compute('2026-10-13', KPM_C);
    for (const r of card.rows.filter((x) => x.key !== 'manpower')) {
      for (const [column, value] of Object.entries(r.cells)) {
        expect([r.key, column, value.kind]).toEqual([r.key, column, value.kind === 'blocked' ? 'blocked' : 'pending']);
      }
    }
    expect(row(card, 'manpower').cells.ytd).toEqual(fig(1));
  });

  it('P18.1-T2 AC-4 a file with APE and no policy count: APE a figure; Case submission and Average Case Size pending, never 0', async () => {
    const card = await compute('2026-10-13', KPM_D);
    expect(cell(card, 'ape', 'lastMonth')).toEqual(fig(8 * M));
    expect(cell(card, 'ape', 'ytd')).toEqual(fig(8 * M));
    expect(cell(card, 'case_submission', 'lastMonth')).toEqual(PENDING);
    expect(cell(card, 'case_submission', 'ytd')).toEqual(PENDING);
    expect(cell(card, 'average_case_size', 'ytd')).toEqual(PENDING);
    // Producing: active in September, the one month held; the rest of the year named as left out.
    expect(cell(card, 'producing_agents', 'ytd')).toEqual(fig(1, ['2026-01', '2026-02', '2026-03', '2026-04', '2026-05', '2026-06', '2026-07', '2026-08']));
  });

  it('P18.96-T6 AC-2 read by the join date, a start corrected back before it (OD-118) changes nothing: one sold by day 90, one never', async () => {
    const card = await compute('2026-10-13', KPM_E);
    expect(cell(card, 'new_agent_3m', 'fy')).toEqual(fig(50));
  });

  it('P18.1-T2 AC-4 a meeting computed after its month ended — the freeze’s read — names that month when its file is absent', async () => {
    clock().set(new Date('2026-11-02T03:00:00Z'));
    const card = await compute('2026-10-13');
    // October is past now, and not held: every year-to-date figure says so; the November it is read in is not named.
    expect(cell(card, 'ape', 'ytd')).toEqual(fig(134 * M, ['2026-10']));
    expect(cell(card, 'case_submission', 'ytd')).toEqual(fig(27, ['2026-08', '2026-10']));
    // P18.96-T6: read on 2 November — NEW_JUL's day 90 (17 October) has passed, her September sale inside it: 2 of 3.
    expect(cell(card, 'new_agent_3m', 'ytd')).toEqual(fig(67));
    expect(cell(card, 'case_submission', 'thisMonth')).toEqual(PENDING);
  });

  it('P18.1-T2 AC-4 writes nothing and records no §3.5 entry: a read of the office’s records', async () => {
    const counts = async () => Promise.all(['auditLog', 'activationProgress', 'monthlyAgentData', 'memberships']
      .map((name) => db().collection(name).countDocuments()));
    const before = await counts();
    await compute('2026-10-13');
    expect(await counts()).toEqual(before);
    // P18.96-T6: and keeps no 3M result — the scorecard reads them, `/new-hires` and the writes keep them.
    expect(await db().collection('memberships').countDocuments({ activation3M: { $ne: null } })).toBe(0);
  });

  it('P18.96-T6 AC-2 a kept result is read as kept: a new hire whose lock says not activated is not, whatever their first sale says', async () => {
    await db().collection('memberships').updateOne({ _id: new mongoose.Types.ObjectId(id.EARLY) }, { $set: { activation3M: 'not_activated' } });
    try {
      expect(cell(await compute('2026-10-13'), 'new_agent_3m', 'ytd')).toEqual(fig(0));
    } finally {
      await db().collection('memberships').updateOne({ _id: new mongoose.Types.ObjectId(id.EARLY) }, { $set: { activation3M: null } });
    }
  });
});
