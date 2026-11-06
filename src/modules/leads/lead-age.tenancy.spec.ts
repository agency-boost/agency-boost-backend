import mongoose from 'mongoose';
import { FixedClock } from '@/common/clock/clock.port';
import { RequestContext } from '@/common/context/request-context';
import { clearCollections, startMongo, stopMongo } from '../../../test/mongo';
import { configModule, provisionOffice } from '../../../test/config-module';

/** 10:00 on 5 November 2026 in Jakarta. */
const NOW = new Date('2026-11-05T03:00:00Z');
const KPM_A = '66f0000000000000000000a1';
const KPM_B = '66f0000000000000000000b1';
const COMPANY = '66f0000000000000000000c1';

const AB = '66f000000000000000000101';
const AAB = '66f000000000000000000102';
const AGENT = '66f000000000000000000103';
const SIBLING = '66f000000000000000000104';
const STRANGER = '66f000000000000000000105';

const ctxFor = (membershipId: string, rung: string, kpmId = KPM_A) => new RequestContext('u-' + membershipId, 'none', {
  membershipId, kpmId, orgLevelCode: rung, hierarchyRole: rung.toLowerCase(),
  status: 'active', isKpmOwner: false, isKpmAdmin: false, directCount: 1,
} as never);

/**
 * **P19.7-T1 AC-1 — the client's age and gender on a lead, through the service, over a real database** (ADR-0224):
 * stored with the day it was written, read as today's on the office's calendar, read and written by whoever the lead's
 * own rules let read and write it, never across offices, and never copied into the audit log.
 */
