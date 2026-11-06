import { INestApplication } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { Test } from '@nestjs/testing';
import mongoose from 'mongoose';
import request from 'supertest';
import { PermissionsGuard } from '@/common/auth/permissions.guard';
import { FixedClock } from '@/common/clock/clock.port';
import { DomainExceptionFilter } from '@/common/errors/error.filter';
import { AuditLog, AuditLogSchema } from '@/modules/audit/audit-log.schema';
import { AuditService } from '@/modules/audit/audit.service';
import { MembershipRepository } from '@/modules/org/membership.repository';
import { Membership, MembershipSchema } from '@/modules/org/membership.schema';
import { EVERY_MEMBER, productionPipe, session, StubAuth, SUPER_ADMIN } from '../../../test/http-permissions';
import { listenOnLoopback } from '../../../test/listen';
import { IN_INDONESIAN } from '../../../test/i18n';
import { clearCollections, startMongo, stopMongo } from '../../../test/mongo';
import { AdminController } from './admin.controller';
import { Company, CompanySchema } from './company.schema';
import { CompanyOrgLevel, CompanyOrgLevelSchema } from './company-org-level.schema';
import { Kpm, KpmSchema } from './kpm.schema';
import { OrgLevelService } from './org-level.service';

const NOW = new Date('2026-11-04T03:00:00Z');

/**
 * **A stale save of a rung is refused, not written** (P19-T6 AC-2; the 11-03 handover's B1-10, *saves have no conflict
 * check*): every row of the ladder carries `version`, `0` when made, every write moves it, and `PATCH /admin/org-levels/:id` with an
 * `expectedVersion` the rung has moved past answers `409 VERSION_CONFLICT` with the two versions and nothing written.
 * Absent, the write lands as it always did. Over HTTP, so the DTO's bounds and the guard are the real ones.
 */
