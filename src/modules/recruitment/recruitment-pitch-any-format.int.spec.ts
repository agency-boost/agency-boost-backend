import { INestApplication } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { Test } from '@nestjs/testing';
import mongoose from 'mongoose';
import request from 'supertest';
import { PermissionsGuard } from '@/common/auth/permissions.guard';
import { RequestContext } from '@/common/context/request-context';
import { DomainExceptionFilter } from '@/common/errors/error.filter';
import { RECRUITMENT } from '@/domain/constants';
import { Kpm, KpmSchema } from '@/modules/tenants/kpm.schema';
import { clearCollections, startMongo, stopMongo, syncIndexes } from '../../../test/mongo';
import { configModule } from '../../../test/config-module';
import {
  AAB, AB, ADMIN, AGENT, FIXTURE_KPM, OWNER, productionPipe, session, StubAuth, SUPER_ADMIN,
} from '../../../test/http-permissions';
import { listenOnLoopback } from '../../../test/listen';
import { IN_INDONESIAN } from '../../../test/i18n';
import { RecruitmentController, RecruitmentPitchController } from './recruitment.controller';
import { pitchLinkOf, RecruitmentPitchService } from './recruitment-pitch.service';
import { RecruitmentPlanService } from './recruitment-plan.service';
import { RecruitmentPlaybookService } from './recruitment-playbook.service';

const NOW = new Date('2026-11-20T03:00:00Z');
const PRUDENTIAL = '66f0000000000000000000c1';
const OTHER_KPM = '66f0000000000000000000b2';
const PITCH = '/kpm/settings/recruitment-pitch';
const READ = '/recruitment/pitch-materials';
const VIDEO_LINK = 'https://www.youtube.com/watch?v=abc123';

const member = (over: Record<string, unknown>) => ({
  membershipId: 'mem-a', kpmId: FIXTURE_KPM, orgLevelCode: 'AB', hierarchyRole: 'ab', status: 'active',
  isKpmOwner: false, isKpmAdmin: false, directCount: 0, ...over,
});
/** An AB marked core leader: the Owner's rights in Pengaturan (ADR-0268). */
const CORE_LEADER = new RequestContext('u-core', 'none', member({ membershipId: 'mem-core', isCoreLeader: true }) as never);
/** The Super Admin working inside the KPM by its `X-Kpm-Id`: the Owner's grants (ADR-0268 §3). */
const SUPER_ADMIN_INSIDE = RequestContext.superAdminInKpm(SUPER_ADMIN, FIXTURE_KPM);
/** The Owner of another office. */
const OTHER_OWNER = new RequestContext('u-other', 'none', member({ membershipId: 'mem-other', kpmId: OTHER_KPM, isKpmOwner: true }) as never);
/** A Super Admin's read-only support session as the Owner. */
const READ_ONLY_OWNER = new RequestContext('u-owner', 'none', member({ isKpmOwner: true }) as never, 'root', null, false, true);

const WRITERS: [string, RequestContext][] = [
  ['the Owner', OWNER], ['an Admin', ADMIN], ['a core leader', CORE_LEADER], ['the Super Admin inside the KPM', SUPER_ADMIN_INSIDE],
];
const NOT_WRITERS: [string, RequestContext][] = [
  ['an AB', AB], ['an AAB', AAB], ['an agent', AGENT], ['a read-only support session as the Owner', READ_ONLY_OWNER],
];

