import { INestApplication } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { Test } from '@nestjs/testing';
import mongoose from 'mongoose';
import request from 'supertest';
import { PermissionsGuard } from '@/common/auth/permissions.guard';
import { ViewOnlySessionGuard } from '@/common/auth/view-only-session.guard';
import { FixedClock } from '@/common/clock/clock.port';
import { RequestContext } from '@/common/context/request-context';
import { DomainExceptionFilter } from '@/common/errors/error.filter';
import { TEMPORARY_PASSWORD } from '@/domain/constants';
import { AuditLog, AuditLogSchema } from '@/modules/audit/audit-log.schema';
import { AuditService } from '@/modules/audit/audit.service';
import { AuthToken, AuthTokenSchema } from '@/modules/auth/auth-token.schema';
import { PasswordService } from '@/modules/auth/password.service';
import { CompanyOrgLevel, CompanyOrgLevelSchema } from '@/modules/tenants/company-org-level.schema';
import { Company, CompanySchema } from '@/modules/tenants/company.schema';
import { Kpm, KpmSchema } from '@/modules/tenants/kpm.schema';
import { OrgLevelService } from '@/modules/tenants/org-level.service';
import { User, UserSchema } from '@/modules/users/user.schema';
import {
  AAB, AB, ADMIN, AGENT, declaredPermissions, FIXTURE_KPM, OWNER, productionPipe, session, StubAuth, SUPER_ADMIN,
} from '../../../test/http-permissions';
import { listenOnLoopback } from '../../../test/listen';
import { clearCollections, seedLadder, startMongo, stopMongo } from '../../../test/mongo';
import { ownersOf } from '../../../test/owners';
import { readPdf, type ReadPdf } from '../../../test/pdf-text';
import { MembershipRepository } from './membership.repository';
import { Membership, MembershipSchema } from './membership.schema';
import { TemporaryPasswordsController } from './temporary-passwords.controller';
import { SHEET_WORDS } from './temporary-passwords.layout';
import { TemporaryPasswordsService } from './temporary-passwords.service';

const NOW = new Date('2026-11-22T03:00:00Z');
const KPM_B = '66f0000000000000000000b1';

/** A PDF answered over HTTP, read whole as bytes. */
const binary = (res: request.Response, done: (err: Error | null, body: Buffer) => void) => {
  const stream = res as unknown as NodeJS.ReadableStream;
  const chunks: Buffer[] = [];
  stream.on('data', (chunk: Buffer) => chunks.push(chunk));
  stream.on('end', () => done(null, Buffer.concat(chunks)));
};

/**
 * Each person's row on the sheet, by email, read off the page's lines (`No · NAMA · Peran · Kode agen · Email · Password`):
 * the address is the token with an `@`, the password the one after it, the code and the rung the two before it, and the
 * name everything between the number and the rung.
 */
function rowsOf(pdf: ReadPdf): Map<string, { no: number; name: string; role: string; code: string; password: string }> {
  const rows = new Map<string, { no: number; name: string; role: string; code: string; password: string }>();
  for (const page of pdf.pages) {
    for (const line of page.text.split('\n')) {
      const words = line.split(' ');
      const at = words.findIndex((w) => w.includes('@'));
      if (at < 3 || !/^\d+$/.test(words[0])) continue;
      rows.set(words[at], {
        no: Number(words[0]), name: words.slice(1, at - 2).join(' '), role: words[at - 2], code: words[at - 1], password: words[at + 1],
      });
    }
  }
  return rows;
}

/**
 * ***Unduh akun & password (PDF)*** **over HTTP** (P19.30-T1 AC-1 to AC-4, AC-6's count; T2 AC-2's narrowing;
 * [ADR-0288](../../../../docs/04-adr/0288-a-kpm-may-hand-out-temporary-passwords-in-one-pdf-and-each-person-chooses-their-own-at-first-sign-in.md)).
 *
 * KPM A: its Owner and its Admin (both signed in), Budi (imported, never signed in), Ani (on a temporary password, signed
 * in once with it), Citra (never signed in, her address proven: her own), a test account, a Super Admin's account, a
 * pending and a removed member. KPM B: one imported member. The sign-in itself, with the real `AuthGuard`, is
 * `auth.e2e.int.spec.ts`'s (*temporary passwords*).
 */
