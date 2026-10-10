import { INestApplication } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { Test } from '@nestjs/testing';
import mongoose from 'mongoose';
import { PermissionsGuard } from '@/common/auth/permissions.guard';
import { RequestContext } from '@/common/context/request-context';
import { DomainExceptionFilter } from '@/common/errors/error.filter';
import { EventController } from '@/modules/events/event.controller';
import { EventGuestController } from '@/modules/events/event-guest.controller';
import { EventGuestService } from '@/modules/events/event-guest.service';
import { EventRollCallService } from '@/modules/events/event-roll-call.service';
import { EventService } from '@/modules/events/event.service';
import type { EventView } from '@/modules/events/event.service';
import { configModule } from './config-module';
import { buildCoachingOffice, COMPANY, KPM_A, KPM_B, ROSTER_NOW, type CoachingOffice, type Who } from './coaching-office';
import { productionPipe, StubAuth } from './http-permissions';
import { listenOnLoopback } from './listen';

/**
 * **The events office, for the specs that read and write its members' answers** (P18.5-T5, P18.5-T6): the coaching
 * office's people (`test/coaching-office.ts`), the company's name, one member who joined after the past events, one
 * leader edge history, and an event in every state, created through the Owner's own service.
 *
 * ```
 * OWNER Wilson (AB, Owner) ── ADMIN Maya (AB, Admin, leads nobody), AGUS (AB), PEER_AB (AB)
 * AGUS ── INDAH, DIMAS, SARI (AAB) ── RINA, BUDI, NINA (AAB) ── DODI
 *      ── DEWI (AAB, leads nobody now; led TARI from 1 to 20 August), LUKAS (Agent who leads TARI)
 * LATE (Agent under SARI, joined 1 September: after every past event below)
 * Office B (0555): B_AB (made its Owner here) ── B_AGENT
 * ```
 *
 * | Event (code) | When, from ROSTER_NOW (Mon 14 Sep 2026, 10:00 Jakarta) | Audience |
 * |---|---|---|
 * | `UPCOMING` | +5 days | all |
 * | `RUNNING_LEADERS` | started an hour ago, ends in two | leaders |
 * | `PAST_ALL` | 24 August | all |
 * | `PAST_CHOSEN` | 20 August | chosen: RINA, BUDI |
 * | `PAST_LEADERS` | 10 August | leaders — DEWI led TARI then, LUKAS did not |
 * | `ENDS_NOW` | ended exactly now | all — the boundary |
 * | `ARCHIVED` | +3 days, archived | all |
 * | 0555 `B_PAST` | 24 August | all |
 */
export const EVENTS_NOW = ROSTER_NOW;

export type EventKey =
  | 'UPCOMING' | 'RUNNING_LEADERS' | 'PAST_ALL' | 'PAST_CHOSEN' | 'PAST_LEADERS' | 'ENDS_NOW' | 'ARCHIVED' | 'B_PAST';

export type EventsWho = Who | 'LATE';

export interface EventsOffice extends Omit<CoachingOffice, 'as' | 'id'> {
  id: Record<EventsWho, string>;
  /** Signed in as this member. `OWNER` is 0417's Owner; `B_OWNER` is 0555's root AB, made its Owner. */
  as(who: EventsWho | 'B_OWNER'): RequestContext;
  /** A support session as this member, read-only unless `readOnly` is false. */
  supported(who: EventsWho, readOnly?: boolean): RequestContext;
  event: Record<EventKey, EventView>;
}

const day = (iso: string) => new Date(iso);

