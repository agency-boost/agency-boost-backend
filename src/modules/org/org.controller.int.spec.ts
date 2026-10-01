import { INestApplication } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { Test } from '@nestjs/testing';
import mongoose from 'mongoose';
import request from 'supertest';
import { PermissionsGuard } from '@/common/auth/permissions.guard';
import { FixedClock } from '@/common/clock/clock.port';
import { RequestContext } from '@/common/context/request-context';
import { DomainExceptionFilter } from '@/common/errors/error.filter';
import { AuditLog, AuditLogSchema } from '@/modules/audit/audit-log.schema';
import { AuditService } from '@/modules/audit/audit.service';
import { Company, CompanySchema } from '@/modules/tenants/company.schema';
import {
  CompanyOrgLevel, CompanyOrgLevelSchema,
} from '@/modules/tenants/company-org-level.schema';
import { Kpm, KpmSchema } from '@/modules/tenants/kpm.schema';
import { OrgLevelService } from '@/modules/tenants/org-level.service';
import { User, UserSchema } from '@/modules/users/user.schema';
import { FIXTURE_KPM, OWNER, productionPipe, session, StubAuth } from '../../../test/http-permissions';
import { listenOnLoopback } from '../../../test/listen';
import { clearCollections, seedLadder, startMongo, stopMongo } from '../../../test/mongo';
import { AdminDelegationService } from './admin-delegation.service';
import { DirectoryService } from './directory.service';
import { GroupService } from './group.service';
import { HierarchyService } from './hierarchy.service';
import { MembershipHistory, MembershipHistorySchema } from './membership-history.schema';
import { MembershipRepository } from './membership.repository';
import { Membership, MembershipSchema } from './membership.schema';
import { OrgController } from './org.controller';
import { MembershipHistoryRepository } from './org.repositories';
import { OrgTreeService } from './org-tree.service';
import { RemovalService } from './removal.service';
import { RoleChangeService } from './role-change.service';

const NOW = new Date('2026-03-11T02:00:00Z');

/** The node ids a tree answer carries, in the order it sends them. */
const ids = (body: { nodes: { membershipId: string }[] }) => body.nodes.map((n) => n.membershipId);

/**
 * The tree, over HTTP (P3-T8, held to P10.1-T2 AC-9).
 *
 * `org.tenancy.spec.ts` proves what `OrgTreeService.read` narrows to by calling it. What only a
 * request can prove lives here: that the route's guard admits every member — `org_tree:read` is
 * granted to an Agent at scope `own` — and that the narrowing is the server's, not the sidebar's.
 *
 * **Hiding is convenience; this is the control.** The agent shell stopped offering *Group tree*
 * to anybody who leads nobody (AC-9). That changes what the nav draws and nothing else: an Agent
 * who types `/group-tree`, or a childless AAB who does, still reaches this route and is answered
 * with themselves and nobody else — a peer's downline is as unreachable by URL as by click.
 */
