import mongoose from 'mongoose';
import { FixedClock } from '@/common/clock/clock.port';
import { RequestContext } from '@/common/context/request-context';
import { AuditLog, AuditLogSchema } from '@/modules/audit/audit-log.schema';
import { AuditService } from '@/modules/audit/audit.service';
import { HierarchyService } from '@/modules/org/hierarchy.service';
import { MembershipHistory, MembershipHistorySchema } from '@/modules/org/membership-history.schema';
import { MembershipRepository } from '@/modules/org/membership.repository';
import { Membership, MembershipSchema } from '@/modules/org/membership.schema';
import { MembershipHistoryRepository } from '@/modules/org/org.repositories';
import { REMOVAL_CONFIRMATION, RemovalService } from '@/modules/org/removal.service';
import { RoleChangeService } from '@/modules/org/role-change.service';
import { CompanyOrgLevel, CompanyOrgLevelSchema } from '@/modules/tenants/company-org-level.schema';
import { Company, CompanySchema } from '@/modules/tenants/company.schema';
import { Kpm, KpmSchema } from '@/modules/tenants/kpm.schema';
import { OrgLevelService } from '@/modules/tenants/org-level.service';
import { User, UserSchema } from '@/modules/users/user.schema';
import { clearCollections, seedLadder, startMongo, stopMongo, syncIndexes } from '../../../test/mongo';
import { configModule } from '../../../test/config-module';

const NOW = new Date('2026-10-02T03:00:00Z');
const KPM_A = new mongoose.Types.ObjectId().toString();

type Rung = 'AB' | 'AAB' | 'AGENT';
type Name = 'ROOT' | 'AB' | 'AB2' | 'AAB' | 'AGENT';

const as = (membershipId: string, rung: Rung, over: Record<string, unknown> = {}) =>
  new RequestContext(`u-${membershipId}`, 'none', {
    membershipId, kpmId: KPM_A, orgLevelCode: rung, hierarchyRole: rung.toLowerCase(),
    status: 'active', isKpmOwner: false, isKpmAdmin: false, directCount: 1, ...over,
  } as never);

/**
 * **A former coach reads only what they led** (P11-T5 AC-11, carried from P11-T3 AC-9; ADR-0082; roles
 * §7.2 `former_leader_reads_only_what_they_led`).
 *
 * The office is built through `HierarchyService.create`, and the leader edge is closed through the org
 * services that close one — once by a re-parent, once by a removal — so `COACH` ends exactly as it does
 * in the product. Office A:
 *
 * ```
 * ROOT (AB, the Owner as well)
 * ├── AB ── AAB ── AGENT       Agent's sessions: the AAB's, and one the AB led
 * └── AB2                      the new leader, after the re-parent
 * ```
 */
