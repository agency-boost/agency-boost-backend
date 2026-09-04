import { Controller, Get, VERSION_NEUTRAL } from '@nestjs/common';
import { InjectConnection } from '@nestjs/mongoose';
import { Connection } from 'mongoose';

/**
 * Liveness and readiness. Neither leaks a version or dependency detail publicly —
 * an unauthenticated endpoint is a reconnaissance surface.
 */
// Version-neutral: a load balancer's health probe should not have to know or track
// the API contract version. Served at /api/health, not /api/v1/health.
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
