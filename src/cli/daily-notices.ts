import 'reflect-metadata';
import type { Writable } from 'node:stream';
import mongoose, { Model } from 'mongoose';
import { Clock, SystemClock } from '@/common/clock/clock.port';
import type { Reader } from '@/common/i18n/reader';
import { MongoTarget, mongoTargetFrom } from '@/config/mongo-target';
import { DEFAULT_TENANT_TIMEZONE } from '@/domain/constants';
import { AuditLog, AuditLogSchema } from '@/modules/audit/audit-log.schema';
import { AuditService } from '@/modules/audit/audit.service';
import { describeNotification } from '@/modules/notifications/inbox-copy';
import { InAppChannelAdapter } from '@/modules/notifications/local-adapters';
import { NotificationRepository } from '@/modules/notifications/notification.repository';
import {
  Notification, NotificationDocument, NotificationPreferences, NotificationPreferencesSchema, NotificationSchema,
} from '@/modules/notifications/notification.schema';
import { NotificationService, TemplateRenderer } from '@/modules/notifications/notification.service';
import type { RenderedMessage } from '@/modules/notifications/notification.types';
import { PremiumNoticesService, type PremiumNoticesReport } from '@/modules/product-data/premium-notices.service';
import { RateTable, RateTableSchema } from '@/modules/product-data/rate-table.schema';
import { Product, ProductSchema } from '@/modules/products/product.schema';
import { Company, CompanySchema } from '@/modules/tenants/company.schema';
import { Kpm, KpmSchema } from '@/modules/tenants/kpm.schema';
import { User, UserSchema } from '@/modules/users/user.schema';

/**
 * **The daily run** (ADR-0261; P19.15-T4 AC-4): the premium table notices for one environment's database —
 * *"Tabel tarif {produk} berakhir {date}"* to the Super Admins fifteen days ahead, and *"Tarif {produk} diperbarui mulai
 * {date}"* to the KPM Owners when a version comes into force. `agencyboost-daily.timer` starts it at 00:10 in Jakarta
 * through `deploy/bin/daily.sh`, which runs, in each deployed environment's API container,
 *
 *   node dist/cli/daily-notices.js [--today YYYY-MM-DD]
 *
 * with the API's own database settings. By hand it is the same command, and safe: each notice is claimed on its table
 * version before it is sent, so a second run on the same day tells nobody again.
 *
 * - **Today is the office's** — `Asia/Jakarta` through the Clock port, never the server's day. `--today` names another,
 *   for an operator catching up a day the VM was down (the timer is `Persistent=`, so that is rarely needed).
 * - **In-app only** (ADR-0261 §4): the notices are rows in the recipients' inboxes, written as the API writes them
 *   (`NotificationService.send`, with the in-app channel alone), so the recipients' muted templates apply as anywhere.
 * - Plain mongoose, as `import-proposal-fields` is: booting the API's module would ask for its whole configuration.
 * - Prints one line per notice kind. Exits `0` when it ran, `2` on a usage error and `1` on any other failure.
 */
export const USAGE = 'Usage: node dist/cli/daily-notices.js [--today YYYY-MM-DD]\n'
  + '       Sends the premium table notices due today (Asia/Jakarta): 15 days before a table ends with nothing\n'
  + '       scheduled, to the Super Admins; and a version come into force, to its company\'s KPM Owners.';

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

/** The report, one line per notice. */
export function describeReport(report: PremiumNoticesReport): string {
  return `Premium table notices for ${report.today} (${DEFAULT_TENANT_TIMEZONE}):\n`
    + `  ending, to Super Admins: ${report.ending.tables} table version(s), ${report.ending.recipients} notice(s)\n`
    + `  started, to KPM Owners: ${report.started.tables} table version(s), ${report.started.recipients} notice(s)\n`;
}

/**
 * **The in-app channel's words**, which `NotificationService` renders for the row it writes: the inbox's own sentences.
 * The API renders through the email renderer, whose frame needs the app's address; an in-app row needs none.
 */
class InboxWordsRenderer extends TemplateRenderer {
  render(templateId: string, payload: Record<string, unknown>, reader?: Reader): RenderedMessage {
    const words = describeNotification(templateId, payload, reader);
    return { subject: words.title, body: words.detail ?? '' };
  }
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
    // Each model handed to the class that types it: the schemas are the API's own.
    const model = (name: string, schema: mongoose.Schema): never => connection!.model(name, schema) as never;
    const clock = io.clock ?? new SystemClock();

    const notificationRows: Model<NotificationDocument> = model(Notification.name, NotificationSchema);
    const notifications = new NotificationService(
      notificationRows,
      new NotificationRepository(notificationRows),
      model(NotificationPreferences.name, NotificationPreferencesSchema),
      new InboxWordsRenderer(),
      clock,
      new AuditService(model(AuditLog.name, AuditLogSchema)),
      [new InAppChannelAdapter()],
    );
    const notices = new PremiumNoticesService(
      model(RateTable.name, RateTableSchema),
      model(Product.name, ProductSchema),
      model(Company.name, CompanySchema),
      model(Kpm.name, KpmSchema),
      model(User.name, UserSchema),
      notifications,
      clock,
    );

    const report = await notices.run(today ?? undefined);
    io.stdout.write(describeReport(report));
    return 0;
  } catch (err) {
    if (err instanceof CliError) {
      io.stderr.write(`${err.message}\n`);
      return err.exitCode;
    }
    io.stderr.write(`daily-notices failed: ${err instanceof Error ? err.message : String(err)}\n`);
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
