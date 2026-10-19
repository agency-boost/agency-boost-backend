import { INestApplication } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { Test } from '@nestjs/testing';
import mongoose from 'mongoose';
import request from 'supertest';
import { PermissionsGuard } from '@/common/auth/permissions.guard';
import { DomainExceptionFilter } from '@/common/errors/error.filter';
import { SUBJECT_READ_ACTION } from '@/modules/audit/subject-read-audit';
import { clearCollections, startMongo, stopMongo } from '../../../test/mongo';
import { configModule } from '../../../test/config-module';
import {
  buildCoachingOffice, ROSTER_NOW, ROSTER_TODAY, type CoachingOffice, type Who,
} from '../../../test/coaching-office';
import { productionPipe, session, StubAuth, SUPER_ADMIN } from '../../../test/http-permissions';
import { listenOnLoopback } from '../../../test/listen';
import { ActivityController } from './activity.controller';
import { ActivityService } from './activity.service';

/** The ratios an agent's rung is not asked (ADR-0020): both measure a recruiting mandate. */
const LEADER_ONLY = ['SELLING_VS_RECRUITMENT', 'RECRUITMENT_SUCCESS_RATE'];

/**
 * **The session's Ratios and Activity cards' reads, over HTTP, per role** (P11-T4 AC-2, AC-4, AC-5;
 * `functional/coaching.md`, the Data contract's *existing routes this phase changes*).
 *
 * `GET /activity/ratios?for=` and `GET /activity/summary?membershipId=` through the real
 * `PermissionsGuard`, the production pipe and the real services over `test/coaching-office.ts`'s office:
 * who is answered (`COACH`, or the office for its Owner and Admin), who is not found, what each answers
 * of the subject — on the subject's rung — and the §3.5 entry each writes, once, and never for a
 * self-read. The arithmetic behind `targets` is `activity-week.tenancy.spec.ts`'s.
 */
