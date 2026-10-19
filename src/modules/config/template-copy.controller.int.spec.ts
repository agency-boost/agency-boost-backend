import { INestApplication } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { Test } from '@nestjs/testing';
import mongoose from 'mongoose';
import request from 'supertest';
import { PermissionsGuard } from '@/common/auth/permissions.guard';
import { RequestContext } from '@/common/context/request-context';
import { DomainExceptionFilter } from '@/common/errors/error.filter';
import {
  AAB, AB, ADMIN, AGENT, FIXTURE_KPM, OWNER, SUPER_ADMIN, declaredPermissions, productionPipe, session, StubAuth,
} from '../../../test/http-permissions';
import { clearCollections, startMongo, stopMongo } from '../../../test/mongo';
import { configModule, provisionOffice } from '../../../test/config-module';
import { listenOnLoopback } from '../../../test/listen';
import { NamedTemplateController } from './named-template.controller';
import { NamedTemplateService } from './named-template.service';
import { OfficeTemplateController } from './office-template.controller';
import { TemplateCopyService } from './template-copy.service';

const NOW = new Date('2026-10-07T03:00:00Z');
const PRUDENTIAL = '66f0000000000000000000c1';
const ALLIANZ = '66f0000000000000000000c2';

/** A support session as `who`: elevated unless `readOnly` (§3.13). */
const supporting = (who: RequestContext, readOnly: boolean) =>
  new RequestContext(who.userId, 'none', who.membership, 'u-support', null, false, readOnly);

/**
 * **The three copies over HTTP** (P13.2-T7 AC-1 to AC-6) — *New template*'s *Copy of*, *Save as template*
 * and *Import from another company* — behind the real `PermissionsGuard` and the production pipe: the
 * Super Admin served, every tenant role and both kinds of support session refused, the body checked.
 */
