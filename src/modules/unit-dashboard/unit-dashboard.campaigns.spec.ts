import mongoose from 'mongoose';
import { SOURCE_READER } from '@/common/i18n/reader';
import { clearCollections, startMongo, stopMongo } from '../../../test/mongo';
import { configModule } from '../../../test/config-module';
import { buildCoachingOffice, KPM_A, ROSTER_NOW, type CoachingOffice, type Who } from '../../../test/coaching-office';
import type { UnitDashboardView, UnitGroup, UnitRow } from './unit-dashboard.service';

const wib = (local: string) => new Date(`${local}+07:00`).toISOString();
const rowsOf = (g: UnitGroup): UnitRow[] => [g.head, ...g.members, ...g.units.flatMap(rowsOf)];
const everyRow = (v: UnitDashboardView): UnitRow[] => [...v.yourUnit.rows, ...v.units.flatMap(rowsOf)];

/**
 * ***Chasing MDRT*** **and *Campaigns they're chasing*** on the Unit Dashboard (P18.2-T7 AC-7, AC-8; ADR-0122,
 * ADR-0142 §3): ✓ is a chase of `MDRT_QUALIFICATION` not ended, the chips the chases not ended by title, both from the
 * campaigns module's one chase reader in the dashboard's one read — and only inside `campaign_qualification:read`'s
 * reach, the dashboard's own reach unchanged.
 */
