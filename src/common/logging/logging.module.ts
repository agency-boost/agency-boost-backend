import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { LoggerModule } from 'nestjs-pino';
import { randomUUID } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';

/**
 * Structured JSON logging.
 *
 * Every line carries `requestId`, and — once a request is authenticated — `userId` and
 * `kpmId`. The tenant id on every line is what makes "is this one office or everyone?"
 * answerable in seconds rather than hours
 * (docs/02-specs/nfr/accessibility-and-observability.md).
 *
 * Never logged: passwords, tokens, full lead contact details, coaching note bodies.
 * Logs are the easiest place to leak personal data without noticing, so redaction is
 * declared here rather than left to call sites.
 */
@Module({
  imports: [
    LoggerModule.forRootAsync({
      inject: [ConfigService],
      useFactory: (config: ConfigService) => ({
        pinoHttp: {
          level: config.get<string>('LOG_LEVEL', 'info'),

          genReqId: (req: IncomingMessage, res: ServerResponse) => {
            const existing = req.headers['x-request-id'];
            const id = (Array.isArray(existing) ? existing[0] : existing) ?? randomUUID();
            res.setHeader('X-Request-Id', id);
            return id;
          },

          customProps: (req: IncomingMessage) => {
            // Populated by the auth guard from Phase 2. Absent on public routes, which
            // is correct — an unauthenticated request has no tenant.
            const ctx = (req as { context?: { userId?: string; kpmId?: string | null } }).context;
            return { userId: ctx?.userId, kpmId: ctx?.kpmId ?? undefined };
          },

          redact: {
            paths: [
              'req.headers.authorization',
              'req.headers.cookie',
              'res.headers["set-cookie"]',
              'req.body.password',
              'req.body.currentPassword',
              'req.body.newPassword',
              'req.body.token',
              '*.passwordHash',
              '*.refreshToken',
            ],
            censor: '[redacted]',
          },

          // The health probe would otherwise dominate the log volume.
          autoLogging: {
            ignore: (req: IncomingMessage) => (req.url ?? '').startsWith('/api/health'),
          },

          transport:
            config.get('NODE_ENV') === 'development'
              ? { target: 'pino-pretty', options: { singleLine: true } }
              : undefined,
        },
      }),
    }),
  ],
})
export class LoggingModule {}
