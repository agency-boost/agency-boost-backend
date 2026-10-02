import mongoose from 'mongoose';
import { RequestContext } from '@/common/context/request-context';
import { clearCollections, startMongo, stopMongo } from '../../../test/mongo';
import { configModule } from '../../../test/config-module';
import { Goal } from './goal.schema';

const NOW = new Date('2026-09-26T02:00:00Z');
const KPM = '66f0000000000000000000a1';

const AB = '66f000000000000000000101';
const AAB = '66f000000000000000000102';
const AGENT = '66f000000000000000000103';
const SIBLING = '66f000000000000000000104';
const OUTSIDER = '66f000000000000000000105';

const NAMES: Record<string, string> = {
  [AB]: 'Pak Agus', [AAB]: 'Ibu Sari', [AGENT]: 'Rina Wijaya',
  [SIBLING]: 'Budi Santoso', [OUTSIDER]: 'Lina Marlina',
};

const ctxFor = (membershipId: string, orgLevelCode: string, over: Record<string, unknown> = {}) =>
  new RequestContext('u-' + membershipId, 'none', {
    membershipId, kpmId: KPM, orgLevelCode,
    hierarchyRole: orgLevelCode.toLowerCase(),
    status: 'active', isKpmOwner: false, isKpmAdmin: false, directCount: 1,
    ...over,
  } as never);

/**
 * Who may set whose goal (P8-T4, ADR-0046).
 *
 * **§3.6 is wider than §3.7, and on purpose.** An office's Owner and Admin read and set goals
 * across the office, where on a *lead* they get counts and no rows — because a lead carries a third
 * party's name and phone number and a goal carries an agent's own intentions about their own
 * production. This file is where that difference is asserted rather than assumed.
 */
