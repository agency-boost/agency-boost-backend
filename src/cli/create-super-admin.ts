import { inSource } from '@/common/i18n/sentence';
import 'reflect-metadata';
import type { Readable, Writable } from 'node:stream';
import { isEmail } from 'class-validator';
import mongoose, { Model } from 'mongoose';
import { Clock, SystemClock } from '@/common/clock/clock.port';
import { MongoTarget, mongoTargetFrom } from '@/config/mongo-target';
import { PasswordService } from '@/modules/auth/password.service';
import { User, UserDocument, UserSchema } from '@/modules/users/user.schema';

/**
 * **The first Super Admin, on a database that has none** (P18.7-T1, ADR-0152).
 *
 * Production starts dark (plan decision D11): no tenant, no seed, and so nobody who can sign in to the
 * console and provision an office. Registration makes agents, never a Super Admin, and the demo seed's two
 * operators are refused there. This is the one way in, run once over SSH on the VM:
 *
 *   node dist/cli/create-super-admin.js <email> [--name "<full name>"]
 *
 * - **The password comes from standard input**, never from an argument, which would sit in the shell's
 *   history and in `ps`. At a terminal it is asked twice and not echoed; piped in, the first line is it.
 *   It is never printed or logged.
 * - **The app's own rules and hashing**: `PasswordService.validate` and its Argon2id `hash`, and the
 *   users schema itself, so the account is the one the seed and the API make. Plain mongoose rather than
 *   a Nest application context: these two are all it needs, and booting the API's module would ask for
 *   its whole configuration (JWT secrets, SMTP, storage) to create one row.
 * - **Refused when a Super Admin exists**, deactivated or not; only an erased one (`deletedAt`) does not
 *   count. After the first, the console is how anybody else is made one.
 * - Exits `0` when it created the account, `2` on a usage error and `1` on any other failure.
 */
export const USAGE = 'Usage: node dist/cli/create-super-admin.js <email> [--name "<full name>"]\n'
  + '       The password is read from standard input: typed at the prompt, or piped in as one line.';

/** The name the account carries unless `--name` gives one: the seed's operator is called this too. */
export const DEFAULT_FULL_NAME = 'Platform Operator';

/** How long to look for the database before giving up: a CLI that hangs for the driver's 30 s looks dead. */
const SERVER_SELECTION_TIMEOUT_MS = 10_000;

/** A failure the person running the command can act on: printed as it is, with no stack. */
export class CliError extends Error {
  constructor(message: string, readonly exitCode = 1) {
    super(message);
  }
}

export interface CreateSuperAdminArgs {
  email: string;
  fullName: string;
}

/** The arguments after `node` and the script. */
export function parseArgs(argv: readonly string[]): CreateSuperAdminArgs {
  const positional: string[] = [];
  let fullName = DEFAULT_FULL_NAME;
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--name') {
      const value = argv[i + 1]?.trim();
      if (!value) throw new CliError(`--name needs a value.\n${USAGE}`, 2);
      fullName = value;
      i += 1;
    } else if (arg === '--help' || arg === '-h') {
      throw new CliError(USAGE, 2);
    } else if (arg.startsWith('-')) {
      throw new CliError(`Unknown option ${arg}.\n${USAGE}`, 2);
    } else {
      positional.push(arg);
    }
  }
  if (positional.length !== 1) throw new CliError(USAGE, 2);
  return { email: positional[0], fullName };
}

export interface Dependencies {
  users: Model<UserDocument>;
  passwords: PasswordService;
  clock: Clock;
}

/** Whether a Super Admin who has not been erased exists. Deactivated counts: reactivating is the console's. */
export async function superAdminExists(users: Model<UserDocument>): Promise<boolean> {
  return (await users.exists({ platformRole: 'super_admin', deletedAt: null }).exec()) !== null;
}

/** The address as the users schema stores it, or a `CliError` when it is not one. */
export function normalizeEmail(raw: string): string {
  const email = raw.trim().toLowerCase();
  if (!isEmail(email)) throw new CliError(`"${raw}" is not an email address.`);
  return email;
}

/** Refused when a Super Admin exists, or when the address already has an account, which this never promotes. */
async function refuseIfTaken(users: Model<UserDocument>, email: string): Promise<void> {
  if (await superAdminExists(users)) {
    throw new CliError('A Super Admin already exists. Nothing was created: sign in as them, and make others from the console.');
  }
  // Any row, erased ones included: the unique index on `email` covers every row.
  if ((await users.exists({ email }).exec()) !== null) {
    throw new CliError(`An account with ${email} already exists. Choose another address; this command does not promote one.`);
  }
}

/**
 * **Create the account**, shaped exactly as the seed shapes its operator: verified, active, a Super Admin who
 * sells for nobody (`companyId` and `agentCode` null, the pair the unique index excludes), with the password
 * hashed by the API's own service. Every refusal is a `CliError` naming what to do instead.
 */
export async function createSuperAdmin(
  input: CreateSuperAdminArgs & { password: string },
  { users, passwords, clock }: Dependencies,
): Promise<{ id: string; email: string }> {
  const email = normalizeEmail(input.email);

  const problems = passwords.validate(input.password);
  // An operator's console, in English: the policy's sentences as the API writes them in English (`inSource`).
  if (problems.length > 0) throw new CliError(`The password was refused. ${problems.map(inSource).join(' ')}`);

  /*
   * Checked again just before the insert, as well as before the prompt. **Two runs at the same moment with
   * different addresses can still both pass and both insert: an accepted risk** (the review's L5). This is a
   * manual command one operator runs once, over SSH, on a database with nobody else in it yet; a sentinel
   * collection to make it atomic would cost more than the case it covers. The unique index on `email` does
   * stop two runs with the same address.
   */
  await refuseIfTaken(users, email);

  const created = await users.create({
    email,
    passwordHash: await passwords.hash(input.password),
    fullName: input.fullName.trim(),
    platformRole: 'super_admin',
    companyId: null,
    agentCode: null,
    status: 'active',
    emailVerifiedAt: clock.now(),
  });
  return { id: String(created._id), email };
}

