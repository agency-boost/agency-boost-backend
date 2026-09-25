import mongoose from 'mongoose';
import { FixedClock } from '@/common/clock/clock.port';
import { RequestContext } from '@/common/context/request-context';
import { clearCollections, startMongo, stopMongo } from '../../../test/mongo';
import { configModule, provisionOffice } from '../../../test/config-module';

const NOW = new Date('2026-09-25T02:00:00Z');
const KPM = '66f0000000000000000000a1';
const COMPANY = '66f0000000000000000000c1';

const AB = '66f000000000000000000101';
const AAB = '66f000000000000000000102';
const AGENT = '66f000000000000000000103';
const SIBLING = '66f000000000000000000104';
const OUTSIDER = '66f000000000000000000105';

const ctxFor = (membershipId: string, orgLevelCode: string, over: Record<string, unknown> = {}) =>
  new RequestContext('u-' + membershipId, 'none', {
    membershipId,
    kpmId: KPM,
    orgLevelCode,
    hierarchyRole: orgLevelCode.toLowerCase(),
    status: 'active',
    isKpmOwner: false,
    isKpmAdmin: false,
    directCount: 1,
    ...over,
  } as never);

/**
 * Who may touch whose lead (P7-T7, ADR-0044).
 *
 * **The hole this spec was written to close.** Until it existed, `lead.tenancy.spec.ts` proved that
 * one *office* could not reach another's — and nothing proved that one *agent* could not reach a
 * colleague's. They could: read, edit and delete, all of it, because every route resolved the lead
 * with a tenant-scoped `findById` and stopped there. `own` was in the permission matrix and in no
 * line of code.
 */
