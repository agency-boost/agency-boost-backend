import { BadRequestException, HttpStatus, InternalServerErrorException } from '@nestjs/common';
import { DomainExceptionFilter } from './error.filter';
import { NotFoundException, PermissionDeniedException, VersionConflictException } from './domain.exception';

function makeHost(requestId = 'req-1') {
  const json = jest.fn();
  const status = jest.fn(() => ({ json }));
  return {
    host: {
      switchToHttp: () => ({
        getResponse: () => ({ status }),
        getRequest: () => ({ id: requestId, url: '/api/v1/leads', headers: {} }),
      }),
    },
    status,
    json,
  } as const;
}

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
});
