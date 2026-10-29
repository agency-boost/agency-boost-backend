import { createHash } from 'node:crypto';
import mongoose from 'mongoose';
import type { Clock } from '@/common/clock/clock.port';
import { addDays } from '@/common/time/local-day';
import { CASCADE_ACTIVITY_CODES, DEFAULT_TENANT_TIMEZONE } from '@/domain/constants';
import { computeCascade, defaultMonthsLeft } from '@/modules/goals/goal-cascade';
import { PRODUCTION_METRICS } from '@/modules/production/monthly-agent-data.schema';
import { MINOR_UNITS_PER_RP_MILLION } from '@/modules/production/production-units';
import { templateFilename } from '@/modules/production/production-template';
import { up as mocPersistency } from '@/migrations/0026-moc-persistency';
import { seedObjectId } from './coaching-fixture';
import { backfillCoachingSnapshots } from './coaching-snapshots';
import { monthField, seedMonthFigures } from './production-figures';

/**
 * **The Owner's reporting, seeded** (Phase 18, *Seed*; P18-T1 AC-13, P18-T2 AC-11, P18-T8 AC-5;
 * `functional/kpm-analytics.md`, *Seed*).
 *
 * Much of what the Overview and the analytics read is seeded already — the coaching cast's weeks of activity and
 * finalized sessions, leads with late stages and promises, goals, this month's and last month's files with the
 * month before last left empty (`demo.ts`, `coaching-fixture.ts`). This adds what the reporting is the first to
 * show. Which account shows what:
 *
 * | Signed in as | Sees |
 * |---|---|
 * | `owner@kpm0417.test`, `admin@kpm0417.test` (Maya Halim) at `/kpm/overview` | **Five AB agencies** — the Owner's, the Admin's, Agus's, and two new ones under the Owner: **Yosef Tambunan**'s, large and producing (five agents of his own and **Winda Anggraeni**'s AAB unit of three), and **Satria Nugraha**'s, small (three agents), **furthest behind its target**. *Units furthest behind target* reads *"Showing 4 of 5 ABs · view full ranking →"*; the leaderboard ranks the four ABs who lead somebody — Satria at 0%, **coached by nobody this week**. *View who hasn't logged* lists three and counts the rest: **Agus Prasetyo** and **Raka Aditama**, who have **never logged**, then the longest silent — the Owner and **Maya Halim** logged 11 to 19 days ago and not since, so they read *"Last logged {n} days ago"*. **Gilang Saputra**, Yosef's agent until last month, is on the *Removed* tab, and on every file this year to three months ago — so the year to date holds what Gilang made and the analytics' total says how much it leaves out (OD-74). **Recruitment**: this month's **target 15**, set by the Owner, so the pill reads one of its three sentences; the office's late-stage candidates (*Expected to close*) and **two closed won last month** (*Last month*). **Production**: a year of files — January last year to three months ago, then last month and this month, **the month before last empty** — so the projection runs on the months to this one, the gap included, and nothing is listed as waited on: this month's file is in |
 * | the same, at `/kpm/analytics` | **Yosef's agency at *Star Club*** on its year to date, **meeting MOC on the three-criteria path**; **Winda's unit *—*** — her persistency is not on this month's file (*"Not uploaded yet: Rolling Persistency — DU."*); the MOC column's tooltip is the company's rules; **Satria's agency failing MOC** with its gaps. *Monthly production*: five bars and one labelled gap. *Previous month* moves the month's APE, the active count and the leads |
 * | `superadmin@agencyboost.test` at `/admin/analytics` | Sign-ins across offices: most of 0417 within the week, some within the month, some never; none of 0601's within thirty days |
 * | `owner@kpm0555.test` | 0555's own figures — two months' files, a 1:1, a fortnight's logging, its Owner and Lina joined two months ago — and nothing of 0417's |
 * | `owner@kpm0701.test` (Hadi Gunawan) | The *Empty* office: every section's empty state, every rate over nobody *—* |
 *
 * **Every new member joined more than six months ago** — so no New hires roster changes (ADR-0104) — and none is
 * in Agus's, Sari's or Arief's downline, so their walks do not change. **Yosef is tagged *Core Leader***, beside
 * Agus and Sari. The two new ABs and Winda are leaders, so **the subscription walk's *Leaders* reads 9 / 10** where
 * it read 6 / 10, and the Owner's field view gains the two agencies. *Since P18.97-T1 (AC-20):* **Yosef and Winda joined
 * before January of last year** (`BEFORE_LAST_YEAR`), so the office's file holds every month of last year and the forum's
 * *Full Year* and *YTD* of last year read whole years.
 *
 * **Derived ids, written once until `--reset`**: every row this writes carries an `_id` from `seedObjectId`, or
 * is keyed by what makes it unique — a month's file is written only into a month the office holds nothing for, an
 * activity day only where none is, a sign-in only on an account that has none — so a re-run writes nothing and a
 * walk's own writes are left as they are.
 */