describe('GET /members/tree over HTTP', () => {
  let app: INestApplication;
  let members: MembershipRepository;
  let hierarchy: HierarchyService;
  let users: mongoose.Model<User>;
  let companyId: string;
  let seq = 0;

  beforeAll(async () => {
    await startMongo();
    const clock = new FixedClock(NOW);
    const kpmModel = mongoose.model(Kpm.name, KpmSchema);
    users = mongoose.model(User.name, UserSchema);
    members = new MembershipRepository(mongoose.model(Membership.name, MembershipSchema) as never);
    const audit = new AuditService(mongoose.model(AuditLog.name, AuditLogSchema) as never);
    const orgLevels = new OrgLevelService(
      mongoose.model(CompanyOrgLevel.name, CompanyOrgLevelSchema) as never,
      mongoose.model(Company.name, CompanySchema) as never,
      kpmModel as never,
      audit,
      clock,
    );
    // The fixture is planted through the product's own write path, so `ancestorIds`, `depth`
    // and the counts are what a real office carries — not a hand-built row the tree might read
    // differently.
    hierarchy = new HierarchyService(
      members,
      kpmModel as never,
      users as never,
      new MembershipHistoryRepository(
        mongoose.model(MembershipHistory.name, MembershipHistorySchema) as never,
      ),
      clock,
      orgLevels,
    );

    const moduleRef = await Test.createTestingModule({
      controllers: [OrgController],
      providers: [
        { provide: OrgTreeService, useValue: new OrgTreeService(members, users as never) },
        // The other five back routes this spec never calls; a bare object keeps Nest from
        // building their dependency graphs.
        ...[DirectoryService, RoleChangeService, RemovalService, GroupService, AdminDelegationService]
          .map((provide) => ({ provide, useValue: {} })),
      ],
    }).compile();

    app = moduleRef.createNestApplication();
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

  /** An account carrying the insurer that issued its code (ADR-0017), as `HierarchyService.create` requires. */
  async function person() {
    seq += 1;
    const u = await users.create({
      email: `p${seq}@kpm.test`, passwordHash: 'x', fullName: `Person ${seq}`, status: 'active',
      platformRole: 'none', companyId, agentCode: `PRU-${1000 + seq}`,
    });
    return String(u._id);
  }

  async function join(role: 'ab' | 'aab' | 'agent', leaderId: string | null = null) {
    const m = await hierarchy.create(OWNER, { userId: await person(), role, leaderId, status: 'active' });
    return String(m._id);
  }

  /** The session a member's own token would carry: their row, read back. */
  async function asMember(membershipId: string) {
    const row = await members.findById(OWNER, membershipId);
    return new RequestContext(row!.userId, 'none', {
      membershipId,
      kpmId: FIXTURE_KPM,
      orgLevelCode: row!.role.toUpperCase(),
      hierarchyRole: row!.role as 'ab' | 'aab' | 'agent',
      status: 'active',
      isKpmOwner: false,
      isKpmAdmin: false,
      directCount: row!.directCounts?.total ?? 0,
    });
  }

  // root (AB) ─┬─ aab ─── agent
  //            └─ childless (AAB, leads nobody)
  let root: string;
  let aab: string;
  let agent: string;
  let childless: string;

  beforeEach(async () => {
    session.current = OWNER;
    await clearCollections();
    const company = await mongoose.model(Company.name).create({
      name: 'Prudential', slug: `prudential-${Math.random()}`,
    });
    companyId = String(company._id);
    await seedLadder(companyId);
    await mongoose.model(Kpm.name).create({
      _id: FIXTURE_KPM, companyId, code: '0417', branchName: 'Branch 0417',
      counters: { nextMemberSeq: 1 }, status: 'active',
    });
    root = await join('ab');
    aab = await join('aab', root);
    agent = await join('agent', aab);
    childless = await join('aab', root);
    for (const id of [root, aab]) await hierarchy.refreshCounts(OWNER, id);
  });

  it('answers an Agent with 200 and a tree of one — themselves — rather than a refusal', async () => {
    // `org_tree:read` at scope `own` (`roles-and-permissions.md`): the guard admits them, and the
    // narrowing leaves them their own node, their leader as the card above it, and nobody under.
    session.current = await asMember(agent);

    const res = await request(app.getHttpServer()).get('/members/tree').expect(200);

    expect(ids(res.body)).toEqual([agent]);
    expect(res.body.selfId).toBe(agent);
    expect(res.body.rootIds).toEqual([agent]);
    expect(res.body.leader?.membershipId).toBe(aab);
    expect(res.body.counts.total).toBe(0);
  });

  it('answers an AAB who leads nobody with their own node only, never a peer’s downline', async () => {
    // Leading is the graph, not the rung (OD-23): the childless AAB stands beside a peer AAB who
    // leads an agent, and the peer's subtree is as unreachable by a typed URL as by the sidebar.
    session.current = await asMember(childless);

    const res = await request(app.getHttpServer()).get('/members/tree').expect(200);

    expect(ids(res.body)).toEqual([childless]);
    expect(ids(res.body)).not.toContain(aab);
    expect(ids(res.body)).not.toContain(agent);
    expect(res.body.leader?.membershipId).toBe(root);

    // The contrast, on the same office and the same route: the peer who does lead sees the
    // downline the childless AAB did not, so the empty answer above is the narrowing, not an
    // empty database.
    session.current = await asMember(aab);
    const peer = await request(app.getHttpServer()).get('/members/tree').expect(200);
    expect(ids(peer.body).sort()).toEqual([aab, agent].sort());
  });
});
