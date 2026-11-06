import mongoose from 'mongoose';
import type { FixedClock } from '@/common/clock/clock.port';
import { RequestContext } from '@/common/context/request-context';
import { clearCollections, startMongo, stopMongo } from '../../../test/mongo';
import { configModule, provisionOffice } from '../../../test/config-module';

/** 23:59 on 30 November 2026 in Jakarta (UTC+7), and the minute after it. */
const LAST_MINUTE_OF_NOV = new Date('2026-11-30T16:59:00Z');
const FIRST_MINUTE_OF_DEC = new Date('2026-11-30T17:00:00Z');
const KPM_A = '66f0000000000000000000a1';
const KPM_B = '66f0000000000000000000b1';
const COMPANY = '66f0000000000000000000c1';

const member = (kpmId: string, membershipId: string) => new RequestContext('u1', 'none', {
  membershipId, kpmId, orgLevelCode: 'AGENT', hierarchyRole: 'agent',
  status: 'active', isKpmOwner: false, isKpmAdmin: false, directCount: 0,
} as never);

/**
 * **P19.1-T2 — the lead's *Potensi* switch and its two outcome buttons, as the service keeps them** (UI-153, UI-160;
 * ADR-0193 §1, ADR-0194). The switch is the month's commitment, derived on read: on the 1st at 00:00 Asia/Jakarta it
 * reads off with nothing having run, and last month's stays as history. *Lost* is refused at the office's final stage;
 * *won* stays refused below it.
 */
