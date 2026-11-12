import { INestApplication } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { Test } from '@nestjs/testing';
import mongoose from 'mongoose';
import request from 'supertest';
import { PermissionsGuard } from '@/common/auth/permissions.guard';
import { DomainExceptionFilter } from '@/common/errors/error.filter';
import { Goal } from '@/modules/goals/goal.schema';
import { SUMMARY } from '@/domain/constants';
import { clearCollections, startMongo, stopMongo } from '../../../test/mongo';
import { configModule } from '../../../test/config-module';
import {
  declaredPermissions, EVERY_MEMBER, FIXTURE_KPM, OWNER, productionPipe, savedLanguage, session, StubAuth, SUPER_ADMIN,
} from '../../../test/http-permissions';
import { SummaryController } from './summary.controller';
import { SummaryService } from './summary.service';
import { listenOnLoopback } from '../../../test/listen';

const NOW = new Date('2026-09-14T02:00:00Z');
const COMPANY = '66f0000000000000000000c1';

/** The Personal Summary over HTTP (P10-T4): the decorators, the pipe, and the wire shape. */
describe('the Personal Summary over HTTP (P10-T4)', () => {
  let app: INestApplication;
  let wired: ReturnType<typeof configModule>;

  beforeAll(async () => {
    await startMongo();
    wired = configModule(NOW);
    const moduleRef = await Test.createTestingModule({
      controllers: [SummaryController],
      providers: [{ provide: SummaryService, useValue: wired.summary }],
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

  beforeEach(async () => {
    session.current = OWNER;
    await clearCollections();
    await mongoose.model(Goal.name).syncIndexes();
    // Opened at 00:00 on 1 January 2026 in Jakarta, still 31 December in UTC (P18.5-T11).
    await (wired.kpms as { create: (d: unknown) => Promise<unknown> }).create({
      _id: FIXTURE_KPM, companyId: COMPANY, code: '0417', branchName: 'A', timezone: 'Asia/Jakarta',
      createdAt: new Date('2025-12-31T17:00:00Z'),
    });
  });

  it('declares its permission, and the right one', () => {
    expect(declaredPermissions(SummaryController)).toEqual({ read: 'personal_summary:read' });
  });

  it.each(EVERY_MEMBER)('answers %s their own Summary', async (_name, who) => {
    session.current = who;
    const res = await request(app.getHttpServer()).get('/summary').expect(200);

    expect(res.body).toMatchObject({ year: '2026', month: '2026-09', today: '2026-09-14', goal: { set: false } });
    // Nothing measured is sent as null, not dropped: a missing key and a zero would read alike.
    expect(res.body.monthly).toHaveProperty('attainmentPct', null);
    // P19.11-T4 AC-4 (UX-12): the month's realised APE says which figure it is — nothing yet — and that no upload is held.
    expect(res.body.monthly.realised).toEqual({ source: 'none', uploaded: false, manual: null });
    expect(res.body).toHaveProperty('pace', null);
    // P10-T5: the chips go out for both periods, with a null target rather than none.
    for (const period of ['monthly', 'yearly']) {
      expect(res.body.activity[period].targets.map((t: { key: string }) => t.key)).toEqual(['leads', 'appointments', 'closings']);
      expect(res.body.activity[period].targets[0]).toHaveProperty('target', null);
      expect(res.body.activity[period]).toHaveProperty('total');
      expect(res.body.activity[period]).toHaveProperty('sections');
    }
    // P10-T6: the reader's own open leads, and how many; P18.5-T15 AC-4: and those of anybody they lead; P19.11-T5 AC-2:
    // how many the section shows before *Lihat semua*.
    expect(res.body.leads).toEqual({ rows: [], total: 0, shown: SUMMARY.LEADS_SHOWN, unitOpen: 0 });
    // P10-T7: nobody has logged anything here, so the one card is that rule's — named, with its facts.
    expect(res.body.insights).toEqual([
      { rule: 'NOTHING_LOGGED', kind: 'action', facts: { windowDays: expect.any(Number), lastLoggedOn: null } },
    ]);
  });

  it('refuses a Super Admin, who has no Summary of their own', async () => {
    session.current = SUPER_ADMIN;
    await request(app.getHttpServer()).get('/summary').expect(403);
  });

  it('refuses a membershipId by name: whose Summary is read is named by for alone (P11-T4)', async () => {
    const res = await request(app.getHttpServer()).get('/summary').query({ membershipId: 'somebody-else' }).expect(400);
    expect(res.body.error.details.violations).toEqual(expect.arrayContaining([expect.stringContaining('membershipId')]));
  });

  describe('the period, by month or year (P18.5-T11, ADR-0161 §4)', () => {
    it('P18.5-T11 AC-1 says which period it is, and which there are, unasked', async () => {
      const res = await request(app.getHttpServer()).get('/summary').expect(200);
      expect(res.body.period).toEqual({ firstMonth: '2026-01', thisMonth: '2026-09', currentMonth: true, currentYear: true });
    });

    it.each(EVERY_MEMBER)('P18.5-T11 AC-1 answers %s an earlier month, read whole, with no pace', async (_name, who) => {
      session.current = who;
      const res = await request(app.getHttpServer()).get('/summary').query({ month: '2026-08' }).expect(200);

      expect(res.body).toMatchObject({
        year: '2026', month: '2026-08', today: '2026-09-14', pace: null,
        period: { firstMonth: '2026-01', thisMonth: '2026-09', currentMonth: false, currentYear: true },
      });
      expect(res.body.activity.monthly).toMatchObject({ from: '2026-08-01', to: '2026-08-31' });
    });

    it('P18.5-T11 AC-1 answers a year: this one, to today', async () => {
      const res = await request(app.getHttpServer()).get('/summary').query({ year: '2026' }).expect(200);
      expect(res.body).toMatchObject({ year: '2026', month: '2026-09', period: { currentMonth: true, currentYear: true } });
    });

    it.each([
      ['a month that is not one', { month: '2026-13' }, 'month'],
      ['a month without its year', { month: '08' }, 'month'],
      ['a year of two digits', { year: '26' }, 'year'],
      ['a month twice', { month: ['2026-08', '2026-07'] }, 'month'],
    ])('P18.5-T11 AC-1 refuses %s at the pipe, by name', async (_what, query, name) => {
      const res = await request(app.getHttpServer()).get('/summary').query(query).expect(400);
      expect(res.body.error.code).toBe('VALIDATION_FAILED');
      expect(res.body.error.details.violations).toEqual(expect.arrayContaining([expect.stringContaining(name)]));
    });

    it.each([
      ['the future', { month: '2026-10' }, { field: 'month', earliest: '2026-01', latest: '2026-09' }],
      ['a year to come', { year: '2027' }, { field: 'year', earliest: '2026', latest: '2026' }],
      ['before the office', { month: '2025-12' }, { field: 'month', earliest: '2026-01', latest: '2026-09' }],
      ['a year before the office', { year: '2025' }, { field: 'year', earliest: '2026', latest: '2026' }],
      ['a month and a year together', { month: '2026-08', year: '2026' }, { field: 'year' }],
    ])('P18.5-T11 AC-1 refuses %s 400 VALIDATION_FAILED, saying what there is', async (_what, query, details) => {
      const res = await request(app.getHttpServer()).get('/summary').query(query).expect(400);
      expect(res.body.error).toMatchObject({ code: 'VALIDATION_FAILED', details });
    });
  });

  /*
   * **The period's refusals in the reader's language, each month in the reader's figures** (P18.10-T5 AC-1, AC-7):
   * *Okt 2026* in Indonesian — for a reader who has chosen nothing too, since the default went live (P18.10-T4's
   * exit) — and *Oct 2026* for an English reader, whether the screen says so or the saved choice does. A year is a name,
   * the same in both.
   */
  describe('P18.10-T5 AC-7 the period in Indonesian', () => {
    const summary = () => request(app.getHttpServer()).get('/summary');
    afterEach(() => { savedLanguage.current = null; });

    it('P18.10-T5 AC-7 refuses a month to come, and one before the office, in Indonesian, each month in Indonesian', async () => {
      const future = await summary().set('Accept-Language', 'id').query({ month: '2026-10' }).expect(400);
      expect(future.body.error).toMatchObject({
        code: 'VALIDATION_FAILED',
        message: 'Okt 2026 belum dimulai: bulan terakhir yang ada adalah Sep 2026.',
        details: { field: 'month', earliest: '2026-01', latest: '2026-09' },
      });
      const before = await summary().set('Accept-Language', 'id').query({ month: '2025-12' }).expect(400);
      expect(before.body.error.message).toBe('Des 2025 sebelum bulan pertama yang ada, Jan 2026.');
      const year = await summary().set('Accept-Language', 'id').query({ year: '2027' }).expect(400);
      expect(year.body.error.message).toBe('2027 belum dimulai: tahun terakhir yang ada adalah 2026.');
    });

    it('P18.10-T5 AC-1 writes the months in the reader’s figures: Indonesian for nobody’s choice, English for an English reader', async () => {
      // No header and nothing saved: nobody's choice, Bahasa Indonesia, words and figures (the default is live).
      const unchosen = await summary().set('Accept-Language', '').query({ month: '2026-10' }).expect(400);
      expect(unchosen.body.error.message).toBe('Okt 2026 belum dimulai: bulan terakhir yang ada adalah Sep 2026.');

      // An English screen's header: English words, and English figures with them.
      const english = await summary().query({ month: '2026-10' }).expect(400);
      expect(english.body.error.message).toBe('Oct 2026 has not begun yet: the latest month is Sep 2026.');

      savedLanguage.current = 'en';
      const chosen = await summary().set('Accept-Language', '').query({ month: '2026-10' }).expect(400);
      expect(chosen.body.error.message).toBe('Oct 2026 has not begun yet: the latest month is Sep 2026.');
    });

    it('P18.10-T5 AC-7 refuses the query’s shapes with its own sentences, in Indonesian', async () => {
      const res = await summary().set('Accept-Language', 'id').query({ month: '2026-13', year: '26' }).expect(400);
      expect(res.body.error).toMatchObject({
        code: 'VALIDATION_FAILED',
        details: { violations: ['month harus berupa bulan, YYYY-MM', 'year harus berupa tahun, YYYY'] },
      });
    });
  });
});
