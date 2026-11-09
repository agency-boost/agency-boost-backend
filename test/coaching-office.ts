import mongoose from 'mongoose';
import { RequestContext } from '@/common/context/request-context';
import { configModule, provisionOffice } from './config-module';

/**
 * **The coaching roster's office, for the specs that read it** (P11-T6): the tenancy spec, the HTTP
 * spec and the measurement read the same people, so a roster asserted in one is the roster the others
 * answer. Built on the real collections — memberships with the cache the org services write, users
 * with names, the company's ladder, goals, production, a fortnight of activity and finalized sessions —
 * and nothing mocked between them and the services.
 *
 * ```
 * OWNER Wilson (AB, the Owner as well, at the root)
 * ├── ADMIN Maya (AB, the Admin as well, leading nobody)
 * ├── AGUS (AB) ─┬── INDAH, DIMAS            his direct agents
 * │              ├── SARI (AAB) ─┬── RINA, BUDI
 * │              │               └── NINA (AAB) ── DODI       a nested unit
 * │              ├── DEWI (AAB, leading nobody)
 * │              ├── LUKAS (an agent who leads) ── TARI
 * │              └── LEFT (removed: keeps the cache, never listed)
 * └── PEER_AB ── PEER_AAB ── PEER_AGENT      Agus's peer, and a peer AAB's agent
 *
 * Office B: B_AB ── B_AGENT
 * ```
 */

/** 10:00 on Monday 14 September 2026 in Jakarta: August is on file, September is half logged. */
export const ROSTER_NOW = new Date('2026-09-14T03:00:00Z');
export const ROSTER_TODAY = '2026-09-14';
export const KPM_A = '66f0000000000000000000a1';
export const KPM_B = '66f0000000000000000000b1';
export const COMPANY = '66f0000000000000000000c1';
const M = 1_000_000 * 100;

export type Who =
  | 'OWNER' | 'ADMIN' | 'AGUS' | 'INDAH' | 'DIMAS' | 'SARI' | 'RINA' | 'BUDI' | 'NINA' | 'DODI' | 'DEWI'
  | 'LUKAS' | 'TARI' | 'LEFT' | 'PEER_AB' | 'PEER_AAB' | 'PEER_AGENT' | 'B_AB' | 'B_AGENT';

interface Person {
  who: Who;
  name: string;
  role: 'ab' | 'aab' | 'agent';
  leader: Who | null;
  kpmId?: string;
  status?: 'active' | 'removed';
  owner?: true;
  admin?: true;
}

/** Root first: a leader is placed before anybody below them. */
const PEOPLE: readonly Person[] = [
  { who: 'OWNER', name: 'Wilson Tanoto', role: 'ab', leader: null, owner: true },
  { who: 'ADMIN', name: 'Maya Kusuma', role: 'ab', leader: 'OWNER', admin: true },
  { who: 'AGUS', name: 'Agus Salim', role: 'ab', leader: 'OWNER' },
  { who: 'INDAH', name: 'Indah Permatasari', role: 'agent', leader: 'AGUS' },
  { who: 'DIMAS', name: 'Dimas Pratama', role: 'agent', leader: 'AGUS' },
  { who: 'SARI', name: 'Sari Puspita', role: 'aab', leader: 'AGUS' },
  { who: 'RINA', name: 'Rina Wijaya', role: 'agent', leader: 'SARI' },
  { who: 'BUDI', name: 'Budi Santoso', role: 'agent', leader: 'SARI' },
  { who: 'NINA', name: 'Nina Lestari', role: 'aab', leader: 'SARI' },
  { who: 'DODI', name: 'Dodi Kurniawan', role: 'agent', leader: 'NINA' },
  { who: 'DEWI', name: 'Dewi Lestari', role: 'aab', leader: 'AGUS' },
  { who: 'LUKAS', name: 'Lukas Hartono', role: 'agent', leader: 'AGUS' },
  { who: 'TARI', name: 'Tari Anggraini', role: 'agent', leader: 'LUKAS' },
  { who: 'LEFT', name: 'Fajar Nugroho', role: 'agent', leader: 'AGUS', status: 'removed' },
  { who: 'PEER_AB', name: 'Hendra Gunawan', role: 'ab', leader: 'OWNER' },
  { who: 'PEER_AAB', name: 'Putu Ayu', role: 'aab', leader: 'PEER_AB' },
  { who: 'PEER_AGENT', name: 'Yusuf Ramadhan', role: 'agent', leader: 'PEER_AAB' },
  { who: 'B_AB', name: 'Lina Marlina', role: 'ab', leader: null, kpmId: KPM_B },
  { who: 'B_AGENT', name: 'Bayu Saputra', role: 'agent', leader: 'B_AB', kpmId: KPM_B },
];

export interface CoachingOffice {
  /** Membership ids, by who. */
  id: Record<Who, string>;
  /** The name each one is listed under. */
  name: Record<Who, string>;
  /** Signed in as this member, in their own office. */
  as(who: Who): RequestContext;
}

