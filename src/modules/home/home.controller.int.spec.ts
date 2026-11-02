import { INestApplication } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { PermissionsGuard } from '@/common/auth/permissions.guard';
import { RequestContext } from '@/common/context/request-context';
import { NoMembershipException } from '@/common/errors/domain.exception';
import { DomainExceptionFilter } from '@/common/errors/error.filter';
import {
  EVERY_MEMBER, FIXTURE_KPM, NO_CLASS, SUPER_ADMIN, declaredPermissions, productionPipe, session, StubAuth,
} from '../../../test/http-permissions';
import { listenOnLoopback } from '../../../test/listen';
import { HomeController } from './home.controller';
import { HomeService, type HomeView } from './home.service';

const VIEW: HomeView = {
  today: '2026-10-30', yesterday: '2026-10-29', month: '2026-10', now: { minute: 545 },
  quote: { index: 16, text: 'Plans are only good intentions unless they immediately degenerate into hard work.', person: 'Peter Drucker', pose: 'thinking' },
  activity: { today: 0, yesterday: 5, days: [], total: 18 },
  schedule: { meetings: 2, tasks: 3 },
  actions: [],
  leader: null,
};

/** A member standing on no rung, who is neither the Owner nor an Admin: no grant at all. */
const NOBODY = new RequestContext('u-none', 'none', {
  membershipId: 'mem-none', kpmId: FIXTURE_KPM, orgLevelCode: 'NONE', hierarchyRole: NO_CLASS,
  status: 'active', isKpmOwner: false, isKpmAdmin: false, directCount: 0,
} as never);

/**
 * **`GET /home` over HTTP** (Phase 18.99 T11; UI-100): who the API lets in, positive and negative. What it answers is
 * `home.tenancy.spec.ts`'s, on real rows.
 */
describe('UI-100 GET /home — who may read it', () => {
  let app: INestApplication;
  const read = jest.fn(async (_ctx: RequestContext) => VIEW);

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      controllers: [HomeController],
      providers: [{ provide: HomeService, useValue: { read } }],
    }).compile();
    app = moduleRef.createNestApplication();
    app.useGlobalPipes(productionPipe());
    app.useGlobalFilters(new DomainExceptionFilter());
    app.useGlobalGuards(new StubAuth(), new PermissionsGuard(app.get(Reflector)));
    await app.init();
    await listenOnLoopback(app);
  });
  afterAll(async () => app.close());
  beforeEach(() => read.mockClear());

  it('UI-100 the route is guarded by personal_summary:read — Home is the reader’s own', () => {
    expect(declaredPermissions(HomeController)).toEqual({ read: 'personal_summary:read' });
  });

  it.each(EVERY_MEMBER)('UI-100 %s reads their Home (the Owner and an Admin in their field view)', async (_who, ctx) => {
    session.current = ctx;
    const { body } = await request(app.getHttpServer()).get('/home').expect(200);
    expect(body).toEqual(VIEW);
    expect(read).toHaveBeenCalledTimes(1);
  });

  it('UI-100 a member holding no grant is refused 403 PERM_DENIED, and the read never runs', async () => {
    session.current = NOBODY;
    const { body } = await request(app.getHttpServer()).get('/home').expect(403);
    expect(body.error.code).toBe('PERM_DENIED');
    expect(read).not.toHaveBeenCalled();
  });

  it('UI-100 a Super Admin belongs to no office: the read refuses them before it reads anything', async () => {
    // The real service, with nothing behind it: it must refuse before it touches a dependency.
    const service = new HomeService(...(Array.from({ length: 13 }, () => ({})) as never as ConstructorParameters<typeof HomeService>));
    await expect(service.read(SUPER_ADMIN)).rejects.toBeInstanceOf(NoMembershipException);
  });
});
