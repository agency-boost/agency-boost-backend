import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { INestApplication, RequestMethod, type Provider } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { Test } from '@nestjs/testing';
import mongoose from 'mongoose';
import request from 'supertest';
import { PermissionsGuard } from '@/common/auth/permissions.guard';
import { DomainExceptionFilter } from '@/common/errors/error.filter';
import { startMongo, stopMongo, syncIndexes } from '../../../test/mongo';
import { configModule } from '../../../test/config-module';
import { productionPipe, session, StubAuth } from '../../../test/http-permissions';
import { listenOnLoopback } from '../../../test/listen';
import {
  buildCoachingOffice, ROSTER_NOW, ROSTER_TODAY, type CoachingOffice, type Who,
} from '../../../test/coaching-office';

type Controller = new (...args: never[]) => unknown;

/** What every note about each subject says: a phrase no other payload could hold by accident. */
const ABOUT: Readonly<Partial<Record<Who, readonly (readonly [Who, string])[]>>> = {
  // An Agent, with notes by her AAB and by the AB above.
  RINA: [['SARI', 'NOTE-ABOUT-RINA-BY-SARI'], ['AGUS', 'NOTE-ABOUT-RINA-BY-AGUS']],
  // An AAB who leads people of her own: she holds `leader_notes:read`, and is still the subject.
  SARI: [['AGUS', 'NOTE-ABOUT-SARI-BY-AGUS'], ['OWNER', 'NOTE-ABOUT-SARI-BY-OWNER']],
};
const SUBJECTS = Object.keys(ABOUT) as Who[];
const markersAbout = (who: Who) => ABOUT[who]!.map(([, text]) => text);

/**
 * **Exit criterion 3: no leader note reaches its subject** (P11-T9 AC-5; ADR-0073; P11-T3 AC-7, P11-T10
 * AC-7; `functional/coaching.md`, *No leader note reaches its subject*).
 *
 * Not one check but the shape of everything a subject can receive. Notes are written about Rina, an
 * Agent, and about Sari, an AAB who leads people of her own, and then — signed in as each of them, over
 * HTTP, through the real guard and services — **every `GET` route every coaching controller declares**
 * is read with every id the subject could put in it: their own, each person they coach, their leader,
 * and every session they were coached in or led. The routes are found from the controllers themselves,
 * so a coaching read added later is swept without anybody remembering to add it here. Whatever each
 * answers — 200, 403 or 404 — holds no note's text about the reader.
 *
 * Then a session with each subject is finalized: neither the notice that reaches them nor the frozen
 * snapshot holds a note.
 */
