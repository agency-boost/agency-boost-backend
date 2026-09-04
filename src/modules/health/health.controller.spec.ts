import { HealthController } from './health.controller';

describe('HealthController', () => {
  it('reports liveness without touching the database', () => {
    const controller = new HealthController({ readyState: 0 } as never);
    expect(controller.live()).toEqual({ status: 'ok' });
  });

  it('reports ready when the database connection is up', async () => {
    const controller = new HealthController({ readyState: 1 } as never);
    await expect(controller.ready()).resolves.toEqual({
      status: 'ok',
      checks: { database: 'up' },
    });
  });

  it('reports degraded when the database is not connected', async () => {
    const controller = new HealthController({ readyState: 2 } as never);
    await expect(controller.ready()).resolves.toEqual({
      status: 'degraded',
      checks: { database: 'down' },
    });
  });

  it('leaks no version or dependency detail', async () => {
    const controller = new HealthController({ readyState: 1 } as never);
    const body = JSON.stringify(await controller.ready());
    expect(body).not.toMatch(/version|mongodb|cloudinary|node/i);
  });
});