/** Standard input as the password reader sees it; `process.stdin` is one. */
export interface PasswordInput extends Readable {
  isTTY?: boolean;
  setRawMode?: (mode: boolean) => unknown;
}

/**
 * **The password, from standard input.** At a terminal: asked twice, nothing echoed, and the two must
 * match, because a typo nobody can see would lock the only operator out. Piped: the first line.
 */
export async function readPassword(input: PasswordInput, prompts: Writable): Promise<string> {
  if (input.isTTY && input.setRawMode) {
    const first = await readHidden('Password: ', input, prompts);
    const again = await readHidden('Repeat it: ', input, prompts);
    if (first !== again) throw new CliError('The two passwords differ. Nothing was created.');
    return first;
  }
  let data = '';
  input.setEncoding('utf8');
  for await (const chunk of input) data += chunk as string;
  const [line] = data.split(/\r?\n/, 1);
  if (line === '') {
    throw new CliError('No password on standard input. Run it at a terminal to be asked, or pipe the password in as one line.');
  }
  return line;
}

/** One line typed at a terminal in raw mode, so nothing is echoed. Ctrl-C, or Ctrl-D on an empty line, cancels. */
function readHidden(prompt: string, input: PasswordInput, prompts: Writable): Promise<string> {
  prompts.write(prompt);
  input.setRawMode?.(true);
  input.setEncoding('utf8');
  input.resume();
  return new Promise((resolve, reject) => {
    let value = '';
    const finish = () => {
      input.off('data', onData);
      input.off('end', onEnd);
      input.off('error', onError);
      input.setRawMode?.(false);
      input.pause();
      prompts.write('\n');
    };
    // The terminal went away (the SSH session dropped, stdin was closed): stop rather than wait for ever.
    const onEnd = () => {
      finish();
      reject(new CliError('Standard input closed before a password was entered. Nothing was created.'));
    };
    const onError = (err: Error) => {
      finish();
      reject(new CliError(`Standard input failed (${err.message}). Nothing was created.`));
    };
    const onData = (chunk: string) => {
      for (const ch of chunk) {
        if (ch === '\r' || ch === '\n') {
          finish();
          resolve(value);
          return;
        }
        if (ch === '\u0003' || (ch === '\u0004' && value === '')) {
          finish();
          reject(new CliError('Cancelled. Nothing was created.'));
          return;
        }
        if (ch === '\u007f' || ch === '\b') {
          value = [...value].slice(0, -1).join('');
        } else if (ch !== '\u0004') {
          value += ch;
        }
      }
    };
    input.on('data', onData);
    input.on('end', onEnd);
    input.on('error', onError);
  });
}

export interface Io {
  stdin: PasswordInput;
  stdout: Writable;
  stderr: Writable;
  env: Readonly<Record<string, string | undefined>>;
}

/**
 * The command, start to finish; resolves to its exit code. The address, and the database's Super Admin
 * and accounts, are checked **before** the password is asked for, so nobody types one for a run that was
 * always going to refuse.
 */
export async function run(argv: readonly string[], io: Io): Promise<number> {
  let connection: mongoose.Connection | null = null;
  try {
    const args = parseArgs(argv);
    const email = normalizeEmail(args.email);
    const target: MongoTarget | null = mongoTargetFrom(io.env);
    if (!target) throw new CliError('MONGODB_URI is not set. Run it where the API runs, with the API\'s environment.');

    io.stderr.write(`Connecting to database "${target.dbName}" on ${target.hosts}\n`);
    // A timeout written in the URI wins: the driver lets the options object override the URI's.
    const selection = /[?&]serverSelectionTimeoutMS=/i.test(target.uri)
      ? {}
      : { serverSelectionTimeoutMS: SERVER_SELECTION_TIMEOUT_MS };
    connection = await mongoose.createConnection(target.uri, { dbName: target.dbName, ...selection }).asPromise();
    // Typed as the API's injected model is; mongoose infers nothing useful from a Nest-built schema.
    const users = connection.model(User.name, UserSchema) as unknown as Model<UserDocument>;
    // The unique index on `email` exists before the insert, as it would once the API had booted.
    await users.init();

    await refuseIfTaken(users, email);

    const password = await readPassword(io.stdin, io.stderr);
    const created = await createSuperAdmin({ ...args, email, password }, { users, passwords: new PasswordService(), clock: new SystemClock() });
    io.stdout.write(`Created the Super Admin ${created.email} (${created.id}). Sign in with that address and the password you gave.\n`);
    return 0;
  } catch (err) {
    if (err instanceof CliError) {
      io.stderr.write(`${err.message}\n`);
      return err.exitCode;
    }
    io.stderr.write(`create-super-admin failed: ${err instanceof Error ? err.message : String(err)}\n`);
    return 1;
  } finally {
    await connection?.close().catch(() => undefined);
  }
}

// Run as the command, never on import: the spec imports `run` and drives it itself.
if (require.main === module) {
  void run(process.argv.slice(2), { stdin: process.stdin, stdout: process.stdout, stderr: process.stderr, env: process.env })
    .then((code) => process.exit(code));
}
