import { Writable } from 'node:stream';
import mongoose from 'mongoose';
import { FixedClock } from '@/common/clock/clock.port';
import { BILLING_LAPSE_SUSPENSION_REASON } from '@/domain/constants';
import { AuditLog, AuditLogSchema } from '@/modules/audit/audit-log.schema';
import { AuditService } from '@/modules/audit/audit.service';
import { LAPSE_JOB, SubscriptionLapseService } from '@/modules/billing/subscription-lapse.service';
import { Kpm, KpmSchema } from '@/modules/tenants/kpm.schema';
import { clearCollections, startMongo, stopMongo } from '../../test/mongo';
import { describeReport, parseArgs, run, USAGE } from './subscription-lapses';

function capture(): Writable & { text: () => string } {
  const chunks: string[] = [];
  const stream = new Writable({ write(chunk, _e, done) { chunks.push(String(chunk)); done(); } });
  return Object.assign(stream, { text: () => chunks.join('') });
}

/** 00:10 in Jakarta on a given office day: the timer's moment. */
const at = (day: string) => new Date(`${day}T00:10:00+07:00`);
const END = '2026-11-01';

/**
 * **The automatic suspension** (P19.23-T5 AC-5; ADR-0279 §5): seven days after a period ends without renewal the KPM is
 * suspended. Day 0 is the end date, the last day the period serves; days 1 to 7 are the grace; on day 8 the run
 * suspends it — through the clock port, in the KPM's own zone.
 */
