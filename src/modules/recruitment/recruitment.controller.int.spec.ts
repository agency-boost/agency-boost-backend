import { INestApplication } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { Test } from '@nestjs/testing';
import mongoose from 'mongoose';
import request from 'supertest';
import { PermissionsGuard } from '@/common/auth/permissions.guard';
import { RequestContext } from '@/common/context/request-context';
import { DomainExceptionFilter } from '@/common/errors/error.filter';
import { SEED_RECRUITMENT_PLAYBOOK } from '@/domain/constants';
import { Kpm, KpmSchema } from '@/modules/tenants/kpm.schema';
import { clearCollections, startMongo, stopMongo } from '../../../test/mongo';
import { configModule } from '../../../test/config-module';
import {
  AAB, AB, ADMIN, AGENT, declaredPermissions, EVERY_MEMBER, FIXTURE_KPM, NOT_ADMINISTRATORS, OWNER,
  productionPipe, session, StubAuth, SUPER_ADMIN,
} from '../../../test/http-permissions';
import { listenOnLoopback } from '../../../test/listen';
import { IN_INDONESIAN } from '../../../test/i18n';
import { defaultPlaybookBody } from './recruitment-playbook-defaults';
import {
  RecruitmentController, RecruitmentPitchController, RecruitmentPlaybookController,
} from './recruitment.controller';
import { RecruitmentPitchService } from './recruitment-pitch.service';
import { RecruitmentPlanService } from './recruitment-plan.service';
import { RecruitmentPlaybookService } from './recruitment-playbook.service';

const NOW = new Date('2026-10-09T02:00:00Z');
const PRUDENTIAL = '66f0000000000000000000c1';
const BLANK = '66f0000000000000000000c3';

const membership = (over: Record<string, unknown> = {}) => ({
  membershipId: 'mem-a', kpmId: FIXTURE_KPM, orgLevelCode: 'AGENT', hierarchyRole: 'agent',
  status: 'active', isKpmOwner: false, isKpmAdmin: false, directCount: 0, ...over,
});
/** A member whose membership is not active: no hierarchy grant survives it. */
const PENDING_AGENT = new RequestContext('u-pending', 'none', membership({ status: 'pending' }) as never);
/** A Super Admin in a **read-only** support session, as the office's agent and as its Owner (roles §3.13). */
const READ_ONLY_AGENT = new RequestContext('u-agent', 'none', membership() as never, 'root', null, false, true);
const READ_ONLY_OWNER = new RequestContext('u-owner', 'none', membership({
  orgLevelCode: 'AB', hierarchyRole: 'ab', isKpmOwner: true,
}) as never, 'root', null, false, true);
/** The same, elevated: it writes as the Owner, both actors on the audit row. */
const ELEVATED_OWNER = new RequestContext('u-owner', 'none', membership({
  orgLevelCode: 'AB', hierarchyRole: 'ab', isKpmOwner: true,
}) as never, 'root', null, false, false);
/** An elevated support session as the office's Admin. */
const ELEVATED_ADMIN = new RequestContext('u-admin', 'none', membership({
  membershipId: 'mem-admin', orgLevelCode: 'AB', hierarchyRole: 'ab', isKpmAdmin: true,
}) as never, 'root', null, false, false);

/**
 * **Who the API lets read and write recruitment tools** (P17-T2 AC-5, P17-T4 AC-7, P17-T8 AC-3): every route
 * over HTTP, with the real `PermissionsGuard` and the production pipe. The services' own rules — isolation,
 * the plan, the replace — are `recruitment.tenancy.spec.ts`'s; this asks what a caller meets at the door,
 * and what shape comes back.
 */
