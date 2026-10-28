import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Logger } from '@nestjs/common';
import pinoHttp from 'pino-http';
import request from 'supertest';
import { DomainExceptionFilter } from '@/common/errors/error.filter';
import { REDACTED, redactUrl, serializeRequest } from './redact-url';

const TOKEN = 'PaQz5IcHtTT6wsTi9xSqra50nogm5Pl9BB5tMqXN3eM';

/**
 * **A shared link's token never reaches a log** (P18.1-T3 AC-1; ADR-0131 §1, the Phase 18.1 code review): it is in the
 * answer that makes the link and nowhere else, while `GET /leader-meetings/shared/{token}` carries it in the path — so
 * the request logger's line and the error filter's both write the path redacted.
 */
describe('P18.1-T3 AC-1 a shared link’s token is redacted from every logged URL', () => {
  it('P18.1-T3 AC-1 the token’s segment is replaced, whatever follows it; any other path is left as it is', () => {
    expect(redactUrl(`/api/v1/leader-meetings/shared/${TOKEN}`)).toBe(`/api/v1/leader-meetings/shared/${REDACTED}`);
    expect(redactUrl(`/api/v1/leader-meetings/shared/${TOKEN}?x=1`)).toBe(`/api/v1/leader-meetings/shared/${REDACTED}?x=1`);
    expect(redactUrl(`/api/v1/leader-meetings/shared/${TOKEN}/action-items`)).toBe(`/api/v1/leader-meetings/shared/${REDACTED}/action-items`);
    expect(redactUrl('/api/v1/leader-meetings/66f0000000000000000000a1')).toBe('/api/v1/leader-meetings/66f0000000000000000000a1');
    expect(redactUrl(undefined)).toBeUndefined();
    expect(serializeRequest({ url: `/api/v1/leader-meetings/shared/${TOKEN}`, params: { token: TOKEN } }))
      .toEqual({ url: `/api/v1/leader-meetings/shared/${REDACTED}`, params: { token: REDACTED } });
    expect(serializeRequest({ url: '/api/v1/leads', params: { leadId: 'x' } })).toEqual({ url: '/api/v1/leads', params: { leadId: 'x' } });
    expect(serializeRequest({ url: '/x' })).toEqual({ url: '/x' });
  });

  it('P18.1-T3 AC-1 the request logger’s line for an opening carries no token', async () => {
    const lines: string[] = [];
    const log = pinoHttp({ serializers: { req: serializeRequest } }, { write: (line: string) => { lines.push(line); } } as never);
    const server = createServer((req, res) => { log(req, res); res.end('ok'); });
    await request(server).get(`/api/v1/leader-meetings/shared/${TOKEN}`).expect(200);
    expect(lines.length).toBeGreaterThan(0);
    expect(lines.join('\n')).not.toContain(TOKEN);
    expect(JSON.parse(lines[0]).req.url).toBe(`/api/v1/leader-meetings/shared/${REDACTED}`);
    // And the application's logger is configured with it.
    expect(readFileSync(join(__dirname, 'logging.module.ts'), 'utf8')).toContain('serializers: { req: serializeRequest }');
  });

  it('P18.1-T3 AC-1 the error filter logs a failed opening’s path without its token', () => {
    const error = jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    try {
      const json = jest.fn();
      const host = {
        switchToHttp: () => ({
          getResponse: () => ({ status: () => ({ json }) }),
          getRequest: () => ({ id: 'req-1', url: `/api/v1/leader-meetings/shared/${TOKEN}`, headers: {} }),
        }),
      };
      new DomainExceptionFilter().catch(new Error('boom'), host as never);
      expect(error).toHaveBeenCalledTimes(1);
      expect(JSON.stringify(error.mock.calls[0][0])).not.toContain(TOKEN);
      expect(error.mock.calls[0][0]).toMatchObject({ path: `/api/v1/leader-meetings/shared/${REDACTED}` });
    } finally {
      error.mockRestore();
    }
  });
});

describe('P18.96-T3 AC-4 an invite link’s token is redacted from every logged URL', () => {
  it('P18.96-T3 AC-4 the token’s segment of /invites/{token} and its /accept is replaced; a leader’s invite id is not', () => {
    const token = `66f0000000000000000000a1.${TOKEN}`;
    expect(redactUrl(`/api/v1/invites/${token}`)).toBe(`/api/v1/invites/${REDACTED}`);
    expect(redactUrl(`/api/v1/invites/${token}/accept`)).toBe(`/api/v1/invites/${REDACTED}/accept`);
    expect(redactUrl('/api/v1/new-hires/invites/66f0000000000000000000b2/resend'))
      .toBe('/api/v1/new-hires/invites/66f0000000000000000000b2/resend');
    expect(serializeRequest({ url: `/api/v1/invites/${token}`, params: { token } }))
      .toEqual({ url: `/api/v1/invites/${REDACTED}`, params: { token: REDACTED } });
  });
});
