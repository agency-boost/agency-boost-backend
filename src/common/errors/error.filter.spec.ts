import {
  BadRequestException, ForbiddenException, HttpStatus, InternalServerErrorException, NotFoundException as RouteNotFound,
  PayloadTooLargeException, UnauthorizedException,
} from '@nestjs/common';
import { DomainExceptionFilter } from './error.filter';
import {
  DomainException, InvalidRequestException, NotFoundException, PermissionDeniedException, VersionConflictException,
} from './domain.exception';
import { ErrorCode } from './error-codes';
import { refusals } from '@/common/i18n/sentence';
import { MissingTenantContextError } from '@/common/tenancy/tenant-scope.error';

function makeHost(requestId = 'req-1', request: { headers?: Record<string, string>; reader?: unknown } = {}) {
  const json = jest.fn();
  const status = jest.fn(() => ({ json }));
  return {
    host: {
      switchToHttp: () => ({
        getResponse: () => ({ status }),
        getRequest: () => ({ id: requestId, url: '/api/v1/leads', headers: request.headers ?? {}, reader: request.reader }),
      }),
    },
    status,
    json,
  } as const;
}

/** A request the app sent from an Indonesian screen, no guard having resolved it. */
const INDONESIAN = { headers: { 'accept-language': 'id' } };

describe('DomainExceptionFilter', () => {
  const filter = new DomainExceptionFilter();

  it('renders a domain exception with its code, message and details', () => {
    const { host, status, json } = makeHost();
    filter.catch(new VersionConflictException(3, 5), host as never);

    expect(status).toHaveBeenCalledWith(HttpStatus.CONFLICT);
    expect(json).toHaveBeenCalledWith({
      error: {
        code: 'VERSION_CONFLICT',
        message: expect.stringContaining('changed since you loaded it'),
        details: { expectedVersion: 3, actualVersion: 5 },
        requestId: 'req-1',
      },
    });
  });

  it('renders a cross-tenant miss as a plain 404, leaking nothing', () => {
    const { host, status, json } = makeHost();
    filter.catch(new NotFoundException('Lead'), host as never);

    expect(status).toHaveBeenCalledWith(HttpStatus.NOT_FOUND);
    const body = json.mock.calls[0][0];
    expect(body.error.code).toBe('NOT_FOUND');
    expect(JSON.stringify(body)).not.toMatch(/kpm|tenant/i);
  });

  it('carries the permission name in details for a denial', () => {
    const { host, json } = makeHost();
    filter.catch(new PermissionDeniedException('lead:delete'), host as never);
    expect(json.mock.calls[0][0].error.details).toMatchObject({ permission: 'lead:delete' });
  });

  it('maps a validation BadRequest to VALIDATION_FAILED with the violations', () => {
    const { host, status, json } = makeHost();
    filter.catch(new BadRequestException(['name must be a string']), host as never);

    expect(status).toHaveBeenCalledWith(HttpStatus.BAD_REQUEST);
    expect(json.mock.calls[0][0].error).toMatchObject({
      code: 'VALIDATION_FAILED',
      details: { violations: ['name must be a string'] },
    });
  });

  it('handles a string-bodied HttpException', () => {
    const { host, json } = makeHost();
    filter.catch(new BadRequestException('plain message'), host as never);
    expect(json.mock.calls[0][0].error.message).toContain('plain message');
  });

  it('never leaks internals from an unexpected error', () => {
    const { host, status, json } = makeHost();
    jest.spyOn(filter['logger'], 'error').mockImplementation(() => undefined);

    filter.catch(new Error('connection string mongodb+srv://user:hunter2@cluster'), host as never);

    expect(status).toHaveBeenCalledWith(HttpStatus.INTERNAL_SERVER_ERROR);
    const body = JSON.stringify(json.mock.calls[0][0]);
    expect(body).not.toContain('hunter2');
    expect(body).not.toContain('mongodb+srv');
    expect(json.mock.calls[0][0].error.requestId).toBe('req-1');
  });

  it('gives a framework exception the catalog code for its status: the router’s 404 is NOT_FOUND, never INTERNAL_ERROR', () => {
    const cases: [Error, number, string][] = [
      [new RouteNotFound('Cannot GET /'), 404, 'NOT_FOUND'],
      [new ForbiddenException(), 403, 'PERM_DENIED'],
      [new UnauthorizedException(), 401, 'AUTH_TOKEN_INVALID'],
      [new BadRequestException('plain message'), 400, 'VALIDATION_FAILED'],
      // No catalog code of its own: still INTERNAL_ERROR, at its own status.
      [new PayloadTooLargeException(), 413, 'INTERNAL_ERROR'],
    ];
    for (const [exception, code, name] of cases) {
      const { host, status, json } = makeHost();
      filter.catch(exception, host as never);
      expect(status).toHaveBeenCalledWith(code);
      expect(json.mock.calls[0][0].error).toMatchObject({ code: name, requestId: 'req-1' });
    }
  });

  it('treats a non-domain HttpException 500 as INTERNAL_ERROR', () => {
    const { host, json } = makeHost();
    jest.spyOn(filter['logger'], 'error').mockImplementation(() => undefined);
    filter.catch(new InternalServerErrorException('boom'), host as never);
    expect(json.mock.calls[0][0].error.code).toBe('INTERNAL_ERROR');
  });

  it('falls back to the x-request-id header, then to "unknown"', () => {
    const json = jest.fn();
    const status = jest.fn(() => ({ json }));
    const host = {
      switchToHttp: () => ({
        getResponse: () => ({ status }),
        getRequest: () => ({ url: '/x', headers: {} }),
      }),
    };
    filter.catch(new NotFoundException('Lead'), host as never);
    expect(json.mock.calls[0][0].error.requestId).toBe('unknown');
  });

  it('renders the tenancy backstop as a refusal, not a server fault', () => {
    // It fired as 500 INTERNAL_ERROR for a whole phase, on `GET /members/tree` with a
    // Super Admin token: the guard passed a grant the route could not honour, the
    // repository stopped the query correctly, and the caller was told the server broke.
    // A backstop working is not a fault.
    const { host, status, json } = makeHost();
    filter.catch(new MissingTenantContextError('memberships', 'find'), host as never);

    expect(status).toHaveBeenCalledWith(HttpStatus.FORBIDDEN);
    expect(json).toHaveBeenCalledWith({
      error: {
        code: 'TENANT_NO_MEMBERSHIP',
        message: 'This request needs an office, and yours resolves to none.',
        requestId: 'req-1',
      },
    });
    // The error's own message names the collection and the operation. That is for the
    // log; a caller learns their request had no tenant and nothing else.
    expect(JSON.stringify(json.mock.calls[0])).not.toContain('memberships');
  });
});