describe('P11-T4 — the coachee’s ratios and week, over HTTP', () => {
  let app: INestApplication;
  let wired: ReturnType<typeof configModule>;
  let office: CoachingOffice;

  const as = (who: Who) => { session.current = office.as(who); };
  const ratios = (query: Record<string, unknown> = {}) =>
    request(app.getHttpServer()).get('/activity/ratios').query(query);
  const week = (query: Record<string, unknown> = {}) =>
    request(app.getHttpServer()).get('/activity/summary').query(query);
  /** Every §3.5 entry written since `since`, oldest first. */
  const entries = (surface: string) => mongoose.connection.db!.collection('auditLog')
    .find({ action: SUBJECT_READ_ACTION, 'after.surface': surface }).sort({ createdAt: 1, _id: 1 }).toArray();
  const wipeEntries = () => mongoose.connection.db!.collection('auditLog').deleteMany({});

  beforeAll(async () => {
    await startMongo();
    wired = configModule(ROSTER_NOW);
    await clearCollections();
    office = await buildCoachingOffice(wired);

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
  }, 120_000);

  afterAll(async () => {
    await app.close();
    await stopMongo();
  });

  beforeEach(wipeEntries);

  describe('GET /activity/ratios?for= (AC-2)', () => {
    it('P11-T4 AC-2 an AB reads a nested agent’s ratios on the agent’s rung: a ratio that does not apply is absent', async () => {
      as('AGUS');
      const res = await ratios({ for: office.id.RINA }).expect(200);

      expect(res.body).toMatchObject({ membershipId: office.id.RINA, from: '2026-08-16', to: ROSTER_TODAY, days: 30 });
      const codes = res.body.ratios.map((r: { code: string }) => r.code);
      expect(codes.length).toBeGreaterThan(0);
      for (const code of LEADER_ONLY) expect(codes).not.toContain(code);
    });

    it('P11-T4 AC-2 and an AAB’s on the AAB’s rung, where both leader-only ratios apply', async () => {
      as('AGUS');
      const res = await ratios({ for: office.id.SARI }).expect(200);

      expect(res.body.membershipId).toBe(office.id.SARI);
      expect(res.body.ratios.map((r: { code: string }) => r.code)).toEqual(expect.arrayContaining(LEADER_ONLY));
    });

    it('P11-T4 AC-2 answers the coach exactly what the coachee reads of their own', async () => {
      as('SARI');
      const coach = await ratios({ for: office.id.RINA }).expect(200);
      as('RINA');
      const own = await ratios().expect(200);

      expect(coach.body).toEqual(own.body);
    });

    it('P11-T4 AC-5 writes one entry, surface `ratios`, over the 30 days — and a self-read writes none', async () => {
      as('SARI');
      await ratios({ for: office.id.RINA }).expect(200);
      as('RINA');
      await ratios().expect(200);
      await ratios({ for: office.id.RINA }).expect(200);

      const written = await entries('ratios');
      expect(written).toHaveLength(1);
      expect(written[0]).toMatchObject({
        actorMembershipId: office.id.SARI,
        targetMembershipId: office.id.RINA,
        after: { surface: 'ratios', from: '2026-08-16', to: ROSTER_TODAY },
      });
    });

    it.each([
      ['an AAB, their nested AAB’s agent', 'SARI', 'DODI'],
      ['the Owner, anybody in the office', 'OWNER', 'PEER_AGENT'],
      ['the Admin, anybody in the office', 'ADMIN', 'RINA'],
    ] as [string, Who, Who][])('P11-T4 AC-2 answers %s', async (_name, reader, subject) => {
      as(reader);
      const res = await ratios({ for: office.id[subject] }).expect(200);
      expect(res.body.membershipId).toBe(office.id[subject]);
      expect(await entries('ratios')).toHaveLength(1);
    });

    it.each([
      ['a peer AAB, an agent of another unit (AC-5)', 'PEER_AAB', 'RINA'],
      ['an Agent, a colleague', 'INDAH', 'DIMAS'],
      ['an Agent who leads, their own report: `own` reaches nobody else', 'LUKAS', 'TARI'],
      ['an AB, somebody outside their downline', 'AGUS', 'PEER_AGENT'],
      ['an AB, a member who has left', 'AGUS', 'LEFT'],
      ['office B’s AB, a member of office A (cross-tenant)', 'B_AB', 'RINA'],
    ] as [string, Who, Who][])('P11-T4 AC-5 is 404 for %s, and writes nothing', async (_name, reader, subject) => {
      as(reader);
      const res = await ratios({ for: office.id[subject] }).expect(404);

      expect(res.body.error.code).toBe('NOT_FOUND');
      expect(await entries('ratios')).toHaveLength(0);
    });

    it('P11-T4 refuses a Super Admin, who has no membership to read from — 403, not a 500', async () => {
      session.current = SUPER_ADMIN;
      const res = await ratios({ for: office.id.RINA }).expect(403);
      expect(res.body.error.code).toBe('TENANT_NO_MEMBERSHIP');
    });

    it('P11-T4 validates `for` as a string of at most 64 characters, and refuses `membershipId` by name', async () => {
      as('AGUS');
      const long = await ratios({ for: 'x'.repeat(65) }).expect(400);
      expect(long.body.error.code).toBe('VALIDATION_FAILED');
      // Express reads `for[$ne]=x` as an object: refused by the pipe, never handed to the resolver.
      await request(app.getHttpServer()).get('/activity/ratios?for[$ne]=x').expect(400);
      const wrongName = await ratios({ membershipId: office.id.RINA }).expect(400);
      expect(wrongName.body.error.details.violations)
        .toEqual(expect.arrayContaining([expect.stringContaining('membershipId')]));
      expect(await entries('ratios')).toHaveLength(0);
    });
  });

  describe('GET /activity/summary — the week, its pro-rated targets and its tiles (AC-4)', () => {
    it('P11-T4 AC-4 answers a coach the coachee’s last 7 days against this month’s targets, pro-rated', async () => {
      as('AGUS');
      const res = await week({ membershipId: office.id.INDAH }).expect(200);

      expect(res.body).toMatchObject({ from: '2026-09-08', to: ROSTER_TODAY });
      // Rp 85 M this month: 57, 17 and 5 a month are 13, 4 and 1 over 7 / 30.44. Indah contacted two
      // leads a day on the 8th, 9th and 10th.
      expect(res.body.targets).toEqual([
        { key: 'leads', code: 'LEADS_CONTACTED', logged: 6, target: 13 },
        { key: 'appointments', code: 'SELL_PRESENTATION', logged: 0, target: 4 },
        { key: 'closings', code: 'SELL_SUBMISSION', logged: 0, target: 1 },
      ]);
    });

    it('P11-T4 AC-4 groups the tiles as the Summary does: the cascade’s tiles left to the targets, Development one tile', async () => {
      as('AGUS');
      const res = await week({ membershipId: office.id.INDAH }).expect(200);

      expect(res.body.sections.map((s: { code: string; label: string }) => [s.code, s.label]))
        .toEqual([['RECRUITMENT', 'Recruitment'], ['DEVELOPMENT', 'Development']]);
      const recruitment = res.body.sections[0];
      expect(recruitment.total).toBe(111);
      expect(recruitment.rows).toEqual(expect.arrayContaining([{ code: 'RECRUIT_FOLLOWUP', label: expect.any(String), count: 111 }]));
      for (const section of res.body.sections) {
        expect(section.total).toBe(section.rows.reduce((n: number, r: { count: number }) => n + r.count, 0));
      }
    });

    it('P11-T4 AC-4 has no target without an APE target to derive one from', async () => {
      as('AGUS');
      const res = await week({ membershipId: office.id.SARI }).expect(200);

      expect(res.body.targets.map((t: { target: number | null }) => t.target)).toEqual([null, null, null]);
    });

    it.each([
      ['ROLLING_30D', { period: 'ROLLING_30D' }],
      ['CALENDAR_MONTH', { period: 'CALENDAR_MONTH' }],
      ['a custom range, even one that is the last 7 days', { from: '2026-09-08', to: ROSTER_TODAY }],
    ])('P11-T4 AC-4 has no pro-rated target over %s', async (_name, query) => {
      as('AGUS');
      const res = await week({ membershipId: office.id.INDAH, ...query }).expect(200);

      expect(res.body.targets.map((t: { target: number | null }) => t.target)).toEqual([null, null, null]);
      expect(res.body.targets[0]).toMatchObject({ key: 'leads', code: 'LEADS_CONTACTED' });
    });

    it('P11-T4 AC-5 writes one entry, surface `summary`, over the window — and a self-read writes none', async () => {
      as('AGUS');
      await week({ membershipId: office.id.INDAH }).expect(200);
      as('INDAH');
      await week().expect(200);
      await week({ membershipId: office.id.INDAH }).expect(200);

      const written = await entries('summary');
      expect(written).toHaveLength(1);
      expect(written[0]).toMatchObject({
        actorMembershipId: office.id.AGUS,
        targetMembershipId: office.id.INDAH,
        after: { surface: 'summary', from: '2026-09-08', to: ROSTER_TODAY },
      });
    });

    it.each([
      ['a peer AAB, an agent of another unit', 'PEER_AAB', 'RINA'],
      ['an Agent, a colleague', 'INDAH', 'DIMAS'],
      ['office B’s AB, a member of office A (cross-tenant)', 'B_AB', 'INDAH'],
    ] as [string, Who, Who][])('P11-T4 AC-5 is 404 for %s, and writes nothing', async (_name, reader, subject) => {
      as(reader);
      const res = await week({ membershipId: office.id[subject] }).expect(404);

      expect(res.body.error.code).toBe('NOT_FOUND');
      expect(await entries('summary')).toHaveLength(0);
    });
  });
});
