import { MongoMemoryServer } from 'mongodb-memory-server';
import mongoose from 'mongoose';

/**
 * An in-memory MongoDB for integration tests. No Docker needed, and each suite gets a
 * clean database so tests cannot leak state into each other.
 */
let server: MongoMemoryServer | null = null;

export async function startMongo(): Promise<string> {
  server = await MongoMemoryServer.create();
  const uri = server.getUri();
  await mongoose.connect(uri);
  return uri;
}

export async function stopMongo(): Promise<void> {
  await mongoose.disconnect();
  await server?.stop();
  server = null;
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
