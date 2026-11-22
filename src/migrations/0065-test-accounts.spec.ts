import mongoose from 'mongoose';
import { startMongo, stopMongo } from '../../test/mongo';
import { up } from './0065-test-accounts';

const KPM_A = '66f0000000000000000000a1';
const KPM_B = '66f0000000000000000000b1';

/**
 * **Test accounts are known by a stored flag** (P19.17-T1 AC-1; ADR-0267 §1; OD-370): every account written before the
 * flag is decided once by its name — *FMT …* and *TES IMPOR …* flagged, the rest cleared — an account holding a value is
 * never read again, and each flagged account's memberships carry the flag. A second run, and every deploy after, writes
 * nothing.
 */
describe('0065 — test accounts are flagged once by their names (ADR-0267 §1)', () => {
  const db = () => mongoose.connection.db as mongoose.mongo.Db;
  const id = () => new mongoose.Types.ObjectId();
  const account = (fullName: string, extra: Record<string, unknown> = {}) => ({
    _id: id(), email: `${String(Math.random())}@kpm0417.test`, fullName, ...extra,
  });
  const membership = (kpmId: string, userId: mongoose.Types.ObjectId, extra: Record<string, unknown> = {}) => ({
    _id: id(), kpmId, userId: String(userId), status: 'active', deletedAt: null, ...extra,
  });
  const flagOf = async (collection: string, _id: mongoose.Types.ObjectId) =>
    (await db().collection(collection).findOne({ _id }, { projection: { _id: 0, testAccount: 1 } }))?.testAccount;

  beforeAll(startMongo);
  afterAll(stopMongo);
  beforeEach(async () => {
    for (const { name } of await db().listCollections({}, { nameOnly: true }).toArray()) await db().collection(name).drop();
  });

  it('P19.17-T1 AC-1 flags FMT and TES IMPOR accounts, clears the rest, and gives each flagged account’s memberships the flag', async () => {
    const people = {
      fmt: account('FMT Budi'),
      fmtLower: account('  fmt   siti '),
      imported: account('TES IMPOR 3'),
      hilmy: account('Hilmy'),
      demo: account('Agus Prasetyo'),
      lookalike: account('FMTX Andi'),
      // Somebody already decided by hand: a person named FMT kept a person, a real-looking name flagged.
      keptPerson: account('FMT Kurniawan', { testAccount: false }),
      flaggedByHand: account('Hendra Wijaya', { testAccount: true }),
    };
    await db().collection('users').insertMany(Object.values(people));
    const rows = {
      fmtA: membership(KPM_A, people.fmt._id),
      fmtB: membership(KPM_B, people.fmt._id, { status: 'removed' }),
      imported: membership(KPM_A, people.imported._id, { deletedAt: new Date('2026-11-01T00:00:00Z') }),
      byHand: membership(KPM_A, people.flaggedByHand._id),
      hilmy: membership(KPM_A, people.hilmy._id),
      keptPerson: membership(KPM_A, people.keptPerson._id),
    };
    await db().collection('memberships').insertMany(Object.values(rows));

    expect(await up(db())).toEqual({ flagged: 3, cleared: 3, memberships: 4 });

    for (const key of ['fmt', 'fmtLower', 'imported', 'flaggedByHand'] as const) {
      expect({ key, flag: await flagOf('users', people[key]._id) }).toEqual({ key, flag: true });
    }
    for (const key of ['hilmy', 'demo', 'lookalike', 'keptPerson'] as const) {
      expect({ key, flag: await flagOf('users', people[key]._id) }).toEqual({ key, flag: false });
    }
    // Every office, removed and soft-deleted rows too; a person's membership is left without the field.
    for (const key of ['fmtA', 'fmtB', 'imported', 'byHand'] as const) {
      expect({ key, flag: await flagOf('memberships', rows[key]._id) }).toEqual({ key, flag: true });
    }
    expect(await flagOf('memberships', rows.hilmy._id)).toBeUndefined();
    expect(await flagOf('memberships', rows.keptPerson._id)).toBeUndefined();
    // The office is kept on every write (invariant §1).
    expect((await db().collection('memberships').findOne({ _id: rows.fmtB._id }))?.kpmId).toBe(KPM_B);

    // A second run, and every deploy after: nothing undecided, nothing to copy.
    expect(await up(db())).toEqual({ flagged: 0, cleared: 0, memberships: 0 });
  });

  it('P19.17-T1 AC-1 never re-decides an account a person cleared since: the next deploy leaves it cleared', async () => {
    const fmt = account('FMT Nadia');
    await db().collection('users').insertOne(fmt);
    const row = membership(KPM_A, fmt._id);
    await db().collection('memberships').insertOne(row);
    await up(db());

    // Cleared by hand, as the Super Admin's flag will: the account and its memberships together.
    await db().collection('users').updateOne({ _id: fmt._id }, { $set: { testAccount: false } });
    await db().collection('memberships').updateOne({ _id: row._id }, { $set: { testAccount: false } });

    expect(await up(db())).toEqual({ flagged: 0, cleared: 0, memberships: 0 });
    expect(await flagOf('users', fmt._id)).toBe(false);
    expect(await flagOf('memberships', row._id)).toBe(false);
  });

  it('P19.17-T1 AC-1 copies the flag onto a flagged account’s membership made since', async () => {
    const flagged = account('TES IMPOR 9', { testAccount: true });
    await db().collection('users').insertOne(flagged);
    const later = membership(KPM_B, flagged._id, { testAccount: false });
    await db().collection('memberships').insertOne(later);

    expect(await up(db())).toEqual({ flagged: 0, cleared: 0, memberships: 1 });
    expect(await flagOf('memberships', later._id)).toBe(true);
  });

  it('P19.17-T1 AC-1 on an empty database it reads nothing and creates no collection', async () => {
    expect(await up(db())).toEqual({ flagged: 0, cleared: 0, memberships: 0 });
    expect(await db().listCollections({}, { nameOnly: true }).toArray()).toEqual([]);
  });
});
