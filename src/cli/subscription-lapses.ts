import 'reflect-metadata';
import type { Writable } from 'node:stream';
import mongoose from 'mongoose';
import { Clock, SystemClock } from '@/common/clock/clock.port';
import { MongoTarget, mongoTargetFrom } from '@/config/mongo-target';
import { BILLING } from '@/domain/constants';
import { AuditLog, AuditLogSchema } from '@/modules/audit/audit-log.schema';
import { AuditService } from '@/modules/audit/audit.service';
import { SubscriptionLapseService, type LapseReport } from '@/modules/billing/subscription-lapse.service';
import { Kpm, KpmSchema } from '@/modules/tenants/kpm.schema';

/**
 * **The automatic suspension, in the daily run** (P19.23-T5 AC-5; ADR-0279 §5): every active KPM whose period ended
 * more than seven days ago without a renewal is suspended, and its members then read *KPM ditangguhkan*.
 * `agencyboost-daily.timer` starts it at 00:10 in Jakarta through `deploy/bin/daily.sh`, after the premium notices, in
 * each deployed environment's API container:
 *
 *   node dist/cli/subscription-lapses.js [--today YYYY-MM-DD]
 *
 * with the API's own database settings. By hand it is the same command, and safe: a suspended KPM is no longer active,
 * so a second run suspends nobody again.
 *
 * - **Today is each KPM's own** (its zone, through the Clock port), never the server's. `--today` names another, for an
 *   operator catching up a day the VM was down (the timer is `Persistent=`, so that is rarely needed).
 * - **Nothing depends on it running on time**: the request path refuses a KPM past its grace on its own
 *   (`isEnded`), so a missed run means members read *Langganan berakhir* instead of *KPM ditangguhkan*, never that they
 *   get in.
 * - Plain mongoose, as `daily-notices` is. Exits `0` when it ran, `2` on a usage error and `1` on any other failure.
 */
export const USAGE = 'Usage: node dist/cli/subscription-lapses.js [--today YYYY-MM-DD]\n'
  + `       Suspends every active KPM whose subscription ended more than ${BILLING.GRACE_DAYS} days ago without a renewal.`;

const SERVER_SELECTION_TIMEOUT_MS = 10_000;

export class CliError extends Error {
  constructor(message: string, readonly exitCode = 1) {
    super(message);
  }
}

/** `--today` is a real calendar day, `YYYY-MM-DD`, or absent. */
export function parseArgs(argv: readonly string[]): { today: string | null } {
  if (argv.some((arg) => arg === '--help' || arg === '-h')) throw new CliError(USAGE, 2);
  let today: string | null = null;
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--today') {
      const value = argv[i + 1]?.trim() ?? '';
      if (!/^\d{4}-\d{2}-\d{2}$/.test(value) || Number.isNaN(Date.parse(`${value}T00:00:00Z`))
        || new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) !== value) {
        throw new CliError(`--today needs a day, YYYY-MM-DD.\n${USAGE}`, 2);
      }
      today = value;
      i += 1;
    } else {
      throw new CliError(`Unknown argument ${arg}.\n${USAGE}`, 2);
    }
  }
  return { today };
}

/** The report: how many were checked, and one line per KPM suspended. */
export function describeReport(report: LapseReport): string {
  const head = `Subscription lapses${report.today ? ` for ${report.today}` : ''}: `
    + `${report.checked} KPM(s) checked, ${report.suspended.length} suspended\n`;
  return head + report.suspended
    .map((k) => `  KPM ${k.code} · ${k.branch}: ended ${k.endDate}, grace ended ${k.graceEndedOn}\n`)
    .join('');
}

export interface Io {
  stdout: Writable;
  stderr: Writable;
  env: Readonly<Record<string, string | undefined>>;
  /** The clock, for a test; the system's otherwise. */
  clock?: Clock;
}

export async function run(argv: readonly string[], io: Io): Promise<number> {
  let connection: mongoose.Connection | null = null;
  try {
    const { today } = parseArgs(argv);
    const target: MongoTarget | null = mongoTargetFrom(io.env);
    if (!target) throw new CliError('MONGODB_URI is not set. Run it where the API runs, with the API\'s environment.');
    io.stderr.write(`Connecting to database "${target.dbName}" on ${target.hosts}\n`);
    const selection = /[?&]serverSelectionTimeoutMS=/i.test(target.uri)
      ? {}
      : { serverSelectionTimeoutMS: SERVER_SELECTION_TIMEOUT_MS };
    connection = await mongoose.createConnection(target.uri, { dbName: target.dbName, ...selection }).asPromise();
    const model = (name: string, schema: mongoose.Schema): never => connection!.model(name, schema) as never;
    const lapses = new SubscriptionLapseService(
      model(Kpm.name, KpmSchema),
      new AuditService(model(AuditLog.name, AuditLogSchema)),
      io.clock ?? new SystemClock(),
    );
    io.stdout.write(describeReport(await lapses.run(today ?? undefined)));
    return 0;
  } catch (err) {
    if (err instanceof CliError) {
      io.stderr.write(`${err.message}\n`);
      return err.exitCode;
    }
    io.stderr.write(`subscription-lapses failed: ${err instanceof Error ? err.message : String(err)}\n`);
    return 1;
  } finally {
    await connection?.close().catch(() => undefined);
  }
}

// Run as the command, never on import: the spec imports `run` and drives it itself.
if (require.main === module) {
  void run(process.argv.slice(2), { stdout: process.stdout, stderr: process.stderr, env: process.env })
    .then((code) => process.exit(code));
}
