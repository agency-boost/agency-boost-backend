import { Writable } from 'node:stream';
import mongoose from 'mongoose';
import { FixedClock } from '@/common/clock/clock.port';
import { clearCollections, startMongo, stopMongo } from '../../test/mongo';
import { describeReport, parseArgs, run, USAGE } from './daily-notices';

/** 12 Nov 2026, 00:10 in Jakarta: the timer's moment. */
const NOW = new Date('2026-11-11T17:10:00Z');
const TODAY = '2026-11-12';
const COMPANY = '66f0000000000000000000c1';
const OTHER_COMPANY = '66f0000000000000000000c2';
const ROOT = '66f0000000000000000000e1';
const ROOT_2 = '66f0000000000000000000e2';
const ROOT_GONE = '66f0000000000000000000e3';
const OWNER = '66f0000000000000000000e4';
const OWNER_SUSPENDED = '66f0000000000000000000e5';
const OWNER_OTHER = '66f0000000000000000000e6';
const KPM = '66f0000000000000000000a1';
const KPM_SUSPENDED = '66f0000000000000000000a2';
const KPM_OTHER = '66f0000000000000000000a3';
const PCB88 = '66f0000000000000000000d1';
const PRUWELL = '66f0000000000000000000d2';
const PRULINK = '66f0000000000000000000d3';
const PRUCINTA = '66f0000000000000000000d4';

function capture(): Writable & { text: () => string } {
  const chunks: string[] = [];
  const stream = new Writable({ write(chunk, _e, done) { chunks.push(String(chunk)); done(); } });
  return Object.assign(stream, { text: () => chunks.join('') });
}

const oid = (id: string) => new mongoose.Types.ObjectId(id);

/** A version as D1's upload writes it, with the fields the run reads; `over` names the rest. */
function version(id: string, productId: string, over: Record<string, unknown>) {
  return {
    _id: oid(id), companyId: COMPANY, productId, version: 1, effectiveFrom: '2026-01-01', effectiveTo: null,
    activatedAt: new Date('2025-12-20T03:00:00Z'), activatedBy: ROOT, turnedOffAt: null, turnedOffBy: null,
    expiryNoticeSentAt: null, activationNoticeSentAt: new Date('2026-01-01T00:00:00Z'), deletedAt: null, ...over,
  };
}

/**
 * **P19.15-T4 AC-4 — the daily run** (ADR-0261; the P1b spec's *Notifications*): the operator's command against the
 * in-memory database the way the VM runs it — its own connection, the environment it is given, the office day in
 * Jakarta. Fifteen days before a table in force ends with nothing scheduled, every Super Admin is told; a version come
 * into force is announced to the KPM Owners of its company's active KPMs; each once, whatever runs again.
 */
