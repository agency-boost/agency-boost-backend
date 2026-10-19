import mongoose from 'mongoose';
import { FixedClock } from '@/common/clock/clock.port';
import { clearCollections, startMongo, stopMongo } from '../../test/mongo';
import { seedDemo } from '../seed/demo';
import { up } from './0022-activation-backfill';

const NOW = new Date('2026-09-14T23:30:00Z'); // the 15th in Jakarta
const db = () => mongoose.connection.db as mongoose.mongo.Db;
const col = (name: string) => db().collection(name);

/**
 * P13-T1 AC-6. Every active Agent under a leader whose join is within an activation's life gets one, from
 * their join date in the office's zone, pinned to the office's newest published checklist — once, however
 * often the migration runs.
 */
describe('0022 — the activation backfill (OD-119)', () => {
  beforeAll(startMongo);
  afterAll(stopMongo);

  describe('on hand-made offices', () => {
    beforeEach(async () => {
      await clearCollections();
      for (const name of ['kpms', 'memberships', 'activationTemplates', 'activationProgress']) await col(name).deleteMany({});
    });

    const office = async (over: Record<string, unknown> = {}) =>
      String((await col('kpms').insertOne({ code: '0417', timezone: 'Asia/Jakarta', deletedAt: null, ...over })).insertedId);
    const checklist = (kpmId: string, version: number, codes: string[], over: Record<string, unknown> = {}) =>
      col('activationTemplates').insertOne({
        kpmId, version, status: 'published', deletedAt: null,
        aspects: [{ code: 'A', label: '1. A', displayOrder: 1, items: codes.map((code, i) => ({ code, label: code, displayOrder: i + 1, autoLink: null })) }],
        ...over,
      });
    /** An active Agent placed under a leader on 1 August, unless `over` says otherwise. */
    const member = async (kpmId: string, over: Record<string, unknown> = {}) => String((await col('memberships').insertOne({
      kpmId, role: 'agent', orgLevelCode: 'AGENT', status: 'active', leaderId: 'leader-1',
      joinedAt: new Date('2026-08-01T01:00:00Z'), deletedAt: null, ...over,
    })).insertedId);

    it('P13-T1 AC-6 gives each active Agent within six months one, from the join date, pinned to the newest published version', async () => {
      const kpmId = await office();
      await checklist(kpmId, 1, ['OLD']);
      const newest = await checklist(kpmId, 2, ['ONE', 'TWO']);
      await checklist(kpmId, 3, ['DRAFT'], { status: 'draft' });
      // 23:30 UTC on 31 July is 1 August in Jakarta.
      const hire = await member(kpmId, { joinedAt: new Date('2026-07-31T23:30:00Z') });

      expect(await up(db(), NOW)).toEqual({ created: 1, alreadyHad: 0, ended: 0, noChecklist: 0 });
      expect(await col('activationProgress').findOne({ membershipId: hire })).toMatchObject({
        kpmId, templateId: String(newest.insertedId), templateVersion: 2, startDate: '2026-08-01', origin: 'backfill',
        items: [
          { code: 'ONE', done: false, doneAt: null, source: null, doneByMembershipId: null, note: null, date: null },
          { code: 'TWO', done: false, doneAt: null, source: null, doneByMembershipId: null, note: null, date: null },
        ],
        graduatedAt: null, note: null, version: 1, deletedAt: null, createdAt: NOW,
      });
    });

    it('P13-T1 AC-6 gives none to an AAB, a pending or removed member, nobody whose six months are over, or another rung', async () => {
      const kpmId = await office();
      await checklist(kpmId, 1, ['ONE']);
      await member(kpmId, { role: 'aab', orgLevelCode: 'AAB' });
      await member(kpmId, { status: 'pending', joinedAt: null });
      await member(kpmId, { status: 'removed' });
      await member(kpmId, { joinedAt: new Date('2026-03-01T01:00:00Z') });
      await member(kpmId, { deletedAt: NOW });
      expect(await up(db(), NOW)).toEqual({ created: 0, alreadyHad: 0, ended: 1, noChecklist: 0 });
      expect(await col('activationProgress').countDocuments({})).toBe(0);
    });

    it('Phase 13 exit review N1 gives none to an Agent under no leader — nobody placed them (ADR-0103) — and keeps origin backfill for one who is', async () => {
      const kpmId = await office();
      await checklist(kpmId, 1, ['ONE']);
      await member(kpmId, { leaderId: null });
      const unset = await member(kpmId);
      await col('memberships').updateOne({ _id: new mongoose.Types.ObjectId(unset) }, { $unset: { leaderId: '' } });
      const placed = await member(kpmId);
      expect(await up(db(), NOW)).toEqual({ created: 1, alreadyHad: 0, ended: 0, noChecklist: 0 });
      expect((await col('activationProgress').find({}).toArray()).map((r) => [r.membershipId, r.origin])).toEqual([[placed, 'backfill']]);
    });

    it('P13-T1 AC-6 counts an office with no published checklist, and writes nothing there', async () => {
      const kpmId = await office();
      await checklist(kpmId, 1, ['ONE'], { status: 'draft' });
      await member(kpmId);
      expect(await up(db(), NOW)).toEqual({ created: 0, alreadyHad: 0, ended: 0, noChecklist: 1 });
    });

    it('P13-T1 AC-6 reads each office’s own zone, and the platform’s where an office names none', async () => {
      const york = await office({ timezone: 'America/New_York' });
      const plain = await office({ code: '0555', timezone: undefined });
      for (const kpmId of [york, plain]) await checklist(kpmId, 1, ['ONE']);
      // 03:00 UTC on 1 August: still 31 July in New York, already 1 August in Jakarta.
      await member(york, { joinedAt: new Date('2026-08-01T03:00:00Z') });
      await member(plain, { joinedAt: new Date('2026-08-01T03:00:00Z') });
      await up(db(), NOW);
      expect((await col('activationProgress').find({}).sort({ kpmId: 1 }).toArray()).map((r) => [r.kpmId, r.startDate]).sort())
        .toEqual([[york, '2026-07-31'], [plain, '2026-08-01']].sort());
    });

    it('P13-T1 AC-6 is idempotent: the second run finds every one there, in whatever state, and writes nothing', async () => {
      const kpmId = await office();
      await checklist(kpmId, 1, ['ONE']);
      const graduated = await member(kpmId);
      await member(kpmId);
      await col('activationProgress').insertOne({ kpmId, membershipId: graduated, graduatedAt: NOW, deletedAt: null });
      expect(await up(db(), NOW)).toEqual({ created: 1, alreadyHad: 1, ended: 0, noChecklist: 0 });
      expect(await up(db(), NOW)).toEqual({ created: 0, alreadyHad: 2, ended: 0, noChecklist: 0 });
      expect(await col('activationProgress').countDocuments({})).toBe(2);
    });
  });

  describe('twice over the demo seed', () => {
    beforeAll(async () => {
      await clearCollections();
      // The hand-made offices above were written past Mongoose, which `clearCollections` does not see.
      for (const name of ['kpms', 'memberships', 'activationTemplates', 'activationProgress']) await col(name).deleteMany({});
      await seedDemo({ clock: new FixedClock(NOW), log: () => undefined });
    }, 240_000);

    it('P13-T1 AC-6 over the seed with its activations taken away: one for each active Agent within six months, and nobody else; then none', async () => {
      await col('activationProgress').deleteMany({});
      const first = await up(db(), NOW);
      const made = await col('activationProgress').find({}).toArray();
      const holders = await col('memberships').find({ _id: { $in: made.map((r) => new mongoose.Types.ObjectId(r.membershipId as string)) } }).toArray();
      const emails = (await col('users').find({ _id: { $in: holders.map((m) => new mongoose.Types.ObjectId(m.userId as string)) } }).toArray())
        .map((u) => u.email).sort();
      expect(emails).toEqual([
        'agent@kpm0555.test', 'budi@kpm0417.test', 'dimas@kpm0417.test', 'indah@kpm0417.test', 'novi@kpm0417.test',
        // Yanti's second membership: her first, removed, has none.
        'removed@kpm0417.test', 'rina@kpm0417.test', 'siti@kpm0417.test', 'wahyu@kpm0417.test',
      ]);
      // Sari, Dewi and Arief joined as Agents and were promoted: the backfill reads the current rung.
      expect(holders.every((m) => m.role === 'agent' && m.status === 'active')).toBe(true);
      // P13.2-T6: office 0701 started Empty, so its Agent, a week in, has no checklist to be pinned to.
      expect(first).toMatchObject({ created: 9, alreadyHad: 0, noChecklist: 1 });

      expect(await up(db(), NOW)).toMatchObject({ created: 0, alreadyHad: 9 });
      expect(await col('activationProgress').countDocuments({})).toBe(9);
    });
  });
});
