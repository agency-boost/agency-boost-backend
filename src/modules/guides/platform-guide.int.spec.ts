import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { INestApplication } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { IS_PUBLIC } from '@/common/auth/auth.decorators';
import { PermissionsGuard } from '@/common/auth/permissions.guard';
import { RequestContext } from '@/common/context/request-context';
import { DomainExceptionFilter } from '@/common/errors/error.filter';
import {
  AAB, AB, ADMIN, AGENT, declaredPermissions, OWNER, productionPipe, session, StubAuth, SUPER_ADMIN,
} from '../../../test/http-permissions';
import { listenOnLoopback } from '../../../test/listen';
import { PlatformGuideController } from './platform-guide.controller';
import { guidesDirectory, SUPER_ADMIN_GUIDE, SuperAdminGuide } from './super-admin-guide';

/** A view-as session: the member's context, the Super Admin behind it, read-only (ADR-0206 §4). */
const viewAs = (who: RequestContext) => new RequestContext(who.userId, 'none', who.membership, 'root', null, false, true);
/** Somebody signed in who belongs to no office yet. */
const NO_OFFICE = new RequestContext('u-new', 'none', null);

/** Every reader but the Super Admin: the five office roles, somebody in no office, and two view-as sessions. */
const REFUSED: [string, RequestContext][] = [
  ['the KPM Owner', OWNER], ['the KPM Admin', ADMIN], ['an AB', AB], ['an AAB', AAB], ['an Agent', AGENT],
  ['somebody in no office', NO_OFFICE],
  ['a view-as session as the Owner', viewAs(OWNER)], ['a view-as session as an Agent', viewAs(AGENT)],
];

const ASSETS = join(__dirname, '../../../assets/panduan');

/**
 * **P19.6-T5 AC-4 — the Super Admin's guide, INTERNAL, over HTTP** (ADR-0219 §4; the guide spec's acceptance 3,
 * `Panduan-AC3`): the real `PermissionsGuard` and pipe in front of the real controller, reading the real files in
 * `assets/panduan/`. The Super Admin reads the HTML and the PDF exactly as delivered, never cached; every other role and
 * a view-as session is `403 PERM_DENIED` with nothing of the guide in the answer.
 */
describe('P19.6-T5 AC-4 GET /admin/panduan — the Super Admin’s guide, to that role alone', () => {
  let app: INestApplication;
  const http = () => request(app.getHttpServer());

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      controllers: [PlatformGuideController],
      providers: [SuperAdminGuide],
    }).compile();
    app = moduleRef.createNestApplication();
    app.useGlobalPipes(productionPipe());
    app.useGlobalFilters(new DomainExceptionFilter());
    app.useGlobalGuards(new StubAuth(), new PermissionsGuard(app.get(Reflector)));
    await app.init();
    await listenOnLoopback(app);
  });

  afterAll(async () => {
    await app?.close();
  });

  beforeEach(() => {
    session.current = SUPER_ADMIN;
  });

  it('P19.6-T5 AC-4 declares platform_guide:read on both routes', () => {
    expect(declaredPermissions(PlatformGuideController)).toEqual({
      html: 'platform_guide:read',
      pdf: 'platform_guide:read',
    });
  });

  it('P19.6-T5 AC-4 neither route is public, so the app’s AuthGuard answers 401 to a request with no session', () => {
    const reflector = new Reflector();
    const prototype = PlatformGuideController.prototype as unknown as Record<string, () => unknown>;
    expect(reflector.get(IS_PUBLIC, PlatformGuideController)).toBeUndefined();
    for (const route of ['html', 'pdf']) expect([route, reflector.get(IS_PUBLIC, prototype[route])]).toEqual([route, undefined]);
  });

  it('Panduan-AC3 P19.6-T5 AC-4 answers the Super Admin the HTML byte for byte, as text/html, never cached', async () => {
    const res = await http().get('/admin/panduan').buffer(true).parse((r, done) => {
      const chunks: Buffer[] = [];
      r.on('data', (c: Buffer) => chunks.push(c));
      r.on('end', () => done(null, Buffer.concat(chunks)));
    });
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toBe('text/html; charset=utf-8');
    expect(res.headers['cache-control']).toBe('no-store');
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    expect(res.headers['content-disposition']).toBeUndefined();
    expect(Buffer.compare(res.body as Buffer, readFileSync(join(ASSETS, SUPER_ADMIN_GUIDE.html)))).toBe(0);
    // The right file: the Super Admin's own guide, not a public one copied by mistake.
    expect((res.body as Buffer).toString('utf8')).toContain('<title>Panduan Super Admin (Internal)</title>');
  });

  it('Panduan-AC3 P19.6-T5 AC-4 answers the Super Admin the PDF as an attachment, byte for byte, never cached', async () => {
    const res = await http().get('/admin/panduan/pdf').buffer(true).parse((r, done) => {
      const chunks: Buffer[] = [];
      r.on('data', (c: Buffer) => chunks.push(c));
      r.on('end', () => done(null, Buffer.concat(chunks)));
    });
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toBe('application/pdf');
    expect(res.headers['content-disposition']).toBe('attachment; filename="panduan-super-admin.pdf"');
    expect(res.headers['cache-control']).toBe('no-store');
    const pdf = res.body as Buffer;
    expect(pdf.subarray(0, 5).toString('latin1')).toBe('%PDF-');
    expect(Buffer.compare(pdf, readFileSync(join(ASSETS, SUPER_ADMIN_GUIDE.pdf)))).toBe(0);
  });

  it.each(REFUSED)('Panduan-AC3 P19.6-T5 AC-4 refuses %s both files, 403 PERM_DENIED, with nothing of the guide', async (_who, ctx) => {
    session.current = ctx;
    for (const path of ['/admin/panduan', '/admin/panduan/pdf']) {
      const res = await http().get(path);
      expect([path, res.status, res.body.error?.code, res.body.error?.details?.permission])
        .toEqual([path, 403, 'PERM_DENIED', 'platform_guide:read']);
      expect(res.headers['content-type']).toMatch(/^application\/json/);
      expect(res.text).not.toMatch(/Panduan Super Admin|%PDF-/);
    }
  });
});

describe('P19.6-T5 AC-4 the guide’s files are found from the source and from the built image alike', () => {
  it('P19.6-T5 AC-4 finds assets/panduan/ from src/modules/guides and from dist/modules/guides', () => {
    expect(guidesDirectory()).toBe(ASSETS);
    expect(guidesDirectory(join(__dirname, '../../../dist/modules/guides'))).toBe(ASSETS);
  });

  it('P19.6-T5 AC-4 says what is missing when the files are not there, rather than answering an empty guide', () => {
    expect(() => guidesDirectory('/')).toThrow(/assets\/panduan\/super-admin\.html/);
  });

  it('P19.6-T5 AC-4 reads each file once and answers the same bytes after', () => {
    const guide = new SuperAdminGuide();
    expect(guide.html()).toBe(guide.html());
    expect(guide.pdf()).toBe(guide.pdf());
    expect(guide.html().equals(guide.pdf())).toBe(false);
  });
});
