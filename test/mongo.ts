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

export async function clearCollections(): Promise<void> {
  const { collections } = mongoose.connection;
  await Promise.all(Object.values(collections).map((c) => c.deleteMany({})));
}
