import { INestApplication, ValidationPipe, VersioningType } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { getConnectionToken } from '@nestjs/mongoose';
import { Test } from '@nestjs/testing';
import cookieParser from 'cookie-parser';
import mongoose, { Connection } from 'mongoose';
import request from 'supertest';
// Above AppModule: its import validates the configuration (test/boot-env.ts says why).
import '../../../test/boot-env';
import { AppModule } from '@/app.module';
import { VALIDATION_PIPE_OPTIONS } from '@/bootstrap';
import { Clock, FixedClock } from '@/common/clock/clock.port';
import { validateEnv } from '@/config/env.validation';
import { TokenSigner } from '@/modules/auth/token-signer';
import { seedDemo } from '@/seed/demo';
import { TEST_ACCOUNTS_SEED } from '@/seed/test-accounts-fixture';
import { listenOnLoopback } from '../../../test/listen';
import { startMongo, stopMongo } from '../../../test/mongo';
import { readPdf } from '../../../test/pdf-text';
import { ReportLinkSigner } from './kpm-report.link';
import { ownersOf } from '../../../test/owners';

const RUN_MS = 420_000;
const quiet = () => undefined;
const flat = (s: string) => s.replace(/\s+/g, ' ');

/**
 * **P19.24 — the KPM report on the demo seed, over HTTP** (ADR-0280): the seed run as the command runs it, on 20 November
 * 2026 at 10:00 in Jakarta, then the real application on the same database, signed in as the seed's own people. The
 * report for 0417 is read back as a viewer reads it; the routes refuse what they must refuse.
 */
