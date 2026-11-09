import { INestApplication } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Reflector } from '@nestjs/core';
import { getModelToken } from '@nestjs/mongoose';
import { Test } from '@nestjs/testing';
import mongoose from 'mongoose';
import request from 'supertest';
import { PermissionsGuard } from '@/common/auth/permissions.guard';
import { FixedClock } from '@/common/clock/clock.port';
import { RequestContext } from '@/common/context/request-context';
import { DomainExceptionFilter } from '@/common/errors/error.filter';
import type { LocalDate } from '@/common/time/local-day';
import { ActivationProgressController } from '@/modules/activation/activation-progress.controller';
import { ActivationProgressService } from '@/modules/activation/activation-progress.service';
import { ActivationItemRecords } from '@/modules/activation/activation-records.service';
import type { ActivationProgressDocument } from '@/modules/activation/activation-progress.schema';
import { ActivationNav } from '@/modules/activation/activation-nav.port';
import { freshItemState } from '@/modules/activation/activation-rules';
import { NewHiresController } from '@/modules/activation/new-hires.controller';
import { NewHiresService } from '@/modules/activation/new-hires.service';
import { ActivityController } from '@/modules/activity/activity.controller';
import { ActivityService } from '@/modules/activity/activity.service';
import { AuthController } from '@/modules/auth/auth.controller';
import { AuthService } from '@/modules/auth/auth.service';
import { RateLimiter } from '@/modules/auth/rate-limiter';
import { GoalController } from '@/modules/goals/goal.controller';
import { GoalService } from '@/modules/goals/goal.service';
import { LeadController } from '@/modules/leads/lead.controller';
import { LeadService } from '@/modules/leads/lead.service';
import { MembershipRepository } from '@/modules/org/membership.repository';
import { User } from '@/modules/users/user.schema';
import { configModule, provisionOffice } from './config-module';
import {
  buildCoachingOffice, COMPANY, KPM_A, KPM_B, ROSTER_NOW, writtenMonthRows, type CoachingOffice, type Who,
} from './coaching-office';
import { NO_CLASS, productionPipe, session, StubAuth } from './http-permissions';
import { listenOnLoopback } from './listen';
import { clearCollections, startMongo, stopMongo } from './mongo';

/**
 * **The activation's office, over HTTP** (Phase 13): `test/coaching-office.ts`'s people behind the real
 * `PermissionsGuard`, the production pipe and the real services — the activation's two controllers, the
 * three that complete its linked items (goals, leads, activity), and `GET /auth/me` for the nav's facts.
 *
 * ```
 * OWNER Wilson (AB, the Owner) ─┬── ADMIN Maya (AB, the Admin, leads nobody)
 *                               ├── AGUS ─┬── INDAH, DIMAS
 *                               │         ├── SARI (AAB) ─┬── RINA, BUDI
 *                               │         │               └── NINA (AAB) ── DODI
 *                               │         ├── DEWI (AAB, leads nobody) · LUKAS (an Agent who leads) ── TARI
 *                               │         └── LEFT (removed)
 *                               └── PEER_AB ── PEER_AAB ── PEER_AGENT
 * Office B: B_AB ── B_AGENT
 * ```
 *
 * The clock is `ROSTER_NOW`, **10:00 on Monday 14 September 2026 in Jakarta**. Everybody joined on
 * 2 January, so nobody's activation would still be open from their join date: a spec starts the ones it
 * needs with `start(who, startDate)`. Both offices hold the seeded checklist, published as version 1.
 */
export const TODAY = '2026-09-14';

export interface ActivationHarness {
  app: INestApplication;
  wired: ReturnType<typeof configModule>;
  office: CoachingOffice;
  clock: FixedClock;
  http: () => ReturnType<typeof request>;
  /** Sign in as somebody of the office, or as a context built for the case. */
  as: (who: Who | RequestContext) => void;
  id: (who: Who) => string;
  col: (name: string) => mongoose.mongo.Collection;
  /** A context as `who`, standing on no rung the matrix names: an Owner or an Admin with no field role. */
  officeOnly: (who: Who) => RequestContext;
  /** A support session as `who`, read-only unless `readOnly` is false. */
  supporting: (who: Who, readOnly?: boolean) => RequestContext;
  /**
   * Start `who`'s activation on `startDate`, pinned to their office's version 1, every item fresh — and make them
   * the new hire a placement makes them, joined that day (ADR-0169 §2: the start is the join date).
   */
  start: (who: Who, startDate: LocalDate, over?: Record<string, unknown>) => Promise<ActivationProgressDocument>;
  /** Empty the activations, the audit log and the records that complete items, and put the clock back. */
  reset: () => Promise<void>;
}