type Role = 'ab' | 'aab' | 'agent';
interface Placed { id: string; ancestorIds: string[]; depth: number }

export interface ReportingCastMember {
  key: ReportingKey;
  email: string;
  fullName: string;
  role: Role;
  leader: 'owner' | ReportingKey;
  /** The insurer's code, so placing these accounts moves no other account's number (`user()`'s counter). */
  agentCode: string;
  joinedDaysAgo: number;
  /** Rp M a month on every file; `null` is somebody with no production at all. */
  apeMillions: number | null;
  persistency: number;
  annualTargetMillions: number;
  /** Days back, today 0, on which they logged an activity. Empty is somebody who never has. */
  loggedDaysBack: readonly number[];
  /**
   * Removed from the office last month (OD-74): in no count of people now, their production this year still the
   * office's — so the Overview's year to date holds it and the analytics' total says how much it leaves out.
   */
  removedLastMonth?: true;
}

export type ReportingKey =
  | 'yosef' | 'arini' | 'bonar' | 'cahya' | 'damar' | 'elsa' | 'winda' | 'ikhsan' | 'jihan' | 'kemal'
  | 'satria' | 'oscar' | 'pandu' | 'raka' | 'gilang';

const RECENT = [0, 2, 4, 6, 8, 10, 12];

/**
 * **The longest-serving leaders' join, before January of last year whatever day the seed runs** (P18.97-T1 AC-20): 800
 * days is more than two years back from any day of the run's year, so **0417's file holds every month of last year** —
 * Yosef and Winda on each — and the forum's *Full Year {Y−1}* and *YTD {Y−1}* read whole years, with no *(\*)* note
 * (ADR-0175 §9). Neither is a new hire, so no cohort, *New hires* roster or 3M figure moves; this year's files list
 * them already.
 */
const BEFORE_LAST_YEAR = { yosef: 800, winda: 780 } as const;

/** The two new agencies, leaders first. Nobody here is in Agus's, Sari's or Arief's downline. */
export const REPORTING_CAST: readonly ReportingCastMember[] = [
  { key: 'yosef', email: 'yosef@kpm0417.test', fullName: 'Yosef Tambunan', role: 'ab', leader: 'owner', agentCode: '87001', joinedDaysAgo: BEFORE_LAST_YEAR.yosef, apeMillions: 18, persistency: 88, annualTargetMillions: 180, loggedDaysBack: RECENT },
  { key: 'arini', email: 'arini@kpm0417.test', fullName: 'Arini Kusuma', role: 'agent', leader: 'yosef', agentCode: '87002', joinedDaysAgo: 390, apeMillions: 16, persistency: 82, annualTargetMillions: 180, loggedDaysBack: RECENT },
  { key: 'bonar', email: 'bonar@kpm0417.test', fullName: 'Bonar Hutapea', role: 'agent', leader: 'yosef', agentCode: '87003', joinedDaysAgo: 380, apeMillions: 16, persistency: 82, annualTargetMillions: 180, loggedDaysBack: RECENT },
  { key: 'cahya', email: 'cahya@kpm0417.test', fullName: 'Cahya Ningrum', role: 'agent', leader: 'yosef', agentCode: '87004', joinedDaysAgo: 360, apeMillions: 16, persistency: 82, annualTargetMillions: 180, loggedDaysBack: RECENT },
  { key: 'damar', email: 'damar@kpm0417.test', fullName: 'Damar Pangestu', role: 'agent', leader: 'yosef', agentCode: '87005', joinedDaysAgo: 340, apeMillions: 16, persistency: 82, annualTargetMillions: 180, loggedDaysBack: RECENT },
  { key: 'elsa', email: 'elsa@kpm0417.test', fullName: 'Elsa Marbun', role: 'agent', leader: 'yosef', agentCode: '87006', joinedDaysAgo: 320, apeMillions: 16, persistency: 82, annualTargetMillions: 180, loggedDaysBack: RECENT },
  { key: 'winda', email: 'winda@kpm0417.test', fullName: 'Winda Anggraeni', role: 'aab', leader: 'yosef', agentCode: '87007', joinedDaysAgo: BEFORE_LAST_YEAR.winda, apeMillions: 17, persistency: 85, annualTargetMillions: 180, loggedDaysBack: RECENT },
  { key: 'ikhsan', email: 'ikhsan@kpm0417.test', fullName: 'Ikhsan Prabowo', role: 'agent', leader: 'winda', agentCode: '87008', joinedDaysAgo: 300, apeMillions: 15, persistency: 80, annualTargetMillions: 180, loggedDaysBack: RECENT },
  { key: 'jihan', email: 'jihan@kpm0417.test', fullName: 'Jihan Mardiyah', role: 'agent', leader: 'winda', agentCode: '87009', joinedDaysAgo: 290, apeMillions: 15, persistency: 80, annualTargetMillions: 180, loggedDaysBack: RECENT },
  // A quiet agent: no APE, no policy, every month — *not active*.
  { key: 'kemal', email: 'kemal@kpm0417.test', fullName: 'Kemal Rasyid', role: 'agent', leader: 'winda', agentCode: '87010', joinedDaysAgo: 280, apeMillions: 0, persistency: 80, annualTargetMillions: 180, loggedDaysBack: [8, 11, 15, 20] },
  { key: 'satria', email: 'satria@kpm0417.test', fullName: 'Satria Nugraha', role: 'ab', leader: 'owner', agentCode: '87011', joinedDaysAgo: 330, apeMillions: 6, persistency: 70, annualTargetMillions: 300, loggedDaysBack: [1, 3] },
  { key: 'oscar', email: 'oscar@kpm0417.test', fullName: 'Oscar Lumbantobing', role: 'agent', leader: 'satria', agentCode: '87012', joinedDaysAgo: 310, apeMillions: 4, persistency: 72, annualTargetMillions: 300, loggedDaysBack: [9, 15] },
  { key: 'pandu', email: 'pandu@kpm0417.test', fullName: 'Pandu Wirawan', role: 'agent', leader: 'satria', agentCode: '87013', joinedDaysAgo: 250, apeMillions: 5, persistency: 72, annualTargetMillions: 300, loggedDaysBack: [12] },
  // Joined long ago and has never logged: *Never logged* on the Overview, *Never* in the directory.
  { key: 'raka', email: 'raka@kpm0417.test', fullName: 'Raka Aditama', role: 'agent', leader: 'satria', agentCode: '87014', joinedDaysAgo: 220, apeMillions: null, persistency: 0, annualTargetMillions: 300, loggedDaysBack: [] },
  // Yosef's agent until last month: on every file this year to three months ago, removed since (OD-74). Placed
  // last, so every member above keeps the agent sequence a fresh seed has always given them.
  { key: 'gilang', email: 'gilang@kpm0417.test', fullName: 'Gilang Saputra', role: 'agent', leader: 'yosef', agentCode: '87015', joinedDaysAgo: 400, apeMillions: 14, persistency: 81, annualTargetMillions: 180, loggedDaysBack: [], removedLastMonth: true },
];

