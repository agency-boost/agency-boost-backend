import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, normalize } from 'node:path';
import mongoose from 'mongoose';
import { clearCollections, startMongo, stopMongo } from '../../../test/mongo';
import { configModule } from '../../../test/config-module';
import { inWindow } from './campaign-standings-reader';
import { FixedClock } from '@/common/clock/clock.port';
import { buildCoachingOffice, KPM_A, ROSTER_NOW, type CoachingOffice } from '../../../test/coaching-office';

const SRC = join(__dirname, '../..');
const wib = (local: string) => new Date(`${local}+07:00`).toISOString();
const TZ = 'Asia/Jakarta';

/** A file's imports, resolved to files under `src/`. */
function importsOf(file: string): string[] {
  return [...readFileSync(file, 'utf8').matchAll(/from\s+'([^']+)'/g)].flatMap(([, spec]) => {
    const base = spec.startsWith('@/') ? join(SRC, spec.slice(2)) : spec.startsWith('.') ? normalize(join(dirname(file), spec)) : null;
    if (base === null) return [];
    return [`${base}.ts`, join(base, 'index.ts')].filter((c) => existsSync(c)).slice(0, 1);
  });
}

/**
 * **The port Phase 18.6's tree reads** (P18.5-T8 AC-8): `CampaignStandingsReader.ofOffice(ctx, { codes? })` — per
 * campaign its identity, kind, phase, window and eligibility; per member and campaign the chase, the eligibility, the
 * status (`not_joined` for a member who did not chase, ADR-0143) and its finality. Its shape is pinned here, and its
 * imports: no route, no screen, no reader of another module's raw collections.
 */
