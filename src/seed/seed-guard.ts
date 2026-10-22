import { MongoTarget, mongoTargetFrom } from '@/config/mongo-target';

/** What `pnpm seed:demo` may do: refuse, with the reason, or seed the named target after saying which it is. */
export type SeedPlan =
  | { refusal: string }
  | { target: MongoTarget; banner: string };

/**
 * **Whether the demo seed may run here, and the line it prints before it writes** (P18.7-T1, ADR-0152).
 *
 * - **Never in production** (plan decision D11: production starts dark, with no tenant and no seed). The seed
 *   writes accounts whose passwords are printed in its own output and in the manuals, and `--reset` empties
 *   every collection it owns. Compared trimmed and lower-cased, so a mistyped `Production` is refused as well
 *   rather than read as somewhere else.
 * - **The target named before anything is written**: the database and its hosts, never the credentials. A
 *   `--reset` aimed at the wrong `MONGODB_URI` is caught by the person reading the first line, not by the
 *   rows that are missing afterwards.
 */
export function planSeed(env: Readonly<Record<string, string | undefined>>, reset: boolean): SeedPlan {
  if ((env.NODE_ENV ?? '').trim().toLowerCase() === 'production') {
    return {
      refusal:
        'Refusing to seed: NODE_ENV is "production". The demo seed writes accounts with published '
        + 'passwords, and --reset empties the collections it owns. It runs locally and on staging only.',
    };
  }
  const target = mongoTargetFrom(env);
  if (!target) {
    return { refusal: 'MONGODB_URI is not set. Copy .env.example to .env and fill in your connection string.' };
  }
  const where = `database "${target.dbName}" on ${target.hosts}`;
  return {
    target,
    banner: reset
      ? `--reset: emptying the demo's collections in ${where}, then seeding it`
      : `Seeding ${where}`,
  };
}
