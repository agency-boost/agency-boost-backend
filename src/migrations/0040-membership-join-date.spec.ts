import mongoose from 'mongoose';
import { clearCollections, startMongo, stopMongo } from '../../test/mongo';
import { up } from './0040-membership-join-date';

const db = () => mongoose.connection.db as mongoose.mongo.Db;
const col = (name: string) => db().collection(name);

/**
 * P18.8-T2 AC-2 (ADR-0169 §6). Every membership is given its join date and who it makes them: one with an activation
 * record a new hire, from that activation's start date; every other an existing agent, from `joinedAt` as an office
 * date in its office's zone; a pending one nothing, until it is approved. Office by office, and once.
 */
describe('0040 — every membership’s join date and classification (ADR-0169)', () => {
  beforeAll(startMongo);
  afterAll(stopMongo);

  beforeEach(async () => {
    await clearCollections();
    for (const name of ['kpms', 'memberships', 'activationProgress']) await col(name).deleteMany({});
  });

  const office = async (over: Record<string, unknown> = {}) =>
    String((await col('kpms').insertOne({ code: '0417', timezone: 'Asia/Jakarta', deletedAt: null, ...over })).insertedId);
  const member = async (kpmId: string, over: Record<string, unknown> = {}) => String((await col('memberships').insertOne({
    kpmId, role: 'agent', status: 'active', leaderId: 'leader-1', joinedAt: new Date('2026-08-01T01:00:00Z'), deletedAt: null,
    ...over,
  })).insertedId);
  const activation = (kpmId: string, membershipId: string, startDate: string, over: Record<string, unknown> = {}) =>
    col('activationProgress').insertOne({ kpmId, membershipId, startDate, graduatedAt: null, deletedAt: null, createdAt: new Date(), ...over });
  const fieldsOf = async (id: string) => {
    const row = await col('memberships').findOne({ _id: new mongoose.Types.ObjectId(id) });
    return { joinedAs: row?.joinedAs, joinDate: row?.joinDate };
  };

  it('P18.8-T2 AC-2 classifies a member with an activation a new hire, from its start date — a corrected one included', async () => {
    const kpmId = await office();
    const hire = await member(kpmId);
    // A leader moved Wahyu's start a week before the day he joined here (ADR-0102): that date is the join date now.
    const corrected = await member(kpmId, { joinedAt: new Date('2026-08-10T03:00:00Z') });
    const graduated = await member(kpmId, { joinedAt: new Date('2025-11-03T03:00:00Z') });
    await activation(kpmId, hire, '2026-08-01');
    await activation(kpmId, corrected, '2026-08-03', { startCorrectedAt: new Date() });
    await activation(kpmId, graduated, '2025-11-03', { graduatedAt: new Date('2026-01-12T03:00:00Z') });

    expect(await up(db())).toEqual({ newHires: 3, existingAgents: 0, waiting: 0 });
    expect(await fieldsOf(hire)).toEqual({ joinedAs: 'new_hire', joinDate: '2026-08-01' });
    expect(await fieldsOf(corrected)).toEqual({ joinedAs: 'new_hire', joinDate: '2026-08-03' });
    // An activation in any state makes them a new hire: the record says they were one.
    expect(await fieldsOf(graduated)).toEqual({ joinedAs: 'new_hire', joinDate: '2025-11-03' });
  });

  it('P18.8-T2 AC-2 classifies every other member an existing agent, from joinedAt as an office date in its office’s zone', async () => {
    const jakarta = await office();
    const york = await office({ code: '0555', timezone: 'America/New_York' });
    const plain = await office({ code: '0601', timezone: undefined });
    // 23:30 UTC on 31 July is 1 August in Jakarta, and still 31 July in New York.
    const late = await member(jakarta, { joinedAt: new Date('2026-07-31T23:30:00Z') });
    const yorker = await member(york, { joinedAt: new Date('2026-07-31T23:30:00Z') });
    // An office that names no zone reads the platform's, Asia/Jakarta (ADR-0016).
    const unzoned = await member(plain, { joinedAt: new Date('2026-07-31T23:30:00Z') });
    const owner = await member(jakarta, { role: 'ab', leaderId: null, joinedAt: new Date('2025-01-06T02:00:00Z') });
    const removed = await member(jakarta, { status: 'removed', joinedAt: new Date('2026-03-02T02:00:00Z'), removedAt: new Date() });

    expect(await up(db())).toEqual({ newHires: 0, existingAgents: 5, waiting: 0 });
    expect(await fieldsOf(late)).toEqual({ joinedAs: 'existing_agent', joinDate: '2026-08-01' });
    expect(await fieldsOf(yorker)).toEqual({ joinedAs: 'existing_agent', joinDate: '2026-07-31' });
    expect(await fieldsOf(unzoned)).toEqual({ joinedAs: 'existing_agent', joinDate: '2026-08-01' });
    expect(await fieldsOf(owner)).toEqual({ joinedAs: 'existing_agent', joinDate: '2025-01-06' });
    // A removed member's history stays, and a report about the past reads them.
    expect(await fieldsOf(removed)).toEqual({ joinedAs: 'existing_agent', joinDate: '2026-03-02' });
  });

  it('P18.8-T2 AC-2 leaves a pending member, whom nobody has let in, with neither until they are approved', async () => {
    const kpmId = await office();
    const pending = await member(kpmId, { status: 'pending', leaderId: null, joinedAt: null });
    expect(await up(db())).toEqual({ newHires: 0, existingAgents: 0, waiting: 1 });
    expect(await fieldsOf(pending)).toEqual({ joinedAs: undefined, joinDate: undefined });
  });

  it('P18.8-T2 AC-2 is tenant-safe: an activation in another office never classifies this office’s member', async () => {
    const a = await office();
    const b = await office({ code: '0555' });
    const inA = await member(a, { joinedAt: new Date('2026-08-01T01:00:00Z') });
    // The same membership id named in office B's activation — a row that must not reach across.
    await activation(b, inA, '2026-07-01');
    await up(db());
    expect(await fieldsOf(inA)).toEqual({ joinedAs: 'existing_agent', joinDate: '2026-08-01' });
  });

  it('P18.8-T2 AC-2 changes nothing on a second run, nor a member classified already — a later correction stays', async () => {
    const kpmId = await office();
    const hire = await member(kpmId);
    await activation(kpmId, hire, '2026-08-01');
    const other = await member(kpmId, { joinedAt: new Date('2026-08-02T01:00:00Z') });
    await member(kpmId, { status: 'pending', joinedAt: null });
    // Somebody written by today's code: classified already, and never reclassified by this.
    const classified = await member(kpmId, { joinedAs: 'existing_agent', joinDate: '2019-05-01' });
    await activation(kpmId, classified, '2026-08-01');

    expect(await up(db())).toEqual({ newHires: 1, existingAgents: 1, waiting: 1 });
    const before = await col('memberships').find({}).sort({ _id: 1 }).toArray();
    expect(await up(db())).toEqual({ newHires: 0, existingAgents: 0, waiting: 1 });
    expect(await col('memberships').find({}).sort({ _id: 1 }).toArray()).toEqual(before);
    expect(await fieldsOf(other)).toEqual({ joinedAs: 'existing_agent', joinDate: '2026-08-02' });
    expect(await fieldsOf(classified)).toEqual({ joinedAs: 'existing_agent', joinDate: '2019-05-01' });
  });

  it('P18.8-T2 AC-2 writes nothing, and makes no collection, on an empty database', async () => {
    for (const { name } of await db().listCollections({}, { nameOnly: true }).toArray()) await col(name).drop();
    expect(await up(db())).toEqual({ newHires: 0, existingAgents: 0, waiting: 0 });
    expect(await up(db())).toEqual({ newHires: 0, existingAgents: 0, waiting: 0 });
    expect(await db().listCollections().toArray()).toEqual([]);
  });
});
