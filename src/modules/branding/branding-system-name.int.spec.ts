import { INestApplication } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { Test } from '@nestjs/testing';
import mongoose from 'mongoose';
import request from 'supertest';
import { PermissionsGuard } from '@/common/auth/permissions.guard';
import { ViewOnlySessionGuard } from '@/common/auth/view-only-session.guard';
import { RequestContext } from '@/common/context/request-context';
import { DomainExceptionFilter } from '@/common/errors/error.filter';
import { RateLimiter } from '@/modules/auth/rate-limiter';
import { BrandingReader } from './branding-reader';
import { BrandingService } from './branding.service';
import { BrandingSettingsController, PublicBrandingController } from './branding.controller';
import { KpmBrandingRepository } from './kpm-branding.repository';
import { KpmBranding, KpmBrandingSchema } from './kpm-branding.schema';
import { BrandingSystemNames } from './system-names';
import { configModule } from '../../../test/config-module';
import {
  AAB, AB, ADMIN, AGENT, FIXTURE_KPM, OWNER, productionPipe, session, StubAuth, SUPER_ADMIN,
} from '../../../test/http-permissions';
import { listenOnLoopback } from '../../../test/listen';
import { clearCollections, startMongo, stopMongo } from '../../../test/mongo';
import type { StubStorage } from '../../../test/stub-storage';

const NOW = new Date('2026-11-20T03:00:00Z');
const COMPANY = '66f0000000000000000000c1';
const OTHER_KPM = '66f0000000000000000000b2';
const SETTINGS = '/kpm/settings/branding';
const NAME = 'Dynamic Smart System';

const member = (over: Record<string, unknown>) => ({
  membershipId: 'mem-a', kpmId: FIXTURE_KPM, orgLevelCode: 'AB', hierarchyRole: 'ab', status: 'active',
  isKpmOwner: false, isKpmAdmin: false, directCount: 0, ...over,
});
const CORE_LEADER = new RequestContext('u-core', 'none', member({ isCoreLeader: true }) as never);
const SUPER_ADMIN_INSIDE = RequestContext.superAdminInKpm(SUPER_ADMIN, FIXTURE_KPM);
const OTHER_OWNER = new RequestContext('u-other', 'none', member({ membershipId: 'mem-other', kpmId: OTHER_KPM, isKpmOwner: true }) as never);
const viewOnly = (who: RequestContext) => new RequestContext(who.userId, 'none', who.membership, 'root', null, false, true);

const WRITERS: [string, RequestContext][] = [
  ['the Owner', OWNER], ['an Admin', ADMIN], ['a core leader', CORE_LEADER], ['the Super Admin inside the KPM', SUPER_ADMIN_INSIDE],
];
const FIELD: [string, RequestContext][] = [['an AB', AB], ['an AAB', AAB], ['an agent', AGENT]];

/**
 * ***Nama sistem* over HTTP** (P19.21-T4 AC-1; ADR-0274): saved and cleared with *Simpan*, checked, kept apart per KPM,
 * written by the KPM's stewards only, and carried by the session, the settings read and the public read a KPM's link
 * makes.
 */
