import { globSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Logger } from '@nestjs/common';
import mongoose from 'mongoose';
import { RequestContext } from '@/common/context/request-context';
import { clearCollections, startMongo, stopMongo } from '../../../test/mongo';
import { configModule, provisionOffice } from '../../../test/config-module';

const NOW = new Date('2026-03-11T02:00:00Z');
const KPM_A = '66f0000000000000000000a1';
const KPM_B = '66f0000000000000000000b1';
const COMPANY = '66f0000000000000000000c1';
/** Today in Jakarta at `NOW`. */
const TODAY = '2026-03-11';
/** The reader's own membership in office A. */
const ME = `mem-${KPM_A}`;

const member = (kpmId: string, over: Record<string, unknown> = {}, impersonator: string | null = null) =>
  new RequestContext(
    'u-reader', 'none', {
      membershipId: `mem-${kpmId}`, kpmId, orgLevelCode: 'AGENT', hierarchyRole: 'agent',
      status: 'active', isKpmOwner: false, isKpmAdmin: false, directCount: 0, ...over,
    } as never,
    impersonator,
  );

const ab = () => member(KPM_A, { orgLevelCode: 'AB', hierarchyRole: 'ab', directCount: 1 });
const aab = () => member(KPM_A, { orgLevelCode: 'AAB', hierarchyRole: 'aab', directCount: 1 });
const owner = (kpmId = KPM_A) => member(kpmId, { isKpmOwner: true });
const admin = () => member(KPM_A, { isKpmAdmin: true });

/**
 * **Every read of another member's raw activity leaves a record** (P10.1-T7) —
 * `roles-and-permissions.md` §3.5, obligation 1.
 *
 * Phase 6 granted the Owner, the Admin and every leader raw reads of a member's days on two
 * conditions, and built neither. This pins the first: a read that discloses somebody else's days
 * writes one `activity_log.read_raw` entry saying who read whose, over what range, from which
 * surface — and a read of your own, or a read that was refused, writes nothing.
 */