/** The goal every member with one holds: Rp 500 M for 2026 at Rp 18 M a case, 30% and 30%. */
function goal(kpmId: string, membershipId: string) {
  return {
    kpmId, membershipId, period: '2026', mode: 'direct', annualApeTargetMinor: 500 * M, savingsTargetMinor: 0,
    commissionRatePct: 0, monthsLeftOverride: null, apeAchievedMinor: 0, caseSizeMinor: 18 * M,
    leadsToApptPct: 30, closingRatePct: 30,
    snapshot: { monthlyApeTargetMinor: 100 * M, policiesPerMonth: 6, appointmentsPerMonth: 20, leadsPerMonth: 67 },
    cascadeMapping: { leadsCode: 'LEADS_CONTACTED', appointmentsCode: 'SELL_PRESENTATION', closingsCode: 'SELL_SUBMISSION' },
    savedAt: new Date('2026-01-05T02:00:00Z'), savedByMembershipId: membershipId, revisions: [], version: 1,
    deletedAt: null, createdAt: new Date('2026-01-05T02:00:00Z'), updatedAt: new Date('2026-01-05T02:00:00Z'),
    createdBy: membershipId, updatedBy: membershipId,
  };
}

const cell = (value: number) => ({ value, provenance: 'imported', sourceBatchId: null });

/**
 * **The months the office's production was written in, as a real upload leaves them** (P19.5-T2; ADR-0214 §11): one
 * `productionMonths` row per month the fixture holds figures for, revision 1, first written on the day the story
 * implies — January and August at their month's end, September on the roster's today. Without them a month the office
 * holds would read as never written, and so open (`'history'`) whatever its date; with them August locks on its
 * schedule, 7 September. A spec that empties `productionMonths` puts these back.
 */
export function writtenMonthRows(): Record<string, unknown>[] {
  const at = (day: string) => new Date(`${day}T10:00:00Z`);
  return ([['2026-01', '2026-01-31'], ['2026-08', '2026-08-31'], ['2026-09', ROSTER_TODAY]] as const).map(([month, on]) => ({
    kpmId: KPM_A, month, revision: 1, lockOverride: null, lockChangedAt: null, lockChangedBy: null,
    firstWrittenOn: on, asOf: null, deletedAt: null, createdBy: null, updatedBy: null,
    createdAt: at(on), updatedAt: at(on),
  }));
}

/**
 * Build the office on the database the caller started. Everybody's status this month, by design:
 *
 * | Who | Goal | September's APE | Cascade codes logged | Status |
 * |---|---|---|---|---|
 * | INDAH | Rp 500 M | Rp 80 M of a Rp 85 M target | 20 | *On track* |
 * | DIMAS | Rp 500 M | Rp 20 M | 20 | *Watch closely* |
 * | RINA | Rp 500 M | Rp 80 M | none, only recruiting | *Needs attention* |
 * | everybody else | none | — | — | *No goal set* |
 *
 * and their last 1:1s: INDAH four days ago with Agus; SARI twelve days ago with Agus, overdue; RINA today
 * with Sari; BUDI two days ago with a coach whose membership is gone; DIMAS a draft of Agus's only, which
 * never counts. Activity is far heavier than any of it — the roster serves none.
 */