describe('the Unit Dashboard’s campaign parts (P18.2-T7)', () => {
  let wired: ReturnType<typeof configModule>;
  let office: CoachingOffice;
  const db = () => mongoose.connection.db!;
  /** Read in the API's English, as asserted below: nobody's choice is Bahasa Indonesia since P18.10-T4's exit. */
  const read = (who: Who, query: { for?: string } = {}) => wired.unitDashboard.read(office.as(who).withReader(SOURCE_READER), query);
  const row = (v: UnitDashboardView, who: Who) => everyRow(v).find((r) => r.membershipId === office.id[who])!;
  const chase = (who: Who, code: string) => db().collection('campaignChases').insertOne({
    kpmId: KPM_A, membershipId: office.id[who], campaignCode: code, chasing: true, deletedAt: null,
  });

  beforeAll(async () => {
    await startMongo();
    wired = configModule(ROSTER_NOW);
    await clearCollections();
    office = await buildCoachingOffice(wired);
    const owner = office.as('OWNER');
    await wired.campaigns.create(owner, {
      code: 'MDRT_QUALIFICATION', title: 'MDRT Qualification', kind: 'structural', subtype: 'ongoing', window: 'calendar_year',
      startsAt: wib('2026-01-01T00:00:00'), endsAt: null,
      requirements: [{ metricKey: 'APE_ACHIEVED', comparator: 'gte', value: 240_000_000_000 }],
    });
    await wired.campaigns.create(owner, {
      code: 'APE_SPRINT', title: 'APE Sprint', startsAt: wib('2026-09-01T00:00:00'), endsAt: wib('2026-09-30T23:59:00'),
      requirements: [],
    });
    await wired.campaigns.create(owner, {
      code: 'OLD_PUSH', title: 'Mid-Year Push', startsAt: wib('2026-06-01T00:00:00'), endsAt: wib('2026-07-31T23:59:00'),
      requirements: [],
    });
    for (const who of ['RINA', 'AGUS', 'DIMAS', 'TARI'] as const) await chase(who, 'MDRT_QUALIFICATION');
    await chase('RINA', 'APE_SPRINT');
    await chase('BUDI', 'OLD_PUSH');
  }, 60_000);
  afterAll(stopMongo);

  it('P18.2-T7 AC-7, AC-8 Sari’s unit: Rina ✓ with her chips by title; Budi —, his only chase ended', async () => {
    const v = await read('SARI');
    expect(row(v, 'RINA')).toMatchObject({
      chasingMdrt: true,
      campaigns: [{ code: 'APE_SPRINT', title: 'APE Sprint' }, { code: 'MDRT_QUALIFICATION', title: 'MDRT Qualification' }],
    });
    expect(row(v, 'BUDI')).toMatchObject({ chasingMdrt: false, campaigns: [] });
    expect(row(v, 'SARI')).toMatchObject({ chasingMdrt: false, campaigns: [] });
  });

  it('P18.2-T7 AC-7 two chips of one title are ordered by code, so two reads never shuffle them', async () => {
    const owner = office.as('OWNER');
    for (const code of ['ZETA_PUSH', 'ALPHA_PUSH']) {
      await wired.campaigns.create(owner, {
        code, title: 'Q3 Push', startsAt: wib('2026-09-01T00:00:00'), endsAt: wib('2026-09-30T23:59:00'), requirements: [],
      });
      await chase('DIMAS', code);
    }
    expect(row(await read('AGUS'), 'DIMAS').campaigns).toEqual([
      { code: 'MDRT_QUALIFICATION', title: 'MDRT Qualification' },
      { code: 'ALPHA_PUSH', title: 'Q3 Push' },
      { code: 'ZETA_PUSH', title: 'Q3 Push' },
    ]);
  });

  it('P18.2-T7 AC-7 Agus’s roster: his own ✓, Dimas ✓, Rina ✓ in Sari’s unit, the rest —', async () => {
    const v = await read('AGUS');
    expect(Object.fromEntries(everyRow(v).map((r) => [r.name, r.chasingMdrt]))).toMatchObject({
      'Agus Salim': true, 'Dimas Pratama': true, 'Rina Wijaya': true, 'Budi Santoso': false, 'Indah Permatasari': false,
    });
  });

  it('P18.2-T7 AC-7 the header tooltip is composed from the office’s MDRT campaign (ADR-0142 §3)', async () => {
    expect((await read('AGUS')).mdrt).toEqual({
      running: true, tooltip: 'Chasing MDRT (Million Dollar Round Table) this year — APE of Rp 2,4 M or more.',
    });
    // A member leading nobody is answered an empty unit, the header's words all the same.
    expect((await read('RINA')).mdrt.running).toBe(true);
  });

  it('P18.2-T7 AC-8 the reach is the dashboard’s, and the chases inside it are exactly campaign_qualification:read’s', async () => {
    for (const leader of ['OWNER', 'AGUS', 'SARI', 'NINA', 'LUKAS', 'PEER_AB'] as const) {
      const ctx = office.as(leader);
      const v = await read(leader);
      for (const r of everyRow(v)) {
        const reached = await wired.coach.subject(ctx, r.membershipId, 'campaign_qualification:read').then(() => true, () => false);
        expect([leader, r.name, r.chasingMdrt !== null]).toEqual([leader, r.name, reached]);
        expect([leader, r.name, r.campaigns !== null]).toEqual([leader, r.name, reached]);
      }
    }
  });

  // Was *an Agent-rung leader sees their own ✓ and — for a coachee*: P19.9-T6 (ADR-0234) gave the Agent `own-downline`.
  it('P18.2-T7 AC-8, P19.9-T6 AC-3 an Agent-rung leader reads their coachee’s chases too — every upline coaches', async () => {
    const v = await read('LUKAS');
    expect(row(v, 'LUKAS')).toMatchObject({ chasingMdrt: false, campaigns: [] });
    // Her own chases, read — no longer the — of a row beyond the reader's reach.
    expect(row(v, 'TARI').chasingMdrt).not.toBeNull();
    expect(row(v, 'TARI').campaigns).not.toBeNull();
  });

  it('P18.2-T8 review item 13 an MDRT campaign not yet begun is not running: the header says none is', async () => {
    await db().collection('campaigns').updateOne({ kpmId: KPM_A, code: 'MDRT_QUALIFICATION' }, { $set: { startsAt: new Date('2026-10-01T00:00:00+07:00') } });
    expect((await read('AGUS')).mdrt).toEqual({
      running: false, tooltip: 'Chasing MDRT (Million Dollar Round Table) this year. No MDRT campaign is running.',
    });
    await db().collection('campaigns').updateOne({ kpmId: KPM_A, code: 'MDRT_QUALIFICATION' }, { $set: { startsAt: new Date('2026-01-01T00:00:00+07:00') } });
  });

  it('P18.2-T7 AC-7 says when the office runs no MDRT campaign, and nobody is ✓', async () => {
    await db().collection('campaigns').updateOne({ kpmId: KPM_A, code: 'MDRT_QUALIFICATION' }, { $set: { status: 'archived' } });
    const v = await read('AGUS');
    expect(v.mdrt).toEqual({ running: false, tooltip: 'Chasing MDRT (Million Dollar Round Table) this year. No MDRT campaign is running.' });
    expect(everyRow(v).some((r) => r.chasingMdrt === true)).toBe(false);
    await db().collection('campaigns').updateOne({ kpmId: KPM_A, code: 'MDRT_QUALIFICATION' }, { $set: { status: 'active' } });
  });
});
