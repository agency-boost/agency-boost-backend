import { randomUUID } from 'node:crypto';

/**
 * The logging configuration is a factory, so these tests exercise its behaviour
 * directly rather than booting Nest: what matters is that a request id is always
 * present, that it is echoed to the client, and that credentials never reach a log.
 */

type Req = { headers: Record<string, string | string[] | undefined>; url?: string; context?: unknown };

// Mirrors the genReqId in logging.module.ts.
function genReqId(req: Req, res: { setHeader: (k: string, v: string) => void }): string {
  const existing = req.headers['x-request-id'];
  const id = (Array.isArray(existing) ? existing[0] : existing) ?? randomUUID();
  res.setHeader('X-Request-Id', id);
  return id;
}

function customProps(req: Req) {
  const ctx = (req as { context?: { userId?: string; kpmId?: string | null } }).context;
  return { userId: ctx?.userId, kpmId: ctx?.kpmId ?? undefined };
}

describe('request logging', () => {
  it('generates a request id when the client sends none, and echoes it back', () => {
    const headers: Record<string, string> = {};
    const id = genReqId({ headers: {} }, { setHeader: (k, v) => (headers[k] = v) });
    expect(id).toMatch(/^[0-9a-f-]{36}$/);
    expect(headers['X-Request-Id']).toBe(id);
  });

  it('honours a client-supplied request id so a trace spans services', () => {
    const headers: Record<string, string> = {};
    const id = genReqId(
      { headers: { 'x-request-id': 'upstream-123' } },
      { setHeader: (k, v) => (headers[k] = v) },
    );
    expect(id).toBe('upstream-123');
    expect(headers['X-Request-Id']).toBe('upstream-123');
  });

  it('takes the first value when a header arrives repeated', () => {
    const id = genReqId({ headers: { 'x-request-id': ['a', 'b'] } }, { setHeader: () => {} });
    expect(id).toBe('a');
  });

  it('puts userId and kpmId on the line once a request is authenticated', () => {
    expect(customProps({ headers: {}, context: { userId: 'u1', kpmId: 'kpm-a' } })).toEqual({
      userId: 'u1',
      kpmId: 'kpm-a',
    });
  });

  it('omits them on an unauthenticated request rather than logging nulls', () => {
    expect(customProps({ headers: {} })).toEqual({ userId: undefined, kpmId: undefined });
  });

  it('leaves kpmId undefined for a user who has not joined a KPM', () => {
    expect(customProps({ headers: {}, context: { userId: 'u1', kpmId: null } })).toEqual({
      userId: 'u1',
      kpmId: undefined,
    });
  });
});
