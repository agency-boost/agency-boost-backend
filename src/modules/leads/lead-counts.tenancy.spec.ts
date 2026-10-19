import { clearCollections, startMongo, stopMongo } from '../../../test/mongo';
import { configModule } from '../../../test/config-module';
import { buildCoachingOffice, ROSTER_NOW, type CoachingOffice, type Who } from '../../../test/coaching-office';
import { seedUnitLeads, UNIT_MONTH } from '../../../test/unit-office';
import type { LeadReadings } from './lead-readings';

/**
 * **The Unit Dashboard's four lead counts, held to `LeadService.summary`** (Phase 15, D-leads). The summary
 * counts in the database, the dashboard per owner over the rows (`personLeadCounts`), so the two evaluations
 * of one rule are pinned together on one office — as the attention counts are — and fail the day they drift.
 */
describe('the lead counts per person (Phase 15, D-leads)', () => {
  let wired: ReturnType<typeof configModule>;
  let office: CoachingOffice;
  let readings: LeadReadings;

  beforeAll(async () => {
    await startMongo();
    wired = configModule(ROSTER_NOW);
    await clearCollections();
    office = await buildCoachingOffice(wired);
    await seedUnitLeads(office);
    readings = (wired.unitDashboard as unknown as { leads: LeadReadings }).leads;
  }, 120_000);
  afterAll(stopMongo);

  it.each(['RINA', 'INDAH', 'DODI', 'DIMAS'] as const)(
    'P15-T1 AC-3 %s: RECRUITMENT_PIPELINE_NOW is the summary’s, and the promises split it by type',
    async (who: Who) => {
      // An agent's summary is their own leads (`lead:read_aggregate_counts`, `own`).
      const summary = await wired.leadRecords.summary(office.as(who));
      const counts = (await readings.countsOfMany(office.as(who), [office.id[who]], { month: UNIT_MONTH })).get(office.id[who])!;

      expect(counts.recruitOpen).toBe(summary.recruitmentPipelineNow);
      // The seed's leads all carry a type: the two promise counts are the summary's whole commitment count.
      expect(counts.salesClosing + counts.recruitNominated).toBe(summary.committedThisMonth);
      expect(counts.salesOpen).toBeLessThanOrEqual(summary.open);
    },
  );

  it('P15-T1 AC-3 every member asked about is answered — zeros for nobody’s leads — and nobody asked about, nothing', async () => {
    const ids = [office.id.RINA, office.id.TARI];
    const counts = await readings.countsOfMany(office.as('AGUS'), ids, { month: UNIT_MONTH });
    expect(counts.get(office.id.TARI)).toEqual({ salesOpen: 0, salesClosing: 0, recruitOpen: 0, recruitNominated: 0 });
    expect(await readings.countsOfMany(office.as('AGUS'), [], { month: UNIT_MONTH })).toEqual(new Map());
  });

  it('P15-T1 AC-9 another office’s leads, filed against the same owner id, are never counted', async () => {
    const b = await readings.countsOfMany(office.as('B_AB'), [office.id.RINA], { month: UNIT_MONTH });
    expect(b.get(office.id.RINA)).toEqual({ salesOpen: 0, salesClosing: 0, recruitOpen: 0, recruitNominated: 0 });
  });
});
