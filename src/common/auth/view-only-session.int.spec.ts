import { INestApplication, RequestMethod, VersioningType } from '@nestjs/common';
import { METHOD_METADATA, PATH_METADATA } from '@nestjs/common/constants';
import { MetadataScanner, ModulesContainer, Reflector } from '@nestjs/core';
import { getConnectionToken, getModelToken } from '@nestjs/mongoose';
import { Test } from '@nestjs/testing';
import { createHash } from 'node:crypto';
import cookieParser from 'cookie-parser';
import mongoose, { Connection, Model } from 'mongoose';
import request from 'supertest';
// Above AppModule: its import validates the configuration (test/boot-env.ts says why).
import '../../../test/boot-env';
import { AppModule } from '@/app.module';
import { ALLOWED_WHILE_READ_ONLY, IS_PUBLIC } from '@/common/auth/auth.decorators';
import { TokenSigner } from '@/modules/auth/token-signer';
import { Kpm } from '@/modules/tenants/kpm.schema';
import { Membership } from '@/modules/org/membership.schema';
import { User } from '@/modules/users/user.schema';
import { listenOnLoopback } from '../../../test/listen';
import { startMongo, stopMongo } from '../../../test/mongo';

/** One route of the real app, as its decorators declare it and the router serves it. */
interface Route {
  method: string;
  path: string;
  isPublic: boolean;
  allowedWhileReadOnly: boolean;
}

/**
 * **The routes a session may post to, and nothing else** (P19.4-T2 AC-2; ADR-0206 §4). Ending the session, and two
 * reads sent as `POST` for their bodies, which write nothing. A route joins only by writing nothing, with its reason.
 */
const ALLOWED_WHILE_READ_ONLY_ROUTES = [
  // Ending the session: blocking it would strand the operator inside it.
  'POST /api/v1/admin/impersonate/end',
  // The goal calculator's cascade over the inputs on screen, written nowhere (P18.11 exit review, L4).
  'POST /api/v1/goals/:period/preview',
  // A training item's address; the first open is recorded only for `training_progress:update`, refused in a session.
  'POST /api/v1/training/modules/:code/items/:itemId/open',
];

/**
 * **P19.4-T2 AC-2 — every write of the real app, sent inside a session** (UI-151, Overview R4; ADR-0206 §4).
 *
 * Boots `AppModule` — every controller, every global guard in the order the app registers them — starts a real
 * session as an office's Owner (the member who holds the most writes), reads **every route the app declares** off
 * its controllers' decorators, and sends each one whose method is not `GET`, `HEAD` or `OPTIONS` with the session's
 * token: settings saves, uploads, imports, corrections, month locks, leads, coaching and the rest. Each is
 * `403 IMPERSONATION_READ_ONLY` — not `PERM_DENIED`, so the refusal came before any route's permission — and every
 * collection of the database is byte for byte what it was. The route list is the app's own, so a route added later is
 * walked without editing this file.
 */
