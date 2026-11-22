import { INestApplication } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { Test } from '@nestjs/testing';
import mongoose from 'mongoose';
import request from 'supertest';
import { PermissionsGuard } from '@/common/auth/permissions.guard';
import { RequestContext } from '@/common/context/request-context';
import { DomainExceptionFilter } from '@/common/errors/error.filter';
import { clearCollections, startMongo, stopMongo } from '../../../test/mongo';
import { configModule, provisionOffice } from '../../../test/config-module';
import {
  AAB, AB, ADMIN, AGENT, FIXTURE_KPM, OWNER, productionPipe, session, StubAuth, SUPER_ADMIN,
} from '../../../test/http-permissions';
import { listenOnLoopback } from '../../../test/listen';
import { IN_INDONESIAN } from '../../../test/i18n';
import { CapabilityController } from './capability.controller';
import { CapabilityService } from './capability.service';

const NOW = new Date('2026-11-20T03:00:00Z');
const COMPANY = '66f0000000000000000000c1';
const OTHER_KPM = '66f0000000000000000000b2';
const URL = '/kpm/settings/capability-mapping';

const member = (over: Record<string, unknown>) => ({
  membershipId: 'mem-a', kpmId: FIXTURE_KPM, orgLevelCode: 'AB', hierarchyRole: 'ab', status: 'active',
  isKpmOwner: false, isKpmAdmin: false, directCount: 0, ...over,
});
const CORE_LEADER = new RequestContext('u-core', 'none', member({ membershipId: 'mem-core', isCoreLeader: true }) as never);
const SUPER_ADMIN_INSIDE = RequestContext.superAdminInKpm(SUPER_ADMIN, FIXTURE_KPM);
const OTHER_OWNER = new RequestContext('u-other', 'none', member({ membershipId: 'mem-other', kpmId: OTHER_KPM, isKpmOwner: true }) as never);
const READ_ONLY_OWNER = new RequestContext('u-owner', 'none', member({ isKpmOwner: true }) as never, 'root', null, false, true);

const WRITERS: [string, RequestContext][] = [
  ['the Owner', OWNER], ['an Admin', ADMIN], ['a core leader', CORE_LEADER], ['the Super Admin inside the KPM', SUPER_ADMIN_INSIDE],
];
const NOT_WRITERS: [string, RequestContext][] = [
  ['an AB', AB], ['an AAB', AAB], ['an agent', AGENT], ['a read-only support session as the Owner', READ_ONLY_OWNER],
];

/**
 * **P19.21-T3 AC-4 — Capability Mapping as two cards** (ADR-0274): the *Ladder* with each *tahap*'s own milestones, and
 * the *Skill tracker*'s groups. Over HTTP with the real guard and pipe: *+ Tambah milestone* under a *tahap*, *+ Tambah
 * tahap* with its first milestone, *+ Tambah kelompok*, *+ Tambah skill*, a kelompok's skills dragged, and ⋯ *Arsipkan*
 * on a milestone under a *tahap* — each the Owner's, an Admin's, a core leader's and the Super Admin's inside the KPM,
 * never a field member's, and only ever in the writer's own office. No automatic rule anywhere.
 */
