import { INestApplication } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { Test } from '@nestjs/testing';
import mongoose from 'mongoose';
import request from 'supertest';
import { PermissionsGuard } from '@/common/auth/permissions.guard';
import { FixedClock } from '@/common/clock/clock.port';
import { RequestContext } from '@/common/context/request-context';
import { DomainExceptionFilter } from '@/common/errors/error.filter';
import { CalendarController } from '@/modules/calendar/calendar.controller';
import { CalendarService } from '@/modules/calendar/calendar.service';
import { CalendarPeopleService } from '@/modules/calendar/calendar-people.service';
import {
  Notification, NotificationPreferences, NotificationPreferencesSchema, NotificationSchema,
} from '@/modules/notifications/notification.schema';
import { NotificationRepository } from '@/modules/notifications/notification.repository';
import { NotificationService, TemplateRenderer } from '@/modules/notifications/notification.service';
import {
  NotificationChannelAdapter, type NotificationChannel, type RenderedMessage, type SendRequest,
} from '@/modules/notifications/notification.types';
import { configModule } from './config-module';
import { buildCoachingOffice, ROSTER_NOW, type CoachingOffice, type Who } from './coaching-office';
import { NO_CLASS, productionPipe, session, StubAuth } from './http-permissions';
import { listenOnLoopback } from './listen';
import { clearCollections, startMongo, stopMongo } from './mongo';

/**
 * **The calendar's office, over HTTP** (Phase 12): `test/coaching-office.ts`'s people — an AB with a
 * whole downline, an AAB with a nested unit, an AAB who leads nobody, a peer AB's unit, a member who
 * left, and an office B — behind the real `PermissionsGuard`, the production pipe and the real calendar
 * services, so what a spec asserts is what the wire carries.
 *
 * ```
 * OWNER Wilson (AB, the Owner) ─┬── ADMIN Maya (AB, the Admin, leads nobody)
 *                               ├── AGUS ─┬── INDAH, DIMAS
 *                               │         ├── SARI (AAB) ─┬── RINA, BUDI
 *                               │         │               └── NINA (AAB) ── DODI
 *                               │         ├── DEWI (AAB, leads nobody) · LUKAS ── TARI · LEFT (removed)
 *                               └── PEER_AB ── PEER_AAB ── PEER_AGENT
 * Office B: B_AB ── B_AGENT
 * ```
 *
 * The clock is `ROSTER_NOW`, **10:00 on Monday 14 September 2026 in Jakarta**: that week runs from the
 * 14th to the 20th, and an entry at 09:00 on the 14th has already ended.
 */
export const WEEK = { monday: '2026-09-14', sunday: '2026-09-20' } as const;

/** A renderer that says what it was asked, so an email's link can be read. */
class LinkRenderer extends TemplateRenderer {
  render(templateId: string, payload: Record<string, unknown>): RenderedMessage {
    return { subject: templateId, body: JSON.stringify(payload) };
  }
}

/** A channel that records what reached it. */
export class RecordingAdapter extends NotificationChannelAdapter {
  sent: { to: SendRequest; rendered: RenderedMessage }[] = [];
  constructor(readonly channel: NotificationChannel) {
    super();
  }
  async send(to: SendRequest, rendered: RenderedMessage): Promise<void> {
    this.sent.push({ to, rendered });
  }
}

export interface CalendarHarness {
  app: INestApplication;
  wired: ReturnType<typeof configModule>;
  office: CoachingOffice;
  clock: FixedClock;
  /** Present when the harness runs the real `NotificationService`. */
  notifications: NotificationService | null;
  inApp: RecordingAdapter | null;
  email: RecordingAdapter | null;
  http: () => ReturnType<typeof request>;
  /** Sign in as somebody of the office, or as a context built for the case. */
  as: (who: Who | RequestContext) => void;
  id: (who: Who) => string;
  col: (name: string) => mongoose.mongo.Collection;
  /** A context as `who`, standing on no rung the matrix names: an Owner or an Admin with no field role. */
  officeOnly: (who: Who) => RequestContext;
  /** A read-only support session as `who`. */
  supporting: (who: Who, readOnly?: boolean) => RequestContext;
  /** Empty the calendar and the inbox, and put the clock back. */
  reset: () => Promise<void>;
}