/**
 * **P18.98-T5 AC-2, AC-3 — every refusal in the reader's language** (ADR-0179 §7): the sentence, every sentence in
 * `details`, and the filter's own — written for the reader `AuthGuard` resolved, else the header's. `code` and every
 * other detail are the same in both languages.
 */
describe('P18.98-T5 the refusal in the reader’s language', () => {
  const filter = new DomainExceptionFilter();
  const SAY = refusals('error.filter spec', {
    VALIDATION_FAILED: {
      bad: { en: 'That is not right.', id: 'Itu tidak benar.' },
      field: { en: 'name must be text.', id: 'name harus berupa teks.' },
    },
  });

  it('AC-2 writes a domain exception’s sentence in Indonesian, its code and details unchanged', () => {
    const { host, json } = makeHost('req-1', INDONESIAN);
    filter.catch(new VersionConflictException(3, 5), host as never);
    expect(json).toHaveBeenCalledWith({
      error: {
        code: 'VERSION_CONFLICT',
        message: 'Data ini berubah sejak Anda membukanya. Muat ulang, lalu coba lagi.',
        details: { expectedVersion: 3, actualVersion: 5 },
        requestId: 'req-1',
      },
    });
  });

  it('AC-2 names a missing resource in the reader’s words', () => {
    const indonesian = makeHost('req-1', INDONESIAN);
    filter.catch(new NotFoundException('Membership'), indonesian.host as never);
    expect(indonesian.json.mock.calls[0][0].error).toMatchObject({ code: 'NOT_FOUND', message: 'Anggota tidak ditemukan.' });
    const english = makeHost();
    filter.catch(new NotFoundException('Membership'), english.host as never);
    expect(english.json.mock.calls[0][0].error.message).toBe('Membership not found.');
  });

  it('AC-1 prefers the reader the guard resolved to the header', () => {
    const { host, json } = makeHost('req-1', { headers: { 'accept-language': 'en' }, reader: { language: 'id', figures: 'id' } });
    filter.catch(new PermissionDeniedException('lead:delete'), host as never);
    expect(json.mock.calls[0][0].error).toMatchObject({
      code: 'PERM_DENIED',
      message: 'Anda tidak memiliki izin untuk melakukan tindakan ini.',
      details: { permission: 'lead:delete' },
    });
  });

  it('AC-1 writes a refusal for the reader its thrower knew, over the request’s', () => {
    const { host, json } = makeHost();
    filter.catch(new InvalidRequestException(SAY.VALIDATION_FAILED.bad).writtenFor({ language: 'id', figures: 'id' }), host as never);
    expect(json.mock.calls[0][0].error.message).toBe('Itu tidak benar.');
  });

  it('AC-3 writes every sentence in details for the reader, and holds English on the exception', () => {
    const refusal = new DomainException(
      ErrorCode.VALIDATION_FAILED, SAY.VALIDATION_FAILED.bad, HttpStatus.BAD_REQUEST,
      { violations: [SAY.VALIDATION_FAILED.field], field: 'name' },
    );
    expect(refusal.message).toBe('That is not right.');
    expect(refusal.details).toEqual({ violations: ['name must be text.'], field: 'name' });
    expect(refusal.getResponse()).toEqual({
      code: 'VALIDATION_FAILED', message: 'That is not right.', details: { violations: ['name must be text.'], field: 'name' },
    });

    const { host, json } = makeHost('req-1', INDONESIAN);
    filter.catch(refusal, host as never);
    expect(json.mock.calls[0][0].error).toEqual({
      code: 'VALIDATION_FAILED',
      message: 'Itu tidak benar.',
      details: { violations: ['name harus berupa teks.'], field: 'name' },
      requestId: 'req-1',
    });
  });

  it('AC-3 answers no details where none were given', () => {
    const { host, json } = makeHost('req-1', INDONESIAN);
    filter.catch(new InvalidRequestException(SAY.VALIDATION_FAILED.bad), host as never);
    expect(json.mock.calls[0][0].error).toEqual({ code: 'VALIDATION_FAILED', message: 'Itu tidak benar.', requestId: 'req-1' });
  });

  it('AC-2 says what a framework exception’s status means in Indonesian, and keeps Nest’s English', () => {
    const cases: [Error, string, string][] = [
      [new RouteNotFound('Cannot GET /'), 'NOT_FOUND', 'Alamat yang diminta tidak ditemukan.'],
      [new ForbiddenException(), 'PERM_DENIED', 'Anda tidak memiliki izin untuk melakukan tindakan ini.'],
      [new UnauthorizedException(), 'AUTH_TOKEN_INVALID', 'Masuk untuk melanjutkan.'],
      [new BadRequestException('Unexpected token } in JSON'), 'VALIDATION_FAILED', 'Permintaan ini tidak valid.'],
      [new PayloadTooLargeException(), 'INTERNAL_ERROR', 'Permintaan ini tidak dapat diproses.'],
    ];
    for (const [exception, code, indonesian] of cases) {
      const id = makeHost('req-1', INDONESIAN);
      filter.catch(exception, id.host as never);
      expect(id.json.mock.calls[0][0].error).toMatchObject({ code, message: indonesian });
      const en = makeHost();
      filter.catch(exception, en.host as never);
      expect(en.json.mock.calls[0][0].error.message).toBe(exception.message);
    }
  });

  it('AC-3 reads a list Nest wrote as class-validator’s violations, in Indonesian', () => {
    const { host, json } = makeHost('req-1', INDONESIAN);
    filter.catch(new BadRequestException(['name must be a string', 'property kpmId should not exist']), host as never);
    expect(json.mock.calls[0][0].error).toMatchObject({
      code: 'VALIDATION_FAILED',
      message: 'name harus berupa teks; properti kpmId tidak dikenal',
      details: { violations: ['name harus berupa teks', 'properti kpmId tidak dikenal'] },
    });
  });

  it('AC-2 writes the tenancy backstop and the unexpected error in Indonesian', () => {
    const backstop = makeHost('req-1', INDONESIAN);
    filter.catch(new MissingTenantContextError('memberships', 'find'), backstop.host as never);
    expect(backstop.json.mock.calls[0][0].error.message)
      .toBe('Permintaan ini memerlukan KPM, dan Anda tidak tergabung di KPM mana pun.');

    jest.spyOn(filter['logger'], 'error').mockImplementation(() => undefined);
    const fault = makeHost('req-1', INDONESIAN);
    filter.catch(new Error('boom'), fault.host as never);
    expect(fault.json.mock.calls[0][0].error.message)
      .toBe('Terjadi kesalahan. Sebutkan ID permintaan ini jika Anda menghubungi tim dukungan.');
  });
});
