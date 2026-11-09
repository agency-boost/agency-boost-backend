import { INestApplication } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { Test } from '@nestjs/testing';
import mongoose from 'mongoose';
import sharp from 'sharp';
import request from 'supertest';
import { PermissionsGuard } from '@/common/auth/permissions.guard';
import { ViewOnlySessionGuard } from '@/common/auth/view-only-session.guard';
import { RequestContext } from '@/common/context/request-context';
import { DomainExceptionFilter } from '@/common/errors/error.filter';
import { RateLimiter } from '@/modules/auth/rate-limiter';
import { BrandingReader } from './branding-reader';
import { BrandingService } from './branding.service';
import { BrandingSettingsController, PublicBrandingController, TemplateBrandingController } from './branding.controller';
import { KpmBrandingRepository } from './kpm-branding.repository';
import { KpmBranding, KpmBrandingSchema } from './kpm-branding.schema';
import { configModule } from '../../../test/config-module';
import {
  AAB, AB, ADMIN, AGENT, FIXTURE_KPM, OWNER, productionPipe, session, StubAuth, SUPER_ADMIN,
} from '../../../test/http-permissions';
import { listenOnLoopback } from '../../../test/listen';
import { clearCollections, startMongo, stopMongo } from '../../../test/mongo';
import type { StubStorage } from '../../../test/stub-storage';

const NOW = new Date('2026-11-06T03:00:00Z');
const COMPANY = '66f0000000000000000000c1';
const OTHER_KPM = '66f0000000000000000000b2';
const SETTINGS = '/kpm/settings/branding';

/** A Super Admin's read-only view-as session as `who` (ADR-0206 §1): it reads, and every write is refused. */
const viewOnly = (who: RequestContext) => new RequestContext(who.userId, 'none', who.membership, 'root', null, false, true);
const OTHER_OWNER = new RequestContext('u-other', 'none', {
  membershipId: 'mem-other', kpmId: OTHER_KPM, orgLevelCode: 'AB', hierarchyRole: 'ab',
  status: 'active', isKpmOwner: true, isKpmAdmin: false, directCount: 0,
} as never);
const FIELD: [string, RequestContext][] = [['an AB', AB], ['an AAB', AAB], ['an agent', AGENT]];
const WRITERS: [string, RequestContext][] = [['the Owner', OWNER], ['the Admin', ADMIN]];

const png = (width: number, height: number, alpha = 1) => sharp({
  create: { width, height, channels: 4, background: { r: 10, g: 110, b: 92, alpha } },
}).png().toBuffer();
const opaque = (width: number, height: number) => sharp({
  create: { width, height, channels: 3, background: { r: 10, g: 110, b: 92 } },
}).png().toBuffer();

/**
 * ***Tampilan KPM* over HTTP** (P19.6-T1 AC-2 to AC-17; ADR-0218): the settings routes behind the real
 * `PermissionsGuard` and `ViewOnlySessionGuard`, the template's images, and the public sign-in read and files. Storage
 * is the stub (`test/stub-storage.ts`): a test puts the browser's bytes where the signed form names, then confirms.
 */
