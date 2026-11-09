import { INestApplication } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { Test } from '@nestjs/testing';
import mongoose from 'mongoose';
import request from 'supertest';
import { PermissionsGuard } from '@/common/auth/permissions.guard';
import { FixedClock } from '@/common/clock/clock.port';
import { RequestContext } from '@/common/context/request-context';
import { DomainExceptionFilter } from '@/common/errors/error.filter';
import { AuditLog, AuditLogSchema } from '@/modules/audit/audit-log.schema';
import { AuditService } from '@/modules/audit/audit.service';
import { Campaign, CampaignSchema, QualificationRule, QualificationRuleSchema } from '@/modules/campaigns/campaign.schema';
import { CampaignRepository } from '@/modules/campaigns/campaign.repository';
import {
  ActivityCategoryRepository, ConfigSnapshotRepository, RatioDefinitionRepository,
} from '@/modules/config/activity.repository';
import { ActivityCategory, ActivityCategorySchema } from '@/modules/config/activity-category.schema';
import { CompanyTemplate, CompanyTemplateSchema } from '@/modules/config/company-template.schema';
import { ConfigSnapshot, ConfigSnapshotSchema } from '@/modules/config/config-snapshot.schema';
import { RatioDefinition, RatioDefinitionSchema } from '@/modules/config/ratio-definition.schema';
import { MembershipRepository } from '@/modules/org/membership.repository';
import { Membership, MembershipSchema } from '@/modules/org/membership.schema';
import { MembershipHistory, MembershipHistorySchema } from '@/modules/org/membership-history.schema';
import { LeaderLimitRequest, LeaderLimitRequestSchema } from '@/modules/org/leader-limit-request.schema';
import { LeaderLimitRequestRepository, MembershipHistoryRepository } from '@/modules/org/org.repositories';
import { EVERY_MEMBER, OWNER, productionPipe, session, StubAuth, SUPER_ADMIN } from '../../../test/http-permissions';
import { listenOnLoopback } from '../../../test/listen';
import { IN_INDONESIAN } from '../../../test/i18n';
import { clearCollections, startMongo, stopMongo, syncIndexes } from '../../../test/mongo';
import { AdminController } from './admin.controller';
import { Company, CompanySchema } from './company.schema';
import { CompanyOrgLevel, CompanyOrgLevelSchema } from './company-org-level.schema';
import { Kpm, KpmSchema } from './kpm.schema';
import { OrgLevelReferences } from './org-level-references';
import { OrgLevelService } from './org-level.service';

const NOW = new Date('2026-11-05T03:00:00Z');
/** A view-as session as the Owner: it only looks (ADR-0206). */
const viewAs = (who: RequestContext) => new RequestContext(who.userId, 'none', who.membership, 'u-support', null, false, true);

type Rung = { orgLevelId: string; code: string; label: string; status: string; version: number };

/**
 * **A rung's label edited, an unused archived rung deleted, and the table answered after each** (P19.4-T5 AC-1, AC-2,
 * AC-3, AC-11; ADR-0213 §1, §2; the 11-03 handover's B1-6). Over HTTP through `AdminController`, the guard, the pipe
 * and the filter real, and the reference search over the real collections: Manulife's archived AAB and AB go, and
 * Prudential's, which members stand on, do not — nor one that any record of each kind names.
 */