export async function startActivationHarness(): Promise<ActivationHarness> {
  await startMongo();
  const wired = configModule(ROSTER_NOW);
  await clearCollections();
  const office = await buildCoachingOffice(wired);
  await provisionOffice(wired, KPM_B, COMPANY);
  await Promise.all(mongoose.modelNames().map((name) => mongoose.model(name).init()));

  const moduleRef = await Test.createTestingModule({
    controllers: [
      ActivationProgressController, NewHiresController, GoalController, LeadController, ActivityController,
      AuthController,
    ],
    providers: [
      { provide: ActivationProgressService, useValue: wired.activationProgress },
      { provide: NewHiresService, useValue: wired.newHires },
      // P18.8-T4: a data-backed item's tick, with its record.
      { provide: ActivationItemRecords, useValue: wired.activationRecords },
      { provide: GoalService, useValue: wired.goals },
      { provide: LeadService, useValue: wired.leadRecords },
      { provide: ActivityService, useValue: wired.activityLogs },
      // `GET /auth/me` alone is exercised: the rest of the controller's collaborators are never called.
      { provide: AuthService, useValue: {} },
      { provide: RateLimiter, useValue: {} },
      { provide: ConfigService, useValue: { get: () => undefined } },
      { provide: getModelToken(User.name), useValue: { findOne: () => ({ exec: async () => null }) } },
      // `/auth/me` reads the membership's work status (ADR-0158 §1).
      { provide: MembershipRepository, useValue: wired.memberships },
      { provide: ActivationNav, useValue: wired.activationProgress },
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
  // P18.8-T4: what the office was built with, so a spec's own coaching sessions can go and the fixture's stay.
  const builtAt = new Date();
  const versionOne = new Map<string, Awaited<ReturnType<typeof wired.activation.publishedNow>>>();
  for (const kpmId of [KPM_A, KPM_B]) {
    versionOne.set(kpmId, await wired.activation.findVersion(RequestContext.forJob(kpmId, 'activation-harness'), 1));
  }

  return {
    app, wired, office, clock,
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
    start: async (who, startDate, over = {}) => {
      const ctx = office.as(who);
      const version = versionOne.get(ctx.kpmId!)!;
      await col('memberships').updateOne(
        { _id: new mongoose.Types.ObjectId(office.id[who]), kpmId: ctx.kpmId },
        { $set: { joinDate: startDate, joinedAs: 'new_hire' } },
      );
      return wired.activationRows.create(RequestContext.forJob(ctx.kpmId!, 'activation-harness'), {
        membershipId: office.id[who],
        templateId: version!.id,
        templateVersion: version!.version,
        startDate,
        startCorrectedAt: null,
        startCorrectedByMembershipId: null,
        origin: 'joined',
        items: version!.aspects.flatMap((a) => a.items).map((i) => freshItemState(i.code)),
        note: null,
        graduatedAt: null,
        graduatedByMembershipId: null,
        version: 1,
        ...over,
      } as never);
    },
    reset: async () => {
      clock.set(ROSTER_NOW);
      /*
       * P18.8-T6: *Mark left* removes a new hire (ADR-0169 §4 as amended), so whoever a spec marked is put back as built —
       * active, their `joined` edge open again, the `removed` event their leaving opened gone.
       */
      const marked = (await col('memberships').find({ leftAt: { $ne: null } }).toArray()).map((m) => String(m._id));
      if (marked.length > 0) {
        await col('memberships').updateMany({ _id: { $in: marked.map((x) => new mongoose.Types.ObjectId(x)) } }, {
          $set: { status: 'active', removedAt: null },
        });
        await col('membershipHistory').deleteMany({ membershipId: { $in: marked }, eventType: 'removed' });
        await col('membershipHistory').updateMany({ membershipId: { $in: marked } }, { $set: { validTo: null } });
      }
      await col('activationProgress').deleteMany({});
      // The office's people as built: joined on 2 January, before join dates were written (`start` gives one).
      await col('memberships').updateMany({}, {
        $unset: {
          joinDate: '', joinedAs: '',
          // P18.8-T4: nobody's first sale but what a spec writes.
          firstSaleDate: '', firstSaleSource: '', firstSaleRecordCollection: '', firstSaleRecordId: '',
          // P18.8-T6: nobody has left, and no 3M result is kept.
          leftAt: '', activation3M: '', activation3MLockedAt: '',
        },
      });
      // P18.8-T4: the sessions and the file's policies a spec wrote go; the fixture's months and 1:1s stay.
      await col('coachingSessions').deleteMany({ createdAt: { $gt: builtAt } });
      await col('monthlyAgentData').deleteMany({ agentCode: { $nin: ['INDAH', 'DIMAS', 'RINA', 'SARI'] } });
      await col('monthlyAgentData').updateMany({}, { $unset: { 'values.POLICY_COUNT': '' } });
      // P19.5-T2: the months a spec reopened or wrote go back to how the fixture's upload left them.
      await col('productionMonths').deleteMany({});
      await col('productionMonths').insertMany(writtenMonthRows());
      await col('auditLog').deleteMany({});
      await col('leads').deleteMany({});
      // The coaching office's own goals and fortnight of log — Indah's, Dimas's and Rina's — stay; specs
      // write only for the others, and what they wrote goes.
      const kept = { $nin: (['INDAH', 'DIMAS', 'RINA'] as const).map((who) => office.id[who]) };
      await col('goals').deleteMany({ membershipId: kept });
      await col('activityLogs').deleteMany({ membershipId: kept });
      session.current = office.as('AGUS');
    },
  };
}

export async function stopActivationHarness(harness: ActivationHarness | undefined): Promise<void> {
  await harness?.app.close();
  await stopMongo();
}

export { KPM_A, KPM_B, ROSTER_NOW, type Who };
