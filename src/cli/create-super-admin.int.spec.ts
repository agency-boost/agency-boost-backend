import { PassThrough, Readable, Writable } from 'node:stream';
import mongoose from 'mongoose';
import { FixedClock } from '@/common/clock/clock.port';
import { PasswordService } from '@/modules/auth/password.service';
import { User, UserSchema } from '@/modules/users/user.schema';
import { startMongo, stopMongo } from '../../test/mongo';
import {
  CliError, createSuperAdmin, DEFAULT_FULL_NAME, Io, parseArgs, PasswordInput, readPassword, run, USAGE,
} from './create-super-admin';

const PASSWORD = 'correct horse battery staple';

/** A stream that keeps what was written to it. */
function capture(): Writable & { text: () => string } {
  const chunks: string[] = [];
  const stream = new Writable({
    write(chunk, _encoding, done) {
      chunks.push(String(chunk));
      done();
    },
  });
  return Object.assign(stream, { text: () => chunks.join('') });
}

/** A terminal: raw mode recorded, keystrokes pushed by the test. */
function terminal(): PassThrough & PasswordInput & { raw: boolean[] } {
  const tty = Object.assign(new PassThrough(), { isTTY: true, raw: [] as boolean[] });
  return Object.assign(tty, { setRawMode: (mode: boolean) => tty.raw.push(mode) });
}

/**
 * **The first Super Admin, made from the command line** (P18.7-T1), against the in-memory database the
 * way the VM runs it: `run()` with its own connection, the environment it is given, and the password on
 * standard input.
 */
