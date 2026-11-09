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

const NOW = new Date('2026-10-26T03:00:00Z');

/**
 * **A rung's leader tier over HTTP** (P18.5-T1 AC-1, AC-2; ADR-0156 §1, §5): the create and update routes take
 * `leaderTier`; a change while any live membership stands on the rung — in any office of the company — is refused
 * `409 ORG_LEVEL_TIER_IN_USE` with the count and nothing written; nobody but the Super Admin reaches either.
 *
 * `OrgLevelService` is real over a real database, its membership count through the named unscoped method; the
 * controller's other collaborators are inert, since no route here reaches them.
 */
describe('POST and PATCH /admin/org-levels — the leader tier (P18.5-T1)', () => {
  let app: INestApplication;
  let companies: mongoose.Model<Company>;
  let levels: mongoose.Model<CompanyOrgLevel>;
  let memberships: mongoose.Model<Membership>;
  let audit: mongoose.Model<AuditLog>;
  let companyId: string;
  let seq = 0;

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
    companyId = String((await companies.create({ name: 'Allianz Life', slug: 'allianz-life' }))._id);
  });

  const api = () => request(app.getHttpServer());
  const add = (body: Record<string, unknown>) =>
    api().post('/api/admin/org-levels').send({ companyId, label: String(body.code), displayOrder: 1, ...body });
  const patch = (id: string, body: Record<string, unknown>) => api().patch(`/api/admin/org-levels/${id}`).send(body);
  const rungOf = (ladder: { code: string; orgLevelId: string }[], code: string) => ladder.find((l) => l.code === code)!;

  /** A membership on a rung, in an office, written straight to the model: the refusal reads a count. */
  async function stand(orgLevelId: string, code: string, kpmId: string, status = 'active') {
    seq += 1;
    return memberships.create({
      kpmId, userId: `user-${seq}`, agentCode: `${1000 + seq}`, agentSeq: seq, leaderCode: `LC${seq}`,
      orgLevelId, orgLevelCode: code, role: 'agent', status,
    });
  }

  it('AC-2 creates a rung with its tier, and a rung with none as Not a leader', async () => {
    await add({ code: 'AGENT', displayOrder: 1 }).expect(201);
    await add({ code: 'UM', label: 'Unit Manager', displayOrder: 2, leaderTier: 'associate' }).expect(201);
    const res = await add({ code: 'SM', label: 'Senior Manager', displayOrder: 3, leaderTier: 'senior' }).expect(201);
    expect(res.body.map((l: { code: string; leaderTier: unknown }) => [l.code, l.leaderTier])).toEqual([
      ['AGENT', null], ['UM', 'associate'], ['SM', 'senior'],
    ]);
    // Stored explicitly, `null` included, so the default ladder's reading of an absent tier never applies to it.
    const stored = await levels.findOne({ companyId, code: 'AGENT' }).lean().exec();
    expect(stored).toHaveProperty('leaderTier', null);
    const created = await audit.findOne({ action: 'org_level.created', 'after.code': 'SM' }).lean().exec();
    expect(created?.after).toMatchObject({ leaderTier: 'senior' });
  });

  it.each([['a tier that is not one', 'manager'], ['a number', 1], ['the class instead of the tier', 'ab']])(
    'AC-2 refuses %s on either route, 400',
    async (_label, leaderTier) => {
      const bad = await add({ code: 'SM', leaderTier }).expect(400);
      expect(bad.body.error.code).toBe('VALIDATION_FAILED');
      const [rung] = (await add({ code: 'UM' }).expect(201)).body;
      expect((await patch(rung.orgLevelId, { leaderTier }).expect(400)).body.error.code).toBe('VALIDATION_FAILED');
    },
  );

  it('AC-2 sets, changes and clears the tier of a rung nobody holds, and audits before and after', async () => {
    const [rung] = (await add({ code: 'SM' }).expect(201)).body;
    let res = await patch(rung.orgLevelId, { leaderTier: 'senior' }).expect(200);
    expect(rungOf(res.body, 'SM')).toMatchObject({ leaderTier: 'senior' });
    res = await patch(rung.orgLevelId, { leaderTier: 'associate' }).expect(200);
    expect(rungOf(res.body, 'SM')).toMatchObject({ leaderTier: 'associate' });
    res = await patch(rung.orgLevelId, { leaderTier: null }).expect(200);
    expect(rungOf(res.body, 'SM')).toMatchObject({ leaderTier: null });
    // Absent leaves it as it is.
    res = await patch(rung.orgLevelId, { label: 'Senior Manager' }).expect(200);
    expect(rungOf(res.body, 'SM')).toMatchObject({ label: 'Senior Manager', leaderTier: null });

    const rows = await audit.find({ action: 'org_level.updated', targetId: rung.orgLevelId }).sort({ _id: 1 }).lean().exec();
    expect(rows.map((r) => [r.before?.leaderTier, r.after?.leaderTier])).toEqual([
      [null, 'senior'], ['senior', 'associate'], ['associate', null], [null, null],
    ]);
  });

  it('AC-2 refuses a change while live members stand on the rung, in any office, with the count and nothing written', async () => {
    const [rung] = (await add({ code: 'SM', label: 'Senior Manager' }).expect(201)).body;
    // Two offices of the company: the rung is the company's, and so are its members.
    await stand(rung.orgLevelId, 'SM', '66f0000000000000000000a1');
    await stand(rung.orgLevelId, 'SM', '66f0000000000000000000b1', 'pending');
    // A removed member holds no rights to re-class, and is not counted.
    await stand(rung.orgLevelId, 'SM', '66f0000000000000000000a1', 'removed');

    const refused = await patch(rung.orgLevelId, { leaderTier: 'senior', label: 'Renamed' }).expect(409);
    expect(refused.body.error).toMatchObject({
      code: 'ORG_LEVEL_TIER_IN_USE',
      details: { orgLevelId: rung.orgLevelId, code: 'SM', members: 2 },
    });
    expect(refused.body.error.message).toContain('2 people stand on Senior Manager');
    // The whole request is refused: neither the tier nor the label moved, and nothing was audited.
    expect(await levels.findById(rung.orgLevelId).lean().exec()).toMatchObject({ leaderTier: null, label: 'Senior Manager' });
    expect(await audit.countDocuments({ action: 'org_level.updated' })).toBe(0);

    // The tier it already has is no change, and a rename alone is never refused.
    await patch(rung.orgLevelId, { leaderTier: null, label: 'Renamed' }).expect(200);
  });

  it('AC-2 counts one member in the singular', async () => {
    const [rung] = (await add({ code: 'UM', label: 'Unit Manager' }).expect(201)).body;
    await stand(rung.orgLevelId, 'UM', '66f0000000000000000000a1');
    const refused = await patch(rung.orgLevelId, { leaderTier: 'associate' }).expect(409);
    expect(refused.body.error.details.members).toBe(1);
    expect(refused.body.error.message).toContain('1 person stands on Unit Manager');
  });

  it('P18.10-T5 AC-7 refuses the change in Indonesian for an Indonesian reader, the count and the label as they are', async () => {
    const [rung] = (await add({ code: 'SM', label: 'Senior Manager' }).expect(201)).body;
    await stand(rung.orgLevelId, 'SM', '66f0000000000000000000a1');
    await stand(rung.orgLevelId, 'SM', '66f0000000000000000000b1');

    const refused = await patch(rung.orgLevelId, { leaderTier: 'senior' }).set(...IN_INDONESIAN).expect(409);
    expect(refused.body.error).toMatchObject({
      code: 'ORG_LEVEL_TIER_IN_USE',
      details: { orgLevelId: rung.orgLevelId, code: 'SM', members: 2 },
      message: '2 orang berada di Senior Manager. Tingkat leader-nya menentukan apa yang boleh mereka lakukan, jadi '
        + 'tidak dapat diubah selama masih ada yang menempatinya. Pindahkan mereka ke jenjang lain terlebih dahulu, '
        + 'atau tambahkan jenjang baru.',
    });
  });

  it('AC-1 reads a rung written before the field as the migration writes it', async () => {
    await levels.collection.insertMany([
      { companyId, code: 'AB', label: 'AB', displayOrder: 3, status: 'active', archivedAt: null, deletedAt: null },
      { companyId, code: 'AAB', label: 'AAB', displayOrder: 2, status: 'active', archivedAt: null, deletedAt: null },
      { companyId, code: 'SM', label: 'SM', displayOrder: 4, status: 'active', archivedAt: null, deletedAt: null },
    ]);
    const res = await api().get(`/api/admin/org-levels?companyId=${companyId}`).expect(200);
    expect(res.body.map((l: { code: string; leaderTier: unknown }) => [l.code, l.leaderTier])).toEqual([
      ['AAB', 'associate'], ['AB', 'senior'], ['SM', null],
    ]);
  });

  /*
   * ADR-0168 §3: the Template library's ladder is edited here, as every company's. It holds no office, so nobody
   * stands on its rungs and a tier change is never refused; the read carries its rungs with everybody else's.
   */
  it('ADR-0168 §3 takes every write on the Template library’s rungs, and reads them with the rest', async () => {
    const library = String((await companies.create({ name: 'Template', slug: 'template', kind: 'template' }))._id);
    const [agent] = (await add({ companyId: library, code: 'AGENT', label: 'Agent', displayOrder: 1 }).expect(201)).body;
    expect(agent).toMatchObject({ companyId: library, code: 'AGENT', leaderTier: null });

    let res = await patch(agent.orgLevelId, { label: 'Agen', displayOrder: 2, leaderTier: 'associate' }).expect(200);
    expect(rungOf(res.body, 'AGENT')).toMatchObject({ label: 'Agen', displayOrder: 2, leaderTier: 'associate' });
    res = await patch(agent.orgLevelId, { status: 'archived' }).expect(200);
    expect(rungOf(res.body, 'AGENT')).toMatchObject({ status: 'archived' });

    await add({ code: 'AGENT' }).expect(201);
    const all = await api().get('/api/admin/org-levels').expect(200);
    expect(all.body.map((l: { companyId: string }) => l.companyId).sort()).toEqual([companyId, library].sort());
    const only = await api().get(`/api/admin/org-levels?companyId=${library}`).expect(200);
    expect(only.body.map((l: { code: string; label: string }) => [l.code, l.label])).toEqual([['AGENT', 'Agen']]);
  });

  // The ladder is the company's (ADR-0012): every member of an office is refused, its Owner and Admins included.
  it.each(EVERY_MEMBER)('AC-2 refuses %s either route, 403', async (_label, who) => {
    const [rung] = (await add({ code: 'SM' }).expect(201)).body;
    session.current = who;
    expect((await add({ code: 'UM', leaderTier: 'associate' }).expect(403)).body.error.code).toBe('PERM_DENIED');
    expect((await patch(rung.orgLevelId, { leaderTier: 'senior' }).expect(403)).body.error.code).toBe('PERM_DENIED');
  });
});
