import { INestApplication } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { Test } from '@nestjs/testing';
import mongoose from 'mongoose';
import request from 'supertest';
import { PermissionsGuard } from '@/common/auth/permissions.guard';
import { DomainExceptionFilter } from '@/common/errors/error.filter';
import { AUDIT_LOG } from '@/domain/constants';
import { CompanyTemplate, CompanyTemplateSchema } from '@/modules/config/company-template.schema';
import { NamedTemplate, NamedTemplateSchema } from '@/modules/config/named-template.schema';
import { Product, ProductSchema } from '@/modules/products/product.schema';
import { CompanyOrgLevel, CompanyOrgLevelSchema } from '@/modules/tenants/company-org-level.schema';
import { KpmRequest, KpmRequestSchema } from '@/modules/tenants/kpm-request.schema';
import { MembershipRepository } from '@/modules/org/membership.repository';
import { Membership, MembershipSchema } from '@/modules/org/membership.schema';
import { AdminController } from '@/modules/tenants/admin.controller';
import { Company, CompanySchema } from '@/modules/tenants/company.schema';
import { Kpm, KpmSchema } from '@/modules/tenants/kpm.schema';
import { User, UserSchema } from '@/modules/users/user.schema';
import {
  AAB, AB, ADMIN, AGENT, FIXTURE_KPM, OWNER, productionPipe, session, StubAuth, SUPER_ADMIN,
} from '../../../test/http-permissions';
import { listenOnLoopback } from '../../../test/listen';
import { clearCollections, startMongo, stopMongo } from '../../../test/mongo';
import { AuditLog, AuditLogSchema } from './audit-log.schema';
import { AuditReadService } from './audit-read.service';
import { AuditService } from './audit.service';

/** The other office, and two companies: Prudential holds `FIXTURE_KPM`, Manulife holds `KPM_B`. */
const KPM_B = '66f0000000000000000000b1';
const PRU = '66f0000000000000000000c1';
const MANU = '66f0000000000000000000c2';
const ROOT_ID = '66f0000000000000000000e1';
const OTHER_ID = '66f0000000000000000000e2';

/** 2 Nov 2026, 23.14 in Jakarta. */
const T0 = new Date('2026-11-02T16:14:00Z').getTime();
const MINUTE = 60_000;

/**
 * **`GET /admin/audit`, a page at a time** (P19.2-T2 AC-6; UI-132, its Appendix D row; `metrics-and-definitions.md`
 * §B.32): the first fifty groups and a cursor, the filters, the grouping's edges, the reach — a Super Admin's any scope,
 * an Owner or an Admin pinned to their own office whatever they pass, nobody else at all — ADR-0073's drop before
 * grouping, and an operator in the query refused.
 *
 * `AuditReadService` and `AuditService` are real over a real database, with the controller's real guard and the
 * deployed pipe; the controller's other collaborators are inert, since no route here reaches them.
 */
