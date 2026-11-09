import { INestApplication } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { Test } from '@nestjs/testing';
import mongoose from 'mongoose';
import request from 'supertest';
import { PermissionsGuard } from '@/common/auth/permissions.guard';
import { RequestContext } from '@/common/context/request-context';
import { DomainExceptionFilter } from '@/common/errors/error.filter';
import { SUBJECT_READ_ACTION } from '@/modules/audit/subject-read-audit';
import { clearCollections, startMongo, stopMongo } from '../../../test/mongo';
import { configModule } from '../../../test/config-module';
import { productionPipe, session, StubAuth, SUPER_ADMIN } from '../../../test/http-permissions';
import { listenOnLoopback } from '../../../test/listen';
import {
  buildCoachingOffice, KPM_A, ROSTER_NOW, ROSTER_TODAY, type CoachingOffice, type Who,
} from '../../../test/coaching-office';
import { SummaryController } from './summary.controller';
import { SummaryService } from './summary.service';

const M = 1_000_000 * 100;

/**
 * **`GET /summary?for=` — a leader's copy of the coachee's Personal Summary** (P11-T4 AC-1, AC-5;
 * `functional/coaching.md`, the Data contract).
 *
 * Over HTTP, through the real `PermissionsGuard`, the production pipe and the real services, on
 * `test/coaching-office.ts`'s office: the subject is resolved by `CoachResolver.subject` on
 * `personal_summary:read`, the page is computed **for them** — their goal, production, log, leads,
 * compliance and rung — and a read of somebody else's writes **exactly one** §3.5 entry.
 */
