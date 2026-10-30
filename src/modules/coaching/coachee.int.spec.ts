import { INestApplication } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { Test } from '@nestjs/testing';
import mongoose from 'mongoose';
import request from 'supertest';
import { FixedClock } from '@/common/clock/clock.port';
import { PermissionsGuard } from '@/common/auth/permissions.guard';
import { RequestContext } from '@/common/context/request-context';
import { DomainExceptionFilter } from '@/common/errors/error.filter';
import { SUBJECT_READ_ACTION } from '@/modules/audit/subject-read-audit';
import { clearCollections, startMongo, stopMongo } from '../../../test/mongo';
import { configModule } from '../../../test/config-module';
import {
  ADMIN, OWNER, productionPipe, session, StubAuth, SUPER_ADMIN,
} from '../../../test/http-permissions';
import { listenOnLoopback } from '../../../test/listen';
import {
  buildCoachingOffice, ROSTER_NOW, ROSTER_TODAY, type CoachingOffice, type Who,
} from '../../../test/coaching-office';
import { CoachingController } from './coaching.controller';
import { CoachingRosterService } from './coaching-roster.service';
import { CoacheeService } from './coachee.service';
import { CoachingSessionService } from './coaching-session.service';

/**
 * **`GET /coaching/coachees/:membershipId` over HTTP, per role** (P11-T7 AC-1, AC-8;
 * `functional/coaching.md`, the Data contract).
 *
 * The person the shell opens on, through the real `PermissionsGuard`, the production pipe and the real
 * services over `test/coaching-office.ts`'s office: who is answered (`COACH` and nothing wider), who is
 * not found, what the wire carries — and that none of it is recorded, because it is directory facts.
 */
