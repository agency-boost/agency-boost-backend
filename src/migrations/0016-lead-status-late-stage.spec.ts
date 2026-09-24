import mongoose from 'mongoose';
import { SEED_LEAD_STATUSES } from '@/domain/constants';
import { clearCollections, startMongo, stopMongo } from '../../test/mongo';
import { up } from './0016-lead-status-late-stage';

/**
 * ADR-0043. Every office that already has a ladder gets the *expected to close* flag.
 *
 * The interesting case is not the seeded stages — it is the ones an office invented. The
 * migration gives those `false` rather than guessing from `rank`, because deriving meaning from
 * position is precisely what the ADR refused (invariant §4).
 */
describe('0016 — the expected-to-close flag', () => {
  beforeAll(startMongo);
  afterAll(stopMongo);

  const db = () => mongoose.connection.db as mongoose.mongo.Db;
  const statuses = () => db().collection('leadStatuses');

  beforeEach(async () => {
    await clearCollections();
    await statuses().deleteMany({});
  });

  /** A row as it was written before this field existed: no `isLateStage` at all. */
  const old = (over: Record<string, unknown>) => ({
    kpmId: 'kpm-1', pipeline: 'sales', label: 'x', rank: 1, isTerminal: false,
    version: 1, status: 'active', archivedAt: null, deletedAt: null, ...over,
  });

  it('flags the seeded stages the platform knows the meaning of', async () => {
    await statuses().insertMany([
      old({ code: 'POLICY_SUBMITTED', rank: 3 }),
      old({ code: 'APPROVED_NOT_PAID', rank: 4 }),
      old({ code: 'AGENT_CODE_CREATED', pipeline: 'recruitment', rank: 4 }),
      old({ code: 'NOT_YET_APPROACHED', rank: 1 }),
    ]);

    const { updated, flagged } = await up(db());

    expect(updated).toBe(4);
    expect(flagged).toBe(3);
    const rows = await statuses().find({}).toArray();
    const late = rows.filter((r) => r.isLateStage).map((r) => r.code).sort();
    expect(late).toEqual(['AGENT_CODE_CREATED', 'APPROVED_NOT_PAID', 'POLICY_SUBMITTED']);
  });

  it('gives an office’s own stage false, never a guess from its rank', async () => {
    // `CONTRACT_SENT` sits at rank 6 of 7, which is exactly where a rank heuristic would
    // have flagged it. We know nothing about it, so it counts nothing until somebody ticks.
    await statuses().insertOne(old({ code: 'CONTRACT_SENT', pipeline: 'recruitment', rank: 6 }));

    const { updated, flagged } = await up(db());

    expect(updated).toBe(1);
    expect(flagged).toBe(0);
    expect((await statuses().findOne({}))!.isLateStage).toBe(false);
  });

  it('leaves a terminal stage false even where the code is a seeded late one', async () => {
    // An office may have made `POLICY_SUBMITTED` the stage that closes its pipeline. A
    // closed lead is not expected to close, and the seed's answer does not override that.
    await statuses().insertOne(old({ code: 'POLICY_SUBMITTED', rank: 3, isTerminal: true }));

    await up(db());

    expect((await statuses().findOne({}))!.isLateStage).toBe(false);
  });

  it('leaves an office that already has the field alone', async () => {
    await statuses().insertOne(old({ code: 'POLICY_SUBMITTED', isLateStage: false }));

    const { updated } = await up(db());

    expect(updated).toBe(0);
    expect((await statuses().findOne({}))!.isLateStage).toBe(false);
  });

  it('is idempotent — a second run writes nothing', async () => {
    await statuses().insertMany(SEED_LEAD_STATUSES.map((s, i) => old({
      code: s.code, pipeline: s.pipeline, rank: i + 1, isTerminal: s.isTerminal,
    })));

    const first = await up(db());
    const second = await up(db());

    expect(first.updated).toBe(SEED_LEAD_STATUSES.length);
    expect(second.updated).toBe(0);
  });

  it('reproduces the seed exactly, so a migrated office matches a new one', async () => {
    await statuses().insertMany(SEED_LEAD_STATUSES.map((s, i) => old({
      code: s.code, pipeline: s.pipeline, rank: i + 1, isTerminal: s.isTerminal,
    })));

    await up(db());

    const rows = await statuses().find({}).toArray();
    for (const seed of SEED_LEAD_STATUSES) {
      expect(rows.find((r) => r.code === seed.code)!.isLateStage).toBe(seed.isLateStage);
    }
  });
});
