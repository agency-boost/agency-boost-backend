import { INestApplication } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { Test } from '@nestjs/testing';
import mongoose from 'mongoose';
import request from 'supertest';
import { PermissionsGuard } from '@/common/auth/permissions.guard';
import { FixedClock } from '@/common/clock/clock.port';
import { RequestContext } from '@/common/context/request-context';
import { DomainExceptionFilter } from '@/common/errors/error.filter';
import { ROSTER_INVITATION } from '@/domain/constants';
import { up as templateCompany } from '@/migrations/0037-template-company';
import { AuthToken, AuthTokenSchema } from '@/modules/auth/auth-token.schema';
import { PasswordService } from '@/modules/auth/password.service';
import { RateLimiter } from '@/modules/auth/rate-limiter';
import { NotificationTemplate } from '@/modules/notifications/notification.types';
import type { NotificationService } from '@/modules/notifications/notification.service';
import { HierarchyService } from '@/modules/org/hierarchy.service';
import { MembershipHistory, MembershipHistorySchema } from '@/modules/org/membership-history.schema';
import { MembershipHistoryRepository } from '@/modules/org/org.repositories';
import { configModule } from '../../../test/config-module';
import { EVERY_MEMBER, OWNER, productionPipe, session, StubAuth, SUPER_ADMIN } from '../../../test/http-permissions';
import { listenOnLoopback } from '../../../test/listen';
import { clearCollections, startMongo, stopMongo } from '../../../test/mongo';
import { AdminController } from './admin.controller';
import { KpmRequest, KpmRequestSchema } from './kpm-request.schema';
import { KpmRequestService } from './kpm-request.service';
import { OwnerInvitations } from './owner-invitations';
import { TEMPLATE_LIBRARY } from './template-library';
import { TenantService } from './tenant.service';
import { ownerUserIdsOf } from './kpm-owners';

const NOW = new Date('2026-11-05T03:00:00Z');
const DAY = 24 * 60 * 60_000;

/**
 * **A new KPM made with its Owner, and invited by email** (P19.4-T3 AC-6, AC-7, AC-8; ADR-0212; the setup spec's A-R1,
 * A2, A5-1, A5-2; SA UI-014, SA R5), over HTTP: *KPM baru*'s *Pemilik KPM* and *"Kirim undangan … sekarang"*, the
 * Owner who waits with no email, *Ganti pemilik* to a named person, *Kirim ulang undangan*, the states the console reads
 * (*Aktif · Diundang · Belum diundang*), and *Perlu perhatian Anda*'s rows per KPM — each refused to every role an
 * office has and inside a view-as session, and nothing ever sent by WhatsApp.
 *
 * `TenantService`, `OwnerInvitations` and `KpmRequestService` are real, over a real database holding what migration
 * `0037` makes; the mail is a recorder, which is what an invitation is asked to reach.
 */
