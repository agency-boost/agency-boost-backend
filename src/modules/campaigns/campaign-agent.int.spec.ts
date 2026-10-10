import { INestApplication } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { Test } from '@nestjs/testing';
import mongoose from 'mongoose';
import request from 'supertest';
import { PermissionsGuard } from '@/common/auth/permissions.guard';
import { RequestContext } from '@/common/context/request-context';
import { DomainExceptionFilter } from '@/common/errors/error.filter';
import { clearCollections, startMongo, stopMongo } from '../../../test/mongo';
import { configModule } from '../../../test/config-module';
import { declaredPermissions, productionPipe, session, StubAuth, SUPER_ADMIN } from '../../../test/http-permissions';
import { listenOnLoopback } from '../../../test/listen';
import { buildCoachingOffice, KPM_B, ROSTER_NOW, type CoachingOffice, type Who } from '../../../test/coaching-office';
import { CampaignAgentController } from './campaign-agent.controller';
import { CampaignAgentService } from './campaign-agent.service';

const M = 1_000_000 * 100;
const wib = (local: string) => new Date(`${local}+07:00`).toISOString();

/**
 * **The agent's campaigns over HTTP** (P18.5-T7 AC-1, AC-5; P18.5-T8 AC-6; P18.5-T9 AC-2), with the real
 * `PermissionsGuard`, the production pipe and the real services over `test/coaching-office.ts`'s office — 10:00 on
 * Monday 14 September 2026 in Jakarta, August on file and locked, September open.
 */
