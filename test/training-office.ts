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
import { ActivationProgressController } from '@/modules/activation/activation-progress.controller';
import { ActivationProgressService } from '@/modules/activation/activation-progress.service';
import { ActivationItemRecords } from '@/modules/activation/activation-records.service';
import type { ActivationProgressDocument } from '@/modules/activation/activation-progress.schema';
import { freshItemState } from '@/modules/activation/activation-rules';
import { NewHiresController } from '@/modules/activation/new-hires.controller';
import { NewHiresService } from '@/modules/activation/new-hires.service';
import { TrainingProgressController } from '@/modules/training/training-progress.controller';
import { TrainingProgressService } from '@/modules/training/training-progress.service';
import { TrainingController } from '@/modules/training/training.controller';
import { TrainingService } from '@/modules/training/training.service';
import { configModule, provisionOffice } from './config-module';
import {
  buildCoachingOffice, COMPANY, KPM_A, KPM_B, ROSTER_NOW, ROSTER_TODAY, type CoachingOffice, type Who,
} from './coaching-office';
import { NO_CLASS, productionPipe, session, StubAuth } from './http-permissions';
import { listenOnLoopback } from './listen';
import { clearCollections, startMongo, stopMongo } from './mongo';

/**
 * **The training office, over HTTP** (P18.5-T1 to T4): `test/coaching-office.ts`'s people behind the real
 * `PermissionsGuard`, the production pipe and the real services — the learner's routes, the settings reads, and
 * the activation routes a training-linked item is read and ticked through.
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
 * Both offices hold the seeded taxonomy — six categories, Sales's six skills and ten published modules — and
 * **both have published it** (`publish`), so what is offered is the snapshot's, as in a real office. Office A's
 * *Building Your Prospect List* carries the company's material: one confirmed PDF and one `https` link
 * (`COMPANY_FILE`, `COMPANY_LINK`); *Referral Generation Techniques* one file whose upload never finished.
 */
export const TODAY = ROSTER_TODAY;
export const COMPANY_FILE = { id: '01JTRAININGFILE00000000000', storageKey: 'company/training/prospect-list.pdf' };
export const COMPANY_LINK = { id: '01JTRAININGLINK00000000000', url: 'https://learn.example.com/prospect-list' };
export const UNCONFIRMED_FILE = { id: '01JTRAININGPEND00000000000', storageKey: 'company/training/referrals.pdf' };

export interface TrainingHarness {
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
  /** Publish `kpmId`'s working copy, as its Owner presses *Publish to agents*. */
  publish: (kpmId?: string) => Promise<void>;
  /** A live module row of an office, by code. */
  moduleRow: (code: string, kpmId?: string) => Promise<{ id: string; version: number }>;
  /** Start `who`'s activation on `startDate`, pinned to their office's version 1, every item fresh. */
  start: (who: Who, startDate: LocalDate) => Promise<ActivationProgressDocument>;
  /** Bind one item of the activation's pinned version to a link, as an office's version that bound it would. */
  bind: (doc: ActivationProgressDocument, itemCode: string, link: string | null) => Promise<void>;
  /** Empty the progress, the activations and the audit log, put the clock back and the taxonomy as provisioned. */
  reset: () => Promise<void>;
}