describe('recruitment tools over HTTP (Phase 17)', () => {
  let app: INestApplication;
  let wired: ReturnType<typeof configModule>;

  beforeAll(async () => {
    await startMongo();
    wired = configModule(NOW);
    const moduleRef = await Test.createTestingModule({
      controllers: [RecruitmentController, RecruitmentPitchController, RecruitmentPlaybookController],
      providers: [
        { provide: RecruitmentPlanService, useValue: wired.recruitmentPlans },
        { provide: RecruitmentPitchService, useValue: wired.recruitmentPitch },
        { provide: RecruitmentPlaybookService, useValue: wired.recruitmentPlaybooks },
      ],
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
    session.current = AGENT;
    await clearCollections();
    await (wired.companies as { create: (d: unknown) => Promise<unknown> }).create([
      { _id: PRUDENTIAL, name: 'Prudential', slug: 'prudential' },
      { _id: BLANK, name: 'Sejahtera Baru Life', slug: 'sejahtera-baru-life', usesPlatformDefaults: false },
    ]);
    await mongoose.model(Kpm.name, KpmSchema).create({
      _id: FIXTURE_KPM, companyId: PRUDENTIAL, code: '0417', branchName: 'BSD City', timezone: 'Asia/Jakarta',
    });
    await wired.recruitmentPlaybooks.seedForCompany(PRUDENTIAL);
  });

  const http = () => request(app.getHttpServer());
  const PLAN = '/recruitment/attack-plan?type=retiree&motivation=leadership,flexibility&hesitation=time,no-network';
  const PITCH = '/kpm/settings/recruitment-pitch';

  /** A PDF signed and attached to a slot by the Owner, over HTTP — the settings page's three calls. */
  async function upload(slot: string, as: RequestContext = OWNER): Promise<{ storageKey: string; version: number }> {
    session.current = as;
    const signed = await http().post(`${PITCH}/uploads`).send({ filename: `${slot}.pdf`, mimeType: 'application/pdf', bytes: 1024 }).expect(201);
    const attached = await http().put(`${PITCH}/${slot}`).send({ storageKey: signed.body.storageKey }).expect(200);
    return { storageKey: signed.body.storageKey, version: attached.body.version };
  }

  describe('the decorators', () => {
    it('declares recruitment:read on the field reads, tenant_config:write on the office’s writes, and the console’s two', () => {
      expect(declaredPermissions(RecruitmentController)).toEqual({
        attackPlan: 'recruitment:read', pitchMaterials: 'recruitment:read', pitchDocumentUrl: 'recruitment:read',
      });
      expect(declaredPermissions(RecruitmentPitchController)).toEqual({
        requestUpload: 'tenant_config:write', attach: 'tenant_config:write', setConfirmation: 'tenant_config:write',
      });
      expect(declaredPermissions(RecruitmentPlaybookController)).toEqual({
        read: 'company_template:read', save: 'recruitment_playbook:write',
      });
    });
  });

  describe('the field reads, per role (P17-T2 AC-5, P17-T4 AC-7)', () => {
    it.each(EVERY_MEMBER)('P17-T2 AC-5 positive: %s reads the plan, the pitch and a document’s link', async (_n, who) => {
      await upload('proof');
      session.current = who;
      for (const path of ['/recruitment/attack-plan', PLAN, '/recruitment/pitch-materials', '/recruitment/pitch-materials/proof/url']) {
        const res = await http().get(path);
        expect([path, res.status]).toEqual([path, 200]);
      }
    });

    it('P17-T2 AC-5 negative: a Super Admin outside a support session is refused every field read — there is no office', async () => {
      session.current = SUPER_ADMIN;
      for (const path of [PLAN, '/recruitment/pitch-materials', '/recruitment/pitch-materials/proof/url']) {
        const res = await http().get(path);
        expect([path, res.status, res.body.error?.code]).toEqual([path, 403, 'TENANT_NO_MEMBERSHIP']);
      }
    });

    it('P17-T2 AC-5 negative: a member whose membership is not active is refused at the guard', async () => {
      session.current = PENDING_AGENT;
      for (const path of [PLAN, '/recruitment/pitch-materials', '/recruitment/pitch-materials/proof/url']) {
        const res = await http().get(path);
        expect([path, res.status, res.body.error?.code]).toEqual([path, 403, 'PERM_DENIED']);
      }
    });

    it('P17-T2 AC-5 a read-only support session reads the plan, the pitch and a link — which write nothing anyway', async () => {
      await upload('proof');
      session.current = READ_ONLY_AGENT;
      for (const path of [PLAN, '/recruitment/pitch-materials', '/recruitment/pitch-materials/proof/url']) {
        expect([path, (await http().get(path)).status]).toEqual([path, 200]);
      }
    });

    it('P17-T4 AC-6 a slot not filled, and one that does not exist, are 404 NOT_FOUND', async () => {
      for (const path of ['/recruitment/pitch-materials/faq/url', '/recruitment/pitch-materials/poster/url']) {
        const res = await http().get(path);
        expect([path, res.status, res.body.error?.code]).toEqual([path, 404, 'NOT_FOUND']);
      }
    });
  });

  describe('the office’s writes, per role (P17-T4 AC-7)', () => {
    it.each([
      ['the Owner', OWNER], ['the Admin', ADMIN], ['an elevated support session as the Owner', ELEVATED_OWNER],
      ['an elevated support session as the Admin', ELEVATED_ADMIN],
    ])(
      'P17-T4 AC-7 positive: %s signs, attaches, ticks and unticks', async (_n, who) => {
        const { version } = await upload('opportunity', who);
        session.current = who;
        const ticked = await http().put(`${PITCH}/opportunity/confirmations/income`).send({ ticked: true, version }).expect(200);
        expect(ticked.body.checklist.find((i: { code: string }) => i.code === 'income').ticked).toBe(true);
        await http().put(`${PITCH}/opportunity/confirmations/income`).send({ ticked: false, version }).expect(200);
      },
    );

    it.each([...NOT_ADMINISTRATORS, ['a read-only support session as the Owner', READ_ONLY_OWNER] as [string, RequestContext]])(
      'P17-T4 AC-7 negative: %s is refused every write, at the guard, with nothing written', async (_n, who) => {
        const { storageKey } = await upload('opportunity');
        session.current = who;
        await http().post(`${PITCH}/uploads`).send({ filename: 'x.pdf', mimeType: 'application/pdf', bytes: 1 }).expect(403);
        await http().put(`${PITCH}/proof`).send({ storageKey }).expect(403);
        await http().put(`${PITCH}/opportunity/confirmations/income`).send({ ticked: true, version: 1 }).expect(403);
        expect(await mongoose.connection.db!.collection('kpmRecruitmentPitchDocuments').find({}).toArray())
          .toMatchObject([{ slot: 'opportunity', version: 1, confirmations: [] }]);
      },
    );
  });

  describe('P18.97-T5 — the two optional documents, per role (ADR-0177 §2; the same permissions as the four)', () => {
    const OPTIONAL = ['company', 'agency'];

    it.each([
      ['the Owner', OWNER], ['the Admin', ADMIN], ['an elevated support session as the Owner', ELEVATED_OWNER],
      ['an elevated support session as the Admin', ELEVATED_ADMIN],
    ])('P18.97-T5 AC-2 positive: %s signs, attaches and replaces Company Profile and Agency Profile', async (_n, who) => {
      for (const slot of OPTIONAL) {
        expect([slot, (await upload(slot, who)).version]).toEqual([slot, 1]);
        expect([slot, (await upload(slot, who)).version]).toEqual([slot, 2]);
      }
    });

    it.each(EVERY_MEMBER)('P18.97-T5 AC-2 positive: %s reads both optional slots and opens one that is filled', async (_n, who) => {
      await upload('company');
      session.current = who;
      const res = await http().get('/recruitment/pitch-materials').expect(200);
      expect(res.body.slots.filter((s: { required: boolean }) => !s.required).map((s: { slot: string; state: string }) => [s.slot, s.state]))
        .toEqual([['company', 'uploaded'], ['agency', 'missing']]);
      const link = await http().get('/recruitment/pitch-materials/company/url').expect(200);
      expect(link.body.url).toContain('/recruitment-pitch/');
      // An empty optional slot has nothing to open: 404, as an empty required one.
      expect((await http().get('/recruitment/pitch-materials/agency/url').expect(404)).body.error.code).toBe('NOT_FOUND');
    });

    it.each([...NOT_ADMINISTRATORS, ['a read-only support session as the Owner', READ_ONLY_OWNER] as [string, RequestContext]])(
      'P18.97-T5 AC-2 negative: %s is refused an optional slot’s upload and attach, at the guard, with nothing written', async (_n, who) => {
        const { storageKey } = await upload('company');
        session.current = who;
        await http().post(`${PITCH}/uploads`).send({ filename: 'agency.pdf', mimeType: 'application/pdf', bytes: 1 }).expect(403);
        for (const slot of OPTIONAL) await http().put(`${PITCH}/${slot}`).send({ storageKey }).expect(403);
        expect(await mongoose.connection.db!.collection('kpmRecruitmentPitchDocuments').find({}).toArray())
          .toMatchObject([{ slot: 'company', version: 1 }]);
      },
    );

    it('P18.97-T5 AC-2 an optional slot takes no tick: 400 VALIDATION_FAILED over HTTP', async () => {
      const { version } = await upload('agency');
      const res = await http().put(`${PITCH}/agency/confirmations/income`).send({ ticked: true, version }).expect(400);
      expect(res.body.error).toMatchObject({ code: 'VALIDATION_FAILED', details: { field: 'item', item: 'income' } });
    });
  });

  describe('the shapes (the Data contract)', () => {
    it('answers the plan as { hasPlaybook, vocabulary, plan }, the plan’s parts as the contract names them', async () => {
      const res = await http().get(PLAN).expect(200);
      expect(Object.keys(res.body)).toEqual(['hasPlaybook', 'vocabulary', 'plan']);
      expect(Object.keys(res.body.vocabulary)).toEqual(['types', 'motivations', 'hesitations']);
      expect(Object.keys(res.body.plan)).toEqual(['brief', 'profile', 'openings', 'objections', 'nextAction']);
      expect(res.body.plan.brief.motivations.map((c: { code: string }) => c.code)).toEqual(['flexibility', 'leadership']);
      expect(Object.keys(res.body.plan.profile)).toEqual(['code', 'label', 'tagline', 'goodFitFor', 'benefits']);
      expect(res.body.plan.openings[0]).toEqual({
        motivation: { code: 'flexibility', label: 'Flexibility' },
        text: SEED_RECRUITMENT_PLAYBOOK.profiles.retiree.openings.flexibility,
      });
      expect(Object.keys(res.body.plan.objections[0])).toEqual(['hesitation', 'theySay', 'youSay', 'profileOwn']);
    });

    it('answers no plan and hasPlaybook without a brief', async () => {
      const res = await http().get('/recruitment/attack-plan').expect(200);
      expect(res.body).toMatchObject({ hasPlaybook: true, plan: null });
    });

    it('P18.97-T5 AC-2 answers the pitch as { slots, summary }, six slots, each the contract’s fields, the summary over the four', async () => {
      await upload('proof');
      await upload('company');
      session.current = AGENT;
      const res = await http().get('/recruitment/pitch-materials').expect(200);
      expect(Object.keys(res.body)).toEqual(['slots', 'summary']);
      expect(res.body.slots.map((s: { slot: string; required: boolean }) => [s.slot, s.required])).toEqual([
        ['opportunity', true], ['proof', true], ['faq', true], ['howtojoin', true], ['company', false], ['agency', false],
      ]);
      expect(Object.keys(res.body.slots[1])).toEqual(['slot', 'title', 'line', 'required', 'state', 'file', 'checklist', 'version']);
      expect(res.body.slots[1]).toMatchObject({ state: 'uploaded', file: { name: 'proof.pdf', bytes: 1024, uploadedOn: '2026-10-09' }, version: 1 });
      expect(res.body.slots[4]).toMatchObject({
        slot: 'company', title: 'Company Profile', required: false, state: 'uploaded', checklist: [], version: 1,
        file: { name: 'company.pdf', bytes: 1024, uploadedOn: '2026-10-09' },
      });
      expect(res.body.slots[5]).toMatchObject({ slot: 'agency', title: 'Agency Profile', required: false, state: 'missing', file: null, version: 0 });
      // The optional Company Profile counts in nothing: one of four done, three missing (ADR-0177 §3).
      expect(res.body.summary).toEqual({ done: 1, total: 4, missing: 3, unconfirmed: 0 });
    });

    it('answers a link as { url, expiresAt }, 300 seconds out', async () => {
      await upload('proof');
      session.current = AGENT;
      const res = await http().get('/recruitment/pitch-materials/proof/url').expect(200);
      expect(res.body).toEqual({ url: expect.stringContaining('/recruitment-pitch/'), expiresAt: '2026-10-09T02:05:00.000Z' });
    });

    it('answers a signed upload with the fields to send beside the file — PDF-only, never an overwrite (N5)', async () => {
      session.current = OWNER;
      const res = await http().post(`${PITCH}/uploads`).send({ filename: 'o.pdf', mimeType: 'application/pdf', bytes: 1024 }).expect(201);
      expect(Object.keys(res.body).sort()).toEqual(['expiresAt', 'fields', 'signature', 'storageKey', 'uploadUrl']);
      expect(res.body.storageKey).toMatch(new RegExp(`^dev/${FIXTURE_KPM}/recruitment-pitch/`));
      expect(wired.storage.signedWith.at(-1)).toEqual({ folder: 'recruitment-pitch', mimeType: 'application/pdf', allowedMimeTypes: ['application/pdf'] });
      // P18.7-T2: one fresh key, and the Content-Type pinned to PDF by the V4 POST policy.
      expect(res.body.fields).toMatchObject({ key: res.body.storageKey, 'Content-Type': 'application/pdf' });
    });
  });

  describe('what the pipe and the service refuse (P17-T2 AC-4, P17-T4 AC-2 to AC-4)', () => {
    it.each([
      ['a parameter nobody asked for', '/recruitment/attack-plan?type=retiree&motivation=time&hesitation=time&name=Pak%20Andi'],
      ['a type sent twice', '/recruitment/attack-plan?type=retiree&type=fresh-grad&motivation=leadership&hesitation=time'],
      ['an unknown code', '/recruitment/attack-plan?type=retiree&motivation=fame&hesitation=time'],
      ['a missing hesitation', '/recruitment/attack-plan?type=retiree&motivation=leadership'],
      ['an empty motivation', '/recruitment/attack-plan?type=retiree&motivation=&hesitation=time'],
    ])('P17-T2 AC-4 refuses %s: 400 VALIDATION_FAILED, naming it', async (_n, path) => {
      const res = await http().get(path).expect(400);
      expect(res.body.error.code).toBe('VALIDATION_FAILED');
      expect(JSON.stringify(res.body.error.details)).toMatch(/name|type|motivation|hesitation/);
    });

    it('P17-T2 AC-4 names a missing parameter in details.parameters', async () => {
      const res = await http().get('/recruitment/attack-plan?type=retiree').expect(400);
      expect(res.body.error.details).toEqual({ parameters: ['motivation', 'hesitation'] });
    });

    it.each([
      ['not a PDF', { filename: 'x.png', mimeType: 'image/png', bytes: 10 }, 415, 'ASSET_TYPE_NOT_ALLOWED'],
      ['a type no route accepts', { filename: 'x.exe', mimeType: 'application/x-msdownload', bytes: 10 }, 415, 'ASSET_TYPE_NOT_ALLOWED'],
      ['over 25 MB', { filename: 'x.pdf', mimeType: 'application/pdf', bytes: 26_214_401 }, 413, 'ASSET_TOO_LARGE'],
      ['no size', { filename: 'x.pdf', mimeType: 'application/pdf' }, 400, 'VALIDATION_FAILED'],
      ['a folder of its own choosing', { filename: 'x.pdf', mimeType: 'application/pdf', bytes: 1, folder: 'training' }, 400, 'VALIDATION_FAILED'],
    ])('P17-T4 AC-2 refuses a signature for %s', async (_n, body, status, code) => {
      session.current = OWNER;
      const res = await http().post(`${PITCH}/uploads`).send(body).expect(status);
      expect(res.body.error.code).toBe(code);
    });

    it('P17-T4 AC-3 refuses an attach with no key, or a field it does not take', async () => {
      session.current = OWNER;
      await http().put(`${PITCH}/opportunity`).send({}).expect(400);
      await http().put(`${PITCH}/opportunity`).send({ storageKey: 'k', confirmations: [] }).expect(400);
    });

    it('P17-T4 AC-4 refuses a tick that is not a boolean, or names no version; and a stale version is 409', async () => {
      const { version } = await upload('opportunity');
      await http().put(`${PITCH}/opportunity/confirmations/income`).send({ ticked: 'yes', version }).expect(400);
      await http().put(`${PITCH}/opportunity/confirmations/income`).send({ ticked: true }).expect(400);
      const stale = await http().put(`${PITCH}/opportunity/confirmations/income`).send({ ticked: true, version: version + 1 }).expect(409);
      expect(stale.body.error.code).toBe('VERSION_CONFLICT');
      const notAnItem = await http().put(`${PITCH}/proof/confirmations/income`).send({ ticked: true, version: 1 }).expect(400);
      expect(notAnItem.body.error.code).toBe('VALIDATION_FAILED');
    });
  });

  describe('the company’s playbook on the console (P17-T8)', () => {
    const PLAYBOOK = `/admin/companies/${PRUDENTIAL}/recruitment-playbook`;

    it('P17-T8 AC-1 reads the company’s playbook, the AgencyBoost words, the vocabulary and the limits', async () => {
      session.current = SUPER_ADMIN;
      const res = await http().get(PLAYBOOK).expect(200);
      expect(Object.keys(res.body)).toEqual(['playbook', 'defaults', 'vocabulary', 'limits']);
      expect(res.body.playbook).toMatchObject({ companyId: PRUDENTIAL, version: 1, updatedBy: null, body: SEED_RECRUITMENT_PLAYBOOK });
      expect(res.body.defaults).toEqual(SEED_RECRUITMENT_PLAYBOOK);
      expect(res.body.limits).toEqual({ textMax: 600, benefitsMax: 6 });
    });

    it('P17-T8 AC-1 a company with none reads null, with the words to start from', async () => {
      session.current = SUPER_ADMIN;
      const res = await http().get(`/admin/companies/${BLANK}/recruitment-playbook`).expect(200);
      expect(res.body).toMatchObject({ playbook: null, defaults: SEED_RECRUITMENT_PLAYBOOK });
    });

    it.each(['66f0000000000000000000ee', 'not-an-id'])('P17-T8 AC-3 an unknown company, %s, is 404 on both', async (id) => {
      session.current = SUPER_ADMIN;
      await http().get(`/admin/companies/${id}/recruitment-playbook`).expect(404);
      await http().put(`/admin/companies/${id}/recruitment-playbook`).send({ version: null, body: defaultPlaybookBody() }).expect(404);
    });

    it.each([
      ...EVERY_MEMBER,
      ['a read-only support session as the Owner', READ_ONLY_OWNER] as [string, RequestContext],
      // N2: a support session acts as its member — a tenant role — however it was elevated.
      ['an elevated support session as the Owner', ELEVATED_OWNER] as [string, RequestContext],
    ])(
      'P17-T8 AC-3 negative: %s is refused the read and the save', async (_n, who) => {
        session.current = who;
        expect((await http().get(PLAYBOOK)).status).toBe(403);
        expect((await http().put(PLAYBOOK).send({ version: 1, body: defaultPlaybookBody() })).status).toBe(403);
      },
    );

    it('P17-T8 AC-2 saves the whole playbook pinned to its version — the nested words intact through the pipe — and a stale version is 409', async () => {
      session.current = SUPER_ADMIN;
      const body = defaultPlaybookBody() as unknown as { nextAction: string; profileObjections: Record<string, unknown> };
      body.nextAction = 'Invite them to <b>Thursday</b>’s session <script>alert(1)</script>.';
      const saved = await http().put(PLAYBOOK).send({ version: 1, body }).expect(200);
      expect(saved.body).toMatchObject({ companyId: PRUDENTIAL, version: 2 });
      // Every nested key survived the whitelist, and the words are as typed — the readers render them as text.
      expect(saved.body.body).toEqual({ ...SEED_RECRUITMENT_PLAYBOOK, nextAction: body.nextAction });
      const stale = await http().put(PLAYBOOK).send({ version: 1, body }).expect(409);
      expect(stale.body.error.code).toBe('VERSION_CONFLICT');

      // P17-T8 AC-4: an agent's next plan carries the words exactly as saved, as text to render.
      session.current = AGENT;
      expect((await http().get(PLAN).expect(200)).body.plan.nextAction).toBe(body.nextAction);
    });

    it('P17-T8 AC-2 refuses a body that is not whole, naming each field in details.violations', async () => {
      session.current = SUPER_ADMIN;
      const body = defaultPlaybookBody() as unknown as { profiles: Record<string, { benefits: string[] }>; nextAction: string };
      body.profiles.retiree.benefits[1] = ' ';
      body.nextAction = '';
      const res = await http().put(PLAYBOOK).send({ version: 1, body }).expect(400);
      expect(res.body.error).toMatchObject({
        code: 'VALIDATION_FAILED',
        details: { violations: [
          { field: 'body.profiles.retiree.benefits[1]', message: 'Must not be empty.' },
          { field: 'body.nextAction', message: 'Must not be empty.' },
        ] },
      });
    });

    it.each([
      ['no version at all', { body: {} }],
      ['a version of 0', { version: 0, body: {} }],
      ['a body that is not an object', { version: 1, body: 'words' }],
      ['a field it does not take', { version: 1, body: {}, companyId: BLANK }],
    ])('P17-T8 AC-2 refuses %s at the pipe', async (_n, payload) => {
      session.current = SUPER_ADMIN;
      expect((await http().put(PLAYBOOK).send(payload).expect(400)).body.error.code).toBe('VALIDATION_FAILED');
    });

    it('P17-T8 AC-2 creates a blank company’s first with version null, and refuses null once it has one', async () => {
      session.current = SUPER_ADMIN;
      const path = `/admin/companies/${BLANK}/recruitment-playbook`;
      const created = await http().put(path).send({ version: null, body: defaultPlaybookBody() }).expect(200);
      expect(created.body).toMatchObject({ companyId: BLANK, version: 1 });
      expect((await http().put(path).send({ version: null, body: defaultPlaybookBody() }).expect(409)).body.error.code)
        .toBe('VERSION_CONFLICT');
    });
  });

  it('never answers AB, AAB or an agent differently from the Owner on the field reads', async () => {
    await upload('opportunity');
    const answers = [];
    for (const who of [OWNER, ADMIN, AB, AAB, AGENT]) {
      session.current = who;
      answers.push(JSON.stringify([(await http().get(PLAN)).body, (await http().get('/recruitment/pitch-materials')).body]));
    }
    expect(new Set(answers).size).toBe(1);
  });

  /**
   * **Recruitment's refusals in Bahasa Indonesia** (P18.98-T5 AC-7): a brief, the pitch's checklist and the playbook's
   * save — the codes and the details as in English, a parameter and a field named as the API names them.
   */
  describe('P18.98-T5 AC-7 recruitment’s refusals in Indonesian', () => {
    const plan = (query: string) => http().get(`/recruitment/attack-plan?${query}`).set(...IN_INDONESIAN).expect(400);

    it('P18.98-T5 AC-7 a brief missing a parameter, naming a code twice, an unknown code and an unknown type', async () => {
      expect((await plan('type=retiree')).body.error).toMatchObject({
        code: 'VALIDATION_FAILED',
        message: 'Brief memerlukan jenis kandidat, motivasi, dan keraguan; motivation dan hesitation belum diisi.',
        details: { parameters: ['motivation', 'hesitation'] },
      });
      expect((await plan('type=retiree&motivation=leadership,leadership&hesitation=time')).body.error.message)
        .toBe('motivation menyebut satu jawaban dua kali.');
      expect((await plan('type=retiree&motivation=fame&hesitation=time')).body.error.message)
        .toBe('motivation berisi kode yang bukan salah satu jawabannya, atau tidak berisi kode sama sekali.');
      expect((await plan('type=astronaut&motivation=leadership&hesitation=time')).body.error).toMatchObject({
        message: '"astronaut" bukan jenis kandidat.', details: { parameters: ['type'] },
      });
    });

    it('P18.98-T5 AC-7 the pitch: a tick on a slot with no file, and an item a slot does not have', async () => {
      session.current = OWNER;
      const empty = await http().put(`${PITCH}/opportunity/confirmations/income`).set(...IN_INDONESIAN)
        .send({ ticked: true, version: 1 }).expect(400);
      expect(empty.body.error).toMatchObject({
        code: 'VALIDATION_FAILED',
        message: 'Opportunity Overview belum memiliki file: unggah file dulu sebelum mengonfirmasi isinya.',
        details: { field: 'slot', slot: 'opportunity' },
      });
      const { version } = await upload('agency');
      const noItem = await http().put(`${PITCH}/agency/confirmations/income`).set(...IN_INDONESIAN)
        .send({ ticked: true, version }).expect(400);
      expect(noItem.body.error).toMatchObject({
        message: 'Agency Profile tidak memiliki item "income" untuk dikonfirmasi.', details: { field: 'item', item: 'income' },
      });
    });

    it('P18.98-T5 AC-7 a playbook that is not whole: each field’s sentence in Indonesian, the message naming them all', async () => {
      session.current = SUPER_ADMIN;
      const body = defaultPlaybookBody() as unknown as { nextAction: string };
      body.nextAction = '';
      const res = await http().put(`/admin/companies/${PRUDENTIAL}/recruitment-playbook`).set(...IN_INDONESIAN)
        .send({ version: 1, body }).expect(400);
      expect(res.body.error).toMatchObject({
        code: 'VALIDATION_FAILED',
        message: 'Playbook ini tidak dapat disimpan: body.nextAction — Tidak boleh kosong.',
        details: { violations: [{ field: 'body.nextAction', message: 'Tidak boleh kosong.' }] },
      });
    });
  });
});
