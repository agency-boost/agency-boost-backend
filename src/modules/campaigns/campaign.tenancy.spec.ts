import mongoose from 'mongoose';
import { RequestContext } from '@/common/context/request-context';
import { SEED_PRODUCTION_CLUB_TIERS } from '@/domain/constants';
import { clearCollections, startMongo, stopMongo } from '../../../test/mongo';
import { configModule } from '../../../test/config-module';

const NOW = new Date('2026-09-18T02:00:00Z');
const KPM_A = '66f0000000000000000000a1';
const KPM_B = '66f0000000000000000000b1';
const PRUDENTIAL = '66f0000000000000000000c1';
const ALLIANZ = '66f0000000000000000000c2';

const member = (kpmId: string) => new RequestContext('u1', 'none', {
  membershipId: `mem-${kpmId}`, kpmId, orgLevelCode: 'AB', hierarchyRole: 'ab',
  status: 'active', isKpmOwner: true, isKpmAdmin: false, directCount: 0,
} as never);

/**
 * Campaigns, and the carrier rules an office is measured against (P5-T7, ADR-0026, ADR-0035).
 *
 * **Two things that look alike on one screen and behave differently.** *Year-End Star Club Drive*
 * is the office's own campaign and fully editable; *Star Club* is the insurer's recognition tier
 * and editable by nobody in any office. The API has to enforce that rather than trusting a screen.
 */
