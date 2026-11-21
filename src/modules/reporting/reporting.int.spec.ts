import { INestApplication } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { Test } from '@nestjs/testing';
import mongoose from 'mongoose';
import request from 'supertest';
import { PermissionsGuard } from '@/common/auth/permissions.guard';
import { DomainExceptionFilter } from '@/common/errors/error.filter';
import { SUBJECT_READ_ACTION } from '@/modules/audit/subject-read-audit';
import { OrgController } from '@/modules/org/org.controller';
import { DirectoryService } from '@/modules/org/directory.service';
import { RoleChangeService } from '@/modules/org/role-change.service';
import { RemovalService } from '@/modules/org/removal.service';
import { OrgTreeService } from '@/modules/org/org-tree.service';
import { GroupService } from '@/modules/org/group.service';
import { AdminDelegationService } from '@/modules/org/admin-delegation.service';
import { LeaderLimitRequestService } from '@/modules/org/leader-limit-request.service';
import { clearCollections, startMongo, stopMongo } from '../../../test/mongo';
import { configModule } from '../../../test/config-module';
import { declaredPermissions, productionPipe, session, StubAuth } from '../../../test/http-permissions';
import { listenOnLoopback } from '../../../test/listen';
import { KPM_A, KPM_B, ROSTER_NOW, type Who } from '../../../test/coaching-office';
import { buildReportingOffice, type ReportingOffice } from '../../../test/reporting-office';
import { DirectoryColumns } from './directory-columns';
import { KpmOverviewService } from './kpm-overview.service';
import { KpmOverviewController } from './reporting.controller';

/**
 * **The Owner's reporting over HTTP, per role** (P18-T1 AC-1, AC-4, AC-6, AC-8, AC-11; P18-T2 AC-2 to AC-5,
 * AC-10; P18-T8 AC-1 to AC-3), with the real `PermissionsGuard`, the production pipe and the real services over
 * `test/reporting-office.ts`. The reconciliation — exit tests 1 to 3 through events — is
 * `reporting.reconciliation.int.spec.ts`; isolation, `reporting.tenancy.spec.ts`.
 */
