import mongoose from 'mongoose';
import { LEGACY_TIER_BY_CODE } from '@/domain/constants';
import { startMongo, stopMongo } from '../../test/mongo';
import { up } from './0030-org-level-leader-tier';

/**
 * **Every rung's leader tier, for companies that already exist** (P18.8-T1 AC-1, ADR-0156 §1): `AB` senior, `AAB`
 * associate, every other code none — archived rungs included — so nobody's class moves; a tier somebody set is never
 * rewritten; memberships on a rung outside the default ladder are counted and left alone; a second run does nothing.
 */
describe('0030 — every rung’s leader tier (ADR-0156)', () => {
  const db = () => mongoose.connection.db as mongoose.mongo.Db;
  const rung = (companyId: string, code: string, extra: Record<string, unknown> = {}) => ({
    companyId, code, label: code, displayOrder: 1, status: 'active', archivedAt: null, deletedAt: null, ...extra,
  });
  const member = (orgLevelCode: string, role: string, status = 'active') => ({
    kpmId: 'k1', userId: `u-${orgLevelCode}-${status}`, orgLevelId: `lvl-${orgLevelCode}`, orgLevelCode, role, status, deletedAt: null,
  });

  // Raw collections, which `clearCollections` (registered models only) does not reach.
  const clear = () => Promise.all(['companyOrgLevels', 'memberships'].map((c) => db().collection(c).deleteMany({})));

  beforeAll(startMongo);
  afterAll(stopMongo);
  beforeEach(async () => {
    await clear();
    await db().collection('companyOrgLevels').insertMany([
      rung('pru', 'AGENT'), rung('pru', 'AAB'), rung('pru', 'AB'),
      rung('pru', 'OLD_AB', { status: 'archived', archivedAt: new Date('2026-01-01T00:00:00Z') }),
      rung('alz', 'AB'), rung('alz', 'SM'),
      // Set on `/admin/org-levels` already — a value, never rewritten.
      rung('alz', 'UM', { leaderTier: 'associate' }), rung('alz', 'AAB', { leaderTier: null }),
    ]);
    await db().collection('memberships').insertMany([
      member('AB', 'ab'), member('AAB', 'aab'), member('AGENT', 'agent'),
      member('SM', 'agent'), member('SM', 'agent', 'pending'), member('SM', 'agent', 'removed'),
    ]);
  });

  it('P18.8-T1 AC-1 follows the rule the API reads an untouched rung by', () => {
    expect(LEGACY_TIER_BY_CODE).toEqual({ AB: 'senior', AAB: 'associate' });
  });

  it('P18.8-T1 AC-1 gives AB senior, AAB associate and every other code none, archived rungs too', async () => {
    expect(await up(db())).toEqual({ senior: 2, associate: 1, none: 3, membersOnCustomRungs: 2 });
    const tiers = await db().collection('companyOrgLevels').find({}).sort({ companyId: 1, code: 1 }).toArray();
    expect(tiers.map((r) => [r.companyId, r.code, r.leaderTier])).toEqual([
      ['alz', 'AAB', null], ['alz', 'AB', 'senior'], ['alz', 'SM', null], ['alz', 'UM', 'associate'],
      ['pru', 'AAB', 'associate'], ['pru', 'AB', 'senior'], ['pru', 'AGENT', null], ['pru', 'OLD_AB', null],
    ]);
  });

  it('P18.8-T1 AC-1 leaves every membership’s class as it was, the custom rung’s included', async () => {
    const before = await db().collection('memberships').find({}).sort({ _id: 1 }).toArray();
    await up(db());
    expect(await db().collection('memberships').find({}).sort({ _id: 1 }).toArray()).toEqual(before);
  });

  it('P18.8-T1 AC-1 is idempotent: a second run writes nothing', async () => {
    await up(db());
    expect(await up(db())).toEqual({ senior: 0, associate: 0, none: 0, membersOnCustomRungs: 2 });
  });

  it('P18.8-T1 AC-1 reads and writes nothing on an empty database', async () => {
    await clear();
    expect(await up(db())).toEqual({ senior: 0, associate: 0, none: 0, membersOnCustomRungs: 0 });
  });
});
