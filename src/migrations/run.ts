import 'dotenv/config';
import mongoose from 'mongoose';
import { SystemClock } from '@/common/clock/clock.port';
import { up as membershipOrgLevel } from './0001-membership-org-level';
import { up as userCompanyAgentCode } from './0002-user-company-agent-code';
import { up as membershipLeaderCode } from './0003-membership-leader-code';
import { up as membershipOrgLevelCode } from './0004-membership-org-level-code';
import { up as ratioOriginAndApplicability } from './0005-ratio-origin-and-applicability';
import { up as companyTemplates } from './0006-company-templates';
import { up as categoryAppliesTo } from './0007-category-applies-to';
import { up as ratioDisplayUnit } from './0008-ratio-display-unit';
import { up as ratioStandardFormula } from './0009-ratio-standard-formula';

/**
 * Every migration, in order. Forward-only and idempotent, so running this twice is a
 * no-op rather than a second application.
 */
const MIGRATIONS: ReadonlyArray<[string, (db: mongoose.mongo.Db, now: Date) => Promise<unknown>]> = [
  ['0001-membership-org-level', membershipOrgLevel],
  ['0002-user-company-agent-code', userCompanyAgentCode],
  ['0003-membership-leader-code', membershipLeaderCode],
  ['0004-membership-org-level-code', membershipOrgLevelCode],
  ['0005-ratio-origin-and-applicability', ratioOriginAndApplicability],
  ['0006-company-templates', companyTemplates],
  ['0007-category-applies-to', categoryAppliesTo],
  ['0008-ratio-display-unit', ratioDisplayUnit],
  ['0009-ratio-standard-formula', ratioStandardFormula],
];

async function main(): Promise<void> {
  const uri = process.env.MONGODB_URI;
  if (!uri) throw new Error('MONGODB_URI is not set');
  await mongoose.connect(uri, { dbName: process.env.MONGODB_DB_NAME });
  const clock = new SystemClock();

  try {
    for (const [name, run] of MIGRATIONS) {
      const result = await run(mongoose.connection.db as mongoose.mongo.Db, clock.now());
      // eslint-disable-next-line no-console
      console.log(`${name}:`, JSON.stringify(result));
    }
  } finally {
    await mongoose.disconnect();
  }
}

void main();
