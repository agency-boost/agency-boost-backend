import { INestApplication } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { Test } from '@nestjs/testing';
import mongoose from 'mongoose';
import request from 'supertest';
import { PermissionsGuard } from '@/common/auth/permissions.guard';
import { RequestContext } from '@/common/context/request-context';
import { DomainExceptionFilter } from '@/common/errors/error.filter';
import { MembershipRepository } from '@/modules/org/membership.repository';
import { clearCollections, startMongo, stopMongo } from '../../../test/mongo';
import { configModule, provisionOffice } from '../../../test/config-module';
import {
  AAB, AB, ADMIN, AGENT, FIXTURE_KPM, OWNER, productionPipe, session, StubAuth, SUPER_ADMIN,
} from '../../../test/http-permissions';
import { listenOnLoopback } from '../../../test/listen';
import { TrainingController } from './training.controller';
import { materialItemOf, TrainingModuleFacts } from './training-module-facts';
import { TrainingProgressRepository } from './training-progress.repository';
import { TrainingService } from './training.service';

const NOW = new Date('2026-11-20T03:00:00Z');
const COMPANY = '66f0000000000000000000c1';
const OTHER_KPM = '66f0000000000000000000b2';
const URL = '/kpm/settings/training';
const PPTX = 'application/vnd.openxmlformats-officedocument.presentationml.presentation';

const member = (over: Record<string, unknown>) => ({
  membershipId: 'mem-a', kpmId: FIXTURE_KPM, orgLevelCode: 'AB', hierarchyRole: 'ab', status: 'active',
  isKpmOwner: false, isKpmAdmin: false, directCount: 0, ...over,
});
const CORE_LEADER = new RequestContext('u-core', 'none', member({ isCoreLeader: true }) as never);
const SUPER_ADMIN_INSIDE = RequestContext.superAdminInKpm(SUPER_ADMIN, FIXTURE_KPM);
const OTHER_OWNER = new RequestContext('u-other', 'none', member({ membershipId: 'mem-other', kpmId: OTHER_KPM, isKpmOwner: true }) as never);

const STEWARDS: [string, RequestContext][] = [
  ['the Owner', OWNER], ['an Admin', ADMIN], ['a core leader', CORE_LEADER], ['the Super Admin inside the KPM', SUPER_ADMIN_INSIDE],
];
const FIELD: [string, RequestContext][] = [['an AB', AB], ['an AAB', AAB], ['an agent', AGENT]];

type ModuleRow = {
  code: string; title: string; materialItem: unknown; completion: { done: number; started: number; of: number };
};
const modulesOf = (body: { skills: { modules: ModuleRow[] }[] }[]) => body.flatMap((c) => c.skills.flatMap((s) => s.modules));

/**
 * **Pengaturan › Training as one tree** (P19.25-T4, ADR-0282): what the settings read carries for each module's row —
 * *"n dari 30 selesai"* over the KPM's counted members (never a test account, never a leaver, never another KPM's), the
 * item named beside *Ganti* or `null` for *Unggah materi* — and a material in any format the owner named. Who may read
 * and write is the settings screens' own: the KPM's stewards, never a field member.
 */