describe('P19.21-T3 AC-4 Capability Mapping: tahap, milestones, kelompok and skills (ADR-0274)', () => {
  let app: INestApplication;
  let wired: ReturnType<typeof configModule>;

  beforeAll(async () => {
    await startMongo();
    wired = configModule(NOW);
    const moduleRef = await Test.createTestingModule({
      controllers: [CapabilityController],
      providers: [{ provide: CapabilityService, useValue: wired.capability }],
    }).compile();
    app = moduleRef.createNestApplication();
    app.useGlobalPipes(productionPipe());
    app.useGlobalFilters(new DomainExceptionFilter());
    app.useGlobalGuards(new StubAuth(), new PermissionsGuard(app.get(Reflector)));
    await app.init();
    await listenOnLoopback(app);
  }, 60_000);

  afterAll(async () => {
    await app.close();
    await stopMongo();
  });

  beforeEach(async () => {
    session.current = OWNER;
    await clearCollections();
    await provisionOffice(wired, FIXTURE_KPM, COMPANY);
    await provisionOffice(wired, OTHER_KPM, COMPANY);
  });

  const http = () => request(app.getHttpServer());
  const catalogs = () => mongoose.connection.db!.collection('capabilityCatalogs').find({}).toArray();

  it.each(WRITERS)('P19.21-T3 AC-4 positive: %s adds a milestone under a tahap, a tahap, a kelompok and a skill, and drags skills', async (_n, who) => {
    session.current = who;
    const milestone = await http().post(`${URL}/items`)
      .send({ part: 'milestone', label: 'Polis pertama terbit', stageCode: 'COMPETENT_PRODUCER' }).expect(201);
    expect(milestone.body.stages.every((s: { requiredMilestoneCodes: string[] }) => s.requiredMilestoneCodes.includes('POLIS_PERTAMA_TERBIT')))
      .toBe(true);

    const stage = await http().post(`${URL}/items`)
      .send({ part: 'stage', label: 'Leader of leaders', firstMilestone: 'Membina dua leader' }).expect(201);
    expect(stage.body.stages.at(-1)).toMatchObject({ code: 'LEADER_OF_LEADERS', stageOrder: 5 });

    const grid = await http().post(`${URL}/items`).send({ part: 'grid', label: 'Digital selling' }).expect(201);
    expect(grid.body.grids.at(-1)).toMatchObject({ code: 'DIGITAL_SELLING', items: [] });

    await http().post(`${URL}/items`).send({ part: 'item', label: 'Konten media sosial', gridCode: 'DIGITAL_SELLING' }).expect(201);
    const skills = await http().post(`${URL}/items`)
      .send({ part: 'item', label: 'WhatsApp broadcast', gridCode: 'DIGITAL_SELLING' }).expect(201);
    const codes = skills.body.grids.at(-1).items.map((i: { code: string }) => i.code);
    const dragged = await http().patch(`${URL}/order`)
      .send({ part: 'item', gridCode: 'DIGITAL_SELLING', codes: [...codes].reverse() }).expect(200);
    expect(dragged.body.grids.at(-1).items.map((i: { code: string }) => i.code)).toEqual([...codes].reverse());
  });

  it.each(NOT_WRITERS)('P19.21-T3 AC-4 negative: %s is refused every new write at the guard, nothing written', async (_n, who) => {
    const before = await catalogs();
    session.current = who;
    await http().post(`${URL}/items`).send({ part: 'stage', label: 'X', firstMilestone: 'Y' }).expect(403);
    await http().post(`${URL}/items`).send({ part: 'grid', label: 'X' }).expect(403);
    await http().post(`${URL}/items`).send({ part: 'milestone', label: 'X', stageCode: 'COMPETENT_PRODUCER' }).expect(403);
    await http().patch(`${URL}/order`).send({ part: 'item', gridCode: 'PERSONAL_SELLING', codes: ['X'] }).expect(403);
    await http().patch(`${URL}/status`).send({ part: 'milestone', code: 'SELLS_OUTSIDE_NETWORK', status: 'archived' }).expect(403);
    expect(await catalogs()).toEqual(before);
  });

  it('P19.21-T3 AC-4 negative: a Super Admin outside any KPM is refused — there is no office', async () => {
    session.current = SUPER_ADMIN;
    expect((await http().post(`${URL}/items`).send({ part: 'grid', label: 'X' })).status).toBe(403);
  });

  it('P19.21-T3 AC-4 ⋯ Arsipkan on a milestone under a tahap takes it out of every stage; restoring puts it back', async () => {
    const archived = await http().patch(`${URL}/status`)
      .send({ part: 'milestone', code: 'SELLS_OUTSIDE_NETWORK', status: 'archived' }).expect(200);
    expect(archived.body.stages.map((s: { requiredMilestoneCodes: string[] }) => s.requiredMilestoneCodes.includes('SELLS_OUTSIDE_NETWORK')))
      .toEqual([false, false, false, false]);
    const restored = await http().patch(`${URL}/status`)
      .send({ part: 'milestone', code: 'SELLS_OUTSIDE_NETWORK', status: 'active' }).expect(200);
    expect(restored.body.stages.map((s: { requiredMilestoneCodes: string[] }) => s.requiredMilestoneCodes.includes('SELLS_OUTSIDE_NETWORK')))
      .toEqual([false, true, true, true]);
  });

  it('P19.21-T3 AC-4 refuses a tahap with no first milestone, and a stage’s last milestone archived, in the reader’s language', async () => {
    const stage = await http().post(`${URL}/items`).set(...IN_INDONESIAN).send({ part: 'stage', label: 'Leader of leaders' }).expect(400);
    expect(stage.body.error.message).toBe('Tahap baru memerlukan milestone pertamanya; tanpa itu semua orang sudah berada di tahap tersebut.');
    const last = await http().patch(`${URL}/status`)
      .send({ part: 'milestone', code: 'SELLS_INDEPENDENTLY', status: 'archived' }).expect(400);
    expect(last.body.error).toMatchObject({ code: 'VALIDATION_FAILED' });
    expect(last.body.error.message).toContain('Competent Producer would require no milestone without this one');
  });

  it('P19.21-T3 AC-4 refuses a skill for a kelompok that does not exist, and a milestone under a tahap that does not exist: 404', async () => {
    await http().post(`${URL}/items`).send({ part: 'item', label: 'X', gridCode: 'NOPE' }).expect(404);
    await http().post(`${URL}/items`).send({ part: 'milestone', label: 'X', stageCode: 'NOPE' }).expect(404);
    await http().patch(`${URL}/order`).send({ part: 'item', gridCode: 'NOPE', codes: ['X'] }).expect(404);
  });

  it('P19.21-T3 AC-4 cross-tenant: another office’s writes land in its own catalog only', async () => {
    session.current = OTHER_OWNER;
    await http().post(`${URL}/items`).send({ part: 'grid', label: 'Digital selling' }).expect(201);
    await http().patch(`${URL}/status`).send({ part: 'milestone', code: 'SELLS_OUTSIDE_NETWORK', status: 'archived' }).expect(200);
    session.current = OWNER;
    const ours = (await http().get(URL).expect(200)).body;
    expect(ours.grids.map((g: { code: string }) => g.code)).not.toContain('DIGITAL_SELLING');
    expect(ours.milestones.find((m: { code: string }) => m.code === 'SELLS_OUTSIDE_NETWORK').status).toBe('active');
  });
});