/**
 * Start the harness. `realNotifications` runs the real `NotificationService` with a recording adapter on
 * each channel, for a spec that asks what reached an inbox and an email; otherwise the configuration
 * module's recorder captures each send.
 */
export async function startCalendar(options: { realNotifications?: boolean } = {}): Promise<CalendarHarness> {
  await startMongo();
  let inApp: RecordingAdapter | null = null;
  let email: RecordingAdapter | null = null;
  let notifications: NotificationService | undefined;
  if (options.realNotifications) {
    inApp = new RecordingAdapter('in_app');
    email = new RecordingAdapter('email');
    const notificationModel = mongoose.model(Notification.name, NotificationSchema);
    notifications = new NotificationService(
      notificationModel as never,
      new NotificationRepository(notificationModel as never),
      mongoose.model(NotificationPreferences.name, NotificationPreferencesSchema) as never,
      new LinkRenderer(),
      new FixedClock(ROSTER_NOW),
      { record: async () => undefined } as never,
      [inApp, email],
    );
  }
  const wired = configModule(ROSTER_NOW, notifications ? { notifications } : {});
  await clearCollections();
  const office = await buildCoachingOffice(wired);
  await Promise.all(mongoose.modelNames().map((name) => mongoose.model(name).init()));

  const moduleRef = await Test.createTestingModule({
    controllers: [CalendarController],
    providers: [
      { provide: CalendarService, useValue: wired.calendar },
      { provide: CalendarPeopleService, useValue: wired.calendarPeople },
    ],
  }).compile();
  const app = moduleRef.createNestApplication();
  app.useGlobalPipes(productionPipe());
  app.useGlobalFilters(new DomainExceptionFilter());
  app.useGlobalGuards(new StubAuth(), new PermissionsGuard(app.get(Reflector)));
  await app.init();
  await listenOnLoopback(app);

  const clock = wired.clock as FixedClock;
  const col = (name: string) => mongoose.connection.db!.collection(name);
  return {
    app, wired, office, clock, inApp, email, notifications: notifications ?? null,
    http: () => request(app.getHttpServer()),
    as: (who) => { session.current = typeof who === 'string' ? office.as(who) : who; },
    id: (who) => office.id[who],
    col,
    officeOnly: (who) => {
      const base = office.as(who);
      // No rung, and so no class (ADR-0156): a grant reads the class, and `NO_CLASS` matches none.
      return new RequestContext(base.userId, 'none', { ...base.membership!, orgLevelCode: 'NO_RUNG', hierarchyRole: NO_CLASS });
    },
    supporting: (who, readOnly = true) => {
      const base = office.as(who);
      return new RequestContext(base.userId, 'none', base.membership, 'u-support', null, false, readOnly);
    },
    reset: async () => {
      clock.set(ROSTER_NOW);
      await col('calendarEvents').deleteMany({});
      await col('notifications').deleteMany({});
      await col('auditLog').deleteMany({});
      wired.sentNotifications.length = 0;
      wired.releasedNotifications.length = 0;
      inApp?.sent.splice(0);
      email?.sent.splice(0);
    },
  };
}

export async function stopCalendar(harness: CalendarHarness | undefined): Promise<void> {
  await harness?.app.close();
  await stopMongo();
}

/** A timed entry's body on the harness's week: `day` 0 is Monday the 14th. */
export function timed(
  day: number, start: string, end: string, over: Record<string, unknown> = {},
): Record<string, unknown> {
  return { type: 'meeting', title: 'Weekly unit standup', date: `2026-09-${String(14 + day).padStart(2, '0')}`, start, end, ...over };
}