describe('the Akun & password PDF (P19.30-T1, ADR-0288)', () => {
  let app: INestApplication;
  let users: mongoose.Model<User>;
  let memberships: mongoose.Model<Membership>;
  let kpms: mongoose.Model<Kpm>;
  let tokens: mongoose.Model<AuthToken>;
  let audit: mongoose.Model<AuditLog>;
  const passwords = new PasswordService();
  const clock = new FixedClock(NOW);
  const SUPER_ADMIN_IN_A = RequestContext.superAdminInKpm(SUPER_ADMIN, FIXTURE_KPM);

  beforeAll(async () => {
    await startMongo();
    users = mongoose.model(User.name, UserSchema) as never;
    memberships = mongoose.model(Membership.name, MembershipSchema) as never;
    kpms = mongoose.model(Kpm.name, KpmSchema) as never;
    tokens = mongoose.model(AuthToken.name, AuthTokenSchema) as never;
    audit = mongoose.model(AuditLog.name, AuditLogSchema) as never;
    const companies = mongoose.model(Company.name, CompanySchema);
    const auditService = new AuditService(audit as never);
    const orgLevels = new OrgLevelService(
      mongoose.model(CompanyOrgLevel.name, CompanyOrgLevelSchema) as never, companies as never, kpms as never, auditService, clock,
    );
    const service = new TemporaryPasswordsService(
      new MembershipRepository(memberships as never), users as never, kpms as never, companies as never, tokens as never,
      passwords, orgLevels, auditService, clock,
      { get: (key: string) => (key === 'APP_ORIGIN' ? 'https://staging.agencyboost.id' : undefined) } as never,
    );
    const moduleRef = await Test.createTestingModule({
      controllers: [TemporaryPasswordsController],
      providers: [{ provide: TemporaryPasswordsService, useValue: service }],
    }).compile();
    app = moduleRef.createNestApplication();
    app.useGlobalPipes(productionPipe());
    app.useGlobalFilters(new DomainExceptionFilter());
    app.useGlobalGuards(new StubAuth(), new ViewOnlySessionGuard(app.get(Reflector)), new PermissionsGuard(app.get(Reflector)));
    await app.init();
    await listenOnLoopback(app);
  });

  afterAll(async () => {
    await app.close();
    await stopMongo();
  });

  let seq = 0;
  let companyId = '';
  const ids: Record<string, string> = {};
  const m: Record<string, string> = {};
  let ownerSession: RequestContext;
  let adminSession: RequestContext;

  async function account(key: string, fullName: string, over: Record<string, unknown> = {}) {
    seq += 1;
    const u = await users.create({
      email: `${key}@kpm.test`, passwordHash: await passwords.hash('their own password'), fullName, status: 'active',
      platformRole: 'none', companyId, agentCode: `${70000 + seq}`, lastLoginAt: null, emailVerifiedAt: null,
      mustChangePassword: false, ...over,
    });
    ids[key] = String(u._id);
    return ids[key];
  }
  async function member(key: string, kpmId: string, role: 'ab' | 'aab' | 'agent', over: Record<string, unknown> = {}) {
    seq += 1;
    const [row] = await memberships.insertMany([{
      kpmId, userId: ids[key], role, status: 'active', agentCode: `${70000 + seq}`, agentSeq: seq, leaderCode: `L${seq}`,
      orgLevelId: 'lvl', orgLevelCode: role.toUpperCase(), leaderId: null, ancestorIds: [], depth: 0, deletedAt: null, ...over,
    }]);
    m[key] = String(row._id);
    return m[key];
  }

  beforeEach(async () => {
    await clearCollections();
    seq = 0;
    const company = await mongoose.model(Company.name).create({ name: 'Prudential', slug: `prudential-${Math.random()}` });
    companyId = String(company._id);
    await seedLadder(companyId);
    const signedIn = { lastLoginAt: new Date('2026-11-20T02:00:00Z'), emailVerifiedAt: new Date('2026-11-01T02:00:00Z') };
    await account('owner', 'Yohanes Saputra', signedIn);
    await account('admin', 'Sinta Maharani', signedIn);
    await account('budi', 'budi  santoso');
    await account('ani', 'Ani Lestari', { mustChangePassword: true, lastLoginAt: new Date('2026-11-21T02:00:00Z') });
    await account('citra', 'Citra Dewi', { emailVerifiedAt: new Date('2026-11-10T02:00:00Z') });
    await account('tes', 'FMT Tes Impor', { testAccount: true });
    await account('root', 'Root Admin', { platformRole: 'super_admin' });
    await account('pending', 'Pending Person');
    await account('gone', 'Gone Person');
    await account('memberB', 'Lina Marlina');
    await kpms.create([
      { _id: FIXTURE_KPM, companyId, code: '0602', branchName: 'PruDynamic', status: 'active', timezone: 'Asia/Jakarta', owners: ownersOf(ids.owner), deletedAt: null },
      { _id: KPM_B, companyId, code: '0555', branchName: 'Kelapa Gading Branch', status: 'active', timezone: 'Asia/Jakarta', owners: [], deletedAt: null },
    ] as never);
    await member('owner', FIXTURE_KPM, 'ab');
    await member('admin', FIXTURE_KPM, 'aab');
    await member('budi', FIXTURE_KPM, 'agent');
    await member('ani', FIXTURE_KPM, 'aab');
    await member('citra', FIXTURE_KPM, 'agent');
    await member('tes', FIXTURE_KPM, 'agent', { testAccount: true });
    await member('root', FIXTURE_KPM, 'agent');
    await member('pending', FIXTURE_KPM, 'agent', { status: 'pending' });
    await member('gone', FIXTURE_KPM, 'agent', { status: 'removed' });
    await member('memberB', KPM_B, 'agent');
    // Ani's session from her temporary password: the next PDF ends it.
    await tokens.create({ userId: ids.ani, kind: 'refresh', tokenHash: 'h-ani', familyId: 'f-ani', expiresAt: new Date('2026-12-30T00:00:00Z') });
    const as = (base: RequestContext, key: string) => new RequestContext(ids[key], 'none', { ...base.membership!, membershipId: m[key] });
    ownerSession = as(OWNER, 'owner');
    adminSession = as(ADMIN, 'admin');
    session.current = ownerSession;
  });

  const api = () => request(app.getHttpServer());
  const download = (body: Record<string, unknown> = {}) =>
    api().post('/members/temporary-passwords').send(body).buffer(true).parse(binary);
  const hashOf = async (key: string) => (await users.findById(ids[key]).select('+passwordHash').lean<{ passwordHash: string }>())!.passwordHash;

  it('P19.30-T1 AC-3 both routes declare member:issue_temporary_password', () => {
    expect(declaredPermissions(TemporaryPasswordsController)).toEqual({
      preview: 'member:issue_temporary_password', issue: 'member:issue_temporary_password',
    });
  });

  describe('who is listed (AC-1)', () => {
    it('P19.30-T1 AC-1 the preview counts every active member whose account is not yet theirs, and issues nothing', async () => {
      const before = await hashOf('budi');
      const res = await api().post('/members/temporary-passwords/preview').send({}).expect(200);
      // Budi (never signed in) and Ani (on a temporary password); never the Owner, the Admin, Citra (her own), the
      // test account, the Super Admin's account, the pending or the removed member, or KPM B's.
      expect(res.body).toMatchObject({ count: 2 });
      expect(await hashOf('budi')).toBe(before);
      expect(await audit.countDocuments({})).toBe(0);
    });

    it('P19.30-T1 AC-1 the PDF lists exactly those two, by name, each with a fresh password that signs in', async () => {
      const res = await download().expect(200);
      expect(res.headers['content-type']).toBe('application/pdf');
      expect(res.headers['content-disposition']).toBe(
        'attachment; filename="Akun-password-PruDynamic-2026-11-22.pdf"; filename*=UTF-8\'\'Akun-password-PruDynamic-2026-11-22.pdf',
      );
      expect(res.headers['cache-control']).toBe('no-store, private');
      const rows = rowsOf(readPdf(res.body as Buffer));
      expect([...rows.keys()]).toEqual(['ani@kpm.test', 'budi@kpm.test']);
      expect(rows.get('budi@kpm.test')).toMatchObject({ name: 'BUDI SANTOSO', role: 'Agent' });
      expect(rows.get('ani@kpm.test')).toMatchObject({ name: 'ANI LESTARI', role: 'AAB' });
      for (const key of ['budi', 'ani'] as const) {
        const { password } = rows.get(`${key}@kpm.test`)!;
        expect(password).toHaveLength(TEMPORARY_PASSWORD.LENGTH);
        expect(password).not.toMatch(/[0O1lI]/);
        // Only the hash is written — the auth module's Argon2id — with the gate set.
        const stored = await users.findById(ids[key]).select('+passwordHash').lean<{ passwordHash: string; mustChangePassword: boolean }>();
        expect(stored!.passwordHash).toMatch(/^\$argon2id\$/);
        expect(stored!.passwordHash).not.toContain(password);
        expect(stored!.mustChangePassword).toBe(true);
        await expect(passwords.verify(stored!.passwordHash, password)).resolves.toBe(true);
      }
    });

    it('P19.30-T1 AC-1 an account that is its person’s own, a test account and a Super Admin are never touched', async () => {
      const before = Object.fromEntries(await Promise.all(['owner', 'admin', 'citra', 'tes', 'root', 'pending', 'gone', 'memberB']
        .map(async (key) => [key, await hashOf(key)] as const)));
      await download().expect(200);
      for (const [key, hash] of Object.entries(before)) expect([key, await hashOf(key)]).toEqual([key, hash]);
      expect(await users.countDocuments({ mustChangePassword: true })).toBe(2);
    });

    it('P19.30-T1 AC-1 a download ends the sessions of the people it lists — an older PDF and what it signed in both go', async () => {
      await download().expect(200);
      expect(await tokens.findOne({ userId: ids.ani }).lean()).toMatchObject({ revokedReason: 'temporary password issued' });
    });

    it('P19.30-T1 AC-1 a second download issues fresh passwords: the first PDF’s no longer sign in', async () => {
      const first = rowsOf(readPdf((await download().expect(200)).body as Buffer)).get('budi@kpm.test')!.password;
      const second = rowsOf(readPdf((await download().expect(200)).body as Buffer)).get('budi@kpm.test')!.password;
      expect(second).not.toBe(first);
      const hash = await hashOf('budi');
      await expect(passwords.verify(hash, first)).resolves.toBe(false);
      await expect(passwords.verify(hash, second)).resolves.toBe(true);
    });

    it('P19.30-T1 AC-5 a person who has chosen their own password is left out of the next PDF', async () => {
      await download().expect(200);
      // Budi signs in and chooses his own: the change-password route clears the flag (auth.e2e.int.spec.ts walks it).
      await users.updateOne({ _id: ids.budi }, { $set: { mustChangePassword: false, lastLoginAt: NOW, passwordHash: await passwords.hash('budi chose this') } });
      expect((await api().post('/members/temporary-passwords/preview').send({}).expect(200)).body).toMatchObject({ count: 1 });
      const rows = rowsOf(readPdf((await download().expect(200)).body as Buffer));
      expect([...rows.keys()]).toEqual(['ani@kpm.test']);
      await expect(passwords.verify(await hashOf('budi'), 'budi chose this')).resolves.toBe(true);
    });

    it('P19.30-T2 AC-2 membershipIds narrow it to those memberships; one already its person’s own is simply not listed', async () => {
      expect((await api().post('/members/temporary-passwords/preview').send({ membershipIds: [m.budi, m.citra] }).expect(200)).body)
        .toMatchObject({ count: 1 });
      const rows = rowsOf(readPdf((await download({ membershipIds: [m.budi, m.citra] }).expect(200)).body as Buffer));
      expect([...rows.keys()]).toEqual(['budi@kpm.test']);
      expect((await users.findById(ids.ani).lean())!.mustChangePassword).toBe(true);
      const row = await audit.findOne({ action: 'member.temporary_passwords_issued' }).lean<{ after: Record<string, unknown> }>();
      expect(row!.after).toEqual({ count: 1, membershipIds: [m.budi], narrowed: true });
    });

    it('P19.30-T1 AC-6 nobody left to list: the preview says 0, and a download is refused with nothing issued', async () => {
      await users.updateMany({ _id: { $in: [ids.budi, ids.ani] } }, { $set: { mustChangePassword: false, lastLoginAt: NOW } });
      expect((await api().post('/members/temporary-passwords/preview').send({}).expect(200)).body).toMatchObject({ count: 0 });
      const res = await api().post('/members/temporary-passwords').send({}).expect(400);
      expect(res.body.error).toMatchObject({ code: 'VALIDATION_FAILED', details: { listed: 0 } });
      expect(await audit.countDocuments({})).toBe(0);
    });

    it('P19.30-T1 AC-1 a malformed list of memberships is 400, never an operator handed to the read', async () => {
      for (const body of [{ membershipIds: [] }, { membershipIds: ['nope'] }, { membershipIds: { $ne: null } }, { other: 1 }]) {
        const res = await api().post('/members/temporary-passwords/preview').send(body).expect(400);
        expect(res.body.error.code).toBe('VALIDATION_FAILED');
      }
    });
  });

  describe('the PDF (AC-2)', () => {
    let pdf: ReadPdf;
    beforeEach(async () => {
      // Enough people for three pages, so the header row and the footer are seen to repeat.
      for (let i = 0; i < 60; i += 1) {
        await account(`p${i}`, `Peserta ${String(i).padStart(2, '0')}`);
        await member(`p${i}`, FIXTURE_KPM, 'agent');
      }
      pdf = readPdf((await download().expect(200)).body as Buffer);
    });

    it('P19.30-T1 AC-2 the head: the KPM, its company, the date and the confidential line, with where to sign in', () => {
      const first = pdf.pages[0].text;
      expect(first.split('\n')[0]).toBe('Akun & password');
      expect(first).toContain('PruDynamic · Prudential · 22 November 2026 · 62 akun');
      expect(first).toContain(SHEET_WORDS.confidential);
      expect(SHEET_WORDS.confidential).toBe('Rahasia — bagikan ke masing-masing orang saja. Password wajib diganti saat pertama masuk.');
      expect(first).toContain('Masuk di staging.agencyboost.id/login dengan email dan password di bawah ini.');
      expect(pdf.info.Title).toBe('Akun & password PruDynamic');
    });

    it('P19.30-T1 AC-2 every page repeats the table’s header and carries “<KPM> · Akun & password · hal. x / n”', () => {
      expect(pdf.pages.length).toBeGreaterThanOrEqual(2);
      pdf.pages.forEach((page, i) => {
        const lines = page.text.split('\n');
        expect(lines).toContain('NO NAMA PERAN KODE AGEN EMAIL PASSWORD');
        expect(lines[lines.length - 1]).toBe(`PruDynamic · Akun & password · hal. ${i + 1} / ${pdf.pages.length}`);
      });
      // Every person once, numbered 1 to 62, by name.
      const rows = [...rowsOf(pdf).values()];
      expect(rows.map((r) => r.no)).toEqual(Array.from({ length: 62 }, (_, i) => i + 1));
      expect(rows.map((r) => r.name).slice(0, 3)).toEqual(['ANI LESTARI', 'BUDI SANTOSO', 'PESERTA 00']);
    });

    it('P19.30-T1 AC-2 nothing is smaller than 9 pt, and it is set in the app’s Inter', () => {
      const sizes = pdf.pages.flatMap((page) => page.fragments.map((f) => f.size));
      expect(Math.min(...sizes)).toBeGreaterThanOrEqual(TEMPORARY_PASSWORD.PDF_MIN_TEXT_PT);
      const fonts = new Set(pdf.pages.flatMap((page) => page.fragments.map((f) => f.font)));
      for (const font of fonts) expect(font).toMatch(/^Inter/);
    });
  });

  describe('the audit (AC-4)', () => {
    it('P19.30-T1 AC-4 member.temporary_passwords_issued: who, the KPM, the count and the memberships — never a password', async () => {
      const res = await download().expect(200);
      const rows = rowsOf(readPdf(res.body as Buffer));
      const row = await audit.findOne({ action: 'member.temporary_passwords_issued' }).lean<Record<string, unknown>>();
      expect(row).toMatchObject({
        kpmId: FIXTURE_KPM, actorUserId: ids.owner, actorMembershipId: m.owner, targetCollection: 'memberships', targetId: FIXTURE_KPM,
        after: { count: 2, membershipIds: [m.ani, m.budi], narrowed: false },
      });
      const everything = JSON.stringify(await audit.find({}).lean());
      for (const { password } of rows.values()) expect(everything).not.toContain(password);
      expect(everything).not.toMatch(/password"\s*:/i);
    });

    it('P19.30-T1 AC-4 the preview answers a count and nothing else', async () => {
      const res = await api().post('/members/temporary-passwords/preview').send({}).expect(200);
      expect(res.body).toEqual({ count: 2, kpmName: 'PruDynamic', fileName: 'Akun-password-PruDynamic-2026-11-22.pdf' });
    });
  });

  describe('who may (AC-3)', () => {
    it('P19.30-T1 AC-3 the Super Admin inside the KPM downloads it as its Owner, the audit naming them', async () => {
      session.current = SUPER_ADMIN_IN_A;
      expect((await api().post('/members/temporary-passwords/preview').send({}).expect(200)).body).toMatchObject({ count: 2 });
      const rows = rowsOf(readPdf((await download().expect(200)).body as Buffer));
      expect([...rows.keys()]).toEqual(['ani@kpm.test', 'budi@kpm.test']);
      expect(await audit.findOne({ action: 'member.temporary_passwords_issued' }).lean()).toMatchObject({
        kpmId: FIXTURE_KPM, actorUserId: 'root', actorMembershipId: null,
      });
    });

    it('P19.30-T1 AC-3 a KPM Admin is refused PERM_OWNER_ONLY, and nothing is issued', async () => {
      session.current = adminSession;
      for (const path of ['/members/temporary-passwords/preview', '/members/temporary-passwords']) {
        const res = await api().post(path).send({}).expect(403);
        expect(res.body.error.code).toBe('PERM_OWNER_ONLY');
      }
      expect(await users.countDocuments({ mustChangePassword: true })).toBe(1);
    });

    /* A member of the KPM is answered as the owners' other grants answer them — `PERM_OWNER_ONLY`; nobody's member, `PERM_DENIED`. */
    it.each([
      ['an AB', AB, 'PERM_OWNER_ONLY'], ['an AAB', AAB, 'PERM_OWNER_ONLY'], ['an agent', AGENT, 'PERM_OWNER_ONLY'],
      ['the Super Admin outside a KPM', SUPER_ADMIN, 'PERM_DENIED'],
    ] as const)(
      'P19.30-T1 AC-3 %s is refused 403 %s',
      async (_who, ctx, code) => {
        session.current = ctx;
        for (const path of ['/members/temporary-passwords/preview', '/members/temporary-passwords']) {
          const res = await api().post(path).send({}).expect(403);
          expect(res.body.error.code).toBe(code);
        }
        expect(await audit.countDocuments({})).toBe(0);
      },
    );

    it('P19.30-T1 AC-3 a support session — even as the Owner — is refused, and nothing is issued', async () => {
      session.current = new RequestContext(ids.owner, 'none', ownerSession.membership, 'root', null, false, true);
      for (const path of ['/members/temporary-passwords/preview', '/members/temporary-passwords']) {
        const res = await api().post(path).send({}).expect(403);
        expect(res.body.error.code).toMatch(/^PERM_DENIED$|^IMPERSONATION_READ_ONLY$/);
      }
      expect(await users.countDocuments({ mustChangePassword: true })).toBe(1);
      expect(await audit.countDocuments({})).toBe(0);
    });

    it('P19.30-T1 AC-3 another KPM: its memberships are 404 from this one, and its people are never listed', async () => {
      for (const path of ['/members/temporary-passwords/preview', '/members/temporary-passwords']) {
        const res = await api().post(path).send({ membershipIds: [m.memberB] }).expect(404);
        expect(res.body.error.code).toBe('NOT_FOUND');
        // Mixed with this KPM's own, still 404: nothing is issued to anybody.
        await api().post(path).send({ membershipIds: [m.budi, m.memberB] }).expect(404);
      }
      expect((await users.findById(ids.memberB).lean())!.mustChangePassword).toBe(false);
      expect((await users.findById(ids.budi).lean())!.mustChangePassword).toBe(false);
      // The Super Admin inside KPM B reads B's, and never A's.
      session.current = RequestContext.superAdminInKpm(SUPER_ADMIN, KPM_B);
      expect((await api().post('/members/temporary-passwords/preview').send({}).expect(200)).body).toMatchObject({ count: 1 });
      await api().post('/members/temporary-passwords/preview').send({ membershipIds: [m.budi] }).expect(404);
    });
  });
});
