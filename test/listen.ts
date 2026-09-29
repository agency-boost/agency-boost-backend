import type { INestApplication } from '@nestjs/common';

/**
 * **Listen where supertest will call: on 127.0.0.1, not on every interface.**
 *
 * `app.listen(0)` binds a free port on `::`, and supertest then dials `127.0.0.1` on that port. On
 * macOS the IPv6 wildcard binds even when another process already holds `127.0.0.1` on the same
 * number — and a developer's machine has several: an editor's extension host, a device helper, an
 * API client. When the free port the OS picked was one of theirs on the loopback address, the
 * request went to them, and a spec that passes every other time answered `401 Unauthorized` from a
 * server that was not ours (2026-09-29). Binding the loopback address makes the OS pick a port that
 * is free *there*.
 */
export function listenOnLoopback(app: INestApplication): Promise<unknown> {
  return app.listen(0, '127.0.0.1');
}