export async function buildEventsOffice(wired: ReturnType<typeof configModule>): Promise<EventsOffice> {
  const office = await buildCoachingOffice(wired);
  const db = mongoose.connection.db!;
  const oid = (id: string) => new mongoose.Types.ObjectId(id);
  await db.collection('companies').insertOne({ _id: oid(COMPANY), name: 'Prudential', slug: 'prudential-events', deletedAt: null });
  // The members' rows' unique indexes, which the single-write rules lean on in a race (as `forum-office.ts` does).
  await Promise.all(['EventRsvp', 'EventFeedback'].map((name) => mongoose.model(name).syncIndexes()));
  await wired.provisioning.seedEventTypes(KPM_B);

  // LATE: under Sari, joined after every past event.
  const lateUser = new mongoose.Types.ObjectId();
  await db.collection('users').insertOne({
    _id: lateUser, email: 'late@events.test', passwordHash: 'x', fullName: 'Lala Terlambat', status: 'active',
    platformRole: 'none', companyId: COMPANY, agentCode: 'PRU-79999', deletedAt: null,
  });
  const sari = await db.collection('memberships').findOne({ _id: oid(office.id.SARI) });
  const late = new mongoose.Types.ObjectId();
  await db.collection('memberships').insertOne({
    _id: late, kpmId: KPM_A, userId: String(lateUser), agentCode: 'PRU-79999', agentSeq: 999, leaderCode: 'LLATE',
    orgLevelId: new mongoose.Types.ObjectId().toString(), orgLevelCode: 'AGENT', role: 'agent', leaderId: office.id.SARI,
    ancestorIds: [...(sari!.ancestorIds as string[]), office.id.SARI], depth: 3, directCounts: { total: 0 },
    subtreeCount: 0, status: 'active', joinedAt: day('2026-09-01T02:00:00Z'), deletedAt: null,
  });

  // Tari's edges: under Lukas, under Dewi from 1 to 20 August, back under Lukas.
  const edge = (eventType: string, toLeaderId: string, validFrom: string, validTo: string | null) => ({
    kpmId: KPM_A, membershipId: office.id.TARI, eventType, toLeaderId, validFrom: day(validFrom),
    validTo: validTo ? day(validTo) : null, deletedAt: null,
  });
  await db.collection('membershipHistory').insertMany([
    edge('joined', office.id.LUKAS, '2026-01-02T02:00:00Z', '2026-08-01T02:00:00Z'),
    edge('re_parented', office.id.DEWI, '2026-08-01T02:00:00Z', '2026-08-20T02:00:00Z'),
    edge('re_parented', office.id.LUKAS, '2026-08-20T02:00:00Z', null),
  ]);

  const id = { ...office.id, LATE: String(late) } as Record<EventsWho, string>;
  const as = (who: EventsWho | 'B_OWNER'): RequestContext => {
    if (who === 'LATE') {
      return new RequestContext('u-LATE', 'none', {
        membershipId: id.LATE, kpmId: KPM_A, orgLevelCode: 'AGENT', hierarchyRole: 'agent', status: 'active',
        isKpmOwner: false, isKpmAdmin: false, directCount: 0,
      });
    }
    if (who === 'B_OWNER') {
      const b = office.as('B_AB');
      return new RequestContext(b.userId, 'none', { ...b.membership!, isKpmOwner: true });
    }
    return office.as(who);
  };

  const owner = as('OWNER');
  const make = (ctx: RequestContext, code: string, over: Record<string, unknown>) => wired.events.create(ctx, {
    code, typeCode: 'TRAINING', title: code.replace(/_/g, ' '), blurb: `${code} blurb`,
    description: `${code} description`, location: 'Kantor KPM', audience: { issuer: 'kpm', scope: 'all_agents' }, ...over,
  });
  const at = (ms: number) => new Date(EVENTS_NOW.getTime() + ms).toISOString();
  const H = 3_600_000;
  const event = {
    UPCOMING: await make(owner, 'UPCOMING', { startsAt: at(5 * 24 * H), endsAt: at(5 * 24 * H + 2 * H), locationUrl: 'https://meet.example.test/x' }),
    RUNNING_LEADERS: await make(owner, 'RUNNING_LEADERS', {
      startsAt: at(-H), endsAt: at(2 * H), audience: { issuer: 'kpm', scope: 'leaders' },
    }),
    PAST_ALL: await make(owner, 'PAST_ALL', {
      typeCode: 'PRODUCT_LAUNCH', startsAt: '2026-08-24T02:00:00Z', endsAt: '2026-08-24T05:00:00Z',
      audience: { issuer: 'company', scope: 'all_agents' },
    }),
    PAST_CHOSEN: await make(owner, 'PAST_CHOSEN', {
      startsAt: '2026-08-20T01:00:00Z', endsAt: '2026-08-20T09:00:00Z',
      audience: { issuer: 'kpm', scope: 'select_agents', inviteeMembershipIds: [office.id.RINA, office.id.BUDI] },
    }),
    PAST_LEADERS: await make(owner, 'PAST_LEADERS', {
      startsAt: '2026-08-10T08:00:00Z', endsAt: '2026-08-10T10:00:00Z', audience: { issuer: 'kpm', scope: 'leaders' },
    }),
    ENDS_NOW: await make(owner, 'ENDS_NOW', { startsAt: at(-2 * H), endsAt: at(0) }),
    ARCHIVED: await make(owner, 'ARCHIVED', { startsAt: at(3 * 24 * H), endsAt: at(3 * 24 * H + H) }),
    B_PAST: await make(as('B_OWNER'), 'B_PAST', { startsAt: '2026-08-24T02:00:00Z', endsAt: '2026-08-24T05:00:00Z' }),
  } as Record<EventKey, EventView>;
  event.ARCHIVED = await wired.events.archive(owner, event.ARCHIVED.id);

  return {
    ...office,
    id,
    as,
    supported: (who, readOnly = true) => {
      const member = as(who);
      return new RequestContext(member.userId, 'none', member.membership, 'u-support', null, false, readOnly);
    },
    event,
  };
}

/** Both events controllers over HTTP, with the real `PermissionsGuard` and the production pipe; `session` decides who. */
export async function eventsApp(wired: ReturnType<typeof configModule>): Promise<INestApplication> {
  const moduleRef = await Test.createTestingModule({
    controllers: [EventGuestController, EventController],
    providers: [
      { provide: EventGuestService, useValue: wired.eventGuests },
      { provide: EventRollCallService, useValue: wired.eventRollCalls },
      { provide: EventService, useValue: wired.events },
    ],
  }).compile();
  const app = moduleRef.createNestApplication();
  app.useGlobalPipes(productionPipe());
  app.useGlobalFilters(new DomainExceptionFilter());
  app.useGlobalGuards(new StubAuth(), new PermissionsGuard(app.get(Reflector)));
  await app.init();
  await listenOnLoopback(app);
  return app;
}

export { KPM_A, KPM_B };