describe('exit criterion 3: no leader note reaches its subject, over every coaching route (P11-T9)', () => {
  let app: INestApplication;
  let wired: ReturnType<typeof configModule>;
  let office: CoachingOffice;
  const controllers: Controller[] = [];

  const db = () => mongoose.connection.db!;
  const col = (name: string) => db().collection(name);
  const id = (who: Who) => office.id[who];

  beforeAll(async () => {
    await startMongo();
    wired = configModule(ROSTER_NOW);
    office = await buildCoachingOffice(wired);
    await syncIndexes();

    for (const [subject, notes] of Object.entries(ABOUT) as [Who, readonly (readonly [Who, string])[]][]) {
      for (const [author, text] of notes) {
        await wired.leaderNotes.save(office.as(author), id(subject), { version: 0, text });
      }
    }

    // Every controller under the `coaching` prefix, found on disk rather than listed by hand.
    for (const file of readdirSync(__dirname).filter((name) => name.endsWith('.controller.ts'))) {
      const exported = (await import(join(__dirname, file))) as Record<string, unknown>;
      for (const value of Object.values(exported)) {
        if (typeof value === 'function' && Reflect.getMetadata('path', value) === 'coaching') {
          controllers.push(value as Controller);
        }
      }
    }

    // Each controller's services, the wired ones: whatever a controller asks for, `configModule` builds.
    const wiredServices = Object.values(wired).filter((v): v is object => typeof v === 'object' && v !== null);
    const providers: Provider[] = [];
    for (const controller of controllers) {
      const needs = (Reflect.getMetadata('design:paramtypes', controller) ?? []) as Controller[];
      for (const need of needs) {
        const instance = wiredServices.find((service) => service instanceof need);
        if (!instance) throw new Error(`test/config-module.ts wires no ${need.name}, which ${controller.name} needs`);
        providers.push({ provide: need, useValue: instance });
      }
    }

    const moduleRef = await Test.createTestingModule({ controllers, providers }).compile();
    app = moduleRef.createNestApplication();
    app.useGlobalPipes(productionPipe());
    app.useGlobalFilters(new DomainExceptionFilter());
    app.useGlobalGuards(new StubAuth(), new PermissionsGuard(app.get(Reflector)));
    await app.init();
    await listenOnLoopback(app);
  }, 120_000);

  afterAll(async () => {
    await app?.close();
    await stopMongo();
  });

  /** Every `GET` path the coaching controllers declare, as written on the handler. */
  function readRoutes(): string[] {
    return controllers.flatMap((controller) => {
      const prototype = controller.prototype as Record<string, unknown>;
      return Object.getOwnPropertyNames(prototype)
        .filter((name) => name !== 'constructor' && typeof prototype[name] === 'function')
        .filter((name) => Reflect.getMetadata('method', prototype[name] as object) === RequestMethod.GET)
        .map((name) => String(Reflect.getMetadata('path', prototype[name] as object)));
    });
  }

  /** Every id `subject` could put in a path: theirs, their leader's, their coachees', and every session of theirs. */
  async function idsFor(subject: Who): Promise<Record<string, string[]>> {
    const me = await col('memberships').findOne({ _id: new mongoose.Types.ObjectId(id(subject)) });
    const coachees = await wired.coach.coacheesOf(office.as(subject), id(subject));
    const sessions = await col('coachingSessions')
      .find({ $or: [{ coacheeMembershipId: id(subject) }, { coachMembershipId: id(subject) }] }).toArray();
    return {
      membershipId: [id(subject), String(me!.leaderId), ...coachees.map((c) => c.membershipId)],
      sessionId: sessions.map((s) => String(s._id)),
    };
  }

  function expand(path: string, ids: Record<string, string[]>): string[] {
    return path.split('/').reduce<string[]>((urls, segment) => {
      if (!segment.startsWith(':')) return urls.map((url) => `${url}/${segment}`);
      const values = ids[segment.slice(1)];
      if (!values) throw new Error(`the sweep does not know what to put in :${segment.slice(1)} (${path})`);
      return urls.flatMap((url) => values.map((value) => `${url}/${value}`));
    }, ['/coaching']);
  }

  it('P11-T9 AC-5 the sweep reaches every read the person shell, the roster and the sessions are built on', () => {
    const routes = readRoutes();
    for (const route of [
      'coachees', 'coachees/:membershipId', 'coachees/:membershipId/sessions', 'sessions/:sessionId',
      'coachees/:membershipId/profile', 'coachees/:membershipId/leader-notes',
    ]) expect(routes).toContain(route);
  });

  it.each(SUBJECTS)('P11-T9 AC-5 every coaching read, as %s, holds no note about them', async (subject) => {
    session.current = office.as(subject);
    const ids = await idsFor(subject);
    const urls = readRoutes().flatMap((route) => expand(route, ids));
    expect(urls.length).toBeGreaterThan(10);

    const answered: string[] = [];
    for (const url of urls) {
      const res = await request(app.getHttpServer()).get(url);
      const body = JSON.stringify(res.body) + res.text;
      for (const marker of markersAbout(subject)) {
        expect({ url, status: res.status, leaks: body.includes(marker) }).toEqual({ url, status: res.status, leaks: false });
      }
      if (res.status === 200) answered.push(url);
    }
    // The sweep read real answers, not only refusals: their own sessions, at least.
    expect(answered.length).toBeGreaterThan(0);
  });

  it('P11-T9 AC-5 the same sweep, as the author, does find the note: the markers are there to be found', async () => {
    session.current = office.as('AGUS');
    const urls = readRoutes().flatMap((route) => expand(route, { membershipId: [id('SARI')], sessionId: [] }));
    const found: string[] = [];
    for (const url of urls) {
      const res = await request(app.getHttpServer()).get(url);
      if (JSON.stringify(res.body).includes('NOTE-ABOUT-SARI-BY-AGUS')) found.push(url);
    }
    expect(found).toEqual([`/coaching/coachees/${id('SARI')}/leader-notes`]);
  });

  it('P11-T9 AC-5 the notes read and the profile read answer the subject not found, or refuse them at the guard', async () => {
    session.current = office.as('RINA');
    await request(app.getHttpServer()).get(`/coaching/coachees/${id('RINA')}/leader-notes`).expect(403);
    await request(app.getHttpServer()).get(`/coaching/coachees/${id('RINA')}/profile`).expect(403);
    session.current = office.as('SARI');
    await request(app.getHttpServer()).get(`/coaching/coachees/${id('SARI')}/leader-notes`).expect(404);
    await request(app.getHttpServer()).get(`/coaching/coachees/${id('SARI')}/profile`).expect(404);
  });

  it.each([
    ['AGUS', 'SARI'], ['SARI', 'RINA'],
  ] as [Who, Who][])('P11-T9 AC-5 a session %s finalizes with %s: the notice and the snapshot hold no note', async (coach, subject) => {
    const sent = wired.sentNotifications.length;
    const ctx = office.as(coach);
    const { session: started } = await wired.coachingSession.start(ctx, id(subject));
    const saved = await wired.coachingSession.save(ctx, started.sessionId, {
      version: started.version,
      lastWeekItems: started.lastWeekItems.map((item) => ({ itemId: item.itemId, done: true })),
      actionItems: [{ text: 'Book two presentations', dueDate: ROSTER_TODAY }],
      tips: [{ text: 'Confirm the next meeting before you leave.' }],
    });
    const finalized = await wired.coachingSession.finalize(ctx, started.sessionId, saved.version);
    expect(finalized.status).toBe('finalized');

    const notices = JSON.stringify(wired.sentNotifications.slice(sent));
    expect(wired.sentNotifications.length).toBeGreaterThan(sent);
    const stored = JSON.stringify(await col('coachingSessions').findOne({ _id: new mongoose.Types.ObjectId(started.sessionId) }));
    expect(stored).toContain('"snapshot"');
    for (const marker of markersAbout(subject)) {
      expect(notices).not.toContain(marker);
      expect(stored).not.toContain(marker);
    }

    // And the subject reads that session, as its coachee, with no note in it.
    session.current = office.as(subject);
    const asSubject = await request(app.getHttpServer()).get(`/coaching/sessions/${started.sessionId}`).expect(200);
    for (const marker of markersAbout(subject)) expect(JSON.stringify(asSubject.body)).not.toContain(marker);
  });

  it('P11-T9 AC-6 no audit entry about a note targets its subject', async () => {
    const entries = await col('auditLog').find({ action: { $regex: /^leader_note\./ } }).toArray();
    expect(entries.length).toBeGreaterThan(0);
    for (const subject of SUBJECTS) {
      expect(entries.filter((e) => e.targetMembershipId === id(subject))).toEqual([]);
    }
    expect(JSON.stringify(entries)).not.toMatch(/NOTE-ABOUT-/);
  });
});
