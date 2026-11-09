import mongoose from 'mongoose';
import { FixedClock } from '@/common/clock/clock.port';
import { RequestContext } from '@/common/context/request-context';
import { evaluationInput } from '@/modules/campaigns/campaign-evaluation';
import type { OfficeCampaign, OfficeStanding } from '@/modules/campaigns/campaign-standings-reader';
import { clearCollections, startMongo, stopMongo, syncIndexes } from '../../../../test/mongo';
import { configModule } from '../../../../test/config-module';
import {
  buildCoachingOffice, KPM_A, KPM_B, ROSTER_NOW, type CoachingOffice, type Who,
} from '../../../../test/coaching-office';
import { MemberNames } from '@/modules/org/member-names.service';
import type { ComplianceScope } from './compliance-category';
import { campaignCell, campaignPickerOrder, CampaignsComplianceCategory } from './campaigns.category';

const wib = (local: string) => new Date(`${local}+07:00`).toISOString();
const APE = { metricKey: 'APE_ACHIEVED', comparator: 'gte', value: 1 };
const REASON = 'Persistency corrected by the carrier after the month locked.';

/**
 * **Campaigns in the Owner's compliance tree** (P18.3-T1 AC-3, P18.3-T2 AC-4, AC-6, AC-7): the picker over D-window,
 * the chip over D-chips, and each member's *Chasing* and *Achieved* — **equal to the evaluation the member's own
 * dialog reads** (exit test 4), the override applied. Over `test/coaching-office.ts`: 10:00 on Monday 14 September 2026
 * in Jakarta, August locked.
 *
 * | Campaign | Kind, window | Applies to | Chasers | On the day |
 * |---|---|---|---|---|
 * | `MDRT` | structural, calendar year | all | Agus | running |
 * | `PROMO` | structural promotion, rolling | AAB | — | running |
 * | `SEPT_PUSH` | seasonal, September | all | Rina | running |
 * | `NEXT_PUSH` | seasonal, Q4 | all | — | upcoming |
 * | `AUGUST_PUSH` | seasonal, August, APE ≥ 1 sen | all | Rina (qualified), Budi (not met) | ended, final |
 * | `AGENTS_AUG` | seasonal, August | `AGENT` | — | ended, final |
 * | `LAST_YEAR`, `ARCHIVED_PUSH`, 0555's `B_PUSH` | — | — | — | never listed in 0417 |
 */
