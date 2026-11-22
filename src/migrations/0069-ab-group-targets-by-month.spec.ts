import mongoose from 'mongoose';
import { startMongo, stopMongo } from '../../test/mongo';
import { down, up } from './0069-ab-group-targets-by-month';

const KPM_A = '66f0000000000000000000a1';
const KPM_B = '66f0000000000000000000b1';
const NOW = new Date('2026-11-20T03:00:00Z');

/**
 * **ADR-0270 §4 for the yearly targets that came before** (P19.17-T4 AC-3; OD-387): an active AB's year becomes twelve
 * months — Active Agent as it was, Rekrut spread so the year adds up — a month already saved kept; an AAB's and a
 * leaver's dropped; the yearly rows left in place; a second run writes nothing; `down` removes what it wrote.
 */
describe('0069 — targets per AB group per month (ADR-0270)', () => {
  const db = () => mongoose.connection.db as mongoose.mongo.Db;
  const oid = () => new mongoose.Types.ObjectId();
  const yearly = (kpmId: string, head: string, year: string | null, aaTarget: number, recTarget: number) => ({
    _id: oid(), kpmId, kind: 'subgroup', headMembershipId: head, year, aaTarget, recTarget, month: null, row: null, value: null, deletedAt: null,
  });
  const member = (kpmId: string, role: string, status = 'active') => ({ _id: oid(), kpmId, role, status, deletedAt: null });
  const monthsOf = (kpmId: string, ab: string) => db().collection('abGroupTargets')
    .find({ kpmId, abMembershipId: ab }, { projection: { _id: 0, month: 1, activeAgentTarget: 1, rekrutTarget: 1, source: 1 } })
    .sort({ month: 1 }).toArray();

  beforeAll(startMongo);
  afterAll(stopMongo);
  beforeEach(async () => {
    for (const { name } of await db().listCollections({}, { nameOnly: true }).toArray()) await db().collection(name).drop();
  });

  it('P19.17-T4 AC-3 carries an active AB’s year into its months, keeps a saved month, drops an AAB’s and a leaver’s', async () => {
    const ab = member(KPM_A, 'ab');
    const aab = member(KPM_A, 'aab');
    const left = member(KPM_A, 'ab', 'removed');
    const agent = member(KPM_A, 'agent');
    const theirs = member(KPM_B, 'ab');
    await db().collection('memberships').insertMany([ab, aab, left, agent, theirs]);
    const id = (m: { _id: mongoose.Types.ObjectId }) => String(m._id);
    await db().collection('analyticsTargets').insertMany([
      yearly(KPM_A, id(ab), '2026', 3, 6),
      yearly(KPM_A, id(aab), '2026', 2, 3),
      yearly(KPM_A, id(left), '2026', 2, 3),
      yearly(KPM_A, id(agent), '2026', 1, 1),
      // Another office's AB, named under this office: not this office's member.
      yearly(KPM_A, id(theirs), '2026', 1, 1),
      yearly(KPM_B, id(theirs), '2025', 24, 24),
      // No year (before 0062) is not read.
      yearly(KPM_A, id(ab), null, 9, 9),
      { ...yearly(KPM_A, id(ab), '2024', 9, 9), deletedAt: NOW },
    ]);
    // November 2026 already saved by somebody: it wins.
    await db().collection('abGroupTargets').insertOne({
      kpmId: KPM_A, abMembershipId: id(ab), month: '2026-11', activeAgentTarget: 8, rekrutTarget: 4, source: 'set', deletedAt: null,
      createdBy: 'm-owner', updatedBy: 'm-owner',
    });

    expect(await up(db(), NOW)).toEqual({ carried: 2, months: 23, kept: 1, droppedAab: 1, droppedGone: 3 });

    const mine = await monthsOf(KPM_A, id(ab));
    expect(mine).toHaveLength(12);
    expect(mine.map((r) => r.activeAgentTarget)).toEqual([...Array(10).fill(3), 8, 3]);
    // 6 a year: 0, 1, 0, 1 … — November is the saved 4.
    expect(mine.map((r) => r.rekrutTarget)).toEqual([0, 1, 0, 1, 0, 1, 0, 1, 0, 1, 4, 1]);
    expect(mine.filter((r) => r.source === 'migration-0069')).toHaveLength(11);
    expect((await monthsOf(KPM_B, id(theirs))).map((r) => [r.month, r.activeAgentTarget, r.rekrutTarget]))
      .toEqual(Array.from({ length: 12 }, (_, i) => [`2025-${String(i + 1).padStart(2, '0')}`, 24, 2]));
    expect(await db().collection('abGroupTargets').countDocuments({ abMembershipId: { $in: [id(aab), id(left), id(agent)] } })).toBe(0);
    // The yearly rows stay where they are.
    expect(await db().collection('analyticsTargets').countDocuments({ kind: 'subgroup' })).toBe(8);

    // Idempotent.
    expect(await up(db(), NOW)).toEqual({ carried: 2, months: 0, kept: 24, droppedAab: 1, droppedGone: 3 });
    expect(await db().collection('abGroupTargets').countDocuments()).toBe(24);

    // Reversible: what it wrote goes, the saved month stays.
    expect(await down(db())).toEqual({ removed: 23 });
    expect(await monthsOf(KPM_A, id(ab))).toEqual([{ month: '2026-11', activeAgentTarget: 8, rekrutTarget: 4, source: 'set' }]);
  });

  it('reads nothing and creates no collection on an empty database, or one with no yearly target', async () => {
    expect(await up(db(), NOW)).toEqual({ carried: 0, months: 0, kept: 0, droppedAab: 0, droppedGone: 0 });
    await db().collection('analyticsTargets').insertOne({ kpmId: KPM_A, kind: 'mapa', month: '2026-01', row: 'ape', value: 1, deletedAt: null });
    expect(await up(db(), NOW)).toEqual({ carried: 0, months: 0, kept: 0, droppedAab: 0, droppedGone: 0 });
    expect(await db().listCollections({ name: 'abGroupTargets' }).toArray()).toEqual([]);
  });
});
