import { createServer, request as httpRequest, Agent } from 'node:http';
import type { AddressInfo } from 'node:net';
import { Controller, INestApplication, Logger, Post } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { Test } from '@nestjs/testing';
import mongoose from 'mongoose';
import request from 'supertest';
import { Clock, FixedClock } from '@/common/clock/clock.port';
import { AuditService } from '@/modules/audit/audit.service';
import { NotificationRepository } from '@/modules/notifications/notification.repository';
import {
  Notification, NotificationPreferences, NotificationPreferencesSchema, NotificationSchema,
} from '@/modules/notifications/notification.schema';
import {
  NOTIFICATION_ADAPTERS, NotificationService, TemplateRenderer,
} from '@/modules/notifications/notification.service';
import {
  NotificationChannel, NotificationChannelAdapter, NotificationTemplate, RenderedMessage, SendRequest,
} from '@/modules/notifications/notification.types';
import { listenOnLoopback } from '../test/listen';
import { startMongo, stopMongo } from '../test/mongo';
import { GracefulShutdown, HTTP_CLOSE_TIMEOUT_MS, stopListening } from './graceful-shutdown';

/** A promise somebody else resolves. */
function gate(): { wait: Promise<void>; open: () => void } {
  let open = () => undefined as void;
  const wait = new Promise<void>((resolve) => { open = resolve; });
  return { wait, open };
}

async function until(condition: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 500 && !condition(); attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  if (!condition()) throw new Error('the condition never held');
}

const requestGate = gate();
const emailGate = gate();
let entered = false;

class StubRenderer extends TemplateRenderer {
  render(templateId: string): RenderedMessage {
    return { subject: templateId, body: '' };
  }
}

/** A relay that answers only once the test says so. */
class GatedEmail extends NotificationChannelAdapter {
  readonly channel: NotificationChannel = 'email';
  sent: SendRequest[] = [];
  async send(to: SendRequest): Promise<void> {
    await emailGate.wait;
    this.sent.push(to);
  }
}
const email = new GatedEmail();

/** A registration, reduced to its shape: busy for a while (Argon2, in the real one), then it sends its email. */
@Controller('slow')
class SlowController {
  constructor(private readonly notifications: NotificationService) {}

  @Post()
  async register(): Promise<{ status: string }> {
    entered = true;
    await requestGate.wait;
    await this.notifications.send({
      userId: 'u-rina', templateId: NotificationTemplate.EMAIL_VERIFICATION, payload: { token: 't' },
    });
    return { status: 'verification_sent' };
  }
}

/**
 * **A shutdown in the middle of a request still delivers that request's email** (P18.7-T1, the review's
 * M1), through `app.close()`, which is what SIGTERM runs.
 *
 * Nest closes the HTTP server only after every `beforeApplicationShutdown` hook. With the drain as one of
 * those hooks it ran first, found nothing in flight and returned. The request finished afterwards and
 * dispatched its email into a process whose database was about to close, so the row stayed `pending`.
 */
