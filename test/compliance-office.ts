import { INestApplication } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { Test } from '@nestjs/testing';
import mongoose from 'mongoose';
import request from 'supertest';
import { PermissionsGuard } from '@/common/auth/permissions.guard';
import { FixedClock } from '@/common/clock/clock.port';
import { RequestContext } from '@/common/context/request-context';
import { DomainExceptionFilter } from '@/common/errors/error.filter';
import type { LocalDate } from '@/common/time/local-day';
import { ActivationReadings } from '@/modules/activation/activation-readings';
import type { ActivationProgressDocument } from '@/modules/activation/activation-progress.schema';
import { freshItemState } from '@/modules/activation/activation-rules';
import { NewHiresController } from '@/modules/activation/new-hires.controller';
import { NewHiresService } from '@/modules/activation/new-hires.service';
import { MemberNames } from '@/modules/org/member-names.service';
import { ActivationComplianceCategory } from '@/modules/reporting/compliance/activation.category';
import { ActivityComplianceCategory } from '@/modules/reporting/compliance/activity.category';
import { CampaignsComplianceCategory } from '@/modules/reporting/compliance/campaigns.category';
import { ComplianceController } from '@/modules/reporting/compliance/compliance.controller';
import { ComplianceService } from '@/modules/reporting/compliance/compliance.service';
import { EventsComplianceCategory } from '@/modules/reporting/compliance/events.category';
import { GoalsComplianceCategory } from '@/modules/reporting/compliance/goals.category';
import { TrainingComplianceCategory } from '@/modules/reporting/compliance/training.category';
import { TenantDay } from '@/modules/tenants/tenant-day.service';
import { configModule } from './config-module';
import { COMPANY, KPM_A, KPM_B, ROSTER_NOW, ROSTER_TODAY, type Who } from './coaching-office';
import { NO_CLASS, productionPipe, session, StubAuth } from './http-permissions';
import { listenOnLoopback } from './listen';
import { clearCollections, startMongo, stopMongo } from './mongo';
import { buildReportingOffice, type ReportingOffice } from './reporting-office';

/**
 * **The Owner's compliance tree, wired** (P18.6-T1): `test/reporting-office.ts`'s 0417 and 0555 — both offices'
 * configuration provisioned and **published**, so what is offered is the snapshot's — plus **one unplaced member**
 * of 0417, Oscar (an Agent under no AB: in the Overview's figures, in no row and no chip of the tree), and the tree's
 * service built over the real readers. The routes behind the real `PermissionsGuard` and the production pipe:
 * `GET /kpm/analytics/compliance`, and the leader's `GET /new-hires` and `GET /new-hires/:membershipId` (OD-158).
 *
 * ```
 * OWNER Wilson (AB, the Owner) ─┬── ADMIN Maya (AB, the Admin, leads nobody)
 *                               ├── AGUS ─┬── INDAH, DIMAS, DEWI (AAB, leads nobody), LUKAS ── TARI
 *                               │         ├── SARI (AAB) ─┬── RINA, BUDI
 *                               │         │               └── NINA (AAB) ── DODI
 *                               │         └── LEFT (removed)
 *                               └── PEER_AB ── PEER_AAB ── PEER_AGENT
 * ORPHAN Oscar (Agent, no leader: unplaced)
 * Office B: B_AB ── B_AGENT
 * ```
 *
 * The clock is `ROSTER_NOW`, 10:00 on Monday 14 September 2026 in Jakarta. Specs add the records they read.
 */
export const TODAY = ROSTER_TODAY;
const M = 1_000_000 * 100;

export type ComplianceWho = Who | 'ORPHAN';

