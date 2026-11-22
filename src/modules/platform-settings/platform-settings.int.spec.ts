import { INestApplication } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { Test } from '@nestjs/testing';
import mongoose from 'mongoose';
import request from 'supertest';
import { PermissionsGuard } from '@/common/auth/permissions.guard';
import { RequestContext } from '@/common/context/request-context';
import { DomainExceptionFilter } from '@/common/errors/error.filter';
import { AuditLog, AuditLogSchema } from '@/modules/audit/audit-log.schema';
import { AuditService } from '@/modules/audit/audit.service';
import {
  AAB, AB, ADMIN, AGENT, declaredPermissions, OWNER, productionPipe, session, StubAuth, SUPER_ADMIN,
} from '../../../test/http-permissions';
import { listenOnLoopback } from '../../../test/listen';
import { clearCollections, startMongo, stopMongo } from '../../../test/mongo';
import { PlatformSettingsController } from './platform-settings.controller';
import { PlatformSettings, PlatformSettingsSchema } from './platform-settings.schema';
import { PlatformSettingsService } from './platform-settings.service';

/** A key of the right shape. Never real: what the test proves is that no answer carries it. */
const KEY = 'sk-ant-test-0123456789abcdefghijKLMNOP';
const SUPPORT_SESSION = new RequestContext('u-owner', 'none', OWNER.membership, 'root', null, false, true);

/**
 * ***Pengaturan platform* over HTTP** (P19.23-T6 AC-3; ADR-0279): the WhatsApp number saved and read, normalised and
 * audited; the AI reading key's **state** from the environment, never its value; the default look shown.
 */
describe('Pengaturan platform (P19.23-T6 AC-3)', () => {
  let app: INestApplication;
  let audit: mongoose.Model<AuditLog>;
  let service: PlatformSettingsService;
  const env: { key: string | undefined } = { key: undefined };

  beforeAll(async () => {
    await startMongo();
    audit = mongoose.model(AuditLog.name, AuditLogSchema) as never;
    const settings = mongoose.model(PlatformSettings.name, PlatformSettingsSchema);
    const config = { get: (name: string) => (name === 'ANTHROPIC_API_KEY' ? env.key : undefined) };
    service = new PlatformSettingsService(settings as never, config as never, new AuditService(audit as never));
    const moduleRef = await Test.createTestingModule({
      controllers: [PlatformSettingsController],
      providers: [{ provide: PlatformSettingsService, useValue: service }],
    }).compile();
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
    env.key = undefined;
  });

  const api = () => request(app.getHttpServer());

  it('P19.23-T6 AC-3 each route names the permission it is guarded by', () => {
    expect(declaredPermissions(PlatformSettingsController)).toEqual({
      read: 'platform_settings:read', update: 'platform_settings:update',
    });
  });

  it('P19.23-T6 AC-3 reads nothing saved yet: no number, the key not set, AgencyBoost’s own look', async () => {
    expect((await api().get('/api/admin/platform/settings').expect(200)).body).toEqual({
      whatsappNumber: null,
      aiReadingKey: 'not_set',
      defaultLook: { systemName: 'AgencyBoost', editable: false },
      updatedAt: null,
    });
  });

  it('P19.23-T6 AC-3 says the AI key is set when the environment has one — and never answers, stores or audits it', async () => {
    env.key = KEY;
    const read = await api().get('/api/admin/platform/settings').expect(200);
    expect(read.body.aiReadingKey).toBe('set');
    const saved = await api().put('/api/admin/platform/settings').send({ whatsappNumber: '0811 2000 300' }).expect(200);
    for (const text of [read.text, saved.text]) expect(text).not.toContain('sk-ant');
    const stored = JSON.stringify(await mongoose.connection.db!.collection('platformSettings').find().toArray());
    const logged = JSON.stringify(await audit.find().lean());
    expect(stored).not.toContain('sk-ant');
    expect(logged).not.toContain('sk-ant');
  });

  it('P19.23-T6 AC-3 saves the WhatsApp number as +62 and its digits, audited before → after; the same again records nothing', async () => {
    const { body } = await api().put('/api/admin/platform/settings').send({ whatsappNumber: '0811-2000-300' }).expect(200);
    expect(body).toMatchObject({ whatsappNumber: '+628112000300', updatedAt: expect.any(String) });
    expect(await service.whatsappNumber()).toBe('+628112000300');
    await api().put('/api/admin/platform/settings').send({ whatsappNumber: '+62 811 2000 300' }).expect(200);
    const entries = await audit.find({ action: 'platform_settings.updated' }).lean();
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      kpmId: null, actorUserId: 'root', targetCollection: 'platformSettings',
      before: { whatsappNumber: null }, after: { whatsappNumber: '+628112000300' },
    });
  });

  it('P19.23-T6 AC-3 an empty number clears it', async () => {
    await api().put('/api/admin/platform/settings').send({ whatsappNumber: '08112000300' }).expect(200);
    expect((await api().put('/api/admin/platform/settings').send({ whatsappNumber: '  ' }).expect(200)).body.whatsappNumber).toBeNull();
    expect(await service.whatsappNumber()).toBeNull();
  });

  it.each([['letters', 'nomor saya'], ['too few digits', '0811']])(
    'P19.23-T6 AC-3 refuses a number that is %s, 400 naming whatsappNumber, and saves nothing',
    async (_label, whatsappNumber) => {
      const { body } = await api().put('/api/admin/platform/settings').send({ whatsappNumber }).expect(400);
      expect(body.error).toMatchObject({ code: 'VALIDATION_FAILED', details: { field: 'whatsappNumber' } });
      expect(await service.whatsappNumber()).toBeNull();
    },
  );

  it('P19.23-T6 AC-3 refuses a number sent as anything but text, 400, in the field’s own words', async () => {
    const { body } = await api().put('/api/admin/platform/settings').send({ whatsappNumber: 8112000300 }).expect(400);
    expect(body.error.code).toBe('VALIDATION_FAILED');
    expect(JSON.stringify(body.error.details)).toContain('Indonesian WhatsApp number');
    expect(await service.whatsappNumber()).toBeNull();
  });

  it.each([['the Owner', OWNER], ['an Admin', ADMIN], ['an AB', AB], ['an AAB', AAB], ['an agent', AGENT], ['a support session', SUPPORT_SESSION]])(
    'P19.23-T6 AC-3 refuses %s both routes, 403 PERM_DENIED',
    async (_label, ctx) => {
      session.current = ctx;
      expect((await api().get('/api/admin/platform/settings').expect(403)).body.error.code).toBe('PERM_DENIED');
      expect((await api().put('/api/admin/platform/settings').send({ whatsappNumber: '08112000300' }).expect(403)).body.error.code)
        .toBe('PERM_DENIED');
    },
  );

  it('P19.23-T6 AC-3 the service refuses a tenant role too, before anything is read', async () => {
    await expect(service.read(OWNER)).rejects.toMatchObject({ code: 'PERM_DENIED' });
    await expect(service.update(OWNER, { whatsappNumber: '08112000300' })).rejects.toMatchObject({ code: 'PERM_DENIED' });
  });
});
