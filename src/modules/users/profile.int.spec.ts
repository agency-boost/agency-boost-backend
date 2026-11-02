import { INestApplication, VersioningType } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Reflector } from '@nestjs/core';
import { getModelToken } from '@nestjs/mongoose';
import { Test } from '@nestjs/testing';
import mongoose from 'mongoose';
import request from 'supertest';
import { AuthGuard } from '@/common/auth/auth.guard';
import { PermissionsGuard } from '@/common/auth/permissions.guard';
import { Clock, FixedClock } from '@/common/clock/clock.port';
import { DomainExceptionFilter } from '@/common/errors/error.filter';
import { AuthController } from '@/modules/auth/auth.controller';
import { AuthService } from '@/modules/auth/auth.service';
import { ContextResolver } from '@/modules/auth/context-resolver';
import { ImpersonationService } from '@/modules/auth/impersonation.service';
import { RateLimiter } from '@/modules/auth/rate-limiter';
import { Hs256TokenSigner, TokenSigner } from '@/modules/auth/token-signer';
import { ownerSegment, StoragePort, type AssetOwner, type SignedUpload, type StoredObject } from '@/modules/assets/storage.port';
import { CoachResolver } from '@/modules/org/coach-resolver';
import { Membership, MembershipSchema } from '@/modules/org/membership.schema';
import { MembershipRepository } from '@/modules/org/membership.repository';
import { Company, CompanySchema } from '@/modules/tenants/company.schema';
import { Kpm, KpmSchema } from '@/modules/tenants/kpm.schema';
import { listenOnLoopback } from '../../../test/listen';
import { productionPipe } from '../../../test/http-permissions';
import { clearCollections, startMongo, stopMongo } from '../../../test/mongo';
import { AvatarLinks, AvatarService } from './avatar.service';
import { ProfileController } from './profile.controller';
import { ProfileService } from './profile.service';
import { User, UserSchema } from './user.schema';

const NOW = new Date('2026-10-30T03:00:00Z');

/** Storage as the adapter keys it — `<env>/<owner>/<folder>/<ulid>` — holding what a test says arrived. */
class PhotoStorage extends StoragePort {
  objects = new Map<string, StoredObject>();
  signed: { owner: AssetOwner; folder: string; mimeType: string; allowedMimeTypes?: readonly string[]; maxBytes?: number }[] = [];
  private n = 0;
  async createSignedUpload(params: {
    owner: AssetOwner; folder: string; filename: string; mimeType: string; allowedMimeTypes?: readonly string[];
    maxBytes?: number;
  }): Promise<SignedUpload> {
    this.signed.push(params);
    this.n += 1;
    const storageKey = `dev/${ownerSegment(params.owner)}/${params.folder}/01JBX0Q4ZB7Y2M8K3T5W6N9P${String(this.n).padStart(2, '0')}`;
    return {
      uploadUrl: 'https://storage.test/bucket', storageKey, signature: 'sig', expiresAt: NOW,
      fields: { key: storageKey, 'Content-Type': params.mimeType },
    };
  }
  async createSignedUrl(storageKey: string): Promise<string> {
    return `https://signed.test/${storageKey}`;
  }
  async describe(storageKey: string): Promise<StoredObject | null> {
    return this.objects.get(storageKey) ?? null;
  }
  async remove(): Promise<void> {}
  async copy(): Promise<StoredObject> { throw new Error('not here'); }
  async putObject(): Promise<StoredObject & { sent: boolean }> { throw new Error('not here'); }
  /** The bytes the browser sent, as storage would describe them. */
  arrived(storageKey: string, mimeType = 'image/jpeg', bytes = 24_576): void {
    this.objects.set(storageKey, { storageKey, mimeType, bytes });
  }
}

/**
 * ***Profil saya* over HTTP** (UI V1, UI-111): `GET /auth/me/profile` and the photo's three writes, through the real
 * `AuthGuard`, `ContextResolver` and `PermissionsGuard`, a signed token, the real `users`, `memberships`, `kpms` and
 * `companies` rows, and a storage double keyed as the adapter keys.
 *
 * - The photo: signed only as a JPEG of at most 512 KB, under the caller's own `user/<id>/avatar/`; attached only
 *   once storage holds it and it passes again; a key outside their own folder is 404; removed to `null`.
 *   `GET /auth/me` then answers the signed link, never the key. Refused in a support session.
 * - The facts: the insurer and the agent code, the leader in this office, the group by role — and never anybody of
 *   another office (cross-tenant negative), nor somebody who left.
 */