describe('a former coach reads only what they led (P11-T5 AC-11)', () => {
  let wired: ReturnType<typeof configModule>;
  let hierarchy: HierarchyService;
  let removals: RemovalService;
  let m: Record<Name, string>;
  let seq = 0;
  const col = (name: string) => mongoose.connection.db!.collection(name);
  const rung: Record<Name, Rung> = { ROOT: 'AB', AB: 'AB', AB2: 'AB', AAB: 'AAB', AGENT: 'AGENT' };
  const ctx = (who: Name) => as(m[who], rung[who], who === 'ROOT' ? { isKpmOwner: true } : {});

  beforeAll(async () => {
    await startMongo();
    const clock = new FixedClock(NOW);
    const audit = new AuditService(mongoose.model(AuditLog.name, AuditLogSchema) as never);
    const kpms = mongoose.model(Kpm.name, KpmSchema);
    const users = mongoose.model(User.name, UserSchema);
    const history = new MembershipHistoryRepository(mongoose.model(MembershipHistory.name, MembershipHistorySchema) as never);
    const members = new MembershipRepository(mongoose.model(Membership.name, MembershipSchema) as never);
    const orgLevels = new OrgLevelService(
      mongoose.model(CompanyOrgLevel.name, CompanyOrgLevelSchema) as never,
      mongoose.model(Company.name, CompanySchema) as never, kpms as never, audit, clock,
    );
    hierarchy = new HierarchyService(members, kpms as never, users as never, history, clock, orgLevels);
    const notifications = { send: async () => undefined };
    const roles = new RoleChangeService(members, hierarchy, history, users as never, audit, notifications as never, clock);
    removals = new RemovalService(members, hierarchy, roles, history, audit, notifications as never, clock);
    wired = configModule(NOW);
    await syncIndexes();
  });
  afterAll(stopMongo);

  beforeEach(async () => {
    await clearCollections();
    (wired.clock as FixedClock).set(NOW);
    seq += 1;
    const company = await mongoose.model(Company.name).create({ name: 'Prudential', slug: `pru-coach-${seq}` });
    const companyId = String(company._id);
    await seedLadder(companyId);
    await mongoose.model(Kpm.name).create({
      _id: KPM_A, companyId, code: '0417', branchName: 'Branch 0417', timezone: 'Asia/Jakarta',
      counters: { nextMemberSeq: 1 }, status: 'active',
    });
    const join = async (role: 'ab' | 'aab' | 'agent', leaderId: string | null) => {
      seq += 1;
      const user = await mongoose.model(User.name).create({
        email: `former${seq}@kpm.test`, passwordHash: 'x', fullName: `Person ${seq}`, status: 'active',
        platformRole: 'none', companyId, agentCode: `PRU-${7000 + seq}`,
      });
      const placed = await hierarchy.create(as('mem-placer', 'AB', { isKpmOwner: true }), {
        userId: String(user._id), role, leaderId, status: 'active',
      });
      return String(placed._id);
    };
    const root = await join('ab', null);
    const ab = await join('ab', root);
    const aab = await join('aab', ab);
    m = { ROOT: root, AB: ab, AB2: await join('ab', root), AAB: aab, AGENT: await join('agent', aab) };
  });

  /** A finalized session of `coach`'s with the agent, through the service. */
  async function finalized(coach: Name, text: string) {
    // A minute apart, so *last week* — the newest by date, then by first finalize — is never a tie.
    (wired.clock as FixedClock).advance(60_000);
    const { session } = await wired.coachingSession.start(ctx(coach), m.AGENT);
    const saved = await wired.coachingSession.save(ctx(coach), session.sessionId, {
      version: session.version, lastWeekItems: [], actionItems: [{ text, dueDate: '2026-10-09' }], tips: [],
    });
    return wired.coachingSession.finalize(ctx(coach), session.sessionId, saved.version);
  }

  /**
   * The AAB's three — one finalized, one under correction, one left as a draft — and one the AB led,
   * with a lead of the agent's dated so *From leads* has something to derive.
   */
  async function sessions() {
    const lead = new mongoose.Types.ObjectId();
    await col('leads').insertOne({
      _id: lead, kpmId: KPM_A, ownerMembershipId: m.AGENT, type: 'sales', name: 'Ibu Melati', commitments: [],
      nextActionDate: '2026-10-05', nextActionNote: 'Collect the SPAJ.', outcome: null, version: 1, transitions: [],
      dateRegistered: new Date('2026-09-01T02:00:00Z'), deletedAt: null,
    });
    const led = await finalized('AAB', 'Led and finalized');
    const corrected = await finalized('AAB', 'Agreed before the correction');
    await wired.coachingSession.reopen(ctx('AAB'), corrected.sessionId, { version: corrected.version, reason: 'A date was wrong.' });
    const byAb = await finalized('AB', 'The AB’s own 1:1');
    const draft = (await wired.coachingSession.start(ctx('AAB'), m.AGENT)).session;
    // The agent's lead moves after: a reader with no grant on new data must not see it.
    await col('leads').updateOne({ _id: lead }, { $set: { nextActionDate: '2026-10-20' } });
    return { led, corrected, byAb, draft };
  }

  const notFound = { status: 404, code: 'NOT_FOUND' };

  async function readsOnlyWhatTheyLed(s: Awaited<ReturnType<typeof sessions>>) {
    const aab = ctx('AAB');
    const svc = wired.coachingSession;

    // The finalized versions of each session they led.
    expect(await svc.read(aab, s.led.sessionId)).toMatchObject({
      status: 'finalized', actionItems: [{ text: 'Led and finalized' }], reopenableUntil: null,
    });
    // A session under correction answers its latest finalized version, with no lead action derived now.
    const correction = await svc.read(aab, s.corrected.sessionId);
    expect(correction).toMatchObject({
      status: 'finalized', version: s.corrected.version, actionItems: [{ text: 'Agreed before the correction' }], earlier: [],
    });
    expect(correction.leadActions).toEqual([
      { leadId: expect.any(String), leadName: 'Ibu Melati', dueDate: '2026-10-05', text: 'Collect the SPAJ.' },
    ]);
    // The history lists those sessions and no other.
    const listed = await svc.history(aab, m.AGENT);
    expect(listed.current).toBeNull();
    expect(listed.sessions.map((row) => row.sessionId).sort()).toEqual([s.led.sessionId, s.corrected.sessionId].sort());

    // 404 on a draft they left, on a session somebody else led, on starting one, and on every write.
    await expect(svc.read(aab, s.draft.sessionId)).rejects.toMatchObject(notFound);
    await expect(svc.read(aab, s.byAb.sessionId)).rejects.toMatchObject(notFound);
    await expect(svc.start(aab, m.AGENT)).rejects.toMatchObject(notFound);
    const body = { version: s.draft.version, lastWeekItems: [], actionItems: [], tips: [] };
    await expect(svc.save(aab, s.draft.sessionId, body)).rejects.toMatchObject(notFound);
    await expect(svc.save(aab, s.corrected.sessionId, { ...body, version: s.corrected.version + 1 })).rejects.toMatchObject(notFound);
    await expect(svc.finalize(aab, s.corrected.sessionId, s.corrected.version + 1)).rejects.toMatchObject(notFound);
    await expect(svc.reopen(aab, s.led.sessionId, { version: s.led.version, reason: 'Once more.' })).rejects.toMatchObject(notFound);
  }

  it('former_leader_reads_only_what_they_led — the edge closed by a re-parent (P11-T5 AC-11)', async () => {
    const s = await sessions();
    // The agent moves to AB2's unit: neither the AAB nor the AB above them coaches the agent now.
    await hierarchy.reparent(ctx('ROOT'), m.AGENT, m.AB2, 'Moved to another unit');
    const after = await finalized('AB2', 'The new leader’s first 1:1');

    await readsOnlyWhatTheyLed(s);
    // A session the new leader led after them is not theirs either.
    await expect(wired.coachingSession.read(ctx('AAB'), after.sessionId)).rejects.toMatchObject(notFound);

    // The new leader carried the commitments across (ADR-0081) and reads the prior sessions read-only…
    expect(after.lastWeek).toEqual({ sessionId: s.byAb.sessionId, date: s.byAb.date });
    const ab2 = ctx('AB2');
    for (const prior of [s.led, s.corrected, s.byAb]) {
      expect(await wired.coachingSession.read(ab2, prior.sessionId)).toMatchObject({ status: 'finalized', reopenableUntil: null });
    }
    expect((await wired.coachingSession.history(ab2, m.AGENT)).sessions).toHaveLength(4);
    // …and a save to one of them, or a reopen of it, is refused.
    await expect(wired.coachingSession.save(ab2, s.led.sessionId, {
      version: s.led.version, lastWeekItems: [], actionItems: [], tips: [],
    })).rejects.toMatchObject(notFound);
    await expect(wired.coachingSession.reopen(ab2, s.led.sessionId, { version: s.led.version, reason: 'Mine now.' }))
      .rejects.toMatchObject(notFound);
    // The Owner may reopen only while the session's coach still coaches the agent: nobody could finalize it.
    await expect(wired.coachingSession.reopen(ctx('ROOT'), s.led.sessionId, { version: s.led.version, reason: 'Fix it.' }))
      .rejects.toMatchObject({ status: 409, code: 'COACHING_REOPEN_COACH_NOT_CURRENT' });
  });

  /**
   * **The print follows the read** (P11-T10 AC-9): the former coach prints the latest finalized version of
   * each session they led — the one under correction as the version the correction will replace — and is
   * 404 on a draft they left and on a session somebody else led. The archive serves them the same version.
   */
  async function printsOnlyWhatTheyLed(s: Awaited<ReturnType<typeof sessions>>, others: string[]) {
    const aab = ctx('AAB');
    const record = wired.coachingRecord;

    const led = await record.print(aab, s.led.sessionId);
    expect(led).toMatchObject({
      sessionId: s.led.sessionId, version: s.led.version, date: s.led.date, actionItems: [{ text: 'Led and finalized' }],
    });
    const corrected = await record.print(aab, s.corrected.sessionId);
    expect(corrected).toMatchObject({ version: s.corrected.version, actionItems: [{ text: 'Agreed before the correction' }] });
    // The lead actions the finalize took, not the lead as it reads now.
    expect(corrected.leadActions).toEqual([{ dueDate: '2026-10-05', text: 'Collect the SPAJ.', leadName: 'Ibu Melati' }]);
    // The archive serves the same versions.
    for (const [printed, id] of [[led, s.led.sessionId], [corrected, s.corrected.sessionId]] as const) {
      const archived = await wired.coachingSession.read(aab, id);
      expect(printed.version).toBe(archived.version);
      expect(printed.actionItems).toEqual(archived.actionItems.map(({ text, dueDate }) => ({ text, dueDate })));
    }

    for (const id of [s.draft.sessionId, s.byAb.sessionId, ...others]) {
      await expect(record.print(aab, id)).rejects.toMatchObject(notFound);
    }
  }

  /** The audit a former coach's print leaves: the export, and the read of the agent's data. */
  async function printEntries(sessionId: string) {
    return {
      exported: await col('auditLog').find({ action: 'coaching_session.exported', targetId: sessionId }).toArray(),
      read: await col('auditLog').find({ action: 'activity_log.read_raw', 'after.surface': 'coaching_session_print' }).toArray(),
    };
  }

  it('P11-T10 AC-9 the print follows former_leader_reads_only_what_they_led — the edge closed by a re-parent', async () => {
    const s = await sessions();
    await hierarchy.reparent(ctx('ROOT'), m.AGENT, m.AB2, 'Moved to another unit');
    const after = await finalized('AB2', 'The new leader’s first 1:1');
    await col('auditLog').deleteMany({});

    await printsOnlyWhatTheyLed(s, [after.sessionId]);
    // Each print the AAB made is recorded twice over: the export, and a read of the agent's data.
    const entries = await printEntries(s.led.sessionId);
    expect(entries.exported).toHaveLength(1);
    expect(entries.exported[0]).toMatchObject({
      actorMembershipId: m.AAB, targetCollection: 'coachingSessions', targetMembershipId: m.AGENT,
      after: { version: s.led.version, date: s.led.date, rowCount: 1 },
    });
    expect(entries.read.map((e) => [e.actorMembershipId, e.targetMembershipId])).toEqual([
      [m.AAB, m.AGENT], [m.AAB, m.AGENT],
    ]);

    // The new leader prints every prior session, read-only, whoever led it.
    for (const prior of [s.led, s.corrected, s.byAb, after]) {
      await expect(wired.coachingRecord.print(ctx('AB2'), prior.sessionId)).resolves.toMatchObject({ sessionId: prior.sessionId });
    }
  });

  it('P11-T10 AC-10 a former coach finds what they led on /coaching/me, and nothing else — the edge closed by a re-parent', async () => {
    const s = await sessions();
    await hierarchy.reparent(ctx('ROOT'), m.AGENT, m.AB2, 'Moved to another unit');
    const after = await finalized('AB2', 'The new leader’s first 1:1');
    await col('auditLog').deleteMany({});

    // The AAB led two sessions with the agent that were finalized; the draft they left is not one.
    const aab = await wired.coachingRecord.mine(ctx('AAB'));
    expect(aab.sessions).toEqual([]);
    expect(aab.ledFormerly).toEqual([
      { sessionId: s.corrected.sessionId, date: s.corrected.date, coachee: { membershipId: m.AGENT, name: expect.any(String) }, actionItemCount: 2, completedCount: 0 },
      { sessionId: s.led.sessionId, date: s.led.date, coachee: { membershipId: m.AGENT, name: expect.any(String) }, actionItemCount: 2, completedCount: 0 },
    ]);
    expect(aab.ledFormerly[0].coachee.name).not.toBe('');
    // The AB above them no longer coaches the agent either: the one they led is theirs.
    expect((await wired.coachingRecord.mine(ctx('AB'))).ledFormerly.map((r) => r.sessionId)).toEqual([s.byAb.sessionId]);
    // The new leader coaches the agent now: their session is the roster's, not this list's.
    expect((await wired.coachingRecord.mine(ctx('AB2'))).ledFormerly).toEqual([]);
    // And the agent reads every finalized session about them, whoever led it — the one being corrected included.
    const agent = await wired.coachingRecord.mine(ctx('AGENT'));
    expect(agent.sessions.map((r) => r.sessionId)).toEqual([after.sessionId, s.byAb.sessionId, s.corrected.sessionId, s.led.sessionId]);
    expect(agent.ledFormerly).toEqual([]);
    // Dates, names and counts: no entry is written.
    expect(await col('auditLog').countDocuments({})).toBe(0);
  });

  it('former_leader_reads_only_what_they_led — the edge closed by a removal (P11-T5 AC-11)', async () => {
    const s = await sessions();
    await removals.remove(ctx('ROOT'), m.AGENT, { confirmation: REMOVAL_CONFIRMATION, reason: 'Left the agency' });

    await readsOnlyWhatTheyLed(s);
    // The history stays with the office: the Owner reads every finalized session about the member who left.
    const owner = await wired.coachingSession.history(ctx('ROOT'), m.AGENT);
    expect(owner.sessions).toHaveLength(3);
    expect(owner.current).toBeNull();
  });

  it('P11-T10 AC-9, AC-10 a member who left: their former coaches print and find what they led, the Owner prints every one', async () => {
    const s = await sessions();
    await removals.remove(ctx('ROOT'), m.AGENT, { confirmation: REMOVAL_CONFIRMATION, reason: 'Left the agency' });

    await printsOnlyWhatTheyLed(s, []);
    expect((await wired.coachingRecord.mine(ctx('AAB'))).ledFormerly.map((r) => r.sessionId))
      .toEqual([s.corrected.sessionId, s.led.sessionId]);
    expect((await wired.coachingRecord.mine(ctx('AB'))).ledFormerly.map((r) => r.sessionId)).toEqual([s.byAb.sessionId]);
    // The history belongs to the office (§6.7): the Owner prints every finalized session, and no draft.
    for (const done of [s.led, s.corrected, s.byAb]) {
      await expect(wired.coachingRecord.print(ctx('ROOT'), done.sessionId)).resolves.toMatchObject({ sessionId: done.sessionId });
    }
    await expect(wired.coachingRecord.print(ctx('ROOT'), s.draft.sessionId)).rejects.toMatchObject(notFound);
  });
});