describe('P19.6-T1 KPM branding (ADR-0218)', () => {
  let app: INestApplication;
  let wired: ReturnType<typeof configModule>;
  let reader: BrandingReader;
  let storage: StubStorage;
  let templateId: string;
  const http = () => request(app.getHttpServer());

  beforeAll(async () => {
    await startMongo();
    wired = configModule(NOW);
    storage = wired.storage as unknown as StubStorage;
    const rows = new KpmBrandingRepository(mongoose.model(KpmBranding.name, KpmBrandingSchema) as never);
    reader = new BrandingReader(rows, wired.kpms as never, wired.templates as never, wired.analyticsConfig, storage);
    // The stub mints `dev/<owner>/<folder>/<n>`: this environment's prefix is `dev`, as the app's default is.
    const config = { getOrThrow: (key: string) => (key === 'STORAGE_KEY_PREFIX' ? 'dev' : undefined) };
    const service = new BrandingService(
      rows, reader, storage, wired.audit, new RateLimiter(wired.clock), wired.clock, wired.namedTemplateRows as never,
      config as never,
    );
    const moduleRef = await Test.createTestingModule({
      controllers: [BrandingSettingsController, TemplateBrandingController, PublicBrandingController],
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
    templateId = String((await wired.namedTemplates.createFirst(SUPER_ADMIN, prudential as never))._id);
    const kpms = wired.kpms as unknown as mongoose.Model<never>;
    const startedFrom = { source: 'template', templateId, templateName: 'Default' };
    await kpms.create({ _id: FIXTURE_KPM, companyId: COMPANY, code: '0417', branchName: 'KPM Bintaro', timezone: 'Asia/Jakarta', startedFrom } as never);
    await kpms.create({ _id: OTHER_KPM, companyId: COMPANY, code: '0418', branchName: 'KPM Serpong', timezone: 'Asia/Jakarta', startedFrom } as never);
  });

  /** One picture through the two steps, as the page does: the form, the bytes, the confirm. */
  function upload(kind: 'logo' | 'logo_square' | 'mascot', body: Buffer, mimeType = 'image/png', base = SETTINGS) {
    return {
      expect: async (status: number) => {
        const signed = await http().post(`${base}/uploads`).send({ kind, filename: 'x', mimeType, bytes: body.length }).expect(201);
        storage.holdBytes(signed.body.storageKey, body, mimeType);
        return http().post(`${base}/uploads/confirm`).send({ kind, storageKey: signed.body.storageKey, mimeType }).expect(status);
      },
    };
  }

  async function brandAsOwner() {
    session.current = OWNER;
    const logo = (await upload('logo', await opaque(600, 120)).expect(200)).body.storageKey as string;
    const mascot = (await upload('mascot', await png(600, 600, 0.6)).expect(200)).body.storageKey as string;
    const saved = await http().put(SETTINGS).send({
      logo: { key: logo }, logoSquare: null, primary: '#0A6E5C', secondary: '#1B2B4B',
      mascot: { default: mascot, poses: {} }, expectedVersion: 0,
    }).expect(200);
    return { logo, mascot, saved: saved.body };
  }

  describe('AC-2 where it is set, and who may', () => {
    it.each(WRITERS)('P19.6-T1 AC-2 %s reads the page and may change it', async (_who, ctx) => {
      session.current = ctx;
      const res = await http().get(SETTINGS).expect(200);
      expect(res.body).toMatchObject({ own: null, template: null, version: 0, canWrite: true });
      expect(res.body.shown).toMatchObject({ kpmId: FIXTURE_KPM, palette: null, logo: null, mascotPoses: [], lesson: null });
    });

    it.each(FIELD)('P19.6-T1 AC-2 %s reads what the KPM shows, and every write is refused 403', async (_who, ctx) => {
      session.current = ctx;
      expect((await http().get(SETTINGS).expect(200)).body.canWrite).toBe(false);
      await http().put(SETTINGS).send({ primary: '#0a6e5c', secondary: '#1b2b4b', expectedVersion: 0 }).expect(403);
      await http().post(`${SETTINGS}/preview`).send({ primary: '#0a6e5c', secondary: '#1b2b4b' }).expect(403);
      await http().post(`${SETTINGS}/reset`).send({ expectedVersion: 0 }).expect(403);
      await http().post(`${SETTINGS}/uploads`).send({ kind: 'logo', filename: 'x', mimeType: 'image/png', bytes: 10 }).expect(403);
    });

    it('P19.6-T1 AC-17 the Super Admin in a view-as sees the branding, cannot change it, and the write answers 403', async () => {
      await brandAsOwner();
      session.current = viewOnly(OWNER);
      const res = await http().get(SETTINGS).expect(200);
      expect(res.body.canWrite).toBe(false);
      expect(res.body.own.primary).toBe('#0a6e5c');
      await http().put(SETTINGS).send({ primary: '#1b2b4b', secondary: '#0a6e5c', expectedVersion: 1 }).expect(403);
      await http().post(`${SETTINGS}/reset`).send({ expectedVersion: 1 }).expect(403);
    });
  });

  describe('AC-3, AC-4, AC-6 the pictures', () => {
    beforeEach(() => { session.current = OWNER; });

    it('P19.6-T1 AC-3 keeps a wide logo as a PNG at three times its drawn size, inside 480 × 96, with every icon', async () => {
      const res = await upload('logo', await opaque(1200, 300)).expect(200);
      expect(res.body).toMatchObject({ width: 384, height: 96 });
      expect(res.body.storageKey).toMatch(new RegExp(`^dev/${FIXTURE_KPM}/branding/[0-9A-Z]{26}$`));
      const names = storage.puts.filter((k) => k.startsWith(res.body.storageKey)).map((k) => k.split('/').pop());
      expect(names).toEqual([
        'logo.png', 'favicon-32.png', 'favicon-48.png', 'apple-touch-icon.png',
        'icon-192.png', 'icon-512.png', 'icon-maskable-192.png', 'icon-maskable-512.png',
      ]);
    });

    it('P19.6-T1 AC-3 renders a safe SVG to PNG, and refuses one with a script: 422 svg_unsafe', async () => {
      const safe = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="200" height="40"><rect width="200" height="40" fill="#0a6e5c"/></svg>');
      const ok = await upload('logo', safe, 'image/svg+xml').expect(200);
      expect(ok.body.height).toBe(96);
      const unsafe = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>');
      const refused = await upload('logo', unsafe, 'image/svg+xml').expect(422);
      expect(refused.body.error).toMatchObject({ code: 'BRANDING_IMAGE_REFUSED', details: { reason: 'svg_unsafe' } });
    });

    it('P19.6-T1 AC-3 refuses a logo under 32 px high (dimensions), over 1 MB (413) or of a type it does not take (415)', async () => {
      expect((await upload('logo', await opaque(200, 20)).expect(422)).body.error.details.reason).toBe('dimensions');
      await http().post(`${SETTINGS}/uploads`).send({ kind: 'logo', filename: 'x', mimeType: 'image/png', bytes: 1_048_577 }).expect(413);
      await http().post(`${SETTINGS}/uploads`).send({ kind: 'logo', filename: 'x', mimeType: 'image/gif', bytes: 10 }).expect(415);
      // A file that claims PNG and is not one is refused on its bytes.
      expect((await upload('logo', Buffer.from('GIF89a not a png')).expect(415)).body.error.code).toBe('ASSET_TYPE_NOT_ALLOWED');
    });

    it('P19.6-T1 AC-4 takes a square logo of at least 512 × 512 and refuses one that is not square', async () => {
      const ok = await upload('logo_square', await png(600, 600)).expect(200);
      expect(ok.body).toMatchObject({ width: 512, height: 512 });
      expect((await upload('logo_square', await png(600, 500)).expect(422)).body.error.details.reason).toBe('dimensions');
      expect((await upload('logo_square', await png(256, 256)).expect(422)).body.error.details.reason).toBe('dimensions');
    });

    it('P19.6-T1 AC-6 keeps a mascot as WebP at three widths, and refuses one without transparency or under 512 px', async () => {
      const ok = await upload('mascot', await png(600, 800, 0.5)).expect(200);
      const names = storage.puts.filter((k) => k.startsWith(ok.body.storageKey)).map((k) => k.split('/').pop());
      expect(names).toEqual(['mascot-120.webp', 'mascot-240.webp', 'mascot-360.webp']);
      expect((await upload('mascot', await opaque(600, 600)).expect(422)).body.error.details.reason).toBe('no_alpha');
      expect((await upload('mascot', await png(300, 300, 0.5)).expect(422)).body.error.details.reason).toBe('dimensions');
    });

    it('P19.6-T1 AC-3 a confirm before the bytes arrived is 409; a key outside this KPM’s originals 400', async () => {
      const signed = await http().post(`${SETTINGS}/uploads`).send({ kind: 'logo', filename: 'x', mimeType: 'image/png', bytes: 10 }).expect(201);
      await http().post(`${SETTINGS}/uploads/confirm`).send({ kind: 'logo', storageKey: signed.body.storageKey }).expect(409);
      await http().post(`${SETTINGS}/uploads/confirm`).send({ kind: 'logo', storageKey: `dev/${OTHER_KPM}/branding/originals/0001` }).expect(400);
    });

    it('P19.6-T1 ADR-0218 §2 a key that only contains this KPM’s originals folder, or is another environment’s, is 400 — whatever storage holds', async () => {
      session.current = OWNER;
      const body = await opaque(600, 120);
      const elsewhere = [
        `dev/${OTHER_KPM}/training/${FIXTURE_KPM}/branding/originals/0001`,
        `staging/${FIXTURE_KPM}/branding/originals/0001`,
        `x/dev/${FIXTURE_KPM}/branding/originals/0001`,
        `dev/${FIXTURE_KPM}/branding/originals/0001/more`,
      ];
      for (const storageKey of elsewhere) {
        // Bytes a real upload would pass with: only the key's place can refuse it.
        storage.holdBytes(storageKey, body, 'image/png');
        const res = await http().post(`${SETTINGS}/uploads/confirm`).send({ kind: 'logo', storageKey, mimeType: 'image/png' }).expect(400);
        expect(res.body.error).toMatchObject({ code: 'VALIDATION_FAILED', details: { field: 'storageKey' } });
      }
      expect(storage.puts.some((k) => k.includes('/branding/') && !k.startsWith(`dev/${FIXTURE_KPM}/`))).toBe(false);
      // The same bytes under this KPM's own originals folder are accepted.
      storage.holdBytes(`dev/${FIXTURE_KPM}/branding/originals/0099`, body, 'image/png');
      await http().post(`${SETTINGS}/uploads/confirm`).send({ kind: 'logo', storageKey: `dev/${FIXTURE_KPM}/branding/originals/0099`, mimeType: 'image/png' }).expect(200);
    });
  });

  describe('AC-5, AC-7, AC-9 the colours', () => {
    beforeEach(() => { session.current = OWNER; });

    it('P19.6-T1 AC-9 previews the palette of two colours and writes nothing', async () => {
      const res = await http().post(`${SETTINGS}/preview`).send({ primary: '#0a6e5c', secondary: '#f2c14e' }).expect(200);
      expect(res.body.primary).toEqual({ contrast: 'light', ratio: expect.any(Number) });
      expect(res.body.secondary.contrast).toBe('dark');
      expect(res.body.palette).toMatchObject({ primary: '#0a6e5c', primaryContrast: '#ffffff', secondaryContrast: '#1b2b4b' });
      expect((await http().get(SETTINGS).expect(200)).body.own).toBeNull();
    });

    it('B7-AC2 P19.6-T1 AC-7 refuses a colour no text reads on, naming it, on the preview and on Simpan', async () => {
      const preview = await http().post(`${SETTINGS}/preview`).send({ primary: '#808080', secondary: '#1b2b4b' }).expect(422);
      expect(preview.body.error).toMatchObject({ code: 'BRANDING_COLOUR_UNREADABLE', details: { field: 'primary' } });
      const save = await http().put(SETTINGS).send({ primary: '#0a6e5c', secondary: '#808080', expectedVersion: 0 }).expect(422);
      expect(save.body.error.details.field).toBe('secondary');
      expect((await http().get(SETTINGS).expect(200)).body.own).toBeNull();
    });

    it('P19.6-T1 AC-5 saves the two colours together, or refuses one alone', async () => {
      await http().put(SETTINGS).send({ primary: '#0a6e5c', expectedVersion: 0 }).expect(400);
      await http().put(SETTINGS).send({ primary: 'teal', secondary: '#1b2b4b', expectedVersion: 0 }).expect(400);
    });
  });

  describe('AC-10, AC-11, AC-12, AC-15 saving, the template, resetting, the audit', () => {
    it('B7-AC1 P19.6-T1 AC-12 after Simpan every member of the KPM reads the logo, colours and mascot with the session', async () => {
      const { saved } = await brandAsOwner();
      expect(saved.version).toBe(1);
      expect(saved.shown).toMatchObject({ logo: { width: 480, height: 96 }, mascotPoses: ['default'], icons: true });
      for (const ctx of [AB, AAB, AGENT, ADMIN]) {
        const seen = await reader.forSession(ctx);
        expect(seen!.palette!.primary).toBe('#0a6e5c');
        expect(seen!.version).toBe(saved.shown.version);
      }
    });

    it('B7-AC4 P19.6-T1 AC-12 another KPM is unaffected: it shows AgencyBoost’s, and cannot use this KPM’s pictures', async () => {
      const { logo } = await brandAsOwner();
      expect(await reader.forSession(OTHER_OWNER)).toMatchObject({ kpmId: OTHER_KPM, palette: null, logo: null, lesson: null });
      session.current = OTHER_OWNER;
      expect((await http().get(SETTINGS).expect(200)).body).toMatchObject({ own: null, version: 0 });
      const refused = await http().put(SETTINGS).send({ logo: { key: logo }, expectedVersion: 0 }).expect(400);
      expect(refused.body.error.details.field).toBe('logo');
      await http().post(`${SETTINGS}/reset`).send({ expectedVersion: 0 }).expect(200);
      expect((await reader.forSession(OWNER))!.palette!.primary).toBe('#0a6e5c');
    });

    it('P19.6-T1 AC-12 a stale expectedVersion is 409 and writes nothing', async () => {
      await brandAsOwner();
      await http().put(SETTINGS).send({ primary: '#1b2b4b', secondary: '#0a6e5c', expectedVersion: 0 }).expect(409);
      expect((await reader.forSession(OWNER))!.palette!.primary).toBe('#0a6e5c');
    });

    it('P19.6-T1 AC-15 every change is in the audit log: who, when, and old → new', async () => {
      await brandAsOwner();
      await http().put(SETTINGS).send({ primary: '#1b2b4b', secondary: '#0a6e5c', expectedVersion: 1 }).expect(200);
      await http().post(`${SETTINGS}/reset`).send({ expectedVersion: 2 }).expect(200);
      const entries = await wired.audit.findForTenant(FIXTURE_KPM);
      const actions = entries.map((e) => e.action).filter((a) => a.startsWith('kpm_branding.'));
      expect(actions.sort()).toEqual(['kpm_branding.reset', 'kpm_branding.updated', 'kpm_branding.updated']);
      const second = entries.find((e) => e.action === 'kpm_branding.updated' && (e.before as { primary?: unknown } | null)?.primary);
      expect(second!.before).toMatchObject({ primary: { hex: '#0a6e5c', contrast: { side: 'light' } } });
      expect(second!.after).toMatchObject({ primary: { hex: '#1b2b4b' }, logo: null, mascot: null });
    });

    it('B7-AC3 P19.6-T1 AC-10, AC-11 the template’s Tampilan is read live; the KPM’s own wins by group; reset shows the template’s', async () => {
      session.current = SUPER_ADMIN;
      const base = `/admin/companies/${COMPANY}/templates/${templateId}/branding`;
      const tplLogo = (await upload('logo', await opaque(600, 120), 'image/png', base).expect(200)).body.storageKey as string;
      expect(tplLogo).toMatch(new RegExp(`^dev/company/${COMPANY}/branding/`));
      await wired.templateService.saveDraft(SUPER_ADMIN, COMPANY, 'branding', {
        logo: { key: tplLogo, width: 480, height: 96 }, primary: '#7a1f5c', secondary: '#1b2b4b',
      }, templateId);
      // A draft is no KPM's yet.
      expect((await reader.shownFor(FIXTURE_KPM))!.source.colours).toBeNull();
      await wired.templateService.publish(SUPER_ADMIN, COMPANY, 'branding', templateId);
      const fromTemplate = (await reader.shownFor(FIXTURE_KPM))!;
      expect(fromTemplate.source).toEqual({ logos: 'template', colours: 'template', mascot: null });
      expect((await reader.shownFor(OTHER_KPM))!.palette!.primary).toBe('#7a1f5c');

      // No lock: the Owner sets the colours alone; the template's logo still shows.
      session.current = OWNER;
      await http().put(SETTINGS).send({ primary: '#0a6e5c', secondary: '#1b2b4b', expectedVersion: 0 }).expect(200);
      expect((await reader.shownFor(FIXTURE_KPM))!.source).toEqual({ logos: 'template', colours: 'own', mascot: null });
      const page = await http().get(SETTINGS).expect(200);
      expect(page.body.template).toMatchObject({ primary: '#7a1f5c', logo: { key: tplLogo } });

      // *Kembalikan ke default*: the template's colours again.
      await http().post(`${SETTINGS}/reset`).send({ expectedVersion: 1 }).expect(200);
      expect((await reader.shownFor(FIXTURE_KPM))!.palette!.primary).toBe('#7a1f5c');
    });

    it('P19.6-T1 AC-11 a template’s Tampilan with an unreadable colour, or another company’s picture, is refused', async () => {
      await expect(wired.templateService.saveDraft(SUPER_ADMIN, COMPANY, 'branding', { primary: '#808080', secondary: '#1b2b4b' }, templateId))
        .rejects.toMatchObject({ response: expect.objectContaining({ code: 'BRANDING_COLOUR_UNREADABLE' }) });
      await expect(wired.templateService.saveDraft(SUPER_ADMIN, COMPANY, 'branding', {
        logo: { key: `dev/company/66f0000000000000000000c9/branding/01JBXXXXXXXXXXXXXXXXXXXXXX`, width: 1, height: 1 },
      }, templateId)).rejects.toMatchObject({ status: 400 });
    });

    it('P19.6-T1 AC-11 a template’s editor previews its colours under company_template:write, and an Owner is refused', async () => {
      const base = `/admin/companies/${COMPANY}/templates/${templateId}/branding/preview`;
      const ok = await http().post(base).send({ primary: '#7a1f5c', secondary: '#1b2b4b' }).expect(200);
      expect(ok.body.palette.primaryContrast).toBe('#ffffff');
      await http().post(base).send({ primary: '#808080', secondary: '#1b2b4b' }).expect(422);
      session.current = OWNER;
      await http().post(base).send({ primary: '#7a1f5c', secondary: '#1b2b4b' }).expect(403);
    });

    it('P19.6-T1 AC-11 template uploads are the Super Admin’s alone, and 404 for a template not the company’s', async () => {
      session.current = OWNER;
      await http().post(`/admin/companies/${COMPANY}/templates/${templateId}/branding/uploads`)
        .send({ kind: 'logo', filename: 'x', mimeType: 'image/png', bytes: 10 }).expect(403);
      session.current = SUPER_ADMIN;
      await http().post(`/admin/companies/${COMPANY}/templates/66f0000000000000000000ff/branding/uploads`)
        .send({ kind: 'logo', filename: 'x', mimeType: 'image/png', bytes: 10 }).expect(404);
    });
  });

  describe('AC-13, AC-16 the public read and the files', () => {
    it('P19.6-T1 AC-13 answers a live KPM’s name, version, palette and logo size by its id, without a session', async () => {
      const { saved } = await brandAsOwner();
      const res = await http().get(`/kpm-branding/${FIXTURE_KPM}`).expect(200);
      expect(res.body).toEqual({
        name: 'KPM Bintaro', version: saved.shown.version, palette: expect.objectContaining({ primary: '#0a6e5c' }),
        logo: { width: 480, height: 96 },
      });
    });

    it('P19.6-T1 AC-13 answers everything null for an unknown, malformed or suspended KPM alike', async () => {
      await brandAsOwner();
      const empty = { name: null, version: null, palette: null, logo: null };
      expect((await http().get('/kpm-branding/66f0000000000000000000ee').expect(200)).body).toEqual(empty);
      expect((await http().get('/kpm-branding/0417').expect(200)).body).toEqual(empty);
      await (wired.kpms as unknown as mongoose.Model<never>).updateOne({ _id: FIXTURE_KPM } as never, { status: 'suspended' } as never);
      expect((await http().get(`/kpm-branding/${FIXTURE_KPM}`).expect(200)).body).toEqual(empty);
    });

    it('P19.6-T1 AC-16 serves the sizes made from the upload, immutable with the current version, never the original', async () => {
      const { saved } = await brandAsOwner();
      const v = saved.shown.version;
      const logo = await http().get(`/kpm-branding/${FIXTURE_KPM}/files/logo.png?v=${v}`).expect(200);
      expect(logo.headers['content-type']).toBe('image/png');
      expect(logo.headers['cache-control']).toBe('public, max-age=31536000, immutable');
      const icon = await http().get(`/kpm-branding/${FIXTURE_KPM}/files/icon-192.png`).expect(200);
      expect(icon.headers['cache-control']).toBe('public, max-age=300');
      expect((await sharp(icon.body as Buffer).metadata()).width).toBe(192);
      // A pose with no picture of its own takes the default's; a name outside the list, or one the KPM lacks, is 404.
      expect((await http().get(`/kpm-branding/${FIXTURE_KPM}/files/mascot-thinking-240.webp`).expect(200)).headers['content-type']).toBe('image/webp');
      await http().get(`/kpm-branding/${FIXTURE_KPM}/files/logo-square.png`).expect(404);
      await http().get(`/kpm-branding/${FIXTURE_KPM}/files/original.png`).expect(404);
      await http().get(`/kpm-branding/${OTHER_KPM}/files/logo.png`).expect(404);
    });
  });
});
