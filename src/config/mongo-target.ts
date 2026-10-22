/**
 * The database a run of the API uses when `MONGODB_DB_NAME` is not set. The same default
 * `env.validation.ts` applies, and `env.validation.spec.ts` pins the two together.
 */
export const MONGODB_DB_NAME_DEFAULT = 'agencyboost';

/** Where a command connects, and how to name it in a line somebody reads. */
export interface MongoTarget {
  uri: string;
  dbName: string;
  /** The host list from the connection string, with no credentials, database or options: safe to print. */
  hosts: string;
}

/**
 * **Where the commands connect: the migrations, the demo seed and `create-super-admin`**
 * (P18.7-T1). They run without the API's configuration module, so they read the two keys
 * themselves, here, the way the API reads them. `null` when `MONGODB_URI` is not set: each
 * command says so in its own words.
 *
 * The migration runner passed `MONGODB_DB_NAME` through unread, so with the key unset it wrote to
 * the database named in the URI, or to `test`, while the API it migrated for used `agencyboost`.
 */
export function mongoTargetFrom(env: Readonly<Record<string, string | undefined>>): MongoTarget | null {
  const uri = env.MONGODB_URI?.trim();
  if (!uri) return null;
  return {
    uri,
    dbName: env.MONGODB_DB_NAME?.trim() || MONGODB_DB_NAME_DEFAULT,
    hosts: hostsOf(uri),
  };
}

/**
 * The hosts of a MongoDB connection string, without the scheme, the credentials, the database or the
 * options, so a command can print where it is about to write.
 *
 * Cut at the **last** `@`, not the first: a password should encode an `@` or a `/`, and a hand-written
 * one often does not. Cutting at the first `/` before the `@` would print half the password.
 */
export function hostsOf(uri: string): string {
  const afterScheme = uri.replace(/^[a-z][a-z0-9+.-]*:\/\//i, '');
  const afterCredentials = afterScheme.slice(afterScheme.lastIndexOf('@') + 1);
  return afterCredentials.split(/[/?]/, 1)[0];
}