describe('P19.24 the KPM report on the demo KPM', () => {
  const clock = new FixedClock(new Date('2026-11-20T03:00:00Z'));
  let app: INestApplication;
  let db: Connection;
  const tokens: Record<'sa' | 'owner' | 'admin' | 'agent' | 'otherOwner' | 'core', string> = {
    sa: '', owner: '', admin: '', agent: '', otherOwner: '', core: '',
  };
  let kpm0417 = '';
  let allianzKpm = '';
  const http = () => request(app.getHttpServer());
  const as = (who: keyof typeof tokens) => ({ Authorization: `Bearer ${tokens[who]}` });
  const pdf = (res: request.Response) => readPdf(res.body as Buffer);
  const binary = (res: request.Response, done: (err: Error | null, body: Buffer) => void) => {
    const chunks: Buffer[] = [];
    res.on('data', (c: Buffer) => chunks.push(c));
    res.on('end', () => done(null, Buffer.concat(chunks)));
  };

  beforeAll(async () => {
    await startMongo();
    await seedDemo({ clock, log: quiet });
    const dbName = mongoose.connection.db!.databaseName;
    await mongoose.disconnect();
    // The application on the seeded database (`startMongo`'s, the worker's own), at the seed's clock.
    const config = new ConfigService({ _PROCESS_ENV_VALIDATED: { ...validateEnv({ ...process.env }), MONGODB_DB_NAME: dbName } });
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(ConfigService).useValue(config)
      .overrideProvider(Clock).useValue(clock)
      .compile();
    app = moduleRef.createNestApplication();
    app.use(cookieParser());
    app.useGlobalPipes(new ValidationPipe(VALIDATION_PIPE_OPTIONS));
    app.setGlobalPrefix('api');
    app.enableVersioning({ type: VersioningType.URI, defaultVersion: '1' });
    await app.init();
    await listenOnLoopback(app);
    db = app.get<Connection>(getConnectionToken());

    const users = db.collection('users');
    const signer = app.get(TokenSigner);
    const token = async (email: string) => {
      const u = await users.findOne({ email });
      return signer.sign({ sub: String(u!._id), sid: `kpm-report-${email}` }, 3600);
    };
    tokens.sa = await token('superadmin@agencyboost.test');
    tokens.owner = await token('owner@kpm0417.test');
    tokens.admin = await token('admin@kpm0417.test');
    tokens.agent = await token('rina@kpm0417.test');
    tokens.otherOwner = await token('owner@kpm0555.test');
    // Sari, an AAB the demo tags core leader (`demo.ts`): the Owner's rights in KPM, never the Owner's link (ADR-0280 §5).
    tokens.core = await token('sari@kpm0417.test');
    kpm0417 = String((await db.collection('kpms').findOne({ code: '0417' }))!._id);
    // A KPM of another company, with nobody in it yet: the Super Admin's report reaches every company.
    const allianz = await db.collection('companies').findOne({ name: 'Allianz Life' });
    const made = await db.collection('kpms').insertOne({
      companyId: String(allianz!._id), code: '7001', branchName: 'Allianz Uji Branch', timezone: 'Asia/Jakarta', status: 'active',
      owners: ownersOf(null), pendingOwner: null, deletedAt: null, createdAt: clock.now(), updatedAt: clock.now(),
    });
    allianzKpm = String(made.insertedId);
  }, RUN_MS);

  afterAll(async () => {
    await app?.close();
    await stopMongo();
  });

  const report = (kpmId: string, month: string, who: keyof typeof tokens = 'sa') =>
    http().get(`/api/v1/admin/tenants/${kpmId}/report?month=${month}`).set(as(who)).buffer(true).parse(binary);

  it('P19.24-T1 AC-1 AC-3 the Super Admin gets the demo KPM’s report: an A4 PDF of the template’s sections', async () => {
    const res = await report(kpm0417, '2026-10').expect(200);
    expect(res.headers['content-type']).toMatch(/^application\/pdf/);
    expect(res.headers['content-disposition']).toContain('Laporan-KPM-BSD-City-Branch-2026-10.pdf');
    const file = pdf(res);
    expect(file.pages.length).toBeGreaterThanOrEqual(10);
    expect(file.pages.length).toBeLessThanOrEqual(45);
    const all = flat(file.pages.map((p) => p.text).join('\n'));
    for (const words of [
      'Ringkasan eksekutif', '3 tindakan minggu ini', 'Ringkasan tindakan', 'KPM Overview', 'Performa vs target per AB group',
      'Compliance · 8 item', 'Status per orang', 'Halaman ini bisa dikirim langsung ke', 'Lampiran · Advanced analytics',
    ]) expect([words, all.includes(words)]).toEqual([words, true]);
    file.pages.forEach((p, i) => expect(flat(p.text)).toContain(`BSD City Branch · Prudential · Laporan KPM Oktober 2026 hal. ${i + 1} / ${file.pages.length}`));
    // Nothing about training (§11): no Training card, column or module. A survey's own question that names training — the
    // NPS's, the Kualitatif's *Pelatihan KPM* item — is the survey's words, which the template prints too.
    const compliance = all.slice(all.indexOf('Compliance · 8 item'), all.indexOf('Halaman ini bisa dikirim langsung ke'));
    expect(compliance).not.toMatch(/training|pelatihan|modul/i);
    expect(all.slice(0, all.indexOf('Lampiran · Advanced analytics'))).not.toMatch(/training|pelatihan/i);
    expect(all).not.toContain('Yang bisa diperbaiki');
  }, RUN_MS);

  it('P19.24-T1 AC-2 never counts or names a test account', async () => {
    const all = flat(pdf(await report(kpm0417, '2026-11').expect(200)).pages.map((p) => p.text).join('\n'));
    expect(all).toContain('BSD City Branch');
    for (const account of Object.values(TEST_ACCOUNTS_SEED)) expect(all).not.toContain(account.fullName.toUpperCase());
  }, RUN_MS);

  it('P19.24-T2 AC-2 records every report made in the platform’s log and the KPM’s', async () => {
    const before = await db.collection('auditLog').countDocuments({ action: 'kpm_report.built' });
    await report(kpm0417, '2026-09').expect(200);
    const rows = await db.collection('auditLog').find({ action: 'kpm_report.built' }).sort({ _id: -1 }).limit(2).toArray();
    expect(await db.collection('auditLog').countDocuments({ action: 'kpm_report.built' })).toBe(before + 2);
    expect(rows.map((r) => r.kpmId ?? null).sort()).toEqual([kpm0417, null].sort());
    expect(rows[0].after).toMatchObject({ month: '2026-09' });
  }, RUN_MS);

  it('P19.24-T2 AC-1 a KPM of another company is the Super Admin’s to report on too', async () => {
    const res = await report(allianzKpm, '2026-11').expect(200);
    expect(flat(pdf(res).pages[0].text)).toContain('Allianz Uji Branch');
  }, RUN_MS);

  it('P19.27-T5 AC-1 a KPM with two owners: the link names both, in order of since — Kirim ke owner goes to every owner', async () => {
    const kpm0602 = String((await db.collection('kpms').findOne({ code: '0602' }))!._id);
    const res = await http().post(`/api/v1/admin/tenants/${kpm0602}/report/link`).set(as('sa')).send({ month: '2026-10' }).expect(200);
    expect(res.body.owners.map((o: { name: string }) => o.name)).toEqual(['Yohanes Saputra', 'Sinta Maharani']);
    expect(res.body.ownerName).toBe('Yohanes Saputra');
  });

  it('P19.24-T2 AC-1 an unknown KPM is 404, a month outside the thirteen is 400', async () => {
    await report('66f0000000000000000000ff', '2026-10').expect(404);
    await report('not-an-id', '2026-10').expect(404);
    expect((await report(kpm0417, '2026-12').expect(400)).body).toBeDefined();
    await report(kpm0417, '2025-10').expect(400);
    await report(kpm0417, '2025-11').expect(200);
  }, RUN_MS);

  it('P19.24-T2 AC-1 every other role is refused the report: the Owner, an Admin, an Agent', async () => {
    for (const who of ['owner', 'admin', 'agent'] as const) await report(kpm0417, '2026-10', who).expect(403);
  }, RUN_MS);

  describe('Kirim ke owner', () => {
    let link = '';
    const open = (token: string, who: keyof typeof tokens) =>
      http().get(`/api/v1/kpm-report/shared/${token}`).set(as(who)).buffer(true).parse(binary);

    beforeAll(async () => {
      const res = await http().post(`/api/v1/admin/tenants/${kpm0417}/report/link`).set(as('sa')).send({ month: '2026-10' }).expect(200);
      expect(res.body).toMatchObject({ month: '2026-10', kpmName: 'BSD City Branch', companyName: 'Prudential', ownerName: 'Wilson Tanoto' });
      // P19.27-T5 AC-1 (ADR-0285 §5): every owner, in order of since — the pick-list *Kirim ke owner* offers.
      expect(res.body.owners).toEqual([{ userId: expect.any(String), name: 'Wilson Tanoto', phone: res.body.ownerPhone }]);
      expect(res.body.link).toMatch(/\/laporan-kpm\/[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/);
      link = res.body.link.split('/laporan-kpm/')[1];
    }, RUN_MS);

    it('P19.24-T2 AC-1 the Owner opens the link, and opens it again: it is not spent', async () => {
      for (let i = 0; i < 2; i += 1) {
        const res = await open(link, 'owner').expect(200);
        expect(res.headers['content-type']).toMatch(/^application\/pdf/);
        expect(flat(pdf(res).pages[0].text)).toContain('BSD City Branch');
      }
      await open(link, 'admin').expect(200);
      expect(await db.collection('auditLog').countDocuments({ action: 'kpm_report.link_opened', kpmId: kpm0417 })).toBeGreaterThanOrEqual(3);
      expect(await db.collection('auditLog').countDocuments({ action: 'kpm_report.link_made', kpmId: kpm0417 })).toBe(1);
    }, RUN_MS);

    it('P19.24-T2 AC-1 an Agent is refused, and another KPM’s Owner finds nothing', async () => {
      await open(link, 'agent').expect(403);
      await open(link, 'otherOwner').expect(404);
    }, RUN_MS);

    /*
     * **The link is the Owner's and the Admins'** (ADR-0280 §5; the permission review of 20 November 2026): a core leader
     * holds the Owner's rights in KPM and Pengaturan, not this grant — `403`; the Super Admin inside the KPM passes the
     * grant as its Owner, and the link, made for a member who is the Owner or an Admin, finds nothing for them — `404`
     * (they build the report itself, `GET /admin/tenants/:id/report`).
     */
    it('P19.24-T2 AC-1 a core leader is refused the link (403); the Super Admin inside the KPM finds nothing (404)', async () => {
      await open(link, 'core').expect(403);
      await http().get(`/api/v1/kpm-report/shared/${link}`).set({ ...as('sa'), 'X-Kpm-Id': kpm0417 }).buffer(true).parse(binary)
        .expect(404);
    }, RUN_MS);

    it('P19.24-T2 AC-1 an expired link and an altered one open nothing', async () => {
      const signer = new ReportLinkSigner(process.env.JWT_ACCESS_SECRET!);
      const sa = await db.collection('users').findOne({ email: 'superadmin@agencyboost.test' });
      const old = signer.sign({ kpmId: kpm0417, month: '2026-10', userId: String(sa!._id) }, new Date('2026-11-10T03:00:00Z')).token;
      const expired = await open(old, 'owner').expect(404);
      expect(Buffer.from(expired.body as Buffer).toString('utf8')).toMatch(/kedaluwarsa|expired/);
      await open(`${link.split('.')[0]}.AAAA`, 'owner').expect(404);
    }, RUN_MS);
  });
});
