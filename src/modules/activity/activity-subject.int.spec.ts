import { INestApplication } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { Test } from '@nestjs/testing';
import mongoose from 'mongoose';
import request from 'supertest';
import { PermissionsGuard } from '@/common/auth/permissions.guard';
import { RequestContext } from '@/common/context/request-context';
import { DomainExceptionFilter } from '@/common/errors/error.filter';
import { clearCollections, startMongo, stopMongo } from '../../../test/mongo';
import { configModule, provisionOffice } from '../../../test/config-module';
import { productionPipe, session, StubAuth } from '../../../test/http-permissions';
import { listenOnLoopback } from '../../../test/listen';
import { ActivityController } from './activity.controller';
import { ActivityService } from './activity.service';

const NOW = new Date('2026-03-11T02:00:00Z');
const TODAY = '2026-03-11';
const COMPANY = '66f0000000000000000000c1';
const KPM_A = '66f0000000000000000000a1';
const KPM_B = '66f0000000000000000000b1';

/**
 * The routes that take a subject, and the surface each one's entry names. `/activity/compliance` was the
 * third until P11-T6 AC-10 retired it; its computation, and its surface, stay for the Summary's reads
 * (`activity-read-audit.tenancy.spec.ts`).
 */
const ROUTES = [
  ['/activity/log', 'log'],
  ['/activity/summary', 'summary'],
] as const;

/**
 * **A `?membershipId=` activity read, through the guard** (P11-T3 AC-10, carried from Phase 10.2).
 *
 * Phase 10.1's exit found the read audit proved only by calling the service (ADR-0072 (e)): the
 * permission the route declares, the scope the service resolves and the entry it writes had never
 * been exercised together. Here they are, over HTTP, with the real `PermissionsGuard`, the
 * production pipe and the real service — a coach's read and the refused ones. AC-8's seam is the one
 * every coaching read will reuse.
 */