export async function buildCoachingOffice(wired: ReturnType<typeof configModule>): Promise<CoachingOffice> {
  const db = mongoose.connection.db!;
  await (wired.kpms as { create: (d: unknown) => Promise<unknown> }).create([
    { _id: KPM_A, companyId: COMPANY, code: '0417', branchName: 'A', timezone: 'Asia/Jakarta' },
    { _id: KPM_B, companyId: COMPANY, code: '0555', branchName: 'B', timezone: 'Asia/Jakarta' },
  ]);
  await wired.orgLevels.seedDefaultLadder(COMPANY);
  await provisionOffice(wired, KPM_A, COMPANY);

  const id = {} as Record<Who, string>;
  const name = {} as Record<Who, string>;
  const person = new Map<Who, Person>();
  let seq = 0;
  for (const p of PEOPLE) {
    seq += 1;
    person.set(p.who, p);
    const userId = new mongoose.Types.ObjectId();
    await db.collection('users').insertOne({
      _id: userId, email: `${p.who.toLowerCase()}@coaching.test`, passwordHash: 'x', fullName: p.name,
      status: 'active', platformRole: 'none', companyId: COMPANY, agentCode: `PRU-7${String(seq).padStart(4, '0')}`,
      deletedAt: null,
    });
    const leader = p.leader === null ? null : id[p.leader];
    const above = p.leader === null ? [] : [
      ...((await db.collection('memberships').findOne({ _id: new mongoose.Types.ObjectId(leader!) }))!.ancestorIds as string[]),
      leader!,
    ];
    const membershipId = new mongoose.Types.ObjectId();
    await db.collection('memberships').insertOne({
      _id: membershipId, kpmId: p.kpmId ?? KPM_A, userId: String(userId), agentCode: `PRU-7${String(seq).padStart(4, '0')}`,
      agentSeq: seq, leaderCode: `L${seq}${p.who}`.slice(0, 8).toUpperCase(),
      orgLevelId: new mongoose.Types.ObjectId().toString(), orgLevelCode: p.role.toUpperCase(), role: p.role,
      leaderId: leader, ancestorIds: above, depth: above.length, directCounts: { total: 0 }, subtreeCount: 0,
      status: p.status ?? 'active', joinedAt: new Date('2026-01-02T02:00:00Z'), deletedAt: null,
    });
    id[p.who] = String(membershipId);
    name[p.who] = p.name;
  }

  // The three goal holders' year: August on file for everybody, September for the three.
  const goals = (['INDAH', 'DIMAS', 'RINA'] as const).map((who) => goal(KPM_A, id[who]));
  await db.collection('goals').insertMany(goals);
  /*
   * P19.5-T2 (ADR-0214 §10): a year to date is the sum of the months held, never the file's YTD column. The year so far
   * was Rp 160 M at the end of August when the file carried it; January's Rp 140 M is what makes the months add to it, so
   * every figure read from this office — September's Rp 85 M target included — is the one it was, and February to July
   * still hold nothing.
   */
  const september: Partial<Record<Who, number>> = { INDAH: 80, DIMAS: 20, RINA: 80, SARI: 90 };
  const row = (who: Who, month: string, ape: number) => ({
    kpmId: KPM_A, membershipId: id[who], month, agentCode: who, deletedAt: null,
    templateId: null, templateVersion: 1, asOf: null, values: { APE: cell(ape * M) }, ytdValues: {},
  });
  const months = (Object.keys(september) as Who[]).flatMap((who) => [
    row(who, '2026-01', 140),
    row(who, '2026-08', 20),
    row(who, '2026-09', september[who]!),
  ]);
  await db.collection('monthlyAgentData').insertMany(months);
  await db.collection('productionMonths').insertMany(writtenMonthRows());

  // A fortnight of log: a cascade count on twelve days for INDAH and DIMAS, recruiting only for RINA.
  const logs: Record<string, unknown>[] = [];
  for (let day = 1; day <= 14; day += 1) {
    const localDate = `2026-09-${String(day).padStart(2, '0')}`;
    const entry = (code: string, count: number) => ({ activityTypeId: `t-${code}`, activityTypeCode: code, count });
    const write = (who: Who, entries: ReturnType<typeof entry>[]) => logs.push({
      kpmId: KPM_A, membershipId: id[who], localDate, entries, totalCount: entries.reduce((s, e) => s + e.count, 0),
      source: 'self', enteredByMembershipId: id[who], version: 1, frozenAt: null, corrections: [], deletedAt: null,
    });
    if (day <= 10) {
      write('INDAH', [entry('LEADS_CONTACTED', 2), entry('RECRUIT_FOLLOWUP', 37)]);
      write('DIMAS', [entry('SELL_PRESENTATION', 2), entry('RECRUIT_FOLLOWUP', 41)]);
    }
    write('RINA', [entry('RECRUIT_FOLLOWUP', 53), entry('DEV_COACHING_RECEIVED', 1)]);
  }
  await db.collection('activityLogs').insertMany(logs);

  // The sessions behind *Last 1:1*.
  const as = (who: Who) => new RequestContext(`u-${who}`, 'none', {
    membershipId: id[who], kpmId: person.get(who)!.kpmId ?? KPM_A, orgLevelCode: person.get(who)!.role.toUpperCase(),
    hierarchyRole: person.get(who)!.role, status: person.get(who)!.status ?? 'active',
    isKpmOwner: person.get(who)!.owner === true, isKpmAdmin: person.get(who)!.admin === true,
    directCount: PEOPLE.filter((p) => p.leader === who && (p.status ?? 'active') === 'active').length,
  } as never);
  const finalized = (coach: string, coachee: Who, date: string) => wired.coachingSessions.create(as('AGUS'), {
    coachMembershipId: coach, coacheeMembershipId: id[coachee], status: 'finalized', date,
    frozenAt: new Date(`${date}T04:00:00Z`), finalizedAt: new Date(`${date}T04:00:00Z`),
    finalizedByMembershipId: coach, version: 3,
    actionItems: [{ itemId: `${coachee}-1`, text: 'Book two presentations', dueDate: date, carriedFromItemId: null }],
  } as never);
  await finalized(id.AGUS, 'INDAH', '2026-09-10');
  await finalized(id.AGUS, 'SARI', '2026-09-02');
  await finalized(id.SARI, 'RINA', '2026-09-07');
  await finalized(id.SARI, 'RINA', ROSTER_TODAY);
  // A coach whose membership is gone: the session stays the coachee's history (ADR-0082).
  await finalized(new mongoose.Types.ObjectId().toString(), 'BUDI', '2026-09-12');
  await wired.coachingSessions.create(as('AGUS'), {
    coachMembershipId: id.AGUS, coacheeMembershipId: id.DIMAS, status: 'draft', version: 2,
  } as never);

  return { id, name, as };
}