/** This month's recruitment target, set by the Owner (D-recruit). */
export const REPORTING_RECRUIT_TARGET = 15;

const byKey = new Map(REPORTING_CAST.map((p) => [p.key, p]));

export interface ReportingCastDeps {
  clock: Clock;
  kpmId: string;
  office0417: { _id: unknown; code: string; companyId: string };
  owner: Placed;
  user: (email: string, fullName: string, opts: { agentCode: string }) => Promise<{ _id: unknown }>;
  place: (
    kpm: { _id: unknown; code: string; companyId: string }, userId: string, role: Role, leader: Placed | null,
    opts: { joinedDaysAgo: number; status?: 'removed'; removedDaysAgo?: number },
  ) => Promise<Placed>;
  recount: (kpmId: string, membershipId: string) => Promise<void>;
}

/**
 * **The two agencies, placed** — called right after the coaching cast, before the month files, so this month's and
 * last month's files list them as they list everybody (`reportingMonthFigures`). Placed after everybody above, so
 * every earlier member keeps the agent sequence a fresh seed has always given them, with codes of their own.
 */
export async function placeReportingCast(deps: ReportingCastDeps): Promise<Record<ReportingKey, Placed>> {
  const placed = {} as Record<ReportingKey, Placed>;
  // Ten days before last month ended, whatever day the seed runs: the 20th of September on 9 October.
  const removedDaysAgo = Number(deps.clock.localDateFor(DEFAULT_TENANT_TIMEZONE).slice(8, 10)) + 10;
  for (const person of REPORTING_CAST) {
    const account = await deps.user(person.email, person.fullName, { agentCode: person.agentCode });
    const leader = person.leader === 'owner' ? deps.owner : placed[person.leader];
    // `place()` never adopts a removed row (P3-T7 AC-4), so a leaver already written is found here: a re-run
    // writes no second membership for them.
    const left = person.removedLastMonth
      ? await mongoose.connection.collection('memberships').findOne({ kpmId: deps.kpmId, userId: String(account._id), status: 'removed' })
      : null;
    if (left) {
      placed[person.key] = { id: String(left._id), ancestorIds: left.ancestorIds as string[], depth: left.depth as number };
      continue;
    }
    placed[person.key] = await deps.place(deps.office0417, String(account._id), person.role, leader, {
      joinedDaysAgo: person.joinedDaysAgo,
      ...(person.removedLastMonth ? { status: 'removed' as const, removedDaysAgo } : {}),
    });
  }
  for (const id of [deps.owner.id, placed.yosef.id, placed.winda.id, placed.satria.id]) await deps.recount(deps.kpmId, id);
  // Core Leader gates Leader Forum co-editing (Phase 18.1) and nothing else.
  await mongoose.connection.collection('memberships').updateOne(
    { _id: new mongoose.Types.ObjectId(placed.yosef.id) }, { $set: { isCoreLeader: true } },
  );
  return placed;
}