describe('reading another member’s activity is audited (P10.1-T7, §3.5)', () => {
  let wired: ReturnType<typeof configModule>;

  beforeAll(async () => {
    await startMongo();
    wired = configModule(NOW);
  });
  afterAll(stopMongo);

  beforeEach(async () => {
    await clearCollections();
    await (wired.kpms as { create: (d: unknown) => Promise<unknown> }).create([
      { _id: KPM_A, companyId: COMPANY, code: '0417', branchName: 'A', timezone: 'Asia/Jakarta' },
      { _id: KPM_B, companyId: COMPANY, code: '0555', branchName: 'B', timezone: 'Asia/Jakarta' },
    ]);
    await wired.orgLevels.seedDefaultLadder(COMPANY);
    await provisionOffice(wired, KPM_A, COMPANY);
    await provisionOffice(wired, KPM_B, COMPANY);
  });

  afterEach(() => jest.restoreAllMocks());

  /** A member of an office, under whoever `leaderId` and `ancestorIds` say. */
  const membership = async (
    kpmId: string, leaderId: string | null, ancestorIds: string[] = leaderId ? [leaderId] : [],
  ) => {
    const row = await mongoose.model('Membership').create({
      kpmId,
      userId: new mongoose.Types.ObjectId().toString(),
      role: 'agent',
      orgLevelCode: 'AGENT',
      orgLevelId: new mongoose.Types.ObjectId().toString(),
      status: 'active',
      agentCode: `A${Math.random().toString(36).slice(2, 8)}`,
      agentSeq: Math.floor(Math.random() * 100000),
      leaderCode: Math.random().toString(36).slice(2, 10).toUpperCase(),
      leaderId,
      ancestorIds,
      deletedAt: null,
    });
    return String(row._id);
  };

  /** Every read entry written so far, oldest first. */
  const reads = () => mongoose.connection.db!.collection('auditLog')
    .find({ action: 'activity_log.read_raw' }).sort({ createdAt: 1 }).toArray();

  /** The three reads that take a subject, as the surface each one records. */
  const SURFACES = {
    log: (ctx: RequestContext, membershipId?: string) =>
      wired.activityLogs.readDay(ctx, { membershipId }),
    summary: (ctx: RequestContext, membershipId?: string) =>
      wired.activityLogs.summary(ctx, { membershipId, period: 'ROLLING_7D' }),
    compliance: (ctx: RequestContext, membershipId?: string) =>
      wired.activityLogs.compliance(ctx, { membershipId }),
  } as const;

  describe('what the entry says (AC-1)', () => {
    it('names the actor, the subject, the day and the surface when a leader reads a day', async () => {
      const agent = await membership(KPM_A, ME);

      await wired.activityLogs.readDay(ab(), { membershipId: agent, date: '2026-03-09' });

      const [entry, ...rest] = await reads();
      expect(rest).toHaveLength(0);
      expect(entry).toMatchObject({
        kpmId: KPM_A,
        actorUserId: 'u-reader',
        actorMembershipId: ME,
        targetCollection: 'memberships',
        targetId: agent,
        targetMembershipId: agent,
        after: { surface: 'log', from: '2026-03-09', to: '2026-03-09' },
      });
    });

    it('records the period a summary was taken over', async () => {
      const agent = await membership(KPM_A, ME);

      await SURFACES.summary(ab(), agent);

      expect((await reads())[0]).toMatchObject({
        targetMembershipId: agent,
        after: { surface: 'summary', from: '2026-03-05', to: TODAY },
      });
    });

    it('records compliance with no start, because the latest day logged can be any day', async () => {
      const agent = await membership(KPM_A, ME);

      await SURFACES.compliance(ab(), agent);

      expect((await reads())[0]).toMatchObject({
        targetMembershipId: agent,
        after: { surface: 'compliance', from: null, to: TODAY },
      });
    });

    it('P11-T3 AC-8: is written by the one shared seam the three reads call, not by copies', async () => {
      /*
       * **Rewritten 2026-10-02 (P11-T3 AC-8).** This counted one literal and three
       * `this.auditRawRead(` calls in `activity.service.ts`. The writer is `SubjectReadAudit` now —
       * the injectable every module that reads a member's data shares, so coaching reuses the seam
       * rather than copying it — and the assertion follows it there: each read hands the seam what
       * it disclosed, once, and the action is spelled in the seam and in no module that reads.
       */
      const agent = await membership(KPM_A, ME);
      const seam = jest.spyOn(wired.subjectReads, 'record');

      for (const read of Object.values(SURFACES)) await read(ab(), agent);

      expect(seam.mock.calls.map(([who, subject, surface, range]) => [
        who.membershipId, subject.membershipId, surface, range.from, range.to,
      ])).toEqual([
        [ME, agent, 'log', TODAY, TODAY],
        [ME, agent, 'summary', '2026-03-05', TODAY],
        [ME, agent, 'compliance', null, TODAY],
      ]);
      expect(await reads()).toHaveLength(3);

      const src = join(__dirname, '../..');
      const spelling = globSync('**/*.ts', { cwd: src })
        .filter((file) => !file.includes('.spec.') && !file.startsWith('seed/'))
        .filter((file) => readFileSync(join(src, file), 'utf8').includes("'activity_log.read_raw'"));
      expect(spelling).toEqual(['modules/audit/subject-read-audit.ts']);
    });
  });

  describe('reading yourself writes nothing (AC-2)', () => {
    it.each(Object.keys(SURFACES) as (keyof typeof SURFACES)[])('on %s', async (surface) => {
      await SURFACES[surface](member(KPM_A));
      // Naming yourself is still yourself.
      await SURFACES[surface](ab(), ME);

      expect(await reads()).toHaveLength(0);
    });
  });

  describe('a refused read writes nothing (AC-3)', () => {
    it('P11-T3 AC-3: an Agent naming anybody else, as not found', async () => {
      // 403 `PERM_OUT_OF_SCOPE` until 2026-10-02, which told the Agent the person existed. Every
      // subject read answers 404 outside its scope (P11-T3 AC-3), as goals and leads always did.
      const other = await membership(KPM_A, null);

      for (const read of Object.values(SURFACES)) {
        await expect(read(member(KPM_A), other)).rejects.toMatchObject({ status: 404, code: 'NOT_FOUND' });
      }
      expect(await reads()).toHaveLength(0);
    });

    it('an AAB naming a peer AAB’s agent, as not found', async () => {
      const peer = await membership(KPM_A, null);
      const theirs = await membership(KPM_A, peer);

      for (const read of Object.values(SURFACES)) {
        await expect(read(aab(), theirs)).rejects.toMatchObject({ status: 404 });
      }
      expect(await reads()).toHaveLength(0);
    });

    it('an AB naming somebody outside their downline, as not found', async () => {
      const stranger = await membership(KPM_A, null);

      for (const read of Object.values(SURFACES)) {
        await expect(read(ab(), stranger)).rejects.toMatchObject({ status: 404 });
      }
      expect(await reads()).toHaveLength(0);
    });

    it('an Owner of office B naming a member of office A, as not found', async () => {
      const inA = await membership(KPM_A, null);

      for (const read of Object.values(SURFACES)) {
        await expect(read(owner(KPM_B), inA)).rejects.toMatchObject({ status: 404 });
      }
      expect(await reads()).toHaveLength(0);
    });

    it('a read in scope that is refused on its arguments', async () => {
      // The subject resolves, then the date or the range is refused: nothing was disclosed.
      const agent = await membership(KPM_A, ME);

      await expect(wired.activityLogs.readDay(ab(), { membershipId: agent, date: '2026-02-31' }))
        .rejects.toThrow(/is not a date/);
      await expect(wired.activityLogs.summary(ab(), { membershipId: agent, from: TODAY, to: '2026-03-01' }))
        .rejects.toThrow(/starts after it ends/);
      expect(await reads()).toHaveLength(0);
    });
  });

  describe('each role that may read, reads once and is recorded once (AC-4)', () => {
    it('an AB over their whole downline, two levels down included', async () => {
      const direct = await membership(KPM_A, ME);
      const below = await membership(KPM_A, direct, [direct, ME]);

      for (const read of Object.values(SURFACES)) await read(ab(), below);

      const entries = await reads();
      expect(entries.map((e) => e.after.surface)).toEqual(['log', 'summary', 'compliance']);
      expect(entries.every((e) => e.targetMembershipId === below)).toBe(true);
    });

    it('an AAB over their unit', async () => {
      const direct = await membership(KPM_A, ME);

      await expect(SURFACES.log(aab(), direct)).resolves.toMatchObject({ membershipId: direct });

      expect(await reads()).toHaveLength(1);
    });

    it('the Owner and the Admin over their office', async () => {
      const anybody = await membership(KPM_A, null);

      await expect(SURFACES.compliance(owner(), anybody)).resolves.toMatchObject({ membershipId: anybody });
      await expect(SURFACES.compliance(admin(), anybody)).resolves.toMatchObject({ membershipId: anybody });

      expect(await reads()).toHaveLength(2);
    });

    it('a Super Admin, only by impersonation, and the entry names both people', async () => {
      const anybody = await membership(KPM_A, null);
      const impersonating = member(KPM_A, { isKpmOwner: true }, 'u-root');

      await SURFACES.log(impersonating, anybody);

      expect((await reads())[0]).toMatchObject({
        actorUserId: 'u-root', effectiveUserId: 'u-reader', targetMembershipId: anybody,
      });
    });
  });

  describe('an audit write that fails (AC-5)', () => {
    it('does not fail the read, and is logged at error level', async () => {
      const agent = await membership(KPM_A, ME);
      const auditModel = (wired.audit as unknown as { model: { create: () => Promise<unknown> } }).model;
      jest.spyOn(auditModel, 'create').mockRejectedValueOnce(new Error('write concern timed out'));
      const logged = jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);

      await expect(SURFACES.log(ab(), agent)).resolves.toMatchObject({ membershipId: agent });

      expect(logged).toHaveBeenCalledWith(
        expect.objectContaining({ action: 'activity_log.read_raw' }), 'failed to write audit entry',
      );
      expect(await reads()).toHaveLength(0);
    });
  });
});
