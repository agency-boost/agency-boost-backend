import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, normalize } from 'node:path';
import mongoose from 'mongoose';
import { clearCollections, startMongo, stopMongo } from '../../../test/mongo';
import { configModule } from '../../../test/config-module';
import { buildCoachingOffice, KPM_A, ROSTER_NOW, type CoachingOffice } from '../../../test/coaching-office';

const SRC = join(__dirname, '../..');
const wib = (local: string) => new Date(`${local}+07:00`).toISOString();

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
describe('the standings port (P18.5-T8 AC-8)', () => {
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
      code: 'AUGUST_PUSH', phase: 'ended', final: true, windowKey: '2026-08..2026-08', windowLabel: 'Aug 2026',
      appliesToOrgLevelCodes: ['AGENT'],
    });
    const active = await mongoose.connection.db!.collection('memberships').countDocuments({ kpmId: KPM_A, status: 'active' });
    expect(read.standings).toHaveLength(2 * active);
    expect(Object.keys(read.standings[0]).sort()).toEqual(['campaignCode', 'chasing', 'eligible', 'final', 'membershipId', 'status']);
    const of = (code: string, id: string) => read.standings.find((s) => s.campaignCode === code && s.membershipId === id)!;
    expect(of('AUGUST_PUSH', office.id.RINA)).toEqual({
      campaignCode: 'AUGUST_PUSH', membershipId: office.id.RINA, chasing: true, eligible: true, status: 'qualified', final: true,
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

  it('P18.5-T8 AC-8 imports only the evaluation, its repositories and the membership repository — no route, no screen', () => {
    const file = join(__dirname, 'campaign-standings-reader.ts');
    const direct = importsOf(file).map((f) => f.slice(SRC.length + 1)).sort();
    expect(direct).toEqual([
      'common/clock/clock.port.ts',
      'common/context/request-context.ts',
      'domain/constants/index.ts',
      'domain/metrics/campaign-qualification.ts',
      'domain/metrics/campaign-window.ts',
      'modules/campaigns/campaign-evaluation.ts',
      'modules/campaigns/campaign.repository.ts',
      'modules/org/membership.repository.ts',
    ]);
  });
});