describe('P11-T3 AC-10 — a subject read of activity, through the guard', () => {
  let app: INestApplication;
  let wired: ReturnType<typeof configModule>;
  let m: Record<'AB' | 'AAB' | 'AGENT' | 'SIBLING' | 'PEER_AAB' | 'PEER_AGENT' | 'OUTSIDER' | 'B_AGENT', string>;

  /** A session for one of the fixture's memberships. */
  const as = (membershipId: string, rung: string, over: Record<string, unknown> = {}) =>
    new RequestContext(`u-${membershipId}`, 'none', {
      membershipId, kpmId: KPM_A, orgLevelCode: rung, hierarchyRole: rung.toLowerCase(),
      status: 'active', isKpmOwner: false, isKpmAdmin: false, directCount: 1, ...over,
    } as never);

  /** Every read entry written so far, oldest first. */
  const reads = () => mongoose.connection.db!.collection('auditLog')
    .find({ action: 'activity_log.read_raw' }).sort({ createdAt: 1, _id: 1 }).toArray();

  const get = (path: string, membershipId: string) =>
    request(app.getHttpServer()).get(path).query({ membershipId });

  beforeAll(async () => {
    await startMongo();
    wired = configModule(NOW);

    const moduleRef = await Test.createTestingModule({
      controllers: [ActivityController],
      providers: [{ provide: ActivityService, useValue: wired.activityLogs }],
    }).compile();

    app = moduleRef.createNestApplication();
    app.useGlobalPipes(productionPipe());
    app.useGlobalFilters(new DomainExceptionFilter());
    app.useGlobalGuards(new StubAuth(), new PermissionsGuard(app.get(Reflector)));
    await app.init();
    await listenOnLoopback(app);
  });

  afterAll(async () => {
    await app.close();
    await stopMongo();
  });

  beforeEach(async () => {
    await clearCollections();
    await (wired.kpms as { create: (d: unknown) => Promise<unknown> }).create([
      { _id: KPM_A, companyId: COMPANY, code: '0417', branchName: 'A', timezone: 'Asia/Jakarta' },
      { _id: KPM_B, companyId: COMPANY, code: '0555', branchName: 'B', timezone: 'Asia/Jakarta' },
    ]);
    await provisionOffice(wired, KPM_A, COMPANY);

    const ab = await member(KPM_A, 'AB', []);
    const aab = await member(KPM_A, 'AAB', [ab]);
    const peer = await member(KPM_A, 'AAB', [ab]);
    m = {
      AB: ab,
      AAB: aab,
      AGENT: await member(KPM_A, 'AGENT', [ab, aab]),
      SIBLING: await member(KPM_A, 'AGENT', [ab, aab]),
      PEER_AAB: peer,
      PEER_AGENT: await member(KPM_A, 'AGENT', [ab, peer]),
      OUTSIDER: await member(KPM_A, 'AGENT', []),
      B_AGENT: await member(KPM_B, 'AGENT', []),
    };
  });

  /** A member of an office, under the leaders `ancestorIds` names, root first. */
  async function member(kpmId: string, rung: string, ancestorIds: string[]) {
    const row = await mongoose.model('Membership').create({
      kpmId,
      userId: new mongoose.Types.ObjectId().toString(),
      role: rung.toLowerCase(),
      orgLevelCode: rung,
      orgLevelId: new mongoose.Types.ObjectId().toString(),
      status: 'active',
      agentCode: `A${Math.random().toString(36).slice(2, 8)}`,
      agentSeq: Math.floor(Math.random() * 100000),
      leaderCode: Math.random().toString(36).slice(2, 10).toUpperCase(),
      leaderId: ancestorIds.at(-1) ?? null,
      ancestorIds,
      depth: ancestorIds.length,
      deletedAt: null,
    });
    return String(row._id);
  }

  it.each(ROUTES)('P11-T3 AC-10: a coach reads %s of somebody they coach — 200, and the entry is written', async (path, surface) => {
    session.current = as(m.AB, 'AB');

    const res = await get(path, m.AGENT).expect(200);

    // The day names its subject; the summary is the window's totals.
    expect(res.body).toMatchObject(surface === 'summary' ? { to: TODAY } : { membershipId: m.AGENT });
    const [entry, ...rest] = await reads();
    expect(rest).toHaveLength(0);
    expect(entry).toMatchObject({
      kpmId: KPM_A,
      actorMembershipId: m.AB,
      targetCollection: 'memberships',
      targetMembershipId: m.AGENT,
      onBehalfOf: true,
      after: { surface, to: TODAY },
    });
  });

  it('P11-T3 AC-10: an AAB reads their own agent on each route, and each read is recorded once', async () => {
    session.current = as(m.AAB, 'AAB');

    for (const [path] of ROUTES) await get(path, m.AGENT).expect(200);

    expect((await reads()).map((e) => [e.targetMembershipId, e.after.surface]))
      .toEqual([[m.AGENT, 'log'], [m.AGENT, 'summary']]);
  });

  it.each(ROUTES)('P11-T3 AC-10 AC-5: an AAB naming a peer AAB’s agent on %s is 404, and nothing is written', async (path) => {
    session.current = as(m.AAB, 'AAB');

    const res = await get(path, m.PEER_AGENT).expect(404);

    expect(res.body.error.code).toBe('NOT_FOUND');
    expect(await reads()).toHaveLength(0);
  });

  it.each(ROUTES)('P11-T3 AC-10: a coach naming somebody outside their downline on %s is 404', async (path) => {
    session.current = as(m.AB, 'AB');

    const res = await get(path, m.OUTSIDER).expect(404);

    expect(res.body.error.code).toBe('NOT_FOUND');
    expect(await reads()).toHaveLength(0);
  });

  it.each(ROUTES)('P11-T3 AC-10 AC-3: an Agent naming somebody else on %s is 404, not 403', async (path) => {
    session.current = as(m.AGENT, 'AGENT');

    const res = await get(path, m.SIBLING).expect(404);

    expect(res.body.error.code).toBe('NOT_FOUND');
    expect(await reads()).toHaveLength(0);
  });

  it.each(ROUTES)('P11-T3 AC-10 AC-6: the Owner of office B naming a member of office A on %s is 404', async (path) => {
    session.current = as(m.B_AGENT, 'AGENT', { kpmId: KPM_B, isKpmOwner: true });

    const res = await get(path, m.AGENT).expect(404);

    expect(res.body.error.code).toBe('NOT_FOUND');
    expect(await reads()).toHaveLength(0);
  });

  it('P11-T3 AC-10: naming yourself is your own read, and writes nothing', async () => {
    session.current = as(m.AGENT, 'AGENT');

    for (const [path] of ROUTES) await get(path, m.AGENT).expect(200);

    expect(await reads()).toHaveLength(0);
  });

  it('P11-T3 AC-10: the guard refuses a role with no grant first — 403, before any subject is resolved', async () => {
    session.current = as(m.AB, 'NOT_A_RUNG');

    for (const [path] of ROUTES) {
      const res = await get(path, m.AGENT).expect(403);
      expect(res.body.error.code).toBe('PERM_DENIED');
    }
    expect(await reads()).toHaveLength(0);
  });
});