/**
 * **A reporting cast member's month on a file**: the same figures every month, the year to date the month's times
 * its number, as `seedMonthFigures` reads everybody else's. `null` is somebody the file leaves out — Raka, who has
 * produced nothing. **Winda's persistency is not on this month's file** (both cells left empty): her MOC reads
 * *—*, *"Not uploaded yet: Rolling Persistency — DU."* — the one thing a held month can leave undecided (the
 * Phase 18 exit review, item 2: a member a held month says nothing of is *not active*, never *perhaps*).
 */
export function reportingMonthFigures(key: ReportingKey, month: string, thisMonth: string): Record<string, number> | null {
  const person = byKey.get(key)!;
  if (person.apeMillions === null) return null;
  const m = Number(month.slice(5));
  const ape = Math.round(person.apeMillions * MINOR_UNITS_PER_RP_MILLION);
  const monthly: Record<string, number> = {
    ape, persistency: person.persistency, recruitment: 0, newActiveAgents: 0,
    fyp: Math.round(ape * 0.6), policyCount: ape > 0 ? 1 : 0,
  };
  const unreported = key === 'winda' && month === thisMonth ? new Set(['persistency']) : new Set<string>();
  return Object.fromEntries(PRODUCTION_METRICS.filter((metric) => !unreported.has(metric)).flatMap((metric) => [
    [monthField(metric, 'monthly'), monthly[metric]],
    [monthField(metric, 'ytd'), metric === 'persistency' ? monthly[metric] - 2 : monthly[metric] * m],
  ]));
}

export interface ReportingFixtureDeps {
  clock: Clock;
  kpmId: string;
  owner: { membershipId: string; userId: string };
  /** Maya Halim, the Admin: logged some weeks back, as the Owner has. */
  admin: { membershipId: string };
  cast: Record<ReportingKey, Placed>;
  /** The coaching cast's memberships: they joined three months ago and are on no history file. */
  coachingCastIds: ReadonlySet<string>;
  office0555: { kpmId: string; owner: string; agent: string };
}

export interface ReportingFixture {
  /** Rows this run wrote; 0 on a re-run. */
  written: number;
  guide: string;
}

const shiftMonth = (month: string, by: number) => {
  const d = new Date(Date.UTC(Number(month.slice(0, 4)), Number(month.slice(5)) - 1 + by, 1));
  return d.toISOString().slice(0, 7);
};
const oid = (id: string) => new mongoose.Types.ObjectId(id);

