import { INestApplication } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { Test } from '@nestjs/testing';
import mongoose from 'mongoose';
import request from 'supertest';
import { PermissionsGuard } from '@/common/auth/permissions.guard';
import { RequestContext } from '@/common/context/request-context';
import { DomainExceptionFilter } from '@/common/errors/error.filter';
import { clearCollections, startMongo, stopMongo, syncIndexes } from '../../../test/mongo';
import { configModule } from '../../../test/config-module';
import { declaredPermissions, productionPipe, session, StubAuth } from '../../../test/http-permissions';
import { listenOnLoopback } from '../../../test/listen';
import { IN_INDONESIAN } from '../../../test/i18n';
import { buildCoachingOffice, KPM_A, ROSTER_NOW, type CoachingOffice, type Who } from '../../../test/coaching-office';
import { CampaignController } from './campaign.controller';
import { CampaignService } from './campaign.service';
import { CampaignStandingOverrides } from './campaign-standing-overrides';

const wib = (local: string) => new Date(`${local}+07:00`).toISOString();
const APE = { metricKey: 'APE_ACHIEVED', comparator: 'gte', value: 1 };
const REASON = 'Persistency corrected by the carrier after the month locked.';

/**
 * **The override's two routes over HTTP** (P18.3-T2 AC-5): `PUT` and `DELETE
 * /kpm/settings/campaigns/:code/standings/:membershipId/override`, with the real `PermissionsGuard`, the production
 * pipe and the real services over `test/coaching-office.ts` — 10:00 on Monday 14 September 2026 in Jakarta, August
 * locked. `AUGUST_PUSH` is final: Rina qualified, Budi not met; `SEPT_PUSH` runs.
 */
