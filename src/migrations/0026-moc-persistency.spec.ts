import mongoose from 'mongoose';
import { MOC_PERSISTENCY_MIN_PCT } from '@/domain/constants';
import { clearCollections, startMongo, stopMongo } from '../../test/mongo';
import { up } from './0026-moc-persistency';

const NOW = new Date('2026-10-09T02:00:00Z');
const PERSISTENCY = { metricKey: 'MOC_PERSISTENCY', comparator: 'gte', value: MOC_PERSISTENCY_MIN_PCT, unit: 'percentage' };

/** The rules P5-T7 seeded for a company: the AB's two groups, the AAB's one, and a club tier beside them. */
function seeded(companyId: string) {
  return [
    {
      companyId, kind: 'moc', code: 'MOC_AB', deletedAt: null, groupMode: 'any',
      waitingOnMetrics: ['NET_APE', 'MONTHLY2_AA_DU', 'MONTHLY2_AA_DG', 'DIRECT_AB_COUNT'],
      criteriaGroups: [
        {
          mode: 'all',
          criteria: [
            { metricKey: 'NET_APE', comparator: 'gte', value: 60_000_000_000, unit: 'idr_minor' },
            { metricKey: 'MONTHLY2_AA_DU', comparator: 'gte', value: 4, unit: 'count' },
            { metricKey: 'MONTHLY2_AA_DG', comparator: 'gte', value: 6, unit: 'count' },
          ],
        },
        { mode: 'all', criteria: [{ metricKey: 'DIRECT_AB_COUNT', comparator: 'gte', value: 5, unit: 'count' }] },
      ],
    },
    {
      companyId, kind: 'moc', code: 'MOC_AAB', deletedAt: null, groupMode: 'any',
      waitingOnMetrics: ['NET_APE', 'MONTHLY2_AA'],
      criteriaGroups: [{
        mode: 'all',
        criteria: [
          { metricKey: 'NET_APE', comparator: 'gte', value: 20_000_000_000, unit: 'idr_minor' },
          { metricKey: 'MONTHLY2_AA', comparator: 'gte', value: 2, unit: 'count' },
        ],
      }],
    },
    {
      companyId, kind: 'production_club', code: 'STAR_CLUB', deletedAt: null, groupMode: 'all', waitingOnMetrics: [],
      criteriaGroups: [{ mode: 'all', criteria: [{ metricKey: 'APE_ACHIEVED', comparator: 'gte', value: 1, unit: 'idr_minor' }] }],
    },
  ];
}

/**
 * P18-T2 AC-4 (D-moc). Every company's MOC rules gain the persistency criterion the prototype states and the
 * first seed left out — on the first group, the AB's standard path and the AAB's only one — and stop listing
 * the metrics Phase 18 registered as waited on. Recorded (its counts), and idempotent: run twice, the second
 * run changes nothing; a rule that already names it is left as it is. (Over the demo seed: `reporting-seed.spec.ts`.)
 */
describe('0026 — the MOC persistency criterion, for the rules that predate it', () => {
  beforeAll(startMongo);
  afterAll(stopMongo);

  const db = () => mongoose.connection.db as mongoose.mongo.Db;
  const rules = () => db().collection('qualificationRules');

  beforeEach(async () => {
    await clearCollections();
    await rules().deleteMany({});
  });

  it('P18-T2 AC-4 adds MOC_PERSISTENCY ≥ 75 to the first group of every live MOC rule, and clears what they waited on', async () => {
    await rules().insertMany([...seeded('c1'), ...seeded('c2')]);
    await rules().insertOne({ ...seeded('gone')[0], deletedAt: NOW });

    expect(await up(db(), NOW)).toEqual({ added: 4, current: 0, cleared: 4 });

    const ab = await rules().findOne({ companyId: 'c1', code: 'MOC_AB' });
    expect(ab!.criteriaGroups[0].criteria.map((c: { metricKey: string }) => c.metricKey))
      .toEqual(['NET_APE', 'MONTHLY2_AA_DU', 'MONTHLY2_AA_DG', 'MOC_PERSISTENCY']);
    expect(ab!.criteriaGroups[0].criteria[3]).toEqual(PERSISTENCY);
    // The override path is untouched: Direct AB alone.
    expect(ab!.criteriaGroups[1].criteria).toHaveLength(1);
    expect(ab!.waitingOnMetrics).toEqual([]);
    expect(ab!.updatedAt).toEqual(NOW);
    const aab = await rules().findOne({ companyId: 'c2', code: 'MOC_AAB' });
    expect(aab!.criteriaGroups[0].criteria.at(-1)).toEqual(PERSISTENCY);
    // A club tier is not MOC, and a deleted rule is no rule.
    expect((await rules().findOne({ code: 'STAR_CLUB', companyId: 'c1' }))!.criteriaGroups[0].criteria).toHaveLength(1);
    expect((await rules().findOne({ companyId: 'gone' }))!.criteriaGroups[0].criteria).toHaveLength(3);
  });

  it('P18-T2 AC-4 run twice, the second run changes nothing', async () => {
    await rules().insertMany(seeded('c1'));
    await up(db(), NOW);
    const first = await rules().find({}).sort({ _id: 1 }).toArray();

    expect(await up(db(), new Date('2026-10-10T02:00:00Z'))).toEqual({ added: 0, current: 2, cleared: 0 });
    expect(await rules().find({}).sort({ _id: 1 }).toArray()).toEqual(first);
  });

  it('P18-T2 AC-4 leaves a threshold somebody set by hand, keeps what a rule still waits on, and passes over a rule with no group', async () => {
    const [ab] = seeded('c1');
    ab.criteriaGroups[0].criteria.push({ metricKey: 'MOC_PERSISTENCY', comparator: 'gte', value: 80, unit: 'percentage' });
    ab.waitingOnMetrics = ['NET_APE', 'FLC_COUNT'];
    await rules().insertMany([ab, { companyId: 'c1', kind: 'moc', code: 'EMPTY', deletedAt: null, criteriaGroups: [] }]);

    expect(await up(db(), NOW)).toEqual({ added: 0, current: 2, cleared: 1 });
    const after = await rules().findOne({ code: 'MOC_AB' });
    expect(after!.criteriaGroups[0].criteria.at(-1)).toMatchObject({ value: 80 });
    expect(after!.waitingOnMetrics).toEqual(['FLC_COUNT']);
  });
});