describe('who may touch whose lead (P7-T7)', () => {
  let wired: ReturnType<typeof configModule>;

  beforeAll(async () => {
    await startMongo();
    wired = configModule(NOW);
  });
  afterAll(stopMongo);

  beforeEach(async () => {
    await clearCollections();
    await provisionOffice(wired, KPM, COMPANY);
    await mongoose.connection.db!.collection('memberships').insertMany([
      person(AB, 'AB', null, [], 'Pak Agus'),
      person(AAB, 'AAB', AB, [AB], 'Ibu Sari'),
      person(AGENT, 'AGENT', AAB, [AB, AAB], 'Rina Wijaya'),
      person(SIBLING, 'AGENT', AAB, [AB, AAB], 'Budi Santoso'),
      // Somebody else's unit entirely: under nobody this spec's leaders can reach.
      person(OUTSIDER, 'AGENT', null, [], 'Lina Marlina'),
    ] as never);
    await mongoose.connection.db!.collection('users').insertMany(
      [AB, AAB, AGENT, SIBLING, OUTSIDER].map((id) => ({
        _id: new mongoose.Types.ObjectId('66f00000000000000000020' + id.slice(-1)),
        email: `${id}@kpm.test`, fullName: NAMES[id], deletedAt: null,
      })) as never,
    );
  });

  const NAMES: Record<string, string> = {
    [AB]: 'Pak Agus', [AAB]: 'Ibu Sari', [AGENT]: 'Rina Wijaya',
    [SIBLING]: 'Budi Santoso', [OUTSIDER]: 'Lina Marlina',
  };

  function person(id: string, rung: string, leaderId: string | null, ancestors: string[], _name: string) {
    return {
      _id: new mongoose.Types.ObjectId(id),
      kpmId: KPM,
      // Unique across live rows (`{leaderCode: 1}`, partial on `deletedAt: null`), so these are
      // written rather than left null — five nulls collide the moment the index is built.
      leaderCode: `LC-${id.slice(-3)}`,
      userId: '66f00000000000000000020' + id.slice(-1),
      orgLevelCode: rung,
      hierarchyRole: rung.toLowerCase(),
      leaderId,
      ancestorIds: ancestors,
      status: 'active',
      deletedAt: null,
    };
  }

  const ab = () => ctxFor(AB, 'AB');
  const aab = () => ctxFor(AAB, 'AAB');
  const agent = () => ctxFor(AGENT, 'AGENT');
  const sibling = () => ctxFor(SIBLING, 'AGENT');
  const outsider = () => ctxFor(OUTSIDER, 'AGENT');

  const leadOf = (who: RequestContext, name = 'Pak Budi') =>
    wired.leadRecords.create(who, { name });

  describe('an agent’s lead is their own', () => {
    it('is invisible to a colleague in the same office and the same unit', async () => {
      const mine = await leadOf(agent());

      await expect(wired.leadRecords.read(sibling(), mine.id))
        .rejects.toMatchObject({ code: 'NOT_FOUND' });
      await expect(wired.leadRecords.update(sibling(), mine.id, { name: 'Taken' }))
        .rejects.toMatchObject({ code: 'NOT_FOUND' });
      await expect(wired.leadRecords.remove(sibling(), mine.id))
        .rejects.toMatchObject({ code: 'NOT_FOUND' });
    });

    it('404 and never 403, so the refusal does not confirm the lead exists', async () => {
      const mine = await leadOf(agent());

      await expect(wired.leadRecords.read(sibling(), mine.id))
        .rejects.toMatchObject({ status: 404 });
    });

    it('is not in a colleague’s list', async () => {
      await leadOf(agent(), 'Rina’s lead');
      await leadOf(sibling(), 'Budi’s lead');

      const theirs = await wired.leadRecords.list(sibling());

      expect(theirs.rows.map((r) => r.name)).toEqual(['Budi’s lead']);
    });
  });

  describe('AC-1 — a leader writes a downline’s lead, and the write carries their name', () => {
    it('lets an AAB reach their own unit', async () => {
      const theirs = await leadOf(agent());

      const edited = await wired.leadRecords.update(aab(), theirs.id, { remarks: 'Coached today.' });

      expect(edited.remarks).toBe('Coached today.');
      expect(edited.ownerMembershipId).toBe(AGENT);
    });

    it('lets an AB reach anybody below them, not only their directs', async () => {
      const theirs = await leadOf(agent());

      const edited = await wired.leadRecords.update(ab(), theirs.id, { remarks: 'Reviewed.' });

      expect(edited.ownerMembershipId).toBe(AGENT);
      expect(edited.remarks).toBe('Reviewed.');
    });

    it('records who moved it, which is not whose lead it is', async () => {
      const theirs = await leadOf(agent());
      await wired.leadRecords.update(aab(), theirs.id, { type: 'sales' });

      await wired.leadRecords.setStatus(aab(), theirs.id, 'FOLLOW_UP');

      const stored = await mongoose.connection.db!.collection('leads')
        .findOne({ _id: new mongoose.Types.ObjectId(theirs.id) });
      expect(stored!.transitions[0]).toMatchObject({
        toStatusCode: 'FOLLOW_UP', byMembershipId: AAB,
      });
      expect(stored!.ownerMembershipId).toBe(AGENT);
    });

    it('AC-2: names the leader on the lead, so the agent can tell whose change it was', async () => {
      const theirs = await leadOf(agent());
      await wired.leadRecords.update(aab(), theirs.id, { remarks: 'Coached today.' });

      // Read by the **agent**, on their own screen. That is where the exit criterion is checked.
      const asTheAgent = await wired.leadRecords.read(agent(), theirs.id);

      expect(asTheAgent.lastEditedBy).toEqual({ membershipId: AAB, name: 'Ibu Sari' });
    });

    it('AC-2: says nothing when the last change was the agent’s own', async () => {
      const theirs = await leadOf(agent());
      await wired.leadRecords.update(aab(), theirs.id, { remarks: 'Coached today.' });

      const afterTheirOwnEdit = await wired.leadRecords.update(agent(), theirs.id, { remarks: 'Mine.' });

      expect(afterTheirOwnEdit.lastEditedBy).toBeNull();
    });
  });

  describe('AC-4/AC-5 — and nothing wider than the grant', () => {
    it('keeps an AAB out of a unit that is not theirs', async () => {
      const elsewhere = await leadOf(outsider());

      await expect(wired.leadRecords.read(aab(), elsewhere.id))
        .rejects.toMatchObject({ code: 'NOT_FOUND' });
      await expect(wired.leadRecords.update(aab(), elsewhere.id, { name: 'Taken' }))
        .rejects.toMatchObject({ code: 'NOT_FOUND' });
    });

    it('keeps an AB out of somebody who is not below them', async () => {
      const elsewhere = await leadOf(outsider());

      await expect(wired.leadRecords.read(ab(), elsewhere.id))
        .rejects.toMatchObject({ code: 'NOT_FOUND' });
    });

    it('lists a leader’s own leads and their downline’s, and no others', async () => {
      await leadOf(ab(), 'Agus’ own');
      await leadOf(aab(), 'Sari’s own');
      await leadOf(agent(), 'Rina’s');
      await leadOf(sibling(), 'Budi’s');
      await leadOf(outsider(), 'Lina’s');

      const seenByAb = await wired.leadRecords.list(ab());
      const seenByAab = await wired.leadRecords.list(aab());

      expect(seenByAb.rows.map((r) => r.name).sort())
        .toEqual(['Agus’ own', 'Budi’s', 'Rina’s', 'Sari’s own']);
      expect(seenByAab.rows.map((r) => r.name).sort())
        .toEqual(['Budi’s', 'Rina’s', 'Sari’s own']);
    });

    it('refuses a leader the delete a lead’s owner has', async () => {
      // `lead:delete` is `own` and is granted to nobody as a proxy: the coaching leads table has
      // no delete at all, which is the prototype agreeing (§3.7).
      const theirs = await leadOf(agent());

      await expect(wired.leadRecords.remove(aab(), theirs.id))
        .rejects.toMatchObject({ code: 'NOT_FOUND' });
      expect((await wired.leadRecords.read(agent(), theirs.id)).id).toBe(theirs.id);
    });

    it('lets each of them delete their own', async () => {
      for (const who of [ab(), aab(), agent()]) {
        const mine = await leadOf(who, `${who.membershipId}'s`);
        await expect(wired.leadRecords.remove(who, mine.id)).resolves.toMatchObject({ id: mine.id });
      }
    });
  });

  describe('AC-3 — two people, one lead, two devices', () => {
    it('refuses a write pinned to a version the lead has moved past', async () => {
      const theirs = await leadOf(agent());
      // The leader loads it, the agent edits it, the leader saves what they loaded.
      const loadedByTheLeader = theirs.version;
      await wired.leadRecords.update(agent(), theirs.id, { remarks: 'Typed while they watched.' });

      await expect(wired.leadRecords.update(aab(), theirs.id, {
        remarks: 'Stale.', version: loadedByTheLeader,
      })).rejects.toMatchObject({ code: 'VERSION_CONFLICT', status: 409 });
    });

    it('overwrites nothing when it refuses', async () => {
      const theirs = await leadOf(agent());
      const stale = theirs.version;
      await wired.leadRecords.update(agent(), theirs.id, { remarks: 'Mine.' });

      await expect(wired.leadRecords.update(aab(), theirs.id, { remarks: 'Theirs.', version: stale }))
        .rejects.toMatchObject({ code: 'VERSION_CONFLICT' });

      expect((await wired.leadRecords.read(agent(), theirs.id)).remarks).toBe('Mine.');
    });

    it('takes the write when the version is the one on the record', async () => {
      const theirs = await leadOf(agent());

      const saved = await wired.leadRecords.update(aab(), theirs.id, {
        remarks: 'Coached.', version: theirs.version,
      });

      expect(saved.remarks).toBe('Coached.');
      expect(saved.version).toBe(theirs.version + 1);
    });

    it('pins a move and an outcome as well as a field edit', async () => {
      const theirs = await leadOf(agent(), 'Movable');
      const afterType = await wired.leadRecords.update(agent(), theirs.id, { type: 'sales' });

      await expect(wired.leadRecords.setStatus(aab(), theirs.id, 'FOLLOW_UP', theirs.version))
        .rejects.toMatchObject({ code: 'VERSION_CONFLICT' });
      await expect(wired.leadRecords.setOutcome(aab(), theirs.id, 'lost', theirs.version))
        .rejects.toMatchObject({ code: 'VERSION_CONFLICT' });

      const moved = await wired.leadRecords.setStatus(aab(), theirs.id, 'FOLLOW_UP', afterType.version);
      expect(moved.statusCode).toBe('FOLLOW_UP');
    });

    it('answers 404 rather than 409 for a lead the writer may not reach', async () => {
      // A conflict confirms the record exists. The scope check has to come first.
      const elsewhere = await leadOf(outsider());

      await expect(wired.leadRecords.update(aab(), elsewhere.id, { remarks: 'x', version: 99 }))
        .rejects.toMatchObject({ code: 'NOT_FOUND' });
    });
  });

  /**
   * The rollups that read leads (P7-T6).
   *
   * **Every number is something already defined elsewhere.** Two are the metric registry's
   * (invariant §8); the rest are this module's own rules — T5's commitment and T4's attention
   * flags — so nothing here is a figure invented for a screen.
   */
  describe('the counts (P7-T6)', () => {
    const summary = (who: RequestContext) => wired.leadRecords.summary(who);

    const recruitmentAt = async (who: RequestContext, name: string, code: string | null) => {
      const lead = await wired.leadRecords.create(who, { name, type: 'recruitment' });
      if (code) await wired.leadRecords.setStatus(who, lead.id, code);
      return lead;
    };

    it('AC-1: RECRUITMENT_PIPELINE_NOW counts the open candidates off the closing stage', async () => {
      await recruitmentAt(agent(), 'Not started', null);
      await recruitmentAt(agent(), 'Halfway', 'MEETING_SCHEDULED');
      const done = await recruitmentAt(agent(), 'Arrived', 'NEW_ACTIVE_AGENT');
      const lost = await recruitmentAt(agent(), 'Gone', 'MEETING_SCHEDULED');
      await wired.leadRecords.setOutcome(agent(), lost.id, 'lost');
      await wired.leadRecords.create(agent(), { name: 'A sale', type: 'sales' });

      // Two: the one with no stage and the one halfway. Not the terminal stage, not the lost one,
      // and not the sales lead — `isTerminal` is the office's own flag, never a rank (invariant §4).
      expect((await summary(agent())).recruitmentPipelineNow).toBe(2);
      expect(done.id).toBeDefined();
    });

    it('AC-1: RECRUITMENT_EXPECTED_TO_CLOSE counts the late stages, and only those', async () => {
      await recruitmentAt(agent(), 'Early', 'MEETING_SCHEDULED');
      await recruitmentAt(agent(), 'Late', 'AGENT_CODE_CREATED');
      await recruitmentAt(agent(), 'Later', 'AAJI_LICENSED');
      // On the stage that closes the pipeline: excluded by construction, because `isLateStage` is
      // never true where `isTerminal` is.
      await recruitmentAt(agent(), 'Arrived', 'NEW_ACTIVE_AGENT');

      expect((await summary(agent())).recruitmentExpectedToClose).toBe(2);
    });

    it('AC-1: reads the office’s own flags rather than a rank', async () => {
      // Flip a stage the platform seeds as early, and the number follows the office.
      const [, recruitment] = await wired.leads.list(agent());
      const early = recruitment.statuses.find((s) => s.code === 'MEETING_SCHEDULED')!;
      await recruitmentAt(agent(), 'Early', 'MEETING_SCHEDULED');
      expect((await summary(agent())).recruitmentExpectedToClose).toBe(0);

      await wired.leads.setLateStage(agent(), early.id, true);

      expect((await summary(agent())).recruitmentExpectedToClose).toBe(1);
    });

    it('counts the commitment T5 defines, for the office’s current month only', async () => {
      const promised = await wired.leadRecords.create(agent(), { name: 'Promised', thisMonth: true });
      await wired.leadRecords.create(agent(), { name: 'Not promised' });

      expect((await summary(agent())).committedThisMonth).toBe(1);

      (wired.clock as FixedClock).set(new Date('2026-10-01T02:00:00Z'));
      // Nothing ran, and the promise is September's.
      expect((await summary(agent())).committedThisMonth).toBe(0);
      (wired.clock as FixedClock).set(NOW);
      expect(promised.thisMonth).toBe(true);
    });

    it('agrees with flagsFor, which is the only definition of an attention flag', async () => {
      // Invariant §8: the counts are evaluated in the database and defined in the service. This
      // is what stops the two from drifting — it fails the moment either changes alone.
      await wired.leadRecords.create(agent(), { name: 'Nothing typed' });
      await wired.leadRecords.create(agent(), { name: 'Late', remarks: 'Talked.', nextActionDate: '2026-09-01' });
      await wired.leadRecords.create(agent(), { name: 'Fine', remarks: 'Talked.', nextActionDate: '2026-12-01' });
      const closed = await wired.leadRecords.create(agent(), { name: 'Closed' });
      await wired.leadRecords.setOutcome(agent(), closed.id, 'lost');

      const rows = (await wired.leadRecords.list(agent(), { pageSize: 200 })).rows;
      const byFlags = {
        overdue: rows.filter((r) => r.flags.includes('overdue')).length,
        'no-next-action': rows.filter((r) => r.flags.includes('no-next-action')).length,
        'no-remarks': rows.filter((r) => r.flags.includes('no-remarks')).length,
      };

      expect((await summary(agent())).attention).toEqual(byFlags);
      expect(byFlags).toEqual({ overdue: 1, 'no-next-action': 1, 'no-remarks': 1 });
    });

    it('AC-4: a leader’s counts cover their downline and nothing else', async () => {
      await wired.leadRecords.create(ab(), { name: 'Agus’ own' });
      await wired.leadRecords.create(aab(), { name: 'Sari’s own' });
      await wired.leadRecords.create(agent(), { name: 'Rina’s' });
      await wired.leadRecords.create(sibling(), { name: 'Budi’s' });
      await wired.leadRecords.create(outsider(), { name: 'Lina’s' });

      expect((await summary(ab())).open).toBe(4);
      expect((await summary(aab())).open).toBe(3);
      expect((await summary(agent())).open).toBe(1);
      // The office has five; nobody but an administrator is told so.
      expect((await summary(outsider())).open).toBe(1);
    });

    it('AC-2: an Owner is told how many and never who', async () => {
      await wired.leadRecords.create(agent(), { name: 'Rina’s' });
      await wired.leadRecords.create(outsider(), { name: 'Lina’s' });
      const owner = ctxFor(AB, 'AB', { isKpmOwner: true, membershipId: '66f000000000000000000199' });

      // Counts: the whole office, because an office's administrator runs the office.
      expect((await summary(owner)).open).toBe(2);
      // Rows: none, at any scope — `lead:read` grants them nothing (§3.7).
      const rows = await wired.leadRecords.list(owner);
      expect(rows.rows).toEqual([]);
    });

    it('counts nothing for somebody the grant does not reach', async () => {
      await wired.leadRecords.create(agent(), { name: 'Rina’s' });
      // An office member holding no lead grant at all: fail-closed, not their own.
      const nobody = ctxFor('66f000000000000000000198', 'UNKNOWN_RUNG');

      expect((await summary(nobody)).open).toBe(0);
    });
  });

});