describe('P19.4-T2 AC-2 a support session writes nothing, on any route of the app', () => {
  let app: INestApplication;
  let db: Connection;
  let routes: Route[];
  let sessionToken: string;
  let superAdminToken: string;
  let ownerId: string;
  const http = () => request(app.getHttpServer());

  beforeAll(async () => {
    await startMongo();
    await mongoose.disconnect();
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    app.use(cookieParser());
    app.setGlobalPrefix('api');
    app.enableVersioning({ type: VersioningType.URI, defaultVersion: '1' });
    await app.init();
    await listenOnLoopback(app);
    db = app.get<Connection>(getConnectionToken());
    // Every model's collection made and indexed before the first snapshot: under load a model's `autoCreate` finished
    // during the walk, and an empty collection that appeared read as a change though nothing was written.
    await Promise.all(Object.values(db.models).map((model) => model.init()));
    for (const collection of Object.values(db.collections)) await collection.deleteMany({});
    routes = declaredRoutes(app);

    // An office, its Owner, and a Super Admin — as the app's own rows.
    const users = app.get<Model<User>>(getModelToken(User.name));
    const kpms = app.get<Model<Kpm>>(getModelToken(Kpm.name));
    const memberships = app.get<Model<Membership>>(getModelToken(Membership.name));
    const sa = await users.create({
      email: 'victor@agencyboost.test', passwordHash: 'x', fullName: 'Victor Oscar', status: 'active',
      platformRole: 'super_admin',
    });
    const owner = await users.create({
      email: 'owner@kpm0601.test', passwordHash: 'x', fullName: 'Rina Owner', status: 'active', platformRole: 'none',
    });
    ownerId = String(owner._id);
    const kpm = await kpms.create({
      companyId: '66f0000000000000000000c1', code: '0601', branchName: 'KaiZen Family', timezone: 'Asia/Jakarta',
      status: 'active', ownerUserId: ownerId,
    });
    await memberships.create({
      kpmId: String(kpm._id), userId: ownerId, agentCode: '10601', agentSeq: 1, leaderCode: 'LC0601',
      orgLevelId: 'lvl-ab', orgLevelCode: 'AB', role: 'ab', status: 'active',
      adminAccess: { isKpmAdmin: false, grantedByUserId: null, grantedAt: null, revokedAt: null },
    });
    superAdminToken = app.get(TokenSigner).sign({ sub: String(sa._id), sid: 'victor-own-session' }, 3600);

    const started = await http().post(`/api/v1/admin/impersonate/${ownerId}`)
      .set('Authorization', `Bearer ${superAdminToken}`).send({ reason: 'Walking every route' });
    expect([started.status, started.body.readOnly]).toEqual([201, true]);
    sessionToken = started.body.accessToken;
  }, 120_000);

  afterAll(async () => {
    await app?.close();
    await stopMongo();
  });

  /** Every collection's rows, as one hash per collection: what a refused write must leave exactly as it was. */
  async function snapshot(): Promise<Record<string, string>> {
    const state: Record<string, string> = {};
    for (const { name } of await db.db!.listCollections({}, { nameOnly: true }).toArray()) {
      const rows = await db.db!.collection(name).find({}).sort({ _id: 1 }).toArray();
      state[name] = createHash('sha256').update(JSON.stringify(rows)).digest('hex');
    }
    return state;
  }

  /** A route's path with every parameter filled: an id-shaped value, which any `:param` accepts. */
  const filled = (path: string) => path.replace(/:[A-Za-z0-9_]+\??/g, '66f0000000000000000000ff');
  const send = (route: Route) => {
    const verb = route.method.toLowerCase() as 'post' | 'put' | 'patch' | 'delete';
    return http()[verb](filled(route.path)).set('Authorization', `Bearer ${sessionToken}`).send({});
  };
  const writes = () => routes.filter((r) => !['GET', 'HEAD', 'OPTIONS'].includes(r.method));
  const named = (r: Route) => `${r.method} ${r.path}`;

  it('P19.4-T2 AC-2 reads the routes off the app, and the router serves each one where its decorators say', () => {
    const served = new Set(
      (app.getHttpAdapter().getInstance() as { _router: { stack: { route?: { path: string; methods: Record<string, boolean> } }[] } })
        ._router.stack.flatMap((layer) => (layer.route
          ? Object.keys(layer.route.methods).map((m) => `${m.toUpperCase()} ${layer.route!.path}`)
          : [])),
    );
    expect(routes.length).toBeGreaterThan(200);
    expect(routes.map(named).filter((r) => !served.has(r))).toEqual([]);
    // Settings saves, uploads, imports, corrections, month locks, leads and coaching are all among them (AC-2).
    for (const sample of [
      'POST /api/v1/kpm/settings/activity-types', 'POST /api/v1/kpm/settings/publish',
      'POST /api/v1/kpm/data-upload/preview', 'POST /api/v1/kpm/data-upload/commit', 'PATCH /api/v1/kpm/data-upload/cell',
      'POST /api/v1/kpm/data-upload/months/:month/lock', 'POST /api/v1/admin/tenants/:id/roster',
      'POST /api/v1/leads', 'POST /api/v1/coaching/coachees/:membershipId/sessions', 'PATCH /api/v1/auth/me',
    ]) {
      expect([sample, writes().some((r) => named(r) === sample)]).toEqual([sample, true]);
    }
  });

  it('P19.4-T2 AC-2 exempts exactly the session’s end and the two reads sent as POST', () => {
    expect(writes().filter((r) => r.allowedWhileReadOnly && !r.isPublic).map(named).sort())
      .toEqual([...ALLOWED_WHILE_READ_ONLY_ROUTES].sort());
  });

  it('P19.4-T2 AC-2 refuses every other write in the session 403 IMPERSONATION_READ_ONLY, and nothing changes', async () => {
    const before = await snapshot();
    const answered: string[] = [];
    const walked = writes().filter((r) => !r.isPublic && !r.allowedWhileReadOnly);
    // Every write route of the app but the public ones — signing in, registering, a reset link, which carry no
    // session — and the three above: two hundred of them on 2026-11-05.
    expect(walked.length).toBeGreaterThan(150);
    for (const route of walked) {
      const res = await send(route);
      if (res.status !== 403 || res.body.error?.code !== 'IMPERSONATION_READ_ONLY') {
        answered.push(`${named(route)} → ${res.status} ${res.body.error?.code ?? ''}`);
      }
    }
    expect(answered).toEqual([]);
    expect(await snapshot()).toEqual(before);
  }, 120_000);

  it('P19.4-T2 AC-2 the clear message, in English and in Indonesian', async () => {
    const save = (language: string) => http().post('/api/v1/kpm/settings/activity-types')
      .set('Authorization', `Bearer ${sessionToken}`).set('Accept-Language', language).send({});
    expect((await save('en')).body.error.message)
      .toBe('This is a view-only session. Nothing can be changed while you view as somebody else.');
    expect((await save('id')).body.error.message)
      .toBe('Ini sesi hanya melihat. Tidak ada yang bisa diubah selama Anda melihat sebagai orang lain.');
  });

  it('P19.4-T2 AC-2 the two reads sent as POST are not refused for being POSTs, and write nothing', async () => {
    const before = await snapshot();
    for (const route of writes().filter((r) => r.allowedWhileReadOnly && named(r) !== ALLOWED_WHILE_READ_ONLY_ROUTES[0])) {
      const res = await send(route);
      expect([named(route), res.body.error?.code]).not.toEqual([named(route), 'IMPERSONATION_READ_ONLY']);
    }
    expect(await snapshot()).toEqual(before);
  });

  it('P19.4-T2 AC-2 reads as the Owner: GET /auth/me says read-only, and carries no purpose or write scope', async () => {
    const me = await http().get('/api/v1/auth/me').set('Authorization', `Bearer ${sessionToken}`).expect(200);
    expect(me.body).toMatchObject({ isImpersonating: true, impersonationReadOnly: true, user: { id: ownerId } });
    expect(me.body).not.toHaveProperty('impersonationPurpose');
    expect(me.body).not.toHaveProperty('impersonationWriteScope');
  });

  it('P19.4-T2 AC-1 POST /admin/impersonation/:sessionId/elevate is gone: 404 to the Super Admin', async () => {
    const res = await http().post('/api/v1/admin/impersonation/66f0000000000000000000ff/elevate')
      .set('Authorization', `Bearer ${superAdminToken}`).send({ reason: 'A role needs fixing in this office.' });
    expect(res.status).toBe(404);
    expect(routes.some((r) => r.path.includes('/elevate'))).toBe(false);
  });

  it('P19.4-T2 AC-5 the session ends from inside it, and its token is refused after (last: it ends the walk)', async () => {
    await http().post('/api/v1/admin/impersonate/end').set('Authorization', `Bearer ${sessionToken}`).expect(200);
    await http().get('/api/v1/auth/me').set('Authorization', `Bearer ${sessionToken}`).expect(401);
  });
});

