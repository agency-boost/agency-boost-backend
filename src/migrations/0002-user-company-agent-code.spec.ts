import mongoose from 'mongoose';
import { clearCollections, startMongo, stopMongo } from '../../test/mongo';
import { up } from './0002-user-company-agent-code';

/**
 * ADR-0017. The agent code moved from the office to the person, and every account written
 * before that has none.
 *
 * Worth a spec of its own because it is a one-shot write over real identity, and because
 * one of the two things it does — dropping an index Mongoose will not — could not have
 * been caught anywhere else: `mongodb-memory-server` starts empty and builds indexes from
 * the current schema every run, so only a database that has lived through the change sees
 * the old one.
 */
describe('0002 — moving the agent code onto the account', () => {
  beforeAll(startMongo);
  afterAll(stopMongo);

  const db = () => mongoose.connection.db as mongoose.mongo.Db;

  /*
   * **The raw collections, and their indexes.**
   *
   * `clearCollections` walks `mongoose.connection.collections`, which holds only what a
   * registered model has touched. This spec writes through `db().collection(...)` — the
   * way a migration does — so nothing here is on that list and nothing was being cleared
   * between tests. Indexes survive a `deleteMany` regardless, and this file builds one
   * deliberately.
   */
  beforeEach(async () => {
    await clearCollections();
    for (const name of ['users', 'memberships', 'kpms', 'companies']) {
      await db().collection(name).deleteMany({});
      await db().collection(name).dropIndexes().catch(() => undefined);
    }
  });
  const NOW = new Date('2026-09-08T02:00:00.000Z');
  const run = () => up(db(), NOW);

  async function legacy(over: { code?: string; email?: string; kpmId?: string } = {}) {
    const companyId = over.kpmId
      ? undefined
      : String((await db().collection('companies').insertOne({ name: 'Prudential' })).insertedId);
    const kpmId = over.kpmId
      ?? String((await db().collection('kpms').insertOne({ companyId, code: '0417' })).insertedId);
    const user = await db().collection('users').insertOne({
      email: over.email ?? 'rina@kpm.test', platformRole: 'none', deletedAt: null,
    });
    await db().collection('memberships').insertOne({
      kpmId, userId: String(user.insertedId), agentCode: over.code ?? 'KPM0417-001',
      createdAt: NOW, deletedAt: null,
    });
    return { userId: user.insertedId, kpmId, companyId };
  }

  it('takes the company from the office and the code from the membership', async () => {
    const { userId, companyId } = await legacy();
    expect(await run()).toMatchObject({ users: 1, skipped: 0, collisions: [] });

    const user = await db().collection('users').findOne({ _id: userId });
    expect(user?.companyId).toBe(companyId);
    // Nothing is invented: the code they already had is the code they keep, so no
    // historical attribution moves.
    expect(user?.agentCode).toBe('KPM0417-001');
  });

  it('runs twice without changing anything the second time', async () => {
    await legacy();
    await run();
    expect(await run()).toMatchObject({ users: 0 });
  });

  it('leaves a Super Admin alone, who sells for nobody', async () => {
    await db().collection('users').insertOne({
      email: 'root@agencyboost.test', platformRole: 'super_admin', deletedAt: null,
    });
    expect(await run()).toMatchObject({ users: 0, skipped: 0 });
    const sa = await db().collection('users').findOne({ email: 'root@agencyboost.test' });
    expect(sa?.agentCode).toBeUndefined();
  });

  it('skips somebody who never joined an office, rather than inventing a code', async () => {
    await db().collection('users').insertOne({
      email: 'newcomer@agencyboost.test', platformRole: 'none', deletedAt: null,
    });
    expect(await run()).toMatchObject({ users: 0, skipped: 1 });
  });

  it('takes the oldest membership, whose code the earliest production rows carry', async () => {
    const { userId, kpmId } = await legacy({ code: 'FIRST-1' });
    await db().collection('memberships').insertOne({
      kpmId, userId: String(userId), agentCode: 'SECOND-2',
      createdAt: new Date(NOW.getTime() + 86_400_000), deletedAt: null,
    });

    await run();
    expect((await db().collection('users').findOne({ _id: userId }))?.agentCode).toBe('FIRST-1');
  });

  it('reports a collision instead of writing a duplicate', async () => {
    // Two offices of one company may both hold a `-001`: that was the whole point of the
    // old per-office uniqueness. Under the new rule one of them has to be sorted out by
    // hand, so it is named rather than silently dropped or forced through.
    const first = await legacy({ email: 'a@kpm.test' });
    await legacy({ email: 'b@kpm.test', kpmId: first.kpmId });

    const result = await run();
    expect(result.users).toBe(1);
    expect(result.collisions).toHaveLength(1);
    expect(result.collisions[0]).toContain('b@kpm.test');
  });

  it('drops the unique membership index, which the schema alone cannot', async () => {
    await legacy();
    // The shape a deployed database is in: Mongoose built this before ADR-0017 and
    // matches indexes by name, so changing `unique` in the schema leaves it exactly here.
    await db().collection('memberships').createIndex({ kpmId: 1, agentCode: 1 }, { unique: true });

    expect(await run()).toMatchObject({ droppedIndex: true });

    const indexes = await db().collection('memberships').indexes();
    const rebuilt = indexes.find((i) => i.name === 'kpmId_1_agentCode_1');
    expect(rebuilt).toBeDefined();
    expect(rebuilt?.unique).toBeUndefined();
  });

  it('says so when there was no stale index to drop', async () => {
    await legacy();
    expect(await run()).toMatchObject({ droppedIndex: false });
  });
});
