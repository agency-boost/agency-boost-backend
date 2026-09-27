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
import { up as kpmSeedRecordPerKind } from './0010-kpm-seed-record-per-kind';
import { up as seedTrainingTaxonomy } from './0011-seed-training-taxonomy';
import { up as seedActivationChecklist } from './0012-seed-activation-checklist';
import { up as seedProductCatalog } from './0013-seed-product-catalog';
import { up as assetUploadState } from './0014-asset-upload-state';
import { up as activityBackdateGrace } from './0015-kpm-activity-backdate-grace';
import { up as leadStatusLateStage } from './0016-lead-status-late-stage';
import { up as companyUsesPlatformDefaults } from './0017-company-uses-platform-defaults';
import { up as leadCommitments } from './0018-lead-commitments';
import { up as goalMonthsLeftOverride } from './0019-goal-months-left-override';
import { up as productionLockGrace } from './0020-kpm-production-lock-grace';

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
  ['0010-kpm-seed-record-per-kind', kpmSeedRecordPerKind],
  ['0011-seed-training-taxonomy', seedTrainingTaxonomy],
  ['0012-seed-activation-checklist', seedActivationChecklist],
  ['0013-seed-product-catalog', seedProductCatalog],
  ['0014-asset-upload-state', assetUploadState],
  ['0015-kpm-activity-backdate-grace', activityBackdateGrace],
  ['0016-lead-status-late-stage', leadStatusLateStage],
  ['0017-company-uses-platform-defaults', companyUsesPlatformDefaults],
  ['0018-lead-commitments', leadCommitments],
  ['0019-goal-months-left-override', goalMonthsLeftOverride],
  ['0020-kpm-production-lock-grace', productionLockGrace],
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