describe('create-super-admin (P18.7-T1)', () => {
  let env: Record<string, string>;
  const users = () => mongoose.connection.db!.collection('users');

  function io(stdin: PasswordInput = Readable.from([`${PASSWORD}\n`])): Io & { out: ReturnType<typeof capture>; err: ReturnType<typeof capture> } {
    const out = capture();
    const err = capture();
    return { stdin, stdout: out, stderr: err, env, out, err };
  }

  beforeAll(async () => {
    const uri = await startMongo();
    env = { MONGODB_URI: uri, MONGODB_DB_NAME: mongoose.connection.db!.databaseName };
  });
  afterAll(stopMongo);
  beforeEach(async () => {
    await users().deleteMany({});
  });

  it('P18.7-T1 creates a verified, active Super Admin who sells for nobody, with the password hashed', async () => {
    const call = io();
    expect(await run(['Ops@AgencyBoost.id', '--name', 'Rina Operator'], call)).toBe(0);

    const rows = await users().find({}).toArray();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      email: 'ops@agencyboost.id',
      fullName: 'Rina Operator',
      platformRole: 'super_admin',
      status: 'active',
      companyId: null,
      agentCode: null,
      mustChangePassword: false,
      deletedAt: null,
    });
    expect(rows[0].emailVerifiedAt).toBeInstanceOf(Date);

    // Argon2id, by the API's own service: the password signs in, and is stored nowhere as itself.
    expect(rows[0].passwordHash).toMatch(/^\$argon2id\$/);
    expect(rows[0].passwordHash).not.toContain(PASSWORD);
    await expect(new PasswordService().verify(rows[0].passwordHash, PASSWORD)).resolves.toBe(true);

    expect(call.out.text()).toContain('Created the Super Admin ops@agencyboost.id');
    expect(call.out.text() + call.err.text()).not.toContain(PASSWORD);
    // It says where it is writing, and nothing of the credentials in the URI.
    expect(call.err.text()).toContain(`Connecting to database "${env.MONGODB_DB_NAME}"`);
  });

  it('P18.7-T1 refuses a second run, before asking for a password, and creates nothing', async () => {
    expect(await run(['first@agencyboost.id'], io())).toBe(0);

    const stdin = terminal(); // nobody types: a prompt here would hang the test
    const second = io(stdin);
    expect(await run(['second@agencyboost.id'], second)).toBe(1);
    expect(second.err.text()).toContain('A Super Admin already exists. Nothing was created');
    expect(second.err.text()).not.toContain('Password:');
    expect(await users().countDocuments({ platformRole: 'super_admin' })).toBe(1);
  });

  it('P18.7-T1 checks again as it creates: a Super Admin made since the first check still stops it', async () => {
    // The race `run` cannot see: another operator's run landing between its check and the insert.
    await users().insertOne({ email: 'raced@agencyboost.id', platformRole: 'super_admin', status: 'active', deletedAt: null });
    const create = createSuperAdmin(
      { email: 'ops@agencyboost.id', fullName: DEFAULT_FULL_NAME, password: PASSWORD },
      { users: mongoose.model(User.name, UserSchema) as never, passwords: new PasswordService(), clock: new FixedClock(new Date('2026-10-19T03:00:00Z')) },
    );
    await expect(create).rejects.toThrow('A Super Admin already exists.');
    expect(await users().countDocuments({})).toBe(1);
  });

  it('P18.7-T1 counts a deactivated Super Admin, and not an erased one', async () => {
    await users().insertOne({ email: 'old@agencyboost.id', platformRole: 'super_admin', status: 'deactivated', deletedAt: null });
    expect(await run(['new@agencyboost.id'], io())).toBe(1);

    await users().updateOne({ email: 'old@agencyboost.id' }, { $set: { deletedAt: new Date() } });
    expect(await run(['new@agencyboost.id'], io())).toBe(0);
    expect(await users().countDocuments({ platformRole: 'super_admin', deletedAt: null })).toBe(1);
  });

  it('P18.7-T1 refuses an address that already has an account rather than promoting it, before the prompt', async () => {
    await users().insertOne({ email: 'agent@kpm0417.test', platformRole: 'none', deletedAt: null });
    const call = io(terminal()); // nobody types: a prompt here would hang the test
    expect(await run(['Agent@KPM0417.test'], call)).toBe(1);
    expect(call.err.text()).toContain('An account with agent@kpm0417.test already exists');
    expect(call.err.text()).not.toContain('Password:');
    expect(await users().findOne({ email: 'agent@kpm0417.test' })).toMatchObject({ platformRole: 'none' });
  });

  it('P18.7-T1 applies the app\'s password rules, without printing the password', async () => {
    // Seven characters: one under `PASSWORD.MIN_LENGTH`.
    const call = io(Readable.from(['tooshrt\n']));
    expect(await run(['ops@agencyboost.id'], call)).toBe(1);
    expect(call.err.text()).toContain('Password must be at least 8 characters.');
    expect(call.err.text()).not.toContain('tooshrt');
    expect(await users().countDocuments({})).toBe(0);
  });

  it('P18.7-T1 refuses an empty standard input, and an address that is not one', async () => {
    const empty = io(Readable.from([]));
    expect(await run(['ops@agencyboost.id'], empty)).toBe(1);
    expect(empty.err.text()).toContain('No password on standard input');

    // The address is checked first: before connecting, and before any password is asked for.
    const notAnEmail = io(terminal());
    expect(await run(['ops-at-agencyboost'], notAnEmail)).toBe(1);
    expect(notAnEmail.err.text()).toBe('"ops-at-agencyboost" is not an email address.\n');
    expect(await users().countDocuments({})).toBe(0);
  });

  it('P18.7-T1 stops, rather than waiting for ever, when the terminal\'s input closes or fails', async () => {
    const closed = terminal();
    const call = io(closed);
    const done = run(['ops@agencyboost.id'], call);
    while (!call.err.text().includes('Password: ')) await new Promise((resolve) => setTimeout(resolve, 5));
    closed.end(); // the SSH session dropped
    expect(await done).toBe(1);
    expect(call.err.text()).toContain('Standard input closed before a password was entered. Nothing was created.');
    expect(closed.raw).toEqual([true, false]);

    const failing = terminal();
    const asked = readPassword(failing, capture());
    failing.destroy(new Error('EIO'));
    await expect(asked).rejects.toThrow('Standard input failed (EIO). Nothing was created.');
    expect(await users().countDocuments({})).toBe(0);
  });

  it('P18.7-T1 exits non-zero without MONGODB_URI, saying so', async () => {
    const call = { ...io(), env: {} };
    expect(await run(['ops@agencyboost.id'], call)).toBe(1);
    expect(call.err.text()).toContain('MONGODB_URI is not set');
  });

  it('P18.7-T1 exits non-zero when the database cannot be reached', async () => {
    const call = { ...io(), env: { MONGODB_URI: 'mongodb://127.0.0.1:1/?serverSelectionTimeoutMS=200' } };
    expect(await run(['ops@agencyboost.id'], call)).toBe(1);
    expect(call.err.text()).toContain('create-super-admin failed:');
  });

  it('P18.7-T1 reads the password at a terminal twice, echoing none of it', async () => {
    const stdin = terminal();
    const call = io(stdin);
    const done = run(['ops@agencyboost.id'], call);
    // Typed: a slip and a backspace, then Enter; then the confirmation.
    const typeWhenAsked = async (prompt: string, keys: string) => {
      while (!call.err.text().includes(prompt)) await new Promise((resolve) => setTimeout(resolve, 5));
      stdin.write(keys);
    };
    await typeWhenAsked('Password: ', `${PASSWORD}x\u007f\r`);
    await typeWhenAsked('Repeat it: ', `${PASSWORD}\r`);

    expect(await done).toBe(0);
    expect(call.err.text()).not.toContain(PASSWORD);
    expect(stdin.raw).toEqual([true, false, true, false]);
    const [row] = await users().find({}).toArray();
    await expect(new PasswordService().verify(row.passwordHash, PASSWORD)).resolves.toBe(true);
  });

  it('P18.7-T1 refuses two passwords that differ, and stops on Ctrl-C', async () => {
    const differ = terminal();
    const asked = readPassword(differ, capture());
    differ.write(`${PASSWORD}\r`);
    await new Promise((resolve) => setTimeout(resolve, 5));
    differ.write('another password\r');
    await expect(asked).rejects.toThrow('The two passwords differ. Nothing was created.');

    const cancelled = terminal();
    const stopped = readPassword(cancelled, capture());
    cancelled.write('half typ\u0003');
    await expect(stopped).rejects.toThrow('Cancelled. Nothing was created.');

    const ended = terminal();
    const eof = readPassword(ended, capture());
    ended.write('\u0004');
    await expect(eof).rejects.toThrow('Cancelled.');
  });

  describe('its arguments', () => {
    it('P18.7-T1 takes one email, and a name with --name', () => {
      expect(parseArgs(['ops@agencyboost.id'])).toEqual({ email: 'ops@agencyboost.id', fullName: DEFAULT_FULL_NAME });
      expect(parseArgs(['--name', ' Rina ', 'ops@agencyboost.id'])).toEqual({ email: 'ops@agencyboost.id', fullName: 'Rina' });
    });

    it.each([[[]], [['a@x.id', 'b@x.id']], [['--name']], [['a@x.id', '--name', ' ']], [['--password', 'x', 'a@x.id']], [['--help']]])(
      'P18.7-T1 refuses %j with the usage, exit code 2',
      (argv) => {
        let thrown: unknown;
        try {
          parseArgs(argv);
        } catch (err) {
          thrown = err;
        }
        expect(thrown).toBeInstanceOf(CliError);
        expect((thrown as CliError).exitCode).toBe(2);
        expect((thrown as CliError).message).toContain(USAGE);
      },
    );

    it('P18.7-T1 a usage error exits 2 through run, before connecting anywhere', async () => {
      const call = io();
      expect(await run([], call)).toBe(2);
      expect(call.err.text()).toContain('Usage: node dist/cli/create-super-admin.js <email>');
      expect(call.err.text()).not.toContain('Connecting');
    });
  });
});
