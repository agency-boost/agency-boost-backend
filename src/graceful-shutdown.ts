import type { Server } from 'node:http';
import { BeforeApplicationShutdown, Injectable, Logger, Optional } from '@nestjs/common';
import { HttpAdapterHost } from '@nestjs/core';
import { NOTIFICATION_DRAIN_TIMEOUT_MS, NotificationService } from '@/modules/notifications/notification.service';

/**
 * **How long a shutdown waits for the requests already being answered** (P18.7-T1, ADR-0152), in
 * milliseconds. With the drain's ten seconds after it, the two fit inside the 30 s a deploy gives the
 * old container before SIGKILL (`stop_grace_period` in `deploy/compose.yml`). A request still open
 * at the end has its connection closed.
 */
export const HTTP_CLOSE_TIMEOUT_MS = 15_000;

/**
 * How often idle keep-alive connections are closed while the server waits. `server.close()` closes the
 * ones idle at that moment, but a connection whose request finishes afterwards stays open for the
 * keep-alive timeout (5 s), and the server's close waits for it.
 */
const IDLE_SWEEP_MS = 100;

/** How `stopListening` ended: every request answered, the stragglers cut off, or nothing was listening. */
export type StopOutcome = 'closed' | 'forced' | 'not-listening';

/**
 * **Stop taking requests and wait, a bounded time, for the ones being answered.** New connections are
 * refused at once. Open requests finish, and each connection closes once it is idle. At `timeoutMs`
 * whatever is still open is closed. Harmless to call again, and on a server that never listened (the
 * serverless entry, a test that only `init()`s).
 */
export function stopListening(server: Server | undefined, timeoutMs: number, logger?: Logger): Promise<StopOutcome> {
  if (!server?.listening) return Promise.resolve('not-listening');
  return new Promise((resolve) => {
    const sweep = setInterval(() => server.closeIdleConnections(), IDLE_SWEEP_MS);
    const deadline = setTimeout(() => {
      logger?.warn({ timeoutMs }, 'requests still open at shutdown; closing their connections');
      server.closeAllConnections();
      finish('forced');
    }, timeoutMs);
    let settled = false;
    function finish(outcome: StopOutcome): void {
      if (settled) return;
      settled = true;
      clearInterval(sweep);
      clearTimeout(deadline);
      resolve(outcome);
    }
    server.close(() => finish('closed'));
  });
}

/**
 * **The order a shutdown happens in** (P18.7-T1, ADR-0152), on `app.close()` and so on SIGTERM:
 *
 * 1. **Stop listening, and let the open requests finish.** Nest closes the HTTP server only after every
 *    `beforeApplicationShutdown` hook has run, so a drain that ran first found nothing in flight. A
 *    registration still hashing its password when the signal came then sent its email after the drain
 *    had finished, into a process about to stop, and its row stayed `pending`.
 * 2. **Wait for the deliveries those requests started** (`NotificationService.drain`), with the database
 *    still open, so each outcome is recorded.
 *
 * One hook, because Nest runs the hooks of the providers in a module concurrently: two hooks could not be
 * ordered. Nest's own close of the server comes after this and finds it closed already.
 */
@Injectable()
export class GracefulShutdown implements BeforeApplicationShutdown {
  private readonly logger = new Logger(GracefulShutdown.name);

  constructor(
    private readonly notifications: NotificationService,
    // Absent in an application context with no HTTP server, where there is nothing to stop.
    @Optional() private readonly adapterHost?: HttpAdapterHost,
  ) {}

  async beforeApplicationShutdown(signal?: string): Promise<void> {
    const server = this.adapterHost?.httpAdapter?.getHttpServer() as Server | undefined;
    await stopListening(server, HTTP_CLOSE_TIMEOUT_MS, this.logger);
    await this.notifications.drain(NOTIFICATION_DRAIN_TIMEOUT_MS, signal);
  }
}