describe('the Owner’s reporting over HTTP (Phase 18)', () => {
  let app: INestApplication;
  let wired: ReturnType<typeof configModule>;
  let office: ReportingOffice;
  const db = () => mongoose.connection.db!;
  const as = (who: Who) => { session.current = office.as(who); };
  const http = () => request(app.getHttpServer());
  const reads = (surface: string) => db().collection('auditLog').countDocuments({ action: SUBJECT_READ_ACTION, 'after.surface': surface });
  /** The newest audit entry's id: what a read writes after it is `entriesSince(mark)`. */
  const mark = async (): Promise<mongoose.Types.ObjectId | null> =>
    (await db().collection('auditLog').find({}).sort({ _id: -1 }).limit(1).next())?._id ?? null;
  const entriesSince = async (since: mongoose.Types.ObjectId | null) => db().collection('auditLog')
    .find({ action: SUBJECT_READ_ACTION, ...(since === null ? {} : { _id: { $gt: since } }) })
    .project({ _id: 0, createdAt: 0, updatedAt: 0, __v: 0 }).toArray();
  /** One §3.5 entry, field by field (S2): who read whom, from which surface, over which range, and as whom. */
  const entry = (
    target: string, surface: string, range: { from: string | null; to: string },
    by: { membershipId: string; actorUserId: string; effectiveUserId?: string | null; kpmId?: string },
  ) => ({
    action: SUBJECT_READ_ACTION, kpmId: by.kpmId ?? KPM_A, targetCollection: 'memberships', targetId: target,
    targetMembershipId: target, actorMembershipId: by.membershipId, actorUserId: by.actorUserId,
    effectiveUserId: by.effectiveUserId ?? null, onBehalfOf: true, after: { surface, from: range.from, to: range.to },
  });
  const byTarget = (rows: Record<string, unknown>[]) => [...rows].sort((a, b) => String(a.targetMembershipId).localeCompare(String(b.targetMembershipId)));
  const expectEntries = (rows: Record<string, unknown>[], expected: ReturnType<typeof entry>[]) =>
    expect(byTarget(rows)).toEqual(byTarget(expected).map((e) => expect.objectContaining(e)));
  const TODAY = '2026-09-14';
  const asOwnerIn = (who: 'OWNER') => ({ membershipId: office.id[who], actorUserId: `u-${who}` });

  beforeAll(async () => {
    await startMongo();
    wired = configModule(ROSTER_NOW);
    await clearCollections();
    office = await buildReportingOffice(wired);

    const moduleRef = await Test.createTestingModule({
      controllers: [KpmOverviewController, OrgController],
      providers: [
        { provide: KpmOverviewService, useValue: wired.kpmOverview },
        { provide: DirectoryColumns, useValue: wired.directoryColumns },
        {
          provide: DirectoryService,
          useValue: new DirectoryService(wired.memberships, wired.users as never, wired.kpms as never),
        },
        // Routes this spec never calls; a bare object keeps Nest from building their graphs.
        ...[RoleChangeService, RemovalService, OrgTreeService, GroupService, AdminDelegationService, LeaderLimitRequestService]
          .map((provide) => ({ provide, useValue: {} })),
      ],
    }).compile();

    app = moduleRef.createNestApplication();
    app.useGlobalPipes(productionPipe());
    app.useGlobalFilters(new DomainExceptionFilter());
    app.useGlobalGuards(new StubAuth(), new PermissionsGuard(app.get(Reflector)));
    await app.init();
    await listenOnLoopback(app);
  }, 120_000);

  afterAll(async () => {
    await app.close();
    await stopMongo();
  });

  it('declares a permission on every route, and the right one', () => {
    expect(declaredPermissions(KpmOverviewController)).toEqual({ read: 'kpm_overview:read', performance: 'kpm_overview:read' });
  });

  /*
   * `P18-T1 — the KPM Overview` was here: the first version's five sections, its not-logged list and the recruitment
   * target. Replaced by the second version (P19.19; ADR-0272), whose routes are `kpm-overview.int.spec.ts`'s.
   */

  describe('P18-T1 AC-8 — the directory’s two columns', () => {
    it('P18-T1 AC-8 every row carries its last activity and last coached, in the office’s calendar; one entry per member', async () => {
      as('OWNER');
      const before = await reads('directory');
      const res = await http().get('/members').query({ limit: 50 }).expect(200);
      const row = (who: Who) => res.body.members.find((m: { membershipId: string }) => m.membershipId === office.id[who]);
      expect(row('RINA')).toMatchObject({ lastActivityOn: '2026-09-14', lastActivityDays: 0, lastCoachedDays: 0 });
      expect(row('INDAH')).toMatchObject({ lastActivityOn: '2026-09-10', lastActivityDays: 4, lastCoachedDays: 4 });
      expect(row('TARI')).toMatchObject({ lastActivityOn: null, lastActivityDays: null, lastCoachedDays: null });
      expect(res.body.members).toHaveLength(16);
      // Everybody on the page but the reader, in one insert.
      expect(await reads('directory')).toBe(before + 15);
    });

    it('P18-T1 AC-8 S2 the page’s entries field by field: each member but the reader, `from: null` to today', async () => {
      as('OWNER');
      const since = await mark();
      const res = await http().get('/members').query({ limit: 50 }).expect(200);
      const others = res.body.members.map((m: { membershipId: string }) => m.membershipId).filter((id: string) => id !== office.id.OWNER);
      expect(others).toHaveLength(15);
      expectEntries(await entriesSince(since), others.map((id: string) => entry(id, 'directory', { from: null, to: TODAY }, asOwnerIn('OWNER'))));
    });

    it('P18-T1 AC-8 S5 positive: the Admin’s page carries the columns on every row, and names the Admin in its entries', async () => {
      as('ADMIN');
      const since = await mark();
      const res = await http().get('/members').query({ limit: 50 }).expect(200);
      const row = (who: Who) => res.body.members.find((m: { membershipId: string }) => m.membershipId === office.id[who]);
      expect(row('RINA')).toMatchObject({ lastActivityOn: '2026-09-14', lastActivityDays: 0, lastCoachedDays: 0 });
      expect(row('OWNER')).toMatchObject({ lastActivityOn: null, lastCoachedDays: null });
      const written = await entriesSince(since);
      expect(written).toHaveLength(15);
      expect(written.every((e) => e.actorMembershipId === office.id.ADMIN && e.actorUserId === 'u-ADMIN')).toBe(true);
    });

    it('P18-T1 AC-8 S5 positive: an AB’s page is their downline, each row with its columns, an entry for each but the AB', async () => {
      as('AGUS');
      const since = await mark();
      const res = await http().get('/members').expect(200);
      const ids = res.body.members.map((m: { membershipId: string }) => m.membershipId);
      expect(ids.sort()).toEqual((['AGUS', 'INDAH', 'DIMAS', 'SARI', 'RINA', 'BUDI', 'NINA', 'DODI', 'DEWI', 'LUKAS', 'TARI'] as const)
        .map((who) => office.id[who]).sort());
      expect(res.body.members.find((m: { membershipId: string }) => m.membershipId === office.id.INDAH))
        .toMatchObject({ lastActivityOn: '2026-09-10', lastActivityDays: 4, lastCoachedDays: 4 });
      const by = { membershipId: office.id.AGUS, actorUserId: 'u-AGUS' };
      expectEntries(await entriesSince(since), ids.filter((id: string) => id !== office.id.AGUS)
        .map((id: string) => entry(id, 'directory', { from: null, to: TODAY }, by)));
    });

    it('P18-T1 AC-8 B1 the Removed and Pending tabs draw neither column, read nothing of a member gone, and write no entry', async () => {
      // Fajar left Agus's agency: give the history something to leak — a day logged and a 1:1.
      await db().collection('activityLogs').insertOne({
        kpmId: KPM_A, membershipId: office.id.LEFT, localDate: '2026-09-13', entries: [], totalCount: 0, source: 'self', note: 'B1',
        enteredByMembershipId: office.id.LEFT, version: 1, frozenAt: null, corrections: [], deletedAt: null,
      });
      await db().collection('coachingSessions').insertOne({
        kpmId: KPM_A, coachMembershipId: office.id.AGUS, coacheeMembershipId: office.id.LEFT, status: 'finalized', date: '2026-09-12',
        frozenAt: new Date('2026-09-12T04:00:00Z'), version: 3, deletedAt: null, note: 'B1',
      });
      const pending = new mongoose.Types.ObjectId();
      await db().collection('memberships').insertOne({
        _id: pending, kpmId: KPM_A, userId: String(new mongoose.Types.ObjectId()), agentCode: 'PRU-7PEND', agentSeq: 300,
        leaderCode: 'PENDING1', orgLevelId: 'x', orgLevelCode: 'AGENT', role: 'agent', leaderId: null, ancestorIds: [], depth: 0,
        status: 'pending', joinedAt: null, deletedAt: null,
      });
      try {
        const columns = ['lastActivityOn', 'lastActivityDays', 'lastCoachedDays'];
        for (const who of ['AGUS', 'OWNER'] as const) {
          as(who);
          const since = await mark();
          const removed = (await http().get('/members').query({ status: 'removed' }).expect(200)).body.members;
          expect(removed.map((m: { membershipId: string }) => m.membershipId)).toEqual([office.id.LEFT]);
          for (const column of columns) expect(removed[0]).not.toHaveProperty(column);
          expect(await entriesSince(since)).toEqual([]);
        }
        as('OWNER');
        const since = await mark();
        const waiting = (await http().get('/members').query({ status: 'pending' }).expect(200)).body.members;
        expect(waiting.map((m: { membershipId: string }) => m.membershipId)).toEqual([String(pending)]);
        for (const column of columns) expect(waiting[0]).not.toHaveProperty(column);
        expect(await entriesSince(since)).toEqual([]);
      } finally {
        await db().collection('activityLogs').deleteMany({ note: 'B1' });
        await db().collection('coachingSessions').deleteMany({ note: 'B1' });
        await db().collection('memberships').deleteOne({ _id: pending });
      }
    });

    it('P18-T1 AC-8 a leader’s page is their downline, and writes an entry per member on it other than them', async () => {
      as('SARI');
      const before = await reads('directory');
      const res = await http().get('/members').expect(200);
      expect(res.body.members.map((m: { fullName: string }) => m.fullName).sort())
        .toEqual(['Budi Santoso', 'Dodi Kurniawan', 'Nina Lestari', 'Rina Wijaya', 'Sari Puspita']);
      expect(await reads('directory')).toBe(before + 4);
    });

    it('P18-T1 AC-8 an agent’s page is their own row, and writes nothing', async () => {
      as('TARI');
      const before = await reads('directory');
      const res = await http().get('/members').expect(200);
      expect(res.body.members).toHaveLength(1);
      expect(await reads('directory')).toBe(before);
    });
  });

  /*
   * `P18-T2 — KPM analytics` was here. KPM Analytics is removed for everyone (P19.19-T4 AC-1; ADR-0272 §1).
   */

  // `P18-T8 — cross-platform analytics` went with `GET /admin/analytics` (P19.23; ADR-0277 §1): the Dashboard reads it.

  describe('P18-T1 AC-12 S3 — a person who rejoined in another office', () => {
    it('P18-T1 AC-12 0417 sees none of the 0555 membership’s days or 1:1s; 0555’s pages write nothing in 0417', async () => {
      const userId = new mongoose.Types.ObjectId();
      await db().collection('users').insertOne({
        _id: userId, email: 'rejoined@reporting.test', passwordHash: 'x', fullName: 'Aan Kurnia', status: 'active', deletedAt: null,
      });
      const before = new mongoose.Types.ObjectId();
      const now = new mongoose.Types.ObjectId();
      const shape = { userId: String(userId), orgLevelId: 'x', orgLevelCode: 'AGENT', role: 'agent', depth: 1, deletedAt: null, note: 'S3' };
      await db().collection('memberships').insertMany([
        {
          ...shape, _id: before, kpmId: KPM_B, agentCode: 'PRU-80555', agentSeq: 500, leaderCode: 'REJOIN01', leaderId: office.id.B_AB,
          ancestorIds: [office.id.B_AB], status: 'removed', joinedAt: new Date('2026-01-05T02:00:00Z'), removedAt: new Date('2026-08-01T02:00:00Z'),
        },
        {
          ...shape, _id: now, kpmId: KPM_A, agentCode: 'PRU-80417', agentSeq: 501, leaderCode: 'REJOIN02', leaderId: office.id.OWNER,
          ancestorIds: [office.id.OWNER], status: 'active', joinedAt: new Date('2026-08-15T02:00:00Z'), removedAt: null,
        },
      ]);
      // 0555's history of the person: days logged and a 1:1, recent enough that any leak would show.
      await db().collection('activityLogs').insertMany(['2026-07-30', '2026-07-31'].map((localDate) => ({
        kpmId: KPM_B, membershipId: String(before), localDate, entries: [], totalCount: 0, source: 'self', note: 'S3',
        enteredByMembershipId: String(before), version: 1, frozenAt: null, corrections: [], deletedAt: null,
      })));
      await db().collection('coachingSessions').insertOne({
        kpmId: KPM_B, coachMembershipId: office.id.B_AB, coacheeMembershipId: String(before), status: 'finalized', date: '2026-07-28',
        frozenAt: new Date('2026-07-28T04:00:00Z'), version: 3, deletedAt: null, note: 'S3',
      });
      try {
        // 0417's Owner: the new membership has never logged and never had a 1:1 — here.
        as('OWNER');
        const page = (await http().get('/members').query({ limit: 100 }).expect(200)).body.members;
        expect(page.find((m: { membershipId: string }) => m.membershipId === String(now)))
          .toMatchObject({ fullName: 'Aan Kurnia', lastActivityOn: null, lastActivityDays: null, lastCoachedDays: null });
        expect(JSON.stringify(page)).not.toContain(String(before));
        const overview = (await http().get('/kpm/overview').expect(200)).body;
        expect(overview.people.find((p: { membershipId: string }) => p.membershipId === String(now)))
          .toMatchObject({ name: 'Aan Kurnia', usage: { status: 'never', days: null }, coaching: { status: 'never', days: null } });

        // 0555's Owner, through every page that writes an entry: none lands in 0417, none names the 0417 membership.
        session.current = office.ownerOfB();
        const since = await mark();
        const removed = (await http().get('/members').query({ status: 'removed' }).expect(200)).body.members;
        expect(removed.map((m: { membershipId: string }) => m.membershipId)).toEqual([String(before)]);
        for (const path of ['/members', '/kpm/overview']) await http().get(path).expect(200);
        const written = await entriesSince(since);
        expect(written.length).toBeGreaterThan(0);
        expect(written.filter((e) => e.kpmId !== KPM_B)).toEqual([]);
        expect(written.map((e) => e.targetMembershipId)).not.toContain(String(now));
        expect(written.map((e) => e.targetMembershipId)).not.toContain(String(before));
        expect(await db().collection('auditLog').countDocuments({ _id: { $gt: since! }, kpmId: KPM_A })).toBe(0);
      } finally {
        await db().collection('memberships').deleteMany({ note: 'S3' });
        await db().collection('activityLogs').deleteMany({ note: 'S3' });
        await db().collection('coachingSessions').deleteMany({ note: 'S3' });
        await db().collection('users').deleteOne({ _id: userId });
      }
    });
  });
});
