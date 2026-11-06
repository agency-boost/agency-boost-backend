import { INestApplication } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { Test } from '@nestjs/testing';
import mongoose from 'mongoose';
import request from 'supertest';
import { PermissionsGuard } from '@/common/auth/permissions.guard';
import { DomainExceptionFilter } from '@/common/errors/error.filter';
import { SUBJECT_READ_ACTION } from '@/modules/audit/subject-read-audit';
import { clearCollections, startMongo, stopMongo } from '../../../test/mongo';
import { configModule, provisionOffice } from '../../../test/config-module';
import {
  buildCoachingOffice, COMPANY, KPM_B, ROSTER_NOW, type CoachingOffice, type Who,
} from '../../../test/coaching-office';
import { productionPipe, session, StubAuth } from '../../../test/http-permissions';
import { listenOnLoopback } from '../../../test/listen';
import { LeadController } from './lead.controller';
import { LeadService } from './lead.service';

/**
 * **`/leads`' search and its two filters, over HTTP, per role** (P18.7-T4 AC-2, ADR-0167 §4; the client's
 * UI review of 2026-10-26, UI-016: *71 leads, no search*).
 *
 * The API has taken `search`, `type` and `statusCode` since P7-T2, for the coaching card; `/leads` sends them
 * from P18.7-T4. What this file asks is that they **narrow and never widen**: a search reaches only the
 * leads the caller's grant already reaches — their own, or their unit's for a leader — in their own office,
 * combines with the other two, the saved order and the page, and is refused in any shape but its own.
 *
 * Over `test/coaching-office.ts`'s office, whose people stand in a real hierarchy, with a second office
 * provisioned beside it — so *whose* leads a search can find is a question with an answer.
 */