describe('P19.4-T3 a new KPM with its Owner, invited by email (ADR-0212)', () => {
  let app: INestApplication;
  let wired: ReturnType<typeof configModule>;
  let tenants: TenantService;
  let clock: FixedClock;
  let prudential: string;
  let manulife: string;
  let seq = 0;
  const sent: { userId: string; kpmId?: string | null; templateId: string; payload: Record<string, unknown> }[] = [];
  let notifier: NotificationService;
  const db = () => mongoose.connection.db as mongoose.mongo.Db;
  const col = (name: string) => db().collection(name);
  const tokens = () => mongoose.model(AuthToken.name, AuthTokenSchema);

  beforeAll(async () => {
    await startMongo();
    wired = configModule(NOW);
    clock = new FixedClock(NOW);
    const users = wired.users as never;
    const notifications = { send: async (r: (typeof sent)[number]) => { sent.push(r); } } as unknown as NotificationService;
    notifier = notifications;
    const invitations = new OwnerInvitations(
      new PasswordService(), tokens() as never, notifications, new RateLimiter(clock), wired.memberships, wired.audit, clock,
    );
    tenants = new TenantService(
      wired.kpms as never, wired.companies as never, users,
      mongoose.model(KpmRequest.name, KpmRequestSchema) as never, wired.audit, clock,
      new HierarchyService(
        wired.memberships, wired.kpms as never, users,
        new MembershipHistoryRepository(mongoose.model(MembershipHistory.name, MembershipHistorySchema) as never),
        clock, wired.orgLevels,
      ),
      wired.memberships, wired.orgLevels, wired.provisioning, wired.products, wired.campaigns,
      wired.namedTemplates, invitations, null, notifications,
    );
    const requests = new KpmRequestService(
      mongoose.model(KpmRequest.name, KpmRequestSchema) as never, wired.companies as never, users, tenants,
      wired.audit, clock,
    );
    const moduleRef = await Test.createTestingModule({
      controllers: [AdminController],
      providers: [{ provide: TenantService, useValue: tenants }, { provide: KpmRequestService, useValue: requests }],
    })
      .useMocker(() => ({}))
      .compile();
    app = moduleRef.createNestApplication();
    app.setGlobalPrefix('api');
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

  beforeEach(async () => {
    await clearCollections();
    for (const name of ['companies', 'companyOrgLevels', 'products', 'qualificationRules', 'recruitmentPlaybooks',
      'companyTemplates', 'templates', 'kpms', 'users', 'auditLog', 'kpmRequests', 'activityTypes', 'memberships',
      'membershipHistory', 'authTokens']) {
      await col(name).deleteMany({});
    }
    sent.length = 0;
    clock.set(NOW);
    session.current = SUPER_ADMIN;
    await templateCompany(db(), NOW);
    prudential = String((await tenants.createCompany(SUPER_ADMIN, { name: 'Prudential', slug: 'prudential' }))._id);
    manulife = String((await tenants.createCompany(SUPER_ADMIN, { name: 'Manulife', slug: 'manulife' }))._id);
    for (const [companyId, name] of [[prudential, 'Prudential template'], [manulife, 'Manulife template']]) {
      await wired.templateCopies.importFrom(SUPER_ADMIN, companyId, {
        fromCompanyId: TEMPLATE_LIBRARY.companyId, templateId: TEMPLATE_LIBRARY.defaultTemplateId, name,
      });
    }
  });

  const api = () => request(app.getHttpServer());

  async function account(fullName: string, companyId: string | null, over: Record<string, unknown> = {}) {
    seq += 1;
    const user = await (wired.users as unknown as mongoose.Model<Record<string, unknown>>).create({
      email: `${fullName.toLowerCase().replace(/\W+/g, '.')}@example.test`, passwordHash: 'x', fullName,
      status: 'active', platformRole: 'none', companyId, agentCode: companyId ? String(70000 + seq) : null,
      emailVerifiedAt: NOW, phone: null, lastLoginAt: null, ...over,
    });
    return String(user._id);
  }

  /** A5-1's KPM: 0602 *Bandung Dago*, and its Owner *Wulan Kartika*. */
  const wulan = (over: Record<string, unknown> = {}) => ({
    fullName: 'Wulan Kartika', phone: '0812 7700 6020', email: 'wulan.kartika@example.test', agentCode: '70045001', ...over,
  });
  const newKpm = (over: Record<string, unknown> = {}) => ({
    companyId: prudential, code: '0602', branchName: 'Bandung Dago', owner: wulan(), ...over,
  });
  const kpmsLive = () => col('kpms').countDocuments({ deletedAt: null });
  const kpmRow = (id: string) => col('kpms').findOne({ _id: new mongoose.Types.ObjectId(id) });
  const actions = async () => (await col('auditLog').find({}).sort({ createdAt: 1, _id: 1 }).toArray()).map((r) => r.action);

  describe('KPM baru with its Owner (AC-6)', () => {
    it('P19.4-T3 AC-6 (A5-1) 0602 Bandung Dago with Owner Wulan Kartika: the KPM, her account, and her invitation by email', async () => {
      const res = await api().post('/api/admin/tenants').send(newKpm()).expect(201);
      expect(res.body).toMatchObject({
        code: '0602', branchName: 'Bandung Dago', ownerName: 'Wulan Kartika', invitationSent: true, ownerNotified: false,
      });

      const user = await col('users').findOne({ email: 'wulan.kartika@example.test' });
      // An account with no usable password (nobody holds it), her company, her code, her number as +62…, unverified.
      expect(user).toMatchObject({
        fullName: 'Wulan Kartika', companyId: prudential, agentCode: '70045001', phone: '+6281277006020',
        emailVerifiedAt: null, mustChangePassword: false, platformRole: 'none',
      });
      const kpmId = res.body._id as string;
      // Her KPM's one owner (ADR-0285 §1).
      expect(ownerUserIdsOf(await kpmRow(kpmId) as never)).toEqual([String(user!._id)]);
      expect((await kpmRow(kpmId))).toMatchObject({ pendingOwner: null });
      // The KPM's root AB, joined as an existing agent (ADR-0169 §6), and *Diundang* stamped.
      const membership = await col('memberships').findOne({ kpmId, userId: String(user!._id) });
      expect(membership).toMatchObject({ role: 'ab', status: 'active', leaderId: null, joinedAs: 'existing_agent', invitedAt: NOW });

      // The member invitation's mechanism, worded for an Owner: a one-time reset link alive ROSTER_INVITATION.TTL_DAYS.
      expect(sent).toEqual([{
        userId: String(user!._id), kpmId, templateId: NotificationTemplate.OWNER_INVITATION,
        payload: { token: expect.any(String), fullName: 'Wulan Kartika', office: 'KPM 0602 · Bandung Dago', days: ROSTER_INVITATION.TTL_DAYS },
      }]);
      const token = await tokens().findOne({ userId: String(user!._id) }).lean<{ kind: string; expiresAt: Date; tokenHash: string }>();
      expect(token).toMatchObject({ kind: 'password_reset' });
      expect(token!.expiresAt.getTime() - NOW.getTime()).toBe(ROSTER_INVITATION.TTL_DAYS * DAY);
      expect(new PasswordService().hashToken(sent[0].payload.token as string)).toBe(token!.tokenHash);
      expect(await actions()).toEqual(expect.arrayContaining(['kpm.created', 'kpm.owner_added', 'kpm.owner_invited']));

      // The Owner's card reads *Diundang*, with her WhatsApp number — a number shown, nothing sent by it.
      const read = await api().get(`/api/admin/tenants/${kpmId}`).expect(200);
      expect(read.body).toMatchObject({
        ownerState: 'invited', ownerPhone: '+6281277006020', ownerInvitedAt: NOW.toISOString(), pendingOwner: null,
        memberCount: 1, membersBesidesOwner: 0,
      });
    });

    it('P19.4-T3 AC-6 with Kirim undangan unticked, the Owner is made and nobody is mailed: Belum diundang', async () => {
      const res = await api().post('/api/admin/tenants').send(newKpm({ sendInvitation: false })).expect(201);
      expect(res.body.invitationSent).toBe(false);
      expect(sent).toEqual([]);
      expect(await tokens().countDocuments({})).toBe(0);
      expect((await api().get(`/api/admin/tenants/${res.body._id}`).expect(200)).body)
        .toMatchObject({ ownerState: 'not_invited', ownerInvitedAt: null });
    });

    /*
     * *Changed 2026-11-22 (OD-475):* an existing account the Owner verified is already theirs — they hold its password —
     * so it reads *Aktif* and no link to set a password goes. Until then it was invited, as one that had never signed in.
     */
    it('P19.4-T3 AC-6 OD-475 an existing verified account with the email becomes the Owner: Aktif, no invitation; its number kept', async () => {
      const dewi = await account('Dewi Lestari', prudential, { phone: '+6281100000001' });
      const res = await api().post('/api/admin/tenants')
        .send(newKpm({ owner: wulan({ email: 'dewi.lestari@example.test', fullName: 'Dewi L.', phone: '0812 9999 0000', agentCode: undefined }) }))
        .expect(201);
      expect(res.body).toMatchObject({ ownerUserId: dewi, ownerName: 'Dewi Lestari', invitationSent: false, ownerNotified: true });
      expect(await col('users').countDocuments({})).toBe(1);
      // The person's own field (UI-101): kept where one is on file.
      expect((await col('users').findOne({}))!.phone).toBe('+6281100000001');
      // Told in the app, as *Masukkan* tells a new KPM's owner (OD-442): no link, no email.
      expect(sent).toEqual([{
        userId: dewi, kpmId: res.body._id, templateId: NotificationTemplate.MEMBER_PLACED,
        payload: { kpmName: res.body.branchName, kpmCode: res.body.code },
      }]);
      expect((await api().get(`/api/admin/tenants/${res.body._id}`).expect(200)).body.ownerState).toBe('active');
    });

    it('P19.4-T3 AC-6 an existing account that has signed in is made the Owner with no invitation: Aktif', async () => {
      const dewi = await account('Dewi Lestari', prudential, { lastLoginAt: new Date(NOW.getTime() - DAY) });
      const res = await api().post('/api/admin/tenants').send(newKpm({ owner: wulan({ email: 'dewi.lestari@example.test' }) })).expect(201);
      expect(res.body).toMatchObject({ ownerUserId: dewi, invitationSent: false, ownerNotified: true });
      expect(sent.map((m) => [m.userId, m.templateId])).toEqual([[dewi, NotificationTemplate.MEMBER_PLACED]]);
      expect((await api().get(`/api/admin/tenants/${res.body._id}`).expect(200)).body.ownerState).toBe('active');
    });

    it('OD-442 a notice that cannot be sent is logged and the KPM stands: ownerNotified false', async () => {
      const dewi = await account('Dewi Lestari', prudential, { lastLoginAt: new Date(NOW.getTime() - DAY) });
      const send = jest.spyOn(notifier, 'send').mockRejectedValueOnce(new Error('inbox down'));
      const res = await api().post('/api/admin/tenants').send(newKpm({ owner: wulan({ email: 'dewi.lestari@example.test' }) })).expect(201);
      send.mockRestore();
      expect(res.body).toMatchObject({ ownerUserId: dewi, invitationSent: false, ownerNotified: false });
      expect(await kpmsLive()).toBe(1);
    });

    it('P19.4-T3 AC-6 refuses the Owner before anything is written, as ADR-0191 §5 refuses one: no KPM is left', async () => {
      await account('Victor Gunawan', manulife);
      await account('Dewi Lestari', prudential, { emailVerifiedAt: null });
      const holder = await account('Rina Holder', prudential);
      const holderCode = (await col('users').findOne({ _id: new mongoose.Types.ObjectId(holder) }))!.agentCode as string;
      const cases: [Record<string, unknown>, number, string, Record<string, unknown>?][] = [
        [wulan({ email: 'victor.gunawan@example.test' }), 409, 'TENANT_COMPANY_MISMATCH'],
        [wulan({ email: 'dewi.lestari@example.test' }), 409, 'AUTH_EMAIL_NOT_VERIFIED'],
        [wulan({ agentCode: undefined }), 400, 'VALIDATION_FAILED', { field: 'owner.agentCode' }],
        [wulan({ agentCode: holderCode }), 409, 'AGENT_CODE_TAKEN', { field: 'owner.agentCode', agentCode: holderCode }],
      ];
      for (const [owner, status, code, details] of cases) {
        const res = await api().post('/api/admin/tenants').send(newKpm({ owner })).expect(status);
        expect(res.body.error.code).toBe(code);
        if (details) expect(res.body.error.details).toMatchObject(details);
      }
      expect(await kpmsLive()).toBe(0);
      expect(await col('memberships').countDocuments({})).toBe(0);
      expect(await col('users').countDocuments({})).toBe(3);
      expect(sent).toEqual([]);
    });

    it('P19.4-T3 AC-6 refuses an account that cannot own an office: deactivated, or with no company or no agent code', async () => {
      // ADR-0212 §2, ADR-0191 §3: the Owner is made the KPM's root AB, so their account needs its insurer and its code.
      const gone = await account('Dedi Nonaktif', prudential, { status: 'deactivated' });
      await account('Nina Tanpa', null);
      await account('Oki Tanpa', prudential, { agentCode: null });
      const cases: [string, number, string, Record<string, unknown>, string][] = [
        ['dedi.nonaktif@example.test', 400, 'VALIDATION_FAILED', { field: 'owner.email', userId: gone },
          'That account is deactivated and cannot own an office.'],
        ['nina.tanpa@example.test', 409, 'TENANT_COMPANY_MISMATCH', { userCompanyId: null, kpmCompanyId: prudential },
          'Nina Tanpa\'s account has no company or no agent code, so they cannot own an office. They complete their details first.'],
        ['oki.tanpa@example.test', 409, 'TENANT_COMPANY_MISMATCH', { userCompanyId: prudential, kpmCompanyId: prudential },
          'Oki Tanpa\'s account has no company or no agent code, so they cannot own an office. They complete their details first.'],
      ];
      for (const [email, status, code, details, message] of cases) {
        const res = await api().post('/api/admin/tenants').send(newKpm({ owner: wulan({ email }) })).expect(status);
        expect(res.body.error).toMatchObject({ code, details, message });
      }
      expect(await kpmsLive()).toBe(0);
      expect(await col('memberships').countDocuments({})).toBe(0);
      expect(sent).toEqual([]);
    });

    it('P19.4-T3 AC-6 a blank email is no email — the Owner waits, named — and a blank code is no code for a new account', async () => {
      const waits = await api().post('/api/admin/tenants').send(newKpm({ owner: wulan({ email: '   ' }) })).expect(201);
      expect(waits.body).toMatchObject({ ownerUserId: null, invitationSent: false });
      expect((await kpmRow(waits.body._id))!.pendingOwner).toMatchObject({ fullName: 'Wulan Kartika' });
      expect(await col('users').countDocuments({})).toBe(0);

      const noCode = await api().post('/api/admin/tenants')
        .send(newKpm({ code: '0603', owner: wulan({ agentCode: '   ' }) })).expect(400);
      expect(noCode.body.error).toMatchObject({ code: 'VALIDATION_FAILED', details: { field: 'owner.agentCode' } });
      expect(await kpmsLive()).toBe(1);
    });

    it('P19.4-T3 AC-6 refuses an Owner’s field that is not text 400, naming it — never trimmed into a server fault', async () => {
      for (const [owner, field] of [
        [wulan({ fullName: 42 }), 'fullName'],
        [wulan({ email: 42 }), 'email'],
        [wulan({ agentCode: 70045001 }), 'agentCode'],
      ] as const) {
        const res = await api().post('/api/admin/tenants').send(newKpm({ owner })).expect(400);
        expect(res.body.error.code).toBe('VALIDATION_FAILED');
        expect(JSON.stringify(res.body.error)).toContain(field);
      }
      await api().post('/api/admin/tenants').send(newKpm({ owner: undefined })).expect(201);
      // *Ganti pemilik*'s own route is retired (ADR-0285 §4): only *KPM baru*'s owner is refused here.
      expect(await kpmsLive()).toBe(1);
      expect(await col('users').countDocuments({})).toBe(0);
    });

    it('P19.4-T3 AC-6 the form’s own fields: a name and a WhatsApp number are required, the number an Indonesian one', async () => {
      for (const [owner, field] of [
        [wulan({ fullName: 'W' }), 'owner.fullName'],
        [wulan({ phone: '12345' }), 'owner.phone'],
        [wulan({ phone: undefined }), 'owner.phone'],
        [wulan({ agentCode: '70-04' }), 'owner.agentCode'],
        [wulan({ email: 'not-an-email' }), 'owner.email'],
      ] as const) {
        const res = await api().post('/api/admin/tenants').send(newKpm({ owner })).expect(400);
        expect(JSON.stringify(res.body.error)).toContain(field.split('.')[1]);
      }
      expect(await kpmsLive()).toBe(0);
    });

    it('P19.4-T3 AC-6 an Owner who cannot be set after the KPM is written undoes the KPM and the account made for them', async () => {
      const failing = jest.spyOn(tenants as unknown as { ensureOwnerMembership: () => Promise<void> }, 'ensureOwnerMembership')
        .mockRejectedValueOnce(new Error('the membership write failed'));
      await api().post('/api/admin/tenants').send(newKpm()).expect(500);
      failing.mockRestore();
      expect(await kpmsLive()).toBe(0);
      expect(await col('users').countDocuments({ deletedAt: null })).toBe(0);
      expect(sent).toEqual([]);
      // The code and the address are free again: the same KPM is made the second time.
      expect((await api().post('/api/admin/tenants').send(newKpm()).expect(201)).body.invitationSent).toBe(true);
    });

    it('P19.4-T3 AC-6 "Lewati, nanti saja": no owner at all is a KPM with no Owner, as before', async () => {
      const res = await api().post('/api/admin/tenants').send(newKpm({ owner: undefined })).expect(201);
      expect(res.body).toMatchObject({ ownerUserId: null, invitationSent: false });
      expect((await api().get(`/api/admin/tenants/${res.body._id}`).expect(200)).body)
        .toMatchObject({ ownerState: 'none', pendingOwner: null, memberCount: 0, membersBesidesOwner: 0 });
    });
  });

  describe('an Owner with no email waits, named (AC-6; ADR-0212 §3)', () => {
    it('P19.4-T3 AC-6 keeps the name, number and code on the KPM, makes no account and sends nothing: Belum diundang', async () => {
      const res = await api().post('/api/admin/tenants').send(newKpm({ owner: wulan({ email: undefined }) })).expect(201);
      expect(res.body).toMatchObject({ ownerUserId: null, invitationSent: false });
      expect(await col('users').countDocuments({})).toBe(0);
      expect(sent).toEqual([]);
      const kpmId = res.body._id as string;
      expect((await kpmRow(kpmId))!.pendingOwner).toEqual({ fullName: 'Wulan Kartika', phone: '+6281277006020', agentCode: '70045001' });
      expect((await api().get(`/api/admin/tenants/${kpmId}`).expect(200)).body).toMatchObject({
        ownerState: 'not_invited', ownerPhone: '+6281277006020',
        pendingOwner: { fullName: 'Wulan Kartika', phone: '+6281277006020', agentCode: '70045001' },
      });
      expect(await actions()).toEqual(expect.arrayContaining(['kpm.pending_owner_set']));
      // *Perlu perhatian Anda* names her (SA R5).
      const overview = await api().get('/api/admin/overview').expect(200);
      expect(overview.body.attention[0]).toMatchObject({ title: 'KPM 0602 has no Owner', href: `/admin/tenants/${kpmId}` });
      expect(overview.body.attention[0].detail).toContain('Wulan Kartika');
    });

    it('P19.27-T1 AC-1 an owner added to a KPM whose Owner waits clears the pending record, audited kpm.owner_added', async () => {
      const kpmId = (await api().post('/api/admin/tenants').send(newKpm({ owner: wulan({ email: undefined }) })).expect(201)).body._id;
      const dewi = await account('Dewi Lestari', prudential);
      await tenants.installAccountOwner(RequestContext.platform('root'), kpmId, dewi);
      expect(ownerUserIdsOf(await kpmRow(kpmId) as never)).toEqual([dewi]);
      expect((await kpmRow(kpmId))!.pendingOwner).toBeNull();
      expect(await col('auditLog').findOne({ action: 'kpm.owner_added', targetId: kpmId }))
        .toMatchObject({ before: { owners: [] }, after: { owners: [dewi], userId: dewi } });
    });

    it('P19.27-T1 AC-4 Ganti pemilik is retired: PATCH …/owner answers 404 and writes nothing (ADR-0285 §4)', async () => {
      const kpmId = (await api().post('/api/admin/tenants').send(newKpm({ owner: wulan({ email: undefined }) })).expect(201)).body._id;
      await api().patch(`/api/admin/tenants/${kpmId}/owner`).send({ owner: wulan({ email: 'wulan@bandung.test' }) }).expect(404);
      expect((await kpmRow(kpmId))!.pendingOwner).toMatchObject({ fullName: 'Wulan Kartika' });
      expect(await col('users').countDocuments({})).toBe(0);
    });
  });

  /*
   * *Kirim ulang undangan* by email (`POST /admin/tenants/:id/owner/invitation`) is retired by P19.23-T2 (ADR-0277 §3;
   * OD-420): the Owner is invited by WhatsApp — a claim link for an Owner who waits, the password link for an account
   * never signed in (`owner-claims.int.spec.ts`) — and the email invitation goes once, when an Owner is named with one.
   */

  describe('the KPM code (AC-7; A5-2)', () => {
    it('P19.4-T3 AC-7 code 0417 refuses with “Kode 0417 sudah dipakai KPM lain di Prudential.”, naming the KPM, writing nothing', async () => {
      await tenants.createKpm(SUPER_ADMIN, { companyId: prudential, code: '0417', branchName: 'Gading Serpong' });
      const res = await api().post('/api/admin/tenants').set('Accept-Language', 'id')
        .send(newKpm({ code: '0417' })).expect(409);
      expect(res.body.error.code).toBe('TENANT_CODE_TAKEN');
      expect(res.body.error.message).toContain('Kode 0417 sudah dipakai KPM lain di Prudential');
      expect(res.body.error.message).toBe('Kode 0417 sudah dipakai KPM lain di Prudential: KPM 0417 · Gading Serpong.');
      expect(await col('users').countDocuments({})).toBe(0);
      expect(sent).toEqual([]);
      // Unique per company (OD-246): Manulife's 0417 is free.
      await api().post('/api/admin/tenants').send(newKpm({ companyId: manulife, code: '0417', owner: undefined })).expect(201);
    });
  });

  describe('Perlu perhatian Anda (AC-8; SA R5)', () => {
    it('P19.4-T3 AC-8 lists “KPM {code} belum punya anggota” until a member besides the Owner exists, and clears', async () => {
      const kpmId = (await api().post('/api/admin/tenants').send(newKpm()).expect(201)).body._id as string;
      const before = await api().get('/api/admin/overview').set('Accept-Language', 'id').expect(200);
      expect(before.body.attention.map((a: { title: string }) => a.title)).toEqual(['KPM 0602 belum punya anggota']);
      // A member besides the Owner — imported by the Owner, here written as the import writes one.
      const agent = await account('Bayu Agent', prudential);
      await tenants['hierarchy'].create(RequestContext.superAdminInTenant('root', kpmId), {
        userId: agent, role: 'AGENT', leaderId: (await col('memberships').findOne({ kpmId }))!._id.toString(), status: 'active',
        joining: { joinedAs: 'existing_agent' },
      });
      const after = await api().get('/api/admin/overview').expect(200);
      expect(after.body.attention).toEqual([]);
      expect((await api().get(`/api/admin/tenants/${kpmId}`).expect(200)).body).toMatchObject({ memberCount: 2, membersBesidesOwner: 1 });
    });

    it('P19.4-T3 AC-8 an archived KPM is nobody’s to set up, and is not listed', async () => {
      const kpmId = (await api().post('/api/admin/tenants').send(newKpm({ owner: undefined })).expect(201)).body._id as string;
      await api().patch(`/api/admin/tenants/${kpmId}/status`).send({ status: 'archived' }).expect(200);
      expect((await api().get('/api/admin/overview').expect(200)).body.attention).toEqual([]);
    });
  });

  describe('who may (AC-6; ADR-0206 §1)', () => {
    const routes = (_kpmId: string) => [
      ['POST /admin/tenants with an owner', () => api().post('/api/admin/tenants').send(newKpm({ code: '0999' }))],
    ] as const;

    it.each(EVERY_MEMBER)('P19.4-T3 AC-6 refuses %s every route, writing and sending nothing', async (_who, role) => {
      const kpmId = (await api().post('/api/admin/tenants').send(newKpm()).expect(201)).body._id as string;
      sent.length = 0;
      session.current = role;
      for (const [, call] of routes(kpmId)) {
        const res = await call().expect(403);
        expect(res.body.error.code).toBe('PERM_DENIED');
      }
      expect(await kpmsLive()).toBe(1);
      expect(sent).toEqual([]);
    });

    it('P19.4-T3 AC-6 refuses a view-as session — the Super Admin looking as an Owner — every route', async () => {
      const kpmId = (await api().post('/api/admin/tenants').send(newKpm()).expect(201)).body._id as string;
      sent.length = 0;
      const membership = OWNER.membership!;
      session.current = new RequestContext('u-owner', 'none', membership, 'root', null, false, true);
      for (const [, call] of routes(kpmId)) await call().expect(403);
      expect(sent).toEqual([]);
    });

    it('P19.4-T3 AC-6 the Super Admin holds every route', async () => {
      const kpmId = (await api().post('/api/admin/tenants').send(newKpm({ owner: undefined })).expect(201)).body._id as string;
      // P19.27 (ADR-0285 §4): *Ganti pemilik* is retired too — owners are added inside the KPM.
      await api().patch(`/api/admin/tenants/${kpmId}/owner`).send({ owner: wulan({ email: 'w@kpm.test' }) }).expect(404);
      // P19.23-T2 (ADR-0277 §3): the email resend is retired, and its address answers 404 like any that does not exist.
      await api().post(`/api/admin/tenants/${kpmId}/owner/invitation`).expect(404);
    });
  });
});
