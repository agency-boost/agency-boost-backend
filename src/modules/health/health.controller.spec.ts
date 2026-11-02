import type { Response } from 'express';
import { HealthController } from './health.controller';

/** A response that records the status a handler sets on it, and nothing else. */
function recordingResponse(): Response & { statusCode: number } {
  const res = { statusCode: 200 } as Response & { statusCode: number };
  res.status = jest.fn((code: number) => {
    res.statusCode = code;
    return res;
  }) as unknown as Response['status'];
  return res;
}

describe('HealthController', () => {
  it('reports liveness without touching the database', () => {
    const controller = new HealthController({ readyState: 0 } as never);
    expect(controller.live()).toEqual({ status: 'ok' });
  });

  it('reports ready when the database connection is up', async () => {
    const controller = new HealthController({ readyState: 1 } as never);
    const res = recordingResponse();
    await expect(controller.ready(res)).resolves.toEqual({
      status: 'ok',
      checks: { database: 'up' },
    });
    // 200 is Nest's own default for a GET; the handler leaves it alone.
    expect(res.status).not.toHaveBeenCalled();
  });

  it('reports degraded when the database is not connected', async () => {
    const controller = new HealthController({ readyState: 2 } as never);
    await expect(controller.ready(recordingResponse())).resolves.toEqual({
      status: 'degraded',
      checks: { database: 'down' },
    });
  });

  /*
   * A probe reads the status, never the body: the container's healthcheck, `deploy.sh` before it
   * switches traffic, and the smoke test after a deploy. `200` with `degraded` passed all three with
   * no database behind them.
   */
  it.each([0, 2, 3, 99])('P18.7-T1 answers 503 when the connection is not up (readyState %d)', async (readyState) => {
    const controller = new HealthController({ readyState } as never);
    const res = recordingResponse();
    await controller.ready(res);
    expect(res.status).toHaveBeenCalledWith(503);
    expect(res.statusCode).toBe(503);
  });

  it('leaks no version or dependency detail', async () => {
    const controller = new HealthController({ readyState: 1 } as never);
    const body = JSON.stringify(await controller.ready(recordingResponse()));
    // P18.7-T2: the storage vendor is GCS now (ADR-0153), so the regex names it rather than Cloudinary.
    expect(body).not.toMatch(/version|mongodb|storage|googleapis|node/i);
  });
});
