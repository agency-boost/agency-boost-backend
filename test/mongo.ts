import mongoose from 'mongoose';
import { DEFAULT_ORG_LADDER } from '@/domain/constants';
import {
  CompanyOrgLevel, CompanyOrgLevelSchema,
} from '@/modules/tenants/company-org-level.schema';

/**
 * An in-memory MongoDB for integration tests. No Docker needed, and each suite gets a
 * clean database so tests cannot leak state into each other.
 */
/**
 * Suites share the server started in `test/global-setup.ts` and take a database each.
 *
 * A database is the isolation boundary that matters — collections, indexes and the
 * uniqueness constraints built on them are all per-database — so this is as clean as a
 * server apiece, without a dozen `mongod` processes competing to start.
 */
let dbName: string | null = null;
let owned = false;
let suiteCounter = 0;

export async function startMongo(): Promise<string> {
  const base = process.env.MONGO_TEST_URI;
  if (!base) {
    throw new Error('MONGO_TEST_URI is unset — test/global-setup.ts did not run.');
  }

  // Unique per worker and per suite within it, so two suites never share a database
  // even when one worker runs both.
  suiteCounter += 1;
  dbName = `test_w${process.env.JEST_WORKER_ID ?? '0'}_s${suiteCounter}`;
  await mongoose.connect(base, { dbName });
  owned = true;
  return base;
}

export async function stopMongo(): Promise<void> {
  // Drop rather than leave it behind: the server outlives this suite now, and a stale
  // database would keep its indexes and its rows for whatever ran next.
  if (owned && mongoose.connection.readyState === 1) {
    await mongoose.connection.dropDatabase();
  }
  await mongoose.disconnect();
  dbName = null;
  owned = false;
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
  await Promise.all(Object.values(mongoose.models).map((m) => m.syncIndexes()));
}

export async function clearCollections(): Promise<void> {
  const { collections } = mongoose.connection;
  await Promise.all(Object.values(collections).map((c) => c.deleteMany({})));
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
  for (const { code, label, displayOrder } of DEFAULT_ORG_LADDER) {
    if (await model.findOne({ companyId, code, deletedAt: null }).exec()) continue;
    await model.create({
      companyId, code, label, displayOrder,
      status: 'active', archivedAt: null, deletedAt: null,
    });
  }
}
