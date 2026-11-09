import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { StreamableFile } from '@nestjs/common';
import { RequestContext } from '@/common/context/request-context';
import { DomainException } from '@/common/errors/domain.exception';
import { ErrorCode } from '@/common/errors/error-codes';
import { XLSX_MIME_TYPE } from '@/domain/constants';
import { TEMPLATE_KINDS } from '@/modules/config/company-template.schema';
import { AdminController } from './admin.controller';

/**
 * The Super Admin console's scoping rules. The service layer is tested elsewhere; what
 * matters here is which tenant each request resolves to, because getting that wrong
 * either hides a log or leaks one.
 */
describe('AdminController', () => {
  const owner = new RequestContext('u-owner', 'none', {
    membershipId: 'mem-owner',
    kpmId: 'kpm-a',
    orgLevelCode: 'AB', hierarchyRole: 'ab',
    status: 'active',
    isKpmOwner: true,
    isKpmAdmin: false, directCount: 0,
  });

  function make() {
    // The console reads through `AuditReadService`, which names the people and the things.
    const audit = { page: jest.fn(async () => ({ items: [], page: {}, facets: null })) };
    const controller = new AdminController(
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      audit as never,
      {} as never,
      {} as never,
    );
    return { controller, audit };
  }

  it('reads the platform log for a Super Admin who names no tenant', async () => {
    const { controller, audit } = make();
    await controller.readAudit(RequestContext.platform('root'), {});
    expect(audit.page).toHaveBeenCalledWith({ kpmId: null, readerUserId: 'root', reader: expect.objectContaining({ language: 'id' }) }, {}, undefined);
  });

  it('narrows to the named tenant for a Super Admin', async () => {
    const { controller, audit } = make();
    await controller.readAudit(RequestContext.platform('root'), { kpmId: 'kpm-b' });
    expect(audit.page).toHaveBeenCalledWith({ kpmId: 'kpm-b', readerUserId: 'root', reader: expect.objectContaining({ language: 'id' }) }, {}, undefined);
  });

  it('pins a tenant admin to their own office whatever they pass', async () => {
    const { controller, audit } = make();
    await controller.readAudit(owner, { kpmId: 'kpm-b' });
    expect(audit.page).toHaveBeenCalledWith({ kpmId: 'kpm-a', readerUserId: 'u-owner', reader: expect.objectContaining({ language: 'id' }) }, {}, undefined);
  });

  it('P19.2-T2 AC-6 passes the filters and the cursor on, and never the kpmId asked for', async () => {
    const { controller, audit } = make();
    await controller.readAudit(owner, {
      kpmId: 'kpm-b', companyId: 'co-1', action: 'company.created', actorUserId: 'u-1', from: '2026-11-01',
      to: '2026-11-02', cursor: 'abc',
    });
    expect(audit.page).toHaveBeenCalledWith(
      { kpmId: 'kpm-a', readerUserId: 'u-owner', reader: expect.objectContaining({ language: 'id' }) },
      { companyId: 'co-1', action: 'company.created', actorUserId: 'u-1', from: '2026-11-01', to: '2026-11-02' },
      'abc',
    );
  });

  /** The template's kind routes and the roster template, over stubs that record what they were asked. */
  function withTemplatesAndRoster() {
    const templates = {
      read: jest.fn(async () => ({})), history: jest.fn(async () => ({})),
      saveDraft: jest.fn(async () => ({})), publish: jest.fn(async () => ({})),
    };
    const roster = { workbook: jest.fn(async () => Buffer.from('xlsx')) };
    const controller = new AdminController(
      {} as never, {} as never, {} as never, {} as never, {} as never, roster as never, templates as never,
    );
    return { controller, templates, roster };
  }

  it('P4-T8 refuses an unknown template kind 400, naming the kinds there are, and asks the template service nothing', async () => {
    const { controller, templates } = withTemplatesAndRoster();
    const sa = RequestContext.platform('root');
    const calls = [
      () => controller.readTemplate(sa, 'co-1', 'recruitment_playbooks', {}),
      () => controller.publishTemplate(sa, 'co-1', 'recruitment_playbooks', {}),
    ];
    for (const call of calls) {
      const failure = await call().catch((e: unknown) => e) as DomainException;
      expect(failure).toBeInstanceOf(DomainException);
      expect(failure.code).toBe(ErrorCode.VALIDATION_FAILED);
      expect(failure.getStatus()).toBe(400);
      expect(failure.message).toBe(`Unknown template kind "recruitment_playbooks". One of: ${TEMPLATE_KINDS.join(', ')}.`);
    }
    expect(templates.read).not.toHaveBeenCalled();
    expect(templates.publish).not.toHaveBeenCalled();
    // A kind there is passes through, by its own name.
    await controller.readTemplate(sa, 'co-1', 'recruitment_playbook', {});
    expect(templates.read).toHaveBeenCalledWith('co-1', 'recruitment_playbook', undefined, sa.reader, sa);
  });

  it('ADR-0184 the workbook template for an Owner who names no office is their own office’s: the service is asked for none', async () => {
    const { controller, roster } = withTemplatesAndRoster();
    for (const kpmId of [undefined, '']) {
      const file = await controller.rosterTemplate(owner, { format: 'xlsx', kpmId } as never);
      expect(file).toBeInstanceOf(StreamableFile);
      expect((file as StreamableFile).getHeaders()).toMatchObject({ type: XLSX_MIME_TYPE, disposition: 'attachment; filename="roster-template.xlsx"' });
    }
    expect(roster.workbook.mock.calls).toEqual([[owner, null], [owner, null]]);
  });

  // Creating a company used to happen *here*, against an injected Mongoose model — the
  // one handler in this controller that did not delegate, and therefore the one place a
  // duplicate slug had nowhere to be caught. It lives in TenantService now, and so does
  // its test: `tenant.service.tenancy.spec.ts` has a real database, which is the only
  // way to prove the unique index and the pre-check agree.

  /*
   * The gate the exit review found missing (P4-T9 fallout).
   *
   * Read from the decorator rather than through HTTP, because the defect was not a
   * behaviour anybody could see — the route answered 200 exactly as designed. It was a
   * *permission name* that widened underneath a route which had been correct for a year.
   * A test that calls the endpoint asserts the answer; this asserts the reason.
   */
  describe('the platform-wide ladder read', () => {
    const source = readFileSync(join(__dirname, 'admin.controller.ts'), 'utf8');

    it('is gated on a permission only Super Admin holds', () => {
      const route = source.slice(source.indexOf("@Get('org-levels')"));
      const permission = /@RequirePermission\('([^']+)'\)/.exec(route)?.[1];

      expect(permission).toBe('org_level:crud');
      // The one that widened. Naming it here means a future widening of `org_level:read`
      // cannot quietly re-open this route.
      expect(permission).not.toBe('org_level:read');
    });
  });
});