describe('the standings port (P18.5-T8 AC-8; P18.6-T2 AC-7)', () => {
  let wired: ReturnType<typeof configModule>;
  let office: CoachingOffice;

  beforeAll(async () => {
    await startMongo();
    wired = configModule(ROSTER_NOW);
    await clearCollections();
    office = await buildCoachingOffice(wired);
    const owner = office.as('OWNER');
    await wired.campaigns.create(owner, {
      code: 'AUGUST_PUSH', title: 'August Push', startsAt: wib('2026-08-01T00:00:00'), endsAt: wib('2026-08-31T23:59:00'),
      appliesToOrgLevelCodes: ['AGENT'], requirements: [{ metricKey: 'APE_ACHIEVED', comparator: 'gte', value: 1 }],
    });
    await wired.campaigns.create(owner, {
      code: 'SEPT_PUSH', title: 'September Push', startsAt: wib('2026-09-01T00:00:00'), endsAt: wib('2026-09-30T23:59:00'),
      requirements: [{ metricKey: 'APE_ACHIEVED', comparator: 'gte', value: 1 }],
    });
    await mongoose.connection.db!.collection('campaignChases').insertOne({
      kpmId: KPM_A, membershipId: office.id.RINA, campaignCode: 'AUGUST_PUSH', chasing: true, deletedAt: null,
    });
  }, 60_000);
  afterAll(stopMongo);

  it('P18.5-T8 AC-8 answers every campaign and every active member, in a pinned shape', async () => {
    const read = await wired.campaignStandingsReader.ofOffice(office.as('OWNER'));
    expect(read.campaigns.map((c) => c.code)).toEqual(['AUGUST_PUSH', 'SEPT_PUSH']);
    expect(Object.keys(read.campaigns[0]).sort()).toEqual([
      'appliesToOrgLevelCodes', 'code', 'endsAt', 'final', 'kind', 'phase', 'startsAt', 'subtype', 'title', 'window',
      'windowKey', 'windowLabel',
    ]);
    expect(read.campaigns[0]).toMatchObject({
      code: 'AUGUST_PUSH', phase: 'ended', final: true, windowKey: '2026-08..2026-08', windowLabel: 'Agu 2026',
      appliesToOrgLevelCodes: ['AGENT'],
    });
    const active = await mongoose.connection.db!.collection('memberships').countDocuments({ kpmId: KPM_A, status: 'active' });
    expect(read.standings).toHaveLength(2 * active);
    // P18.6-T2 AC-7: `overridden` added — who, when and why — `null` without an override.
    expect(Object.keys(read.standings[0]).sort()).toEqual([
      'campaignCode', 'chasing', 'eligible', 'final', 'membershipId', 'overridden', 'status',
    ]);
    const of = (code: string, id: string) => read.standings.find((s) => s.campaignCode === code && s.membershipId === id)!;
    expect(of('AUGUST_PUSH', office.id.RINA)).toEqual({
      campaignCode: 'AUGUST_PUSH', membershipId: office.id.RINA, chasing: true, eligible: true, status: 'qualified', final: true,
      overridden: null,
    });
    // ADR-0143: a member who did not chase is `not_joined`, whatever they produced — the tree's *Not achieved*.
    expect(of('AUGUST_PUSH', office.id.INDAH)).toMatchObject({ chasing: false, status: 'not_joined' });
    expect(of('AUGUST_PUSH', office.id.SARI)).toMatchObject({ eligible: false, status: 'not_joined' });
    expect(of('SEPT_PUSH', office.id.RINA)).toMatchObject({ final: false, status: 'not_joined' });
    // A member who has left is in no row.
    expect(read.standings.some((s) => s.membershipId === office.id.LEFT)).toBe(false);
  });

  it('P18.5-T8 AC-8 narrows to the codes asked for', async () => {
    const read = await wired.campaignStandingsReader.ofOffice(office.as('OWNER'), { codes: ['SEPT_PUSH'] });
    expect(read.campaigns.map((c) => c.code)).toEqual(['SEPT_PUSH']);
    expect(new Set(read.standings.map((s) => s.campaignCode))).toEqual(new Set(['SEPT_PUSH']));
  });

  it('P18.6-T2 AC-7 reads only the members asked for, a leaver included, without reading the office’s memberships', async () => {
    await Promise.all(mongoose.modelNames().map((name) => mongoose.model(name).init()));
    const queries: string[] = [];
    mongoose.set('debug', (collection: string, method: string) => { queries.push(`${collection}.${method}`); });
    const read = await wired.campaignStandingsReader.ofOffice(office.as('OWNER'), { memberIds: [office.id.RINA, office.id.LEFT] })
      .finally(() => mongoose.set('debug', false));
    expect(new Set(read.standings.map((s) => s.membershipId))).toEqual(new Set([office.id.RINA, office.id.LEFT]));
    expect(read.standings).toHaveLength(2 * read.campaigns.length);
    // The office's every active membership is not read: the one memberships read is the evaluation's, of the two.
    expect(queries.filter((q) => q.startsWith('memberships.'))).toHaveLength(1);
  });

  it('P18.6-T2 AC-7 applies an override the stored standing carries — the status read and who, when and why', async () => {
    const at = new Date('2026-09-14T02:00:00Z');
    await mongoose.connection.db!.collection('campaignStandings').updateOne(
      { kpmId: KPM_A, campaignCode: 'AUGUST_PUSH', membershipId: office.id.RINA },
      { $set: { override: { status: 'not_met', reason: 'Lapsed policy', byMembershipId: office.id.OWNER, at, previousStatus: 'qualified' } } },
    );
    try {
      const read = await wired.campaignStandingsReader.ofOffice(office.as('OWNER'), { codes: ['AUGUST_PUSH'], memberIds: [office.id.RINA] });
      expect(read.standings).toEqual([{
        campaignCode: 'AUGUST_PUSH', membershipId: office.id.RINA, chasing: true, eligible: true, status: 'not_met', final: true,
        overridden: { status: 'not_met', reason: 'Lapsed policy', byMembershipId: office.id.OWNER, at: at.toISOString() },
      }]);
      // The frozen status is the one frozen: the override sits beside it.
      expect((await mongoose.connection.db!.collection('campaignStandings').findOne({ campaignCode: 'AUGUST_PUSH', membershipId: office.id.RINA }))!.status)
        .toBe('qualified');
    } finally {
      await mongoose.connection.db!.collection('campaignStandings').updateOne(
        { kpmId: KPM_A, campaignCode: 'AUGUST_PUSH', membershipId: office.id.RINA }, { $set: { override: null } },
      );
    }
  });

  describe('D-window (P18.6-T1, P18.6-T2 AC-4): this year in the office’s zone', () => {
    const YEAR = { start: new Date('2026-01-01T00:00:00+07:00'), end: new Date('2027-01-01T00:00:00+07:00') };
    const raw = (code: string, over: Record<string, unknown>) => ({
      kpmId: KPM_A, code, title: code, kind: 'seasonal', subtype: null, window: 'campaign_dates', appliesToOrgLevelCodes: [],
      requirements: [], frozenWindows: [], version: 1, status: 'active', deletedAt: null, ...over,
    });

    beforeAll(async () => {
      await mongoose.connection.db!.collection('campaigns').insertMany([
        raw('LAST_YEAR', { startsAt: new Date('2025-06-01T00:00:00+07:00'), endsAt: new Date('2025-06-30T23:59:59.999+07:00') }),
        raw('ACROSS_NEW_YEAR', { startsAt: new Date('2025-12-01T00:00:00+07:00'), endsAt: new Date('2026-01-31T23:59:59.999+07:00') }),
        raw('ENDS_AT_THE_START', { startsAt: new Date('2025-12-01T00:00:00+07:00'), endsAt: new Date('2025-12-31T23:59:59.999+07:00') }),
        raw('NOVEMBER_LAST_YEAR', { startsAt: new Date('2025-11-01T00:00:00+07:00'), endsAt: new Date('2025-11-30T23:59:59.999+07:00') }),
        raw('NEXT_QUARTER', { startsAt: new Date('2026-10-01T00:00:00+07:00'), endsAt: new Date('2026-12-31T23:59:59.999+07:00') }),
        raw('NEXT_YEAR', { startsAt: new Date('2027-01-01T00:00:00+07:00'), endsAt: new Date('2027-01-31T23:59:59.999+07:00') }),
        raw('MDRT_RUNNING', { kind: 'structural', subtype: 'ongoing', window: 'calendar_year', startsAt: new Date('2026-01-01T00:00:00+07:00'), endsAt: null }),
        raw('PROMO_LATER', { kind: 'structural', subtype: 'promotion', window: 'rolling_12m', startsAt: new Date('2026-10-01T00:00:00+07:00'), endsAt: null }),
        raw('STRUCT_ENDED', { kind: 'structural', subtype: 'ongoing', window: 'calendar_year', startsAt: new Date('2025-01-01T00:00:00+07:00'), endsAt: new Date('2026-06-30T23:59:59.999+07:00') }),
        raw('ARCHIVED_THIS_YEAR', { status: 'archived', startsAt: new Date('2026-09-01T00:00:00+07:00'), endsAt: new Date('2026-09-30T23:59:59.999+07:00') }),
      ]);
    });

    it('P18.6-T2 AC-4 seasonal campaigns overlapping the year, ended ones included; structural ones running; archived never', async () => {
      const read = await wired.campaignStandingsReader.ofOffice(office.as('OWNER'), { window: YEAR, memberIds: [office.id.RINA] });
      expect(read.campaigns.map((c) => c.code).sort()).toEqual([
        // M1: last December's campaign is listed — it became final this January; November's is not. Round 2: next
        // January's, not started yet, is listed too.
        'ACROSS_NEW_YEAR', 'AUGUST_PUSH', 'ENDS_AT_THE_START', 'MDRT_RUNNING', 'NEXT_QUARTER', 'NEXT_YEAR', 'SEPT_PUSH',
      ]);
      expect(read.campaigns.find((c) => c.code === 'NEXT_YEAR')!.phase).toBe('upcoming');
      expect(read.campaigns.find((c) => c.code === 'NEXT_QUARTER')!.phase).toBe('upcoming');
      expect(read.campaigns.find((c) => c.code === 'ACROSS_NEW_YEAR')!.phase).toBe('ended');
    });

    it('M1 with the clock in January: last December’s campaign is listed, ended and final; one ended in November is not', async () => {
      const clock = wired.clock as FixedClock;
      clock.set(new Date('2027-01-12T03:00:00Z'));
      try {
        const year2027 = { start: new Date('2027-01-01T00:00:00+07:00'), end: new Date('2028-01-01T00:00:00+07:00') };
        const read = await wired.campaignStandingsReader.ofOffice(office.as('OWNER'), { window: year2027, memberIds: [office.id.RINA] });
        expect(read.campaigns.map((c) => c.code).sort()).toEqual(['MDRT_RUNNING', 'NEXT_QUARTER', 'NEXT_YEAR', 'PROMO_LATER']);
        expect(read.campaigns.find((c) => c.code === 'NEXT_QUARTER')).toMatchObject({ phase: 'ended', final: true, windowKey: '2026-10..2026-12' });
        expect(read.campaigns.map((c) => c.code)).not.toContain('SEPT_PUSH');
      } finally {
        clock.set(ROSTER_NOW);
      }
    });

    it('round 1 item 7: a code the list does not hold is 404 before anything is evaluated — no query past the list', async () => {
      // Nothing in flight when the queries are captured: a model's automatic index build would land in the log.
      await Promise.all(mongoose.modelNames().map((name) => mongoose.model(name).init()));
      for (const code of ['NOPE', 'LAST_YEAR', 'ARCHIVED_THIS_YEAR', 'NOVEMBER_LAST_YEAR']) {
        const queries: string[] = [];
        mongoose.set('debug', (collection: string, method: string) => { queries.push(`${collection}.${method}`); });
        await expect(wired.campaignStandingsReader.ofOffice(office.as('OWNER'), { window: YEAR, memberIds: [office.id.RINA], requireListed: code })
          .finally(() => mongoose.set('debug', false))).rejects.toMatchObject({ code: 'NOT_FOUND', status: 404 });
        expect(queries.sort()).toEqual(['campaigns.find', 'kpms.findOne']);
      }
      const read = await wired.campaignStandingsReader.ofOffice(office.as('OWNER'), { window: YEAR, memberIds: [office.id.RINA], requireListed: 'SEPT_PUSH' });
      expect(read.campaigns.map((c) => c.code)).toContain('SEPT_PUSH');
    });

    it('P18.6-T2 AC-4 without a window every active campaign is read, as before', async () => {
      const read = await wired.campaignStandingsReader.ofOffice(office.as('OWNER'), { memberIds: [office.id.RINA] });
      expect(read.campaigns.map((c) => c.code)).not.toContain('ARCHIVED_THIS_YEAR');
      expect(read.campaigns.map((c) => c.code)).toEqual(expect.arrayContaining(['LAST_YEAR', 'NEXT_YEAR', 'PROMO_LATER', 'STRUCT_ENDED']));
    });

    it('P18.6-T2 AC-4 the window’s edges: an end at its first instant is in, a start at its end is out', () => {
      const now = new Date('2026-09-14T03:00:00Z');
      const seasonal = (startsAt: string, endsAt: string | null) => ({ kind: 'seasonal', startsAt: new Date(startsAt), endsAt: endsAt ? new Date(endsAt) : null });
      expect(inWindow(seasonal('2025-12-01T00:00:00+07:00', '2026-01-01T00:00:00+07:00'), YEAR, now, TZ)).toBe(true);
      // M1: a window whose last month is last December is listed — it becomes final in this year …
      expect(inWindow(seasonal('2025-12-01T00:00:00+07:00', '2025-12-31T23:59:59.999+07:00'), YEAR, now, TZ)).toBe(true);
      expect(inWindow(seasonal('2025-10-01T00:00:00+07:00', '2025-12-15T23:59:00+07:00'), YEAR, now, TZ)).toBe(true);
      // … one whose last month is November, or earlier, is not.
      expect(inWindow(seasonal('2025-11-01T00:00:00+07:00', '2025-11-30T23:59:59.999+07:00'), YEAR, now, TZ)).toBe(false);
      // December in the office's zone: 30 November 23:00 in Jakarta is 30 November there, whatever UTC says.
      expect(inWindow(seasonal('2025-11-01T00:00:00+07:00', '2025-11-30T23:00:00+07:00'), YEAR, now, TZ)).toBe(false);
      expect(inWindow(seasonal('2026-12-31T23:59:59.999+07:00', null), YEAR, now, TZ)).toBe(true);
      // Round 2: not started yet, whatever its year — listed (*Seasonal — Ongoing*, tagged *Upcoming*) …
      expect(inWindow(seasonal('2027-01-01T00:00:00+07:00', '2027-03-31T23:59:59.999+07:00'), YEAR, now, TZ)).toBe(true);
      // … one that has started outside the year is not (a clock past the window's end).
      expect(inWindow(seasonal('2027-01-01T00:00:00+07:00', null), YEAR, new Date('2027-02-01T00:00:00Z'), TZ)).toBe(false);
      const structural = (startsAt: string, endsAt: string | null) => ({ kind: 'structural', startsAt: new Date(startsAt), endsAt: endsAt ? new Date(endsAt) : null });
      expect(inWindow(structural('2020-01-01T00:00:00Z', null), YEAR, now, TZ)).toBe(true);
      expect(inWindow(structural('2026-10-01T00:00:00Z', null), YEAR, now, TZ)).toBe(false);
      expect(inWindow(structural('2020-01-01T00:00:00Z', '2026-09-01T00:00:00Z'), YEAR, now, TZ)).toBe(false);
    });
  });

  it('P18.5-T8 AC-8 imports only the evaluation, its repositories and the membership repository — no route, no screen', () => {
    const file = join(__dirname, 'campaign-standings-reader.ts');
    const direct = importsOf(file).map((f) => f.slice(SRC.length + 1)).sort();
    expect(direct).toEqual([
      'common/clock/clock.port.ts',
      'common/context/request-context.ts',
      // `requireListed`'s 404, before anything is evaluated (round 1, item 7).
      'common/errors/domain.exception.ts',
      'common/time/local-day.ts',
      'domain/constants/index.ts',
      'domain/metrics/campaign-qualification.ts',
      'domain/metrics/campaign-window.ts',
      'modules/campaigns/campaign-evaluation.ts',
      'modules/campaigns/campaign.repository.ts',
      'modules/org/membership.repository.ts',
      // The office's zone, which the window's months are read in (M1), read once and handed to the evaluation.
      'modules/tenants/tenant-day.service.ts',
    ]);
  });
});