describe('the override of a final standing over HTTP (P18.3-T2 AC-5)', () => {
  let app: INestApplication;
  let wired: ReturnType<typeof configModule>;
  let office: CoachingOffice;
  const db = () => mongoose.connection.db!;
  const http = () => request(app.getHttpServer());
  const as = (who: Who) => { session.current = office.as(who); };
  /** A support session as a member: read-only unless elevated. */
  const supporting = (who: Who, readOnly: boolean) => {
    const c = office.as(who);
    session.current = new RequestContext(c.userId, 'none', c.membership, 'u-operator', null, false, readOnly);
  };
  const path = (code: string, who: Who | string) =>
    `/kpm/settings/campaigns/${code}/standings/${who in (office?.id ?? {}) ? office.id[who as Who] : who}/override`;
  const put = (code: string, who: Who | string, body: unknown) => http().put(path(code, who)).send(body as object);
  const del = (code: string, who: Who | string, body?: unknown) => {
    const req = http().delete(path(code, who));
    return body === undefined ? req : req.send(body as object);
  };
  const audits = (action: string) => db().collection('auditLog').countDocuments({ action });

  beforeAll(async () => {
    await startMongo();
    wired = configModule(ROSTER_NOW);
    await syncIndexes();
    const moduleRef = await Test.createTestingModule({
      controllers: [CampaignController],
      providers: [
        { provide: CampaignService, useValue: wired.campaigns },
        { provide: CampaignStandingOverrides, useValue: wired.campaignStandingOverrides },
      ],
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
    await clearCollections();
    office = await buildCoachingOffice(wired);
    const o = office.as('OWNER');
    await wired.campaigns.create(o, { code: 'AUGUST_PUSH', title: 'August Push', startsAt: wib('2026-08-01T00:00:00'), endsAt: wib('2026-08-31T23:59:00'), requirements: [APE] });
    await wired.campaigns.create(o, { code: 'SEPT_PUSH', title: 'September Push', startsAt: wib('2026-09-01T00:00:00'), endsAt: wib('2026-09-30T23:59:00'), requirements: [APE] });
    for (const [code, who] of [['AUGUST_PUSH', 'RINA'], ['AUGUST_PUSH', 'BUDI'], ['AUGUST_PUSH', 'OWNER'], ['SEPT_PUSH', 'RINA']] as const) {
      await db().collection('campaignChases').insertOne({
        kpmId: KPM_A, membershipId: office.id[who], campaignCode: code, chasing: true, chasedAt: new Date('2026-01-05T02:00:00Z'),
        unchasedAt: null, closedBy: null, deletedAt: null,
      });
    }
  }, 60_000);

  it('P18.3-T2 AC-5 both routes declare campaign_qualification:override', () => {
    const declared = declaredPermissions(CampaignController);
    expect({ override: declared.override, clearOverride: declared.clearOverride })
      .toEqual({ override: 'campaign_qualification:override', clearOverride: 'campaign_qualification:override' });
  });

  describe('who may (P18.3-T2 AC-5, roles §3.11)', () => {
    it.each(['OWNER', 'ADMIN'] as const)('P18.3-T2 AC-5 positive: %s sets and clears an override', async (who) => {
      as(who);
      const set = await put('AUGUST_PUSH', 'BUDI', { status: 'qualified', reason: REASON }).expect(200);
      expect(set.body).toEqual({
        campaignCode: 'AUGUST_PUSH', membershipId: office.id.BUDI, status: 'qualified',
        override: { status: 'qualified', reason: REASON, by: { membershipId: office.id[who], name: office.name[who] }, at: ROSTER_NOW.toISOString() },
      });
      const cleared = await del('AUGUST_PUSH', 'BUDI', { reason: 'Set in error.' }).expect(200);
      expect(cleared.body).toEqual({ campaignCode: 'AUGUST_PUSH', membershipId: office.id.BUDI, status: 'not_met', override: null });
      expect([await audits('campaign_standing.overridden'), await audits('campaign_standing.override_cleared')]).toEqual([1, 1]);
    });

    it.each(['AGUS', 'SARI', 'RINA', 'BUDI'] as const)('P18.3-T2 AC-5 negative: %s is refused 403 PERM_DENIED, nothing written', async (who) => {
      as(who);
      const res = await put('AUGUST_PUSH', 'BUDI', { status: 'qualified', reason: REASON }).expect(403);
      expect(res.body.error).toMatchObject({ code: 'PERM_DENIED', details: { permission: 'campaign_qualification:override' } });
      await del('AUGUST_PUSH', 'BUDI', { reason: 'x' }).expect(403);
      expect(await db().collection('campaignStandings').countDocuments({ 'override.status': { $exists: true } })).toBe(0);
    });

    it('P18.3-T2 AC-5 negative: a Super Admin outside a support session has no office — 403 TENANT_NO_MEMBERSHIP', async () => {
      session.current = RequestContext.platform('root');
      const res = await put('AUGUST_PUSH', 'BUDI', { status: 'qualified', reason: REASON }).expect(403);
      expect(res.body.error.code).toBe('TENANT_NO_MEMBERSHIP');
    });

    it('P18.3-T2 AC-5 negative: a read-only support session is refused both, freezing nothing', async () => {
      supporting('OWNER', true);
      const res = await put('AUGUST_PUSH', 'BUDI', { status: 'qualified', reason: REASON }).expect(403);
      expect(res.body.error.code).toBe('PERM_DENIED');
      await del('AUGUST_PUSH', 'BUDI', { reason: 'x' }).expect(403);
      expect(await audits('campaign_standing.finalised')).toBe(0);
      expect(await db().collection('campaignStandings').countDocuments({})).toBe(0);
    });

    it('P18.3-T2 AC-5 positive: an elevated support session writes as the Owner, both actors on the entry', async () => {
      supporting('OWNER', false);
      await put('AUGUST_PUSH', 'BUDI', { status: 'qualified', reason: REASON }).expect(200);
      const entry = await db().collection('auditLog').findOne({ action: 'campaign_standing.overridden' });
      expect(entry).toMatchObject({ actorUserId: 'u-operator', effectiveUserId: office.as('OWNER').userId, actorMembershipId: office.id.OWNER });
    });

    it('P18.3-T2 AC-5 negative: an elevated session as a field member holds nothing', async () => {
      supporting('AGUS', false);
      await put('AUGUST_PUSH', 'BUDI', { status: 'qualified', reason: REASON }).expect(403);
    });
  });

  describe('nobody overrides their own result (the exit review, round 1)', () => {
    it('round 1 negative: the Owner’s own row, PUT and DELETE — 400 CAMPAIGN_OVERRIDE_SELF, naming the membership', async () => {
      as('OWNER');
      const set = await put('AUGUST_PUSH', 'OWNER', { status: 'qualified', reason: REASON }).expect(400);
      expect(set.body.error).toMatchObject({
        code: 'CAMPAIGN_OVERRIDE_SELF', message: 'You can’t override your own result.', details: { membershipId: office.id.OWNER },
      });
      const cleared = await del('AUGUST_PUSH', 'OWNER', { reason: 'Mine' }).expect(400);
      expect(cleared.body.error.code).toBe('CAMPAIGN_OVERRIDE_SELF');
      expect(await audits('campaign_standing.overridden')).toBe(0);
    });

    it('round 1 positive: the Admin overrides the Owner’s result', async () => {
      as('ADMIN');
      const res = await put('AUGUST_PUSH', 'OWNER', { status: 'qualified', reason: REASON }).expect(200);
      expect(res.body).toMatchObject({ membershipId: office.id.OWNER, status: 'qualified', override: { by: { membershipId: office.id.ADMIN } } });
    });

    it('round 1 negative: an elevated support session as the Owner is refused on the Owner’s own row', async () => {
      supporting('OWNER', false);
      const res = await put('AUGUST_PUSH', 'OWNER', { status: 'qualified', reason: REASON }).expect(400);
      expect(res.body.error).toMatchObject({ code: 'CAMPAIGN_OVERRIDE_SELF', details: { membershipId: office.id.OWNER } });
    });
  });

  describe('what it refuses (P18.3-T2 AC-5)', () => {
    beforeEach(() => as('OWNER'));

    it.each([
      [{ status: 'qualified', reason: '   ' }, 'reason must be 1–500 characters.'],
      [{ status: 'qualified', reason: 'x'.repeat(501) }, 'reason must be 1–500 characters.'],
      [{ status: 'qualified' }, 'reason is required.'],
      [{ status: 'achieved', reason: 'x' }, 'status must be one of qualified, not_met.'],
    ])('P18.3-T2 AC-5 400 VALIDATION_FAILED for %j', async (body, said) => {
      const res = await put('AUGUST_PUSH', 'BUDI', body).expect(400);
      expect(res.body.error).toMatchObject({ code: 'VALIDATION_FAILED', details: { violations: expect.arrayContaining([said]) } });
    });

    it('P18.3-T2 AC-5 400 for a field the body does not take — the pipe’s own refusal', async () => {
      const res = await put('AUGUST_PUSH', 'BUDI', { status: 'qualified', reason: 'x', by: 'me' }).expect(400);
      expect(res.body.error.code).toBe('VALIDATION_FAILED');
      expect(JSON.stringify(res.body.error)).toContain('by');
    });

    it('P18.3-T2 AC-5 400 for a clear with no reason, with a blank one, or with no body at all', async () => {
      await put('AUGUST_PUSH', 'BUDI', { status: 'qualified', reason: REASON }).expect(200);
      for (const body of [{}, { reason: ' ' }, undefined]) {
        const res = await del('AUGUST_PUSH', 'BUDI', body).expect(400);
        expect(res.body.error.code).toBe('VALIDATION_FAILED');
      }
      expect(await audits('campaign_standing.override_cleared')).toBe(0);
    });

    it('P18.3-T2 AC-5 400 for the status it already reads, naming it in details', async () => {
      const res = await put('AUGUST_PUSH', 'BUDI', { status: 'not_met', reason: 'x' }).expect(400);
      expect(res.body.error).toMatchObject({ code: 'VALIDATION_FAILED', details: { status: 'not_met' } });
    });

    it('P18.3-T2 AC-5 409 CAMPAIGN_STANDING_NOT_FINAL before final', async () => {
      const res = await put('SEPT_PUSH', 'RINA', { status: 'not_met', reason: 'x' }).expect(409);
      expect(res.body.error).toMatchObject({ code: 'CAMPAIGN_STANDING_NOT_FINAL', details: { code: 'SEPT_PUSH' } });
      await del('SEPT_PUSH', 'RINA', { reason: 'x' }).expect(409);
    });

    it('P18.3-T2 AC-5 404 NOT_FOUND: an unknown campaign, another office’s member, a non-chaser, a clear with no override', async () => {
      await put('NO_SUCH_PUSH', 'BUDI', { status: 'qualified', reason: 'x' }).expect(404);
      await put('AUGUST_PUSH', 'B_AGENT', { status: 'qualified', reason: 'x' }).expect(404);
      await put('AUGUST_PUSH', 'not-an-id', { status: 'qualified', reason: 'x' }).expect(404);
      const res = await put('AUGUST_PUSH', 'INDAH', { status: 'qualified', reason: 'x' }).expect(404);
      expect(res.body.error.code).toBe('NOT_FOUND');
      await del('AUGUST_PUSH', 'BUDI', { reason: 'x' }).expect(404);
    });

    it('P18.3-T2 AC-5 takes the campaign’s code in any case', async () => {
      await put('august_push', 'BUDI', { status: 'qualified', reason: REASON }).expect(200);
    });
  });

  /** **The override's refusals in Bahasa Indonesia** (P18.10-T5 AC-7): the codes and details as in English. */
  describe('P18.10-T5 AC-7 the override’s refusals in Indonesian', () => {
    it('P18.10-T5 AC-7 one’s own result, a result not final, the status it already reads and a missing reason', async () => {
      as('OWNER');
      const own = await put('AUGUST_PUSH', 'OWNER', { status: 'qualified', reason: REASON }).set(...IN_INDONESIAN).expect(400);
      expect(own.body.error).toMatchObject({
        code: 'CAMPAIGN_OVERRIDE_SELF', message: 'Anda tidak dapat mengoreksi hasil Anda sendiri.', details: { membershipId: office.id.OWNER },
      });
      const early = await put('SEPT_PUSH', 'RINA', { status: 'not_met', reason: 'x' }).set(...IN_INDONESIAN).expect(409);
      expect(early.body.error).toMatchObject({
        code: 'CAMPAIGN_STANDING_NOT_FINAL',
        message: 'Hasil campaign ini belum final. Hasil ini dapat dikoreksi manual setelah bulan terakhir yang dibacanya dikunci.',
        details: { code: 'SEPT_PUSH' },
      });
      const already = await put('AUGUST_PUSH', 'BUDI', { status: 'not_met', reason: 'x' }).set(...IN_INDONESIAN).expect(400);
      expect(already.body.error).toMatchObject({
        code: 'VALIDATION_FAILED', message: 'Hasil ini sudah bernilai not_met.',
        details: { status: 'not_met', violations: ['status sudah bernilai not_met.'] },
      });
      const noReason = await put('AUGUST_PUSH', 'BUDI', { status: 'qualified' }).set(...IN_INDONESIAN).expect(400);
      expect(noReason.body.error.details.violations).toEqual(['reason wajib diisi.']);
      const none = await del('AUGUST_PUSH', 'BUDI', { reason: 'x' }).set(...IN_INDONESIAN).expect(404);
      expect(none.body.error).toMatchObject({ code: 'NOT_FOUND', message: 'Koreksi manual tidak ditemukan.' });
    });
  });
});
