import { Controller, Get } from '@nestjs/common';
import { InjectConnection } from '@nestjs/mongoose';
import { Connection } from 'mongoose';

/**
 * Liveness and readiness. Neither leaks a version or dependency detail publicly —
 * an unauthenticated endpoint is a reconnaissance surface.
 */
@Controller('health')
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
