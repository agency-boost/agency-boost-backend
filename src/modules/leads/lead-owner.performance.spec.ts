import mongoose from 'mongoose';
import { RequestContext } from '@/common/context/request-context';
import { clearCollections, startMongo, stopMongo } from '../../../test/mongo';
import { configModule, provisionOffice } from '../../../test/config-module';

const NOW = new Date('2026-09-25T02:00:00Z');
const KPM_A = '66f0000000000000000000a1';
const KPM_B = '66f0000000000000000000b1';
const COMPANY = '66f0000000000000000000c1';

const AGENTS = 20;
const LEADS = 40;
const LEADER = '66f0000000000000000003ff';
const LEADER_USER = '66f0000000000000000004ff';

type Explained = { queryPlanner: unknown; executionStats: { nReturned: number; totalDocsExamined: number } };

/**
 * **`GET /leads?owner=`, measured** (P11-T4 AC-7; `performance-and-scale.md`, 300 ms at p95 for a read):
 * the coaching session's Leads card, one coachee's leads read by their leader.
 *
 * The read resolves the owner through `COACH`, reads that one owner's leads by the tenant index, names
 * the page's editors and writes one §3.5 entry. Two offices of twenty agents with forty leads each, so a
 * plan that read the other office, or the whole downline to show one member, shows up in the examined
 * count before it shows up in the time.
 */
describe('P11-T4 AC-7 — a coachee’s leads, measured', () => {
  let wired: ReturnType<typeof configModule>;
  const agents: string[] = [];
  const leader = new RequestContext('u-leader', 'none', {
    membershipId: LEADER, kpmId: KPM_A, orgLevelCode: 'AB', hierarchyRole: 'ab',
    status: 'active', isKpmOwner: false, isKpmAdmin: false, directCount: AGENTS,
  } as never);

  beforeAll(async () => {
    await startMongo();
    wired = configModule(NOW);
    await clearCollections();
    await (wired.kpms as { create: (d: unknown) => Promise<unknown> }).create([
      { _id: KPM_A, companyId: COMPANY, code: '0417', branchName: 'A', timezone: 'Asia/Jakarta' },
      { _id: KPM_B, companyId: COMPANY, code: '0555', branchName: 'B', timezone: 'Asia/Jakarta' },
    ]);
    await provisionOffice(wired, KPM_A, COMPANY);
    await provisionOffice(wired, KPM_B, COMPANY);

    const memberships: Record<string, unknown>[] = [
      { _id: new mongoose.Types.ObjectId(LEADER), kpmId: KPM_A, userId: LEADER_USER, leaderCode: 'LC-LEAD',
        orgLevelCode: 'AB', leaderId: null, ancestorIds: [], depth: 0, status: 'active', deletedAt: null },
    ];
    const leads: Record<string, unknown>[] = [];
    for (let a = 0; a < AGENTS; a += 1) {
      for (const kpmId of [KPM_A, KPM_B]) {
        const id = new mongoose.Types.ObjectId().toString();
        if (kpmId === KPM_A) agents.push(id);
        memberships.push({
          _id: new mongoose.Types.ObjectId(id), kpmId, userId: new mongoose.Types.ObjectId().toString(),
          leaderCode: `LC-${id.slice(-8)}`,
          orgLevelCode: 'AGENT', leaderId: kpmId === KPM_A ? LEADER : null, ancestorIds: kpmId === KPM_A ? [LEADER] : [],
          depth: kpmId === KPM_A ? 1 : 0, status: 'active', deletedAt: null,
        });
        for (let n = 0; n < LEADS; n += 1) {
          leads.push({
            kpmId, ownerMembershipId: id, name: `Lead ${a}-${n}`, type: n % 2 === 0 ? 'sales' : 'recruitment',
            contact: { phone: null, email: null }, lawfulBasis: null, consentAt: null,
            statusCode: null, statusId: null, commitments: [], remarks: n % 4 === 0 ? null : 'Talked on Friday.',
            nextActionDate: n % 7 === 0 ? '2026-09-01' : '2026-12-01', nextActionNote: null,
            outcome: n % 11 === 0 ? 'lost' : null, outcomeAt: null, dateRegistered: NOW, source: null, version: 1,
            transitions: [], deletedAt: null, createdAt: NOW, updatedAt: NOW,
            // Every fifth one last changed by the leader, so the page has an editor's name to look up.
            createdBy: id, updatedBy: n % 5 === 0 && kpmId === KPM_A ? LEADER : id,
          });
        }
      }
    }
    const db = mongoose.connection.db!;
    await db.collection('memberships').insertMany(memberships as never);
    await db.collection('users').insertOne({
      _id: new mongoose.Types.ObjectId(LEADER_USER), email: 'leader@kpm.test', fullName: 'Agus Salim', deletedAt: null,
    } as never);
    await db.collection('leads').insertMany(leads as never);
    await Promise.all(['Lead', 'Membership']
      .filter((name) => mongoose.modelNames().includes(name))
      .map((name) => mongoose.model(name).syncIndexes()));
  }, 120_000);

  afterAll(stopMongo);

  it('reads one owner’s leads by index, touching that owner’s rows and no other', async () => {
    const plan = (await mongoose.connection.db!.collection('leads')
      .find({ kpmId: KPM_A, ownerMembershipId: { $in: [agents[0]] }, deletedAt: null })
      .explain('executionStats')) as unknown as Explained;

    expect(JSON.stringify(plan.queryPlanner)).not.toContain('COLLSCAN');
    expect(plan.executionStats.nReturned).toBe(LEADS);
    expect(plan.executionStats.totalDocsExamined).toBe(LEADS);
  });

  it('P11-T4 AC-7 GET /leads?owner= answers inside the read budget at p95, and records each read', async () => {
    const first = await wired.leadRecords.list(leader, { owner: agents[0] });
    expect(first.total).toBe(LEADS);
    expect(first.rows.every((r) => r.ownerMembershipId === agents[0])).toBe(true);
    expect(first.rows.filter((r) => r.lastEditedBy?.name === 'Agus Salim')).toHaveLength(LEADS / 5);

    const times: number[] = [];
    for (let i = 0; i < 20; i += 1) {
      const started = process.hrtime.bigint();
      await wired.leadRecords.list(leader, { owner: agents[i % AGENTS], search: i % 2 ? 'Lead' : undefined });
      times.push(Number(process.hrtime.bigint() - started) / 1e6);
    }
    times.sort((a, b) => a - b);
    const p95 = times[Math.ceil(0.95 * times.length) - 1];

    // eslint-disable-next-line no-console
    console.log(`  leads owner=          p95 of 20: ${p95.toFixed(1)} ms`);
    expect(p95).toBeLessThan(300);
    expect(await mongoose.connection.db!.collection('auditLog')
      .countDocuments({ action: 'activity_log.read_raw', 'after.surface': 'leads' })).toBe(21);
  });
});
