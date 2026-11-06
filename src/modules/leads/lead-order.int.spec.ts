import { INestApplication } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { Test } from '@nestjs/testing';
import mongoose from 'mongoose';
import request from 'supertest';
import { PermissionsGuard } from '@/common/auth/permissions.guard';
import { RequestContext } from '@/common/context/request-context';
import { DomainExceptionFilter } from '@/common/errors/error.filter';
import { clearCollections, startMongo, stopMongo } from '../../../test/mongo';
import { configModule } from '../../../test/config-module';
import { buildCoachingOffice, ROSTER_NOW, type CoachingOffice, type Who } from '../../../test/coaching-office';
import { productionPipe, session, StubAuth, SUPER_ADMIN } from '../../../test/http-permissions';
import { listenOnLoopback } from '../../../test/listen';
import { LeadController } from './lead.controller';
import { LeadService } from './lead.service';

/**
 * **`PATCH /leads/order`, over HTTP, per role** (P18.5-T7 AC-1 to AC-3, ADR-0161 §1).
 *
 * Through the real `PermissionsGuard`, the production pipe and the real service, over
 * `test/coaching-office.ts`'s office, where the people stand in a real hierarchy: so *whose* list a
 * reorder writes can be asked — the caller's, never a downline's, never another office's — which the
 * one-person fixtures of `lead.controller.int.spec.ts` cannot.
 */