describe('P19.23-T5 AC-5 the subscription lapse', () => {
  let kpms: mongoose.Model<Kpm>;
  let audit: mongoose.Model<AuditLog>;
  let env: Record<string, string>;
  let seq = 0;

  beforeAll(async () => {
    const uri = await startMongo();
    env = { MONGODB_URI: uri, MONGODB_DB_NAME: mongoose.connection.db!.databaseName };
    kpms = mongoose.model(Kpm.name, KpmSchema) as never;
    audit = mongoose.model(AuditLog.name, AuditLogSchema) as never;
  });
  afterAll(stopMongo);
  beforeEach(clearCollections);

  const lapses = (day: string) => new SubscriptionLapseService(kpms as never, new AuditService(audit as never), new FixedClock(at(day)));

  async function office(over: Record<string, unknown> = {}, sub: Record<string, unknown> = {}) {
    seq += 1;
    return kpms.create({
      companyId: 'c1', code: `0${500 + seq}`, branchName: `Branch ${seq}`, timezone: 'Asia/Jakarta', status: 'active',
      subscription: {
        startDate: '2026-05-02', endDate: END, pricePerLeaderMinor: 40_000_000, currency: 'IDR', maxLeaders: 10,
        keepActiveAfterEnd: false, plan: 'six_months', ...sub,
      },
      ...over,
    });
  }
  const statusOf = async (id: unknown) => (await kpms.findById(id).lean())?.status;

  it('P19.23-T5 AC-5 day 0 (the end date) and day 7 suspend nobody', async () => {
    const kpm = await office();
    expect((await lapses('2026-11-01').run()).suspended).toEqual([]);
    expect((await lapses('2026-11-08').run()).suspended).toEqual([]);
    expect(await statusOf(kpm._id)).toBe('active');
  });

  it('P19.23-T5 AC-5 day 8 suspends it, with the lapse’s reason, audited by the job in the KPM’s log', async () => {
    const kpm = await office();
    const report = await lapses('2026-11-09').run();
    expect(report.suspended).toEqual([
      { kpmId: String(kpm._id), code: kpm.code, branch: kpm.branchName, endDate: END, graceEndedOn: '2026-11-08' },
    ]);
    const row = await kpms.findById(kpm._id).lean();
    expect(row).toMatchObject({ status: 'suspended', suspendedReason: BILLING_LAPSE_SUSPENSION_REASON });
    expect(row?.suspendedAt?.toISOString()).toBe(at('2026-11-09').toISOString());
    const [entry] = await audit.find({ action: 'kpm.suspended' }).lean();
    expect(entry).toMatchObject({
      kpmId: String(kpm._id), actorUserId: `job:${LAPSE_JOB}`, targetId: String(kpm._id),
      before: { status: 'active' },
      after: { status: 'suspended', reason: BILLING_LAPSE_SUSPENSION_REASON, endDate: END, graceEndedOn: '2026-11-08' },
    });
  });

  it('P19.23-T5 AC-5 reads the KPM’s own day: 23:59 on day 7 in Jakarta is not yet day 8, whatever the server’s zone', async () => {
    await office();
    const lateOnDaySeven = new SubscriptionLapseService(
      kpms as never, new AuditService(audit as never), new FixedClock(new Date('2026-11-08T16:59:00Z')),
    );
    expect((await lateOnDaySeven.run()).suspended).toEqual([]);
  });

  it('P19.23-T5 AC-5 a renewal stops it: an end date moved past today suspends nobody', async () => {
    const kpm = await office();
    await kpms.updateOne({ _id: kpm._id }, { $set: { 'subscription.endDate': '2027-05-01' } });
    expect((await lapses('2026-11-09').run()).suspended).toEqual([]);
    expect(await statusOf(kpm._id)).toBe('active');
  });

  it('P19.23-T5 AC-5 kept active, already suspended, archived, deleted or with no end: nobody is touched', async () => {
    await office({}, { keepActiveAfterEnd: true });
    await office({ status: 'suspended', suspendedReason: 'Tidak membayar' });
    await office({ status: 'archived' });
    await office({ deletedAt: new Date('2026-10-01T00:00:00Z') });
    await office({}, { startDate: null, endDate: null });
    await office({ subscription: null });
    expect((await lapses('2026-11-20').run()).suspended).toEqual([]);
    expect(await audit.countDocuments({})).toBe(0);
  });

  it('P19.23-T5 AC-5 an ended trial lapses like any period', async () => {
    const kpm = await office({}, { startDate: '2026-10-03', endDate: END, pricePerLeaderMinor: null, maxLeaders: null, plan: null, trial: true });
    expect((await lapses('2026-11-09').run()).suspended.map((k) => k.kpmId)).toEqual([String(kpm._id)]);
  });

  it('P19.23-T5 AC-5 is safe to repeat: a second run on the same day suspends nobody again', async () => {
    await office();
    expect((await lapses('2026-11-09').run()).suspended).toHaveLength(1);
    expect((await lapses('2026-11-09').run()).suspended).toHaveLength(0);
    expect(await audit.countDocuments({ action: 'kpm.suspended' })).toBe(1);
  });

  describe('the command', () => {
    it('P19.23-T5 AC-5 runs against the environment’s database and prints one line per KPM', async () => {
      const kpm = await office();
      const stdout = capture();
      const stderr = capture();
      const code = await run([], { stdout, stderr, env, clock: new FixedClock(at('2026-11-09')) });
      expect(code).toBe(0);
      expect(stdout.text()).toBe(
        `Subscription lapses: 1 KPM(s) checked, 1 suspended\n  KPM ${kpm.code} · ${kpm.branchName}: ended ${END}, grace ended 2026-11-08\n`,
      );
      expect(await statusOf(kpm._id)).toBe('suspended');
    });

    it('P19.23-T5 AC-5 --today names the day for every KPM', async () => {
      await office();
      const stdout = capture();
      expect(await run(['--today', '2026-11-08'], { stdout, stderr: capture(), env, clock: new FixedClock(at('2026-12-01')) })).toBe(0);
      expect(stdout.text()).toBe('Subscription lapses for 2026-11-08: 1 KPM(s) checked, 0 suspended\n');
    });

    it('P19.23-T5 AC-5 usage errors exit 2; no database settings exit 1', async () => {
      expect(() => parseArgs(['--today', '2026-02-30'])).toThrow(/--today needs a day/);
      expect(() => parseArgs(['--now'])).toThrow(/Unknown argument/);
      const stderr = capture();
      expect(await run(['--help'], { stdout: capture(), stderr, env })).toBe(2);
      expect(stderr.text()).toContain(USAGE);
      expect(await run([], { stdout: capture(), stderr: capture(), env: {} })).toBe(1);
    });

    it('describes an empty run in one line', () => {
      expect(describeReport({ today: null, checked: 0, suspended: [] })).toBe('Subscription lapses: 0 KPM(s) checked, 0 suspended\n');
    });
  });
});
