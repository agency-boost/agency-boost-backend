import { Controller, Get, VERSION_NEUTRAL } from '@nestjs/common';
import { Public } from '@/common/auth/auth.decorators';
import { InjectConnection } from '@nestjs/mongoose';
import { Connection } from 'mongoose';

/**
 * Liveness and readiness. Neither leaks a version or dependency detail publicly —
 * an unauthenticated endpoint is a reconnaissance surface.
 */
// Version-neutral so a probe never tracks the API contract version, and public so the
// global AuthGuard does not answer 401 — a health check that needs a token is a health
// check that reports the service down whenever auth is the thing that broke.
@Public()
@Controller({ path: 'health', version: VERSION_NEUTRAL })
export class HealthController {
  constructor(@InjectConnection() private readonly connection: Connection) {}

  /** Liveness: the process is up. Says nothing about dependencies. */
  @Get()
  live(): { status: 'ok' } {
    return { status: 'ok' };
  }

  /** Readiness: the process can serve traffic. Includes database connectivity. */
  @Get('ready')
  async ready(): Promise<{ status: 'ok' | 'degraded'; checks: Record<string, string> }> {
    // 1 === connected, per Mongoose's readyState enum.
    const database = this.connection.readyState === 1 ? 'up' : 'down';
    return {
      status: database === 'up' ? 'ok' : 'degraded',
      checks: { database },
    };
  }
}