describe('P19.25-T4 Pengaturan › Training as one tree', () => {
  let app: INestApplication;
  let wired: ReturnType<typeof configModule>;
  const db = () => mongoose.connection.db!;
  const http = () => request(app.getHttpServer());

  beforeAll(async () => {
    await startMongo();
    wired = configModule(NOW);
    const base = wired.training as unknown as Record<string, unknown>;
    const facts = new TrainingModuleFacts(
      wired.memberships as MembershipRepository, wired.trainingProgressRows as TrainingProgressRepository,
    );
    // The service the app builds: the harness's, with the facts the app module provides.
    const training = new TrainingService(
      base.categories as never, base.skills as never, base.modules as never, base.audit as never, base.clock as never,
      base.assets as never, base.kpms as never, facts,
    );
    const moduleRef = await Test.createTestingModule({
      controllers: [TrainingController],
      providers: [{ provide: TrainingService, useValue: training }],
    }).compile();
    app = moduleRef.createNestApplication();
    app.useGlobalPipes(productionPipe());
    app.useGlobalFilters(new DomainExceptionFilter());
    app.useGlobalGuards(new StubAuth(), new PermissionsGuard(app.get(Reflector)));
    await app.init();
    await listenOnLoopback(app);
  });

  afterAll(async () => {
    await app.close();
    await stopMongo();
  });

  let code: string;
  let other: string;

  beforeEach(async () => {
    session.current = OWNER;
    await clearCollections();
    for (const [kpmId, branch] of [[FIXTURE_KPM, 'A'], [OTHER_KPM, 'B']]) {
      await (wired.kpms as { create: (d: unknown) => Promise<unknown> }).create({
        _id: kpmId, companyId: COMPANY, code: kpmId.slice(-4), branchName: branch, timezone: 'Asia/Jakarta',
      });
      await provisionOffice(wired, kpmId, COMPANY);
    }
    const modules = modulesOf((await http().get(URL).expect(200)).body);
    code = modules[0].code;
    other = modules[1].code;
  });

  // A leader code each: another suite in the same worker may have built `memberships`' unique `leaderCode` index, which a
  // second row with none would collide on.
  const membership = (kpmId: string, over: Record<string, unknown> = {}) => {
    const _id = new mongoose.Types.ObjectId();
    return {
      _id, kpmId, userId: new mongoose.Types.ObjectId().toString(), leaderCode: `tt-${String(_id)}`, role: 'agent',
      orgLevelCode: 'AGENT', status: 'active', deletedAt: null, ...over,
    };
  };
  const progress = (kpmId: string, membershipId: unknown, moduleCode: string, status: string) => ({
    kpmId, membershipId: String(membershipId), moduleCode, status, startedAt: NOW,
    completedAt: status === 'done' ? NOW : null, opened: [], version: 1, deletedAt: null,
  });

  describe('AC-2 "n dari 30 selesai"', () => {
    it('P19.25-T4 AC-2 counts the KPM’s active members who marked it done, and who began it — never a test account or a leaver', async () => {
      const done = membership(FIXTURE_KPM);
      const begun = membership(FIXTURE_KPM);
      const idle = membership(FIXTURE_KPM);
      const tester = membership(FIXTURE_KPM, { testAccount: true });
      const leaver = membership(FIXTURE_KPM, { status: 'removed' });
      await db().collection('memberships').insertMany([done, begun, idle, tester, leaver]);
      await db().collection('trainingProgress').insertMany([
        progress(FIXTURE_KPM, done._id, code, 'done'),
        progress(FIXTURE_KPM, begun._id, code, 'in_progress'),
        progress(FIXTURE_KPM, idle._id, code, 'not_started'),
        progress(FIXTURE_KPM, tester._id, code, 'done'),
        progress(FIXTURE_KPM, leaver._id, code, 'done'),
      ]);

      const modules = modulesOf((await http().get(URL).expect(200)).body);
      expect(modules.find((m) => m.code === code)!.completion).toEqual({ done: 1, started: 2, of: 3 });
      // A module nobody touched: *Belum ada yang belajar*, over the same people.
      expect(modules.find((m) => m.code === other)!.completion).toEqual({ done: 0, started: 0, of: 3 });
    });

    it('P19.25-T4 AC-2 cross-tenant: another KPM’s members and rows move nothing, even filed with this KPM’s member ids', async () => {
      const mine = membership(FIXTURE_KPM);
      const theirs = membership(OTHER_KPM);
      await db().collection('memberships').insertMany([mine, theirs]);
      await db().collection('trainingProgress').insertMany([
        progress(OTHER_KPM, theirs._id, code, 'done'),
        // Planted: this KPM's member id under the other KPM — only the KPM filter keeps it out.
        progress(OTHER_KPM, mine._id, code, 'done'),
      ]);

      const here = modulesOf((await http().get(URL).expect(200)).body);
      expect(here.find((m) => m.code === code)!.completion).toEqual({ done: 0, started: 0, of: 1 });

      session.current = OTHER_OWNER;
      const there = modulesOf((await http().get(URL).expect(200)).body);
      expect(there.find((m) => m.code === code)!.completion).toEqual({ done: 1, started: 1, of: 1 });
    });
  });

  describe('AC-2 the file on the row, Ganti or Unggah materi', () => {
    it('P19.25-T4 AC-2 names the office’s file once it replaces the template’s, and null where there is none', async () => {
      const before = modulesOf((await http().get(URL).expect(200)).body).find((m) => m.code === code)!;
      // The template's material, or none: either way the row says which.
      expect(before.materialItem === null || typeof before.materialItem === 'object').toBe(true);

      const signed = await http().post(`${URL}/uploads`).send({ filename: 'Prospek_list.pptx', mimeType: PPTX, bytes: 2048 }).expect(201);
      const confirmed = await http().post(`${URL}/uploads/confirm`).send({ storageKey: signed.body.storageKey }).expect(201);
      await http().put(`${URL}/modules/${code}/content`).send({
        files: [{ label: 'Prospek_list.pptx', storageKey: confirmed.body.storageKey, mimeType: confirmed.body.mimeType, bytes: 2048 }],
      }).expect(200);
      await http().put(`${URL}/modules/${other}/content`).send({ files: [], videos: [], links: [] }).expect(200);

      const after = modulesOf((await http().get(URL).expect(200)).body);
      expect(after.find((m) => m.code === code)!.materialItem).toEqual({ label: 'Prospek_list.pptx', kind: 'file', mimeType: PPTX });
      expect(after.find((m) => m.code === other)!.materialItem).toBeNull();
    });

    it.each([
      ['a PowerPoint', 'deck.pptx', PPTX],
      ['an old PowerPoint', 'deck.ppt', 'application/vnd.ms-powerpoint'],
      ['a Word document', 'notes.docx', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'],
      ['an old Word document', 'notes.doc', 'application/msword'],
      ['a WebM video', 'clip.webm', 'video/webm'],
      ['a QuickTime video', 'clip.mov', 'video/quicktime'],
      ['a PDF', 'deck.pdf', 'application/pdf'],
    ])('P19.25-T4 AC-2 Unggah materi takes %s (any format, ADR-0282 §3)', async (_what, filename, mimeType) => {
      await http().post(`${URL}/uploads`).send({ filename, mimeType, bytes: 1024 }).expect(201);
    });

    it('P19.25-T4 AC-2 refuses a type that is no material — a program — before anything is signed', async () => {
      const res = await http().post(`${URL}/uploads`)
        .send({ filename: 'setup.exe', mimeType: 'application/x-msdownload', bytes: 1024 }).expect(400);
      expect(res.body.error.code).toBe('VALIDATION_FAILED');
    });
  });

  describe('who may reach it', () => {
    it.each(STEWARDS)('P19.25-T4 AC-1 shows %s the tree with each module’s figures', async (_who, who) => {
      session.current = who;
      const modules = modulesOf((await http().get(URL).expect(200)).body);
      expect(modules.length).toBeGreaterThan(0);
      for (const m of modules) expect(m.completion).toMatchObject({ done: expect.any(Number), of: expect.any(Number) });
    });

    it.each(STEWARDS)('P19.25-T4 AC-2 lets %s sign an upload', async (_who, who) => {
      session.current = who;
      await http().post(`${URL}/uploads`).send({ filename: 'deck.pptx', mimeType: PPTX, bytes: 1024 }).expect(201);
    });

    it.each(FIELD)('P19.25-T4 AC-1 refuses %s the tree and every upload', async (_who, who) => {
      session.current = who;
      expect((await http().get(URL).expect(403)).body.error.code).toBe('PERM_DENIED');
      await http().post(`${URL}/uploads`).send({ filename: 'deck.pptx', mimeType: PPTX, bytes: 1024 }).expect(403);
    });

    it('P19.25-T4 AC-1 refuses a Super Admin who has entered no KPM', async () => {
      session.current = SUPER_ADMIN;
      await http().get(URL).expect(403);
    });
  });
});

describe('P19.25-T4 AC-2 the item a row names (materialItemOf)', () => {
  const file = { id: 'f', label: 'Prospek_list.pdf', storageKey: 'k1', mimeType: 'application/pdf', bytes: 1 };
  const video = { id: 'v', label: 'Referral.mp4', storageKey: 'k2', mimeType: 'video/mp4', bytes: 1 };
  const link = { id: 'l', label: 'Panduan', url: 'https://example.com/' };

  it('P19.25-T4 AC-2 is the first file, else the first video, else the first link, else nothing', () => {
    expect(materialItemOf({ files: [file], videos: [video], links: [link] })).toEqual({ label: 'Prospek_list.pdf', kind: 'file', mimeType: 'application/pdf' });
    expect(materialItemOf({ files: [], videos: [video], links: [link] })).toEqual({ label: 'Referral.mp4', kind: 'video', mimeType: 'video/mp4' });
    expect(materialItemOf({ files: [], videos: [], links: [link] })).toEqual({ label: 'Panduan', kind: 'link', mimeType: null });
    expect(materialItemOf({ files: [], videos: [], links: [] })).toBeNull();
  });
});
