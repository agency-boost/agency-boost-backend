import { INestApplication } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { Test } from '@nestjs/testing';
import mongoose from 'mongoose';
import { PermissionsGuard } from '@/common/auth/permissions.guard';
import { RequestContext } from '@/common/context/request-context';
import { DomainExceptionFilter } from '@/common/errors/error.filter';
import { MemberNames } from '@/modules/org/member-names.service';
import { MonthlyAgentData, MonthlyAgentDataSchema } from '@/modules/production/monthly-agent-data.schema';
import { MonthlyAgentDataRepository } from '@/modules/production/monthly-agent-data.repository';
import { LeaderMeeting, LeaderMeetingSchema } from '@/modules/leader-meetings/leader-meeting.schema';
import {
  LeaderMeetingShareLink, LeaderMeetingShareLinkSchema,
} from '@/modules/leader-meetings/leader-meeting-share-link.schema';
import { LeaderMeetingRepository } from '@/modules/leader-meetings/leader-meeting.repository';
import { LeaderMeetingShareLinkRepository } from '@/modules/leader-meetings/leader-meeting-share-link.repository';
import { LeaderMeetingPeople } from '@/modules/leader-meetings/leader-meeting-people';
import { LeaderMeetingsService } from '@/modules/leader-meetings/leader-meetings.service';
import { LeaderMeetingMinutes } from '@/modules/leader-meetings/leader-meeting-minutes.service';
import { LeaderMeetingSharing } from '@/modules/leader-meetings/leader-meeting-sharing.service';
import { LeaderMeetingsController } from '@/modules/leader-meetings/leader-meetings.controller';
import { LeaderScorecardService } from '@/modules/leader-meetings/scorecard/scorecard.service';
import { configModule } from './config-module';
import { productionPipe, StubAuth } from './http-permissions';
import { listenOnLoopback } from './listen';
import { buildReportingOffice, KPM_A, KPM_B, type ReportingOffice } from './reporting-office';
import type { Who } from './coaching-office';

/**
 * **The Strategic Leader Forum's office, for the specs that read and write it** (Phase 18.1): `test/reporting-office.ts`'s
 * people, production and sessions, and what the forum reads that they do not hold — each office's owning account
 * (`kpms.ownerUserId`), the Admin's grant on her membership (`adminAccess.isKpmAdmin`) and the *Core Leader* tag on
 * Agus and Sari — with the forum's services wired the way the app wires them, over the real scorecard.
 *
 * | Who | Stands | The forum by its address |
 * |---|---|---|
 * | OWNER (Wilson Tanoto) | the Owner, an AB | every meeting, every write, make, move, delete |
 * | ADMIN (Maya Kusuma) | an Admin, an AB | the same |
 * | AGUS | an AB, tagged | read, edit, share — no make, move or delete |
 * | SARI | an AAB, tagged | the same |
 * | RINA, DEWI, PEER_AB | an Agent, an AAB, an AB, not tagged | 404, the list included; a link opens read-only |
 * | B_AB, B_AGENT | 0555's Owner (`ownerOfB()`) and its Agent | their own office's meetings only |
 */
/** The forum's repositories and services, wired the way the app wires them, over the real scorecard. */
export interface ForumServices {
  meetings: LeaderMeetingRepository;
  links: LeaderMeetingShareLinkRepository;
  people: LeaderMeetingPeople;
  scorecards: LeaderScorecardService;
  forum: LeaderMeetingsService;
  minutes: LeaderMeetingMinutes;
  sharing: LeaderMeetingSharing;
}

export async function buildForumServices(wired: ReturnType<typeof configModule>): Promise<ForumServices> {
  const model = <T>(name: string, schema: unknown) => mongoose.model(name, schema as never) as unknown as T;
  const meetings = new LeaderMeetingRepository(model(LeaderMeeting.name, LeaderMeetingSchema));
  const links = new LeaderMeetingShareLinkRepository(model(LeaderMeetingShareLink.name, LeaderMeetingShareLinkSchema));
  await Promise.all([LeaderMeeting.name, LeaderMeetingShareLink.name].map((name) => mongoose.model(name).syncIndexes()));
  const people = new LeaderMeetingPeople(
    wired.memberships, new MemberNames(wired.memberships, wired.users as never), wired.orgLevels, wired.kpms as never,
  );
  const scorecards = new LeaderScorecardService(
    wired.officePeople, wired.productionReadings,
    new MonthlyAgentDataRepository(model(MonthlyAgentData.name, MonthlyAgentDataSchema)), wired.memberships, wired.clock,
  );
  const forum = new LeaderMeetingsService(meetings, people, scorecards, wired.audit, wired.clock);
  const minutes = new LeaderMeetingMinutes(meetings, people, wired.audit, wired.clock);
  const sharing = new LeaderMeetingSharing(links, meetings, forum, people, wired.audit, wired.clock);
  return { meetings, links, people, scorecards, forum, minutes, sharing };
}

export interface ForumOffice extends ReportingOffice, ForumServices {
  /** Tag or untag a member *Core Leader*, as All members does. */
  tag(who: Who, tagged: boolean): Promise<void>;
  /** A support session as this member, read-only unless `readOnly` is false. */
  supported(who: Who, readOnly?: boolean): RequestContext;
}

export async function buildForumOffice(wired: ReturnType<typeof configModule>): Promise<ForumOffice> {
  const office = await buildReportingOffice(wired);
  const db = mongoose.connection.db!;
  const oid = (id: string) => new mongoose.Types.ObjectId(id);
  await db.collection('kpms').updateOne({ _id: oid(KPM_A) }, { $set: { ownerUserId: await office.userIdOf('OWNER'), branchName: 'BSD City Branch' } });
  await db.collection('kpms').updateOne({ _id: oid(KPM_B) }, { $set: { ownerUserId: await office.userIdOf('B_AB'), branchName: 'Kelapa Gading Branch' } });
  await db.collection('memberships').updateOne(
    { _id: oid(office.id.ADMIN) },
    { $set: { adminAccess: { isKpmAdmin: true, grantedByUserId: null, grantedAt: null, revokedAt: null } } },
  );
  const tag = async (who: Who, tagged: boolean) => {
    await db.collection('memberships').updateOne({ _id: oid(office.id[who]) }, { $set: { isCoreLeader: tagged } });
  };
  await tag('AGUS', true);
  await tag('SARI', true);

  const services = await buildForumServices(wired);

  return {
    ...office, ...services, tag,
    supported: (who, readOnly = true) => {
      const member = office.as(who);
      return new RequestContext(member.userId, 'none', member.membership, 'u-support', null, false, readOnly);
    },
  };
}

/** The forum's controller over HTTP, with the real `PermissionsGuard` and the production pipe; `session` decides who. */
export async function forumApp(forum: ForumServices): Promise<INestApplication> {
  const moduleRef = await Test.createTestingModule({
    controllers: [LeaderMeetingsController],
    providers: [
      { provide: LeaderMeetingsService, useValue: forum.forum },
      { provide: LeaderMeetingMinutes, useValue: forum.minutes },
      { provide: LeaderMeetingSharing, useValue: forum.sharing },
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