describe('GET /admin/audit — paged, filtered and grouped on the server (P19.2-T2)', () => {
  let app: INestApplication;
  let audit: mongoose.Model<AuditLog>;
  let memberships: mongoose.Model<Membership>;

  beforeAll(async () => {
    await startMongo();
    audit = mongoose.model(AuditLog.name, AuditLogSchema) as never;
    memberships = mongoose.model(Membership.name, MembershipSchema) as never;
    const users = mongoose.model(User.name, UserSchema);
    const kpms = mongoose.model(Kpm.name, KpmSchema);
    const companies = mongoose.model(Company.name, CompanySchema);
    const read = new AuditReadService(
      new AuditService(audit as never), users as never, new MembershipRepository(memberships as never),
      kpms as never, companies as never,
      // P19.4-T3 AC-11: the names of templates, sections, products, rungs and KPM requests.
      mongoose.model(NamedTemplate.name, NamedTemplateSchema) as never,
      mongoose.model(CompanyTemplate.name, CompanyTemplateSchema) as never,
      mongoose.model(Product.name, ProductSchema) as never,
      mongoose.model(CompanyOrgLevel.name, CompanyOrgLevelSchema) as never,
      mongoose.model(KpmRequest.name, KpmRequestSchema) as never,
    );

    const moduleRef = await Test.createTestingModule({
      controllers: [AdminController],
      providers: [{ provide: AuditReadService, useValue: read }],
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
  });

  afterAll(async () => {
    await app.close();
    await stopMongo();
  });

  beforeEach(async () => {
    await clearCollections();
    session.current = SUPER_ADMIN;
    const db = mongoose.connection.db!;
    await db.collection('users').insertMany([
      { _id: new mongoose.Types.ObjectId(ROOT_ID), email: 'root@agencyboost.test', fullName: 'Superadmin' },
      { _id: new mongoose.Types.ObjectId(OTHER_ID), email: 'ops@agencyboost.test', fullName: 'Operator Dua' },
    ]);
    await db.collection('companies').insertMany([
      { _id: new mongoose.Types.ObjectId(PRU), name: 'Prudential', slug: 'prudential' },
      { _id: new mongoose.Types.ObjectId(MANU), name: 'Manulife', slug: 'manulife' },
    ]);
    await db.collection('kpms').insertMany([
      { _id: new mongoose.Types.ObjectId(FIXTURE_KPM), companyId: PRU, code: '0417', branchName: 'Surabaya', timezone: 'Asia/Jakarta' },
      { _id: new mongoose.Types.ObjectId(KPM_B), companyId: MANU, code: '0001', branchName: 'Jakarta', timezone: 'Asia/Jakarta' },
    ]);
  });

  const api = () => request(app.getHttpServer());
  const read = (query = '') => api().get(`/api/admin/audit${query}`);

  /** A row written `minutesAgo` before 23.14 on 2 Nov, straight to the model — the log is append-only and nothing else writes it here. */
  async function write(minutesAgo: number, over: Record<string, unknown> = {}) {
    // Through the collection, so the time written is the one given rather than the schema's timestamp.
    const createdAt = new Date(T0 - minutesAgo * MINUTE);
    const { insertedId } = await mongoose.connection.db!.collection('auditLog').insertOne({
      kpmId: null, actorUserId: ROOT_ID, effectiveUserId: null, action: 'company.updated', targetCollection: 'companies',
      targetId: PRU, before: null, after: null, createdAt, updatedAt: createdAt, ...over,
    });
    return String(insertedId);
  }

  /** `n` rows a minute and a half apart, each about its own target — every one a group of one. */
  async function singles(n: number, kpmId: string | null = null, from = 0) {
    const ids: string[] = [];
    for (let i = 0; i < n; i += 1) {
      ids.push(await write(from + i * 11, { kpmId, targetCollection: 'kpms', targetId: `t-${from}-${i}` }));
    }
    return ids;
  }

  const shape = (body: { items: { action: string; count: number }[] }) => body.items.map((g) => `${g.action}×${g.count}`);

  describe('pages', () => {
    it('P19.2-T2 AC-6 loads the first 50, then Muat lagi’s next page from the cursor, then none', async () => {
      const ids = await singles(60);

      const first = (await read().expect(200)).body;
      expect(first.items).toHaveLength(AUDIT_LOG.PAGE_SIZE);
      expect(first.items.map((g: { _id: string }) => g._id)).toEqual(ids.slice(0, 50));
      expect(first.page).toMatchObject({ cursor: null, limit: 50, hasMore: true });

      const second = (await read(`?cursor=${first.page.nextCursor}`).expect(200)).body;
      expect(second.items.map((g: { _id: string }) => g._id)).toEqual(ids.slice(50));
      expect(second.page).toMatchObject({ nextCursor: null, hasMore: false });
      expect(second.facets).toBeNull();
    });

    it('P19.2-T2 AC-6 stays stable while rows are added: a page not yet opened does not move', async () => {
      const ids = await singles(60);
      const first = (await read().expect(200)).body;

      // Five more written while the first page is on the screen — newer than everything, as new rows are.
      for (let i = 1; i <= 5; i += 1) await write(-i, { targetCollection: 'kpms', targetId: `new-${i}` });

      const second = (await read(`?cursor=${first.page.nextCursor}`).expect(200)).body;
      expect(second.items.map((g: { _id: string }) => g._id)).toEqual(ids.slice(50));
      // Reading from the top again shows them first.
      expect((await read().expect(200)).body.items[0].targetId).toBe('new-5');
    });

    it('P19.2-T2 AC-6 refuses a cursor it did not write, 400', async () => {
      const res = await read('?cursor=bm90LWEtY3Vyc29y').expect(400);
      expect(res.body.error.code).toBe('VALIDATION_FAILED');
    });
  });

  describe('grouping', () => {
    it('P19.2-T2 AC-6 reads one editing session’s autosaves as one ×28, with its oldest time', async () => {
      for (let i = 0; i < 28; i += 1) {
        await write(i * 0.25, { action: 'company_template.draft_saved', targetCollection: 'companyTemplates', targetId: 'tpl-1' });
      }
      await write(12, { action: 'company.created' });

      const body = (await read().expect(200)).body;
      expect(shape(body)).toEqual(['company_template.draft_saved×28', 'company.created×1']);
      expect(body.items[0]).toMatchObject({
        createdAt: new Date(T0).toISOString(), oldestAt: new Date(T0 - 27 * 0.25 * MINUTE).toISOString(),
      });
    });

    it('P19.2-T2 AC-6 a row exactly 10 minutes older joins the group; past it, a new group', async () => {
      await write(0);
      await write(AUDIT_LOG.GROUP_WINDOW_MINUTES);
      await write(AUDIT_LOG.GROUP_WINDOW_MINUTES + 0.001);

      expect(shape((await read().expect(200)).body)).toEqual(['company.updated×2', 'company.updated×1']);
    });

    it('P19.2-T2 AC-6 another actor or another target breaks a group', async () => {
      await write(0);
      await write(1, { actorUserId: OTHER_ID });
      await write(2);
      await write(3, { targetId: MANU });
      await write(4, { targetId: MANU });

      expect(shape((await read().expect(200)).body))
        .toEqual(['company.updated×1', 'company.updated×1', 'company.updated×1', 'company.updated×2']);
    });
  });

  describe('filters, within the reach', () => {
    it('P19.2-T2 AC-6 Perusahaan: its offices’ rows, rows about it and rows whose change names it', async () => {
      await write(1, { action: 'company.updated', targetId: PRU });
      await write(2, { action: 'product.updated', targetCollection: 'products', targetId: 'p-1', after: { companyId: PRU } });
      await write(3, { action: 'company.updated', targetId: MANU });
      await write(4, { action: 'product.updated', targetCollection: 'products', targetId: 'p-2', after: { companyId: MANU } });
      await write(5, { kpmId: FIXTURE_KPM, action: 'member.role_changed', targetCollection: 'memberships', targetId: 'm-1' });

      expect(shape((await read(`?companyId=${PRU}`).expect(200)).body)).toEqual(['company.updated×1', 'product.updated×1']);
      // An office's rows are the company's too — read in that office's scope.
      expect(shape((await read(`?kpmId=${FIXTURE_KPM}&companyId=${PRU}`).expect(200)).body)).toEqual(['member.role_changed×1']);
      expect((await read(`?kpmId=${FIXTURE_KPM}&companyId=${MANU}`).expect(200)).body.items).toEqual([]);
    });

    it('P19.2-T2 AC-6 Cakupan: one office’s rows, and the platform’s by default', async () => {
      await write(1);
      await write(2, { kpmId: FIXTURE_KPM, action: 'member.role_changed' });
      await write(3, { kpmId: KPM_B, action: 'kpm.suspended' });

      expect(shape((await read().expect(200)).body)).toEqual(['company.updated×1']);
      expect(shape((await read(`?kpmId=${KPM_B}`).expect(200)).body)).toEqual(['kpm.suspended×1']);
    });

    it('P19.2-T2 AC-6 Tindakan and Pelaku: one action, one actor — and together', async () => {
      await write(1, { action: 'company.created' });
      await write(2, { action: 'company.updated', actorUserId: OTHER_ID });
      await write(3, { action: 'company.created', actorUserId: OTHER_ID, targetId: MANU });

      expect(shape((await read('?action=company.created').expect(200)).body)).toEqual(['company.created×1', 'company.created×1']);
      expect((await read(`?actorUserId=${OTHER_ID}`).expect(200)).body.items).toHaveLength(2);
      expect((await read(`?actorUserId=${OTHER_ID}&action=company.created`).expect(200)).body.items[0].targetId).toBe(MANU);
    });

    it('P19.2-T2 AC-6 Tanggal: office days in Jakarta, both ends inclusive', async () => {
      // 00.30 on 2 Nov in Jakarta is 17.30 UTC on 1 Nov; 23.59 on 1 Nov is 16.59 UTC.
      await mongoose.connection.db!.collection('auditLog').insertMany([
        { kpmId: null, actorUserId: ROOT_ID, action: 'company.updated', targetCollection: 'companies', targetId: 'a', createdAt: new Date('2026-11-01T17:30:00Z') },
        { kpmId: null, actorUserId: ROOT_ID, action: 'company.updated', targetCollection: 'companies', targetId: 'b', createdAt: new Date('2026-11-01T16:59:00Z') },
        { kpmId: null, actorUserId: ROOT_ID, action: 'company.updated', targetCollection: 'companies', targetId: 'c', createdAt: new Date('2026-11-02T16:59:00Z') },
        { kpmId: null, actorUserId: ROOT_ID, action: 'company.updated', targetCollection: 'companies', targetId: 'd', createdAt: new Date('2026-11-02T17:00:00Z') },
      ]);

      const day = (await read('?from=2026-11-02&to=2026-11-02').expect(200)).body;
      expect(day.items.map((g: { targetId: string }) => g.targetId)).toEqual(['c', 'a']);
      expect((await read('?to=2026-11-01').expect(200)).body.items.map((g: { targetId: string }) => g.targetId)).toEqual(['b']);
      expect((await read('?from=2026-11-03').expect(200)).body.items.map((g: { targetId: string }) => g.targetId)).toEqual(['d']);
      expect((await read('?from=2026-11-02&to=2026-11-01').expect(400)).body.error.code).toBe('VALIDATION_FAILED');
    });

    it('P19.2-T2 AC-6 offers every action and actor in the reach on the first page, whatever the filters', async () => {
      await write(1, { action: 'company.created' });
      await write(2, { action: 'company.updated', actorUserId: OTHER_ID });
      await write(3, { kpmId: KPM_B, action: 'kpm.suspended' });

      const { facets } = (await read('?action=company.created').set('Accept-Language', 'id').expect(200)).body;
      expect(facets).toEqual({
        actions: ['company.created', 'company.updated'],
        // P19.4-T3 AC-11: each in the reader's words.
        actionLabels: [
          { action: 'company.created', label: 'Perusahaan dibuat' },
          { action: 'company.updated', label: 'Perusahaan diubah' },
        ],
        actors: [{ userId: OTHER_ID, name: 'Operator Dua' }, { userId: ROOT_ID, name: 'Superadmin' }],
      });
    });

    it.each([
      ['an operator in the scope', '?kpmId[$ne]=x'],
      ['an operator in the actor', '?actorUserId[$gt]='],
      ['a scope that is not an id', '?kpmId=0417'],
      ['an action that is not an action’s name', '?action=everything'],
      ['a day that is not a day', '?from=2-11-2026'],
      ['a parameter nobody reads', '?limit=500'],
    ])('P19.2-T2 AC-6 refuses %s, 400 VALIDATION_FAILED', async (_label, query) => {
      const res = await read(query).expect(400);
      expect(res.body.error.code).toBe('VALIDATION_FAILED');
    });
  });

  /**
   * **P19.4-T3 AC-11 (SA UI-016; SA case 9): names instead of ids, actions in words, the KPM filter.** Over a real
   * database: what the platform's rows name, read once per collection, a deleted product still named, and every line's
   * action in the reader's language.
   */
  describe('P19.4-T3 AC-11 names and words', () => {
    const TPL = '66f0000000000000000000f1';
    const SECTION = '66f0000000000000000000f2';
    const PRODUCT = '66f0000000000000000000f3';
    const RUNG = '66f0000000000000000000f4';
    const oid = (id: string) => new mongoose.Types.ObjectId(id);

    beforeEach(async () => {
      const db = mongoose.connection.db!;
      await db.collection('templates').insertOne({ _id: oid(TPL), companyId: PRU, name: 'Prudential template' });
      await db.collection('companyTemplates').insertOne({ _id: oid(SECTION), companyId: PRU, templateId: TPL, kind: 'activity_taxonomy' });
      await db.collection('products').insertOne({
        _id: oid(PRODUCT), companyId: PRU, code: 'PRUPROSPER', name: 'PRUProsper', deletedAt: new Date('2026-11-01T00:00:00Z'),
      });
      await db.collection('companyOrgLevels').insertOne({ _id: oid(RUNG), companyId: MANU, code: 'SBP', label: 'Senior Business Partner' });
    });

    it('P19.4-T3 AC-11 shows the target’s name, never an id: a section, a product deleted since, a rung, a KPM', async () => {
      await write(1, { action: 'company_template.draft_saved', targetCollection: 'companyTemplates', targetId: SECTION,
        after: { companyId: PRU, templateId: TPL, kind: 'ratio_set' } });
      await write(2, { action: 'product.updated', targetCollection: 'products', targetId: PRODUCT });
      await write(3, { action: 'org_level.updated', targetCollection: 'companyOrgLevels', targetId: RUNG });
      await write(4, { action: 'kpm.suspended', targetCollection: 'kpms', targetId: FIXTURE_KPM });

      const { body } = await read().set('Accept-Language', 'id').expect(200);

      expect(body.items.map((g: { actionLabel: string; targetKind: string; targetLabel: string }) =>
        [g.actionLabel, g.targetKind, g.targetLabel])).toEqual([
        ['Draf template disimpan', 'Bagian template', 'Prudential template · Aktivitas & rasio'],
        ['Produk diubah', 'Produk', 'PRUProsper'],
        ['Peran diubah', 'Peran', 'Senior Business Partner (SBP)'],
        ['KPM ditangguhkan', 'Kantor', 'KPM 0417 · Surabaya'],
      ]);
    });

    it('P19.4-T3 AC-11 writes the same lines for an English reader, and the chip’s actions in words', async () => {
      await write(1, { action: 'company_template.draft_saved', targetCollection: 'companyTemplates', targetId: SECTION, after: null });
      await write(2, { action: 'company.created' });

      const { body } = await read().set('Accept-Language', 'en').expect(200);

      expect(body.items[0]).toMatchObject({
        action: 'company_template.draft_saved', actionLabel: 'Template draft saved',
        targetLabel: 'Prudential template · Activities & ratios',
      });
      expect(body.facets.actionLabels).toEqual([
        { action: 'company.created', label: 'Company created' },
        { action: 'company_template.draft_saved', label: 'Template draft saved' },
      ]);
    });

    it('P19.4-T3 AC-11 SA case 9: an editing session’s autosaves read as one line, “Draf template disimpan ×28”', async () => {
      for (let i = 0; i < 28; i += 1) {
        await write(i * 0.3, { action: 'company_template.draft_saved', targetCollection: 'companyTemplates',
          targetId: SECTION, after: { templateId: TPL, kind: 'activity_taxonomy' } });
      }

      const { body } = await read().set('Accept-Language', 'id').expect(200);

      expect(body.items).toHaveLength(1);
      expect(`${body.items[0].actionLabel} ×${body.items[0].count}`).toBe('Draf template disimpan ×28');
      expect(body.items[0].targetLabel).toBe('Prudential template · Aktivitas & rasio');
    });

    it('P19.4-T3 AC-11 SA case 9: filters by KPM, and writes a platform read’s line with the KPM it read', async () => {
      await write(1, { kpmId: FIXTURE_KPM, action: 'platform_read.kpm_analytics', targetCollection: 'kpms', targetId: FIXTURE_KPM });
      await write(2, { kpmId: KPM_B, action: 'platform_read.kpm_analytics', targetCollection: 'kpms', targetId: KPM_B });

      const { body } = await read(`?kpmId=${FIXTURE_KPM}`).set('Accept-Language', 'id').expect(200);

      expect(body.items.map((g: { actionLabel: string; targetLabel: string }) => [g.actionLabel, g.targetLabel]))
        .toEqual([['Analytics KPM 0417 dilihat', 'KPM 0417 · Surabaya']]);
    });

    it('P19.4-T3 AC-11 keeps the log append-only: the read writes nothing, and the rows keep the words they were written with', async () => {
      const id = await write(1, { action: 'platform_template.draft_saved', targetCollection: 'platformTemplates', targetId: SECTION });
      const before = await mongoose.connection.db!.collection('auditLog').find({}).toArray();

      const { body } = await read().set('Accept-Language', 'id').expect(200);

      expect(body.items[0]).toMatchObject({ _id: id, action: 'platform_template.draft_saved', actionLabel: 'Draf template disimpan' });
      expect(await mongoose.connection.db!.collection('auditLog').find({}).toArray()).toEqual(before);
    });
  });

  describe('the reach (positive and negative per role)', () => {
    it.each([['the Owner', OWNER], ['the Admin', ADMIN]])(
      'P19.2-T2 AC-6 %s reads their own office’s log, pinned to it whatever scope they pass',
      async (_label, ctx) => {
        await write(1, { kpmId: FIXTURE_KPM, action: 'member.role_changed' });
        await write(2, { kpmId: KPM_B, action: 'kpm.suspended' });
        await write(3, { action: 'company.created' });
        session.current = ctx;

        expect(shape((await read().expect(200)).body)).toEqual(['member.role_changed×1']);
        // Another office's id, and the other company's: still their own office, and nothing of anybody else's.
        expect(shape((await read(`?kpmId=${KPM_B}`).expect(200)).body)).toEqual(['member.role_changed×1']);
        expect((await read(`?companyId=${MANU}`).expect(200)).body.items).toEqual([]);
        expect((await read().expect(200)).body.facets.actions).toEqual(['member.role_changed']);
      },
    );

    it('P19.2-T2 AC-6 a Super Admin reads any scope', async () => {
      await write(1, { kpmId: FIXTURE_KPM, action: 'member.role_changed' });
      await write(2, { kpmId: KPM_B, action: 'kpm.suspended' });

      expect(shape((await read(`?kpmId=${FIXTURE_KPM}`).expect(200)).body)).toEqual(['member.role_changed×1']);
      expect(shape((await read(`?kpmId=${KPM_B}`).expect(200)).body)).toEqual(['kpm.suspended×1']);
    });

    it.each([['an AB', AB], ['an AAB', AAB], ['an agent', AGENT]])(
      'P19.2-T2 AC-6 refuses %s, 403 PERM_DENIED',
      async (_label, ctx) => {
        await write(1, { kpmId: FIXTURE_KPM });
        session.current = ctx;

        expect((await read().expect(403)).body.error.code).toBe('PERM_DENIED');
      },
    );

    it('P19.2-T2 AC-6 drops ADR-0073’s rows about the reader before grouping, so neither a count nor a gap shows them', async () => {
      // The Owner is also somebody's coachee: a membership of theirs a note is about.
      const { insertedId: own } = await mongoose.connection.db!.collection('memberships').insertOne({
        kpmId: FIXTURE_KPM, userId: OWNER.userId, agentCode: '9001', role: 'ab', status: 'active', deletedAt: null,
      });
      const same = { kpmId: FIXTURE_KPM, action: 'member.role_changed', targetCollection: 'memberships', targetId: 'm-9' };
      await write(0, same);
      await write(1, {
        kpmId: FIXTURE_KPM, action: 'leader_note.read', targetCollection: 'leaderNotes', targetId: 'n-1',
        after: { coacheeMembershipId: String(own) },
      });
      await write(2, same);

      session.current = OWNER;
      expect(shape((await read().expect(200)).body)).toEqual(['member.role_changed×2']);
      session.current = SUPER_ADMIN;
      expect(shape((await read(`?kpmId=${FIXTURE_KPM}`).expect(200)).body))
        .toEqual(['member.role_changed×1', 'leader_note.read×1', 'member.role_changed×1']);
    });
  });
});