/**
 * **Every route the app declares**, off its controllers' decorators: the method, the path as the router serves it
 * (`/api`, the version, the controller's path and the handler's), and the two marks this spec asks about.
 */
function declaredRoutes(app: INestApplication): Route[] {
  const reflector = app.get(Reflector);
  const scanner = new MetadataScanner();
  const out: Route[] = [];
  for (const module of app.get(ModulesContainer).values()) {
    for (const wrapper of module.controllers.values()) {
      const metatype = wrapper.metatype as (new (...args: never[]) => unknown) | null;
      if (!metatype) continue;
      const version = Reflect.getMetadata('__version__', metatype) as unknown;
      const prefix = typeof version === 'symbol' ? '/api' : '/api/v1';
      const controllerPaths = [Reflect.getMetadata(PATH_METADATA, metatype) as string | string[]].flat();
      for (const name of scanner.getAllMethodNames(metatype.prototype)) {
        const handler = (metatype.prototype as Record<string, unknown>)[name] as object;
        const own = Reflect.getMetadata(PATH_METADATA, handler) as string | string[] | undefined;
        if (own === undefined) continue;
        const method = RequestMethod[Reflect.getMetadata(METHOD_METADATA, handler) as RequestMethod];
        for (const base of controllerPaths) {
          for (const path of [own].flat()) {
            out.push({
              method,
              path: `${prefix}/${[base, path].filter(Boolean).join('/')}`.replace(/\/+/g, '/').replace(/(.)\/$/, '$1'),
              isPublic: reflector.getAllAndOverride<boolean>(IS_PUBLIC, [handler as never, metatype]) === true,
              allowedWhileReadOnly: reflector.getAllAndOverride<boolean>(ALLOWED_WHILE_READ_ONLY, [handler as never, metatype]) === true,
            });
          }
        }
      }
    }
  }
  return out;
}
