import { INestApplication, ValidationPipe, VersioningType } from '@nestjs/common';
import { getConnectionToken, getModelToken } from '@nestjs/mongoose';
import { Test } from '@nestjs/testing';
import cookieParser from 'cookie-parser';
import mongoose, { Connection, Model } from 'mongoose';
import request from 'supertest';
// Above AppModule: its import validates the configuration (test/boot-env.ts says why).
import '../../../test/boot-env';
import { AppModule } from '@/app.module';
import { VALIDATION_PIPE_OPTIONS } from '@/bootstrap';
import { TokenSigner } from '@/modules/auth/token-signer';
import { Kpm } from '@/modules/tenants/kpm.schema';
import { Membership } from '@/modules/org/membership.schema';
import { User } from '@/modules/users/user.schema';
import { listenOnLoopback } from '../../../test/listen';
import { startMongo, stopMongo } from '../../../test/mongo';
import { ownersOf } from '../../../test/owners';

/**
 * **P19.23-T2 AC-7 — *Lihat sebagai*'s new window, over HTTP** (ADR-0277): `POST /admin/impersonate/:userId` with
 * `handoff: true` answers a one-time code and no token; `POST /admin/impersonate/handoff` redeems it for the session's
 * token, once, as the Super Admin who started it. Through the real app: every global guard, the validation pipe, the
 * read-only session guard.
 */
