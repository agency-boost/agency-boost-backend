import mongoose from 'mongoose';
import { MemberNames } from '@/modules/org/member-names.service';
import { clearCollections, startMongo, stopMongo } from '../../../test/mongo';
import { configModule } from '../../../test/config-module';
import { KPM_A, ROSTER_NOW } from '../../../test/coaching-office';
import { buildReportingOffice, type ReportingOffice } from '../../../test/reporting-office';

/**
 * **The readings this phase added to their owning modules** (D-api): each answers nobody for nobody, in no query,
 * and reads what the reports need of the rows the modules already hold — a lead with no registration date by its
 * creation, a month's cells as the month table reads them.
 */
describe('the readings the Owner’s reporting reads through', () => {
  let wired: ReturnType<typeof configModule>;
  let office: ReportingOffice;

  beforeAll(async () => {
    await startMongo();
    wired = configModule(ROSTER_NOW);
    await clearCollections();
    office = await buildReportingOffice(wired);
  }, 120_000);

  afterAll(stopMongo);

  it('P18-T7 AC-1 nobody asked about is nobody answered, and no query sent', async () => {
    const ctx = office.as('OWNER');
    const queries: string[] = [];
    mongoose.set('debug', (collection: string, method: string) => { queries.push(`${collection}.${method}`); });
    try {
      expect(await wired.activityReadings.lastLoggedOnMany(ctx, [])).toEqual(new Map());
      expect(await wired.coachingReadings.countedSince(ctx, [], '2026-09-01')).toEqual([]);
      expect(await wired.leadReadings.countsOfManyAt(ctx, [], { month: '2026-08', at: new Date('2026-08-31T17:00:00Z') })).toEqual(new Map());
      expect(await wired.productionReadings.monthCellsFor(ctx, [], { from: '2026-01', to: '2026-09' })).toEqual(new Map());
    } finally {
      mongoose.set('debug', false);
    }
    expect(queries).toEqual([]);
  });

  it('the office’s people and the active ones’ names: the memberships read once, then the users — byMembershipId’s names', async () => {
    const ctx = office.as('OWNER');
    // Nothing in flight while the queries are counted: a model's automatic index build lands in whichever capture it
    // overlaps (`scorecard.performance.spec.ts`'s note).
    await Promise.all(mongoose.modelNames().map((name) => mongoose.model(name).init()));
    const queries: string[] = [];
    mongoose.set('debug', (collection: string, method: string) => { queries.push(`${collection}.${method}`); });
    let roster: Awaited<ReturnType<typeof wired.officePeople.read>>;
    try {
      roster = await wired.officePeople.read(ctx, null, 'Asia/Jakarta');
    } finally {
      mongoose.set('debug', false);
    }
    // 2026-10-29: the names come from the rows the people read holds — no second read of every membership, whole.
    expect(queries).toEqual(['memberships.find', 'users.find']);
    const byId = await new MemberNames(wired.memberships, wired.users as never)
      .byMembershipId(ctx, roster.active.map((p) => p.membershipId));
    expect(roster.names).toEqual(byId);
    expect(roster.names.get(office.id.SARI)).toBe('Sari Puspita');
    // Every active member here has a name on file: one each, and nobody else's.
    expect([...roster.names.keys()].sort()).toEqual(roster.active.map((p) => p.membershipId).sort());
  });

  it('P18-T2 AC-3 a lead with no registration date stood from its creation; a month’s cells read as the table reads them', async () => {
    const ctx = office.as('OWNER');
    await mongoose.connection.db!.collection('leads').insertOne({
      kpmId: KPM_A, ownerMembershipId: office.id.TARI, type: 'sales', name: 'Old row', statusCode: null, outcome: null,
      commitments: [{ month: '2026-08' }], transitions: [], version: 1, deletedAt: null, dateRegistered: null,
      createdAt: new Date('2026-09-05T03:00:00Z'),
    });
    const atEndOfAugust = await wired.leadReadings.countsOfManyAt(ctx, [office.id.TARI], { month: '2026-08', at: new Date('2026-08-31T17:00:00Z') });
    expect(atEndOfAugust.get(office.id.TARI)).toEqual({ salesOpen: 0, salesClosing: 0, recruitOpen: 0, recruitNominated: 0 });
    const cells = await wired.productionReadings.monthCellsFor(ctx, [office.id.INDAH, office.id.TARI], { from: '2026-08', to: '2026-09' });
    // P19.3-T1: a member's row carries no unit persistency — a leader's own column (D6).
    expect(cells.get(office.id.INDAH)!.get('2026-09')).toEqual({
      apeMonthly: 80 * 1_000_000 * 100, policyCountMonthly: 2, persistencyMonthly: 88, unitPersistencyMonthly: null,
    });
    expect(cells.get(office.id.TARI)).toEqual(new Map());
  });

  it('P18-T1 AC-4 item 5 the latest day logged within a range: either bound alone, both, or the whole history', async () => {
    const ctx = office.as('OWNER');
    const ids = [office.id.INDAH, office.id.RINA];
    // Indah logged the 1st to the 10th, Rina the 1st to today (the 14th).
    expect(await wired.activityReadings.lastLoggedOnMany(ctx, ids))
      .toEqual(new Map([[office.id.INDAH, '2026-09-10'], [office.id.RINA, '2026-09-14']]));
    expect(await wired.activityReadings.lastLoggedOnMany(ctx, ids, { from: '2026-09-11' }))
      .toEqual(new Map([[office.id.RINA, '2026-09-14']]));
    expect(await wired.activityReadings.lastLoggedOnMany(ctx, ids, { to: '2026-09-05' }))
      .toEqual(new Map([[office.id.INDAH, '2026-09-05'], [office.id.RINA, '2026-09-05']]));
    expect(await wired.activityReadings.lastLoggedOnMany(ctx, ids, { from: '2026-09-11', to: '2026-09-12' }))
      .toEqual(new Map([[office.id.RINA, '2026-09-12']]));
  });

  /*
   * *Changed 2026-11-05 (P19.3-T2; ADR-0200 §3):* the month's logging and its comparison with last month are gone, so the
   * Overview makes **one** engagement read, bounded from the week's first day — 8 to 14 September — where it made two
   * from last month's first.
   */
  it('P18-T1 AC-4 item 5, P19.3-T2 the Overview bounds its one engagement read from the week’s first day; the not-logged list reads all history', async () => {
    const ctx = office.as('OWNER');
    const matches: Record<string, unknown>[] = [];
    mongoose.set('debug', (collection: string, method: string, pipeline: unknown) => {
      if (collection === 'activityLogs' && method === 'aggregate') matches.push((pipeline as { $match: Record<string, unknown> }[])[0].$match);
    });
    try {
      await wired.kpmOverview.read(ctx);
      expect(matches.map((m) => m.localDate)).toEqual([{ $gte: '2026-09-08' }]);
      matches.length = 0;
      await wired.kpmOverview.notLogged(ctx);
      expect(matches.map((m) => m.localDate)).toEqual([undefined]);
    } finally {
      mongoose.set('debug', false);
    }
  });
});
