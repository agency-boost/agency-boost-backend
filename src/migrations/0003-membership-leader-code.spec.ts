import mongoose from 'mongoose';
import { clearCollections, startMongo, stopMongo } from '../../test/mongo';
import { up } from './0003-membership-leader-code';

/**
 * P3.2-T1. The leader code moved from `inviteCodes` onto the membership, and every row
 * written before that has none.
 *
 * The promise worth pinning is the carry-over: somebody has their code on a card or in a
 * WhatsApp thread, and a migration that generated a fresh one would break every link
 * already shared for no reason anybody could see.
 */
describe('0003 — giving every membership its leader code', () => {
  beforeAll(startMongo);
  afterAll(stopMongo);

  const db = () => mongoose.connection.db as mongoose.mongo.Db;

  // The same reason as 0002's: this writes through `db().collection(...)`, which
  // `clearCollections` does not know about.
  beforeEach(async () => {
    await clearCollections();
    for (const name of ['memberships', 'inviteCodes']) {
      await db().collection(name).deleteMany({});
      await db().collection(name).dropIndexes().catch(() => undefined);
    }
  });

  const NOW = new Date('2026-09-09T02:00:00.000Z');
  const run = () => up(db(), NOW);

  async function membership(over: Record<string, unknown> = {}) {
    const row = await db().collection('memberships').insertOne({
      kpmId: 'kpm-1', userId: `u-${Math.random()}`, agentCode: 'PRU-1', deletedAt: null, ...over,
    });
    return String(row.insertedId);
  }

  async function invite(issuedByMembershipId: string, over: Record<string, unknown> = {}) {
    await db().collection('inviteCodes').insertOne({
      code: 'SARI01', issuedByMembershipId, deletedAt: null, revokedAt: null,
      createdAt: NOW, ...over,
    });
  }

  it('carries over a live invite code, so links already shared keep working', async () => {
    const id = await membership();
    await invite(id);

    expect(await run()).toMatchObject({ carried: 1, generated: 0, skipped: 0 });
    const row = await db().collection('memberships').findOne({ _id: new mongoose.Types.ObjectId(id) });
    expect(row?.leaderCode).toBe('SARI01');
  });

  it('generates one for a membership that never issued an invite', async () => {
    await membership();
    expect(await run()).toMatchObject({ carried: 0, generated: 1, skipped: 0 });

    const row = await db().collection('memberships').findOne({});
    // The alphabet people can read down a phone line: no 0, O, 1 or I.
    expect(row?.leaderCode).toMatch(/^[A-Z2-9]{6}$/);
  });

  it('ignores a withdrawn or deleted invite, which nobody can use any more', async () => {
    const id = await membership();
    await invite(id, { revokedAt: NOW });
    await invite(id, { code: 'GONE01', deletedAt: NOW });

    expect(await run()).toMatchObject({ carried: 0, generated: 1 });
    const row = await db().collection('memberships').findOne({});
    expect(row?.leaderCode).not.toBe('SARI01');
    expect(row?.leaderCode).not.toBe('GONE01');
  });

  it('takes the oldest live invite, the one most likely to be out in the world', async () => {
    const id = await membership();
    await invite(id, { code: 'FIRST1', createdAt: new Date(NOW.getTime() - 86_400_000) });
    await invite(id, { code: 'LATER1' });

    await run();
    expect((await db().collection('memberships').findOne({}))?.leaderCode).toBe('FIRST1');
  });

  it('generates rather than duplicating a code somebody already holds', async () => {
    // Codes are unique across every office. If two memberships somehow both point at one,
    // only the first may keep it.
    await membership({ leaderCode: 'SARI01' });
    const second = await membership();
    await invite(second);

    expect(await run()).toMatchObject({ carried: 0, generated: 1 });
    const row = await db().collection('memberships').findOne({ leaderCode: { $ne: 'SARI01' } });
    expect(row?.leaderCode).toMatch(/^[A-Z2-9]{6}$/);
  });

  it('never hands two memberships the same generated code', async () => {
    for (let i = 0; i < 25; i += 1) await membership();
    expect(await run()).toMatchObject({ generated: 25, skipped: 0 });

    const rows = await db().collection('memberships').find({}).toArray();
    expect(new Set(rows.map((r) => r.leaderCode)).size).toBe(25);
  });

  it('runs twice without changing anything the second time', async () => {
    await membership();
    const first = await run();
    expect(await run()).toMatchObject({ carried: 0, generated: 0, skipped: 0 });
    expect(first.generated).toBe(1);
  });

  it('copes with a database that never had an inviteCodes collection', async () => {
    await db().collection('inviteCodes').drop().catch(() => undefined);
    await membership();
    expect(await run()).toMatchObject({ generated: 1 });
  });
});
