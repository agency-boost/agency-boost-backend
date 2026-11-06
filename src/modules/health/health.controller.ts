import { Controller, Get, HttpStatus, Res, VERSION_NEUTRAL } from '@nestjs/common';
import { ApiResponse } from '@nestjs/swagger';
import type { Response } from 'express';
import { Public } from '@/common/auth/auth.decorators';
import { InjectConnection } from '@nestjs/mongoose';
import { Connection } from 'mongoose';
import { ReadinessDto } from '@/modules/auth/session.response.dto';

/** What readiness answers: the same body whether the process is ready or not, only the status differs. */
export interface Readiness {
  status: 'ok' | 'degraded';
  checks: Record<string, string>;
}

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

  /**
   * Readiness: the process can serve traffic. Includes database connectivity.
   *
   * **`503` when the database is down** (P18.4-T1, ADR-0152). It answered `200` with `degraded` in
   * the body, and a probe reads the status, not the body: the container's healthcheck, `deploy.sh`
   * waiting before it switches traffic, and the smoke test after a deploy would all have passed an
   * API with no database. The body is unchanged, so a person reading it still sees which check
   * failed.
   *
   * Set on the response with `passthrough` rather than thrown, so the error filter does not replace
   * the body with its envelope.
   */
  @Get('ready')
  // Stated because the failure is: Swagger drops the success it would infer once any response is declared.
  @ApiResponse({ status: HttpStatus.OK, description: '', type: ReadinessDto })
  @ApiResponse({
    status: HttpStatus.SERVICE_UNAVAILABLE,
    description: 'Not ready: the database is not connected. The body says so, `{ status: "degraded", checks: { database: "down" } }`.',
    type: ReadinessDto,
  })
  async ready(@Res({ passthrough: true }) res: Response): Promise<Readiness> {
    // 1 === connected, per Mongoose's readyState enum.
    const database = this.connection.readyState === 1 ? 'up' : 'down';
    if (database === 'down') res.status(HttpStatus.SERVICE_UNAVAILABLE);
    return {
      status: database === 'up' ? 'ok' : 'degraded',
      checks: { database },
    };
  }
}