describe('P18.7-T4 AC-2 — /leads’ search and filters, over HTTP', () => {
  let app: INestApplication;
  let wired: ReturnType<typeof configModule>;
  let office: CoachingOffice;

  const as = (who: Who) => { session.current = office.as(who); };
  const http = () => request(app.getHttpServer());
  const db = () => mongoose.connection.db!;

  /** A lead of `who`'s, typed, moved to `status` and remarked as given. */
  const leadOf = async (
    who: Who, name: string,
    { type, status, remarks }: { type?: 'sales' | 'recruitment'; status?: string; remarks?: string } = {},
  ) => {
    const ctx = office.as(who);
    const lead = await wired.leadRecords.create(ctx, { name, type: type ?? null, remarks: remarks ?? null });
    if (status) await wired.leadRecords.setStatus(ctx, lead.id, status);
    return lead.id;
  };

  /** The names `GET /leads` answers `who` for this query, in the order it answers them. */
  const names = async (who: Who, query: Record<string, string | number>) => {
    as(who);
    const res = await http().get('/leads').query(query).expect(200);
    return res.body.rows.map((row: { name: string }) => row.name);
  };

  const refused = async (query: string, field: string) => {
    as('RINA');
    const res = await http().get('/leads').query(query).expect(400);
    expect(res.body.error.code).toBe('VALIDATION_FAILED');
    expect(JSON.stringify(res.body.error.details)).toMatch(new RegExp(field));
  };

  beforeAll(async () => {
    await startMongo();
    wired = configModule(ROSTER_NOW);
    await clearCollections();
    office = await buildCoachingOffice(wired);
    // Office B gets its ladders too, so its leads can sit on the same stage codes as office A's.
    await provisionOffice(wired, KPM_B, COMPANY);

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

  /*
   * **Every office holds an *Ibu Wulan*.** Rina's, her colleague Budi's under the same AAB, a peer unit's
   * agent's, and office B's — so a search for *wulan* is a question about whose leads it reaches, and every
   * answer below names exactly which.
   */
  beforeEach(async () => {
    await db().collection('leads').deleteMany({});
    await db().collection('auditLog').deleteMany({});
    await leadOf('RINA', 'Ibu Wulan Sari', { type: 'sales', status: 'FOLLOW_UP', remarks: 'Golf on Sunday.' });
    await leadOf('RINA', 'Pak Bambang', { type: 'sales' });
    await leadOf('RINA', 'Sdri. Maya Putri', { type: 'recruitment', status: 'MEETING_SCHEDULED' });
    await leadOf('RINA', 'Ibu Dewi (Referral)');
    await leadOf('BUDI', 'Ibu Wulan Kusuma', { type: 'sales', status: 'FOLLOW_UP' });
    await leadOf('PEER_AGENT', 'Ibu Wulan Ayu', { type: 'sales', status: 'FOLLOW_UP' });
    await leadOf('B_AGENT', 'Ibu Wulan Bayu', { type: 'sales', status: 'FOLLOW_UP' });
  });

  describe('each filter on its own', () => {
    it('P18.7-T4 AC-2 searches the name, whatever its case and wherever the words fall', async () => {
      expect(await names('RINA', { search: 'wulan' })).toEqual(['Ibu Wulan Sari']);
      expect(await names('RINA', { search: 'MAYA PUT' })).toEqual(['Sdri. Maya Putri']);
      expect(await names('RINA', { search: '  bambang  ' })).toEqual(['Pak Bambang']);
    });

    it('P18.7-T4 AC-2 reads a search as the words typed, never as a pattern', async () => {
      expect(await names('RINA', { search: '(Referral)' })).toEqual(['Ibu Dewi (Referral)']);
      // `.*` would match every lead as a pattern; as text, no name holds it.
      expect(await names('RINA', { search: '.*' })).toEqual([]);
      expect(await names('RINA', { search: 'Ibu|Pak' })).toEqual([]);
    });

    it('P18.7-T4 AC-2 searches the remarks as well, as the coaching card’s search always has', async () => {
      expect(await names('RINA', { search: 'golf' })).toEqual(['Ibu Wulan Sari']);
    });

    it.each([
      ['sales', ['Pak Bambang', 'Ibu Wulan Sari']],
      ['recruitment', ['Sdri. Maya Putri']],
      ['unassigned', ['Ibu Dewi (Referral)']],
    ])('P18.7-T4 AC-2 narrows to type=%s, in the saved order', async (type, expected) => {
      // No sort is the owner's own order: the newest lead on top (P18.5-T7 AC-1).
      expect(await names('RINA', { type })).toEqual(expected);
    });

    it('P18.7-T4 AC-2 narrows to one stage, of either ladder', async () => {
      expect(await names('RINA', { statusCode: 'FOLLOW_UP' })).toEqual(['Ibu Wulan Sari']);
      expect(await names('RINA', { statusCode: 'MEETING_SCHEDULED' })).toEqual(['Sdri. Maya Putri']);
    });
  });

  describe('combined, ordered and paged', () => {
    it('P18.7-T4 AC-2 combines the search with a type and a stage', async () => {
      expect(await names('RINA', { search: 'ibu', type: 'sales', statusCode: 'FOLLOW_UP' })).toEqual(['Ibu Wulan Sari']);
      expect(await names('RINA', { search: 'ibu', type: 'sales' })).toEqual(['Ibu Wulan Sari']);
      expect(await names('RINA', { type: 'sales', statusCode: 'FOLLOW_UP' })).toEqual(['Ibu Wulan Sari']);
    });

    it('P18.7-T4 AC-2 answers an empty page, total 0, when nothing matches — a stage of the other ladder included', async () => {
      as('RINA');
      for (const query of [
        { search: 'nobody by this name' },
        { search: 'wulan', type: 'recruitment' },
        { type: 'recruitment', statusCode: 'FOLLOW_UP' },
        { statusCode: 'A_STAGE_NOBODY_HAS' },
      ]) {
        const res = await http().get('/leads').query({ ...query, outcome: 'open' }).expect(200);
        expect(res.body).toEqual({ rows: [], total: 0, page: 1, pageSize: 50 });
      }
    });

    it('P18.7-T4 AC-2 keeps the saved order under a filter, and a column sort when one is asked for', async () => {
      as('RINA');
      const ids = (await http().get('/leads').query({ outcome: 'open' }).expect(200)).body.rows
        .map((row: { id: string; name: string }) => row);
      // Rina drags *Ibu Wulan Sari* below *Pak Bambang*'s… and her filtered list follows.
      const byName = (name: string) => ids.find((row: { name: string }) => row.name === name).id;
      await http().patch('/leads/order').send({
        ids: [byName('Ibu Wulan Sari'), byName('Ibu Dewi (Referral)'), byName('Sdri. Maya Putri'), byName('Pak Bambang')],
      }).expect(200);

      expect(await names('RINA', { type: 'sales', outcome: 'open' })).toEqual(['Ibu Wulan Sari', 'Pak Bambang']);
      expect(await names('RINA', { type: 'sales', sort: 'name', dir: 'desc' })).toEqual(['Pak Bambang', 'Ibu Wulan Sari']);
      expect(await names('RINA', { search: 'i', sort: 'name', dir: 'asc' }))
        .toEqual(['Ibu Dewi (Referral)', 'Ibu Wulan Sari', 'Sdri. Maya Putri']);
    });

    it('P18.7-T4 AC-2 pages the filtered set, and its total is the filtered count', async () => {
      as('RINA');
      const first = await http().get('/leads').query({ type: 'sales', page: 1, pageSize: 1 }).expect(200);
      const second = await http().get('/leads').query({ type: 'sales', page: 2, pageSize: 1 }).expect(200);

      expect(first.body).toMatchObject({ total: 2, page: 1, pageSize: 1 });
      expect([...first.body.rows, ...second.body.rows].map((row: { name: string }) => row.name))
        .toEqual(['Pak Bambang', 'Ibu Wulan Sari']);
    });

    it('P18.7-T4 AC-2 narrows the closed lists the same way', async () => {
      as('RINA');
      const { rows } = (await http().get('/leads').query({ search: 'maya' }).expect(200)).body;
      await http().patch(`/leads/${rows[0].id}/outcome`).send({ outcome: 'lost' }).expect(200);

      expect(await names('RINA', { search: 'maya', outcome: 'open' })).toEqual([]);
      expect(await names('RINA', { search: 'maya', outcome: 'lost' })).toEqual(['Sdri. Maya Putri']);
    });
  });

  describe('a search narrows what the grant reaches, and never widens it', () => {
    it('P18.7-T4 AC-2 an agent finds none of a colleague’s leads, whatever they search or filter', async () => {
      expect(await names('RINA', { search: 'kusuma' })).toEqual([]);
      expect(await names('RINA', { statusCode: 'FOLLOW_UP', type: 'sales' })).toEqual(['Ibu Wulan Sari']);
      expect(await names('BUDI', { search: 'wulan' })).toEqual(['Ibu Wulan Kusuma']);
    });

    it('P18.7-T4 AC-2 a leader’s search keeps their reach: their unit’s leads, and nobody else’s', async () => {
      // Sari leads Rina and Budi; the peer unit's agent and office B's are outside her.
      expect((await names('SARI', { search: 'wulan' })).sort()).toEqual(['Ibu Wulan Kusuma', 'Ibu Wulan Sari']);
      expect((await names('SARI', { search: 'wulan', statusCode: 'FOLLOW_UP', type: 'sales' })).sort())
        .toEqual(['Ibu Wulan Kusuma', 'Ibu Wulan Sari']);
      // Agus leads Sari, so his reach is hers and more — still not his peer's unit.
      expect((await names('AGUS', { search: 'wulan' })).sort()).toEqual(['Ibu Wulan Kusuma', 'Ibu Wulan Sari']);
      expect(await names('PEER_AB', { search: 'wulan' })).toEqual(['Ibu Wulan Ayu']);
    });

    it('P18.7-T4 AC-2 the Owner and the Admin search as the rung they stand on reads, in their office alone', async () => {
      await leadOf('OWNER', 'Ibu Wulan Owner');
      await leadOf('ADMIN', 'Ibu Wulan Admin');
      // Wilson is an AB at the root as well as the Owner, so his rung reaches every unit below him…
      expect((await names('OWNER', { search: 'wulan' })).sort())
        .toEqual(['Ibu Wulan Admin', 'Ibu Wulan Ayu', 'Ibu Wulan Kusuma', 'Ibu Wulan Owner', 'Ibu Wulan Sari']);
      // …and Maya is an AB leading nobody: her own, and nothing a search could widen.
      expect(await names('ADMIN', { search: 'wulan' })).toEqual(['Ibu Wulan Admin']);
      expect(await names('ADMIN', { search: 'sari' })).toEqual([]);
    });

    it('P18.7-T4 AC-2 another office’s leads are never found, by a search or a filter, either way', async () => {
      expect(await names('RINA', { search: 'bayu' })).toEqual([]);
      expect(await names('AGUS', { search: 'bayu' })).toEqual([]);
      expect(await names('B_AGENT', { search: 'wulan' })).toEqual(['Ibu Wulan Bayu']);
      expect(await names('B_AB', { search: 'wulan' })).toEqual(['Ibu Wulan Bayu']);
      expect(await names('B_AB', { search: 'sari' })).toEqual([]);
      expect(await names('B_AB', { statusCode: 'MEETING_SCHEDULED' })).toEqual([]);
    });

    it('P18.7-T4 AC-2 a leader’s search writes a read entry for the owners it shows, and none for a list of their own', async () => {
      await leadOf('SARI', 'Ibu Wulan Sendiri');
      const entries = () => db().collection('auditLog').countDocuments({ action: SUBJECT_READ_ACTION });

      expect(await names('SARI', { search: 'sendiri' })).toEqual(['Ibu Wulan Sendiri']);
      expect(await entries()).toBe(0);

      expect((await names('SARI', { search: 'kusuma' }))).toEqual(['Ibu Wulan Kusuma']);
      expect(await db().collection('auditLog').find({ action: SUBJECT_READ_ACTION }).toArray())
        .toEqual([expect.objectContaining({ targetMembershipId: office.id.BUDI })]);
    });
  });

  describe('what the pipe refuses before the service is asked', () => {
    it('P18.7-T4 AC-2 refuses a search longer than 120 characters', () => refused(`search=${'a'.repeat(121)}`, 'search'));
    it('P18.7-T4 AC-2 refuses a type outside its vocabulary', () => refused('type=wholesale', 'type'));
    it('P18.7-T4 AC-2 refuses a stage code longer than 64 characters', () => refused(`statusCode=${'A'.repeat(65)}`, 'statusCode'));
    it.each([
      ['search', 'search[$regex]=.*'],
      ['search', 'search[]=a&search[]=b'],
      ['type', 'type[$in][]=sales'],
      ['statusCode', 'statusCode[$exists]=true'],
    ])('P18.7-T4 AC-2 refuses an object or a list in `%s`, rather than handing it to the database', (field, query) => refused(query, field));
  });
});
