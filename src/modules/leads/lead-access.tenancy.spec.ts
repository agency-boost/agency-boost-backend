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

  /*
   * A leader's write pins the version it read: required of anybody but the owner since P11-T4 AC-3, so
   * every leader write below carries one, as the coaching card's and `/leads`' do.
   */
  describe('AC-1 — a leader writes a downline’s lead, and the write carries their name', () => {
    it('lets an AAB reach their own unit', async () => {
      const theirs = await leadOf(agent());

      const edited = await wired.leadRecords.update(aab(), theirs.id, { remarks: 'Coached today.', version: theirs.version });

      expect(edited.remarks).toBe('Coached today.');
      expect(edited.ownerMembershipId).toBe(AGENT);
    });

    it('lets an AB reach anybody below them, not only their directs', async () => {
      const theirs = await leadOf(agent());

      const edited = await wired.leadRecords.update(ab(), theirs.id, { remarks: 'Reviewed.', version: theirs.version });

      expect(edited.ownerMembershipId).toBe(AGENT);
      expect(edited.remarks).toBe('Reviewed.');
    });

    it('records who moved it, which is not whose lead it is', async () => {
      const theirs = await leadOf(agent());
      const typed = await wired.leadRecords.update(aab(), theirs.id, { type: 'sales', version: theirs.version });

      await wired.leadRecords.setStatus(aab(), theirs.id, 'FOLLOW_UP', typed.version);

      const stored = await mongoose.connection.db!.collection('leads')
        .findOne({ _id: new mongoose.Types.ObjectId(theirs.id) });
      expect(stored!.transitions[0]).toMatchObject({
        toStatusCode: 'FOLLOW_UP', byMembershipId: AAB,
      });
      expect(stored!.ownerMembershipId).toBe(AGENT);
    });

    it('AC-2: names the leader on the lead, so the agent can tell whose change it was', async () => {
      const theirs = await leadOf(agent());
      await wired.leadRecords.update(aab(), theirs.id, { remarks: 'Coached today.', version: theirs.version });

      // Read by the **agent**, on their own screen. That is where the exit criterion is checked.
      const asTheAgent = await wired.leadRecords.read(agent(), theirs.id);

      expect(asTheAgent.lastEditedBy).toEqual({ membershipId: AAB, name: 'Ibu Sari' });
    });

    it('AC-2: says nothing when the last change was the agent’s own', async () => {
      const theirs = await leadOf(agent());
      await wired.leadRecords.update(aab(), theirs.id, { remarks: 'Coached today.', version: theirs.version });

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

    /*
     * *Rewritten 2026-11-08 (P19.9-T1 AC-2, AC-3; ADR-0232 §2–§3):* a leader's list held their own leads and their
     * downline's together. It holds their own now, and the downline's are `scope=team` — the same reach, in two lists.
     */
    it('lists a leader’s own leads, their downline’s on scope=team, and no others', async () => {
      await leadOf(ab(), 'Agus’ own');
      await leadOf(aab(), 'Sari’s own');
      await leadOf(agent(), 'Rina’s');
      await leadOf(sibling(), 'Budi’s');
      await leadOf(outsider(), 'Lina’s');

      const names = async (who: RequestContext, scope?: 'team') =>
        (await wired.leadRecords.list(who, scope ? { scope } : {})).rows.map((r) => r.name).sort();

      expect(await names(ab())).toEqual(['Agus’ own']);
      expect(await names(ab(), 'team')).toEqual(['Budi’s', 'Rina’s', 'Sari’s own']);
      expect(await names(aab())).toEqual(['Sari’s own']);
      expect(await names(aab(), 'team')).toEqual(['Budi’s', 'Rina’s']);
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

  /*
   * **One reach for a member's data, through `COACH`** (P11-T3, ADR-0074).
   *
   * `ownersInScope` read the AAB's `own-unit` as `{ leaderId: me }` and read no status, so a nested
   * AAB's agent's leads were out of reach while those of a member who had left were still in it. It
   * resolves through `CoachResolver.reach` now, as goals and activity do.
   */
  describe('P11-T3 — leads reach what COACH reaches', () => {
    const PEER_AAB = '66f000000000000000000107';
    const PEER_AGENT = '66f000000000000000000108';
    const NESTED_AAB = '66f000000000000000000109';
    const NESTED_AGENT = '66f00000000000000000010a';
    const LEFT = '66f00000000000000000010b';

    beforeEach(async () => {
      await mongoose.connection.db!.collection('memberships').insertMany([
        person(PEER_AAB, 'AAB', AB, [AB], 'Peer'),
        person(PEER_AGENT, 'AGENT', PEER_AAB, [AB, PEER_AAB], 'Peer agent'),
        person(NESTED_AAB, 'AAB', AAB, [AB, AAB], 'Nested'),
        person(NESTED_AGENT, 'AGENT', NESTED_AAB, [AB, AAB, NESTED_AAB], 'Nested agent'),
        person(LEFT, 'AGENT', AAB, [AB, AAB], 'Left'),
      ] as never);
    });

    it('P11-T3 AC-5 aab_cannot_coach_peer_unit: an AAB cannot reach a peer AAB’s leads', async () => {
      const theirs = await leadOf(ctxFor(PEER_AGENT, 'AGENT'), 'Peer’s lead');

      await expect(wired.leadRecords.read(aab(), theirs.id)).rejects.toMatchObject({ code: 'NOT_FOUND', status: 404 });
      await expect(wired.leadRecords.update(aab(), theirs.id, { remarks: 'Taken' }))
        .rejects.toMatchObject({ code: 'NOT_FOUND', status: 404 });
      expect((await wired.leadRecords.list(aab(), { scope: 'team' })).rows.map((r) => r.name)).not.toContain('Peer’s lead');
    });

    it('P11-T3 ADR-0074: an AAB reaches a nested AAB’s agent’s lead — `own-unit` is the subtree for a member’s data', async () => {
      const theirs = await leadOf(ctxFor(NESTED_AGENT, 'AGENT'), 'Nested agent’s lead');

      const edited = await wired.leadRecords.update(aab(), theirs.id, { remarks: 'Coached.', version: theirs.version });

      expect(edited).toMatchObject({ ownerMembershipId: NESTED_AGENT, remarks: 'Coached.' });
      expect((await wired.leadRecords.list(aab(), { scope: 'team' })).rows.map((r) => r.name)).toContain('Nested agent’s lead');
    });

    it('P11-T3 AC-2: a leader no longer reaches the leads of a member who has left (§6.1, §6.7)', async () => {
      const theirs = await leadOf(ctxFor(LEFT, 'AGENT'), 'Left’s lead');
      await mongoose.connection.db!.collection('memberships').updateOne(
        { _id: new mongoose.Types.ObjectId(LEFT), kpmId: KPM }, { $set: { status: 'removed' } },
      );

      await expect(wired.leadRecords.read(aab(), theirs.id)).rejects.toMatchObject({ code: 'NOT_FOUND', status: 404 });
      expect((await wired.leadRecords.list(ab(), { scope: 'team' })).rows.map((r) => r.name)).not.toContain('Left’s lead');
    });
  });

  /*
   * **OD-107, option 1 (decided 2026-10-02): a leader's list of a downline's rows is a subject read.**
   * One §3.5 entry per owner other than the caller whose rows the answer holds, surface `leads`, and
   * none for the caller's own: the same record `GET /leads?owner=` leaves, so neither route steps round it.
   */
  /*
   * **P19.9-T1 — *Leads milik: Saya · Tim*** (R9, R10; ADR-0232; OD-286 by its default): `/leads` opens on the reader's
   * own leads and offers the team's in its filter; every row names its owner. `scope` narrows what the grant reaches,
   * never widens it, and the §3.5 entry per owner shown is as it was (ADR-0089).
   */
  describe('P19.9-T1 AC-2, AC-3, AC-4 — scope=own, scope=team and the owner on every row', () => {
    const names = (page: { rows: { name: string }[] }) => page.rows.map((r) => r.name).sort();
    const reads = async () => mongoose.connection.db!.collection('auditLog')
      .find({ action: 'activity_log.read_raw', 'after.surface': 'leads' }).toArray();

    beforeEach(async () => {
      await leadOf(ab(), 'Agus’ own');
      await leadOf(aab(), 'Sari’s own');
      await leadOf(agent(), 'Rina’s');
      await leadOf(sibling(), 'Budi’s');
      await leadOf(outsider(), 'Lina’s');
    });

    it('P19.9-T1 AC-2 scope=own is the reader’s own leads alone, for a leader as for an agent — and records nobody', async () => {
      expect(names(await wired.leadRecords.list(ab(), { scope: 'own' }))).toEqual(['Agus’ own']);
      expect(names(await wired.leadRecords.list(aab(), { scope: 'own' }))).toEqual(['Sari’s own']);
      expect(names(await wired.leadRecords.list(agent(), { scope: 'own' }))).toEqual(['Rina’s']);
      expect(await reads()).toEqual([]);
    });

    it('P19.9-T1 AC-3 OD-286 scope=team is everybody the grant reaches but the reader: an AB’s downline, an AAB’s unit', async () => {
      expect(names(await wired.leadRecords.list(ab(), { scope: 'team' }))).toEqual(['Budi’s', 'Rina’s', 'Sari’s own']);
      expect(names(await wired.leadRecords.list(aab(), { scope: 'team' }))).toEqual(['Budi’s', 'Rina’s']);
      // Never wider than the grant: the outsider's lead is in no team.
      expect(names(await wired.leadRecords.list(ab(), { scope: 'team' }))).not.toContain('Lina’s');
    });

    it('P19.9-T1 AC-3 an Agent’s grant reaches nobody else: scope=team is an empty page, never a colleague’s', async () => {
      expect(await wired.leadRecords.list(agent(), { scope: 'team' })).toMatchObject({ rows: [], total: 0 });
      expect(await wired.leadRecords.list(outsider(), { scope: 'team' })).toMatchObject({ rows: [], total: 0 });
    });

    it('P19.9-T1 AC-2 absent, the list is the reader’s own (ADR-0232 §2) — where it was their whole reach', async () => {
      expect(names(await wired.leadRecords.list(ab()))).toEqual(names(await wired.leadRecords.list(ab(), { scope: 'own' })));
      expect(names(await wired.leadRecords.list(aab()))).toEqual(['Sari’s own']);
      expect(await reads()).toEqual([]);
    });

    it('P19.9-T1 AC-3 absent beside owner=, the coaching tab’s list is that member’s, as it was', async () => {
      expect(names(await wired.leadRecords.list(ab(), { owner: AGENT }))).toEqual(['Rina’s']);
      expect(names(await wired.leadRecords.list(ab(), { owner: AB }))).toEqual(['Agus’ own']);
    });

    it('P19.9-T1 AC-3 the closed lists narrow the same way: a downline’s won lead is Tim’s, never Saya’s', async () => {
      const rina = await wired.leadRecords.list(agent());
      const won = await wired.leadRecords.update(agent(), rina.rows[0].id, { type: 'recruitment' });
      await wired.leadRecords.setStatus(agent(), won.id, 'NEW_ACTIVE_AGENT', won.version);
      await wired.leadRecords.setOutcome(agent(), won.id, 'won');
      expect(names(await wired.leadRecords.list(ab(), { scope: 'own', outcome: 'won' }))).toEqual([]);
      expect(names(await wired.leadRecords.list(ab(), { scope: 'team', outcome: 'won' }))).toEqual(['Rina’s']);
    });

    it('P19.9-T1 AC-3 scope narrows owner= and never widens it: a coachee under own is nothing, yourself under team is nothing', async () => {
      expect(names(await wired.leadRecords.list(ab(), { owner: AGENT, scope: 'team' }))).toEqual(['Rina’s']);
      expect(await wired.leadRecords.list(ab(), { owner: AGENT, scope: 'own' })).toMatchObject({ rows: [], total: 0 });
      expect(await wired.leadRecords.list(ab(), { owner: AB, scope: 'team' })).toMatchObject({ rows: [], total: 0 });
      // owner= outside the reach is still the 404 it was, whatever the scope.
      await expect(wired.leadRecords.list(aab(), { owner: OUTSIDER, scope: 'team' })).rejects.toMatchObject({ status: 404 });
    });

    it('P19.9-T1 AC-3 ADR-0089 a leader’s Tim writes one leads entry per owner shown, and Saya none', async () => {
      await wired.leadRecords.list(aab(), { scope: 'own' });
      expect(await reads()).toEqual([]);
      await wired.leadRecords.list(aab(), { scope: 'team' });
      expect((await reads()).map((e) => e.targetMembershipId).sort()).toEqual([AGENT, SIBLING].sort());
    });

    it('P19.9-T1 AC-3 with Sudah ada proposal, Tim holds nothing: a proposal is its owner’s alone', async () => {
      expect(await wired.leadRecords.list(ab(), { scope: 'team', hasProposal: 'false' })).toMatchObject({ rows: [], total: 0 });
      expect(names(await wired.leadRecords.list(ab(), { scope: 'own', hasProposal: 'false' }))).toEqual(['Agus’ own']);
    });

    it('P19.9-T1 AC-4 every row names its owner — the reader’s own included — on the list, a read and a write', async () => {
      const team = await wired.leadRecords.list(ab(), { scope: 'team' });
      expect(team.rows.map((r) => [r.name, r.owner]).sort()).toEqual([
        ['Budi’s', { membershipId: SIBLING, name: 'Budi Santoso' }],
        ['Rina’s', { membershipId: AGENT, name: 'Rina Wijaya' }],
        ['Sari’s own', { membershipId: AAB, name: 'Ibu Sari' }],
      ]);
      const [own] = (await wired.leadRecords.list(ab(), { scope: 'own' })).rows;
      expect(own.owner).toEqual({ membershipId: AB, name: 'Pak Agus' });
      const rina = team.rows.find((r) => r.ownerMembershipId === AGENT)!;
      expect((await wired.leadRecords.read(ab(), rina.id)).owner).toEqual({ membershipId: AGENT, name: 'Rina Wijaya' });
      const edited = await wired.leadRecords.update(ab(), rina.id, { remarks: 'Coached.', version: rina.version });
      expect(edited.owner).toEqual({ membershipId: AGENT, name: 'Rina Wijaya' });
      expect((await leadOf(agent(), 'Rina’s new')).owner).toEqual({ membershipId: AGENT, name: 'Rina Wijaya' });
    });
  });

  describe('OD-107 — the list writes the §3.5 entry per other owner shown', () => {
    const reads = async () => mongoose.connection.db!.collection('auditLog')
      .find({ action: 'activity_log.read_raw' }).toArray();

    it('OD-107 a leader’s list writes one leads entry per downline owner shown, and none for their own rows', async () => {
      await leadOf(ab(), 'Agus’ own');
      await leadOf(aab(), 'Sari’s own');
      await leadOf(agent(), 'Rina’s first');
      await leadOf(agent(), 'Rina’s second');
      await leadOf(sibling(), 'Budi’s');
      await leadOf(outsider(), 'Lina’s');

      // The downline's rows are *Tim*'s since P19.9-T1 (ADR-0232 §3); its entries are as they were (ADR-0089).
      await wired.leadRecords.list(ab(), { scope: 'team' });

      const entries = await reads();
      // Rina's two rows are one disclosure of Rina: one entry, not one per row.
      expect(entries.map((e) => e.targetMembershipId).sort()).toEqual([AAB, AGENT, SIBLING].sort());
      for (const entry of entries) {
        expect(entry).toMatchObject({
          kpmId: KPM, actorMembershipId: AB, targetCollection: 'memberships',
          after: { surface: 'leads', from: null, to: '2026-09-25' },
        });
        expect(entry.targetId).toBe(entry.targetMembershipId);
      }
    });

    it('OD-107 an agent’s own list, and a leader’s list holding only their own rows, write nothing', async () => {
      await leadOf(agent(), 'Rina’s');
      await leadOf(aab(), 'Sari’s own');

      await wired.leadRecords.list(agent());
      await wired.leadRecords.list(aab(), { search: 'Sari' });

      expect(await reads()).toEqual([]);
    });

    it('OD-107 only the owners on the page answered are recorded, not every owner the filter matched', async () => {
      await leadOf(agent(), 'Rina’s');
      await leadOf(sibling(), 'Budi’s');

      const page = await wired.leadRecords.list(aab(), { scope: 'team', pageSize: 1 });

      expect(page.total).toBe(2);
      expect((await reads()).map((e) => e.targetMembershipId)).toEqual([page.rows[0].ownerMembershipId]);
    });

    it('OD-107 an empty answer records nobody', async () => {
      await leadOf(agent(), 'Rina’s');

      await wired.leadRecords.list(ab(), { search: 'nobody by this name' });

      expect(await reads()).toEqual([]);
    });

    /*
     * ADR-0089's propagation, P11-T10 AC-11: **the list's own tests** for the two halves of *written last*
     * — a refused read records nothing, and a failed record does not refuse the read (D-failopen). The
     * seam's own fail-open is `subject-read-audit.spec.ts`'s; these hold the list to it.
     */
    it('P11-T10 AC-11 a refused read writes nothing: a caller with no office, and an owner outside the leader’s reach', async () => {
      await leadOf(agent(), 'Rina’s');
      await leadOf(outsider(), 'Lina’s');

      await expect(wired.leadRecords.list(RequestContext.platform('root')))
        .rejects.toMatchObject({ code: 'TENANT_NO_MEMBERSHIP' });
      await expect(wired.leadRecords.list(aab(), { owner: OUTSIDER })).rejects.toMatchObject({ status: 404 });

      expect(await reads()).toEqual([]);
    });

    it('P11-T10 AC-11 a read that fails after its rows were found writes nothing: the entry follows the answer', async () => {
      await leadOf(agent(), 'Rina’s');
      await leadOf(sibling(), 'Budi’s');
      // The *Status* sort reads the published ladders once the rows are in hand; that read fails here.
      const failing = jest.spyOn(wired.config, 'readPublished').mockRejectedValue(new Error('the config store is down'));
      try {
        await expect(wired.leadRecords.list(ab(), { scope: 'team', sort: 'status' })).rejects.toThrow('the config store is down');
      } finally {
        failing.mockRestore();
      }

      expect(await reads()).toEqual([]);
    });

    it('P11-T10 AC-11 the list fails open: an entry that fails to write still answers the leader’s list', async () => {
      await leadOf(agent(), 'Rina’s');
      await leadOf(sibling(), 'Budi’s');
      const failing = jest.spyOn(wired.audit, 'record').mockRejectedValue(new Error('the audit store is down'));
      let page;
      try {
        page = await wired.leadRecords.list(ab(), { scope: 'team' });
        // One attempt per downline owner shown, each refused by the store.
        expect(failing).toHaveBeenCalledTimes(2);
      } finally {
        failing.mockRestore();
      }

      expect(page.rows.map((row) => row.ownerMembershipId).sort()).toEqual([AGENT, SIBLING].sort());
      expect(await reads()).toEqual([]);
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
   *
   * **The route went in P10.1-T4 and these stay.** `LeadService.summary` is the only computation of
   * `RECRUITMENT_PIPELINE_NOW` and `RECRUITMENT_EXPECTED_TO_CLOSE`, which the registry says are
   * computed from Phase 7. Until another screen reads them, these tests are what keeps that true.
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