describe('P19.23-T2 AC-7 the view-as window over HTTP', () => {
  let app: INestApplication;
  let db: Connection;
  const tokens: Record<'sa' | 'sa2' | 'owner' | 'admin' | 'agent', string> = {
    sa: '', sa2: '', owner: '', admin: '', agent: '',
  };
  let agentId = '';
  let ownerId = '';
  const http = () => request(app.getHttpServer());
  const START = (userId: string) => `/api/v1/admin/impersonate/${userId}`;
  const HANDOFF = '/api/v1/admin/impersonate/handoff';

  beforeAll(async () => {
    await startMongo();
    await mongoose.disconnect();
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    app.use(cookieParser());
    // The pipe the app runs with (`bootstrap.ts`): the validation refusals below are its.
    app.useGlobalPipes(new ValidationPipe(VALIDATION_PIPE_OPTIONS));
    app.setGlobalPrefix('api');
    app.enableVersioning({ type: VersioningType.URI, defaultVersion: '1' });
    await app.init();
    await listenOnLoopback(app);
    db = app.get<Connection>(getConnectionToken());
    for (const collection of Object.values(db.collections)) await collection.deleteMany({});

    const users = app.get<Model<User>>(getModelToken(User.name));
    const kpms = app.get<Model<Kpm>>(getModelToken(Kpm.name));
    const memberships = app.get<Model<Membership>>(getModelToken(Membership.name));
    const signer = app.get(TokenSigner);
    const person = (email: string, fullName: string, platformRole: 'none' | 'super_admin' = 'none') =>
      users.create({ email, passwordHash: 'x', fullName, status: 'active', platformRole });

    const sa = await person('victor@agencyboost.test', 'Victor Oscar', 'super_admin');
    const sa2 = await person('dina@agencyboost.test', 'Dina Kusuma', 'super_admin');
    const owner = await person('wilson@kpm0417.test', 'Wilson Tanoto');
    const admin = await person('linda@kpm0417.test', 'Linda Kusuma');
    const agent = await person('rina@kpm0417.test', 'Rina Wijaya');
    agentId = String(agent._id);
    ownerId = String(owner._id);
    const kpm = await kpms.create({
      companyId: '66f0000000000000000000c1', code: '0417', branchName: 'BSD City Branch', timezone: 'Asia/Jakarta',
      status: 'active', owners: ownersOf(String(owner._id)),
    });
    const kpmId = String(kpm._id);
    const member = (userId: unknown, code: string, role: 'ab' | 'agent', isKpmAdmin = false) => memberships.create({
      kpmId, userId: String(userId), agentCode: code, agentSeq: Number(code.slice(-1)), leaderCode: `LC${code}`,
      orgLevelId: role === 'ab' ? 'lvl-ab' : 'lvl-agent', orgLevelCode: role === 'ab' ? 'AB' : 'AGENT', role,
      status: 'active',
      adminAccess: { isKpmAdmin, grantedByUserId: null, grantedAt: null, revokedAt: null },
    });
    await member(owner._id, '104171', 'ab');
    await member(admin._id, '104172', 'agent', true);
    await member(agent._id, '104173', 'agent');

    tokens.sa = signer.sign({ sub: String(sa._id), sid: 'victor-own' }, 3600);
    tokens.sa2 = signer.sign({ sub: String(sa2._id), sid: 'dina-own' }, 3600);
    tokens.owner = signer.sign({ sub: String(owner._id), sid: 'wilson-own' }, 3600);
    tokens.admin = signer.sign({ sub: String(admin._id), sid: 'linda-own' }, 3600);
    tokens.agent = signer.sign({ sub: String(agent._id), sid: 'rina-own' }, 3600);
  }, 120_000);

  afterAll(async () => {
    await app?.close();
    await stopMongo();
  });

  const startWindow = (as: keyof typeof tokens = 'sa', target = agentId) => http().post(START(target))
    .set('Authorization', `Bearer ${tokens[as]}`)
    .send({ reason: 'Lihat sebagai Agent dari halaman KPM BSD City Branch', handoff: true });

  it('P19.23-T2 AC-7 happy path: a code with no token, redeemed once for the person\'s session', async () => {
    const started = await startWindow();
    expect(started.status).toBe(201);
    expect(started.body).not.toHaveProperty('accessToken');
    expect(started.body).toMatchObject({ readOnly: true });
    expect(typeof started.body.handoffCode).toBe('string');

    const taken = await http().post(HANDOFF).set('Authorization', `Bearer ${tokens.sa}`)
      .send({ code: started.body.handoffCode });
    expect(taken.status).toBe(200);
    expect(taken.body).toMatchObject({ sessionId: started.body.sessionId, readOnly: true });

    const me = await http().get('/api/v1/auth/me').set('Authorization', `Bearer ${taken.body.accessToken}`);
    expect(me.status).toBe(200);
    expect(me.body).toMatchObject({ isImpersonating: true, impersonationReadOnly: true, user: { id: agentId } });

    // Once: the second press is 410, naming why.
    const again = await http().post(HANDOFF).set('Authorization', `Bearer ${tokens.sa}`)
      .send({ code: started.body.handoffCode });
    expect([again.status, again.body.error?.code ?? again.body.code]).toEqual([410, 'IMPERSONATION_HANDOFF_SPENT']);
  });

  it('P19.23-T2 AC-7 another Super Admin\'s code is 404, and leaves it for the one who started it', async () => {
    // As the Owner, not the Agent: the happy path's redemption as the Agent, in the same second, signs the same token —
    // ADR-0168 §4's `409 IMPERSONATION_JUST_STARTED`, the product's own rule — which made this flaky in the full run.
    const started = await startWindow('sa', ownerId);
    const theirs = await http().post(HANDOFF).set('Authorization', `Bearer ${tokens.sa2}`)
      .send({ code: started.body.handoffCode });
    expect(theirs.status).toBe(404);
    const mine = await http().post(HANDOFF).set('Authorization', `Bearer ${tokens.sa}`)
      .send({ code: started.body.handoffCode });
    expect(mine.status).toBe(200);
  });

  it('P19.23-T2 AC-7 validation: no code, a malformed code, and a handoff that is not a boolean are 400', async () => {
    const none = await http().post(HANDOFF).set('Authorization', `Bearer ${tokens.sa}`).send({});
    const malformed = await http().post(HANDOFF).set('Authorization', `Bearer ${tokens.sa}`).send({ code: 'not a code!' });
    const flag = await http().post(START(agentId)).set('Authorization', `Bearer ${tokens.sa}`)
      .send({ reason: 'Lihat sebagai Agent', handoff: 'yes' });
    expect([none.status, malformed.status, flag.status]).toEqual([400, 400, 400]);
  });

  it.each(['owner', 'admin', 'agent'] as const)(
    'P19.23-T2 AC-7 permission negative: the %s may neither start a window nor redeem a code (403 PERM_DENIED)',
    async (who) => {
      const started = await startWindow(who);
      expect(started.status).toBe(403);
      const redeemed = await http().post(HANDOFF).set('Authorization', `Bearer ${tokens[who]}`)
        .send({ code: 'x'.repeat(43) });
      expect(redeemed.status).toBe(403);
      expect(redeemed.body.error?.code ?? redeemed.body.code).toBe('PERM_DENIED');
    },
  );

  it('P19.23-T2 AC-7 from inside a support session the redemption is refused as every write is', async () => {
    const sameTab = await http().post(START(agentId)).set('Authorization', `Bearer ${tokens.sa}`)
      .send({ reason: 'A session in its own tab' });
    expect(sameTab.status).toBe(201);
    const inside = await http().post(HANDOFF).set('Authorization', `Bearer ${sameTab.body.accessToken}`)
      .send({ code: 'x'.repeat(43) });
    expect(inside.status).toBe(403);
    expect(inside.body.error?.code ?? inside.body.code).toBe('IMPERSONATION_READ_ONLY');
  });
});