describe('the compliance tree’s Campaigns category (P18.3-T2)', () => {
  let wired: ReturnType<typeof configModule>;
  let office: CoachingOffice;
  let category: CampaignsComplianceCategory;
  const db = () => mongoose.connection.db!;
  const YEAR = { from: '2026-01-01', to: '2026-12-31', start: new Date('2026-01-01T00:00:00+07:00'), end: new Date('2027-01-01T00:00:00+07:00') };
  const ACTIVE: Who[] = [
    'OWNER', 'ADMIN', 'AGUS', 'INDAH', 'DIMAS', 'SARI', 'RINA', 'BUDI', 'NINA', 'DODI', 'DEWI', 'LUKAS', 'TARI',
    'PEER_AB', 'PEER_AAB', 'PEER_AGENT',
  ];
  const scopeOf = (ctx: RequestContext, memberIds: string[]): ComplianceScope => ({
    ctx, office: {} as never, today: '2026-09-14', year: YEAR, memberIds,
  });
  const ownerScope = (who: Who[] = ACTIVE, ctx = office.as('OWNER')) => scopeOf(ctx, who.map((w) => office.id[w]));
  const read = (scope: ComplianceScope, item: string | null = null, selected = true) => category.read(scope, { selected, item });
  const ownerB = () => {
    const b = office.as('B_AB');
    return new RequestContext(b.userId, 'none', { ...b.membership!, isKpmOwner: true });
  };
  const chase = (code: string, who: Who) => db().collection('campaignChases').insertOne({
    kpmId: KPM_A, membershipId: office.id[who], campaignCode: code, chasing: true, chasedAt: new Date('2026-01-05T02:00:00Z'),
    unchasedAt: null, closedBy: null, deletedAt: null,
  });

  const build = async () => {
    await clearCollections();
    office = await buildCoachingOffice(wired);
    const o = office.as('OWNER');
    const make = (body: Record<string, unknown>) => wired.campaigns.create(o, body);
    await make({ code: 'MDRT', title: 'MDRT Qualification', kind: 'structural', subtype: 'ongoing', window: 'calendar_year', startsAt: wib('2026-01-01T00:00:00'), endsAt: null, requirements: [APE] });
    await make({
      code: 'PROMO', title: 'Promotion: AAB → AB', kind: 'structural', subtype: 'promotion', window: 'rolling_12m',
      startsAt: wib('2026-01-01T00:00:00'), endsAt: null, appliesToOrgLevelCodes: ['AAB'], requirements: [APE],
    });
    await make({ code: 'SEPT_PUSH', title: 'September Push', startsAt: wib('2026-09-01T00:00:00'), endsAt: wib('2026-09-30T23:59:00'), requirements: [APE] });
    await make({ code: 'NEXT_PUSH', title: 'Q4 Push', startsAt: wib('2026-10-01T00:00:00'), endsAt: wib('2026-12-31T23:59:00'), requirements: [APE] });
    await make({ code: 'AUGUST_PUSH', title: 'August Push', startsAt: wib('2026-08-01T00:00:00'), endsAt: wib('2026-08-31T23:59:00'), requirements: [APE] });
    await make({
      code: 'AGENTS_AUG', title: 'Agents August', startsAt: wib('2026-08-01T00:00:00'), endsAt: wib('2026-08-31T23:59:00'),
      appliesToOrgLevelCodes: ['AGENT'], requirements: [APE],
    });
    await make({ code: 'LAST_YEAR', title: 'Last Year', startsAt: wib('2025-06-01T00:00:00'), endsAt: wib('2025-06-30T23:59:00'), requirements: [APE] });
    const archived = await make({ code: 'ARCHIVED_PUSH', title: 'Archived', startsAt: wib('2026-08-01T00:00:00'), endsAt: wib('2026-08-31T23:59:00'), requirements: [APE] });
    await wired.campaigns.archive(o, archived.id);
    await wired.campaigns.create(ownerB(), { code: 'B_PUSH', title: 'B Push', startsAt: wib('2026-08-01T00:00:00'), endsAt: wib('2026-08-31T23:59:00'), requirements: [APE] });
    await chase('MDRT', 'AGUS');
    await chase('SEPT_PUSH', 'RINA');
    await chase('AUGUST_PUSH', 'RINA');
    await chase('AUGUST_PUSH', 'BUDI');
  };

  beforeAll(async () => {
    await startMongo();
    wired = configModule(ROSTER_NOW);
    category = new CampaignsComplianceCategory(wired.campaignStandingsReader, new MemberNames(wired.memberships, wired.users as never));
    await syncIndexes();
    await build();
  }, 120_000);
  afterAll(stopMongo);

  describe('the picker (P18.3-T2 AC-4, D-window)', () => {
    it('P18.3-T2 AC-4 lists Structural, then Seasonal ongoing and upcoming, then Seasonal past — archived, last year’s and B’s never', async () => {
      const { catalog } = await read(ownerScope(), null, false);
      expect(catalog.map((c) => c.code)).toEqual(['MDRT', 'PROMO', 'SEPT_PUSH', 'NEXT_PUSH', 'AGENTS_AUG', 'AUGUST_PUSH']);
      expect(catalog[0]).toEqual({
        code: 'MDRT', title: 'MDRT Qualification', kind: 'structural', subtype: 'ongoing', phase: 'running',
        startsAt: wib('2026-01-01T00:00:00'), endsAt: null, final: false,
      });
      expect(catalog.find((c) => c.code === 'NEXT_PUSH')).toMatchObject({ kind: 'seasonal', phase: 'upcoming', final: false });
      expect(catalog.find((c) => c.code === 'AUGUST_PUSH')).toMatchObject({ phase: 'ended', final: true, subtype: null });
    });

    it('P18.3-T2 AC-4 opens on the picker’s first campaign without an item, as the prototype does (Owner:3497)', async () => {
      expect((await read(ownerScope())).item).toBe('MDRT');
    });

    it('P18.3-T2 AC-4 404 for a campaign it does not list: archived, last year’s, another office’s, unknown — any case is one code', async () => {
      for (const item of ['ARCHIVED_PUSH', 'LAST_YEAR', 'B_PUSH', 'NOPE']) {
        await expect(read(ownerScope(), item)).rejects.toMatchObject({ code: 'NOT_FOUND', status: 404 });
      }
      expect((await read(ownerScope(), 'august_push')).item).toBe('AUGUST_PUSH');
    });

    it('P18.3-T2 AC-4 an office with no campaign this year: no item, an empty tree, the chip over nobody', async () => {
      const ofOffice = jest.fn(async () => ({ campaigns: [], standings: [] }));
      const empty = new CampaignsComplianceCategory({ ofOffice } as never, {} as never);
      expect(await empty.read(ownerScope(), { selected: true, item: null }))
        .toEqual({ catalog: [], chip: { count: 0, of: 0 }, item: null, cells: new Map() });
      // An item is handed to the port, upper-cased, to refuse before it evaluates (round 1, item 7); none, nothing.
      expect(ofOffice).toHaveBeenLastCalledWith(expect.anything(), expect.objectContaining({ requireListed: undefined }));
      await empty.read(ownerScope(), { selected: true, item: 'mdrt' });
      expect(ofOffice).toHaveBeenLastCalledWith(expect.anything(), expect.objectContaining({ requireListed: 'MDRT' }));
    });

    it('P18.3-T2 AC-4 KPM A never reads KPM B: 0555 lists its own campaign alone, and A’s code is 404 there', async () => {
      const b = scopeOf(ownerB(), [office.id.B_AB, office.id.B_AGENT]);
      const result = await read(b);
      expect(result.catalog.map((c) => c.code)).toEqual(['B_PUSH']);
      await expect(read(b, 'AUGUST_PUSH')).rejects.toMatchObject({ status: 404 });
    });
  });

  describe('the rows (P18.3-T2 AC-6)', () => {
    const cellsOf = async (code: string) => (await read(ownerScope(), code)).cells!;

    it('P18.3-T2 AC-6 an ended seasonal campaign: Chasing and the result; Not chasing and not joined; a chaser’s cell overridable', async () => {
      const cells = await cellsOf('AUGUST_PUSH');
      const of = (who: Who) => cells.get(office.id[who]);
      expect(of('RINA')).toEqual({ status: 'chasing', done: true, on: null, second: 'qualified', override: null, overridable: true });
      expect(of('BUDI')).toEqual({ status: 'chasing', done: true, on: null, second: 'not_met', override: null, overridable: true });
      expect(of('INDAH')).toEqual({ status: 'not_chasing', done: false, on: null, second: 'not_joined', override: null, overridable: false });
    });

    it('P18.3-T2 AC-6 a campaign not open to the member’s rung: — in both, out of every count', async () => {
      const cells = await cellsOf('AGENTS_AUG');
      expect(cells.get(office.id.SARI)).toEqual({ status: null, done: null, on: null, second: null, override: null, overridable: false });
      expect(cells.get(office.id.RINA)).toMatchObject({ status: 'not_chasing', second: 'not_joined' });
    });

    it('P18.3-T2 AC-6 no result drawn while running, before it starts, or for a structural campaign', async () => {
      expect((await cellsOf('SEPT_PUSH')).get(office.id.RINA)).toEqual({ status: 'chasing', done: true, on: null, second: null, override: null, overridable: false });
      expect((await cellsOf('NEXT_PUSH')).get(office.id.RINA)).toMatchObject({ status: 'not_chasing', second: null, overridable: false });
      expect((await cellsOf('MDRT')).get(office.id.AGUS)).toMatchObject({ status: 'chasing', second: null, overridable: false });
      expect((await cellsOf('PROMO')).get(office.id.AGUS)).toMatchObject({ status: null, done: null });
    });

    it.each(['AUGUST_PUSH', 'SEPT_PUSH', 'MDRT', 'AGENTS_AUG'])(
      'P18.3-T2 AC-6 exit test 4: for %s, Chasing and the result equal the evaluation each member’s own dialog reads',
      async (code) => {
        const cells = await cellsOf(code);
        const row = (await wired.campaignRows.findOne(office.as('OWNER'), { code }))!;
        for (const who of ACTIVE) {
          const mine = (await wired.campaignEvaluation.evaluate(office.as(who), [evaluationInput(row)], [office.id[who]]))
            .get(code)!.members.get(office.id[who])!;
          const cell = cells.get(office.id[who])!;
          if (!mine.eligible) {
            expect([who, cell.status]).toEqual([who, null]);
            continue;
          }
          expect([who, cell.status]).toEqual([who, mine.chasing ? 'chasing' : 'not_chasing']);
          if (code === 'AUGUST_PUSH' || code === 'AGENTS_AUG') expect([who, cell.second]).toEqual([who, mine.status]);
        }
      },
    );

    it('P18.3-T2 AC-7 an override shows in the result, with who, when and why — and still equals the evaluation', async () => {
      await wired.campaignStandingOverrides.override(office.as('ADMIN'), 'AUGUST_PUSH', office.id.BUDI, { status: 'qualified', reason: REASON });
      try {
        const cell = (await cellsOf('AUGUST_PUSH')).get(office.id.BUDI);
        expect(cell).toEqual({
          status: 'chasing', done: true, on: null, second: 'qualified', overridable: true,
          override: { status: 'qualified', reason: REASON, by: { membershipId: office.id.ADMIN, name: office.name.ADMIN }, at: ROSTER_NOW.toISOString() },
        });
        const row = (await wired.campaignRows.findOne(office.as('OWNER'), { code: 'AUGUST_PUSH' }))!;
        const mine = (await wired.campaignEvaluation.evaluate(office.as('BUDI'), [evaluationInput(row)], [office.id.BUDI])).get('AUGUST_PUSH')!;
        expect(mine.members.get(office.id.BUDI)!.status).toBe(cell!.second);
      } finally {
        await wired.campaignStandingOverrides.clear(office.as('ADMIN'), 'AUGUST_PUSH', office.id.BUDI, { reason: 'Test done.' });
      }
    });

    it('P18.3-T2 AC-8 an override by somebody the office cannot name reads an empty name', async () => {
      await wired.campaignStandingOverrides.override(RequestContext.forJob(KPM_A, 'correction'), 'AUGUST_PUSH', office.id.BUDI, {
        status: 'qualified', reason: REASON,
      });
      try {
        expect((await cellsOf('AUGUST_PUSH')).get(office.id.BUDI)!.override!.by).toEqual({ membershipId: 'job:correction', name: '' });
      } finally {
        await wired.campaignStandingOverrides.clear(office.as('OWNER'), 'AUGUST_PUSH', office.id.BUDI, { reason: 'Test done.' });
      }
    });

    it('round 1: the reader’s own row is never overridable — no control is drawn on it; another’s is', async () => {
      // Whoever reads: here Rina's own context, over the push she chased.
      const cells = (await read(ownerScope(ACTIVE, office.as('RINA')), 'AUGUST_PUSH')).cells!;
      expect(cells.get(office.id.RINA)).toMatchObject({ second: 'qualified', overridable: false });
      expect(cells.get(office.id.BUDI)).toMatchObject({ second: 'not_met', overridable: true });
      // The Owner's read: both overridable, neither is the Owner's.
      const owners = (await read(ownerScope(), 'AUGUST_PUSH')).cells!;
      expect(owners.get(office.id.RINA)).toMatchObject({ overridable: true });
    });

    it('P18.3-T2 AC-6 serves a cell for the tree’s members only, and none when not selected', async () => {
      const result = await read(ownerScope(['RINA', 'BUDI']), 'AUGUST_PUSH');
      expect([...result.cells!.keys()].sort()).toEqual([office.id.RINA, office.id.BUDI].sort());
      expect((await read(ownerScope(), null, false)).cells).toBeNull();
    });
  });

  describe('the chip (P18.3-T1 AC-3, D-chips)', () => {
    it('P18.3-T1 AC-3 chasing one listed campaign, over those eligible for one', async () => {
      // Everybody is eligible for an all-rungs campaign; Agus (MDRT), Rina and Budi chase.
      expect((await read(ownerScope(), null, false)).chip).toEqual({ count: 3, of: ACTIVE.length });
      expect((await read(ownerScope(['RINA', 'INDAH']), null, false)).chip).toEqual({ count: 1, of: 2 });
    });
  });

  describe('the freeze through the tree (P18.3-T2 AC-5; ADR-0144)', () => {
    beforeAll(build, 120_000);
    const finalised = () => db().collection('auditLog').countDocuments({ action: 'campaign_standing.finalised' });

    it('round 1 item 7: a refused read — a code the year does not list — freezes nothing and audits nothing', async () => {
      // August's two windows are final and nobody has read them yet: any evaluating read would freeze them.
      for (const item of ['NOPE', 'LAST_YEAR', 'ARCHIVED_PUSH', 'B_PUSH']) {
        await expect(read(ownerScope(), item)).rejects.toMatchObject({ code: 'NOT_FOUND', status: 404 });
      }
      expect(await db().collection('campaignStandings').countDocuments({})).toBe(0);
      expect(await finalised()).toBe(0);
    });

    it('P18.3-T2 AC-5 a read-only session reads the frozen view and writes nothing; the first other read freezes it once', async () => {
      const o = office.as('OWNER');
      const readOnly = new RequestContext(o.userId, 'none', o.membership, 'u-operator', null, false, true);
      const viewed = (await read(ownerScope(ACTIVE, readOnly), 'AUGUST_PUSH')).cells!;
      expect(viewed.get(office.id.RINA)).toMatchObject({ second: 'qualified', overridable: true });
      expect(await db().collection('campaignStandings').countDocuments({})).toBe(0);
      expect(await finalised()).toBe(0);
      await read(ownerScope(), 'AUGUST_PUSH');
      expect(await finalised()).toBe(2);   // August's two windows: AUGUST_PUSH's and AGENTS_AUG's, each once
      await read(ownerScope(), 'AUGUST_PUSH');
      expect(await finalised()).toBe(2);
      expect(await db().collection('campaignStandings').countDocuments({ kpmId: KPM_A })).toBe(2);
    });
  });

  /*
   * **M1** (the exit review, round 1): a seasonal campaign whose window's last month is last December becomes final in
   * January — inside this year — so the tree lists it under *Seasonal — Past*, and its result can be overridden.
   */
  describe('M1 — last December’s campaign, read in January', () => {
    const JANUARY = new Date('2027-01-12T03:00:00Z');
    const YEAR_2027 = { from: '2027-01-01', to: '2027-12-31', start: new Date('2027-01-01T00:00:00+07:00'), end: new Date('2028-01-01T00:00:00+07:00') };
    const january = (ctx = office.as('OWNER')): ComplianceScope => ({
      ctx, office: {} as never, today: '2027-01-12', year: YEAR_2027, memberIds: ACTIVE.map((w) => office.id[w]),
    });

    beforeAll(async () => {
      await build();
      const o = office.as('OWNER');
      await wired.campaigns.create(o, { code: 'DEC_PUSH', title: 'December Push', startsAt: wib('2026-12-01T00:00:00'), endsAt: wib('2026-12-31T23:59:00'), requirements: [APE] });
      await wired.campaigns.create(o, { code: 'NOV_PUSH', title: 'November Push', startsAt: wib('2026-11-01T00:00:00'), endsAt: wib('2026-11-30T23:59:00'), requirements: [APE] });
      await chase('DEC_PUSH', 'RINA');
      await chase('NOV_PUSH', 'BUDI');
      (wired.clock as FixedClock).set(JANUARY);
      // December's file never arrived. A month never written stays open whatever its date (P19.5-T2; ADR-0214 §11), so the
      // Owner has locked it by hand: the window is final with nothing to decide it.
      await wired.productionMonths.lock(o, '2026-12');
    }, 120_000);
    afterAll(() => (wired.clock as FixedClock).set(ROSTER_NOW));

    it('M1 lists last December’s campaigns under Seasonal — Past, final; November’s and earlier never', async () => {
      const { catalog } = await read(january(), null, false);
      expect(catalog.map((c) => c.code)).toEqual(['MDRT', 'PROMO', 'DEC_PUSH', 'NEXT_PUSH']);
      expect(catalog.find((c) => c.code === 'DEC_PUSH')).toMatchObject({ kind: 'seasonal', phase: 'ended', final: true });
      await expect(read(january(), 'NOV_PUSH')).rejects.toMatchObject({ status: 404 });
    });

    it('M1 the chip follows the window: Rina chasing December’s counts, Budi chasing November’s does not', async () => {
      expect((await read(january(), null, false)).chip).toEqual({ count: 2, of: ACTIVE.length });   // Agus (MDRT), Rina
    });

    it('M1 its result can be overridden from the tree: overridable, and the override lands', async () => {
      const before = (await read(january(), 'DEC_PUSH')).cells!.get(office.id.RINA);
      // December's file never arrived: final, and nothing could decide it.
      expect(before).toMatchObject({ status: 'chasing', second: 'unknown', overridable: true });
      await wired.campaignStandingOverrides.override(office.as('ADMIN'), 'DEC_PUSH', office.id.RINA, { status: 'qualified', reason: REASON });
      expect((await read(january(), 'DEC_PUSH')).cells!.get(office.id.RINA))
        .toMatchObject({ second: 'qualified', override: { by: { membershipId: office.id.ADMIN } } });
    });
  });

  /*
   * **Round 2** (the exit review's parity check): every seasonal campaign not started yet is listed, whatever its year
   * — members chase one before it starts. Read in mid-November, with one starting in January (F-242's *Upcoming*).
   */
  describe('round 2 — an upcoming campaign next year, read in mid-November', () => {
    const NOVEMBER = new Date('2026-11-16T03:00:00Z');

    beforeAll(async () => {
      await build();
      const o = office.as('OWNER');
      await wired.campaigns.create(o, { code: 'JAN_PUSH', title: 'January Push', startsAt: wib('2027-01-01T00:00:00'), endsAt: wib('2027-01-31T23:59:00'), requirements: [APE] });
      const archived = await wired.campaigns.create(o, {
        code: 'ARCHIVED_FEB', title: 'Archived February', startsAt: wib('2027-02-01T00:00:00'), endsAt: wib('2027-02-28T23:59:00'), requirements: [APE],
      });
      await wired.campaigns.archive(o, archived.id);
      await chase('JAN_PUSH', 'DIMAS');
      (wired.clock as FixedClock).set(NOVEMBER);
    }, 120_000);
    afterAll(() => (wired.clock as FixedClock).set(ROSTER_NOW));

    it('round 2 lists next January’s campaign under Seasonal — Ongoing, upcoming; last year’s and an archived upcoming one never', async () => {
      const { catalog } = await read(ownerScope(), null, false);
      expect(catalog.map((c) => c.code)).toEqual(['MDRT', 'PROMO', 'NEXT_PUSH', 'JAN_PUSH', 'SEPT_PUSH', 'AGENTS_AUG', 'AUGUST_PUSH']);
      expect(catalog.find((c) => c.code === 'JAN_PUSH')).toMatchObject({ kind: 'seasonal', phase: 'upcoming', final: false });
      for (const item of ['LAST_YEAR', 'ARCHIVED_FEB']) await expect(read(ownerScope(), item)).rejects.toMatchObject({ status: 404 });
    });

    it('round 2 its rows and the chip follow: Dimas chasing it counts; no result drawn before it starts', async () => {
      const result = await read(ownerScope(), 'JAN_PUSH');
      expect(result.cells!.get(office.id.DIMAS)).toEqual({
        status: 'chasing', done: true, on: null, second: null, override: null, overridable: false,
      });
      // Agus (MDRT), Rina (September's, August's), Budi (August's) and Dimas (January's).
      expect(result.chip).toEqual({ count: 4, of: ACTIVE.length });
    });
  });

  describe('pure rules', () => {
    const campaign = (over: Partial<OfficeCampaign>): OfficeCampaign => ({
      code: 'C', title: 'C', kind: 'seasonal', subtype: null, phase: 'ended', window: 'campaign_dates',
      startsAt: '2026-08-01T00:00:00.000Z', endsAt: '2026-08-31T00:00:00.000Z', appliesToOrgLevelCodes: [],
      windowKey: 'k', windowLabel: 'l', final: true, ...over,
    });
    const standing = (over: Partial<OfficeStanding>): OfficeStanding => ({
      campaignCode: 'C', membershipId: 'm', chasing: true, eligible: true, status: 'unknown', final: true, overridden: null, ...over,
    });

    it('round 1: the reader’s own final standing is never overridable', () => {
      expect(campaignCell(standing({}), campaign({}), () => '', true)).toMatchObject({ second: 'unknown', overridable: false });
    });

    it('P18.3-T2 AC-8 a final unknown is overridable; an ended but not final one is not', () => {
      expect(campaignCell(standing({}), campaign({}), () => '')).toMatchObject({ second: 'unknown', overridable: true });
      expect(campaignCell(standing({ final: false, status: 'in_progress' }), campaign({ final: false }), () => ''))
        .toMatchObject({ second: 'in_progress', overridable: false });
      expect(campaignCell(undefined, campaign({}), () => '')).toMatchObject({ status: null, overridable: false });
    });

    it('P18.3-T2 AC-4 the picker’s order: structural before seasonal whatever the dates', () => {
      const a = campaign({ code: 'A', kind: 'seasonal', phase: 'running' });
      const b = campaign({ code: 'B', title: 'B', kind: 'structural', phase: 'running', endsAt: null });
      expect([a, b].sort(campaignPickerOrder).map((c) => c.code)).toEqual(['B', 'A']);
    });
  });

  it('refuses to read without an office', async () => {
    await expect(read(scopeOf(RequestContext.platform('root'), []))).rejects.toThrow();
    expect(KPM_B).not.toBe(KPM_A);
  });
});
