import mongoose from 'mongoose';
import { clearCollections, startMongo, stopMongo } from '../../test/mongo';
import { up } from './0004-membership-org-level-code';

/**
 * P4-T9. `orgLevelCode` is what a permission grant is compared against, and
 * `directCounts` is keyed by it. A row written before either has neither.
 *
 * The thing worth pinning is that **no permission outcome changes**: v1's seeded ladder
 * codes are the upper-cased enum values, so the two are one-to-one — and asserting that
 * is different from assuming it.
 */
describe('0004 — the ladder code on every membership', () => {
  beforeAll(startMongo);
  afterAll(stopMongo);

  const db = () => mongoose.connection.db as mongoose.mongo.Db;

  // Written through `db().collection(...)`, which `clearCollections` does not know about.
  beforeEach(async () => {
    await clearCollections();
    for (const name of ['memberships', 'companyOrgLevels', 'kpms']) {
      await db().collection(name).deleteMany({});
    }
  });

  async function ladder(companyId = 'c1') {
    await db().collection('companyOrgLevels').insertMany([
      { _id: 'lvl-agent' as never, companyId, code: 'AGENT', displayOrder: 1, status: 'active', deletedAt: null },
      { _id: 'lvl-aab' as never, companyId, code: 'AAB', displayOrder: 2, status: 'active', deletedAt: null },
      { _id: 'lvl-ab' as never, companyId, code: 'AB', displayOrder: 3, status: 'active', deletedAt: null },
    ]);
    await db().collection('kpms').insertOne({ _id: 'kpm-1' as never, companyId, deletedAt: null });
  }

  const member = (over: Record<string, unknown>) => ({
    kpmId: 'kpm-1', userId: `u-${Math.random()}`, status: 'active',
    leaderId: null, deletedAt: null, ...over,
  });

  it('copies the code from the level the membership points at', async () => {
    await ladder();
    await db().collection('memberships').insertOne(
      member({ _id: 'm1' as never, orgLevelId: 'lvl-aab', role: 'aab' }) as never,
    );

    const result = await up(db());

    const row = await db().collection('memberships').findOne({ _id: 'm1' as never });
    expect(row?.orgLevelCode).toBe('AAB');
    expect(result.coded).toBe(1);
  });

  it('changes no permission outcome, because the two are one-to-one in v1', async () => {
    /*
     * The assertion P4-T9 AC-3 asks for. Every seeded rung's code is the upper-cased enum
     * value, so a grant that compared `role` and a grant that compares `orgLevelCode`
     * answer alike — for every row, not for the one somebody happened to check.
     */
    await ladder();
    await db().collection('memberships').insertMany([
      member({ _id: 'a' as never, orgLevelId: 'lvl-ab', role: 'ab' }),
      member({ _id: 'b' as never, orgLevelId: 'lvl-aab', role: 'aab' }),
      member({ _id: 'c' as never, orgLevelId: 'lvl-agent', role: 'agent' }),
    ] as never);

    await up(db());

    const rows = await db().collection('memberships').find({}).toArray();
    for (const row of rows) {
      expect(row.orgLevelCode).toBe(String(row.role).toUpperCase());
    }
  });

  it('falls back to the enum for a row whose level was archived out from under it', async () => {
    // A membership left with no rung would be denied by every hierarchy grant, silently.
    await ladder();
    await db().collection('memberships').insertOne(
      member({ _id: 'orphan' as never, orgLevelId: 'lvl-gone', role: 'ab' }) as never,
    );

    await up(db());

    const row = await db().collection('memberships').findOne({ _id: 'orphan' as never });
    expect(row?.orgLevelCode).toBe('AB');
  });

  it('rewrites the counts by code, with a zero for a rung nobody stands on', async () => {
    /*
     * The old shape's keys are lower case and nothing looks for them any more, so leaving
     * them would read as zero everywhere — a leader with two reports showing as leading
     * nobody on every screen that breaks the number down.
     */
    await ladder();
    await db().collection('memberships').insertMany([
      member({ _id: 'leader' as never, orgLevelId: 'lvl-ab', role: 'ab',
        directCounts: { ab: 0, aab: 0, agent: 2, total: 2 } }),
      member({ _id: 'r1' as never, orgLevelId: 'lvl-agent', role: 'agent', leaderId: 'leader' }),
      member({ _id: 'r2' as never, orgLevelId: 'lvl-agent', role: 'agent', leaderId: 'leader' }),
    ] as never);

    await up(db());

    const row = await db().collection('memberships').findOne({ _id: 'leader' as never });
    expect(row?.directCounts).toEqual({ total: 2, AGENT: 2, AAB: 0, AB: 0 });
  });

  it('counts only active reports', async () => {
    await ladder();
    await db().collection('memberships').insertMany([
      member({ _id: 'leader' as never, orgLevelId: 'lvl-ab', role: 'ab' }),
      member({ _id: 'live' as never, orgLevelId: 'lvl-agent', role: 'agent', leaderId: 'leader' }),
      member({ _id: 'gone' as never, orgLevelId: 'lvl-agent', role: 'agent',
        leaderId: 'leader', status: 'removed' }),
    ] as never);

    await up(db());

    const row = await db().collection('memberships').findOne({ _id: 'leader' as never });
    expect(row?.directCounts).toMatchObject({ total: 1, AGENT: 1 });
  });

  it('runs twice without changing anything the second time', async () => {
    await ladder();
    await db().collection('memberships').insertOne(
      member({ _id: 'm1' as never, orgLevelId: 'lvl-ab', role: 'ab' }) as never,
    );

    await up(db());
    const after = await up(db());

    expect(after.coded).toBe(0);
    const row = await db().collection('memberships').findOne({ _id: 'm1' as never });
    expect(row?.orgLevelCode).toBe('AB');
  });
});