describe('UI-111 Profil saya: GET /auth/me/profile and the photo, over HTTP', () => {
  let app: INestApplication;
  const clock = new FixedClock(NOW);
  const signer = new Hs256TokenSigner('s'.repeat(40), clock);
  const storage = new PhotoStorage();
  let users: mongoose.Model<User>;
  let kpms: mongoose.Model<Kpm>;
  let companies: mongoose.Model<Company>;
  let memberships: mongoose.Model<Membership>;
  let seq = 0;

  beforeAll(async () => {
    await startMongo();
    users = mongoose.model(User.name, UserSchema) as never;
    kpms = mongoose.model(Kpm.name, KpmSchema) as never;
    companies = mongoose.model(Company.name, CompanySchema) as never;
    memberships = mongoose.model(Membership.name, MembershipSchema) as never;

    const moduleRef = await Test.createTestingModule({
      controllers: [AuthController, ProfileController],
      providers: [
        Reflector,
        { provide: Clock, useValue: clock },
        { provide: TokenSigner, useValue: signer },
        { provide: StoragePort, useValue: storage },
        { provide: getModelToken(User.name), useValue: users },
        { provide: getModelToken(Kpm.name), useValue: kpms },
        { provide: getModelToken(Company.name), useValue: companies },
        { provide: getModelToken(Membership.name), useValue: memberships },
        MembershipRepository, CoachResolver, ProfileService, AvatarService, AvatarLinks,
        { provide: AuthService, useValue: { refusePersonalData: () => undefined } },
        // The real limiter: the photo's upload forms are counted per account (L5).
        { provide: RateLimiter, useValue: new RateLimiter(clock) },
        // This environment's storage prefix is `dev`, as `PhotoStorage` keys; every other value is a secret's length.
        {
          provide: ConfigService,
          useValue: { get: () => undefined, getOrThrow: (key: string) => (key === 'STORAGE_KEY_PREFIX' ? 'dev' : 's'.repeat(40)) },
        },
        { provide: ImpersonationService, useValue: { liveSession: async () => ({ readOnly: false, writeScope: [] }) } },
        ContextResolver, AuthGuard, PermissionsGuard,
      ],
    }).compile();

    app = moduleRef.createNestApplication();
    app.setGlobalPrefix('api');
    app.enableVersioning({ type: VersioningType.URI, defaultVersion: '1' });
    app.useGlobalPipes(productionPipe());
    app.useGlobalFilters(new DomainExceptionFilter());
    app.useGlobalGuards(app.get(AuthGuard), app.get(PermissionsGuard));
    await app.init();
    await listenOnLoopback(app);
  });

  afterAll(async () => {
    await app.close();
    await stopMongo();
  });

  beforeEach(async () => {
    await clearCollections();
    storage.objects.clear();
    storage.signed = [];
  });

  async function office(name = 'BSD City Branch') {
    seq += 1;
    const company = await companies.create({ name: `Prudential Indonesia ${seq}`, slug: `pru-${seq}` });
    const kpm = await kpms.create({
      companyId: String(company._id), code: `04${String(seq).padStart(2, '0')}`, branchName: name, timezone: 'Asia/Jakarta',
    });
    return { kpmId: String(kpm._id), companyId: String(company._id), companyName: company.name };
  }

  /** A person in an office under `leader`, with the account `users` holds for them. */
  async function person(
    at: { kpmId: string; companyId: string },
    role: 'ab' | 'aab' | 'agent',
    fullName: string,
    leader: { membershipId: string; ancestorIds: string[] } | null = null,
    status: 'active' | 'removed' = 'active',
  ) {
    seq += 1;
    const user = await users.create({
      email: `p${seq}@kpm.test`, passwordHash: 'x', fullName, status: 'active', platformRole: 'none',
      companyId: at.companyId, agentCode: `${70_000_000 + seq}`,
    });
    const ancestorIds = leader ? [...leader.ancestorIds, leader.membershipId] : [];
    const m = await memberships.create({
      kpmId: at.kpmId, userId: String(user._id), agentCode: `${20_000 + seq}`, agentSeq: seq,
      leaderCode: `LC${String(seq).padStart(4, '0')}`, orgLevelId: `lvl-${role}`, orgLevelCode: role.toUpperCase(),
      role, status, leaderId: leader?.membershipId ?? null, ancestorIds, depth: ancestorIds.length,
      adminAccess: { isKpmAdmin: false, grantedByUserId: null, grantedAt: null, revokedAt: null },
    });
    return { userId: String(user._id), membershipId: String(m._id), ancestorIds };
  }

  const as = (userId: string, sid = 'session') => ({ Authorization: `Bearer ${signer.sign({ sub: userId, sid }, 3600)}` });
  const http = () => request(app.getHttpServer());

  describe('UI-111 GET /auth/me/profile', () => {
    it('UI-111 answers the insurer, the agent code, the leader in this office and the group by role', async () => {
      const at = await office();
      const wilson = await person(at, 'ab', 'Wilson Tanoto');
      const agus = await person(at, 'ab', 'Agus Prasetyo', wilson);
      const arief = await person(at, 'aab', 'Arief Hidayat', agus);
      await person(at, 'agent', 'Novi Andriani', arief);
      await person(at, 'agent', 'Siti Rahmawati', agus);
      await person(at, 'agent', 'Gone Person', agus, 'removed');

      const res = await http().get('/api/v1/auth/me/profile').set(as(agus.userId)).expect(200);

      expect(res.body).toEqual({
        companyName: at.companyName,
        agentCode: expect.stringMatching(/^700000\d\d$/),
        leader: { name: 'Wilson Tanoto', orgLevelCode: 'AB' },
        group: { people: 3, ab: 0, aab: 1, agents: 2 },
      });
    });

    it('UI-111 an Agent with nobody below reads no group; the top of the office reads no leader', async () => {
      const at = await office();
      const wilson = await person(at, 'ab', 'Wilson Tanoto');
      const novi = await person(at, 'agent', 'Novi Andriani', wilson);

      expect((await http().get('/api/v1/auth/me/profile').set(as(novi.userId)).expect(200)).body)
        .toMatchObject({ leader: { name: 'Wilson Tanoto', orgLevelCode: 'AB' }, group: null });
      expect((await http().get('/api/v1/auth/me/profile').set(as(wilson.userId)).expect(200)).body)
        .toMatchObject({ leader: null, group: { people: 1, ab: 0, aab: 0, agents: 1 } });
    });

    it('UI-111 cross-tenant: office B’s people are never counted in office A’s group, and B’s reader sees only B', async () => {
      const a = await office('Office A');
      const b = await office('Office B');
      const leaderA = await person(a, 'ab', 'Leader A');
      await person(a, 'agent', 'Agent A', leaderA);
      const leaderB = await person(b, 'ab', 'Leader B');
      // A row in office B that names office A's leader as its own: the tenant scope must not follow it.
      await memberships.create({
        kpmId: b.kpmId, userId: 'u-stray', agentCode: '99999', agentSeq: 999, leaderCode: 'STRAY1', orgLevelId: 'lvl-agent',
        orgLevelCode: 'AGENT', role: 'agent', status: 'active', leaderId: leaderA.membershipId, ancestorIds: [leaderA.membershipId],
        depth: 1, adminAccess: { isKpmAdmin: false, grantedByUserId: null, grantedAt: null, revokedAt: null },
      });

      expect((await http().get('/api/v1/auth/me/profile').set(as(leaderA.userId)).expect(200)).body.group)
        .toEqual({ people: 1, ab: 0, aab: 0, agents: 1 });
      expect((await http().get('/api/v1/auth/me/profile').set(as(leaderB.userId)).expect(200)).body)
        .toMatchObject({ companyName: b.companyName, leader: null, group: null });
    });

    it('UI-111 somebody in no office reads their insurer and code, no leader and no group', async () => {
      const at = await office();
      const user = await users.create({
        email: 'new@kpm.test', passwordHash: 'x', fullName: 'New Person', status: 'active', platformRole: 'none',
        companyId: at.companyId, agentCode: '70012345',
      });
      expect((await http().get('/api/v1/auth/me/profile').set(as(String(user._id))).expect(200)).body)
        .toEqual({ companyName: at.companyName, agentCode: '70012345', leader: null, group: null });
    });

    it('UI-111 refuses nobody signed out: 401', async () => {
      await http().get('/api/v1/auth/me/profile').expect(401);
    });
  });

  describe('UI-111 the photo', () => {
    it('UI-111 signs a JPEG under the caller’s own folder, pinned to image/jpeg', async () => {
      const at = await office();
      const agus = await person(at, 'ab', 'Agus Prasetyo');

      const res = await http().post('/api/v1/auth/me/avatar/upload').set(as(agus.userId))
        .send({ mimeType: 'image/jpeg', bytes: 24_576 }).expect(201);

      expect(res.body.storageKey).toMatch(new RegExp(`^dev/user/${agus.userId}/avatar/[0-9A-Z]{26}$`));
      expect(storage.signed[0]).toMatchObject({ owner: { kind: 'user', userId: agus.userId }, folder: 'avatar', allowedMimeTypes: ['image/jpeg'] });
    });

    it('L5 the form is signed with the photo’s own ceiling, 512 KB, so storage refuses a larger file whatever was claimed', async () => {
      const at = await office();
      const agus = await person(at, 'ab', 'Agus Prasetyo');

      await http().post('/api/v1/auth/me/avatar/upload').set(as(agus.userId)).send({ mimeType: 'image/jpeg', bytes: 24_576 }).expect(201);

      expect(storage.signed[0].maxBytes).toBe(512 * 1024);
    });

    it('L5 20 upload forms an hour per account, refused or not; the 21st is 429 AUTH_RATE_LIMITED, another account is not, and the hour ends', async () => {
      const at = await office();
      const agus = await person(at, 'ab', 'Agus Prasetyo');
      const indah = await person(at, 'agent', 'Indah Permatasari', agus);
      const ask = (userId: string, bytes = 24_576) => http().post('/api/v1/auth/me/avatar/upload').set(as(userId))
        .send({ mimeType: 'image/jpeg', bytes });

      try {
        // One refused claim counts as well: the limit is on asking.
        await ask(agus.userId, 512 * 1024 + 1).expect(413);
        for (let n = 2; n <= 20; n += 1) await ask(agus.userId).expect(201);
        const refused = await ask(agus.userId).expect(429);
        expect(refused.body.error).toMatchObject({ code: 'AUTH_RATE_LIMITED', details: { retryAfterSeconds: 3600 } });
        expect(storage.signed).toHaveLength(19);

        await ask(indah.userId).expect(201);
        clock.set(new Date(NOW.getTime() + 3600_000));
        await ask(agus.userId).expect(201);
      } finally {
        clock.set(NOW);
      }
    });

    it.each([
      ['a PNG', { mimeType: 'image/png', bytes: 1000 }, 400],
      ['more than 512 KB', { mimeType: 'image/jpeg', bytes: 512 * 1024 + 1 }, 413],
      ['no size', { mimeType: 'image/jpeg', bytes: 0 }, 400],
    ])('UI-111 refuses %s before anything is signed', async (_, body, status) => {
      const at = await office();
      const agus = await person(at, 'ab', 'Agus Prasetyo');
      await http().post('/api/v1/auth/me/avatar/upload').set(as(agus.userId)).send(body).expect(status);
      expect(storage.signed).toHaveLength(0);
    });

    it('UI-111 attaches what storage holds, and GET /auth/me answers it as a signed link — never the key', async () => {
      const at = await office();
      const agus = await person(at, 'ab', 'Agus Prasetyo');
      const { body: signed } = await http().post('/api/v1/auth/me/avatar/upload').set(as(agus.userId))
        .send({ mimeType: 'image/jpeg', bytes: 24_576 }).expect(201);
      storage.arrived(signed.storageKey);

      const res = await http().put('/api/v1/auth/me/avatar').set(as(agus.userId)).send({ storageKey: signed.storageKey }).expect(200);

      expect(res.body).toEqual({ avatarUrl: `https://signed.test/${signed.storageKey}` });
      expect((await users.findById(agus.userId).lean().exec())?.avatarUrl).toBe(signed.storageKey);
      const me = await http().get('/api/v1/auth/me').set(as(agus.userId)).expect(200);
      expect(me.body.user.avatarUrl).toBe(`https://signed.test/${signed.storageKey}`);
    });

    it('UI-111 refuses bytes that never arrived (409), are no JPEG (415) or are too large (413), and attaches nothing', async () => {
      const at = await office();
      const agus = await person(at, 'ab', 'Agus Prasetyo');
      const sign = async () => (await http().post('/api/v1/auth/me/avatar/upload').set(as(agus.userId))
        .send({ mimeType: 'image/jpeg', bytes: 24_576 }).expect(201)).body.storageKey as string;

      const never = await sign();
      expect((await http().put('/api/v1/auth/me/avatar').set(as(agus.userId)).send({ storageKey: never }).expect(409)).body.error.code)
        .toBe('ASSET_NOT_UPLOADED');
      const png = await sign();
      storage.arrived(png, 'image/png');
      expect((await http().put('/api/v1/auth/me/avatar').set(as(agus.userId)).send({ storageKey: png }).expect(415)).body.error.code)
        .toBe('ASSET_TYPE_NOT_ALLOWED');
      const big = await sign();
      storage.arrived(big, 'image/jpeg', 600 * 1024);
      expect((await http().put('/api/v1/auth/me/avatar').set(as(agus.userId)).send({ storageKey: big }).expect(413)).body.error.code)
        .toBe('ASSET_TOO_LARGE');
      expect((await users.findById(agus.userId).lean().exec())?.avatarUrl).toBeNull();
    });

    it('UI-111 another person’s photo key is answered 404, as one that does not exist, and nothing is written', async () => {
      const at = await office();
      const agus = await person(at, 'ab', 'Agus Prasetyo');
      const indah = await person(at, 'agent', 'Indah Permatasari', agus);
      const { body: signed } = await http().post('/api/v1/auth/me/avatar/upload').set(as(indah.userId))
        .send({ mimeType: 'image/jpeg', bytes: 24_576 }).expect(201);
      storage.arrived(signed.storageKey);

      expect((await http().put('/api/v1/auth/me/avatar').set(as(agus.userId)).send({ storageKey: signed.storageKey }).expect(404)).body.error.code)
        .toBe('NOT_FOUND');
      expect((await users.findById(agus.userId).lean().exec())?.avatarUrl).toBeNull();
    });

    it('L5 a key of their own folder minted by another environment is 404, and nothing is written', async () => {
      const at = await office();
      const agus = await person(at, 'ab', 'Agus Prasetyo');
      const staging = `staging/user/${agus.userId}/avatar/01JBX0Q4ZB7Y2M8K3T5W6N9P97`;
      storage.arrived(staging);

      expect((await http().put('/api/v1/auth/me/avatar').set(as(agus.userId)).send({ storageKey: staging }).expect(404)).body.error.code)
        .toBe('NOT_FOUND');
      expect((await users.findById(agus.userId).lean().exec())?.avatarUrl).toBeNull();
    });

    it('UI-111 Hapus foto clears it: GET /auth/me answers null, the initials', async () => {
      const at = await office();
      const agus = await person(at, 'ab', 'Agus Prasetyo');
      await users.updateOne({ _id: agus.userId }, { $set: { avatarUrl: `dev/user/${agus.userId}/avatar/01JBX0Q4ZB7Y2M8K3T5W6N9P99` } });

      expect((await http().delete('/api/v1/auth/me/avatar').set(as(agus.userId)).expect(200)).body).toEqual({ avatarUrl: null });
      expect((await http().get('/api/v1/auth/me').set(as(agus.userId)).expect(200)).body.user.avatarUrl).toBeNull();
    });

    it('UI-111 every photo write is refused in a support session, 403 PERM_DENIED, and nothing is written', async () => {
      const at = await office();
      const agus = await person(at, 'ab', 'Agus Prasetyo');
      const key = `dev/user/${agus.userId}/avatar/01JBX0Q4ZB7Y2M8K3T5W6N9P98`;
      storage.arrived(key);

      for (const call of [
        http().post('/api/v1/auth/me/avatar/upload').set(as(agus.userId, 'imp:sa-1')).send({ mimeType: 'image/jpeg', bytes: 1000 }),
        http().put('/api/v1/auth/me/avatar').set(as(agus.userId, 'imp:sa-1')).send({ storageKey: key }),
        http().delete('/api/v1/auth/me/avatar').set(as(agus.userId, 'imp:sa-1')),
      ]) {
        expect((await call.expect(403)).body.error.code).toBe('PERM_DENIED');
      }
      expect((await users.findById(agus.userId).lean().exec())?.avatarUrl).toBeNull();
      // Reading is not writing: the support session reads the profile as the person would.
      await http().get('/api/v1/auth/me/profile').set(as(agus.userId, 'imp:sa-1')).expect(200);
    });
  });
});
