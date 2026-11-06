import mongoose from 'mongoose';
import { startMongo, stopMongo } from '../../test/mongo';
import { MIGRATIONS } from './migrations';

/**
 * **Every migration runs on a database with nothing in it** (P18.4-T3, ADR-0152).
 *
 * A new VM's first deploy runs `node dist/migrations/run.js` before the API has created a single
 * collection. Each migration's own spec seeds the rows it moves, so none of them ever met an empty
 * database — and 0002 threw `NamespaceNotFound` on its first line there, which would have stopped the first
 * staging and the first production deploy at the migration step. This runs the whole list, in the
 * runner's order, against a database that holds nothing, and then again, as `deploy.sh` does on every
 * deploy: the second run must be the no-op the runner promises.
 */
describe('P18.4-T3 the migrations on an empty database', () => {
  beforeAll(startMongo);
  afterAll(stopMongo);

  const db = () => mongoose.connection.db as mongoose.mongo.Db;
  const NOW = new Date('2026-10-19T02:00:00.000Z');

  beforeEach(async () => {
    for (const { name } of await db().listCollections({}, { nameOnly: true }).toArray()) {
      await db().collection(name).drop();
    }
  });

  /** Every collection, its row count and its index names: what a second run must leave exactly as it was. */
  async function snapshot(): Promise<Record<string, { rows: number; indexes: string[] }>> {
    const state: Record<string, { rows: number; indexes: string[] }> = {};
    for (const { name } of await db().listCollections({}, { nameOnly: true }).toArray()) {
      state[name] = {
        rows: await db().collection(name).countDocuments({}),
        indexes: (await db().collection(name).indexes()).map((i) => String(i.name)).sort(),
      };
    }
    return state;
  }

  it('P18.4-T3 runs every migration in order on a database with no collections, and again as a no-op', async () => {
    expect(await db().listCollections().toArray()).toEqual([]);
    for (const [name, run] of MIGRATIONS) {
      await expect(run(db(), NOW)).resolves.not.toThrow();
      expect(name).toMatch(/^\d{4}-/);
    }
    const afterFirst = await snapshot();

    for (const [, run] of MIGRATIONS) {
      await expect(run(db(), NOW)).resolves.not.toThrow();
    }
    // P18.4-T1 (the review's L4): the second run is the no-op the runner promises, not merely one that
    // does not throw. Every deploy runs the list again, and there is no ledger to skip what has run.
    expect(await snapshot()).toEqual(afterFirst);
  });

  it('P18.4-T3 keeps the runner’s order: numbered, ascending, each named once', () => {
    const names = MIGRATIONS.map(([name]) => name);
    expect(new Set(names).size).toBe(names.length);
    expect([...names].sort()).toEqual(names);
  });
});