describe('the person a coaching page opens on, over HTTP (P11-T7)', () => {
  let app: INestApplication;
  let wired: ReturnType<typeof configModule>;
  let office: CoachingOffice;
  const get = (membershipId: string) => request(app.getHttpServer()).get(`/coaching/coachees/${membershipId}`);
  const as = (who: Who) => { session.current = office.as(who); };
  const reads = () => mongoose.connection.db!.collection('auditLog').countDocuments({ action: SUBJECT_READ_ACTION });
  const userOf = async (who: Who) => (await mongoose.connection.db!.collection('memberships')
    .findOne({ _id: new mongoose.Types.ObjectId(office.id[who]) }))!.userId as string;

  beforeAll(async () => {
    await startMongo();
    wired = configModule(ROSTER_NOW);
    await clearCollections();
    office = await buildCoachingOffice(wired);
    // Their own pronouns: Indah chose *she*, Dimas *he*; everybody else never said, and reads *they*.
    for (const [who, pronoun] of [['INDAH', 'she'], ['DIMAS', 'he']] as const) {
      await mongoose.connection.db!.collection('users').updateOne(
        { _id: new mongoose.Types.ObjectId(await userOf(who)) }, { $set: { pronoun } },
      );
    }

    const moduleRef = await Test.createTestingModule({
      controllers: [CoachingController],
      providers: [
        { provide: CoachingRosterService, useValue: wired.coachingRoster },
        { provide: CoacheeService, useValue: wired.coachee },
        { provide: CoachingSessionService, useValue: wired.coachingSession },
      ],
    }).compile();
    app = moduleRef.createNestApplication();
    app.useGlobalPipes(productionPipe());
    app.useGlobalFilters(new DomainExceptionFilter());
    app.useGlobalGuards(new StubAuth(), new PermissionsGuard(app.get(Reflector)));
    await app.init();
    await listenOnLoopback(app);
  }, 120_000);

  afterAll(async () => {
    await app.close();
    await stopMongo();
  });

  describe('who is answered', () => {
    it('P11-T7 AC-1 an AB is answered a direct agent: the name, the pronoun, the rung, the leader, and that it is them', async () => {
      as('AGUS');
      const res = await get(office.id.INDAH).expect(200);

      expect(res.body).toEqual({
        today: ROSTER_TODAY,
        membershipId: office.id.INDAH,
        name: 'Indah Permatasari',
        photoUrl: null,
        pronoun: 'she',
        rung: { code: 'AGENT', label: 'Agent' },
        leader: { membershipId: office.id.AGUS, name: 'Agus Salim' },
        direct: true,
        downline: { members: 0, leaders: 0 },
      });
    });

    it('P11-T7 AC-1 an AB is answered an agent further down, whose leader is somebody else', async () => {
      as('AGUS');
      const res = await get(office.id.RINA).expect(200);

      expect(res.body).toMatchObject({
        name: 'Rina Wijaya', pronoun: 'they', direct: false,
        leader: { membershipId: office.id.SARI, name: 'Sari Puspita' },
      });
    });

    it('P11-T7 AC-1 counts everybody below an AAB, and those of them who lead: a nested unit is one leader', async () => {
      as('AGUS');
      const sari = (await get(office.id.SARI).expect(200)).body;

      // Rina, Budi, Nina and Nina's Dodi; of them only Nina leads anybody.
      expect(sari).toMatchObject({ rung: { code: 'AAB', label: 'AAB' }, direct: true, downline: { members: 4, leaders: 1 } });
      // An AAB who leads nobody, and an agent who leads somebody: the counts follow the edges, not the rung.
      expect((await get(office.id.DEWI).expect(200)).body.downline).toEqual({ members: 0, leaders: 0 });
      expect((await get(office.id.LUKAS).expect(200)).body.downline).toEqual({ members: 1, leaders: 0 });
    });

    it('P11-T7 AC-8 an AAB is answered their own agent, and an agent of their nested unit', async () => {
      as('SARI');
      expect((await get(office.id.RINA).expect(200)).body).toMatchObject({ direct: true, pronoun: 'they' });
      expect((await get(office.id.DODI).expect(200)).body).toMatchObject({
        direct: false, leader: { membershipId: office.id.NINA, name: 'Nina Lestari' },
      });
    });

    it('P11-T7 AC-8 the Owner, standing at the root as the office’s AB, is answered as that AB', async () => {
      as('OWNER');
      expect((await get(office.id.DIMAS).expect(200)).body).toMatchObject({ pronoun: 'he', direct: false });
      expect((await get(office.id.AGUS).expect(200)).body).toMatchObject({ direct: true, downline: { members: 10, leaders: 3 } });
    });

    it('P11-T7 AC-8 a read-only support session reads the person as that leader would', async () => {
      const agus = office.as('AGUS');
      session.current = new RequestContext(agus.userId, 'none', agus.membership, 'u-support', null, false, true);
      expect((await get(office.id.INDAH).expect(200)).body.name).toBe('Indah Permatasari');
    });
  });

  describe('who is not found (404, never 403)', () => {
    it.each([
      ['SARI', 'INDAH', 'an agent of the AB above them, outside their unit'],
      ['SARI', 'PEER_AGENT', 'a peer AAB’s agent'],
      ['AGUS', 'PEER_AGENT', 'a peer AB’s person'],
      ['AGUS', 'B_AGENT', 'a member of another office'],
      ['B_AB', 'INDAH', 'this office’s member, to another office’s AB'],
      ['AGUS', 'LEFT', 'a member who has left: a former coachee'],
      ['AGUS', 'AGUS', 'themselves: their own coaching is somewhere else'],
      ['AGUS', 'OWNER', 'the leader above them'],
      ['INDAH', 'DIMAS', 'anybody at all, to an Agent'],
      ['INDAH', 'INDAH', 'an Agent themselves'],
      ['ADMIN', 'INDAH', 'anybody, to an Admin who stands above nobody'],
    ] as [Who, Who, string][])('P11-T7 AC-8 %s reading %s: %s', async (reader, subject) => {
      as(reader);
      const res = await get(office.id[subject]).expect(404);
      expect(res.body.error.code).toBe('NOT_FOUND');
    });

    it('P11-T7 AC-8 an id that is nobody’s, or not an id at all, is not found either', async () => {
      as('AGUS');
      await get(new mongoose.Types.ObjectId().toString()).expect(404);
      await get('not-a-membership').expect(404);
    });

    it('P11-T7 AC-8 an Owner or an Admin who leads nobody holds own-kpm and coaches nobody by it', async () => {
      for (const who of [OWNER, ADMIN]) {
        session.current = who;
        await get(office.id.INDAH).expect(404);
      }
    });

    it('P11-T7 AC-8 a former coachee, moved under somebody else, is not found the moment the edge closes', async () => {
      const memberships = mongoose.connection.db!.collection('memberships');
      const dimas = { _id: new mongoose.Types.ObjectId(office.id.DIMAS) };
      const before = await memberships.findOne(dimas);
      await memberships.updateOne(dimas, {
        $set: { leaderId: office.id.PEER_AB, ancestorIds: [office.id.OWNER, office.id.PEER_AB] },
      });
      try {
        as('AGUS');
        await get(office.id.DIMAS).expect(404);
        as('PEER_AB');
        expect((await get(office.id.DIMAS).expect(200)).body).toMatchObject({
          direct: true, leader: { membershipId: office.id.PEER_AB, name: 'Hendra Gunawan' },
        });
      } finally {
        await memberships.updateOne(dimas, { $set: { leaderId: before!.leaderId, ancestorIds: before!.ancestorIds } });
      }
    });
  });

  describe('who is refused', () => {
    it('P11-T7 a Super Admin, who has no membership to coach from, is refused by name', async () => {
      session.current = SUPER_ADMIN;
      expect((await get(office.id.INDAH).expect(403)).body.error.code).toBe('TENANT_NO_MEMBERSHIP');
    });

    it('P11-T7 a leader whose membership is pending holds no grant yet', async () => {
      const agus = office.as('AGUS');
      session.current = new RequestContext('u-x', 'none', { ...agus.membership!, status: 'pending' });
      expect((await get(office.id.INDAH).expect(403)).body.error.code).toBe('PERM_DENIED');
    });
  });

  describe('the office’s today, and nothing asked of the caller (review fixes)', () => {
    it('P11-T7 answers today in the office’s calendar, from the tenant’s zone — not the server’s day', async () => {
      const clock = wired.clock as FixedClock;
      as('AGUS');
      try {
        expect((await get(office.id.INDAH).expect(200)).body.today).toBe(ROSTER_TODAY);
        // 18:30 on the 14th in UTC is 01:30 on the 15th in Jakarta: the office has moved on, the server not yet.
        clock.set(new Date('2026-09-14T18:30:00Z'));
        expect((await get(office.id.INDAH).expect(200)).body.today).toBe('2026-09-15');
      } finally {
        clock.set(ROSTER_NOW);
      }
    });

    it.each([
      ['for', () => office.id.RINA, 'somebody else’s id'],
      ['membershipId', () => office.id.RINA, 'a second id'],
      ['today', () => '2026-01-01', 'a day of the caller’s choosing'],
    ] as [string, () => string, string][])(
      'P11-T7 refuses a query parameter by name — %s, %s: 400 VALIDATION_FAILED, nothing recorded',
      async (name, value) => {
        as('AGUS');
        const res = await get(office.id.INDAH).query({ [name]: value() }).expect(400);
        expect(res.body.error.code).toBe('VALIDATION_FAILED');
        expect(JSON.stringify(res.body.error.details)).toContain(name);
        expect(await reads()).toBe(0);
      },
    );

    it('P11-T7 refuses a query parameter before it decides who is answered: somebody outside COACH reads 400 too', async () => {
      as('SARI');
      const res = await get(office.id.INDAH).query({ for: office.id.INDAH }).expect(400);
      expect(res.body.error.code).toBe('VALIDATION_FAILED');
    });
  });

  it('P11-T7 AC-1 the wire carries the contract’s fields and no figure; nothing is recorded', async () => {
    const before = await reads();
    as('AGUS');
    const res = await get(office.id.RINA).expect(200);

    expect(Object.keys(res.body).sort())
      .toEqual(['direct', 'downline', 'leader', 'membershipId', 'name', 'photoUrl', 'pronoun', 'rung', 'today']);
    // Rina logged 53 recruiting follow-ups a day for a fortnight: not one count is in the answer.
    expect(JSON.stringify(res.body)).not.toMatch(/"(count|logged|total|totalCount|entries|status)"/);
    // Directory facts: no §3.5 entry for this read, or for any read above.
    expect(await reads()).toBe(before);
    expect(before).toBe(0);
  });
});