describe('who may set whose goal (P8-T4)', () => {
  let wired: ReturnType<typeof configModule>;

  beforeAll(async () => {
    await startMongo();
    wired = configModule(NOW);
  });
  afterAll(stopMongo);

  beforeEach(async () => {
    await clearCollections();
    await mongoose.model(Goal.name).syncIndexes();
    wired.sentNotifications.length = 0;
    await mongoose.connection.db!.collection('memberships').insertMany([
      person(AB, 'AB', null, []),
      person(AAB, 'AAB', AB, [AB]),
      person(AGENT, 'AGENT', AAB, [AB, AAB]),
      person(SIBLING, 'AGENT', AAB, [AB, AAB]),
      // Under nobody these leaders reach.
      person(OUTSIDER, 'AGENT', null, []),
    ] as never);
    await mongoose.connection.db!.collection('users').insertMany(
      Object.keys(NAMES).map((id) => ({
        _id: new mongoose.Types.ObjectId('66f00000000000000000020' + id.slice(-1)),
        email: `${id}@kpm.test`, fullName: NAMES[id], deletedAt: null,
      })) as never,
    );
  });

  function person(id: string, rung: string, leaderId: string | null, ancestors: string[]) {
    return {
      _id: new mongoose.Types.ObjectId(id),
      kpmId: KPM,
      userId: '66f00000000000000000020' + id.slice(-1),
      leaderCode: `LC-${id.slice(-3)}`,
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
  const owner = () => ctxFor(AB, 'AB', { membershipId: AB, isKpmOwner: true });
  const admin = () => ctxFor(AB, 'AB', { membershipId: AB, isKpmAdmin: true });

  const plan = (over: Record<string, unknown> = {}) => ({
    period: '2026',
    mode: 'direct',
    annualApeTargetMinor: 500_000_000_00,
    savingsTargetMinor: 50_000_000_00,
    commissionRatePct: 10,
    monthsLeft: 5,
    apeAchievedMinor: 0,
    caseSizeMinor: 18_000_000_00,
    leadsToApptPct: 30,
    closingRatePct: 30,
    ...over,
  });

  const save = (who: RequestContext, forWhom?: string, over: Record<string, unknown> = {}) =>
    wired.goals.save(who, plan(over), forWhom);

  describe('AC-1 — a leader saves a downline’s goal, and it carries their name', () => {
    it('lets an AAB set somebody in their own unit', async () => {
      const saved = await save(aab(), AGENT, { annualApeTargetMinor: 750_000_000_00 });

      expect(saved.membershipId).toBe(AGENT);
      expect(saved.savedByMembershipId).toBe(AAB);
      expect(saved.annualApeTargetMinor).toBe(750_000_000_00);
    });

    it('lets an AB set anybody below them, not only their directs', async () => {
      const saved = await save(ab(), AGENT);

      expect(saved.membershipId).toBe(AGENT);
      expect(saved.savedByMembershipId).toBe(AB);
    });

    it('is the agent’s goal immediately — there is nothing to accept (ADR-0046)', async () => {
      await save(aab(), AGENT, { annualApeTargetMinor: 750_000_000_00 });

      // Read by the agent themselves: what their leader saved is what they have.
      const theirs = await wired.goals.read(agent(), '2026');
      expect(theirs.annualApeTargetMinor).toBe(750_000_000_00);
      expect(theirs).not.toHaveProperty('acceptedByAgentAt');
    });

    it('records the setter without becoming the owner', async () => {
      await save(aab(), AGENT);

      const row = await mongoose.connection.db!.collection('goals')
        .findOne({ kpmId: KPM, membershipId: AGENT });
      expect(row!.membershipId).toBe(AGENT);
      expect(row!.savedByMembershipId).toBe(AAB);
    });
  });

  describe('AC-3 — outside the grant is a 404, never a 403', () => {
    it('keeps an AAB out of another unit', async () => {
      await expect(save(aab(), OUTSIDER)).rejects.toMatchObject({ code: 'NOT_FOUND', status: 404 });
      await expect(wired.goals.read(aab(), '2026', OUTSIDER))
        .rejects.toMatchObject({ code: 'NOT_FOUND' });
    });

    it('keeps an AB out of somebody not below them', async () => {
      await expect(save(ab(), OUTSIDER)).rejects.toMatchObject({ code: 'NOT_FOUND' });
    });

    it('keeps one agent out of a colleague’s', async () => {
      await expect(save(agent(), SIBLING)).rejects.toMatchObject({ code: 'NOT_FOUND' });
      await expect(wired.goals.read(agent(), '2026', SIBLING))
        .rejects.toMatchObject({ code: 'NOT_FOUND' });
    });

    it('answers 404 for a membership that does not exist, even at own-kpm', async () => {
      // Without this an Owner could probe ids and tell a real one from an invented one by the
      // shape of the answer. The leads module learned it the same way, one phase earlier.
      await expect(save(owner(), '66f0000000000000000000ff'))
        .rejects.toMatchObject({ code: 'NOT_FOUND' });
    });

    it('keeps an Owner out of a real membership in another office', async () => {
      // The sharper version of the test above, and the one that proves the *scope* of the lookup
      // rather than its existence: this id resolves, so an unscoped `findById` would accept it.
      // An Owner holds `own-kpm`, which means `CoachResolver.subject` answers "anybody" — and
      // anybody means anybody **here**.
      const FOREIGN = '66f000000000000000000106';
      await mongoose.connection.db!.collection('memberships').insertOne({
        ...person(FOREIGN, 'AGENT', null, []),
        kpmId: '66f0000000000000000000b2',
      } as never);

      await expect(save(owner(), FOREIGN))
        .rejects.toMatchObject({ code: 'NOT_FOUND', status: 404 });
      await expect(wired.goals.read(owner(), '2026', FOREIGN))
        .rejects.toMatchObject({ code: 'NOT_FOUND', status: 404 });
    });
  });

  describe('AC-5 — what §3.6 grants each of the six', () => {
    it('lets the Owner set anybody in the office', async () => {
      const saved = await save(owner(), OUTSIDER);

      expect(saved.membershipId).toBe(OUTSIDER);
      expect(saved.savedByMembershipId).toBe(AB);
    });

    it('lets the Admin do the same — a goal carries no third party’s data', async () => {
      const saved = await save(admin(), OUTSIDER);

      expect(saved.membershipId).toBe(OUTSIDER);
    });

    it('lets every rung keep their own', async () => {
      for (const who of [ab(), aab(), agent(), sibling(), outsider()]) {
        const mine = await save(who);
        expect(mine.membershipId).toBe(who.membershipId);
        expect(mine.savedByMembershipId).toBe(who.membershipId);
      }
    });

    it('refuses somebody holding no grant at all, rather than falling back to their own', async () => {
      // Fail-closed. The first version of the equivalent for leads returned the caller's own set,
      // which quietly granted on the strength of an absent permission.
      const nobody = ctxFor('66f000000000000000000199', 'UNKNOWN_RUNG');

      await expect(save(nobody, AGENT)).rejects.toMatchObject({ code: 'NOT_FOUND' });
    });
  });

  /*
   * **One reach for a member's data, through `COACH`** (P11-T3, ADR-0074).
   *
   * Until P11-T3 the AAB's `own-unit` resolved here as `{ leaderId: me }` — direct reports only —
   * and no status was read, so a nested AAB's agent was out of reach while a member who had left was
   * still in it. Both now resolve through `CoachResolver`, which leads, activity and coaching read
   * too. Phase 10's carry-forward #2 is the first test: no goal test named a peer AAB.
   */
  describe('P11-T3 — goals reach what COACH reaches', () => {
    const PEER_AAB = '66f000000000000000000107';
    const PEER_AGENT = '66f000000000000000000108';
    const NESTED_AAB = '66f000000000000000000109';
    const NESTED_AGENT = '66f00000000000000000010a';
    const LEFT = '66f00000000000000000010b';

    beforeEach(async () => {
      await mongoose.connection.db!.collection('memberships').insertMany([
        person(PEER_AAB, 'AAB', AB, [AB]),
        person(PEER_AGENT, 'AGENT', PEER_AAB, [AB, PEER_AAB]),
        // An AAB leading an AAB: nothing forbids it, and a promotion keeps its edge (ADR-0014).
        person(NESTED_AAB, 'AAB', AAB, [AB, AAB]),
        person(NESTED_AGENT, 'AGENT', NESTED_AAB, [AB, AAB, NESTED_AAB]),
        // Removed: the cache still names their leaders (map finding 3), and the status is the answer.
        { ...person(LEFT, 'AGENT', AAB, [AB, AAB]), status: 'removed' },
      ] as never);
    });

    it('P11-T3 AC-5 aab_cannot_coach_peer_unit: an AAB cannot reach a peer AAB’s unit through goals', async () => {
      for (const peer of [PEER_AAB, PEER_AGENT]) {
        await expect(save(aab(), peer)).rejects.toMatchObject({ code: 'NOT_FOUND', status: 404 });
        await expect(wired.goals.read(aab(), '2026', peer))
          .rejects.toMatchObject({ code: 'NOT_FOUND', status: 404 });
        await expect(wired.goals.readOrDefaults(aab(), '2026', peer))
          .rejects.toMatchObject({ code: 'NOT_FOUND', status: 404 });
      }
      // Nor the other way round.
      await expect(save(ctxFor(PEER_AAB, 'AAB'), AGENT)).rejects.toMatchObject({ status: 404 });
      expect(wired.sentNotifications).toHaveLength(0);
    });

    it('P11-T3 ADR-0074: an AAB sets a nested AAB’s agent’s goal — `own-unit` is the subtree for a member’s data', async () => {
      const saved = await save(aab(), NESTED_AGENT);

      expect(saved).toMatchObject({ membershipId: NESTED_AGENT, savedByMembershipId: AAB });
      await expect(wired.goals.read(aab(), '2026', NESTED_AGENT))
        .resolves.toMatchObject({ membershipId: NESTED_AGENT });
      // The nested AAB keeps their own unit, and reaches nothing above it.
      await expect(wired.goals.read(ctxFor(NESTED_AAB, 'AAB'), '2026', NESTED_AGENT))
        .resolves.toMatchObject({ membershipId: NESTED_AGENT });
      await expect(save(ctxFor(NESTED_AAB, 'AAB'), AGENT)).rejects.toMatchObject({ status: 404 });
    });

    it('P11-T3 AC-2: no leader reaches the goal of a member who has left — the office does (§6.7)', async () => {
      await expect(save(aab(), LEFT)).rejects.toMatchObject({ code: 'NOT_FOUND', status: 404 });
      await expect(wired.goals.readOrDefaults(ab(), '2026', LEFT))
        .rejects.toMatchObject({ code: 'NOT_FOUND', status: 404 });
      await expect(wired.goals.readOrDefaults(owner(), '2026', LEFT))
        .resolves.toMatchObject({ savedAt: null });
    });
  });

  describe('AC-7 — the agent is told', () => {
    it('announces a leader’s write to the agent whose goal it is', async () => {
      await save(aab(), AGENT);

      expect(wired.sentNotifications).toHaveLength(1);
      expect(wired.sentNotifications[0]).toMatchObject({
        templateId: 'goal.set_by_leader',
        membershipId: AGENT,
        kpmId: KPM,
        payload: { byName: 'Ibu Sari', period: '2026' },
      });
    });

    it('says nothing when the agent saved it themselves', async () => {
      await save(agent());

      expect(wired.sentNotifications).toHaveLength(0);
    });

    it('announces an Owner’s write too — §3.6 grants it, so the agent hears about it', async () => {
      await save(owner(), OUTSIDER);

      expect(wired.sentNotifications).toHaveLength(1);
      expect(wired.sentNotifications[0]).toMatchObject({ membershipId: OUTSIDER });
    });

    it('names the office rather than nobody when the setter cannot be resolved', async () => {
      // The setter's own user row, built the way the fixture builds it.
      await mongoose.connection.db!.collection('users')
        .deleteOne({ _id: new mongoose.Types.ObjectId('66f00000000000000000020' + AAB.slice(-1)) });

      await save(aab(), AGENT);

      expect(wired.sentNotifications[0]).toMatchObject({ payload: { byName: null } });
    });
  });

  describe('reading somebody else’s', () => {
    it('offers the office’s defaults for a downline who has no goal yet', async () => {
      const offered = await wired.goals.readOrDefaults(aab(), '2026', AGENT);

      expect(offered.savedAt).toBeNull();
      expect(offered.projected!.leadsPerMonth).toBeGreaterThan(0);
    });

    it('reads a downline’s goal once there is one', async () => {
      await save(aab(), AGENT, { annualApeTargetMinor: 750_000_000_00 });

      const read = await wired.goals.readOrDefaults(aab(), '2026', AGENT);

      expect(read.annualApeTargetMinor).toBe(750_000_000_00);
      expect(read.savedByMembershipId).toBe(AAB);
    });
  });
});