describe('a graceful shutdown (P18.7-T1)', () => {
  let app: INestApplication;

  beforeAll(async () => {
    const uri = await startMongo();
    const dbName = mongoose.connection.db!.databaseName;
    const moduleRef = await Test.createTestingModule({
      imports: [
        MongooseModule.forRoot(uri, { dbName }),
        MongooseModule.forFeature([
          { name: Notification.name, schema: NotificationSchema },
          { name: NotificationPreferences.name, schema: NotificationPreferencesSchema },
        ]),
      ],
      controllers: [SlowController],
      providers: [
        NotificationRepository,
        NotificationService,
        GracefulShutdown,
        { provide: TemplateRenderer, useClass: StubRenderer },
        { provide: Clock, useValue: new FixedClock(new Date('2026-10-19T03:00:00Z')) },
        { provide: AuditService, useValue: { record: async () => undefined } },
        { provide: NOTIFICATION_ADAPTERS, useValue: [email] },
      ],
    }).compile();
    app = moduleRef.createNestApplication({ logger: false });
    await app.init();
    await listenOnLoopback(app);
  });

  afterAll(async () => {
    requestGate.open();
    emailGate.open();
    await stopMongo();
  });

  it('P18.7-T1 stops listening, lets the open request finish, then waits for the email it sent', async () => {
    const server = app.getHttpServer();
    const answered = request(server).post('/slow').then((res) => res);
    await until(() => entered);

    let closed = false;
    const closing = app.close().then(() => { closed = true; });
    // The listener goes first: nothing new is taken while the open request finishes.
    await until(() => !server.listening);

    requestGate.open();
    const res = await answered;
    expect(res.status).toBe(201);
    expect(res.body).toEqual({ status: 'verification_sent' });

    // The request has answered and its email is still at the relay: the shutdown waits for it.
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(closed).toBe(false);

    emailGate.open();
    await closing;
    expect(email.sent).toHaveLength(1);
    const [row] = await mongoose.connection.db!.collection('notifications').find({}).toArray();
    expect(row.delivery.email.status).toBe('sent');
  });
});

describe('GracefulShutdown with no HTTP server (P18.7-T1)', () => {
  it.each([
    ['no adapter host', undefined],
    ['an adapter host with no adapter, as an application context has', {}],
  ])('P18.7-T1 with %s, it only drains, with the drain\'s own bound', async (_what, host) => {
    const drain = jest.fn().mockResolvedValue([]);
    await new GracefulShutdown({ drain } as never, host as never).beforeApplicationShutdown('SIGTERM');
    expect(drain).toHaveBeenCalledWith(10_000, 'SIGTERM');
  });
});

describe('stopListening (P18.7-T1)', () => {
  it('P18.7-T1 has a bound that leaves time for the drain inside the 30 s grace period', () => {
    expect(HTTP_CLOSE_TIMEOUT_MS).toBe(15_000);
  });

  it('P18.7-T1 answers at once for a server that is not listening, and a second call is harmless', async () => {
    expect(await stopListening(undefined, 1_000)).toBe('not-listening');
    const server = createServer((_req, res) => res.end('ok'));
    expect(await stopListening(server, 1_000)).toBe('not-listening');

    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    expect(await stopListening(server, 1_000)).toBe('closed');
    expect(await stopListening(server, 1_000)).toBe('not-listening');
  });

  it('P18.7-T1 closes a keep-alive connection once its request is answered, rather than after its timeout', async () => {
    const answer = gate();
    const server = createServer(async (_req, res) => {
      await answer.wait;
      res.end('ok');
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const agent = new Agent({ keepAlive: true });
    const done = new Promise<void>((resolve) => {
      httpRequest({ host: '127.0.0.1', port: (server.address() as AddressInfo).port, agent }, (res) => {
        res.resume();
        res.on('end', resolve);
      }).end();
    });
    await new Promise((resolve) => setTimeout(resolve, 50));

    const started = Date.now();
    const stopping = stopListening(server, 10_000);
    answer.open();
    await done;
    expect(await stopping).toBe('closed');
    // Well under the server's 5 s keep-alive timeout, which is what a plain `close()` waits for.
    expect(Date.now() - started).toBeLessThan(2_000);
    agent.destroy();
  });

  it('P18.7-T1 closes what is still open at the bound, and says so', async () => {
    const warn = jest.fn();
    const server = createServer(() => undefined); // never answers
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const failed = new Promise<void>((resolve) => {
      httpRequest({ host: '127.0.0.1', port: (server.address() as AddressInfo).port })
        .on('error', () => resolve())
        .end();
    });
    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(await stopListening(server, 100, { warn } as unknown as Logger)).toBe('forced');
    await failed; // the client's connection was closed under it
    expect(warn).toHaveBeenCalledWith({ timeoutMs: 100 }, 'requests still open at shutdown; closing their connections');
  });
});