describe('the agent’s campaigns over HTTP (P18.5-T7, T8, T9)', () => {
  let app: INestApplication;
  let wired: ReturnType<typeof configModule>;
  let office: CoachingOffice;
  const db = () => mongoose.connection.db!;
  const http = () => request(app.getHttpServer());
  const as = (who: Who) => { session.current = office.as(who); };
  /** A support session as a member: read-only unless elevated. */
  const supporting = (who: Who, readOnly: boolean) => {
    const c = office.as(who);
    session.current = new RequestContext(c.userId, 'none', c.membership, 'sa-1', null, false, readOnly);
  };

  beforeAll(async () => {
    await startMongo();
    wired = configModule(ROSTER_NOW);
    await clearCollections();
    office = await buildCoachingOffice(wired);

    const owner = office.as('OWNER');
    const make = (body: Record<string, unknown>) => wired.campaigns.create(owner, body);
    await make({
      code: 'APE_SPRINT', title: 'APE Sprint', startsAt: wib('2026-08-01T00:00:00'), endsAt: wib('2026-09-30T23:59:00'),
      poster: { emoji: '🚀', color: 'amber' }, blurb: 'Push for APE.', reward: 'Cash bonus',
      requirements: [{ metricKey: 'APE_ACHIEVED', comparator: 'gte', value: 150 * M }, { metricKey: 'NEW_HIRES', comparator: 'gte', value: 1 }],
    });
    await make({
      code: 'NEXT_PUSH', title: 'Q4 Push', startsAt: wib('2026-10-01T00:00:00'), endsAt: wib('2026-12-31T23:59:00'),
      requirements: [{ metricKey: 'APE_ACHIEVED', comparator: 'gte', value: 100 * M }],
    });
    await make({
      code: 'OLD_PUSH', title: 'Mid-Year Push', startsAt: wib('2026-06-01T00:00:00'), endsAt: wib('2026-07-31T23:59:00'),
      requirements: [{ metricKey: 'ROLLING_PERSISTENCY', comparator: 'gte', value: 90 }],
    });
    await make({
      code: 'MDRT_QUALIFICATION', title: 'MDRT Qualification', kind: 'structural', subtype: 'ongoing', window: 'calendar_year',
      startsAt: wib('2026-01-01T00:00:00'), endsAt: null, poster: { emoji: '🏆', color: 'gold' },
      requirements: [{ metricKey: 'APE_ACHIEVED', comparator: 'gte', value: 2_400 * M }],
    });
    await make({
      code: 'PROMOTION_AAB_AB', title: 'Promotion: AAB → AB', kind: 'structural', subtype: 'promotion', window: 'rolling_12m',
      startsAt: wib('2026-01-01T00:00:00'), endsAt: null, appliesToOrgLevelCodes: ['AAB'],
      requirements: [{ metricKey: 'MAA_COUNT_IN_UNIT', comparator: 'gte', value: 5 }],
    });
    const archived = await make({
      code: 'ARCHIVED_DRIVE', title: 'Archived', startsAt: wib('2026-09-01T00:00:00'), endsAt: wib('2026-09-30T23:59:00'),
      requirements: [],
    });
    await wired.campaigns.archive(owner, archived.id);
    const b = office.as('B_AB');
    await wired.campaigns.create(new RequestContext(b.userId, 'none', { ...b.membership!, isKpmOwner: true }), {
      code: 'GADING_PUSH', title: 'Gading Push', startsAt: wib('2026-09-01T00:00:00'), endsAt: wib('2026-09-30T23:59:00'),
      requirements: [],
    });

    const moduleRef = await Test.createTestingModule({
      controllers: [CampaignAgentController],
      providers: [{ provide: CampaignAgentService, useValue: wired.campaignAgent }],
    }).compile();
    app = moduleRef.createNestApplication();
    app.useGlobalPipes(productionPipe());
    app.useGlobalFilters(new DomainExceptionFilter());
    app.useGlobalGuards(new StubAuth(), new PermissionsGuard(app.get(Reflector)));
    await app.init();
    await listenOnLoopback(app);
  }, 60_000);

  afterAll(async () => {
    await app.close();
    await stopMongo();
  });

  beforeEach(async () => {
    await db().collection('campaignChases').deleteMany({});
  });

  it('P18.5-T7 AC-1 declares a permission on every route, and the right one', () => {
    expect(declaredPermissions(CampaignAgentController)).toEqual({
      list: 'campaign:read_list',
      chasing: 'campaign_qualification:read',
      detail: 'campaign:read_list',
      chase: 'campaign:chase',
      unchase: 'campaign:chase',
    });
  });

  describe('the list (T7 AC-1, AC-2)', () => {
    it.each(['OWNER', 'ADMIN', 'AGUS', 'SARI', 'RINA'] as const)('P18.5-T7 AC-1 positive: %s reads the office’s active campaigns, in D-lists’ order', async (who) => {
      as(who);
      const res = await http().get('/campaigns').expect(200);
      expect(res.body.campaigns.map((c: { code: string }) => c.code)).toEqual([
        'APE_SPRINT', 'NEXT_PUSH', 'OLD_PUSH', 'MDRT_QUALIFICATION', 'PROMOTION_AAB_AB',
      ]);
      expect(res.body.can).toEqual({ chase: true });
    });

    it('P18.5-T7 AC-3 each card carries what the card draws, composed in Jakarta, and why a chase is blocked', async () => {
      as('RINA');
      const cards = (await http().get('/campaigns').expect(200)).body.campaigns as Record<string, unknown>[];
      const byCode = (code: string) => cards.find((c) => c.code === code)!;
      expect(byCode('APE_SPRINT')).toMatchObject({
        kind: 'seasonal', subtype: null, window: 'campaign_dates', phase: 'running', duration: 'Aug 1 – Sep 30, 2026',
        poster: { emoji: '🚀', color: 'amber' }, blurb: 'Push for APE.', reward: 'Cash bonus', chasing: false, eligible: true,
        chaseBlocked: null,
        requirements: [
          { metricKey: 'APE_ACHIEVED', metricName: 'APE achieved', comparator: 'gte', value: 150 * M, unit: 'idr_minor', measured: true },
          { metricKey: 'NEW_HIRES', metricName: 'New Hire', comparator: 'gte', value: 1, unit: 'count', measured: true },
        ],
      });
      expect(byCode('MDRT_QUALIFICATION')).toMatchObject({
        kind: 'structural', subtype: 'ongoing', phase: 'running', endsAt: null,
        duration: 'Standing — evaluated per calendar year (Jan 1 – Dec 31)',
      });
      expect(byCode('OLD_PUSH')).toMatchObject({ phase: 'ended', chaseBlocked: 'ended' });
      expect(byCode('NEXT_PUSH')).toMatchObject({ phase: 'upcoming', chaseBlocked: null });
      expect(byCode('PROMOTION_AAB_AB')).toMatchObject({ eligible: false, chaseBlocked: 'not_eligible', duration: 'Rolling 12-month window' });
    });

    it('P18.5-T7 AC-2 refuses a parameter the read does not know, by name', async () => {
      as('RINA');
      const res = await http().get('/campaigns').query({ status: 'archived' }).expect(400);
      expect(res.body.error.code).toBe('VALIDATION_FAILED');
    });

    it('P18.5-T7 AC-1 a Super Admin outside a support session reads nothing: no office', async () => {
      session.current = SUPER_ADMIN;
      expect((await http().get('/campaigns').expect(403)).body.error.code).toBe('TENANT_NO_MEMBERSHIP');
      expect((await http().get('/campaigns/APE_SPRINT').expect(403)).body.error.code).toBe('TENANT_NO_MEMBERSHIP');
      expect((await http().get('/campaigns/chasing').expect(403)).body.error.code).toBe('TENANT_NO_MEMBERSHIP');
      expect((await http().put('/campaigns/APE_SPRINT/chase').expect(403)).body.error.code).toBe('PERM_DENIED');
    });
  });

  describe('one campaign, and its progress (T7 AC-4, T8 AC-6)', () => {
    it('P18.5-T8 AC-6 the dialog carries the reader’s progress in each requirement row, and the window in words', async () => {
      as('RINA');
      const res = await http().get('/campaigns/APE_SPRINT').expect(200);
      expect(res.body).toMatchObject({ code: 'APE_SPRINT', description: '', can: { chase: true } });
      expect(res.body.progress).toEqual({
        windowLabel: 'Aug – Sep 2026', final: false,
        rows: [
          // Rina: Rp 20 M in August and Rp 80 M in September, of Rp 150 M — September still open.
          { metricKey: 'APE_ACHIEVED', current: 100 * M, target: 150 * M, unit: 'idr_minor', state: 'in_progress' },
          { metricKey: 'NEW_HIRES', current: 0, target: 1, unit: 'count', state: 'in_progress' },
        ],
      });
    });

    it('P18.5-T8 AC-6 an upcoming campaign has no progress yet; a lower-case address finds it', async () => {
      as('RINA');
      expect((await http().get('/campaigns/next_push').expect(200)).body).toMatchObject({ code: 'NEXT_PUSH', progress: null });
    });

    it.each(['ARCHIVED_DRIVE', 'GADING_PUSH', 'NOPE'])('P18.5-T7 AC-1 %s — archived, another office’s, unknown — is 404', async (code) => {
      as('RINA');
      expect((await http().get(`/campaigns/${code}`).expect(404)).body.error.code).toBe('NOT_FOUND');
      expect((await http().put(`/campaigns/${code}/chase`).expect(404)).body.error.code).toBe('NOT_FOUND');
    });
  });

  describe('chasing (T7 AC-5)', () => {
    const audits = (action: string) => db().collection('auditLog').countDocuments({ action });

    it('P18.5-T7 AC-5 chase and stop, idempotent, keyed by the membership and the code, audited once each', async () => {
      as('RINA');
      const before = await audits('campaign.chased');
      expect((await http().put('/campaigns/APE_SPRINT/chase').expect(200)).body).toMatchObject({ code: 'APE_SPRINT', chasing: true });
      expect((await http().put('/campaigns/APE_SPRINT/chase').expect(200)).body.chasing).toBe(true);
      expect(await audits('campaign.chased')).toBe(before + 1);
      const rows = await db().collection('campaignChases').find({}).toArray();
      expect(rows).toEqual([expect.objectContaining({ membershipId: office.id.RINA, campaignCode: 'APE_SPRINT', chasing: true })]);

      expect((await http().delete('/campaigns/APE_SPRINT/chase').expect(200)).body.chasing).toBe(false);
      expect((await http().delete('/campaigns/APE_SPRINT/chase').expect(200)).body.chasing).toBe(false);
      expect(await db().collection('campaignChases').findOne({})).toMatchObject({ chasing: false, closedBy: 'member' });
      const unchased = await db().collection('auditLog').find({ action: 'campaign.unchased' }).toArray();
      expect(unchased.at(-1)).toMatchObject({ before: { chasing: true }, after: { chasing: false } });
    });

    it('P18.5-T8 review item 6 a double tap chases once: both answer 200, one row, one audit', async () => {
      as('RINA');
      const before = await audits('campaign.chased');
      const [a, b] = await Promise.all([http().put('/campaigns/APE_SPRINT/chase'), http().put('/campaigns/APE_SPRINT/chase')]);
      expect([a.status, b.status]).toEqual([200, 200]);
      expect(await db().collection('campaignChases').countDocuments({ campaignCode: 'APE_SPRINT', membershipId: office.id.RINA })).toBe(1);
      expect(await audits('campaign.chased')).toBeLessThanOrEqual(before + 2);
    });

    it('P18.5-T8 review item 6 a write refused by the unique index is retried once; any other failure is not', async () => {
      as('RINA');
      const upsert = jest.spyOn(wired.campaignChases, 'upsertOne');
      upsert.mockRejectedValueOnce(Object.assign(new Error('E11000 duplicate key'), { code: 11000 }));
      await http().put('/campaigns/NEXT_PUSH/chase').expect(200);
      upsert.mockRejectedValueOnce(new Error('the database went away'));
      expect((await http().delete('/campaigns/NEXT_PUSH/chase').expect(500)).body.error.code).toBe('INTERNAL_ERROR');
      upsert.mockRestore();
    });

    it('P18.5-T7 AC-5 an ended campaign is 409 CAMPAIGN_NOT_OPEN both ways; an upcoming one is chaseable', async () => {
      as('RINA');
      for (const verb of ['put', 'delete'] as const) {
        expect((await http()[verb]('/campaigns/OLD_PUSH/chase').expect(409)).body.error.code).toBe('CAMPAIGN_NOT_OPEN');
      }
      await http().put('/campaigns/NEXT_PUSH/chase').expect(200);
    });

    it('P18.5-T7 AC-5 a rung outside the campaign is 403 CAMPAIGN_NOT_ELIGIBLE; the AAB it is for chases it', async () => {
      as('RINA');
      expect((await http().put('/campaigns/PROMOTION_AAB_AB/chase').expect(403)).body.error.code).toBe('CAMPAIGN_NOT_ELIGIBLE');
      as('SARI');
      await http().put('/campaigns/PROMOTION_AAB_AB/chase').expect(200);
    });

    it.each(['AGUS', 'SARI', 'RINA', 'OWNER', 'ADMIN'] as const)('P18.5-T7 AC-1 positive: %s chases by the rung they hold', async (who) => {
      as(who);
      await http().put('/campaigns/MDRT_QUALIFICATION/chase').expect(200);
    });

    it('P18.5-T7 AC-1 a support session reads and draws no chase, and is refused one — read-only or elevated (ADR-0143)', async () => {
      for (const readOnly of [true, false]) {
        supporting('RINA', readOnly);
        expect((await http().get('/campaigns').expect(200)).body.can).toEqual({ chase: false });
        expect((await http().get('/campaigns/APE_SPRINT').expect(200)).body.can).toEqual({ chase: false });
        expect((await http().put('/campaigns/APE_SPRINT/chase').expect(403)).body.error.code).toBe('PERM_DENIED');
        expect((await http().delete('/campaigns/APE_SPRINT/chase').expect(403)).body.error.code).toBe('PERM_DENIED');
      }
    });
  });

  describe('whose chases (T7 AC-6, T9 AC-2)', () => {
    const chasing = (query: Record<string, string> = {}) => http().get('/campaigns/chasing').query(query);

    beforeEach(async () => {
      as('RINA');
      for (const code of ['APE_SPRINT', 'MDRT_QUALIFICATION', 'NEXT_PUSH']) await http().put(`/campaigns/${code}/chase`).expect(200);
      // An ended campaign Rina chased while it ran: on no list (D-lists).
      await db().collection('campaignChases').insertOne({
        kpmId: '66f0000000000000000000a1', membershipId: office.id.RINA, campaignCode: 'OLD_PUSH', chasing: true, deletedAt: null,
      });
    });

    it('P18.5-T7 AC-6 the reader’s own chases, not ended, in order — the Summary card’s rows', async () => {
      as('RINA');
      const res = await chasing().expect(200);
      expect(res.body.membershipId).toBe(office.id.RINA);
      expect(res.body.campaigns).toEqual([
        { code: 'APE_SPRINT', title: 'APE Sprint', kind: 'seasonal', subtype: null, phase: 'running', duration: 'Aug 1 – Sep 30, 2026', poster: { emoji: '🚀', color: 'amber' } },
        { code: 'NEXT_PUSH', title: 'Q4 Push', kind: 'seasonal', subtype: null, phase: 'upcoming', duration: 'Oct 1 – Dec 31, 2026', poster: { emoji: '🎯', color: 'navy' } },
        { code: 'MDRT_QUALIFICATION', title: 'MDRT Qualification', kind: 'structural', subtype: 'ongoing', phase: 'running', duration: 'Standing — evaluated per calendar year (Jan 1 – Dec 31)', poster: { emoji: '🏆', color: 'gold' } },
      ]);
      // Naming herself is her own read.
      expect((await chasing({ for: office.id.RINA }).expect(200)).body).toEqual(res.body);
    });

    it.each(['SARI', 'AGUS', 'OWNER', 'ADMIN'] as const)('P18.5-T9 AC-2 positive, exit test 3: %s reads the same chases Rina’s own Summary lists', async (who) => {
      as('RINA');
      const own = (await chasing().expect(200)).body;
      as(who);
      expect((await chasing({ for: office.id.RINA }).expect(200)).body).toEqual(own);
    });

    it.each([['BUDI', 'an agent, about a peer'], ['PEER_AB', 'a peer AB'], ['DEWI', 'an AAB leading nobody'], ['B_AB', 'another office']] as const)(
      'P18.5-T9 AC-2 negative: %s (%s) is answered 404 for Rina', async (who, _what) => {
        as(who);
        expect((await chasing({ for: office.id.RINA }).expect(404)).body.error.code).toBe('NOT_FOUND');
      },
    );

    it('P18.5-T9 AC-2 another office’s member and an invented id are 404 alike; any other parameter 400', async () => {
      as('OWNER');
      expect((await chasing({ for: office.id.B_AGENT }).expect(404)).body.error.code).toBe('NOT_FOUND');
      expect((await chasing({ for: 'not-an-id' }).expect(404)).body.error.code).toBe('NOT_FOUND');
      expect((await chasing({ membershipId: office.id.RINA }).expect(400)).body.error.code).toBe('VALIDATION_FAILED');
    });

    it('P18.5-T9 AC-2 a read-only support session reads them; nothing is recorded', async () => {
      const before = await db().collection('auditLog').countDocuments({});
      supporting('SARI', true);
      expect((await chasing({ for: office.id.RINA }).expect(200)).body.campaigns).toHaveLength(3);
      expect(await db().collection('auditLog').countDocuments({})).toBe(before);
    });

    it('P18.5-T8 review item 11 a member who has left is not found, even by the Owner', async () => {
      as('OWNER');
      expect((await chasing({ for: office.id.LEFT }).expect(404)).body.error.code).toBe('NOT_FOUND');
    });

    it('P18.5-T7 AC-6 somebody chasing nothing reads an empty list', async () => {
      as('BUDI');
      expect((await chasing().expect(200)).body).toEqual({ membershipId: office.id.BUDI, campaigns: [] });
      expect(KPM_B).toBeTruthy();
    });
  });
});