/** Every kind the owner named (*"PDF, PowerPoint, Word, gambar, video"*), as a browser claims it. */
const KINDS: [string, string, string][] = [
  ['a PDF', 'deck.pdf', 'application/pdf'],
  ['an HTML page', 'page.html', 'text/html'],
  ['a PowerPoint (.pptx)', 'Proof_and_Credibility_2026.pptx', 'application/vnd.openxmlformats-officedocument.presentationml.presentation'],
  ['a PowerPoint (.ppt)', 'old.ppt', 'application/vnd.ms-powerpoint'],
  ['a Word file (.docx)', 'FAQ.docx', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'],
  ['a Word file (.doc)', 'FAQ.doc', 'application/msword'],
  ['a PNG', 'poster.png', 'image/png'],
  ['a JPEG', 'poster.jpg', 'image/jpeg'],
  ['a WebP', 'poster.webp', 'image/webp'],
  ['an MP4 video', 'video.mp4', 'video/mp4'],
  ['a WebM video', 'video.webm', 'video/webm'],
  ['a QuickTime video', 'video.mov', 'video/quicktime'],
];

/**
 * **P19.21-T3 AC-6 — a pitch material is any format, or a link** (ADR-0274): every kind the owner named is signed and
 * attached, a link is set in place of a file and back, what is not a pitch format is refused before anything is
 * signed, a link that is not an `https://` address is refused, the counts read all six, and each write is the Owner's,
 * an Admin's, a core leader's and the Super Admin's inside the KPM — never a field member's, never another office's.
 */
describe('P19.21-T3 AC-6 a recruitment pitch material is any format or a link (ADR-0274)', () => {
  let app: INestApplication;
  let wired: ReturnType<typeof configModule>;
  const db = () => mongoose.connection.db!;

  beforeAll(async () => {
    await startMongo();
    wired = configModule(NOW);
    await syncIndexes();
    const moduleRef = await Test.createTestingModule({
      controllers: [RecruitmentController, RecruitmentPitchController],
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
    session.current = OWNER;
    await clearCollections();
    await (wired.companies as { create: (d: unknown) => Promise<unknown> }).create([
      { _id: PRUDENTIAL, name: 'Prudential', slug: 'prudential' },
    ]);
    await mongoose.model(Kpm.name, KpmSchema).create([
      { _id: FIXTURE_KPM, companyId: PRUDENTIAL, code: '0417', branchName: 'BSD City', timezone: 'Asia/Jakarta' },
      { _id: OTHER_KPM, companyId: PRUDENTIAL, code: '0555', branchName: 'Kelapa Gading', timezone: 'Asia/Jakarta' },
    ]);
  });

  const http = () => request(app.getHttpServer());
  const rows = () => db().collection('kpmRecruitmentPitchDocuments').find({}).sort({ slot: 1 }).toArray();

  async function upload(slot: string, filename: string, mimeType: string, as: RequestContext = OWNER) {
    session.current = as;
    const signed = await http().post(`${PITCH}/uploads`).send({ filename, mimeType, bytes: 2048 }).expect(201);
    return http().put(`${PITCH}/${slot}`).send({ storageKey: signed.body.storageKey });
  }

  describe('every kind the owner named is signed and attached', () => {
    it.each(KINDS)('P19.21-T3 AC-6 %s is signed into the pitch folder and attached, under the pitch list', async (_n, filename, mimeType) => {
      const attached = await upload('proof', filename, mimeType);
      expect(attached.status).toBe(200);
      expect(attached.body).toMatchObject({ slot: 'proof', state: 'uploaded', file: { name: filename, mimeType }, link: null, version: 1 });
      expect(wired.storage.signedWith.at(-1)).toEqual({
        folder: RECRUITMENT.PITCH_UPLOAD_FOLDER, mimeType, allowedMimeTypes: RECRUITMENT.PITCH_MIME_TYPES,
      });
    });

    it.each([
      ['an executable', 'setup.exe', 'application/x-msdownload'],
      ['a zip', 'deck.zip', 'application/zip'],
      ['a spreadsheet', 'figures.xlsx', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'],
      ['a CSV', 'figures.csv', 'text/csv'],
      ['an Excel 97 file', 'figures.xls', 'application/vnd.ms-excel'],
    ])('P19.21-T3 AC-6 refuses %s before anything is signed: 415, nothing written', async (_n, filename, mimeType) => {
      const before = wired.storage.signedWith.length;
      const res = await http().post(`${PITCH}/uploads`).send({ filename, mimeType, bytes: 1024 }).expect(415);
      expect(res.body.error.code).toBe('ASSET_TYPE_NOT_ALLOWED');
      expect(wired.storage.signedWith.length).toBe(before);
      expect(await rows()).toEqual([]);
    });

    it('P19.21-T3 AC-6 refuses a video larger than 25 MB before anything is signed: a longer video is a link', async () => {
      const res = await http().post(`${PITCH}/uploads`)
        .send({ filename: 'long.mp4', mimeType: 'video/mp4', bytes: RECRUITMENT.PITCH_MAX_BYTES + 1 }).expect(413);
      expect(res.body.error.code).toBe('ASSET_TOO_LARGE');
    });
  });

  describe('a link in place of a file', () => {
    it('P19.21-T3 AC-6 a link is set, counted as a material, and read back by every member with its day', async () => {
      const res = await http().put(`${PITCH}/faq/link`).send({ url: VIDEO_LINK }).expect(200);
      expect(res.body).toMatchObject({ slot: 'faq', state: 'uploaded', file: null, link: { url: VIDEO_LINK, addedOn: '2026-11-20' }, version: 1 });
      session.current = AGENT;
      const read = await http().get(READ).expect(200);
      expect(read.body.slots.find((s: { slot: string }) => s.slot === 'faq')).toMatchObject({ link: { url: VIDEO_LINK }, file: null });
      expect(read.body.summary.all).toEqual({ ready: 1, total: 6, missing: 5, unconfirmed: 0 });
      // A link has no file to sign: its address is in the read, and the file route says so.
      expect((await http().get(`${READ}/faq/url`).expect(404)).body.error.code).toBe('NOT_FOUND');
    });

    it('P19.21-T3 AC-6 a link replaces a file — releasing it, clearing the ticks, moving the version — and a file replaces a link', async () => {
      const first = await upload('opportunity', 'Opportunity_Overview_v3.pdf', 'application/pdf');
      const fileKey = (await rows())[0].storageKey as string;
      await http().put(`${PITCH}/opportunity/confirmations/income`).send({ ticked: true, version: first.body.version }).expect(200);

      const linked = await http().put(`${PITCH}/opportunity/link`).send({ url: VIDEO_LINK }).expect(200);
      expect(linked.body).toMatchObject({ state: 'partial', file: null, link: { url: VIDEO_LINK }, version: 2 });
      expect(linked.body.checklist.every((i: { ticked: boolean }) => !i.ticked)).toBe(true);
      expect(await db().collection('assets').findOne({ storageKey: fileKey })).toMatchObject({ refCount: 0 });
      expect(await rows()).toMatchObject([{ slot: 'opportunity', storageKey: null, fileName: null, linkUrl: VIDEO_LINK, version: 2 }]);
      const audit = await db().collection('auditLog').findOne({ action: 'recruitment_pitch.linked' });
      expect(audit).toMatchObject({ before: { storageKey: fileKey, linkUrl: null, version: 1 }, after: { linkUrl: VIDEO_LINK, version: 2 } });

      const back = await upload('opportunity', 'Opportunity_Overview_v4.pptx',
        'application/vnd.openxmlformats-officedocument.presentationml.presentation');
      expect(back.body).toMatchObject({ file: { name: 'Opportunity_Overview_v4.pptx' }, link: null, version: 3 });
      expect(await rows()).toMatchObject([{ linkUrl: null, version: 3 }]);
    });

    it('P19.21-T3 AC-6 the link the slot already holds changes nothing: no version, no audit row', async () => {
      await http().put(`${PITCH}/agency/link`).send({ url: VIDEO_LINK }).expect(200);
      const again = await http().put(`${PITCH}/agency/link`).send({ url: `  ${VIDEO_LINK}  ` }).expect(200);
      expect(again.body.version).toBe(1);
      expect(await db().collection('auditLog').countDocuments({ action: 'recruitment_pitch.linked' })).toBe(1);
    });

    it.each([
      ['an http:// address', 'http://example.com/deck'],
      ['a javascript: address', 'javascript:alert(1)'],
      ['a data: address', 'data:text/html,<b>x</b>'],
      ['words, not an address', 'lihat di grup WhatsApp'],
      ['an address with a password in it', 'https://user:secret@example.com/deck'],
      ['an address with a space in it', 'https://example.com/my deck'],
      ['an empty string', '   '],
      ['an address one character too long', `https://example.com/${'a'.repeat(RECRUITMENT.PITCH_LINK_MAX_LENGTH - 19)}`],
    ])('P19.21-T3 AC-6 refuses %s: 400 VALIDATION_FAILED on `url`, nothing written', async (_n, url) => {
      const res = await http().put(`${PITCH}/faq/link`).send({ url });
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('VALIDATION_FAILED');
      expect(await rows()).toEqual([]);
    });

    it('P19.21-T3 AC-6 refuses a body with no url, or a field it does not take, at the pipe', async () => {
      await http().put(`${PITCH}/faq/link`).send({}).expect(400);
      await http().put(`${PITCH}/faq/link`).send({ url: VIDEO_LINK, storageKey: 'x' }).expect(400);
    });

    it('P19.21-T3 AC-6 a slot that does not exist is 404', async () => {
      expect((await http().put(`${PITCH}/poster/link`).send({ url: VIDEO_LINK }).expect(404)).body.error.code).toBe('NOT_FOUND');
    });

    it('P19.21-T3 AC-6 the refusal is in the reader’s language', async () => {
      const res = await http().put(`${PITCH}/faq/link`).set(...IN_INDONESIAN).send({ url: 'http://example.com' }).expect(400);
      expect(res.body.error.message).toBe(
        'Link harus berupa alamat https:// lengkap, paling banyak 2.000 karakter, tanpa nama pengguna atau kata sandi.',
      );
    });
  });

  describe('who may write (positive and negative, per role)', () => {
    it.each(WRITERS)('P19.21-T3 AC-6 positive: %s uploads a PowerPoint and sets a link', async (_n, who) => {
      const attached = await upload('proof', 'deck.pptx', 'application/vnd.openxmlformats-officedocument.presentationml.presentation', who);
      expect(attached.status).toBe(200);
      session.current = who;
      await http().put(`${PITCH}/howtojoin/link`).send({ url: VIDEO_LINK }).expect(200);
      expect((await rows()).map((r) => r.slot)).toEqual(['howtojoin', 'proof']);
    });

    it.each(NOT_WRITERS)('P19.21-T3 AC-6 negative: %s is refused the upload and the link at the guard, nothing written', async (_n, who) => {
      session.current = who;
      await http().post(`${PITCH}/uploads`).send({ filename: 'deck.pptx', mimeType: 'application/vnd.ms-powerpoint', bytes: 1 }).expect(403);
      await http().put(`${PITCH}/faq/link`).send({ url: VIDEO_LINK }).expect(403);
      expect(await rows()).toEqual([]);
    });

    it('P19.21-T3 AC-6 negative: a Super Admin outside any KPM is refused — there is no office', async () => {
      session.current = SUPER_ADMIN;
      expect((await http().put(`${PITCH}/faq/link`).send({ url: VIDEO_LINK })).status).toBe(403);
      expect(await rows()).toEqual([]);
    });
  });

  describe('across offices', () => {
    it('P19.21-T3 AC-6 another office’s Owner writes a link into their own office only, and cannot reach this one’s file', async () => {
      await upload('proof', 'deck.docx', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document');
      const ourKey = (await rows())[0].storageKey as string;

      session.current = OTHER_OWNER;
      await http().put(`${PITCH}/proof/link`).send({ url: VIDEO_LINK }).expect(200);
      // Their attach naming our file is 404 — indistinguishable from a key nobody signed.
      expect((await http().put(`${PITCH}/faq`).send({ storageKey: ourKey }).expect(404)).body.error.code).toBe('NOT_FOUND');

      const byOffice = Object.fromEntries((await rows()).map((r) => [r.kpmId, r]));
      expect(byOffice[FIXTURE_KPM]).toMatchObject({ slot: 'proof', storageKey: ourKey, linkUrl: null });
      expect(byOffice[OTHER_KPM]).toMatchObject({ slot: 'proof', storageKey: null, linkUrl: VIDEO_LINK });

      session.current = OWNER;
      const ours = await http().get(READ).expect(200);
      expect(ours.body.slots.find((s: { slot: string }) => s.slot === 'proof')).toMatchObject({ link: null, file: { name: 'deck.docx' } });
    });
  });

  describe('the link rule, as a function', () => {
    it('P19.21-T3 AC-6 keeps an https address as typed, trimmed; refuses anything else', () => {
      expect(pitchLinkOf(` ${VIDEO_LINK} `)).toBe(VIDEO_LINK);
      expect(pitchLinkOf('https://drive.google.com/file/d/1/view?usp=sharing')).toBe('https://drive.google.com/file/d/1/view?usp=sharing');
      for (const bad of [null, 42, '', 'ftp://x.y/z', 'https://', 'https://a:b@x.y', '//example.com']) {
        expect([bad, pitchLinkOf(bad)]).toEqual([bad, null]);
      }
      expect(pitchLinkOf(`https://x.co/${'a'.repeat(RECRUITMENT.PITCH_LINK_MAX_LENGTH - 13)}`)).not.toBeNull();
      expect(pitchLinkOf(`https://x.co/${'a'.repeat(RECRUITMENT.PITCH_LINK_MAX_LENGTH - 12)}`)).toBeNull();
    });
  });
});