describe('P19.4-T5 /admin/org-levels — the label, the delete and the table after each', () => {
  let app: INestApplication;
  const col = (name: string) => mongoose.connection.collection(name);
  let manulife = '';
  let prudential = '';
  let kpm = '';

  beforeAll(async () => {
    await startMongo();
    const model = <T>(name: string, schema: mongoose.Schema<T>) => mongoose.model(name, schema) as never;
    const kpms = model(Kpm.name, KpmSchema);
    const memberships = new MembershipRepository(model(Membership.name, MembershipSchema));
    const references = new OrgLevelReferences(
      kpms,
      model(CompanyTemplate.name, CompanyTemplateSchema),
      model(QualificationRule.name, QualificationRuleSchema),
      memberships,
      new MembershipHistoryRepository(model(MembershipHistory.name, MembershipHistorySchema)),
      new LeaderLimitRequestRepository(model(LeaderLimitRequest.name, LeaderLimitRequestSchema)),
      new ActivityCategoryRepository(model(ActivityCategory.name, ActivityCategorySchema)),
      new RatioDefinitionRepository(model(RatioDefinition.name, RatioDefinitionSchema)),
      new ConfigSnapshotRepository(model(ConfigSnapshot.name, ConfigSnapshotSchema)),
      new CampaignRepository(model(Campaign.name, CampaignSchema)),
    );
    const orgLevels = new OrgLevelService(
      model(CompanyOrgLevel.name, CompanyOrgLevelSchema), model(Company.name, CompanySchema), kpms,
      new AuditService(model(AuditLog.name, AuditLogSchema)), new FixedClock(NOW), memberships, references,
    );
    const moduleRef = await Test.createTestingModule({
      controllers: [AdminController],
      providers: [{ provide: OrgLevelService, useValue: orgLevels }],
    })
      .useMocker(() => ({}))
      .compile();
    app = moduleRef.createNestApplication();
    app.setGlobalPrefix('api');
    app.useGlobalPipes(productionPipe());
    app.useGlobalFilters(new DomainExceptionFilter());
    app.useGlobalGuards(new StubAuth(), new PermissionsGuard(app.get(Reflector)));
    await app.init();
    await listenOnLoopback(app);
    await syncIndexes();
  });

  afterAll(async () => {
    await app.close();
    await stopMongo();
  });

  const api = () => request(app.getHttpServer());
  const ladderOf = async (companyId: string) =>
    (await api().get('/api/admin/org-levels').query({ companyId }).expect(200)).body as Rung[];
  const rung = async (companyId: string, code: string) => (await ladderOf(companyId)).find((r) => r.code === code)!;
  const remove = (r: Rung, expectedVersion?: number) => api()
    .delete(`/api/admin/org-levels/${r.orgLevelId}`)
    .query(expectedVersion === undefined ? {} : { expectedVersion });
  const archive = async (companyId: string, code: string) => {
    const r = await rung(companyId, code);
    await api().patch(`/api/admin/org-levels/${r.orgLevelId}`).send({ status: 'archived', expectedVersion: r.version }).expect(200);
    return rung(companyId, code);
  };

  beforeEach(async () => {
    await clearCollections();
    session.current = SUPER_ADMIN;
    const companies = mongoose.model(Company.name);
    manulife = String((await companies.create({ name: 'Manulife', slug: 'manulife' }))._id);
    prudential = String((await companies.create({ name: 'Prudential', slug: 'prudential' }))._id);
    for (const companyId of [manulife, prudential]) {
      for (const [code, displayOrder] of [['AGENT', 1], ['AAB', 2], ['AB', 3]] as const) {
        await api().post('/api/admin/org-levels').send({ companyId, code, label: code, displayOrder }).expect(201);
      }
    }
    kpm = String((await mongoose.model(Kpm.name).create({ companyId: prudential, code: '0417', branchName: 'BSD City' }))._id);
    // Prudential's people stand on its AB and AAB.
    for (const code of ['AB', 'AAB']) {
      await col('memberships').insertOne({
        kpmId: kpm, userId: `u-${code}`, orgLevelId: (await rung(prudential, code)).orgLevelId, orgLevelCode: code,
        leaderCode: `LC-${code}`, agentCode: `100${code.length}`, status: 'active', deletedAt: null,
      });
    }
  });

  describe('AC-1: the label', () => {
    it('P19.4-T5 AC-1 is edited and saved, and the code never changes — it is not in the body', async () => {
      const ab = await rung(manulife, 'AB');
      const res = await api().patch(`/api/admin/org-levels/${ab.orgLevelId}`)
        .send({ label: 'Agency Builder', expectedVersion: ab.version }).expect(200);
      expect((res.body as Rung[]).find((r) => r.orgLevelId === ab.orgLevelId)).toMatchObject({ code: 'AB', label: 'Agency Builder' });
      const renamed = await api().patch(`/api/admin/org-levels/${ab.orgLevelId}`).send({ code: 'XX', label: 'X' }).expect(400);
      expect(renamed.body.error.code).toBe('VALIDATION_FAILED');
      expect(await rung(manulife, 'AB')).toMatchObject({ label: 'Agency Builder' });
    });
  });

  describe('AC-3: the table after Arsipkan', () => {
    it('P19.4-T5 AC-3 the archive answers the company’s whole ladder with the rung archived — what the table shows at once', async () => {
      const aab = await rung(manulife, 'AAB');
      const res = await api().patch(`/api/admin/org-levels/${aab.orgLevelId}`)
        .send({ status: 'archived', expectedVersion: aab.version }).expect(200);
      expect((res.body as Rung[]).map((r) => [r.code, r.status])).toEqual([['AGENT', 'active'], ['AAB', 'archived'], ['AB', 'active']]);
    });
  });

  describe('AC-2: the delete', () => {
    it('P19.4-T5 AC-2 deletes Manulife’s archived AAB and AB: soft, audited with code and label, and the ladder answered without them', async () => {
      for (const code of ['AAB', 'AB']) {
        const archived = await archive(manulife, code);
        const res = await remove(archived, archived.version).expect(200);
        expect((res.body as Rung[]).map((r) => r.code)).not.toContain(code);
        const row = await col('companyOrgLevels').findOne({ _id: new mongoose.Types.ObjectId(archived.orgLevelId) });
        expect(row!.deletedAt).toEqual(NOW);
        expect(await col('auditLog').findOne({ action: 'org_level.deleted', targetId: archived.orgLevelId })).toMatchObject({
          after: { companyId: manulife, code, label: code },
        });
      }
      expect((await ladderOf(manulife)).map((r) => r.code)).toEqual(['AGENT']);
    });

    it('P19.4-T5 AC-2 refuses Prudential’s archived AB, which members stand on: 409 ORG_LEVEL_IN_USE, why, nothing written', async () => {
      const archived = await archive(prudential, 'AB');
      const res = await remove(archived).expect(409);
      expect(res.body.error).toMatchObject({
        code: 'ORG_LEVEL_IN_USE',
        details: { code: 'AB', references: [{ kind: 'memberships', count: 1 }] },
      });
      expect(res.body.error.message).toMatch(/^AB cannot be deleted: 1 membership\(s\) still names it\./);
      const id = await api().delete(`/api/admin/org-levels/${archived.orgLevelId}`).set(...IN_INDONESIAN).expect(409);
      expect(id.body.error.message).toMatch(/^AB tidak dapat dihapus: masih dipakai oleh 1 keanggotaan\./);
      expect(await col('companyOrgLevels').countDocuments({ _id: new mongoose.Types.ObjectId(archived.orgLevelId), deletedAt: null })).toBe(1);
    });

    it('P19.4-T5 AC-2 refuses a live rung: archive it first', async () => {
      const live = await rung(manulife, 'AB');
      const res = await remove(live).expect(409);
      expect(res.body.error).toMatchObject({ code: 'ORG_LEVEL_IN_USE', details: { status: 'active', references: [] } });
      expect(res.body.error.message).toContain('Archive it first');
    });

    /** One record of each kind that names Manulife's AB, in its office or the company — each refuses the delete alone. */
    const NAMERS: [kind: string, write: (ids: { office: string; companyId: string; orgLevelId: string }) => Promise<unknown>][] = [
      ['memberships', ({ office, orgLevelId }) => col('memberships').insertOne({
        kpmId: office, userId: 'gone', orgLevelId, orgLevelCode: 'AB', leaderCode: 'LC-GONE', agentCode: '9001',
        status: 'removed', deletedAt: null,
      })],
      ['membershipHistory', ({ office, orgLevelId }) => col('membershipHistory').insertOne({
        kpmId: office, membershipId: 'm-1', eventType: 'role_changed', fromOrgLevelId: orgLevelId, toOrgLevelId: 'other',
        validFrom: NOW, deletedAt: null,
      })],
      ['leaderLimitRequests', ({ office }) => col('leaderLimitRequests').insertOne({
        kpmId: office, subjectMembershipId: 'm-1', action: 'promote', fromOrgLevelCode: 'AGENT', toOrgLevelCode: 'AB',
        status: 'pending', deletedAt: null,
      })],
      ['activityCategories', ({ office }) => col('activityCategories').insertOne({
        kpmId: office, code: 'LEADER', label: 'Leader', appliesToOrgLevelCodes: ['AB'], deletedAt: null,
      })],
      ['ratioDefinitions', ({ office }) => col('ratioDefinitions').insertOne({
        kpmId: office, code: 'R1', label: 'R1', appliesToOrgLevelCodes: ['AB'], deletedAt: null,
      })],
      ['configSnapshots', ({ office }) => col('configSnapshots').insertOne({
        kpmId: office, version: 1, payload: { ratios: [{ code: 'R1', appliesToOrgLevelCodes: ['AB'] }] }, deletedAt: null,
      })],
      ['campaigns', ({ office }) => col('campaigns').insertOne({
        kpmId: office, code: 'C1', name: 'C1', appliesToOrgLevelCodes: ['AB'], deletedAt: null,
      })],
      ['qualificationRules', ({ companyId }) => col('qualificationRules').insertOne({
        companyId, kind: 'promotion_path', code: 'P1', appliesToOrgLevelCodes: ['AB'], deletedAt: null,
      })],
      ['companyTemplates', ({ companyId }) => col('companyTemplates').insertOne({
        companyId, templateId: 't-1', kind: 'ratio_set', version: 2, status: 'draft',
        payload: { ratios: [{ code: 'R1', appliesToOrgLevelCodes: ['AB'] }] }, deletedAt: null,
      })],
    ];

    it.each(NAMERS)('P19.4-T5 AC-2 refuses a rung one %s names, counted by kind', async (kind, write) => {
      const office = String((await mongoose.model(Kpm.name).create({ companyId: manulife, code: '0900', branchName: 'Sudirman' }))._id);
      const archived = await archive(manulife, 'AB');
      await write({ office, companyId: manulife, orgLevelId: archived.orgLevelId });
      const res = await remove(archived).expect(409);
      expect(res.body.error).toMatchObject({ code: 'ORG_LEVEL_IN_USE', details: { references: [{ kind, count: 1 }] } });
    });

    it('P19.4-T5 AC-2 another company’s records never count: Prudential’s members do not hold Manulife’s AB', async () => {
      const archived = await archive(manulife, 'AB');
      await col('ratioDefinitions').insertOne({ kpmId: kpm, code: 'R1', label: 'R1', appliesToOrgLevelCodes: ['AB'], deletedAt: null });
      await remove(archived).expect(200);
    });

    it('P19.4-T5 AC-2 a deleted code may be used again: the new rung is a new row, the old one kept deleted', async () => {
      const archived = await archive(manulife, 'AB');
      await remove(archived).expect(200);
      const res = await api().post('/api/admin/org-levels')
        .send({ companyId: manulife, code: 'AB', label: 'Agency Builder', displayOrder: 3 }).expect(201);
      const again = (res.body as Rung[]).find((r) => r.code === 'AB')!;
      expect(again.orgLevelId).not.toBe(archived.orgLevelId);
      expect(await col('companyOrgLevels').countDocuments({ companyId: manulife, code: 'AB' })).toBe(2);
    });

    it('P19.4-T5 AC-2 a stale version is 409 VERSION_CONFLICT, a rung not there 404, and a second delete 404', async () => {
      const archived = await archive(manulife, 'AB');
      await remove(archived, archived.version - 1).expect(409);
      await api().delete('/api/admin/org-levels/66f00000000000000000ffff').expect(404);
      await api().delete('/api/admin/org-levels/not-an-id').expect(404);
      await remove(archived).expect(200);
      await remove(archived).expect(404);
    });
  });

  describe('AC-11: who may', () => {
    it.each([...EVERY_MEMBER, ['a view-as session', viewAs(OWNER)] as [string, RequestContext]])(
      'P19.4-T5 AC-11 refuses %s the label and the delete, 403, nothing written',
      async (_who, who) => {
        const archived = await archive(manulife, 'AB');
        session.current = who;
        await api().patch(`/api/admin/org-levels/${archived.orgLevelId}`).send({ label: 'X' }).expect(403);
        await remove(archived).expect(403);
        session.current = SUPER_ADMIN;
        expect(await rung(manulife, 'AB')).toMatchObject({ label: 'AB', status: 'archived' });
      },
    );
  });
});
