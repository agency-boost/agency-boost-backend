/*
 * **No `dotenv` here** (P18.7-T1, ADR-0152). `pnpm migrate` loads `.env` with `-r dotenv/config` before
 * this file runs; the image runs `node dist/migrations/run.js` with the environment the container was
 * given, and `dotenv` is a dev dependency the image does not install. An import here made the compiled
 * runner fail to start in production before it read a single variable.
 */
import mongoose from 'mongoose';
import { SystemClock } from '@/common/clock/clock.port';
import { mongoTargetFrom } from '@/config/mongo-target';
import { MIGRATIONS } from './migrations';

/** A run that cannot start for want of configuration: its message is the whole story, so no stack is printed. */
class NotConfigured extends Error {}

async function main(): Promise<void> {
  const target = mongoTargetFrom(process.env);
  if (!target) {
    throw new NotConfigured(
      'MONGODB_URI is not set. The migrations read the environment only: locally, run `pnpm migrate`, '
      + 'which loads .env; in a container, pass the API\'s env file.',
    );
  }
  // Said before anything is written, so a run against the wrong database is visible in its first line.
  // eslint-disable-next-line no-console
  console.log(`Migrating database "${target.dbName}" on ${target.hosts}`);
  await mongoose.connect(target.uri, { dbName: target.dbName });
  const clock = new SystemClock();

  /*
   * **Every migration, every deploy: there is no ledger** (P18.7-T1). Nothing records which ones have run,
   * so `deploy.sh` runs the whole list each time, and the contract is the one `README.md` in this folder
   * states: each is forward-only and idempotent, and a second run changes nothing. A migration that holds
   * only within a single run (0002's collision guard did) breaks the deploy after the one that first ran
   * it. `migrations.empty-db.spec.ts` runs the list twice and compares what each run leaves.
   */
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

/*
 * **A failed migration is a failed command** (P18.7-T1). `void main()` left a rejection to Node, whose
 * exit code depends on its version and flags; `deploy.sh` runs the migrations before it switches traffic
 * and stops on a non-zero exit, so the code has to be non-zero whatever Node does by default.
 */
main().catch((err: unknown) => {
  console.error(err instanceof NotConfigured ? err.message : err);
  process.exit(1);
});