describe('P19.21-T4 AC-1 the system name (Tampilan KPM)', () => {
  let app: INestApplication;
  let wired: ReturnType<typeof configModule>;
  let reader: BrandingReader;
  let rows: KpmBrandingRepository;
  const http = () => request(app.getHttpServer());

  beforeAll(async () => {
    await startMongo();
    wired = configModule(NOW);
    const storage = wired.storage as unknown as StubStorage;
    rows = new KpmBrandingRepository(mongoose.model(KpmBranding.name, KpmBrandingSchema) as never);
    reader = new BrandingReader(rows, wired.kpms as never, wired.templates as never, wired.analyticsConfig, storage);
    const config = { getOrThrow: (key: string) => (key === 'STORAGE_KEY_PREFIX' ? 'dev' : undefined) };
    const service = new BrandingService(
      rows, reader, storage, wired.audit, new RateLimiter(wired.clock), wired.clock, wired.namedTemplateRows as never,
      config as never,
    );
    const moduleRef = await Test.createTestingModule({
      controllers: [BrandingSettingsController, PublicBrandingController],
      providers: [
        { provide: BrandingService, useValue: service },
        { provide: RateLimiter, useValue: new RateLimiter(wired.clock) },
      ],
    }).compile();
    app = moduleRef.createNestApplication();
    app.useGlobalPipes(productionPipe());
    app.useGlobalFilters(new DomainExceptionFilter());
    app.useGlobalGuards(new StubAuth(), new PermissionsGuard(app.get(Reflector)), new ViewOnlySessionGuard(app.get(Reflector)));
    await app.init();
    await listenOnLoopback(app);
  }, 60_000);

  afterAll(async () => {
    await app.close();
    await stopMongo();
  });

  beforeEach(async () => {
    await clearCollections();
    session.current = SUPER_ADMIN;
    const companies = wired.companies as unknown as mongoose.Model<never>;
    const prudential = await companies.create({ _id: COMPANY, name: 'Prudential', slug: 'prudential' } as never);
    const templateId = String((await wired.namedTemplates.createFirst(SUPER_ADMIN, prudential as never))._id);
    const kpms = wired.kpms as unknown as mongoose.Model<never>;
    const startedFrom = { source: 'template', templateId, templateName: 'Default' };
    await kpms.create({ _id: FIXTURE_KPM, companyId: COMPANY, code: '0417', branchName: 'KPM Bintaro', timezone: 'Asia/Jakarta', status: 'active', startedFrom } as never);
    await kpms.create({ _id: OTHER_KPM, companyId: COMPANY, code: '0418', branchName: 'KPM Serpong', timezone: 'Asia/Jakarta', status: 'active', startedFrom } as never);
  });

  const save = (body: Record<string, unknown>) => http().put(SETTINGS).send({ expectedVersion: 0, ...body });

  describe('saving and clearing', () => {
    it('P19.21-T4 AC-1 saves the name trimmed; the settings read, the session and the public read carry it', async () => {
      session.current = OWNER;
      const res = await save({ systemName: `  ${NAME}  ` }).expect(200);
      expect(res.body.shown.systemName).toBe(NAME);
      expect((await http().get(SETTINGS).expect(200)).body.shown.systemName).toBe(NAME);
      expect(await reader.forSession(OWNER)).toMatchObject({ kpmId: FIXTURE_KPM, systemName: NAME });
      for (const who of [AB, AAB, AGENT]) expect((await reader.forSession(who))?.systemName).toBe(NAME);
      expect((await http().get(`/kpm-branding/${FIXTURE_KPM}`).expect(200)).body).toMatchObject({ name: 'KPM Bintaro', systemName: NAME });
    });

    it('P19.21-T4 AC-1 a KPM that never set one reads null — AgencyBoost — everywhere', async () => {
      session.current = OWNER;
      expect((await http().get(SETTINGS).expect(200)).body.shown.systemName).toBeNull();
      expect(await reader.forSession(OWNER)).toMatchObject({ systemName: null });
      expect((await http().get(`/kpm-branding/${FIXTURE_KPM}`).expect(200)).body.systemName).toBeNull();
    });

    it('P19.21-T4 AC-1 null clears it; a Simpan that leaves it out keeps it; the colours save beside it', async () => {
      session.current = OWNER;
      await save({ systemName: NAME }).expect(200);
      const kept = await http().put(SETTINGS).send({ primary: '#0a6e5c', secondary: '#1b2b4b', expectedVersion: 1 }).expect(200);
      expect(kept.body.shown).toMatchObject({ systemName: NAME, palette: expect.objectContaining({ primary: '#0a6e5c' }) });
      const cleared = await http().put(SETTINGS).send({ primary: '#0a6e5c', secondary: '#1b2b4b', systemName: null, expectedVersion: 2 }).expect(200);
      expect(cleared.body.shown.systemName).toBeNull();
      expect(cleared.body.version).toBe(3);
    });

    it('P19.21-T4 AC-1 Kembalikan ke default clears the name with the rest', async () => {
      session.current = OWNER;
      await save({ systemName: NAME }).expect(200);
      const res = await http().post(`${SETTINGS}/reset`).send({ expectedVersion: 1 }).expect(200);
      expect(res.body.shown.systemName).toBeNull();
    });

    it('P19.21-T4 AC-1 audits the name old → new', async () => {
      session.current = OWNER;
      await save({ systemName: NAME }).expect(200);
      await http().put(SETTINGS).send({ systemName: 'DSS', expectedVersion: 1 }).expect(200);
      const entries = (await wired.audit.findForTenant(FIXTURE_KPM)).filter((e) => e.action === 'kpm_branding.updated');
      expect(entries.some((e) => (e.before as { systemName?: unknown } | null)?.systemName === NAME
        && (e.after as { systemName?: unknown }).systemName === 'DSS')).toBe(true);
    });
  });

  describe('validation', () => {
    it.each([
      ['blank', '   ', 'Isi nama sistem'],
      ['over 40 characters', 'x'.repeat(41), '40 karakter'],
      ['a line break', 'Dynamic\nSmart', 'satu baris'],
      ['a tab', 'Dynamic\tSmart', 'satu baris'],
    ])('P19.21-T4 AC-1 refuses a name that is %s: 400 VALIDATION_FAILED on systemName', async (_what, systemName, words) => {
      session.current = OWNER;
      const res = await save({ systemName }).set('Accept-Language', 'id').expect(400);
      expect(res.body.error).toMatchObject({ code: 'VALIDATION_FAILED' });
      expect(JSON.stringify(res.body)).toContain('systemName');
      expect(res.body.error.message).toContain(words);
      expect(await rows.live(OWNER)).toBeNull();
    });

    it('P19.21-T4 AC-1 refuses a name that is not text, and one far too long, before the service', async () => {
      session.current = OWNER;
      await save({ systemName: 42 }).expect(400);
      await save({ systemName: 'x'.repeat(401) }).expect(400);
      expect(await rows.live(OWNER)).toBeNull();
    });
  });

  describe('who may', () => {
    it.each(WRITERS)('P19.21-T4 AC-1 %s sets the name', async (_who, ctx) => {
      session.current = ctx;
      expect((await http().get(SETTINGS).expect(200)).body.canWrite).toBe(true);
      expect((await save({ systemName: NAME }).expect(200)).body.shown.systemName).toBe(NAME);
    });

    it.each(FIELD)('P19.21-T4 AC-1 %s reads it with the session and is refused the write 403', async (_who, ctx) => {
      session.current = OWNER;
      await save({ systemName: NAME }).expect(200);
      session.current = ctx;
      expect((await http().get(SETTINGS).expect(200)).body).toMatchObject({ canWrite: false, shown: { systemName: NAME } });
      await http().put(SETTINGS).send({ systemName: 'Mine', expectedVersion: 1 }).expect(403);
      expect((await rows.live(OWNER))?.systemName).toBe(NAME);
    });

    it('P19.21-T4 AC-1 a read-only view-as session reads it and cannot change it', async () => {
      session.current = viewOnly(OWNER);
      await save({ systemName: NAME }).expect(403);
      expect(await rows.live(OWNER)).toBeNull();
    });

    it('P19.21-T4 AC-1 a Super Admin in no KPM is refused, never writing into one', async () => {
      session.current = SUPER_ADMIN;
      const res = await save({ systemName: NAME });
      expect([403, 404]).toContain(res.status);
      expect(await rows.live(OWNER)).toBeNull();
    });
  });

  describe('one KPM’s name is its own', () => {
    it('P19.21-T4 AC-1 another KPM reads nothing of it and its Simpan reaches no row of this one', async () => {
      session.current = OWNER;
      await save({ systemName: NAME }).expect(200);
      session.current = OTHER_OWNER;
      expect((await http().get(SETTINGS).expect(200)).body.shown.systemName).toBeNull();
      expect(await reader.forSession(OTHER_OWNER)).toMatchObject({ kpmId: OTHER_KPM, systemName: null });
      await save({ systemName: 'Serpong Smart' }).expect(200);
      expect((await rows.live(OWNER))?.systemName).toBe(NAME);
      expect((await http().get(`/kpm-branding/${OTHER_KPM}`).expect(200)).body.systemName).toBe('Serpong Smart');
      expect((await http().get(`/kpm-branding/${FIXTURE_KPM}`).expect(200)).body.systemName).toBe(NAME);
    });

    it('P19.21-T4 AC-1 an email port reads each KPM’s own name', async () => {
      session.current = OWNER;
      await save({ systemName: NAME }).expect(200);
      const names = new BrandingSystemNames(reader, wired.clock);
      expect(await names.nameOf(FIXTURE_KPM)).toBe(NAME);
      expect(await names.nameOf(OTHER_KPM)).toBeNull();
    });
  });
});