describe('campaigns and carrier rules (P5-T7)', () => {
  let wired: ReturnType<typeof configModule>;

  beforeAll(async () => {
    await startMongo();
    wired = configModule(NOW);
  });
  afterAll(stopMongo);

  beforeEach(async () => {
    await clearCollections();
    await (wired.kpms as { create: (d: unknown) => Promise<unknown> }).create([
      { _id: KPM_A, companyId: PRUDENTIAL, code: '0417', branchName: 'A', timezone: 'Asia/Jakarta' },
      { _id: KPM_B, companyId: ALLIANZ, code: '0999', branchName: 'B', timezone: 'Asia/Jakarta' },
    ]);
    await wired.campaigns.seedForCompany(PRUDENTIAL);
    await wired.campaigns.seedForCompany(ALLIANZ);
  });

  const aCampaign = (over: Record<string, unknown> = {}) => ({
    code: 'YEAR_END_DRIVE',
    title: 'Year-End Star Club Drive',
    startsAt: '2026-10-01T00:00:00Z',
    endsAt: '2026-12-31T16:59:59Z',
    reward: 'Extra unit budget',
    requirements: [{ metricKey: 'APE_ACHIEVED', comparator: 'gte', value: 500_000_000 * 100 }],
    ...over,
  });

  describe('a requirement names a metric this product can compute (AC-1)', () => {
    it('takes one, and copies the unit from the registry rather than from the caller', async () => {
      const made = await wired.campaigns.create(member(KPM_A), aCampaign());

      expect(made.requirements[0]).toEqual({
        metricKey: 'APE_ACHIEVED',
        metricName: 'APE achieved',
        comparator: 'gte',
        value: 50_000_000_000,
        // A client sending its own could label sen as rupiah and every screen would be wrong.
        unit: 'idr_minor',
      });
    });

    it('refuses a metric nobody measures, naming it and what is available', async () => {
      // The prototype's requirements are display strings — "Net APE ≥ Rp 600 juta" — which nothing
      // can evaluate and nothing can refuse.
      await expect(wired.campaigns.create(member(KPM_A), aCampaign({
        requirements: [{ metricKey: 'NET_APE', comparator: 'gte', value: 100 }],
      }))).rejects.toThrow(/"NET_APE" is not a metric this product measures/);
    });

    it('refuses a metric nothing measures yet, saying so and naming no phase', async () => {
      // Accepting it would be a campaign nobody could ever qualify for, failing silently. The
      // Owner reads the refusal, so it says what is true now, not our schedule (P10.1-T2 AC-3).
      // Event NPS is the Owner's reporting metric (Phase 18), after campaign evaluation (14): it
      // was refused under the old plan's numbers and is refused still (P10.1-T2 AC-7 — the set
      // itself is pinned by key in `registry.spec.ts`).
      await expect(wired.campaigns.create(member(KPM_A), aCampaign({
        requirements: [{ metricKey: 'EVENT_NPS', comparator: 'gte', value: 50 }],
      }))).rejects.toThrow(/Event NPS is not measured yet, so a campaign asking for it could never qualify anybody/);
    });

    it('refuses money that is not whole sen (AC-2)', async () => {
      await expect(wired.campaigns.create(member(KPM_A), aCampaign({
        requirements: [{ metricKey: 'APE_ACHIEVED', comparator: 'gte', value: 1_000.5 }],
      }))).rejects.toThrow(/whole sen/);
    });

    it('refuses a comparator it does not have', async () => {
      await expect(wired.campaigns.create(member(KPM_A), aCampaign({
        requirements: [{ metricKey: 'APE_ACHIEVED', comparator: 'about', value: 1 }],
      }))).rejects.toThrow(/comparator is one of/);
    });
  });

  describe('when a campaign is running is derived (AC-3)', () => {
    it('reads upcoming, running and ended off the dates', async () => {
      const upcoming = await wired.campaigns.create(member(KPM_A), aCampaign());
      const running = await wired.campaigns.create(member(KPM_A), aCampaign({
        code: 'NOW', startsAt: '2026-09-01T00:00:00Z', endsAt: '2026-09-30T00:00:00Z',
      }));
      const ended = await wired.campaigns.create(member(KPM_A), aCampaign({
        code: 'LAST', startsAt: '2026-01-01T00:00:00Z', endsAt: '2026-06-30T00:00:00Z',
      }));

      expect([upcoming.phase, running.phase, ended.phase]).toEqual(['upcoming', 'running', 'ended']);
      // The prototype labels one campaign Running in the list while its own data says `past`.
      const stored = await mongoose.connection.db!.collection('campaigns').findOne({ code: 'NOW' });
      expect(stored).not.toHaveProperty('phase');
    });
  });

  describe('isolation (AC-4)', () => {
    it('keeps one office’s campaigns out of another’s', async () => {
      await wired.campaigns.create(member(KPM_A), aCampaign());

      expect(await wired.campaigns.list(member(KPM_A))).toHaveLength(1);
      expect(await wired.campaigns.list(member(KPM_B))).toHaveLength(0);
    });

    it('refuses another office’s campaign as a 404', async () => {
      const mine = await wired.campaigns.create(member(KPM_A), aCampaign());

      await expect(wired.campaigns.archive(member(KPM_B), mine.id))
        .rejects.toMatchObject({ code: 'NOT_FOUND' });
    });

    it('refuses an office a company-scoped campaign', async () => {
      expect(() => wired.campaigns.refuseCompanyScope('company'))
        .toThrow(/belongs to your insurer/);
      expect(() => wired.campaigns.refuseCompanyScope('kpm')).not.toThrow();
    });
  });

  describe('the carrier rules are the insurer’s (AC-5, AC-6, AC-7)', () => {
    it('seeds the three production club tiers, in integer minor units', async () => {
      const tiers = await wired.campaigns.listRules(member(KPM_A), 'production_club');

      expect(tiers.map((t) => t.name)).toEqual(['Star Club', 'Elite Club', "Chairman's Club"]);
      expect(tiers.map((t) => t.criteriaGroups[0].criteria[0].value)).toEqual([
        120_000_000_000, 200_000_000_000, 350_000_000_000,
      ]);
      // Rp 1.2B, Rp 2B, Rp 3.5B — the prototype's "Rp 1.2B" is a display string, and one of its
      // campaigns is denominated in pesos.
      expect(SEED_PRODUCTION_CLUB_TIERS.map((t) => t.minAnnualApe / 100)).toEqual([
        1_200_000_000, 2_000_000_000, 3_500_000_000,
      ]);
      expect(tiers.map((t) => t.reward)).toEqual([
        'Promotion bonus', 'Trip qualification', 'AB override + unit budget',
      ]);
    });

    it('seeds MOC for AB and AAB, porting the thresholds and no fabricated derivation', async () => {
      const moc = await wired.campaigns.listRules(member(KPM_A), 'moc');

      const ab = moc.find((r) => r.code === 'MOC_AB')!;
      expect(ab.appliesToOrgLevelCodes).toEqual(['AB']);
      // Net APE **and** both Monthly2 AA counts, **or** five direct ABs — the carrier's own "or".
      expect(ab.groupMode).toBe('any');
      expect(ab.criteriaGroups).toHaveLength(2);
      expect(ab.criteriaGroups[0].criteria[0].value).toBe(60_000_000_000);

      const aab = moc.find((r) => r.code === 'MOC_AAB')!;
      expect(aab.appliesToOrgLevelCodes).toEqual(['AAB']);
      expect(aab.criteriaGroups[0].criteria[0].value).toBe(20_000_000_000);
    });

    it('says which metrics a rule is still waiting on, rather than showing it as ordinary', async () => {
      // The prototype fabricates `monthly2Aa` from a headcount it has to hand — a different number
      // wearing the carrier's name. A rule whose inputs do not exist can never pass, and a screen
      // that hid that would tell somebody they had failed something nothing measures.
      const moc = await wired.campaigns.listRules(member(KPM_A), 'moc');

      expect(moc.find((r) => r.code === 'MOC_AB')!.waitingOnMetrics)
        .toEqual(['NET_APE', 'MONTHLY2_AA_DU', 'MONTHLY2_AA_DG', 'DIRECT_AB_COUNT']);
      // And a tier built on a registry metric waits on nothing.
      const tiers = await wired.campaigns.listRules(member(KPM_A), 'production_club');
      expect(tiers.every((t) => t.waitingOnMetrics.length === 0)).toBe(true);
    });

    it('shows an office only its own company’s rules', async () => {
      const prudential = await wired.campaigns.listRules(member(KPM_A));
      const allianz = await wired.campaigns.listRules(member(KPM_B));

      expect(prudential).toHaveLength(5);
      expect(allianz).toHaveLength(5);
      expect(prudential[0].id).not.toBe(allianz[0].id);
    });

    it('offers no way for an office to write one — not a refusal, an absence (AC-7)', () => {
      // A permission check can be bypassed by a new caller; a method that does not exist cannot.
      for (const name of ['createRule', 'updateRule', 'deleteRule', 'archiveRule']) {
        expect(wired.campaigns).not.toHaveProperty(name);
      }
    });

    it('leaves a company that already has rules alone', async () => {
      expect(await wired.campaigns.seedForCompany(PRUDENTIAL)).toBe(0);
    });
  });
});