describe('P18.5-T7 — the owner’s own order, over HTTP', () => {
  let app: INestApplication;
  let wired: ReturnType<typeof configModule>;
  let office: CoachingOffice;

  const as = (who: Who) => { session.current = office.as(who); };
  const http = () => request(app.getHttpServer());
  const db = () => mongoose.connection.db!;
  const leadOf = async (who: Who, name: string) => (await wired.leadRecords.create(office.as(who), { name })).id;
  /** Three leads of `who`'s, added in this order: the last is on top. */
  const threeOf = async (who: Who) => [
    await leadOf(who, `${who} first`), await leadOf(who, `${who} second`), await leadOf(who, `${who} third`),
  ];
  const order = (...ids: string[]) => http().patch('/leads/order').send({ ids });
  const listed = async () => (await http().get('/leads').expect(200)).body.rows
    .map((row: { name: string }) => row.name);
  const places = async (ids: string[]) => Promise.all(ids.map(async (id) =>
    (await db().collection('leads').findOne({ _id: new mongoose.Types.ObjectId(id) }))!.position));

  beforeAll(async () => {
    await startMongo();
    wired = configModule(ROSTER_NOW);
    await clearCollections();
    office = await buildCoachingOffice(wired);

    const moduleRef = await Test.createTestingModule({
      controllers: [LeadController],
      providers: [{ provide: LeadService, useValue: wired.leadRecords }],
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

  beforeEach(async () => {
    await db().collection('leads').deleteMany({});
    await db().collection('auditLog').deleteMany({});
  });

  describe('who may order their own list', () => {
    it.each([
      ['an Agent', 'RINA'],
      ['an AAB', 'SARI'],
      ['an AB', 'AGUS'],
      ['the Owner, on their own rung', 'OWNER'],
      ['the Admin, on their own rung', 'ADMIN'],
    ] as [string, Who][])('P18.5-T7 AC-2 AC-3 lets %s save their order, and GET /leads without a sort reads it', async (_name, who) => {
      const [first, second, third] = await threeOf(who);
      as(who);

      const res = await order(first, third, second).expect(200);

      expect(res.body).toEqual({ ids: [first, third, second] });
      expect((await listed()).filter((name: string) => name.startsWith(who)))
        .toEqual([`${who} first`, `${who} third`, `${who} second`]);
      expect(await places([first, third, second])).toEqual([0, 1, 2]);
    });

    it('P18.5-T7 AC-3 a column sort still sorts, and is not saved', async () => {
      const [first, second, third] = await threeOf('RINA');
      as('RINA');
      await order(second, first, third).expect(200);

      const byName = await http().get('/leads').query({ sort: 'name', dir: 'desc' }).expect(200);
      expect(byName.body.rows.map((r: { name: string }) => r.name)).toEqual(['RINA third', 'RINA second', 'RINA first']);
      expect(await listed()).toEqual(['RINA second', 'RINA first', 'RINA third']);
    });

    it('P18.5-T7 AC-1 a lead a leader adds in a session goes to the top of the coachee’s list', async () => {
      const [first, second] = [await leadOf('RINA', 'RINA first'), await leadOf('RINA', 'RINA second')];
      as('RINA');
      await order(first, second).expect(200);

      as('SARI');
      await http().post('/leads').query({ owner: office.id.RINA }).send({ name: 'Added by Sari' }).expect(201);

      as('RINA');
      expect(await listed()).toEqual(['Added by Sari', 'RINA first', 'RINA second']);
    });
  });

  describe('a list is its owner’s', () => {
    it('P18.5-T7 AC-2 refuses a leader a downline’s lead, though their own list shows it, and writes nothing', async () => {
      const [mine] = [await leadOf('SARI', 'SARI own')];
      const rinas = await threeOf('RINA');
      as('SARI');
      // Sari's `/leads` holds her unit's leads beside her own (P7-T7)…
      expect(await listed()).toHaveLength(4);

      // …and her order is hers alone: Rina's leads in it, or in place of hers, are refused.
      for (const ids of [[mine, ...rinas], [...rinas], [mine, rinas[0]]]) {
        const res = await order(...ids).expect(400);
        expect(res.body.error.code).toBe('VALIDATION_FAILED');
      }
      expect(await places(rinas)).toEqual([0, -1, -2]);
      expect(await db().collection('auditLog').countDocuments({ action: 'lead.reordered' })).toBe(0);

      // Her own, alone, is the order she may send — and Rina's places do not move.
      await order(mine).expect(200);
      expect(await places(rinas)).toEqual([0, -1, -2]);
    });

    it('P18.5-T7 AC-2 refuses an agent a colleague’s lead', async () => {
      const [mine] = [await leadOf('RINA', 'RINA own')];
      const budis = await leadOf('BUDI', 'BUDI own');
      as('RINA');

      expect((await order(mine, budis).expect(400)).body.error.code).toBe('VALIDATION_FAILED');
      expect((await order(budis).expect(400)).body.error.code).toBe('VALIDATION_FAILED');
    });

    it('P18.5-T7 AC-2 refuses another office’s leads, both ways, and moves neither list', async () => {
      const ours = await threeOf('RINA');
      const theirs = await threeOf('B_AGENT');

      as('B_AB');
      expect((await order(...ours).expect(400)).body.error.code).toBe('VALIDATION_FAILED');
      as('B_AGENT');
      expect((await order(...theirs, ours[0]).expect(400)).body.error.code).toBe('VALIDATION_FAILED');
      as('RINA');
      expect((await order(...theirs).expect(400)).body.error.code).toBe('VALIDATION_FAILED');

      expect(await places(ours)).toEqual([0, -1, -2]);
      expect(await places(theirs)).toEqual([0, -1, -2]);
    });

    it('P18.5-T7 AC-2 refuses a list with one of the caller’s open leads left out', async () => {
      const [first, second] = await threeOf('RINA');
      as('RINA');

      const res = await order(first, second).expect(400);

      expect(res.body.error).toMatchObject({
        code: 'VALIDATION_FAILED',
        details: { violations: ['1 of your open leads is missing from ids'] },
      });
    });

    it('P18.10-T5 AC-7 says what is wrong with the list in Indonesian: one form for one and many, *leads* kept English', async () => {
      const [first] = await threeOf('RINA');
      const budis = await leadOf('BUDI', 'BUDI own');
      as('RINA');

      const sent = [first, first, budis];
      const res = await order(...sent).set('Accept-Language', 'id').expect(400);
      expect(res.body.error).toMatchObject({
        code: 'VALIDATION_FAILED',
        message: 'Kirim semua lead Anda yang masih terbuka, masing-masing sekali, dalam urutan yang Anda inginkan. '
          + 'Daftar Anda mungkin sudah berubah sejak Anda membukanya: muat ulang, lalu coba lagi.',
        details: { violations: [
          '1 dari id yang dikirim bukan lead Anda yang masih terbuka',
          'ids menyebut satu lead lebih dari sekali',
          '2 leads Anda yang masih terbuka tidak ada di ids',
        ] },
      });

      // In English, as before: the verb agrees with the count.
      const english = await order(...sent).expect(400);
      expect(english.body.error.details.violations).toEqual([
        '1 of the ids sent is not one of your open leads',
        'ids names a lead more than once',
        '2 of your open leads are missing from ids',
      ]);

      // Two strangers, and nothing else wrong: *are* in English, the one form in Indonesian.
      const rinaFourth = await leadOf('RINA', 'RINA fourth');
      const budiSecond = await leadOf('BUDI', 'BUDI second');
      as('RINA');
      const rinas = (await db().collection('leads').find({ ownerMembershipId: office.id.RINA }).toArray()).map((l) => String(l._id));
      expect(rinas).toHaveLength(4);
      expect(rinas).toContain(rinaFourth);
      const twoStrangers = [...rinas, budis, budiSecond];
      expect((await order(...twoStrangers).expect(400)).body.error.details.violations)
        .toEqual(['2 of the ids sent are not one of your open leads']);
      expect((await order(...twoStrangers).set('Accept-Language', 'id').expect(400)).body.error.details.violations)
        .toEqual(['2 dari id yang dikirim bukan lead Anda yang masih terbuka']);
    });
  });

  describe('what the pipe refuses before the service is asked', () => {
    it.each([
      ['no ids', {}],
      ['an empty list', { ids: [] }],
      ['a string in place of the list', { ids: 'all' }],
      ['an id that is not an ObjectId', { ids: ['lead-1'] }],
      ['an operator in place of an id', { ids: [{ $ne: null }] }],
      ['a field nobody defined', { ids: ['66f00000000000000000ffff'], pipeline: 'sales' }],
    ])('P18.5-T7 AC-2 refuses %s with 400', async (_name, body) => {
      as('RINA');
      const res = await http().patch('/leads/order').send(body).expect(400);
      expect(res.body.error.code).toBe('VALIDATION_FAILED');
    });

    it('P18.5-T7 is declared above PATCH /leads/:id, so *order* is never read as a lead', async () => {
      const [only] = [await leadOf('RINA', 'RINA only')];
      as('RINA');
      // `PATCH /leads/:id` would take a `name` and answer 404 for the id *order*; this route refuses it.
      const res = await http().patch('/leads/order').send({ name: 'Renamed' }).expect(400);
      expect(JSON.stringify(res.body.error.details)).toMatch(/ids|name/);
      await order(only).expect(200);
    });
  });

  describe('who is refused, and how', () => {
    it('P18.5-T7 refuses a Super Admin by name, not by a 500', async () => {
      session.current = SUPER_ADMIN;
      const res = await order('66f00000000000000000ffff').expect(403);
      expect(res.body.error.code).toBe('TENANT_NO_MEMBERSHIP');
    });

    it('P18.5-T7 refuses a membership still pending, which holds no grant yet', async () => {
      const rina = office.as('RINA');
      session.current = new RequestContext('u-x', 'none', { ...rina.membership!, status: 'pending' });
      const res = await order('66f00000000000000000ffff').expect(403);
      expect(res.body.error).toMatchObject({ code: 'PERM_DENIED', details: { permission: 'lead:update' } });
    });

    it('P18.5-T7 refuses a read-only support session, and moves nothing', async () => {
      const [first, second] = [await leadOf('RINA', 'RINA first'), await leadOf('RINA', 'RINA second')];
      const rina = office.as('RINA');
      session.current = new RequestContext(rina.userId, 'none', rina.membership, 'u-support', null, false, true);

      expect((await order(first, second).expect(403)).body.error.code).toBe('PERM_DENIED');
      expect(await places([first, second])).toEqual([0, -1]);
    });
  });
});