describe('template copies over HTTP (P13.2-T7)', () => {
  let app: INestApplication;
  let wired: ReturnType<typeof configModule>;
  let prudentialDefault: string;
  let allianzDefault: string;
  const http = () => request(app.getHttpServer());
  const templates = (companyId: string) => `/admin/companies/${companyId}/templates`;
  const saveAs = `/admin/tenants/${FIXTURE_KPM}/template`;
  const count = () => (wired.namedTemplateRows as unknown as mongoose.Model<unknown>).countDocuments({ deletedAt: null });

  beforeAll(async () => {
    await startMongo();
    wired = configModule(NOW);
    const moduleRef = await Test.createTestingModule({
      controllers: [NamedTemplateController, OfficeTemplateController],
      providers: [
        { provide: NamedTemplateService, useValue: wired.namedTemplates },
        { provide: TemplateCopyService, useValue: wired.templateCopies },
      ],
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
    wired.storage.resetCopies();
    session.current = SUPER_ADMIN;
    const companies = wired.companies as unknown as mongoose.Model<never>;
    for (const [_id, name] of [[PRUDENTIAL, 'Prudential'], [ALLIANZ, 'Allianz Life']]) {
      const company = await companies.create({ _id, name, slug: name.toLowerCase().replace(/\s/g, '-') } as never);
      await wired.orgLevels.seedDefaultLadder(_id);
      await wired.namedTemplates.createFirst(SUPER_ADMIN, company as never);
    }
    prudentialDefault = String((await wired.namedTemplates.resolve(PRUDENTIAL))._id);
    allianzDefault = String((await wired.namedTemplates.resolve(ALLIANZ))._id);
    await (wired.kpms as unknown as mongoose.Model<never>).create({
      _id: FIXTURE_KPM, companyId: PRUDENTIAL, code: '0417', branchName: 'BSD City Branch',
      timezone: 'Asia/Jakarta', status: 'active',
    } as never);
    await provisionOffice(wired, FIXTURE_KPM);
    await wired.config.publish(OWNER);
  });

  it('declares company_template:write on Save as template, and nothing else', () => {
    expect(declaredPermissions(OfficeTemplateController)).toEqual({ save: 'company_template:write' });
  });

  describe('AC-6: refused 403 to every tenant role and a support session, writing nothing', () => {
    const refused: [string, RequestContext][] = [
      ['the Owner', OWNER], ['the Admin', ADMIN], ['an AB', AB], ['an AAB', AAB], ['an Agent', AGENT],
      ['a read-only support session', supporting(OWNER, true)],
      ['an elevated support session', supporting(OWNER, false)],
    ];

    it.each(refused)('%s', async (_who, ctx) => {
      session.current = ctx;
      const before = await count();
      for (const call of [
        http().post(templates(PRUDENTIAL)).send({ name: 'Copy', from: { templateId: prudentialDefault } }),
        http().post(`${templates(PRUDENTIAL)}/import`).send({ fromCompanyId: ALLIANZ, templateId: allianzDefault, name: 'In' }),
        http().post(saveAs).send({ name: 'Mine', companyId: PRUDENTIAL }),
      ]) {
        const res = await call;
        expect([res.status, res.body.error?.code]).toEqual([403, 'PERM_DENIED']);
      }
      expect(await count()).toBe(before);
      expect(wired.storage.copies).toEqual([]);
    });
  });

  describe('as the Super Admin', () => {
    it('AC-1: New template copies one of the company’s templates — 201, origin copy', async () => {
      const res = await http().post(templates(PRUDENTIAL))
        .send({ name: 'Jakarta branches', from: { templateId: prudentialDefault } }).expect(201);
      expect(res.body).toMatchObject({
        name: 'Jakarta branches', isDefault: false, origin: { kind: 'copy', templateId: prudentialDefault },
      });
      expect(Object.values(res.body.publishedVersions)).toEqual(Array(7).fill(1));
      // Another company's template is not this company's to copy.
      await http().post(templates(PRUDENTIAL)).send({ name: 'Theirs', from: { templateId: allianzDefault } }).expect(404);
    });

    it('validates `from`: one of the two words, or exactly { templateId } naming an id', async () => {
      for (const from of [
        { templateId: 'not-an-id' }, { templateId: prudentialDefault, extra: true }, {}, ['empty'], 'copy', null,
      ]) {
        const res = await http().post(templates(PRUDENTIAL)).send({ name: 'x', from });
        expect([String(from), res.status, res.body.error?.code]).toEqual([String(from), 400, 'VALIDATION_FAILED']);
      }
    });

    it('AC-2: Save as template — 201 into its own company, and into another', async () => {
      const own = await http().post(saveAs).send({ name: 'BSD City settings', companyId: PRUDENTIAL }).expect(201);
      expect(own.body).toMatchObject({
        companyId: PRUDENTIAL, name: 'BSD City settings', origin: { kind: 'office', kpmId: FIXTURE_KPM },
        // What the office held that the template left out (exit review, finding 2): nothing, here.
        dropped: [],
      });
      const theirs = await http().post(saveAs).send({ name: 'BSD City settings', companyId: ALLIANZ }).expect(201);
      expect(theirs.body).toMatchObject({ companyId: ALLIANZ, origin: { kind: 'office', companyId: PRUDENTIAL } });

      // The name is taken now, in Prudential.
      const taken = await http().post(saveAs).send({ name: 'bsd city settings', companyId: PRUDENTIAL }).expect(409);
      expect(taken.body.error).toMatchObject({ code: 'TEMPLATE_NAME_TAKEN', details: { name: 'bsd city settings' } });
    });

    it('validates Save as template’s body, and answers 404 for an office that is not there', async () => {
      await http().post(saveAs).send({ name: 'x' }).expect(400);
      await http().post(saveAs).send({ name: '', companyId: PRUDENTIAL }).expect(400);
      await http().post(saveAs).send({ name: 'x', companyId: 'nope' }).expect(400);
      await http().post(saveAs).send({ name: 'x', companyId: PRUDENTIAL, extra: 1 }).expect(400);
      await http().post('/admin/tenants/66f00000000000000000ffff/template').send({ name: 'x', companyId: PRUDENTIAL }).expect(404);
    });

    it('AC-4: Import from another company — 201, and a rung this ladder lacks refused 409 with its codes', async () => {
      const res = await http().post(`${templates(PRUDENTIAL)}/import`)
        .send({ fromCompanyId: ALLIANZ, templateId: allianzDefault, name: 'From Allianz' }).expect(201);
      expect(res.body).toMatchObject({
        companyId: PRUDENTIAL, origin: { kind: 'import', templateId: allianzDefault, companyId: ALLIANZ },
      });

      await mongoose.connection.db!.collection('companyOrgLevels')
        .updateOne({ companyId: PRUDENTIAL, code: 'AAB' }, { $set: { status: 'archived' } });
      const refused = await http().post(`${templates(PRUDENTIAL)}/import`)
        .send({ fromCompanyId: ALLIANZ, templateId: allianzDefault, name: 'Again' }).expect(409);
      expect(refused.body.error).toMatchObject({ code: 'TEMPLATE_RUNG_UNKNOWN', details: { codes: ['AAB'] } });
      // Said in words a Super Admin can act on.
      expect(refused.body.error.message).toContain('AAB');
      expect(refused.body.error.message).toContain('ladder');
    });

    it('validates Import’s body, refuses this company as its own source, and 404s a foreign template', async () => {
      const at = `${templates(PRUDENTIAL)}/import`;
      await http().post(at).send({ fromCompanyId: ALLIANZ, name: 'x' }).expect(400);
      await http().post(at).send({ fromCompanyId: 'x', templateId: allianzDefault, name: 'x' }).expect(400);
      await http().post(at).send({ fromCompanyId: PRUDENTIAL, templateId: prudentialDefault, name: 'x' }).expect(400);
      await http().post(at).send({ fromCompanyId: ALLIANZ, templateId: prudentialDefault, name: 'x' }).expect(404);
    });
  });
});
