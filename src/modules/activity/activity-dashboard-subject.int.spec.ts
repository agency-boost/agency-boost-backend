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

/** The last 7 days at `ROSTER_NOW`, as the Dashboard's default range cuts them. */
const WEEK = { from: '2026-09-08', to: ROSTER_TODAY };

interface Section { code: string; standing: string; total: number; types: { code: string; total: number }[] }

/**
 * **Coaching's *Activity* tab reads a coachee's Dashboard** (P13.1-T9; the client's item 12, 2026-10-07).
 *
 * `GET /activity/dashboard?for=` through the real `PermissionsGuard`, the production pipe and the real
 * services over `test/coaching-office.ts`'s office: who is answered (`COACH`, or the office for its Owner
 * and Admin), who is not found, that the answer is drawn on the coachee's rung, and the §3.5 entry each
 * read of somebody else writes — once, surface `activity_dashboard` — and a self-read never does. The
 * range arithmetic is `activity-dashboard.spec.ts`'s and the reader's own Dashboard
 * `activity-dashboard.tenancy.spec.ts`'s; neither changed.
 */
describe('P13.1-T9 — a coachee’s Activity Dashboard, over HTTP', () => {
  let app: INestApplication;
  let wired: ReturnType<typeof configModule>;
  let office: CoachingOffice;

  const as = (who: Who) => { session.current = office.as(who); };
  const dashboard = (query: Record<string, unknown> = {}) =>
    request(app.getHttpServer()).get('/activity/dashboard').query(query);
  const entries = () => mongoose.connection.db!.collection('auditLog')
    .find({ action: SUBJECT_READ_ACTION, 'after.surface': 'activity_dashboard' }).sort({ createdAt: 1, _id: 1 }).toArray();
  const wipeEntries = () => mongoose.connection.db!.collection('auditLog').deleteMany({});
  const section = (body: { sections: Section[] }, code: string) => body.sections.find((s) => s.code === code);

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

  describe('AC-1 whose days, and on whose rung', () => {
    it('P13.1-T9 AC-1 answers an AB a nested agent’s last 7 days, their stored counts per type', async () => {
      as('AGUS');
      const res = await dashboard({ for: office.id.RINA }).expect(200);

      expect(res.body).toMatchObject({ range: 'ROLLING_7D', ...WEEK, days: 7, today: ROSTER_TODAY, daysLogged: 7 });
      // Rina recruits every day: 53 follow-ups and one 1-on-1 a day, the whole fortnight.
      const recruitment = section(res.body, 'RECRUITMENT')!;
      expect(recruitment.types.find((t) => t.code === 'RECRUIT_FOLLOWUP')?.total).toBe(7 * 53);
      expect(res.body.total).toBe(7 * 54);
    });

    it('P13.1-T9 AC-1 answers the coach exactly what the coachee reads of their own', async () => {
      as('SARI');
      const coach = await dashboard({ for: office.id.RINA, range: 'ROLLING_30D' }).expect(200);
      as('RINA');
      const own = await dashboard({ range: 'ROLLING_30D' }).expect(200);

      expect(coach.body).toEqual(own.body);
    });

    it('P13.1-T9 AC-1 draws the coachee’s sections on the coachee’s rung, not the reader’s', async () => {
      // Team Development for leaders only: Agus (AB) is shown it, Rina (Agent) is not, Sari (AAB) is.
      const owner = office.as('OWNER');
      const development = (await wired.activity.list(owner)).find((c) => c.code === 'TEAM_DEVELOPMENT')!;
      await wired.activity.updateCategory(owner, development.id, { appliesToOrgLevelCodes: ['AB', 'AAB'] });
      try {
        as('AGUS');
        const mine = await dashboard().expect(200);
        const rinas = await dashboard({ for: office.id.RINA }).expect(200);
        const saris = await dashboard({ for: office.id.SARI }).expect(200);

        expect(section(mine.body, 'TEAM_DEVELOPMENT')?.standing).toBe('shown');
        // Rina logged nothing there, so for her rung it is not a section at all.
        expect(section(rinas.body, 'TEAM_DEVELOPMENT')).toBeUndefined();
        expect(section(saris.body, 'TEAM_DEVELOPMENT')?.standing).toBe('shown');
      } finally {
        await wired.activity.updateCategory(owner, development.id, { appliesToOrgLevelCodes: [] });
      }
    });

    it('P13.1-T9 AC-1 reads a custom range for the coachee, the range checked as the reader’s own is', async () => {
      as('AGUS');
      const res = await dashboard({ for: office.id.INDAH, range: 'CUSTOM', from: '2026-09-01', to: '2026-09-10' }).expect(200);

      expect(res.body).toMatchObject({ range: 'CUSTOM', from: '2026-09-01', to: '2026-09-10', days: 10 });
      // Two leads a day on the 1st to the 10th.
      expect(section(res.body, 'LEADS_GENERATION')?.total).toBe(20);
      const before = (await entries()).length;
      await dashboard({ for: office.id.INDAH, range: 'CUSTOM', from: '2026-09-10', to: '2026-09-01' }).expect(400);
      // A refused range writes no §3.5 entry: the read never happened.
      expect(await entries()).toHaveLength(before);
    });
  });

  describe('AC-2 the §3.5 entry', () => {
    it('P13.1-T9 AC-2 writes one entry, surface `activity_dashboard`, over the range — and a self-read writes none', async () => {
      as('AGUS');
      await dashboard({ for: office.id.RINA }).expect(200);
      as('RINA');
      await dashboard().expect(200);
      await dashboard({ for: office.id.RINA }).expect(200);

      const written = await entries();
      expect(written).toHaveLength(1);
      expect(written[0]).toMatchObject({
        actorMembershipId: office.id.AGUS,
        targetMembershipId: office.id.RINA,
        after: { surface: 'activity_dashboard', ...WEEK },
      });
    });

    it('P13.1-T9 AC-2 records the range that was read, not the default', async () => {
      as('SARI');
      await dashboard({ for: office.id.RINA, range: 'ROLLING_30D' }).expect(200);

      expect((await entries())[0]).toMatchObject({ after: { surface: 'activity_dashboard', from: '2026-08-16', to: ROSTER_TODAY } });
    });
  });

  describe('AC-4 who is answered, per role', () => {
    it.each([
      ['an AB, a direct agent', 'AGUS', 'INDAH'],
      ['an AB, a nested AAB', 'AGUS', 'SARI'],
      ['an AAB, their own agent', 'SARI', 'BUDI'],
      ['an AAB, their nested AAB’s agent', 'SARI', 'DODI'],
      ['the Owner, anybody in the office', 'OWNER', 'PEER_AGENT'],
      ['the Admin, anybody in the office', 'ADMIN', 'RINA'],
      ['the Owner, a member who has left: history belongs to the office', 'OWNER', 'LEFT'],
    ] as [string, Who, Who][])('P13.1-T9 AC-4 answers %s, and writes one entry', async (_name, reader, subject) => {
      as(reader);
      await dashboard({ for: office.id[subject] }).expect(200);

      const written = await entries();
      expect(written).toHaveLength(1);
      expect(written[0]).toMatchObject({ actorMembershipId: office.id[reader], targetMembershipId: office.id[subject] });
    });

    it.each([
      ['a peer AAB, an agent of another unit', 'PEER_AAB', 'RINA'],
      ['an AAB, their own leader', 'SARI', 'AGUS'],
      ['an Agent, a colleague', 'INDAH', 'DIMAS'],
      ['an Agent who leads, their own report: `own` reaches nobody else', 'LUKAS', 'TARI'],
      ['an AB, somebody outside their downline', 'AGUS', 'PEER_AGENT'],
      ['an AB, a member who has left', 'AGUS', 'LEFT'],
      ['office B’s AB, a member of office A (cross-tenant)', 'B_AB', 'RINA'],
      ['office A’s Owner, a member of office B (cross-tenant)', 'OWNER', 'B_AGENT'],
      ['office A’s Admin, a member of office B (cross-tenant)', 'ADMIN', 'B_AGENT'],
    ] as [string, Who, Who][])('P13.1-T9 AC-4 is 404 for %s, and writes nothing', async (_name, reader, subject) => {
      as(reader);
      const res = await dashboard({ for: office.id[subject] }).expect(404);

      expect(res.body.error.code).toBe('NOT_FOUND');
      expect(await entries()).toHaveLength(0);
    });

    it('P13.1-T9 AC-4 answers an Agent their own days by name as by default, and writes nothing', async () => {
      as('INDAH');
      const named = await dashboard({ for: office.id.INDAH }).expect(200);
      const own = await dashboard().expect(200);

      expect(named.body).toEqual(own.body);
      expect(await entries()).toHaveLength(0);
    });

    it('P13.1-T9 AC-4 refuses a Super Admin, who has no membership to read from — 403, not a 500', async () => {
      session.current = SUPER_ADMIN;
      const res = await dashboard({ for: office.id.RINA }).expect(403);
      expect(res.body.error.code).toBe('TENANT_NO_MEMBERSHIP');
    });

    it('P13.1-T9 AC-4 validates `for` as a string of at most 64 characters, and refuses `membershipId` by name', async () => {
      as('AGUS');
      const long = await dashboard({ for: 'x'.repeat(65) }).expect(400);
      expect(long.body.error.code).toBe('VALIDATION_FAILED');
      // Express reads `for[$ne]=x` as an object: refused by the pipe, never handed to the resolver.
      await request(app.getHttpServer()).get('/activity/dashboard?for[$ne]=x').expect(400);
      const wrongName = await dashboard({ membershipId: office.id.RINA }).expect(400);
      expect(wrongName.body.error.details.violations)
        .toEqual(expect.arrayContaining([expect.stringContaining('membershipId')]));
      expect(await entries()).toHaveLength(0);
    });
  });
});
