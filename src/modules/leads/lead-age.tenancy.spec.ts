import mongoose from 'mongoose';
import { FixedClock } from '@/common/clock/clock.port';
import { RequestContext } from '@/common/context/request-context';
import { clearCollections, startMongo, stopMongo } from '../../../test/mongo';
import { configModule, provisionOffice } from '../../../test/config-module';

/** 10:00 on 5 November 2026 in Jakarta. */
const NOW = new Date('2026-11-05T03:00:00Z');
const KPM_A = '66f0000000000000000000a1';
const KPM_B = '66f0000000000000000000b1';
const COMPANY = '66f0000000000000000000c1';

const AB = '66f000000000000000000101';
const AAB = '66f000000000000000000102';
const AGENT = '66f000000000000000000103';
const SIBLING = '66f000000000000000000104';
const STRANGER = '66f000000000000000000105';

const ctxFor = (membershipId: string, rung: string, kpmId = KPM_A) => new RequestContext('u-' + membershipId, 'none', {
  membershipId, kpmId, orgLevelCode: rung, hierarchyRole: rung.toLowerCase(),
  status: 'active', isKpmOwner: false, isKpmAdmin: false, directCount: 1,
} as never);

/**
 * **P19.14-T1 AC-4 — a lead written while it could carry an age** (ADR-0254 §5, superseding ADR-0224): a lead saved
 * between 5 and 12 November may still hold `age`, `ageRecordedOn` and `gender` in the database. **They are left as they
 * are and read by nothing**: no read answers them, to its owner or a leader; a write neither moves nor clears them; and
 * a proposal for the lead starts from no client data of the lead's — only from an earlier proposal's.
 */
describe('P19.14-T1 AC-4 a lead’s stored age and gender, read by nothing', () => {
  let wired: ReturnType<typeof configModule>;
  const clock = () => wired.clock as FixedClock;
  const db = () => mongoose.connection.db!;

  beforeAll(async () => {
    await startMongo();
    wired = configModule(NOW);
  });
  afterAll(stopMongo);

  beforeEach(async () => {
    clock().set(NOW);
    await clearCollections();
    await (wired.kpms as { create: (d: unknown) => Promise<unknown> }).create([
      { _id: KPM_A, companyId: COMPANY, code: '0417', branchName: 'A', timezone: 'Asia/Jakarta' },
      { _id: KPM_B, companyId: COMPANY, code: '0555', branchName: 'B', timezone: 'Asia/Jakarta' },
    ]);
    await provisionOffice(wired, KPM_A, COMPANY);
    const person = (id: string, rung: string, leaderId: string | null, ancestors: string[]) => ({
      _id: new mongoose.Types.ObjectId(id), kpmId: KPM_A, leaderCode: `LC-${id.slice(-3)}`,
      userId: '66f00000000000000000020' + id.slice(-1), orgLevelCode: rung, hierarchyRole: rung.toLowerCase(),
      leaderId, ancestorIds: ancestors, status: 'active', deletedAt: null,
    });
    await db().collection('memberships').insertMany([
      person(AB, 'AB', null, []),
      person(AAB, 'AAB', AB, [AB]),
      person(AGENT, 'AGENT', AAB, [AB, AAB]),
      person(SIBLING, 'AGENT', AAB, [AB, AAB]),
    ] as never);
    await db().collection('users').insertMany([AB, AAB, AGENT, SIBLING].map((id) => ({
      _id: new mongoose.Types.ObjectId('66f00000000000000000020' + id.slice(-1)),
      email: `${id}@kpm.test`, fullName: `Person ${id.slice(-3)}`, deletedAt: null,
    })) as never);
  });

  const agent = () => ctxFor(AGENT, 'AGENT');
  const aab = () => ctxFor(AAB, 'AAB');
  const stored = async (id: string) => db().collection('leads').findOne({ _id: new mongoose.Types.ObjectId(id) });
  const legacy = async (ctx: RequestContext) => {
    const lead = await wired.leadRecords.create(ctx, { name: 'Pak Budi', type: 'sales' });
    await db().collection('leads').updateOne(
      { _id: new mongoose.Types.ObjectId(lead.id) }, { $set: { age: 36, ageRecordedOn: '2026-11-05', gender: 'male' } },
    );
    return lead.id;
  };

  it('P19.14-T1 AC-4 answers none of the three to the owner, on a read or a list', async () => {
    const id = await legacy(agent());
    const read = await wired.leadRecords.read(agent(), id);
    const row = (await wired.leadRecords.list(agent(), { pageSize: 50 })).rows.find((r) => r.id === id)!;
    for (const view of [read, row]) for (const key of ['age', 'ageRecordedOn', 'gender']) expect(view).not.toHaveProperty(key);
  });

  it('P19.14-T1 AC-4 answers none of the three to a leader reading a downline’s lead', async () => {
    const id = await legacy(agent());
    const read = await wired.leadRecords.read(aab(), id);
    for (const key of ['age', 'ageRecordedOn', 'gender']) expect(read).not.toHaveProperty(key);
  });

  it('P19.14-T1 AC-4 a write neither moves nor clears them: they stay as stored, untouched (no destructive migration)', async () => {
    const id = await legacy(agent());
    const lead = await wired.leadRecords.read(agent(), id);
    await wired.leadRecords.update(agent(), id, { name: 'Pak Budi S.', version: lead.version });
    expect(await stored(id)).toMatchObject({ name: 'Pak Budi S.', age: 36, ageRecordedOn: '2026-11-05', gender: 'male' });
  });

  it('P19.14-T1 AC-5 the first proposal for such a lead starts empty: the lead’s stored age is no prefill', async () => {
    const id = await legacy(agent());
    const row = (await wired.leadRecords.list(agent(), { pageSize: 50 })).rows.find((r) => r.id === id)!;
    expect(row.proposals).toBeNull();
  });

  it('P19.14-T1 AC-4 KPM B cannot read KPM A’s lead at all: 404, as before (cross-tenant)', async () => {
    const id = await legacy(agent());
    const b = ctxFor(STRANGER, 'AGENT', KPM_B);
    await expect(wired.leadRecords.read(b, id)).rejects.toMatchObject({ status: 404 });
  });
});
