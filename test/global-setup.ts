import { MongoMemoryServer } from 'mongodb-memory-server';

/**
 * One in-memory MongoDB for the whole run, started before any worker forks.
 *
 * Every suite used to call `MongoMemoryServer.create()` for itself. With a dozen
 * DB-backed suites across parallel workers that is a dozen `mongod` processes racing to
 * start, and under `--coverage` — where instrumentation slows every one of them — they
 * exceeded the library's 10s startup budget and the tenancy suite failed with *"Instance
 * failed to start within 10000ms"*. It took 1009 seconds to do it.
 *
 * That made `pnpm test:coverage` — the gate the Definition of Done names — unreliable,
 * which is worse than slow: a flaky isolation suite is one somebody learns to re-run.
 *
 * Jest forks workers after this runs, so `process.env` set here reaches all of them.
 * Each worker keeps one database on it, wiped when a suite starts rather than dropped when
 * one ends — creating and dropping a database per suite was what stalled the server
 * (see `test/mongo.ts`).
 */
export default async function globalSetup(): Promise<void> {
  const server = await MongoMemoryServer.create();
  process.env.MONGO_TEST_URI = server.getUri();
  (globalThis as { __MONGO_SERVER__?: MongoMemoryServer }).__MONGO_SERVER__ = server;
}
