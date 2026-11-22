import { INestApplication } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
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
import type { NotificationService } from '@/modules/notifications/notification.service';
import { HierarchyService } from '@/modules/org/hierarchy.service';
import { MembershipHistory, MembershipHistorySchema } from '@/modules/org/membership-history.schema';
import { MembershipHistoryRepository } from '@/modules/org/org.repositories';
import { configModule } from '../../../test/config-module';
import {
  declaredPermissions, EVERY_MEMBER, OWNER, productionPipe, session, StubAuth, SUPER_ADMIN,
} from '../../../test/http-permissions';
import { listenOnLoopback } from '../../../test/listen';
import { clearCollections, startMongo, stopMongo } from '../../../test/mongo';
import { KpmRequest, KpmRequestSchema } from './kpm-request.schema';
import { OwnerClaims, OWNER_WHATSAPP_LIMIT } from './owner-claims.service';
import { OwnerInvitations } from './owner-invitations';
import { OwnerInvitesController, OwnerWhatsAppInvitationController } from './owner-invites.controller';
import { TEMPLATE_LIBRARY } from './template-library';
import { TenantService } from './tenant.service';
import { ownerUserIdsOf } from './kpm-owners';

const NOW = new Date('2026-11-20T03:00:00Z');
const DAY = 24 * 60 * 60_000;
const APP = 'https://app.agencyboost.test';

/**
 * **The KPM Owner, invited by WhatsApp** (P19.23-T2 AC-3; ADR-0277; OD-420), over HTTP: the Super Admin's *Kirim
 * undangan* — a claim link for an Owner named with no email, the password link for an account that never signed in —
 * the claim link's public banner, and accepting it signed in: single use, a new link replacing the last, the expiry,
 * the checks every Owner meets asked before the link is spent, and who may ask for a link at all.
 *
 * `TenantService`, `OwnerInvitations` and `OwnerClaims` are real, over a real database holding what migration `0037`
 * makes. Nothing is sent: the answer is the link the Super Admin's own WhatsApp carries (`wa.me`, OD-359).
 */
