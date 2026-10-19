import mongoose from 'mongoose';
import { clearCollections, startMongo, stopMongo } from '../../../test/mongo';
import { configModule } from '../../../test/config-module';
import {
  buildCoachingOffice, KPM_A, KPM_B, ROSTER_NOW, type CoachingOffice, type Who,
} from '../../../test/coaching-office';

/**
 * **The print and `/coaching/me` hold the office boundary** (P11-T10; invariant §1;
 * `multi-tenancy-and-scoping.md`): another office's session is 404 — never 403 — to every reader, the
 * Owner of this office included, and nothing is recorded; a reader's own coaching lists their office's
 * sessions and no other, even where another office's records name the same membership ids.
 */
describe('the record after the meeting holds the office boundary (P11-T10)', () => {
  let wired: ReturnType<typeof configModule>;
  let office: CoachingOffice;
  const col = (name: string) => mongoose.connection.db!.collection(name);

  beforeAll(async () => {
    await startMongo();
    wired = configModule(ROSTER_NOW);
    await clearCollections();
    office = await buildCoachingOffice(wired);
  }, 120_000);
  afterAll(stopMongo);

  /** A finalized session in `kpmId`, written as finalize leaves one. */
  async function held(kpmId: string, coach: string, coachee: string, date: string) {
    const _id = new mongoose.Types.ObjectId();
    await col('coachingSessions').insertOne({
      _id, kpmId, coachMembershipId: coach, coacheeMembershipId: coachee, status: 'finalized', date,
      lastWeek: null, lastWeekItems: [], tips: [], leadActions: [], snapshot: null,
      actionItems: [{ itemId: `${date}-1`, text: 'Another office’s item', dueDate: date, carriedFromItemId: null }],
      frozenAt: new Date(`${date}T04:00:00Z`), finalizedAt: new Date(`${date}T04:00:00Z`), finalizedByMembershipId: coach,
      version: 3, corrections: [], deletedAt: null, createdAt: new Date(`${date}T03:00:00Z`), updatedAt: new Date(`${date}T04:00:00Z`),
    });
    return String(_id);
  }

  const notFound = { status: 404, code: 'NOT_FOUND' };
  const id = (who: Who) => office.id[who];

  it('P11-T10 another office’s session is 404 on the print to every reader in this one, and nothing is recorded', async () => {
    const theirs = await held(KPM_B, id('B_AB'), id('B_AGENT'), '2026-09-11');
    await col('auditLog').deleteMany({});

    for (const who of ['AGUS', 'OWNER', 'ADMIN', 'INDAH'] as Who[]) {
      await expect(wired.coachingRecord.print(office.as(who), theirs)).rejects.toMatchObject(notFound);
    }
    // Its own office prints it.
    await expect(wired.coachingRecord.print(office.as('B_AB'), theirs)).resolves.toMatchObject({ sessionId: theirs });
    expect(await col('auditLog').countDocuments({ kpmId: KPM_A })).toBe(0);
  });

  it('P11-T10 this office’s session is 404 on the print to another office, whoever they lead', async () => {
    const ours = String((await col('coachingSessions').findOne({ kpmId: KPM_A, coacheeMembershipId: id('INDAH') }))!._id);
    await col('auditLog').deleteMany({});

    for (const who of ['B_AB', 'B_AGENT'] as Who[]) {
      await expect(wired.coachingRecord.print(office.as(who), ours)).rejects.toMatchObject(notFound);
    }
    expect(await col('auditLog').countDocuments({})).toBe(0);
  });

  it('P11-T10 /coaching/me lists the reader’s own office only, where another office’s records carry the same ids', async () => {
    // Filed in office B under Indah's and Agus's membership ids: a forged pair a missing filter would answer.
    const forgedAbout = await held(KPM_B, id('B_AB'), id('INDAH'), '2026-09-13');
    const forgedLed = await held(KPM_B, id('AGUS'), id('B_AGENT'), '2026-09-13');

    const indah = await wired.coachingRecord.mine(office.as('INDAH'));
    expect(indah.sessions.map((r) => r.sessionId)).not.toContain(forgedAbout);
    expect(indah.sessions.map((r) => r.date)).toEqual(['2026-09-10']);
    const agus = await wired.coachingRecord.mine(office.as('AGUS'));
    expect(agus.ledFormerly.map((r) => r.sessionId)).not.toContain(forgedLed);
    expect(agus.ledFormerly).toEqual([]);

    // Office B's own reader reads B's records, the one filed under Agus's id included: the boundary is the
    // office the record is in, not whose id it carries.
    const b = await wired.coachingRecord.mine(office.as('B_AGENT'));
    expect(b.sessions.map((r) => r.sessionId)).toContain(forgedLed);
    const inB = await col('coachingSessions').find({ kpmId: KPM_B }).toArray();
    expect(b.sessions.every((r) => inB.some((s) => String(s._id) === r.sessionId))).toBe(true);
  });
});