describe('P19.7-T1 AC-1 the lead’s age and gender', () => {
  let wired: ReturnType<typeof configModule>;
  const clock = () => wired.clock as FixedClock;
  const db = () => mongoose.connection.db!;

  beforeAll(async () => {
    await startMongo();
    wired = configModule(NOW);
  });
  afterAll(stopMongo);

  beforeEach(async () => {
    clock().set(NOW);
    await clearCollections();
    await (wired.kpms as { create: (d: unknown) => Promise<unknown> }).create([
      { _id: KPM_A, companyId: COMPANY, code: '0417', branchName: 'A', timezone: 'Asia/Jakarta' },
      { _id: KPM_B, companyId: COMPANY, code: '0555', branchName: 'B', timezone: 'Asia/Jakarta' },
    ]);
    await provisionOffice(wired, KPM_A, COMPANY);
    const person = (id: string, rung: string, leaderId: string | null, ancestors: string[]) => ({
      _id: new mongoose.Types.ObjectId(id), kpmId: KPM_A, leaderCode: `LC-${id.slice(-3)}`,
      userId: '66f00000000000000000020' + id.slice(-1), orgLevelCode: rung, hierarchyRole: rung.toLowerCase(),
      leaderId, ancestorIds: ancestors, status: 'active', deletedAt: null,
    });
    await db().collection('memberships').insertMany([
      person(AB, 'AB', null, []),
      person(AAB, 'AAB', AB, [AB]),
      person(AGENT, 'AGENT', AAB, [AB, AAB]),
      person(SIBLING, 'AGENT', AAB, [AB, AAB]),
    ] as never);
    await db().collection('users').insertMany([AB, AAB, AGENT, SIBLING].map((id) => ({
      _id: new mongoose.Types.ObjectId('66f00000000000000000020' + id.slice(-1)),
      email: `${id}@kpm.test`, fullName: `Person ${id.slice(-3)}`, deletedAt: null,
    })) as never);
  });

  const agent = () => ctxFor(AGENT, 'AGENT');
  const stored = async (id: string) => db().collection('leads').findOne({ _id: new mongoose.Types.ObjectId(id) });

  it('P19.7-T1 AC-1 stores the age with today’s day and the gender, and answers both on every read', async () => {
    const lead = await wired.leadRecords.create(agent(), { name: 'Pak Budi', type: 'sales', age: 36, gender: 'male' });
    expect(lead).toMatchObject({ age: 36, ageRecordedOn: '2026-11-05', gender: 'male' });
    expect(await stored(lead.id)).toMatchObject({ age: 36, ageRecordedOn: '2026-11-05', gender: 'male' });
    expect(await wired.leadRecords.read(agent(), lead.id)).toMatchObject({ age: 36, gender: 'male' });
    const page = await wired.leadRecords.list(agent(), {});
    expect(page.rows[0]).toMatchObject({ age: 36, ageRecordedOn: '2026-11-05', gender: 'male' });
  });

  it('P19.7-T1 AC-1 leaves both optional: a lead with neither answers null, null, null', async () => {
    const lead = await wired.leadRecords.create(agent(), { name: 'Ibu Sari' });
    expect(lead).toMatchObject({ age: null, ageRecordedOn: null, gender: null });
  });

  it('P19.7-T1 AC-1 moves the age up on the anniversary at 00:00 WIB, and reads the year before unchanged', async () => {
    const lead = await wired.leadRecords.create(agent(), { name: 'Pak Budi', age: 36 });
    clock().set(new Date('2027-11-04T16:59:00Z')); // 23:59 WIB, 4 November 2027
    expect((await wired.leadRecords.read(agent(), lead.id)).age).toBe(36);
    clock().set(new Date('2027-11-04T17:00:00Z')); // 00:00 WIB, 5 November 2027
    expect((await wired.leadRecords.read(agent(), lead.id)).age).toBe(37);
    // The stored age is the one written, with its day: only the reading moved.
    expect(await stored(lead.id)).toMatchObject({ age: 36, ageRecordedOn: '2026-11-05' });
  });

  it('P19.7-T1 AC-1 leaves the age and its day alone when the sheet saves the age it shows; another age moves the day', async () => {
    const lead = await wired.leadRecords.create(agent(), { name: 'Pak Budi', age: 36 });
    clock().set(new Date('2028-01-10T03:00:00Z'));
    const same = await wired.leadRecords.update(agent(), lead.id, { age: 37, remarks: 'Sudah bicara.' });
    expect(same).toMatchObject({ age: 37, ageRecordedOn: '2026-11-05' });
    expect(await stored(lead.id)).toMatchObject({ age: 36, ageRecordedOn: '2026-11-05' });

    const moved = await wired.leadRecords.update(agent(), lead.id, { age: 40 });
    expect(moved).toMatchObject({ age: 40, ageRecordedOn: '2028-01-10' });

    const cleared = await wired.leadRecords.update(agent(), lead.id, { age: null, gender: null });
    expect(cleared).toMatchObject({ age: null, ageRecordedOn: null, gender: null });
  });

  it('P19.7-T1 AC-1 names the fields changed in the audit entry, never their values', async () => {
    const lead = await wired.leadRecords.create(agent(), { name: 'Pak Budi' });
    await wired.leadRecords.update(agent(), lead.id, { age: 52, gender: 'female' });
    const entry = await db().collection('auditLog').findOne({ action: 'lead.updated', targetId: lead.id });
    expect(entry!.after.fields).toEqual(expect.arrayContaining(['age', 'gender']));
    const written = JSON.stringify(await db().collection('auditLog').find({ targetId: lead.id }).toArray());
    expect(written).not.toMatch(/"age":\s*52|female|ageRecordedOn/);
  });

  it('P19.7-T1 AC-1 an unchanged age is not named as changed', async () => {
    const lead = await wired.leadRecords.create(agent(), { name: 'Pak Budi', age: 30, gender: 'male' });
    await wired.leadRecords.update(agent(), lead.id, { age: 30, gender: 'male', remarks: 'x' });
    const entry = await db().collection('auditLog').findOne({ action: 'lead.updated', targetId: lead.id });
    expect(entry!.after.fields).toEqual(['remarks']);
  });

  describe('P19.7-T1 AC-1 who reads and writes them: whoever the lead’s own rules let', () => {
    it('P19.7-T1 AC-1 a leader reads a downline’s lead with its age and gender', async () => {
      const lead = await wired.leadRecords.create(agent(), { name: 'Pak Budi', age: 45, gender: 'male' });
      expect(await wired.leadRecords.read(ctxFor(AAB, 'AAB'), lead.id)).toMatchObject({ age: 45, gender: 'male' });
      expect(await wired.leadRecords.read(ctxFor(AB, 'AB'), lead.id)).toMatchObject({ age: 45, gender: 'male' });
    });

    it('P19.7-T1 AC-1 a leader’s write is pinned to the version read, and carries the leader’s name (ADR-0044)', async () => {
      const lead = await wired.leadRecords.create(agent(), { name: 'Pak Budi' });
      await expect(wired.leadRecords.update(ctxFor(AAB, 'AAB'), lead.id, { age: 45 }))
        .rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
      await expect(wired.leadRecords.update(ctxFor(AAB, 'AAB'), lead.id, { age: 45, version: lead.version + 3 }))
        .rejects.toMatchObject({ code: 'VERSION_CONFLICT' });
      const written = await wired.leadRecords.update(ctxFor(AAB, 'AAB'), lead.id, { age: 45, version: lead.version });
      expect(written).toMatchObject({ age: 45, ageRecordedOn: '2026-11-05', lastEditedBy: { membershipId: AAB } });
    });

    it('P19.7-T1 AC-1 a colleague in the same unit can neither read nor write them: 404', async () => {
      const lead = await wired.leadRecords.create(agent(), { name: 'Pak Budi', age: 45 });
      await expect(wired.leadRecords.read(ctxFor(SIBLING, 'AGENT'), lead.id)).rejects.toMatchObject({ code: 'NOT_FOUND' });
      await expect(wired.leadRecords.update(ctxFor(SIBLING, 'AGENT'), lead.id, { age: 50 }))
        .rejects.toMatchObject({ code: 'NOT_FOUND' });
    });

    it('P19.7-T1 AC-1 KPM B cannot read or write KPM A’s lead’s age: 404, and nothing changes', async () => {
      const lead = await wired.leadRecords.create(agent(), { name: 'Pak Budi', age: 45, gender: 'male' });
      const other = ctxFor(STRANGER, 'AGENT', KPM_B);
      await expect(wired.leadRecords.read(other, lead.id)).rejects.toMatchObject({ code: 'NOT_FOUND' });
      await expect(wired.leadRecords.update(other, lead.id, { age: 99, gender: 'female', version: lead.version }))
        .rejects.toMatchObject({ code: 'NOT_FOUND' });
      expect(await stored(lead.id)).toMatchObject({ age: 45, gender: 'male' });
      expect((await wired.leadRecords.list(other, {})).rows).toEqual([]);
    });
  });

  it('P19.7-T1 AC-1 refuses an age outside 1–100 with LEAD_AGE_OUT_OF_RANGE and { min, max }, writing nothing', async () => {
    const lead = await wired.leadRecords.create(agent(), { name: 'Pak Budi', age: 30 });
    for (const age of [0, 101, -1]) {
      await expect(wired.leadRecords.update(agent(), lead.id, { age }))
        .rejects.toMatchObject({ code: 'LEAD_AGE_OUT_OF_RANGE', details: { min: 1, max: 100 } });
    }
    await expect(wired.leadRecords.create(agent(), { name: 'Ibu Ani', age: 101 }))
      .rejects.toMatchObject({ code: 'LEAD_AGE_OUT_OF_RANGE' });
    expect(await stored(lead.id)).toMatchObject({ age: 30, version: lead.version });
    expect(await db().collection('leads').countDocuments({})).toBe(1);
  });
});
