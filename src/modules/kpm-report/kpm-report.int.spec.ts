import { INestApplication } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { PermissionsGuard } from '@/common/auth/permissions.guard';
import { ViewOnlySessionGuard } from '@/common/auth/view-only-session.guard';
import { RequestContext } from '@/common/context/request-context';
import { DomainExceptionFilter } from '@/common/errors/error.filter';
import {
  AAB, AB, ADMIN, AGENT, declaredPermissions, OWNER, productionPipe, session, StubAuth, SUPER_ADMIN,
} from '../../../test/http-permissions';
import { listenOnLoopback } from '../../../test/listen';
import { AdminKpmReportController, KpmReportLinkController } from './kpm-report.controller';
import { KpmReportService } from './kpm-report.service';

const KPM = '66f0000000000000000000a1';
const PDF = Buffer.from('%PDF-1.3\n%stub\n');

/** A view-as session, read-only, as `ContextResolver` builds every one (ADR-0206 §4). */
const viewAs = (ctx: RequestContext) => new RequestContext(ctx.userId, 'none', ctx.membership, 'u-super', null, false, true);

/**
 * **The KPM report's routes over HTTP** (P19.24-T1, T2; ADR-0280 §5, §6; roles §3.9): who the API lets through, per role,
 * both ways, and what it refuses before the service runs. What the service answers on real rows — the demo KPM's file, a
 * KPM of another company, an unknown one, the link opened and refused — is `kpm-report.demo.int.spec.ts`'s.
 */
describe('P19.24 the KPM report routes — who may call them', () => {
  let app: INestApplication;
  const file = { bytes: PDF, disposition: 'attachment; filename="Laporan-KPM-BSD-City-Branch-2026-10.pdf"', pages: 1 };
  const reports = {
    pdf: jest.fn(async () => file),
    link: jest.fn(async () => ({ link: 'http://app/laporan-kpm/t', month: '2026-10' })),
    openLink: jest.fn(async () => file),
  };

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      controllers: [AdminKpmReportController, KpmReportLinkController],
      providers: [{ provide: KpmReportService, useValue: reports }],
    }).compile();
    app = moduleRef.createNestApplication();
    app.useGlobalPipes(productionPipe());
    app.useGlobalFilters(new DomainExceptionFilter());
    app.useGlobalGuards(new StubAuth(), new ViewOnlySessionGuard(app.get(Reflector)), new PermissionsGuard(app.get(Reflector)));
    await app.init();
    await listenOnLoopback(app);
  });
  afterAll(async () => app.close());
  beforeEach(() => {
    for (const fn of Object.values(reports)) fn.mockClear();
  });

  const http = () => request(app.getHttpServer());

  it('P19.24-T2 AC-1 each route declares its grant: the Super Admin’s kpm_report:read, the link kpm_report:download_link', () => {
    expect(declaredPermissions(AdminKpmReportController)).toEqual({ pdf: 'kpm_report:read', link: 'kpm_report:read' });
    expect(declaredPermissions(KpmReportLinkController)).toEqual({ open: 'kpm_report:download_link' });
  });

  it('P19.24-T1 AC-3 the Super Admin gets the PDF itself: application/pdf, an attachment, never cached', async () => {
    session.current = SUPER_ADMIN;
    const res = await http().get(`/admin/tenants/${KPM}/report?month=2026-10`).buffer(true).expect(200);
    expect(res.headers['content-type']).toMatch(/^application\/pdf/);
    expect(res.headers['content-disposition']).toContain('attachment');
    expect(res.headers['cache-control']).toBe('no-store, private');
    expect(reports.pdf).toHaveBeenCalledWith(expect.anything(), KPM, '2026-10');
  });

  it('P19.24-T2 AC-1 the Super Admin gets a Kirim ke owner link', async () => {
    session.current = SUPER_ADMIN;
    const { body } = await http().post(`/admin/tenants/${KPM}/report/link`).send({ month: '2026-10' }).expect(200);
    expect(body).toMatchObject({ month: '2026-10' });
    expect(reports.link).toHaveBeenCalledWith(expect.anything(), KPM, '2026-10');
  });

  it.each([['the Owner', OWNER], ['an Admin', ADMIN], ['an AB', AB], ['an AAB', AAB], ['an Agent', AGENT], ['a view-as session', viewAs(OWNER)]])(
    'P19.24-T2 AC-1 %s holds no kpm_report:read: 403 on both routes, nothing runs', async (_who, ctx) => {
      session.current = ctx;
      expect((await http().get(`/admin/tenants/${KPM}/report?month=2026-10`).expect(403)).body.error.code).toBe('PERM_DENIED');
      // A view-as session is refused the POST one step earlier, by the view-only guard.
      expect(['PERM_DENIED', 'IMPERSONATION_READ_ONLY'])
        .toContain((await http().post(`/admin/tenants/${KPM}/report/link`).send({ month: '2026-10' }).expect(403)).body.error.code);
      expect(reports.pdf).not.toHaveBeenCalled();
      expect(reports.link).not.toHaveBeenCalled();
    },
  );

  it('P19.24-T2 AC-1 a missing or malformed month is 400 by name before the service runs', async () => {
    session.current = SUPER_ADMIN;
    for (const query of ['', '?month=2026-13', '?month=10-2026', '?month=2026-1', '?month=2026-10&group=x']) {
      const { body } = await http().get(`/admin/tenants/${KPM}/report${query}`).expect(400);
      expect(body.error.code).toBe('VALIDATION_FAILED');
    }
    await http().post(`/admin/tenants/${KPM}/report/link`).send({}).expect(400);
    expect(reports.pdf).not.toHaveBeenCalled();
    expect(reports.link).not.toHaveBeenCalled();
  });

  it.each([['the Owner', OWNER], ['an Admin', ADMIN]])('P19.24-T2 AC-1 %s opens a link (the service then checks the KPM)', async (_who, ctx) => {
    session.current = ctx;
    const res = await http().get('/kpm-report/shared/abc.def').buffer(true).expect(200);
    expect(res.headers['content-type']).toMatch(/^application\/pdf/);
    expect(reports.openLink).toHaveBeenCalledWith(expect.anything(), 'abc.def');
  });

  it.each([
    ['an AB', AB], ['an AAB', AAB], ['an Agent', AGENT], ['the Super Admin outside a KPM', SUPER_ADMIN],
    ['a view-as session as the Owner', viewAs(OWNER)],
    // A core leader holds the Owner's rights in KPM and Pengaturan (ADR-0268 §1), not the Owner's link (ADR-0280 §5).
    ['a core leader', new RequestContext(AB.userId, 'none', { ...AB.membership!, isCoreLeader: true } as never)],
  ])(
    'P19.24-T2 AC-1 %s may not open a link: 403, nothing runs', async (_who, ctx) => {
      session.current = ctx;
      await http().get('/kpm-report/shared/abc.def').expect(403);
      expect(reports.openLink).not.toHaveBeenCalled();
    },
  );
});