describe('P19.23-T2 AC-3 the KPM Owner invited by WhatsApp (OD-420)', () => {
  let app: INestApplication;
  let wired: ReturnType<typeof configModule>;
  let tenants: TenantService;
  let clock: FixedClock;
  let prudential: string;
  let manulife: string;
  let seq = 0;
  const db = () => mongoose.connection.db as mongoose.mongo.Db;
  const col = (name: string) => db().collection(name);
  const tokens = () => mongoose.model(AuthToken.name, AuthTokenSchema);

  beforeAll(async () => {
    await startMongo();
    wired = configModule(NOW);
    clock = new FixedClock(NOW);
    const users = wired.users as never;
    const notifications = { send: async () => undefined } as unknown as NotificationService;
    const limiter = new RateLimiter(clock);
    const passwords = new PasswordService();
    const invitations = new OwnerInvitations(passwords, tokens() as never, notifications, limiter, wired.memberships, wired.audit, clock);
    tenants = new TenantService(
      wired.kpms as never, wired.companies as never, users,
      mongoose.model(KpmRequest.name, KpmRequestSchema) as never, wired.audit, clock,
      new HierarchyService(
        wired.memberships, wired.kpms as never, users,
        new MembershipHistoryRepository(mongoose.model(MembershipHistory.name, MembershipHistorySchema) as never),
        clock, wired.orgLevels,
      ),
      wired.memberships, wired.orgLevels, wired.provisioning, wired.products, wired.campaigns,
      wired.namedTemplates, invitations,
    );
    const claims = new OwnerClaims(
      wired.kpms as never, wired.companies as never, users, tokens() as never, passwords, wired.memberships, tenants,
      limiter, wired.audit, clock,
    );
    const moduleRef = await Test.createTestingModule({
      controllers: [OwnerWhatsAppInvitationController, OwnerInvitesController],
      providers: [
        { provide: OwnerClaims, useValue: claims },
        { provide: RateLimiter, useValue: limiter },
        { provide: ConfigService, useValue: { get: (key: string) => (key === 'APP_ORIGIN' ? `${APP}/` : undefined) } },
      ],
    }).compile();
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
      email: `${fullName.toLowerCase().replace(/\W+/g, '.')}.${seq}@example.test`, passwordHash: 'x', fullName,
      status: 'active', platformRole: 'none', companyId, agentCode: companyId ? String(70000 + seq) : null,
      emailVerifiedAt: NOW, phone: null, lastLoginAt: null, ...over,
    });
    return String(user._id);
  }

  /** *KPM baru* as the console makes it: a name and a WhatsApp number for the Owner, no email (spec §5). */
  async function pendingKpm(code = '0418') {
    const made = await tenants.createKpm(SUPER_ADMIN, {
      companyId: prudential, code, branchName: 'Serpong Branch',
      owner: { fullName: 'BUDI HARTONO', phone: '+6281234567890' },
    });
    return made._id;
  }

  const invite = (kpmId: string) => api().post(`/api/admin/tenants/${kpmId}/owner/whatsapp-invitation`);
  const tokenOf = (link: string) => link.split('/owner-invite/')[1];
  const kpmRow = async (kpmId: string) => col('kpms').findOne({ _id: new mongoose.Types.ObjectId(kpmId) });
  const signedInAs = (userId: string) => { session.current = new RequestContext(userId, 'none', null); };

  describe('the claim link, for an Owner named with no email', () => {
    it('P19.23-T2 AC-3 answers a one-time link and what the message names, storing only its hash, audited', async () => {
      const kpmId = await pendingKpm();
      const res = await invite(kpmId).expect(200);
      expect(res.body).toEqual({
        kind: 'claim',
        link: expect.stringMatching(new RegExp(`^${APP}/owner-invite/${kpmId}\\.[A-Za-z0-9_-]{32}$`)),
        ownerName: 'BUDI HARTONO', ownerPhone: '+6281234567890',
        kpmName: 'Serpong Branch', kpmCode: '0418', companyName: 'Prudential',
        expiresAt: new Date(NOW.getTime() + ROSTER_INVITATION.TTL_DAYS * DAY).toISOString(),
      });
      const row = await kpmRow(kpmId);
      expect(row?.pendingOwner.invite).toEqual({
        tokenHash: new PasswordService().hashToken(tokenOf(res.body.link)), invitedAt: NOW,
        expiresAt: new Date(NOW.getTime() + ROSTER_INVITATION.TTL_DAYS * DAY), usedAt: null,
      });
      expect(JSON.stringify(row)).not.toContain(tokenOf(res.body.link));
      const audit = await col('auditLog').findOne({ action: 'kpm.owner_invited', targetId: kpmId });
      expect(audit?.after).toEqual({ fullName: 'BUDI HARTONO', channel: 'whatsapp', kind: 'claim', resent: false });
    });

    it('P19.23-T2 AC-3 the KPM reads Diundang from then, and its served Owner carries no hash', async () => {
      const kpmId = await pendingKpm();
      const [before] = await tenants.listAll(SUPER_ADMIN);
      expect(before.ownerState).toBe('not_invited');
      await invite(kpmId).expect(200);
      const [after] = await tenants.listAll(SUPER_ADMIN);
      expect(after.ownerState).toBe('invited');
      expect(after.ownerInvitedAt).toBe(NOW.toISOString());
      expect(after.pendingOwner).toEqual({ fullName: 'BUDI HARTONO', phone: '+6281234567890', agentCode: null });
    });

    it('P19.23-T2 AC-3 a new link replaces the last: the old one opens nothing', async () => {
      const kpmId = await pendingKpm();
      const first = tokenOf((await invite(kpmId).expect(200)).body.link);
      const second = tokenOf((await invite(kpmId).expect(200)).body.link);
      expect(second).not.toBe(first);
      expect((await api().get(`/api/owner-invites/${first}`).expect(404)).body.error.message).toContain('not valid');
      await api().get(`/api/owner-invites/${second}`).expect(200);
      const audit = await col('auditLog').find({ action: 'kpm.owner_invited' }).sort({ _id: 1 }).toArray();
      expect(audit.map((a) => a.after.resent)).toEqual([false, true]);
    });

    it('P19.23-T2 AC-3 the banner is public: the KPM, its company, the Owner named and the expiry — nothing else', async () => {
      const kpmId = await pendingKpm();
      const token = tokenOf((await invite(kpmId).expect(200)).body.link);
      session.current = new RequestContext('job:nobody', 'none', null);
      expect((await api().get(`/api/owner-invites/${token}`).expect(200)).body).toEqual({
        kpmName: 'Serpong Branch', kpmCode: '0418', companyName: 'Prudential', ownerName: 'BUDI HARTONO',
        expiresAt: new Date(NOW.getTime() + ROSTER_INVITATION.TTL_DAYS * DAY).toISOString(),
      });
    });

    it.each([
      ['garbage', 'not-a-token'],
      ['no secret', '66f0000000000000000000a1'],
      ['an unknown KPM', '66f0000000000000000000a1.c2VjcmV0c2VjcmV0c2VjcmV0c2VjcmV0'],
    ])('P19.23-T2 AC-3 a link that opens nothing (%s) is 404 in plain words', async (_what, token) => {
      const res = await api().get(`/api/owner-invites/${token}`).expect(404);
      expect(res.body.error.code).toBe('NOT_FOUND');
      expect(res.body.error.message).toContain('not valid');
    });

    it('P19.23-T2 AC-3 a link past its days has expired, and says so', async () => {
      const kpmId = await pendingKpm();
      const token = tokenOf((await invite(kpmId).expect(200)).body.link);
      clock.set(new Date(NOW.getTime() + ROSTER_INVITATION.TTL_DAYS * DAY));
      expect((await api().get(`/api/owner-invites/${token}`).expect(404)).body.error.message).toContain('expired');
    });

    it('P19.23-T2 AC-3 accepted signed in, the account becomes the Owner — its root AB — and the link is spent', async () => {
      const kpmId = await pendingKpm();
      const token = tokenOf((await invite(kpmId).expect(200)).body.link);
      const budi = await account('Budi Hartono', prudential);
      signedInAs(budi);
      expect((await api().post(`/api/owner-invites/${token}/accept`).expect(200)).body)
        .toEqual({ kpmId, kpmName: 'Serpong Branch' });

      const row = await kpmRow(kpmId);
      expect(ownerUserIdsOf(row as never)).toEqual([budi]);
      expect(row?.pendingOwner).toBeNull();
      const membership = await col('memberships').findOne({ kpmId, userId: budi });
      expect(membership).toMatchObject({ status: 'active', leaderId: null, role: 'ab' });
      // The number the Super Admin typed is kept on an account that had none.
      expect((await col('users').findOne({ _id: new mongoose.Types.ObjectId(budi) }))?.phone).toBe('+6281234567890');
      const audit = await col('auditLog').findOne({ action: 'kpm.owner_added', targetId: kpmId });
      expect(audit).toMatchObject({ kpmId, after: { owners: [budi], userId: budi, via: 'whatsapp_claim', pendingOwner: 'BUDI HARTONO' } });

      // Single use: a second tap, or anybody else, meets *already used*.
      const other = await account('Sari Puspita', prudential);
      signedInAs(other);
      expect((await api().post(`/api/owner-invites/${token}/accept`).expect(404)).body.error.message).toContain('already used');
      expect((await api().get(`/api/owner-invites/${token}`).expect(404)).body.error.message).toContain('already used');
      expect(ownerUserIdsOf(await kpmRow(kpmId) as never)).toEqual([budi]);
    });

    it('P19.23-T2 AC-3 an account of another company is refused before the link is spent, which still works', async () => {
      const kpmId = await pendingKpm();
      const token = tokenOf((await invite(kpmId).expect(200)).body.link);
      signedInAs(await account('Wrong Insurer', manulife));
      expect((await api().post(`/api/owner-invites/${token}/accept`).expect(409)).body.error.code).toBe('TENANT_COMPANY_MISMATCH');
      signedInAs(await account('No Code', null));
      expect((await api().post(`/api/owner-invites/${token}/accept`).expect(409)).body.error.code).toBe('TENANT_COMPANY_MISMATCH');
      expect((await kpmRow(kpmId))?.pendingOwner.invite.usedAt).toBeNull();
      signedInAs(await account('Budi Hartono', prudential));
      await api().post(`/api/owner-invites/${token}/accept`).expect(200);
    });

    it('P19.23-T2 AC-3 an unverified address is refused until it is verified', async () => {
      const kpmId = await pendingKpm();
      const token = tokenOf((await invite(kpmId).expect(200)).body.link);
      signedInAs(await account('Budi Hartono', prudential, { emailVerifiedAt: null }));
      expect((await api().post(`/api/owner-invites/${token}/accept`).expect(409)).body.error.code).toBe('AUTH_EMAIL_NOT_VERIFIED');
      expect(ownerUserIdsOf(await kpmRow(kpmId) as never)).toEqual([]);
      expect(await col('memberships').countDocuments({ kpmId })).toBe(0);
    });

    it('P19.23-T2 AC-3 a KPM given its Owner another way meanwhile answers the link as used', async () => {
      const kpmId = await pendingKpm();
      const token = tokenOf((await invite(kpmId).expect(200)).body.link);
      const picked = await account('Picked By Super Admin', prudential);
      await tenants.installAccountOwner(SUPER_ADMIN, kpmId, picked);
      signedInAs(await account('Budi Hartono', prudential));
      expect((await api().post(`/api/owner-invites/${token}/accept`).expect(404)).body.error.message).toContain('already used');
    });

    it('P19.23-T2 AC-3 an archived KPM is nobody’s to claim', async () => {
      const kpmId = await pendingKpm();
      const token = tokenOf((await invite(kpmId).expect(200)).body.link);
      await tenants.setStatus(SUPER_ADMIN, kpmId, 'archived', 'closed');
      await api().get(`/api/owner-invites/${token}`).expect(404);
    });
  });

  describe('the password link, for an Owner whose account is not theirs yet', () => {
    /**
     * An Owner account the Super Admin made for somebody: never signed in, and no address proven — not theirs yet, so
     * it reads *Belum diundang* and may be sent a link (OD-475). `lastLoginAt` set makes it theirs.
     */
    async function ownedKpm(lastLoginAt: Date | null) {
      const owner = await account('Wulan Kartika', prudential, { phone: '+6281277006020', lastLoginAt, emailVerifiedAt: null });
      const made = await tenants.createKpm(SUPER_ADMIN, { companyId: prudential, code: '0602', branchName: 'Bandung Dago' });
      await tenants.installAccountOwner(SUPER_ADMIN, made._id, owner);
      return { kpmId: made._id, owner };
    }

    it('P19.23-T2 AC-3 hands over the email invitation’s link instead of emailing it, older links revoked', async () => {
      const { kpmId, owner } = await ownedKpm(null);
      await col('authTokens').insertOne({ userId: owner, kind: 'password_reset', tokenHash: 'old', usedAt: null, revokedAt: null, expiresAt: new Date(NOW.getTime() + DAY) });
      const res = await invite(kpmId).expect(200);
      expect(res.body).toMatchObject({
        kind: 'password', ownerName: 'Wulan Kartika', ownerPhone: '+6281277006020', kpmCode: '0602',
        link: expect.stringMatching(new RegExp(`^${APP}/reset-password/[A-Za-z0-9_-]{43}$`)),
      });
      const raw = res.body.link.split('/reset-password/')[1] as string;
      const live = await col('authTokens').find({ userId: owner, revokedAt: null }).toArray();
      expect(live.map((t) => t.tokenHash)).toEqual([new PasswordService().hashToken(raw)]);
      expect((await col('memberships').findOne({ kpmId, userId: owner }))?.invitedAt).toEqual(NOW);
      expect((await col('auditLog').findOne({ action: 'kpm.owner_invited', targetId: kpmId }))?.after)
        .toMatchObject({ userId: owner, channel: 'whatsapp', kind: 'password' });
    });

    it('P19.27-T1 AC-4 Kirim ulang undangan names one of several owners: the second, invited, gets her own password link', async () => {
      const { kpmId, owner } = await ownedKpm(new Date(NOW.getTime() - DAY));
      const sinta = await account('Sinta Maharani', prudential, { phone: '+6281299990000', emailVerifiedAt: null });
      await tenants.installAccountOwner(SUPER_ADMIN, kpmId, sinta);
      // The first owner has signed in: the route with no one named answers as before.
      expect((await invite(kpmId).expect(409)).body.error.details.reason).toBe('signed_in');
      const res = await api().post(`/api/admin/tenants/${kpmId}/owner/whatsapp-invitation`).send({ userId: sinta }).expect(200);
      expect(res.body).toMatchObject({ kind: 'password', ownerName: 'Sinta Maharani', ownerPhone: '+6281299990000' });
      expect((await col('memberships').findOne({ kpmId, userId: sinta }))?.invitedAt).toEqual(NOW);
      expect((await col('memberships').findOne({ kpmId, userId: owner }))?.invitedAt ?? null).toBeNull();
      // Somebody who is not one of its owners is 404, as another KPM's person is; a malformed id 400.
      const stranger = await account('Joko Prasetyo', prudential);
      await api().post(`/api/admin/tenants/${kpmId}/owner/whatsapp-invitation`).send({ userId: stranger }).expect(404);
      await api().post(`/api/admin/tenants/${kpmId}/owner/whatsapp-invitation`).send({ userId: 'nope' }).expect(400);
    });

    it('P19.23-T2 AC-3 an Owner who has signed in is invited to nothing (409 signed_in)', async () => {
      const { kpmId } = await ownedKpm(new Date(NOW.getTime() - DAY));
      const res = await invite(kpmId).expect(409);
      expect(res.body.error).toMatchObject({ code: 'TENANT_OWNER_NOT_INVITABLE', details: { reason: 'signed_in' } });
    });

    it('OD-475 an Owner whose account is already theirs — its address proven, never signed in — is invited to nothing', async () => {
      const { kpmId, owner } = await ownedKpm(null);
      await col('users').updateOne({ _id: new mongoose.Types.ObjectId(owner) }, { $set: { emailVerifiedAt: NOW } });
      const res = await invite(kpmId).expect(409);
      expect(res.body.error).toMatchObject({ code: 'TENANT_OWNER_NOT_INVITABLE', details: { reason: 'signed_in' } });
      expect(res.body.error.message).toContain('already has their own account');
      expect((await col('memberships').findOne({ kpmId, userId: owner }))?.invitedAt ?? null).toBeNull();
    });

    it('P19.23-T2 AC-3 a KPM with nobody named has nobody to invite (409 no_owner); an unknown one is 404', async () => {
      const made = await tenants.createKpm(SUPER_ADMIN, { companyId: prudential, code: '0603', branchName: 'Tangerang' });
      expect((await invite(made._id).expect(409)).body.error.details.reason).toBe('no_owner');
      await invite('66f0000000000000000000ff').expect(404);
      await invite('not-an-id').expect(404);
    });
  });

  describe('who may ask for a link', () => {
    it('P19.23-T2 AC-3 the routes name their permissions', () => {
      expect(declaredPermissions(OwnerWhatsAppInvitationController)).toEqual({ invite: 'kpm:assign_owner' });
      expect(declaredPermissions(OwnerInvitesController)).toEqual({ banner: undefined, accept: 'join_via_code_link_qr' });
    });

    it('P19.23-T2 AC-3 the Super Admin may', async () => {
      await invite(await pendingKpm()).expect(200);
    });

    it.each(EVERY_MEMBER)('P19.23-T2 AC-3 refuses %s, writing nothing', async (_who, role) => {
      const kpmId = await pendingKpm();
      session.current = role;
      expect((await invite(kpmId).expect(403)).body.error.code).toBe('PERM_DENIED');
      expect((await kpmRow(kpmId))?.pendingOwner.invite).toBeUndefined();
    });

    it('P19.23-T2 AC-3 refuses a support session — the Super Admin looking as an Owner — both writes', async () => {
      const kpmId = await pendingKpm();
      session.current = SUPER_ADMIN;
      const token = tokenOf((await invite(kpmId).expect(200)).body.link);
      session.current = new RequestContext('u-owner', 'none', OWNER.membership!, 'root', null, false, true);
      await invite(kpmId).expect(403);
      await api().post(`/api/owner-invites/${token}/accept`).expect(403);
      expect(ownerUserIdsOf(await kpmRow(kpmId) as never)).toEqual([]);
    });

    it(`P19.23-T2 AC-3 at most ${OWNER_WHATSAPP_LIMIT} links an hour for one KPM, then 429`, async () => {
      const kpmId = await pendingKpm();
      for (let i = 0; i < OWNER_WHATSAPP_LIMIT; i += 1) await invite(kpmId).expect(200);
      expect((await invite(kpmId).expect(429)).body.error.code).toBe('AUTH_RATE_LIMITED');
    });
  });
});