describe('P19.1-T2 the Potensi switch and the outcome buttons (UI-153, UI-160)', () => {
  let wired: ReturnType<typeof configModule>;
  const A = () => member(KPM_A, 'mem-a1');
  const B = () => member(KPM_B, 'mem-b1');
  const clock = () => wired.clock as FixedClock;
  const db = () => mongoose.connection.db!;

  beforeAll(async () => {
    await startMongo();
    wired = configModule(new Date('2026-11-04T03:00:00Z'));
  });
  afterAll(stopMongo);
  beforeEach(async () => {
    await clearCollections();
    clock().set(new Date('2026-11-04T03:00:00Z'));
    await (wired.kpms as { create: (d: unknown) => Promise<unknown> }).create([
      { _id: KPM_A, companyId: COMPANY, code: '0417', branchName: 'A', timezone: 'Asia/Jakarta' },
      { _id: KPM_B, companyId: COMPANY, code: '0555', branchName: 'B', timezone: 'Asia/Jakarta' },
    ]);
    await provisionOffice(wired, KPM_A, COMPANY);
    await provisionOffice(wired, KPM_B, COMPANY);
  });

  const lead = async (type: 'sales' | 'recruitment', stage: string, thisMonth = false, who = A()) => {
    const created = await wired.leadRecords.create(who, { name: 'Ibu Kartika Dewanti', type, thisMonth });
    return wired.leadRecords.setStatus(who, created.id, stage);
  };

  describe('the switch (UI-153 items 1–4)', () => {
    it('P19.1-T2 AC-6 every switch reads off at 00:00 WIB on 1 December, with nothing having run; November stays readable', async () => {
      const on = await lead('sales', 'FOLLOW_UP', true);
      clock().set(LAST_MINUTE_OF_NOV);
      expect((await wired.leadRecords.read(A(), on.id))).toMatchObject({ thisMonth: true, committedMonths: ['2026-11'] });

      clock().set(FIRST_MINUTE_OF_DEC);
      const december = await wired.leadRecords.read(A(), on.id);
      expect(december).toMatchObject({ thisMonth: false, committedMonths: ['2026-11'] });
      // The history the Potensi tab reads for November.
      const stored = await db().collection('leads').findOne({ name: 'Ibu Kartika Dewanti' });
      expect(stored!.commitments).toEqual([expect.objectContaining({ month: '2026-11' })]);
    });

    it('P19.1-T2 AC-6 a lead switched on before this change, written the old way, still reads on for November 2026', async () => {
      // A row as P7-T5 wrote it: one commitment entry, and no field this phase added.
      const { insertedId } = await db().collection('leads').insertOne({
        kpmId: KPM_A, ownerMembershipId: 'mem-a1', type: 'sales', name: 'Pak Hendro Gunawan', statusCode: 'FOLLOW_UP',
        statusId: null, outcome: null, outcomeAt: null, contact: { phone: null, email: null }, remarks: null,
        nextActionDate: null, nextActionNote: null, source: null, version: 3, transitions: [], deletedAt: null,
        commitments: [{ month: '2026-11', at: new Date('2026-11-02T03:00:00Z'), byMembershipId: 'mem-a1' }],
        dateRegistered: new Date('2026-10-20T03:00:00Z'), createdBy: 'mem-a1', updatedBy: 'mem-a1',
      });
      const read = await wired.leadRecords.read(A(), String(insertedId));
      expect(read).toMatchObject({ thisMonth: true, closedThisMonth: false, committedMonths: ['2026-11'] });
    });

    it('P19.1-T2 AC-7 a switched-on lead that closes this month keeps its switch on for the month (UI-153 item 4)', async () => {
      const on = await lead('sales', 'PAID_AND_ISSUED', true);
      const won = await wired.leadRecords.setOutcome(A(), on.id, 'won');
      expect(won).toMatchObject({ outcome: 'won', thisMonth: true, closedThisMonth: true });
      // A Recruit lead's success is the office's final Recruit stage, *Agen aktif baru* (ADR-0194 §4).
      const kandidat = await lead('recruitment', 'NEW_ACTIVE_AGENT', true);
      expect(await wired.leadRecords.setOutcome(A(), kandidat.id, 'won')).toMatchObject({ thisMonth: true, closedThisMonth: true });
    });

    it('P19.1-T2 AC-8 the badge clears on the 1st with the switch: closedThisMonth reads false in December', async () => {
      const on = await lead('sales', 'PAID_AND_ISSUED', true);
      clock().set(LAST_MINUTE_OF_NOV);
      await wired.leadRecords.setOutcome(A(), on.id, 'won');
      expect((await wired.leadRecords.list(A())).rows[0]).toMatchObject({ thisMonth: true, closedThisMonth: true });
      clock().set(FIRST_MINUTE_OF_DEC);
      expect((await wired.leadRecords.list(A())).rows[0]).toMatchObject({ thisMonth: false, closedThisMonth: false });
    });

    it('P19.1-T2 AC-8 the list carries the badge’s two facts on every row, so the badge needs no second call', async () => {
      await lead('sales', 'FOLLOW_UP', true);
      await lead('sales', 'FOLLOW_UP', false);
      const rows = (await wired.leadRecords.list(A())).rows;
      expect(rows.map((r) => [r.thisMonth, r.closedThisMonth]).sort()).toEqual([[false, false], [true, false]]);
    });

    it('P19.1-T2 AC-5 changing the type clears the month’s switch: closing and recruiting are different promises', async () => {
      const on = await lead('sales', 'FOLLOW_UP', true);
      const moved = await wired.leadRecords.update(A(), on.id, { type: 'recruitment' });
      expect(moved.thisMonth).toBe(false);
    });
  });

  describe('the outcome buttons (UI-160, ADR-0194)', () => {
    it('P19.1-T2 AC-10 refuses lost at the final Sales stage with LEAD_STATUS_FINAL, and writes nothing', async () => {
      const paid = await lead('sales', 'PAID_AND_ISSUED');
      await expect(wired.leadRecords.setOutcome(A(), paid.id, 'lost')).rejects.toMatchObject({
        code: 'LEAD_STATUS_FINAL', status: 422, details: { statusCode: 'PAID_AND_ISSUED' },
      });
      expect((await wired.leadRecords.read(A(), paid.id)).outcome).toBeNull();
    });

    it('P19.1-T2 AC-10 refuses lost at the final Recruit stage too: a kandidat who joined is a success', async () => {
      const joined = await lead('recruitment', 'NEW_ACTIVE_AGENT');
      await expect(wired.leadRecords.setOutcome(A(), joined.id, 'lost')).rejects.toMatchObject({ code: 'LEAD_STATUS_FINAL' });
      // The agent code is stage 4, not the end: lost is still allowed there.
      const coded = await lead('recruitment', 'AGENT_CODE_CREATED');
      expect((await wired.leadRecords.setOutcome(A(), coded.id, 'lost')).outcome).toBe('lost');
    });

    it('P19.1-T2 AC-10 won below the final stage stays LEAD_STATUS_NOT_FINAL; lost below it is taken', async () => {
      const early = await lead('sales', 'APPROVED_NOT_PAID');
      await expect(wired.leadRecords.setOutcome(A(), early.id, 'won')).rejects.toMatchObject({ code: 'LEAD_STATUS_NOT_FINAL' });
      expect((await wired.leadRecords.setOutcome(A(), early.id, 'lost')).outcome).toBe('lost');
    });

    it('P19.1-T2 AC-10 the way out: moved back to an earlier stage, a lead that fell through is marked lost (ADR-0194 §5)', async () => {
      const paid = await lead('sales', 'PAID_AND_ISSUED');
      const back = await wired.leadRecords.setStatus(A(), paid.id, 'APPROVED_NOT_PAID');
      expect((await wired.leadRecords.setOutcome(A(), back.id, 'lost', back.version)).outcome).toBe('lost');
      const history = (await wired.leadRecords.read(A(), paid.id)).history.map((m) => (m.kind === 'stage' ? m.toStatusCode : null));
      expect(history).toEqual(['PAID_AND_ISSUED', 'APPROVED_NOT_PAID']);
    });

    it('P19.1-T2 AC-10 a lead already lost at the final stage keeps its outcome; reopening still works (ADR-0194 §6)', async () => {
      const paid = await lead('sales', 'PAID_AND_ISSUED');
      await db().collection('leads').updateOne({ _id: new mongoose.Types.ObjectId(paid.id) }, { $set: { outcome: 'lost' } });
      expect((await wired.leadRecords.read(A(), paid.id)).outcome).toBe('lost');
      expect((await wired.leadRecords.setOutcome(A(), paid.id, null)).outcome).toBeNull();
    });

    it('P19.1-T2 AC-11 after Tandai berhasil the lead is won, out of the open list, and in the closed list', async () => {
      const paid = await lead('sales', 'PAID_AND_ISSUED', true);
      await wired.leadRecords.setOutcome(A(), paid.id, 'won');
      expect((await wired.leadRecords.list(A(), { outcome: 'open' })).total).toBe(0);
      expect((await wired.leadRecords.list(A(), { outcome: 'won' })).rows.map((r) => r.id)).toEqual([paid.id]);
    });

    it('P19.1-T2 AC-10 another office’s lead is 404, whichever outcome is asked for', async () => {
      const theirs = await lead('sales', 'PAID_AND_ISSUED', false, B());
      await expect(wired.leadRecords.setOutcome(A(), theirs.id, 'lost')).rejects.toMatchObject({ status: 404 });
      await expect(wired.leadRecords.setOutcome(A(), theirs.id, 'won')).rejects.toMatchObject({ status: 404 });
      expect((await wired.leadRecords.read(B(), theirs.id)).outcome).toBeNull();
    });
  });
});