describe('PATCH /admin/org-levels/:id — the version a save was read at (P19-T6)', () => {
  let app: INestApplication;
  let companies: mongoose.Model<Company>;
  let levels: mongoose.Model<CompanyOrgLevel>;
  let memberships: mongoose.Model<Membership>;
  let audit: mongoose.Model<AuditLog>;
  let companyId: string;

  beforeAll(async () => {
    await startMongo();
    companies = mongoose.model(Company.name, CompanySchema) as never;
    levels = mongoose.model(CompanyOrgLevel.name, CompanyOrgLevelSchema) as never;
    memberships = mongoose.model(Membership.name, MembershipSchema) as never;
    audit = mongoose.model(AuditLog.name, AuditLogSchema) as never;
    const orgLevels = new OrgLevelService(
      levels as never, companies as never, mongoose.model(Kpm.name, KpmSchema) as never,
      new AuditService(audit as never), new FixedClock(NOW), new MembershipRepository(memberships as never),
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
  });

  afterAll(async () => {
    await app.close();
    await stopMongo();
  });

  beforeEach(async () => {
    await clearCollections();
    session.current = SUPER_ADMIN;
    companyId = String((await companies.create({ name: 'Manulife', slug: 'manulife' }))._id);
  });

  const api = () => request(app.getHttpServer());
  const add = async (code: string) => {
    const res = await api().post('/api/admin/org-levels')
      .send({ companyId, code, label: code, displayOrder: 1 }).expect(201);
    return (res.body as { code: string; orgLevelId: string; version: number }[]).find((l) => l.code === code)!;
  };
  const patch = (id: string, body: Record<string, unknown>) => api().patch(`/api/admin/org-levels/${id}`).send(body);
  const rungIn = (ladder: { orgLevelId: string }[], id: string) =>
    ladder.find((l) => l.orgLevelId === id) as unknown as Record<string, unknown>;

  it('P19-T6 AC-2 gives every rung a version, 0 when it is made', async () => {
    const rung = await add('AAB');
    expect(rung.version).toBe(0);
    const read = await api().get('/api/admin/org-levels').query({ companyId }).expect(200);
    expect(read.body[0]).toMatchObject({ code: 'AAB', version: 0 });
  });

  it('P19-T6 AC-2 lands a save carrying the version read, and moves the version on', async () => {
    const rung = await add('AAB');
    let res = await patch(rung.orgLevelId, { label: 'Associate Agency Builder', expectedVersion: 0 }).expect(200);
    expect(rungIn(res.body, rung.orgLevelId)).toMatchObject({ label: 'Associate Agency Builder', version: 1 });
    res = await patch(rung.orgLevelId, { status: 'archived', expectedVersion: 1 }).expect(200);
    expect(rungIn(res.body, rung.orgLevelId)).toMatchObject({ status: 'archived', version: 2 });
  });

  it('P19-T6 AC-2 refuses a save carrying a version somebody else saved past: 409, both versions, nothing written', async () => {
    const rung = await add('AAB');
    // The other Super Admin's archive lands first …
    await patch(rung.orgLevelId, { status: 'archived', expectedVersion: 0 }).expect(200);
    const audited = await audit.countDocuments({ targetId: rung.orgLevelId }).exec();

    // … and this screen, still at version 0, renames it.
    const res = await patch(rung.orgLevelId, { label: 'Renamed', expectedVersion: 0 }).expect(409);
    expect(res.body.error).toMatchObject({
      code: 'VERSION_CONFLICT',
      message: 'This record changed since you loaded it. Reload and try again.',
      details: { expectedVersion: 0, actualVersion: 1 },
    });
    expect(await levels.findById(rung.orgLevelId).lean().exec()).toMatchObject({ label: 'AAB', status: 'archived', version: 1 });
    expect(await audit.countDocuments({ targetId: rung.orgLevelId }).exec()).toBe(audited);
  });

  it('P19-T6 AC-2 says the refusal in the reader’s language', async () => {
    const rung = await add('AAB');
    await patch(rung.orgLevelId, { label: 'One' }).expect(200);
    const res = await patch(rung.orgLevelId, { label: 'Two', expectedVersion: 0 }).set(...IN_INDONESIAN).expect(409);
    expect(res.body.error.message).toBe('Data ini berubah sejak Anda membukanya. Muat ulang, lalu coba lagi.');
  });

  it('P19-T6 AC-2 checks the version before the tier: a stale view is told it is stale, not who stands on the rung', async () => {
    const rung = await add('SM');
    await memberships.create({
      kpmId: '66f0000000000000000000a1', userId: 'user-1', agentCode: '1001', agentSeq: 1, leaderCode: 'LC1',
      orgLevelId: rung.orgLevelId, orgLevelCode: 'SM', role: 'agent', status: 'active',
    });
    await patch(rung.orgLevelId, { label: 'Senior Manager' }).expect(200);
    const res = await patch(rung.orgLevelId, { leaderTier: 'senior', expectedVersion: 0 }).expect(409);
    expect(res.body.error.code).toBe('VERSION_CONFLICT');
  });

  it('P19-T6 AC-2 lets exactly one of two saves racing on one version land', async () => {
    const rung = await add('AAB');
    const answers = await Promise.all([
      patch(rung.orgLevelId, { label: 'First', expectedVersion: 0 }),
      patch(rung.orgLevelId, { label: 'Second', expectedVersion: 0 }),
    ]);
    expect(answers.map((r) => r.status).sort()).toEqual([200, 409]);
    expect(await levels.findById(rung.orgLevelId).lean().exec()).toMatchObject({ version: 1 });
  });

  it('P19-T6 AC-2 lands a save with no version, as before, and moves the version all the same', async () => {
    const rung = await add('AAB');
    const res = await patch(rung.orgLevelId, { label: 'Unpinned' }).expect(200);
    expect(rungIn(res.body, rung.orgLevelId)).toMatchObject({ label: 'Unpinned', version: 1 });
  });

  it('P19-T6 AC-2 reads a rung written raw, with no version key, as version 0, and saves it at 0', async () => {
    // As migration 0037 writes the Template's ladder: no `version` at all.
    const { insertedId } = await levels.collection.insertOne({
      companyId, code: 'AB', label: 'AB', displayOrder: 3, leaderTier: 'senior', status: 'active', archivedAt: null,
      deletedAt: null,
    });
    const id = String(insertedId);
    const read = await api().get('/api/admin/org-levels').query({ companyId }).expect(200);
    expect(rungIn(read.body, id)).toMatchObject({ version: 0 });
    const res = await patch(id, { label: 'Agency Builder', expectedVersion: 0 }).expect(200);
    expect(rungIn(res.body, id)).toMatchObject({ label: 'Agency Builder', version: 1 });
    expect(await levels.collection.findOne({ _id: insertedId })).toMatchObject({ leaderTier: 'senior', version: 1 });
  });

  it.each([['a negative', -1], ['a fraction', 0.5], ['a string', '0']])(
    'P19-T6 AC-2 refuses %s for the version, 400, nothing written',
    async (_label, expectedVersion) => {
      const rung = await add('AAB');
      const res = await patch(rung.orgLevelId, { label: 'X', expectedVersion }).expect(400);
      expect(res.body.error.code).toBe('VALIDATION_FAILED');
      expect(await levels.findById(rung.orgLevelId).lean().exec()).toMatchObject({ label: 'AAB', version: 0 });
    },
  );

  it('P19-T6 AC-2 answers 404 for a rung that is not there, whatever version is named', async () => {
    await patch('66f00000000000000000ffff', { label: 'X', expectedVersion: 0 }).expect(404);
  });

  it.each(EVERY_MEMBER)('P19-T6 AC-2 still refuses %s, a correct version or not, 403', async (_name, who) => {
    const rung = await add('AAB');
    session.current = who;
    await patch(rung.orgLevelId, { label: 'X', expectedVersion: 0 }).expect(403);
    expect(await levels.findById(rung.orgLevelId).lean().exec()).toMatchObject({ label: 'AAB', version: 0 });
  });
});