describe('a Personal Summary with a subject, over HTTP (P11-T4)', () => {
  let app: INestApplication;
  let wired: ReturnType<typeof configModule>;
  let office: CoachingOffice;

  const get = (query: Record<string, unknown> = {}) => request(app.getHttpServer()).get('/summary').query(query);
  const as = (who: Who) => { session.current = office.as(who); };
  const audit = () => mongoose.connection.db!.collection('auditLog');
  const reads = () => audit().find({ action: SUBJECT_READ_ACTION }).toArray();

  beforeAll(async () => {
    await startMongo();
    wired = configModule(ROSTER_NOW);
    await clearCollections();
    office = await buildCoachingOffice(wired);
    // Indah's own leads, for *Leads that need her*; Agus's own, which her page must not carry.
    await wired.leadRecords.create(office.as('INDAH'), { name: 'Pak Hadi', nextActionDate: '2026-09-16' });
    await wired.leadRecords.create(office.as('INDAH'), { name: 'Ibu Wati' });
    await wired.leadRecords.create(office.as('AGUS'), { name: 'Agus’ own prospect' });

    const moduleRef = await Test.createTestingModule({
      controllers: [SummaryController],
      providers: [{ provide: SummaryService, useValue: wired.summary }],
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

  beforeEach(async () => {
    await audit().deleteMany({});
  });

  describe('AC-1: the Summary computed for the subject', () => {
    it('P11-T4 AC-1 an AB reading a direct agent gets exactly the page the agent reads as themselves', async () => {
      as('INDAH');
      const hers = (await get().expect(200)).body;
      as('AGUS');
      const theirs = (await get({ for: office.id.INDAH }).expect(200)).body;

      expect(theirs).toEqual(hers);
    });

    it('P11-T4 AC-1 it is the subject’s goal, production and its source, log and leads — not the reader’s', async () => {
      as('AGUS');
      const mine = (await get().expect(200)).body;
      const hers = (await get({ for: office.id.INDAH }).expect(200)).body;

      // Agus has no goal; Indah's Rp 500 M plan gives September a Rp 85 M target, Rp 80 M of it produced.
      expect(mine.goal.set).toBe(false);
      expect(hers.goal.set).toBe(true);
      expect(hers.monthly).toMatchObject({
        targetMinor: 85 * M, actualMinor: 80 * M, source: { provenance: 'imported', month: '2026-09' },
      });
      // Her log: two leads contacted on each of ten days this month.
      expect(hers.activity.monthly.targets[0]).toMatchObject({ key: 'leads', code: 'LEADS_CONTACTED', logged: 20 });
      expect(hers.leads.rows.map((r: { name: string }) => r.name).sort()).toEqual(['Ibu Wati', 'Pak Hadi']);
      expect(hers.leads.total).toBe(2);
      expect(JSON.stringify(hers)).not.toContain('Agus’ own prospect');
    });

    it('P11-T4 AC-1 the sections and ratios are the subject’s rung: an AB reads an AAB’s page as the AAB does', async () => {
      as('SARI');
      const hers = (await get().expect(200)).body;
      as('AGUS');
      const theirs = (await get({ for: office.id.SARI }).expect(200)).body;

      expect(theirs.activity).toEqual(hers.activity);
      expect(theirs.insights).toEqual(hers.insights);
      expect(theirs).toEqual(hers);
    });

    it('P11-T4 AC-1 an AAB reads an agent of a nested unit, and the Owner reads anybody in the office', async () => {
      as('DODI');
      const his = (await get().expect(200)).body;
      as('SARI');
      expect((await get({ for: office.id.DODI }).expect(200)).body).toEqual(his);
      as('OWNER');
      expect((await get({ for: office.id.DODI }).expect(200)).body).toEqual(his);
    });

    it('P11-T4 AC-5 roles §3.7: an Admin who is not above the member reads the count of open leads, never the rows', async () => {
      as('INDAH');
      const hers = (await get().expect(200)).body;
      as('ADMIN');
      const theirs = (await get({ for: office.id.INDAH }).expect(200)).body;

      expect(hers.leads.rows.length).toBeGreaterThan(0);
      expect(theirs.leads.rows).toEqual([]);
      expect(theirs.leads.total).toBe(hers.leads.total);
      expect(theirs.insights.map((i: { rule: string }) => i.rule)).not.toEqual(
        expect.arrayContaining(['LEAD_OVERDUE']),
      );
      for (const i of theirs.insights as { rule: string }[]) {
        expect(['LEAD_OVERDUE', 'LEAD_NEGLECTED']).not.toContain(i.rule);
      }
      expect(theirs.goal).toEqual(hers.goal);
    });

    it('P11-T4 AC-1 without for, or naming the caller, it is the caller’s own Summary, unchanged', async () => {
      as('AGUS');
      const absent = (await get().expect(200)).body;
      const named = (await get({ for: office.id.AGUS }).expect(200)).body;

      expect(named).toEqual(absent);
      expect(absent.goal.set).toBe(false);
    });
  });

  describe('AC-5: the §3.5 entry', () => {
    it('P11-T4 AC-5 a read of somebody else’s writes exactly one entry, personal_summary, from no date to today', async () => {
      as('AGUS');
      await get({ for: office.id.INDAH }).expect(200);

      const entries = await reads();
      // One read, one record: the compliance and the ratios inside it write nothing of their own.
      expect(entries).toHaveLength(1);
      expect(entries[0]).toMatchObject({
        kpmId: KPM_A,
        actorMembershipId: office.id.AGUS,
        targetCollection: 'memberships',
        targetId: office.id.INDAH,
        targetMembershipId: office.id.INDAH,
        // From no date: the answer holds open leads of any age and compliance's last logged day.
        after: { surface: 'personal_summary', from: null, to: ROSTER_TODAY },
      });
      // Nothing else was written to the audit log by the read either.
      expect(await audit().countDocuments()).toBe(1);
    });

    it('P11-T4 AC-5 every read is its own entry, and an Owner’s read of somebody else’s is recorded too', async () => {
      as('AGUS');
      await get({ for: office.id.INDAH }).expect(200);
      await get({ for: office.id.INDAH }).expect(200);
      as('OWNER');
      await get({ for: office.id.RINA }).expect(200);

      const entries = await reads();
      expect(entries.map((e) => [e.actorMembershipId, e.targetMembershipId])).toEqual([
        [office.id.AGUS, office.id.INDAH], [office.id.AGUS, office.id.INDAH], [office.id.OWNER, office.id.RINA],
      ]);
    });

    it('P11-T4 AC-5 the caller’s own read writes none, with for or without it', async () => {
      for (const who of ['AGUS', 'INDAH', 'SARI'] as const) {
        as(who);
        await get().expect(200);
        await get({ for: office.id[who] }).expect(200);
      }
      expect(await audit().countDocuments()).toBe(0);
    });

    it('P11-T4 AC-5 a support session reading as the leader is recorded with both people', async () => {
      const agus = office.as('AGUS');
      session.current = new RequestContext(agus.userId, 'none', agus.membership, 'u-support', null, false, true);
      await get({ for: office.id.INDAH }).expect(200);

      const [entry] = await reads();
      expect(entry).toMatchObject({ targetMembershipId: office.id.INDAH, after: { surface: 'personal_summary' } });
      expect(entry).toMatchObject({ actorUserId: 'u-support', effectiveUserId: agus.userId });
    });
  });

  describe('AC-5: outside the grant is 404, and nothing is recorded', () => {
    it.each([
      ['AGUS', 'B_AGENT', 'cross-tenant: another office’s agent, to an AB'],
      ['B_AB', 'INDAH', 'cross-tenant: this office’s agent, to another office’s AB'],
      ['OWNER', 'B_AGENT', 'cross-tenant: another office’s agent, to the Owner'],
      ['PEER_AAB', 'RINA', 'peer AAB: an agent of the AAB beside them'],
      ['SARI', 'PEER_AGENT', 'peer AAB: the peer AAB’s agent'],
      ['SARI', 'INDAH', 'an agent of the AB above them'],
      ['SARI', 'AGUS', 'the leader above them'],
      ['AGUS', 'PEER_AGENT', 'a peer AB’s person'],
      ['AGUS', 'LEFT', 'a member who has left'],
      ['INDAH', 'DIMAS', 'an Agent naming a colleague'],
      ['INDAH', 'AGUS', 'an Agent naming their own leader'],
    ] as [Who, Who, string][])('P11-T4 AC-5 %s reading %s: %s', async (reader, subject) => {
      as(reader);
      const res = await get({ for: office.id[subject] }).expect(404);

      expect(res.body.error.code).toBe('NOT_FOUND');
      expect(await audit().countDocuments()).toBe(0);
    });

    it('P11-T4 AC-5 an id that is nobody’s, or not an id at all, is not found either', async () => {
      as('AGUS');
      await get({ for: new mongoose.Types.ObjectId().toString() }).expect(404);
      await get({ for: 'not-a-membership' }).expect(404);
      expect(await audit().countDocuments()).toBe(0);
    });
  });

  describe('the query is validated', () => {
    it('P11-T4 AC-1 any other parameter is refused by name, beside for or without it', async () => {
      as('AGUS');
      const alone = await get({ membershipId: office.id.INDAH }).expect(400);
      expect(alone.body.error.code).toBe('VALIDATION_FAILED');
      expect(alone.body.error.details.violations).toEqual(expect.arrayContaining([expect.stringContaining('membershipId')]));

      const beside = await get({ for: office.id.INDAH, period: 'yearly' }).expect(400);
      expect(beside.body.error.details.violations).toEqual(expect.arrayContaining([expect.stringContaining('period')]));
      expect(await audit().countDocuments()).toBe(0);
    });

    it('P11-T4 AC-1 for is a string of at most 64 characters', async () => {
      as('AGUS');
      const long = await get({ for: 'a'.repeat(65) }).expect(400);
      expect(long.body.error.details.violations).toEqual(expect.arrayContaining([expect.stringContaining('for')]));
      // Sent twice, it arrives as a list, which is not a membership.
      await request(app.getHttpServer()).get(`/summary?for=${office.id.INDAH}&for=${office.id.DIMAS}`).expect(400);
      // 64 is allowed through to the resolver, which finds nobody.
      await get({ for: 'a'.repeat(64) }).expect(404);
    });
  });

  describe('an earlier month, for the subject (P18.5-T11, ADR-0161 §4)', () => {
    // The office opened in January in Jakarta: August is a month it has.
    beforeAll(() => mongoose.connection.db!.collection('kpms').updateOne(
      { _id: new mongoose.Types.ObjectId(KPM_A) }, { $set: { createdAt: new Date('2025-12-31T17:00:00Z') } },
    ));

    it('P18.5-T11 AC-2 a leader reads a coachee’s August as the coachee does, and one entry records it', async () => {
      as('INDAH');
      const hers = (await get({ month: '2026-08' }).expect(200)).body;
      as('AGUS');
      const theirs = (await get({ for: office.id.INDAH, month: '2026-08' }).expect(200)).body;

      expect(theirs).toEqual(hers);
      expect(theirs).toMatchObject({ month: '2026-08', pace: null, period: { currentMonth: false } });
      const entries = await reads();
      expect(entries).toHaveLength(1);
      expect(entries[0]).toMatchObject({ targetMembershipId: office.id.INDAH, after: { surface: 'personal_summary' } });
    });

    it('P18.5-T11 AC-1 a refused period records nothing, and a stranger is still 404 before the period is checked', async () => {
      as('AGUS');
      const future = await get({ for: office.id.INDAH, month: '2027-01' }).expect(400);
      expect(future.body.error).toMatchObject({ code: 'VALIDATION_FAILED', details: { field: 'month' } });
      as('INDAH');
      await get({ for: office.id.AGUS, month: '2027-01' }).expect(404);
      expect(await audit().countDocuments()).toBe(0);
    });
  });

  it('P11-T4 a Super Admin, who has no membership, is refused by name', async () => {
    session.current = SUPER_ADMIN;
    const res = await get({ for: office.id.INDAH }).expect(403);
    expect(res.body.error.code).toBe('TENANT_NO_MEMBERSHIP');
  });
});