export async function startTrainingHarness(): Promise<TrainingHarness> {
  await startMongo();
  const wired = configModule(ROSTER_NOW);
  await clearCollections();
  const office = await buildCoachingOffice(wired);
  await provisionOffice(wired, KPM_B, COMPANY);
  await Promise.all(mongoose.modelNames().map((name) => mongoose.model(name).init()));

  const moduleRef = await Test.createTestingModule({
    controllers: [TrainingProgressController, TrainingController, ActivationProgressController, NewHiresController],
    providers: [
      { provide: TrainingProgressService, useValue: wired.trainingProgress },
      { provide: TrainingService, useValue: wired.training },
      { provide: ActivationProgressService, useValue: wired.activationProgress },
      { provide: NewHiresService, useValue: wired.newHires },
      { provide: ActivationItemRecords, useValue: wired.activationRecords },
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
  const ownerOf = (kpmId: string) => office.as(kpmId === KPM_B ? 'B_AB' : 'OWNER');
  const publish = async (kpmId = KPM_A) => { await wired.config.publish(ownerOf(kpmId)); };

  // The company's material for one module, by reference, as provisioning gives it (ADR-0032).
  const material = async () => {
    await col('assets').deleteMany({ companyId: COMPANY });
    await col('assets').insertMany([
      {
        kpmId: null, companyId: COMPANY, storageKey: COMPANY_FILE.storageKey, mimeType: 'application/pdf', bytes: 2048,
        originalFilename: 'prospect-list.pdf', uploadedByMembershipId: null, refCount: 2, uploadState: 'confirmed',
        deletedAt: null, createdAt: ROSTER_NOW, updatedAt: ROSTER_NOW,
      },
      {
        kpmId: null, companyId: COMPANY, storageKey: UNCONFIRMED_FILE.storageKey, mimeType: 'application/pdf', bytes: 2048,
        originalFilename: 'referrals.pdf', uploadedByMembershipId: null, refCount: 1, uploadState: 'pending',
        deletedAt: null, createdAt: ROSTER_NOW, updatedAt: ROSTER_NOW,
      },
    ]);
    for (const kpmId of [KPM_A, KPM_B]) {
      await col('trainingModules').updateOne({ kpmId, code: 'PROSPECT_LIST' }, {
        $set: {
          officeContent: null,
          companyContent: {
            files: [{ id: COMPANY_FILE.id, label: 'Prospect list worksheet.pdf', storageKey: COMPANY_FILE.storageKey, mimeType: 'application/pdf', bytes: 2048 }],
            videos: [],
            links: [{ id: COMPANY_LINK.id, label: 'The prospecting talk', url: COMPANY_LINK.url }],
          },
        },
      });
      await col('trainingModules').updateOne({ kpmId, code: 'REFERRAL_GENERATION' }, {
        $set: {
          officeContent: null,
          companyContent: {
            files: [{ id: UNCONFIRMED_FILE.id, label: 'Referrals.pdf', storageKey: UNCONFIRMED_FILE.storageKey, mimeType: 'application/pdf', bytes: 2048 }],
            videos: [],
            links: [],
          },
        },
      });
    }
  };

  // The taxonomy as provisioning left it, so a spec that archived or drafted a module leaves nothing behind.
  const provisioned = await col('trainingModules').find({}).toArray();
  const provisionedSkills = await col('trainingSkills').find({}).toArray();
  const provisionedCategories = await col('trainingCategories').find({}).toArray();

  const harness: TrainingHarness = {
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
    publish,
    moduleRow: async (code, kpmId = KPM_A) => {
      const row = (await col('trainingModules').findOne({ kpmId, code }))!;
      return { id: String(row._id), version: row.version as number };
    },
    start: async (who, startDate) => {
      const ctx = office.as(who);
      const version = (await wired.activation.findVersion(RequestContext.forJob(ctx.kpmId!, 'training-harness'), 1))!;
      return wired.activationRows.create(RequestContext.forJob(ctx.kpmId!, 'training-harness'), {
        membershipId: office.id[who],
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
      } as never);
    },
    bind: async (doc, itemCode, link) => {
      await col('activationTemplates').updateOne(
        { _id: new mongoose.Types.ObjectId(doc.templateId) },
        { $set: { 'aspects.$[].items.$[i].autoLink': link } },
        { arrayFilters: [{ 'i.code': itemCode }] },
      );
    },
    reset: async () => {
      clock.set(ROSTER_NOW);
      await col('trainingProgress').deleteMany({});
      await col('activationProgress').deleteMany({});
      await col('auditLog').deleteMany({});
      await col('configSnapshots').deleteMany({});
      for (const [name, rows] of [
        ['trainingModules', provisioned], ['trainingSkills', provisionedSkills], ['trainingCategories', provisionedCategories],
      ] as const) {
        await col(name).deleteMany({});
        await col(name).insertMany(rows.map((r) => ({ ...r })));
      }
      // Version 1 binds nothing to training, as the seed's does.
      await col('activationTemplates').updateMany(
        { 'aspects.items.code': 'MANDATORY_TRAINING' },
        { $set: { 'aspects.$[].items.$[i].autoLink': null } },
        { arrayFilters: [{ 'i.code': 'MANDATORY_TRAINING' }] },
      );
      await material();
      await publish(KPM_A);
      await publish(KPM_B);
      session.current = office.as('RINA');
    },
  };
  return harness;
}

export async function stopTrainingHarness(harness: TrainingHarness | undefined): Promise<void> {
  await harness?.app.close();
  await stopMongo();
}

export { KPM_A, KPM_B, ROSTER_NOW, type Who };