describe('P19.15-T4 daily-notices', () => {
  let env: Record<string, string>;
  const db = () => mongoose.connection.db!;
  const inbox = (userId: string) => db().collection('notifications').find({ userId }).toArray();

  beforeAll(async () => {
    const uri = await startMongo();
    env = { MONGODB_URI: uri, MONGODB_DB_NAME: mongoose.connection.db!.databaseName };
  });
  afterAll(stopMongo);
  beforeEach(async () => {
    await clearCollections();
    // Written below through the driver, so emptied through it too: no model of this connection names them.
    for (const name of ['companies', 'products', 'users', 'kpms', 'rateTables', 'notifications', 'notificationPreferences']) {
      await db().collection(name).deleteMany({});
    }
    await db().collection('companies').insertMany([
      { _id: oid(COMPANY), name: 'Prudential', slug: 'prudential', kind: 'insurer', deletedAt: null },
      { _id: oid(OTHER_COMPANY), name: 'Manulife', slug: 'manulife', kind: 'insurer', deletedAt: null },
    ]);
    await db().collection('products').insertMany([
      { _id: oid(PCB88), companyId: COMPANY, code: 'PRUCRITICAL_BENEFIT_88', name: 'PRUCritical Benefit 88', deletedAt: null },
      { _id: oid(PRUWELL), companyId: COMPANY, code: 'PRUWELL_MEDICAL', name: 'PRUWell Medical', deletedAt: null },
      { _id: oid(PRULINK), companyId: COMPANY, code: 'PRULINK', name: 'PRULink NextGen', deletedAt: null },
      { _id: oid(PRUCINTA), companyId: COMPANY, code: 'PRUCINTA', name: 'PRUCinta', deletedAt: null },
    ]);
    await db().collection('users').insertMany([
      { _id: oid(ROOT), fullName: 'Root', email: 'root@x.id', platformRole: 'super_admin', status: 'active', deletedAt: null },
      { _id: oid(ROOT_2), fullName: 'Root Two', email: 'root2@x.id', platformRole: 'super_admin', status: 'active', deletedAt: null },
      { _id: oid(ROOT_GONE), fullName: 'Gone', email: 'gone@x.id', platformRole: 'super_admin', status: 'deactivated', deletedAt: null },
      { _id: oid(OWNER), fullName: 'Owner', email: 'o@x.id', platformRole: 'none', status: 'active', deletedAt: null },
      { _id: oid(OWNER_SUSPENDED), fullName: 'Owner S', email: 's@x.id', platformRole: 'none', status: 'active', deletedAt: null },
      { _id: oid(OWNER_OTHER), fullName: 'Owner M', email: 'm@x.id', platformRole: 'none', status: 'active', deletedAt: null },
    ]);
    await db().collection('kpms').insertMany([
      { _id: oid(KPM), code: '0417', branchName: 'Bandung', companyId: COMPANY, status: 'active', ownerUserId: OWNER, deletedAt: null },
      { _id: oid(KPM_SUSPENDED), code: '0418', branchName: 'Bogor', companyId: COMPANY, status: 'suspended', ownerUserId: OWNER_SUSPENDED, deletedAt: null },
      { _id: oid(KPM_OTHER), code: '0900', branchName: 'Medan', companyId: OTHER_COMPANY, status: 'active', ownerUserId: OWNER_OTHER, deletedAt: null },
    ]);
    await db().collection('rateTables').insertMany([
      // PCB88: in force, ends in exactly 15 days, nothing after it — the Super Admins are told.
      version('66f0000000000000000000f1', PCB88, { effectiveTo: '2026-11-27' }),
      // PRUWell: ends in 8 days, but its next version is scheduled — nobody is told.
      version('66f0000000000000000000f2', PRUWELL, { effectiveTo: '2026-11-20' }),
      version('66f0000000000000000000f3', PRUWELL, {
        version: 2, effectiveFrom: '2026-11-21', activationNoticeSentAt: null, activatedAt: new Date('2026-11-10T03:00:00Z'),
      }),
      // PRULink: version 2 comes into force today — the Owners are told; version 1 is superseded.
      version('66f0000000000000000000f4', PRULINK, {}),
      version('66f0000000000000000000f5', PRULINK, {
        version: 2, effectiveFrom: TODAY, activationNoticeSentAt: null, activatedAt: new Date('2026-11-01T03:00:00Z'),
      }),
      // PRUCinta: ends in 16 days (outside), a turned-off version and a draft starting today — nobody is told.
      version('66f0000000000000000000f6', PRUCINTA, { effectiveTo: '2026-11-28' }),
      version('66f0000000000000000000f7', PRUCINTA, {
        version: 2, effectiveFrom: '2026-11-10', activationNoticeSentAt: null, turnedOffAt: new Date('2026-11-11T03:00:00Z'),
      }),
      version('66f0000000000000000000f8', PRUCINTA, { version: 3, effectiveFrom: TODAY, activationNoticeSentAt: null, activatedAt: null }),
    ]);
  });

  const io = () => {
    const out = capture();
    const err = capture();
    return { stdout: out, stderr: err, env, clock: new FixedClock(NOW), out, err };
  };

  it('P19.15-T4 AC-4 tells every active Super Admin of the table ending in 15 days with nothing scheduled, in their own inbox', async () => {
    const call = io();
    expect(await run([], call)).toBe(0);
    expect(call.out.text()).toContain(`Premium table notices for ${TODAY} (Asia/Jakarta)`);
    expect(call.out.text()).toContain('ending, to Super Admins: 1 table version(s), 2 notice(s)');

    for (const admin of [ROOT, ROOT_2]) {
      const rows = await inbox(admin);
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        kpmId: null, templateId: 'premium_table.ending', readAt: null,
        payload: {
          productName: 'PRUCritical Benefit 88', companyId: COMPANY, companyName: 'Prudential', effectiveTo: '2026-11-27',
          version: 1,
        },
        delivery: { in_app: { status: 'sent' } },
      });
    }
    expect(await inbox(ROOT_GONE)).toHaveLength(0);
    const table = await db().collection('rateTables').findOne({ _id: oid('66f0000000000000000000f1') });
    expect(table!.expiryNoticeSentAt).toEqual(NOW);
    // Not the version with a successor scheduled.
    expect((await db().collection('rateTables').findOne({ _id: oid('66f0000000000000000000f2') }))!.expiryNoticeSentAt).toBeNull();
  });

  it('P19.15-T4 AC-4 announces the version come into force today to the KPM Owner of each active KPM of its company', async () => {
    const call = io();
    expect(await run([], call)).toBe(0);
    expect(call.out.text()).toContain('started, to KPM Owners: 1 table version(s), 1 notice(s)');
    const rows = await inbox(OWNER);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      kpmId: KPM, templateId: 'premium_table.started',
      payload: { productName: 'PRULink NextGen', effectiveFrom: TODAY, companyName: 'Prudential', version: 2 },
    });
    // A suspended KPM's Owner, and another company's, are not told.
    expect(await inbox(OWNER_SUSPENDED)).toHaveLength(0);
    expect(await inbox(OWNER_OTHER)).toHaveLength(0);
    // Not a turned-off version, not a draft, not a version scheduled for later.
    for (const id of ['66f0000000000000000000f3', '66f0000000000000000000f7', '66f0000000000000000000f8']) {
      expect((await db().collection('rateTables').findOne({ _id: oid(id) }))!.activationNoticeSentAt).toBeNull();
    }
  });

  it('P19.15-T4 AC-4 a second run the same day tells nobody again', async () => {
    expect(await run([], io())).toBe(0);
    const again = io();
    expect(await run([], again)).toBe(0);
    expect(again.out.text()).toContain('ending, to Super Admins: 0 table version(s), 0 notice(s)');
    expect(again.out.text()).toContain('started, to KPM Owners: 0 table version(s), 0 notice(s)');
    expect(await db().collection('notifications').countDocuments()).toBe(3);
  });

  it('P19.15-T4 AC-4 the scheduled version is announced on the day it comes into force, not before', async () => {
    const before = io();
    expect(await run(['--today', '2026-11-20'], before)).toBe(0);
    expect(await db().collection('notifications').countDocuments({ templateId: 'premium_table.started', 'payload.productName': 'PRUWell Medical' }))
      .toBe(0);
    expect(await run(['--today', '2026-11-21'], io())).toBe(0);
    expect(await db().collection('notifications').countDocuments({ templateId: 'premium_table.started', 'payload.productName': 'PRUWell Medical' }))
      .toBe(1);
  });

  it('P19.15-T4 AC-4 a muted template writes nothing for that person, as everywhere', async () => {
    await db().collection('notificationPreferences').insertOne({ userId: ROOT_2, mutedTemplates: ['premium_table.ending'] });
    expect(await run([], io())).toBe(0);
    expect(await inbox(ROOT)).toHaveLength(1);
    expect(await inbox(ROOT_2)).toHaveLength(0);
  });

  it('refuses a day that is not one, an unknown argument, and runs nowhere without a database', async () => {
    expect(() => parseArgs(['--today', '2026-02-30'])).toThrow('--today needs a day');
    expect(() => parseArgs(['--today'])).toThrow('--today needs a day');
    expect(() => parseArgs(['--now'])).toThrow('Unknown argument --now');
    expect(parseArgs(['--today', '2026-11-12'])).toEqual({ today: '2026-11-12' });
    expect(parseArgs([])).toEqual({ today: null });
    const help = io();
    expect(await run(['--help'], help)).toBe(2);
    expect(help.err.text()).toContain(USAGE);
    const nowhere = { ...io(), env: {} };
    expect(await run([], nowhere)).toBe(1);
    expect(nowhere.err.text()).toContain('MONGODB_URI is not set');
  });

  it('says what it did in one line per notice', () => {
    expect(describeReport({ today: TODAY, ending: { tables: 2, recipients: 4 }, started: { tables: 0, recipients: 0 } }))
      .toBe(`Premium table notices for ${TODAY} (Asia/Jakarta):\n`
        + '  ending, to Super Admins: 2 table version(s), 4 notice(s)\n'
        + '  started, to KPM Owners: 0 table version(s), 0 notice(s)\n');
  });
});
