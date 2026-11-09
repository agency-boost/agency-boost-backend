import 'reflect-metadata';
import type { Writable } from 'node:stream';
import mongoose, { Model, Types } from 'mongoose';
import { SystemClock } from '@/common/clock/clock.port';
import { MongoTarget, mongoTargetFrom } from '@/config/mongo-target';
import { AuditLog, AuditLogSchema } from '@/modules/audit/audit-log.schema';
import { Product, ProductDocument, ProductSchema } from '@/modules/products/product.schema';
import { importProposalFields, type ProposalFieldsImportReport } from '@/modules/products/proposal-fields-import';
import { PRUDENTIAL_PROPOSAL_IMPORT, PRUDENTIAL_PROPOSAL_ROWS } from '@/modules/products/proposal-fields-prudential';
import { Company, CompanySchema } from '@/modules/tenants/company.schema';

/**
 * **The Prudential proposal fields, imported into one company's catalogue** (P19.7-T1 AC-4; ADR-0225 §10). The operator
 * runs it for production, once the company exists, over IAP SSH:
 *
 *   sudo /opt/agencyboost/bin/import-proposal-fields.sh prod <company id or slug>
 *
 * which runs `node dist/cli/import-proposal-fields.js <company>` inside that environment's API container, with the
 * API's own database settings. The demo seed runs the same function (`importProposalFields`) on its Prudential company.
 *
 * - **Matched by code**; a row naming a code the company lacks is reported, and nothing is created.
 * - **Never over a Super Admin's edit**: a product whose fields are not empty and are no longer exactly this import's
 *   own is reported *skipped* and left alone.
 * - **Running it twice changes nothing**: the second run reports every product *unchanged*.
 * - Each write is a new product version, audited `product.updated` with `reason: 'proposal_fields_import'`, its actor
 *   the job's name.
 * - Plain mongoose, as `create-super-admin` is: booting the API's module would ask for its whole configuration.
 * - Exits `0` when it ran (whatever it wrote), `2` on a usage error and `1` on any other failure.
 */
export const USAGE = 'Usage: node dist/cli/import-proposal-fields.js <company id or slug>\n'
  + '       Writes the Prudential proposal fields draft of 3 November 2026 onto that company\'s products, by code.';

/** Who the audit rows name: a job, as `RequestContext.forJob` names one. */
export const IMPORT_ACTOR = `job:import-proposal-fields:${PRUDENTIAL_PROPOSAL_IMPORT}`;

const SERVER_SELECTION_TIMEOUT_MS = 10_000;

export class CliError extends Error {
  constructor(message: string, readonly exitCode = 1) {
    super(message);
  }
}

export function parseArgs(argv: readonly string[]): { company: string } {
  if (argv.some((arg) => arg === '--help' || arg === '-h')) throw new CliError(USAGE, 2);
  const unknown = argv.find((arg) => arg.startsWith('-'));
  if (unknown) throw new CliError(`Unknown option ${unknown}.\n${USAGE}`, 2);
  if (argv.length !== 1 || argv[0].trim() === '') throw new CliError(USAGE, 2);
  return { company: argv[0].trim() };
}

/** The report, one line per kind, the codes named. */
export function describeReport(companyName: string, report: ProposalFieldsImportReport): string {
  const line = (label: string, codes: string[]) => `  ${label} (${codes.length})${codes.length ? `: ${codes.join(', ')}` : ''}\n`;
  return `Proposal fields "${PRUDENTIAL_PROPOSAL_IMPORT}" for ${companyName}:\n`
    + line('written', report.written)
    + line('unchanged', report.unchanged)
    + line('skipped, edited since', report.skipped)
    + line('no such product', report.missing);
}

export interface Io {
  stdout: Writable;
  stderr: Writable;
  env: Readonly<Record<string, string | undefined>>;
}

export async function run(argv: readonly string[], io: Io): Promise<number> {
  let connection: mongoose.Connection | null = null;
  try {
    const { company } = parseArgs(argv);
    const target: MongoTarget | null = mongoTargetFrom(io.env);
    if (!target) throw new CliError('MONGODB_URI is not set. Run it where the API runs, with the API\'s environment.');
    io.stderr.write(`Connecting to database "${target.dbName}" on ${target.hosts}\n`);
    const selection = /[?&]serverSelectionTimeoutMS=/i.test(target.uri)
      ? {}
      : { serverSelectionTimeoutMS: SERVER_SELECTION_TIMEOUT_MS };
    connection = await mongoose.createConnection(target.uri, { dbName: target.dbName, ...selection }).asPromise();
    const companies = connection.model(Company.name, CompanySchema);
    const products = connection.model(Product.name, ProductSchema) as unknown as Model<ProductDocument>;
    const audit = connection.model(AuditLog.name, AuditLogSchema);

    const found = await companies.findOne({
      deletedAt: null,
      ...(Types.ObjectId.isValid(company) && company.length === 24 ? { _id: company } : { slug: company.toLowerCase() }),
    }).lean().exec() as { _id: unknown; name: string } | null;
    if (!found) throw new CliError(`No company "${company}". Give its id or its slug, as /admin/companies shows it.`);

    const report = await importProposalFields(
      {
        products,
        clock: new SystemClock(),
        audit: async (entry) => {
          await audit.create({
            ...entry, kpmId: null, actorUserId: IMPORT_ACTOR, effectiveUserId: IMPORT_ACTOR, actorMembershipId: null,
          });
        },
      },
      String(found._id),
      { name: PRUDENTIAL_PROPOSAL_IMPORT, rows: PRUDENTIAL_PROPOSAL_ROWS },
    );
    io.stdout.write(describeReport(found.name, report));
    return 0;
  } catch (err) {
    if (err instanceof CliError) {
      io.stderr.write(`${err.message}\n`);
      return err.exitCode;
    }
    io.stderr.write(`import-proposal-fields failed: ${err instanceof Error ? err.message : String(err)}\n`);
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
