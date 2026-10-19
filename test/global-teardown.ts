import { MongoMemoryServer } from 'mongodb-memory-server';

export default async function globalTeardown(): Promise<void> {
  const server = (globalThis as { __MONGO_SERVER__?: MongoMemoryServer }).__MONGO_SERVER__;
  await server?.stop();
}