export interface ComplianceHarness {
  app: INestApplication;
  wired: ReturnType<typeof configModule>;
  office: ReportingOffice;
  clock: FixedClock;
  compliance: ComplianceService;
  activationReadings: ActivationReadings;
  http: () => ReturnType<typeof request>;
  /** Sign in as somebody of either office, or as a context built for the case. */
  as: (who: ComplianceWho | RequestContext) => void;
  ctx: (who: ComplianceWho) => RequestContext;
  id: (who: ComplianceWho) => string;
  col: (name: string) => mongoose.mongo.Collection;
  /** 0555's Owner: its root AB, made its Owner. */
  ownerOfB: () => RequestContext;
  /** A context as `who`, standing on no rung the matrix names: an Owner or an Admin with no field role. */
  officeOnly: (who: Who) => RequestContext;
  /** A support session as `who`, read-only unless `readOnly` is false. */
  supporting: (who: Who, readOnly?: boolean) => RequestContext;
  /** Start `who`'s activation on `startDate`, pinned to their office's version 1, every item fresh. */
  start: (who: ComplianceWho, startDate: LocalDate, over?: Record<string, unknown>) => Promise<ActivationProgressDocument>;
  /** A training progress row, written as the learner's toggle leaves it. */
  progress: (who: ComplianceWho, moduleCode: string, status: 'done' | 'in_progress', completedAt?: Date) => Promise<void>;
  /** Every offered module code of 0417, in the snapshot's order. */
  sales: string[];
  /** Publish an office's working copy, as its Owner does. */
  publish: (kpmId?: string) => Promise<void>;
}

