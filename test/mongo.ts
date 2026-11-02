import mongoose from 'mongoose';
import { DEFAULT_ORG_LADDER } from '@/domain/constants';
import {
  CompanyOrgLevel, CompanyOrgLevelSchema,
} from '@/modules/tenants/company-org-level.schema';

/**
 * An in-memory MongoDB for integration tests — no Docker — and **one database per worker, for the
 * whole run: wiped when a suite starts, never dropped.** Each suite still starts clean, so no test
 * sees another's rows.
 *
 * Suites share the server started in `test/global-setup.ts`. A database per suite used to be the
 * isolation boundary: created by the suite's first write, dropped by its `afterAll`. That was
 * about a hundred and fifty databases a run, each built from nothing — every registered model's
 * collection and indexes, a WiredTiger table apiece — and each dropped a minute later, across four
 * workers at once. Creating and dropping tables takes WiredTiger's schema lock, and so does
 * finishing a batch of deferred drops: when one landed, every worker's `syncIndexes` waited on it
 * together and was released together. Traced on 2026-09-29, with `TEST_DB_TRACE`: a `syncIndexes`
 * of 42 s against its hook's 30, and full runs failing one in three, each time in a suite nothing
 * had changed in. Turning the server's periodic checkpoints off did not stop it; the churn did.
 *
 * Now each worker keeps one database, and a suite starts from what a fresh one would give it:
 *
 * - **no rows** — every collection emptied, system ones aside, including collections this suite
 *   registers no model for, which a suite writing through `db().collection(...)` would otherwise
 *   inherit;
 * - **no constraint it did not build** — every unique index dropped. A migration spec builds a
 *   legacy index on purpose, and a unique index a suite's fixtures never agreed to rejects them;
 *   the suite's own models rebuild theirs as they would on a fresh database, and `syncIndexes`
 *   still waits for them. Plain indexes stay: they change how a query is answered, not whether.
 *
 * The wipe runs on a connection of its own, before the suite's: a model's automatic index build
 * starts when the suite connects, and dropping indexes under it would race it. Workers run their
 * suites one at a time and never share a database, so no suite ever sees another's rows.
 */
let dbName: string | null = null;

/**
 * `TEST_DB_TRACE=1` prints any operation on the shared server slower than 1.5 s, with its worker —
 * how the churn above was found, and the first thing to reach for if hooks start timing out again.
 */
const trace = async <T>(what: string, work: () => Promise<T>): Promise<T> => {
  const started = Date.now();
  try {
    return await work();
  } finally {
    const ms = Date.now() - started;
    if (process.env.TEST_DB_TRACE && ms > 1500) {
      process.stderr.write(`[db-trace] w${process.env.JEST_WORKER_ID} ${dbName} ${what} ${ms}ms ${new Date().toISOString()}\n`);
    }
  }
};

export async function startMongo(): Promise<string> {
  const base = process.env.MONGO_TEST_URI;
  if (!base) {
    throw new Error('MONGO_TEST_URI is unset — test/global-setup.ts did not run.');
  }

  // The worker's own database: a suite before this one on the same worker may have used it.
  const name = `test_w${process.env.JEST_WORKER_ID ?? '0'}`;
  dbName = name;
  await trace('wipe', () => wipe(base, name));
  await trace('connect', () => mongoose.connect(base, { dbName: name }));
  return base;
}

/** Empty every collection and drop every unique index, on a connection that builds no index. */
async function wipe(base: string, name: string): Promise<void> {
  const connection = await mongoose.createConnection(base, { dbName: name, autoIndex: false }).asPromise();
  try {
    const db = connection.db!;
    /*
     * **The last suite's index builds first.** A model starts building its indexes when its suite
     * connects, and the build outlives the suite's disconnect on the server. Wiping under one fails
     * (`an index build is currently running`), and a unique index still being built is not listed
     * yet — it would finish after the wipe, a constraint this suite never built.
     */
    await indexBuildsSettled(connection, name);
    const collections = await db.listCollections({}, { nameOnly: true }).toArray();
    await Promise.all(
      collections
        .filter((c) => !c.name.startsWith('system.'))
        .map(async (c) => {
          const collection = db.collection(c.name);
          await collection.deleteMany({});
          const constraining = (await collection.indexes()).filter((index) => index.name !== '_id_' && index.unique);
          await Promise.all(constraining.map((index) => untilNoBuild(() => collection.dropIndex(index.name!))));
        }),
    );
  } finally {
    await connection.close();
  }
}

const BUILD_WAIT_MS = 20_000;
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Until no index build is running in this database, or the wait runs out. */
async function indexBuildsSettled(connection: mongoose.Connection, name: string): Promise<void> {
  const deadline = Date.now() + BUILD_WAIT_MS;
  for (;;) {
    const { inprog } = await connection.db!.admin().command({
      currentOp: 1, 'command.createIndexes': { $exists: true }, ns: { $regex: `^${name}\\.` },
    });
    if ((inprog as unknown[]).length === 0 || Date.now() > deadline) return;
    await sleep(50);
  }
}

/** One more guard for the moment between the check and the drop: retry while a build holds the collection. */
async function untilNoBuild<T>(work: () => Promise<T>): Promise<T> {
  const deadline = Date.now() + BUILD_WAIT_MS;
  for (;;) {
    try {
      return await work();
    } catch (error) {
      // 12587 BackgroundOperationInProgressForNamespace — an index build is running on the collection.
      if ((error as { code?: number }).code !== 12587 || Date.now() > deadline) throw error;
      await sleep(50);
    }
  }
}

export async function stopMongo(): Promise<void> {
  // Not dropped: the next suite on this worker wipes it, and the server goes at the end of the run.
  await trace('disconnect', () => mongoose.disconnect());
  dbName = null;
}

/**
 * Build every registered model's indexes and wait for them.
 *
 * Mongoose builds indexes in the background, so an insert can beat the build — and a
 * unique index that has not been built enforces nothing. A test asserting a uniqueness
 * constraint has to wait for it, or it asserts the absence of a race rather than the
 * presence of a constraint.
 */
export async function syncIndexes(): Promise<void> {
  await trace('syncIndexes', () => Promise.all(Object.values(mongoose.models).map((m) => m.syncIndexes())));
}

export async function clearCollections(): Promise<void> {
  const { collections } = mongoose.connection;
  await trace('clearCollections', () => Promise.all(Object.values(collections).map((c) => c.deleteMany({}))));
}

/**
 * The ladder every company gets in production, for a fixture that creates one directly.
 *
 * `memberships.orgLevelId` resolves against a company's ladder on every join, so a
 * company built through the model in a spec — bypassing `TenantService.createCompany`,
 * which seeds it — has no rung to resolve and every join throws. Which is the design
 * working: a membership with no level is the defect the reference exists to prevent.
 */
export async function seedLadder(companyId: string): Promise<void> {
  const model = mongoose.models[CompanyOrgLevel.name]
    ?? mongoose.model(CompanyOrgLevel.name, CompanyOrgLevelSchema);
  for (const { code, label, displayOrder, leaderTier } of DEFAULT_ORG_LADDER) {
    if (await model.findOne({ companyId, code, deletedAt: null }).exec()) continue;
    await model.create({
      companyId, code, label, displayOrder, leaderTier,
      status: 'active', archivedAt: null, deletedAt: null,
    });
  }
}
