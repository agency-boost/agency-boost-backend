import mongoose from 'mongoose';
import { clearCollections, startMongo, stopMongo } from '../../test/mongo';
import { up } from './0001-membership-org-level';

/**
 * P3.5-T8. `memberships.orgLevelId` is required, and every row written before it existed
 * has none — so the field is only the stored truth once this has run.
 */
describe('0001 — backfilling the membership org level', () => {
  beforeAll(startMongo);
  afterAll(stopMongo);

  const db = () => mongoose.connection.db as mongoose.mongo.Db;
  /*
   * By name, because this spec registers no mongoose models and `clearCollections`
   * iterates the ones that are registered — so on its own it clears nothing here.
   *
   * That was invisible while `companies.slug`'s unique index happened not to exist in
   * this worker's database. Adding a spec file shifted the worker split, a neighbouring
   * file built the index, and every `legacyOffice()` after the first collided on
   * `slug: "prudential"`. `0004` and `0005` already clear by name for the same reason.
   */
  beforeEach(async () => {
    await clearCollections();
    for (const name of ['companies', 'kpms', 'memberships', 'companyOrgLevels']) {
      await db().collection(name).deleteMany({});
    }
  });

  const NOW = new Date('2026-09-07T02:00:00.000Z');
  const run = () => up(db(), NOW);

  async function legacyOffice(role = 'agent') {
    const company = await db().collection('companies').insertOne({
      name: 'Prudential', slug: 'prudential', deletedAt: null,
    });
    const kpm = await db().collection('kpms').insertOne({
      companyId: String(company.insertedId), code: '0417', deletedAt: null,
    });
    const member = await db().collection('memberships').insertOne({
      kpmId: String(kpm.insertedId), userId: 'u-1', role, status: 'active',
      agentCode: 'KPM0417-001', agentSeq: 1, deletedAt: null,
    });
    return { companyId: String(company.insertedId), membershipId: member.insertedId };
  }

  it('gives a company with no ladder the default one', async () => {
    const { companyId } = await legacyOffice();
    const result = await run();

    expect(result.ladders).toBe(3);
    const codes = await db()
      .collection('companyOrgLevels')
      .find({ companyId })
      .sort({ displayOrder: 1 })
      .toArray();
    expect(codes.map((l) => l.code)).toEqual(['AGENT', 'AAB', 'AB']);
  });

  it.each(['agent', 'aab', 'ab'])('points a legacy %s at the matching rung', async (role) => {
    const { companyId, membershipId } = await legacyOffice(role);
    await run();

    const member = await db().collection('memberships').findOne({ _id: membershipId });
    const level = await db()
      .collection('companyOrgLevels')
      .findOne({ _id: new mongoose.Types.ObjectId(String(member?.orgLevelId)) });

    expect(String(level?.code)).toBe(role.toUpperCase());
    expect(String(level?.companyId)).toBe(companyId);
  });

  it('is a no-op the second time, because a deploy may retry it', async () => {
    await legacyOffice();
    expect(await run()).toEqual({ ladders: 3, memberships: 1 });
    expect(await run()).toEqual({ ladders: 0, memberships: 0 });
  });

  it('leaves a ladder that already exists alone', async () => {
    const { companyId } = await legacyOffice();
    await db().collection('companyOrgLevels').insertOne({
      companyId, code: 'AGENT', label: 'Field Agent', displayOrder: 1,
      status: 'active', archivedAt: null, deletedAt: null,
    });

    await run();

    // The label the company chose survives. A migration that overwrote it would undo a
    // deliberate rename on the way past.
    const agent = await db().collection('companyOrgLevels').findOne({ companyId, code: 'AGENT' });
    expect(agent?.label).toBe('Field Agent');
  });

  it('throws rather than writing a membership with no rung', async () => {
    // An office pointing at a company that is not there is a data problem somebody has to
    // look at. Papering over it with a null would put back exactly the state the
    // reference exists to prevent.
    await db().collection('memberships').insertOne({
      kpmId: 'kpm-that-does-not-exist', userId: 'u-2', role: 'agent',
      status: 'active', agentCode: 'X-1', agentSeq: 1, deletedAt: null,
    });

    await expect(run()).rejects.toThrow(/Cannot resolve a rung/);
  });
});