export async function startComplianceHarness(): Promise<ComplianceHarness> {
  await startMongo();
  const wired = configModule(ROSTER_NOW);
  await clearCollections();
  const office = await buildReportingOffice(wired);
  const db = mongoose.connection.db!;

  // 0555's configuration, as provisioning gives one (its lead pipelines the reporting office already seeded).
  const seeded = await wired.provisioning.seedActivityTaxonomy(KPM_B);
  await wired.provisioning.seedRatioDefinitions(KPM_B, seeded.typeCodes);
  const training = await wired.provisioning.seedTrainingTaxonomy(KPM_B);
  await wired.provisioning.seedActivationChecklist(KPM_B, training.publishedModuleCodes);
  await wired.provisioning.seedEventTypes(KPM_B);
  await wired.provisioning.seedCapabilityCatalog(KPM_B);

  // Oscar: an active Agent of 0417 under nobody — in the Overview's figures, placed in no AB agency.
  const orphanUser = new mongoose.Types.ObjectId();
  const orphan = new mongoose.Types.ObjectId();
  await db.collection('users').insertOne({
    _id: orphanUser, email: 'orphan@compliance.test', passwordHash: 'x', fullName: 'Oscar Yatim', status: 'active',
    platformRole: 'none', companyId: COMPANY, deletedAt: null,
  });
  await db.collection('memberships').insertOne({
    _id: orphan, kpmId: KPM_A, userId: String(orphanUser), agentCode: 'PRU-79999', agentSeq: 9999, leaderCode: 'LORPHAN',
    orgLevelId: new mongoose.Types.ObjectId().toString(), orgLevelCode: 'AGENT', role: 'agent', leaderId: null,
    ancestorIds: [], depth: 0, directCounts: { total: 0 }, subtreeCount: 0, status: 'active',
    joinedAt: new Date('2026-01-02T02:00:00Z'), deletedAt: null,
  });
  await Promise.all(mongoose.modelNames().map((name) => mongoose.model(name).init()));

  const clock = wired.clock as FixedClock;
  const ownerOfB = office.ownerOfB;
  const publish = async (kpmId = KPM_A) => { await wired.config.publish(kpmId === KPM_B ? ownerOfB() : office.as('OWNER')); };
  await publish(KPM_A);
  await publish(KPM_B);

  const activationReadings = new ActivationReadings(wired.activationRows, wired.activationProgress, wired.clock);
  const compliance = new ComplianceService(
    wired.officePeople, new TenantDay(wired.kpms as never, wired.clock), wired.clock, wired.subjectReads,
    new TrainingComplianceCategory(wired.offeredTraining, wired.trainingReadings, wired.clock),
    new GoalsComplianceCategory(wired.goals, wired.clock),
    new ActivityComplianceCategory(wired.activityReadings),
    new ActivationComplianceCategory(activationReadings),
    // P18.6-T2's two (BE-ec), over the readers their contract names.
    new EventsComplianceCategory(wired.eventReadings),
    new CampaignsComplianceCategory(wired.campaignStandingsReader, new MemberNames(wired.memberships, wired.users as never)),
  );

  const moduleRef = await Test.createTestingModule({
    controllers: [ComplianceController, NewHiresController],
    providers: [
      { provide: ComplianceService, useValue: compliance },
      { provide: NewHiresService, useValue: wired.newHires },
    ],
  }).compile();
  const app = moduleRef.createNestApplication();
  app.useGlobalPipes(productionPipe());
  app.useGlobalFilters(new DomainExceptionFilter());
  app.useGlobalGuards(new StubAuth(), new PermissionsGuard(app.get(Reflector)));
  await app.init();
  await listenOnLoopback(app);

  const id = (who: ComplianceWho) => (who === 'ORPHAN' ? String(orphan) : office.id[who]);
  const ctx = (who: ComplianceWho) => (who === 'ORPHAN'
    ? new RequestContext(String(orphanUser), 'none', {
      membershipId: String(orphan), kpmId: KPM_A, orgLevelCode: 'AGENT', hierarchyRole: 'agent', status: 'active',
      isKpmOwner: false, isKpmAdmin: false, directCount: 0,
    } as never)
    : office.as(who));
  const kpmOf = (who: ComplianceWho) => ctx(who).kpmId!;
  const sales = (await wired.offeredTraining.tree(office.as('OWNER')))
    .flatMap((c) => c.skills.flatMap((s) => s.modules.map((m) => m.code)));

  return {
    app, wired, office, clock, compliance, activationReadings,
    http: () => request(app.getHttpServer()),
    as: (who) => { session.current = typeof who === 'string' ? ctx(who) : who; },
    ctx,
    id,
    col: (name) => db.collection(name),
    ownerOfB,
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
      const job = RequestContext.forJob(kpmOf(who), 'compliance-harness');
      const version = (await wired.activation.findVersion(job, 1))!;
      // P18.96-T6: the new hire a placement makes them, joined that day (ADR-0169 §2), as `/new-hires` lists them.
      await db.collection('memberships').updateOne(
        { _id: new mongoose.Types.ObjectId(id(who)), kpmId: kpmOf(who) }, { $set: { joinDate: startDate, joinedAs: 'new_hire' } },
      );
      return wired.activationRows.create(job, {
        membershipId: id(who),
        templateId: version.id,
        templateVersion: version.version,
        startDate,
        startCorrectedAt: null,
        startCorrectedByMembershipId: null,
        origin: 'joined',
        items: version.aspects.flatMap((a) => a.items).map((i) => freshItemState(i.code)),
        note: null,
        graduatedAt: null,
        graduatedByMembershipId: null,
        version: 1,
        ...over,
      } as never);
    },
    progress: async (who, moduleCode, status, completedAt = ROSTER_NOW) => {
      await db.collection('trainingProgress').insertOne({
        kpmId: kpmOf(who), membershipId: id(who), moduleCode, status, startedAt: new Date('2026-09-01T03:00:00Z'),
        completedAt: status === 'done' ? completedAt : null, opened: [], version: 1, deletedAt: null,
        createdBy: id(who), updatedBy: id(who), createdAt: ROSTER_NOW, updatedAt: ROSTER_NOW,
      });
    },
    sales,
    publish,
  };
}