export async function seedReportingFixture(deps: ReportingFixtureDeps): Promise<ReportingFixture> {
  const { clock, kpmId } = deps;
  const db = mongoose.connection.db!;
  const now = clock.now();
  const today = clock.localDateFor(DEFAULT_TENANT_TIMEZONE, now);
  const thisMonth = today.slice(0, 7);
  const lastMonth = shiftMonth(thisMonth, -1);
  const lastYear = String(Number(today.slice(0, 4)) - 1);
  const dayStart = (day: string) => clock.startOfLocalDay(DEFAULT_TENANT_TIMEZONE, day);
  const at = (day: string, hour: number) => new Date(dayStart(day).getTime() + hour * 3_600_000);
  const keyOf = new Map(Object.entries(deps.cast).map(([key, p]) => [p.id, key as ReportingKey]));
  let written = 0;

  // ---- The persistency criterion on the company's MOC rules, by the migration that gives it to every company.
  await mocPersistency(db, now);

  // ---- A year of files: January last year to three months ago, the month before last left empty.
  const active = await db.collection('memberships')
    .find({ kpmId, status: 'active', deletedAt: null }).sort({ agentSeq: 1 }).toArray();
  const earlier = active.filter((m) => !deps.coachingCastIds.has(String(m._id)) && !keyOf.has(String(m._id)));
  // The cast's leaver is on every file of a month they were here to the end of (OD-74).
  const leavers = (await db.collection('memberships')
    .find({ kpmId, status: 'removed', deletedAt: null }).sort({ agentSeq: 1 }).toArray())
    .filter((m) => keyOf.has(String(m._id)));
  const roster = [...active, ...leavers];
  const EMPTY = { value: null, provenance: null, sourceBatchId: null };
  for (let month = `${lastYear}-01`; month <= shiftMonth(thisMonth, -3); month = shiftMonth(month, 1)) {
    const held = (await db.collection('dataUploadBatches').findOne({ kpmId, month }))
      ?? (await db.collection('productionMonths').findOne({ kpmId, month, deletedAt: null }));
    if (held) continue;
    const endOfMonth = dayStart(`${shiftMonth(month, 1)}-01`);
    const rows = roster
      .filter((m) => !deps.coachingCastIds.has(String(m._id)) && m.joinedAt && (m.joinedAt as Date) < endOfMonth
        && (m.status === 'active' || (m.removedAt as Date) >= endOfMonth))
      .flatMap((m) => {
        const key = keyOf.get(String(m._id));
        const values = key ? reportingMonthFigures(key, month, thisMonth) : seedMonthFigures(earlier.findIndex((e) => String(e._id) === String(m._id)), month);
        return values ? [{ member: m, values }] : [];
      });
    if (rows.length === 0) continue;
    const batchId = seedObjectId('reporting-fixture', 'batch', kpmId, month);
    const committedAt = at(`${shiftMonth(month, 1)}-05`, 3);
    await db.collection('dataUploadBatches').insertOne({
      _id: oid(batchId), kpmId, month, status: 'committed', filename: templateFilename('0417', month),
      fileSha256: createHash('sha256').update(`reporting:${month}`).digest('hex'), templateVersion: 1, encoding: 'utf-8',
      delimiter: ',', basedOnRevision: 0, monthRevision: 1, rowCount: rows.length, writtenRowCount: rows.length,
      cellCount: rows.length * 12, issueCount: 0, startedAt: committedAt, committedAt, committedBy: deps.owner.membershipId,
      revertedAt: null, revertedBy: null, restoredCellCount: 0, keptCellCount: 0, deletedAt: null,
      createdBy: deps.owner.membershipId, updatedBy: deps.owner.membershipId, createdAt: committedAt, updatedAt: committedAt,
    });
    await db.collection('dataUploadRows').insertMany(rows.map((r, n) => ({
      kpmId, batchId, month, line: n + 2, agentCode: r.member.agentCode, membershipId: String(r.member._id), status: 'ready',
      values: r.values, previousValues: Object.fromEntries(Object.keys(r.values).map((k) => [k, null])), issues: [], deletedAt: null,
      createdBy: deps.owner.membershipId, updatedBy: deps.owner.membershipId, createdAt: committedAt, updatedAt: committedAt,
    })));
    await db.collection('monthlyAgentData').insertMany(rows.map((r) => ({
      kpmId, membershipId: String(r.member._id), agentCode: r.member.agentCode, month,
      ...Object.fromEntries(PRODUCTION_METRICS.flatMap((metric) => (['monthly', 'ytd'] as const).map((c) => {
        const value = r.values[monthField(metric, c)];
        return [monthField(metric, c), value === undefined ? EMPTY : { value, provenance: 'imported', sourceBatchId: batchId }];
      }))),
      deletedAt: null, createdBy: deps.owner.membershipId, updatedBy: deps.owner.membershipId, createdAt: committedAt, updatedAt: committedAt,
    })));
    await db.collection('productionMonths').insertOne({
      kpmId, month, revision: 1, lockOverride: null, deletedAt: null, createdBy: deps.owner.membershipId,
      updatedBy: deps.owner.membershipId, createdAt: committedAt, updatedAt: committedAt,
    });
    await db.collection('auditLog').insertOne({
      kpmId, actorUserId: deps.owner.userId, effectiveUserId: deps.owner.userId, actorMembershipId: deps.owner.membershipId,
      action: 'upload.commit', targetCollection: 'dataUploadBatches', targetId: batchId,
      after: { month, filename: templateFilename('0417', month), writtenRowCount: rows.length }, createdAt: committedAt,
    });
    written += 3 + rows.length * 2;
  }

  // ---- This year's goals, saved by each member's leader in their name (ADR-0046).
  const year = today.slice(0, 4);
  for (const person of REPORTING_CAST.filter((p) => !p.removedLastMonth)) {
    const membershipId = deps.cast[person.key].id;
    const id = seedObjectId('reporting-fixture', 'goal', kpmId, year, person.key);
    if (await db.collection('goals').findOne({ kpmId, membershipId, period: year, deletedAt: null })) continue;
    const savedAt = at(`${year}-01-10`, 3);
    const inputs = {
      mode: 'direct' as const, annualApeTargetMinor: person.annualTargetMillions * MINOR_UNITS_PER_RP_MILLION, savingsTargetMinor: 0,
      commissionRatePct: 0, apeAchievedMinor: 0, caseSizeMinor: 18 * MINOR_UNITS_PER_RP_MILLION, leadsToApptPct: 30, closingRatePct: 30,
    };
    const agreed = computeCascade({ ...inputs, monthsLeft: defaultMonthsLeft(year, savedAt, DEFAULT_TENANT_TIMEZONE) });
    const savedBy = person.leader === 'owner' ? deps.owner.membershipId : deps.cast[person.leader].id;
    await db.collection('goals').insertOne({
      _id: oid(id), kpmId, membershipId, period: year, ...inputs, monthsLeftOverride: null,
      snapshot: {
        monthlyApeTargetMinor: agreed.monthlyApeTargetMinor, policiesPerMonth: agreed.policiesPerMonth,
        appointmentsPerMonth: agreed.appointmentsPerMonth, leadsPerMonth: agreed.leadsPerMonth,
      },
      cascadeMapping: { ...CASCADE_ACTIVITY_CODES }, savedAt, savedByMembershipId: savedBy, version: 1, revisions: [],
      deletedAt: null, createdBy: savedBy, updatedBy: savedBy, createdAt: savedAt, updatedAt: savedAt,
    });
    written += 1;
  }

  // ---- Logging: the large agency this week, Satria's agents some weeks back, Raka never.
  const types = new Map((await db.collection('activityTypes').find({ kpmId }).toArray()).map((t) => [t.code as string, String(t._id)]));
  const entry = (code: string, count: number) => ({ activityTypeId: types.get(code) ?? code, activityTypeCode: code, count });
  const logDays = async (office: string, membershipId: string, daysBack: readonly number[]) => {
    for (const back of daysBack) {
      const localDate = addDays(today, -back);
      const entries = [entry(CASCADE_ACTIVITY_CODES.leadsCode, 3), entry(CASCADE_ACTIVITY_CODES.appointmentsCode, 1)];
      const { upsertedCount } = await db.collection('activityLogs').updateOne(
        { kpmId: office, membershipId, localDate, deletedAt: null },
        {
          $setOnInsert: {
            _id: oid(seedObjectId('reporting-fixture', 'log', office, membershipId, localDate)), kpmId: office, membershipId, localDate,
            entries, totalCount: 4, source: 'self', enteredByMembershipId: membershipId, version: 1, frozenAt: null, corrections: [],
            deletedAt: null, createdBy: membershipId, updatedBy: membershipId, createdAt: at(localDate, 12), updatedAt: at(localDate, 12),
          },
        },
        { upsert: true },
      );
      written += upsertedCount;
    }
  };
  for (const person of REPORTING_CAST) await logDays(kpmId, deps.cast[person.key].id, person.loggedDaysBack);
  // The Owner and the Admin logged some weeks back, and not since: *"Last logged {n} days ago"* on the not-logged
  // list, beside those who never have.
  await logDays(kpmId, deps.owner.membershipId, [11, 17]);
  await logDays(kpmId, deps.admin.membershipId, [13, 19]);

  // ---- 1:1s: Yosef this week with three of his; Winda with two of hers; Satria's people weeks ago — nobody this week.
  const sessions: [coach: ReportingKey, coachee: ReportingKey, daysBack: number][] = [
    ['yosef', 'arini', 2], ['yosef', 'bonar', 4], ['yosef', 'winda', 5], ['winda', 'ikhsan', 10], ['winda', 'jihan', 6],
    ['satria', 'oscar', 25], ['satria', 'pandu', 40],
  ];
  const session = async (office: string, coach: string, coachee: string, slot: string, daysBack: number) => {
    const id = seedObjectId('reporting-fixture', 'session', office, slot);
    if (await db.collection('coachingSessions').findOne({ _id: oid(id) })) return;
    const day = addDays(today, -daysBack);
    await db.collection('coachingSessions').insertOne({
      _id: oid(id), kpmId: office, coachMembershipId: coach, coacheeMembershipId: coachee, status: 'finalized', date: day,
      lastWeek: null, lastWeekItems: [], tips: [], leadActions: [],
      actionItems: [{ itemId: seedObjectId('reporting-fixture', 'item', office, slot), text: 'Jadwalkan dua presentasi', dueDate: addDays(day, 7), carriedFromItemId: null }],
      snapshot: null, finalizedAt: at(day, 4), finalizedByMembershipId: coach, version: 3, frozenAt: at(day, 4), corrections: [],
      deletedAt: null, createdAt: at(day, 3), createdBy: coach, updatedAt: at(day, 4), updatedBy: coach,
    });
    written += 1;
  };
  for (const [coach, coachee, back] of sessions) {
    await session(kpmId, deps.cast[coach].id, deps.cast[coachee].id, `${coach}-${coachee}`, back);
  }

  // ---- Recruitment: three candidates at the office's late stages, two closed won last month.
  const leadStage = async (owner: ReportingKey, name: string, path: string[], closedWonOn: string | null) => {
    const id = seedObjectId('reporting-fixture', 'lead', kpmId, name);
    if (await db.collection('leads').findOne({ _id: oid(id) })) return;
    const ownerId = deps.cast[owner].id;
    const registered = at(addDays(today, -60), 3);
    const statusCode = path.at(-1)!;
    const status = await db.collection('leadStatuses').findOne({ kpmId, code: statusCode });
    await db.collection('leads').insertOne({
      _id: oid(id), kpmId, ownerMembershipId: ownerId, name, type: 'recruitment', contact: { phone: null, email: null },
      statusCode, statusId: status ? String(status._id) : null, commitments: [], remarks: null,
      nextActionDate: closedWonOn ? null : addDays(today, 3), nextActionNote: closedWonOn ? null : 'Konfirmasi tanggal ujian AAJI.',
      outcome: closedWonOn ? 'won' : null, outcomeAt: closedWonOn ? at(closedWonOn, 5) : null, dateRegistered: registered,
      source: 'Jaringan pribadi', version: path.length + (closedWonOn ? 2 : 1),
      transitions: path.map((code, i) => ({
        fromStatusCode: i === 0 ? null : path[i - 1], toStatusCode: code,
        at: at(addDays(closedWonOn ?? today, -(path.length - i) * 4), 4), byMembershipId: ownerId,
      })),
      deletedAt: null, createdBy: ownerId, updatedBy: ownerId, createdAt: registered, updatedAt: registered,
    });
    written += 1;
  };
  const midLastMonth = `${lastMonth}-15`;
  await leadStage('arini', 'Sdr. Galang Pratama', ['NOT_APPROACHED', 'RECRUITMENT_PRESENTATION', 'AGENT_CODE_CREATED'], null);
  await leadStage('bonar', 'Sdri. Melinda Sari', ['NOT_APPROACHED', 'AGENT_CODE_CREATED', 'AAJI_LICENSED'], null);
  await leadStage('ikhsan', 'Sdr. Taufik Hidayat', ['MEETING_SCHEDULED', 'AAJI_LICENSED', 'JOINT_FIELD_WORK_PLANNED'], null);
  await leadStage('cahya', 'Sdri. Anjani Putri', ['MEETING_SCHEDULED', 'AAJI_LICENSED', 'NEW_ACTIVE_AGENT'], midLastMonth);
  await leadStage('damar', 'Sdr. Rizal Fadillah', ['MEETING_SCHEDULED', 'JOINT_FIELD_WORK_PLANNED', 'NEW_ACTIVE_AGENT'], addDays(midLastMonth, 5));

  // ---- This month's recruitment target, set by the Owner and audited as the write audits it.
  if (!(await db.collection('kpmRecruitTargets').findOne({ kpmId, month: thisMonth, deletedAt: null }))) {
    const id = seedObjectId('reporting-fixture', 'target', kpmId, thisMonth);
    const setAt = at(`${thisMonth}-01`, 3);
    await db.collection('kpmRecruitTargets').insertOne({
      _id: oid(id), kpmId, month: thisMonth, target: REPORTING_RECRUIT_TARGET, deletedAt: null,
      createdBy: deps.owner.membershipId, updatedBy: deps.owner.membershipId, createdAt: setAt, updatedAt: setAt,
    });
    await db.collection('auditLog').insertOne({
      kpmId, actorUserId: deps.owner.userId, effectiveUserId: deps.owner.userId, actorMembershipId: deps.owner.membershipId,
      action: 'kpm_overview.recruit_target_set', targetCollection: 'kpmRecruitTargets', targetId: id,
      before: null, after: { month: thisMonth, target: REPORTING_RECRUIT_TARGET }, createdAt: setAt,
    });
    written += 2;
  }

  // ---- 0555's own: two months' files, a 1:1 and a fortnight's logging.
  const b = deps.office0555;
  for (const month of [lastMonth, thisMonth]) {
    if (await db.collection('productionMonths').findOne({ kpmId: b.kpmId, month, deletedAt: null })) continue;
    const members = await db.collection('memberships').find({ kpmId: b.kpmId, status: 'active', deletedAt: null }).sort({ agentSeq: 1 }).toArray();
    const batchId = seedObjectId('reporting-fixture', 'batch', b.kpmId, month);
    const committedAt = month === thisMonth ? at(today, 2) : at(`${thisMonth}-03`, 3);
    await db.collection('dataUploadBatches').insertOne({
      _id: oid(batchId), kpmId: b.kpmId, month, status: 'committed', filename: templateFilename('0555', month),
      fileSha256: createHash('sha256').update(`reporting:0555:${month}`).digest('hex'), templateVersion: 1, encoding: 'utf-8',
      delimiter: ',', basedOnRevision: 0, monthRevision: 1, rowCount: members.length, writtenRowCount: members.length,
      cellCount: members.length * 12, issueCount: 0, startedAt: committedAt, committedAt, committedBy: b.owner,
      revertedAt: null, revertedBy: null, restoredCellCount: 0, keptCellCount: 0, deletedAt: null,
      createdBy: b.owner, updatedBy: b.owner, createdAt: committedAt, updatedAt: committedAt,
    });
    await db.collection('monthlyAgentData').insertMany(members.map((m, i) => {
      const values = seedMonthFigures(i + 1, month);
      return {
        kpmId: b.kpmId, membershipId: String(m._id), agentCode: m.agentCode, month,
        ...Object.fromEntries(Object.entries(values).map(([k, v]) => [k, { value: v, provenance: 'imported', sourceBatchId: batchId }])),
        deletedAt: null, createdBy: b.owner, updatedBy: b.owner, createdAt: committedAt, updatedAt: committedAt,
      };
    }));
    await db.collection('productionMonths').insertOne({
      kpmId: b.kpmId, month, revision: 1, lockOverride: null, deletedAt: null, createdBy: b.owner, updatedBy: b.owner,
      createdAt: committedAt, updatedAt: committedAt,
    });
    written += 2 + members.length;
  }
  await session(b.kpmId, b.owner, b.agent, '0555-owner-agent', 3);
  // Its snapshot, taken by finalize's own builder as of its day, as 0417's are (`coaching-snapshots.ts`).
  written += await backfillCoachingSnapshots(b.kpmId);
  await logDays(b.kpmId, b.agent, [0, 1, 3, 5, 8, 13]);
  await logDays(b.kpmId, b.owner, [2, 9]);

  // ---- Sign-ins across offices: only on an account that has none, so a real sign-in is never written over.
  const signIn = async (userId: string, daysBack: number | null) => {
    if (daysBack === null) return;
    const { modifiedCount } = await db.collection('users').updateOne(
      { _id: oid(userId), lastLoginAt: null }, { $set: { lastLoginAt: new Date(now.getTime() - daysBack * 86_400_000 - 3_600_000) } },
    );
    written += modifiedCount;
  };
  const officeUsers = async (code: string) => {
    const office = await db.collection('kpms').findOne({ code, deletedAt: null });
    if (!office) return [];
    return (await db.collection('memberships').find({ kpmId: String(office._id), status: 'active', deletedAt: null })
      .sort({ agentSeq: 1 }).toArray()).map((m) => String(m.userId));
  };
  // 0417: most within the week, every fifth within the month, every seventh never.
  for (const [i, userId] of (await officeUsers('0417')).entries()) {
    await signIn(userId, i % 7 === 6 ? null : i % 5 === 4 ? 12 + (i % 15) : 1 + (i % 6));
  }
  for (const [i, userId] of (await officeUsers('0555')).entries()) await signIn(userId, i === 0 ? 2 : 12);
  // 0601's subscription ended ten days ago: nobody there within thirty days.
  for (const [i, userId] of (await officeUsers('0601')).entries()) await signIn(userId, i === 0 ? 45 : null);
  for (const userId of await officeUsers('0602')) await signIn(userId, 3);
  for (const [i, userId] of (await officeUsers('0701')).entries()) await signIn(userId, i === 0 ? 1 : null);

  const guide = `
  REPORTING at /kpm/overview, /kpm/analytics and /admin/analytics  (from src/seed/reporting-fixture.ts)
    owner@kpm0417.test           KPM Overview: five AB agencies — the Owner's, Maya's, Agus's, and two new
    admin@kpm0417.test           ones under the Owner: Yosef Tambunan's (large: five agents and Winda
                                 Anggraeni's unit of three) and Satria Nugraha's (small, furthest behind
                                 target). "Showing 4 of 5 ABs"; the leaderboard ranks the four ABs who lead
                                 somebody, Satria at 0% (coached by nobody this week). Who hasn't logged:
                                 Agus Prasetyo and Raka Aditama never; the Owner and Maya 11 to 19 days ago.
                                 Recruitment target ${REPORTING_RECRUIT_TARGET}, set by the Owner this month; three
                                 candidates at late stages and two closed won last month. Files from January
                                 last year — every month of it, Yosef and Winda here since the year before — to
                                 three months ago; the month before last is empty. Gilang Saputra left
                                 Yosef's agency last month: on the Removed tab, their production this year
                                 still the office's
                                 KPM Analytics: Yosef's agency at Star Club and meeting MOC (three-criteria
                                 path); Winda's unit "—" (her persistency not on this month's file); Satria's
                                 agency failing MOC with its gaps. Monthly production: five bars, one gap
                                 People › All members: Last activity and Last coached on every row
    yosef@kpm0417.test           tagged Core Leader, beside Agus and Sari
    owner@kpm0555.test           0555's own figures only: two months' files, a 1:1, a fortnight's logging;
                                 its Owner and Lina joined two months ago
    owner@kpm0701.test           Hadi Gunawan: the empty office — every section's empty state
    superadmin@agencyboost.test  Cross-platform analytics: sign-ins — most of 0417 within the week, some
                                 within the month, some never; none of 0601's within thirty days.
                                 A read-only support session into 0417's Owner reads the Overview and
                                 cannot set the target
`;

  return { written, guide };
}