/**
 * **The records the tree reads** — written once, after the harness is up:
 *
 * | Who | Training (`PROSPECT_LIST`) | Goal 2026 | Last logged | Activation |
 * |---|---|---|---|---|
 * | INDAH | every module *Done* (14 Sep) | set | 10 Sep | — |
 * | DIMAS | *In progress* | set | 10 Sep | — |
 * | RINA | *Done* at 23:59 on 10 Sep | set | 14 Sep | open, from 1 Aug |
 * | BUDI | *Done* at 00:01 on 11 Sep | — | — | open, from 1 May: overdue |
 * | SARI | — | saved with a zero target: not set | — | — |
 * | DODI | — | — | — | graduated 20 May |
 * | TARI | — | — | — | expired: started 2 Jan, ended 2 Jul |
 * | PEER_AAB | — | — | 8 Sep: the window's first day | — |
 * | PEER_AGENT | — | — | 7 Sep: a day before it | open, from today |
 * | ORPHAN (unplaced) | every module *Done* | set | 12 Sep | graduated |
 *
 * Indah's, Dimas's and Rina's goals and logging are the coaching office's own.
 */
export async function seedTreeRecords(h: ComplianceHarness): Promise<void> {
  for (const code of h.sales) await h.progress('INDAH', code, 'done');
  for (const code of h.sales) await h.progress('ORPHAN', code, 'done');
  await h.progress('RINA', 'PROSPECT_LIST', 'done', new Date('2026-09-10T16:59:00Z'));
  await h.progress('BUDI', 'PROSPECT_LIST', 'done', new Date('2026-09-10T17:01:00Z'));
  await h.progress('DIMAS', 'PROSPECT_LIST', 'in_progress');

  const goal = (who: ComplianceWho, annualApeTargetMinor: number) => ({
    kpmId: KPM_A, membershipId: h.id(who), period: '2026', mode: 'direct', annualApeTargetMinor, savingsTargetMinor: 0,
    commissionRatePct: 0, monthsLeftOverride: null, apeAchievedMinor: 0, caseSizeMinor: 18 * M, leadsToApptPct: 30,
    closingRatePct: 30, savedAt: new Date('2026-02-03T17:30:00Z'), savedByMembershipId: h.id(who), version: 1, deletedAt: null,
    cascadeMapping: { leadsCode: 'LEADS_CONTACTED', appointmentsCode: 'SELL_PRESENTATION', closingsCode: 'SELL_SUBMISSION' },
    revisions: [],
  });
  await h.col('goals').insertMany([goal('SARI', 0), goal('ORPHAN', 400 * M)]);

  const day = (who: ComplianceWho, localDate: string) => ({
    kpmId: KPM_A, membershipId: h.id(who), localDate, entries: [], totalCount: 0, source: 'self',
    enteredByMembershipId: h.id(who), version: 1, frozenAt: null, corrections: [], deletedAt: null,
  });
  await h.col('activityLogs').insertMany([day('ORPHAN', '2026-09-12'), day('PEER_AAB', '2026-09-08'), day('PEER_AGENT', '2026-09-07')]);

  await h.start('RINA', '2026-08-01');
  await h.start('BUDI', '2026-05-01');
  await h.start('DODI', '2026-03-01', { graduatedAt: new Date('2026-05-20T03:00:00Z'), graduatedByMembershipId: h.id('DODI') });
  await h.start('TARI', '2026-01-02');
  await h.start('PEER_AGENT', TODAY);
  await h.start('ORPHAN', '2026-03-01', { graduatedAt: new Date('2026-05-21T03:00:00Z'), graduatedByMembershipId: h.id('ORPHAN') });
}

/** Every member the tree lists: 0417's sixteen active members — Oscar, unplaced, is in none. */
export const LISTED: readonly ComplianceWho[] = [
  'OWNER', 'ADMIN', 'AGUS', 'INDAH', 'DIMAS', 'SARI', 'RINA', 'BUDI', 'NINA', 'DODI', 'DEWI', 'LUKAS', 'TARI',
  'PEER_AB', 'PEER_AAB', 'PEER_AGENT',
];

export async function stopComplianceHarness(harness: ComplianceHarness | undefined): Promise<void> {
  await harness?.app.close();
  await stopMongo();
}

export { KPM_A, KPM_B, ROSTER_NOW, type Who };
