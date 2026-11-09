import mongoose from 'mongoose';
import { MOC_PERSISTENCY_MIN_PCT, SEED_MOC_RULES } from '@/domain/constants';
import { defaultCampaignKinds } from '@/modules/campaigns/campaign-kinds-payload';
import { clearCollections, startMongo, stopMongo } from '../../test/mongo';
import { up } from './0051-moc-ape-key';

const NOW = new Date('2026-11-05T02:00:00Z');
const EARLIER = new Date('2026-10-09T02:00:00Z');

/** The seeded `moc` rules as a company holds them before P19.3-T1: `0026-moc-persistency`'s shape, `NET_APE` first. */
function seeded(companyId: string) {
  return [
    {
      companyId, kind: 'moc', code: 'MOC_AB', deletedAt: null, groupMode: 'any', waitingOnMetrics: [], updatedAt: EARLIER,
      criteriaGroups: [
        {
          mode: 'all',
          criteria: [
            { metricKey: 'NET_APE', comparator: 'gte', value: 60_000_000_000, unit: 'idr_minor' },
            { metricKey: 'MONTHLY2_AA_DU', comparator: 'gte', value: 4, unit: 'count' },
            { metricKey: 'MONTHLY2_AA_DG', comparator: 'gte', value: 6, unit: 'count' },
            { metricKey: 'MOC_PERSISTENCY', comparator: 'gte', value: MOC_PERSISTENCY_MIN_PCT, unit: 'percentage' },
          ],
        },
        { mode: 'all', criteria: [{ metricKey: 'DIRECT_AB_COUNT', comparator: 'gte', value: 5, unit: 'count' }] },
      ],
    },
    {
      companyId, kind: 'moc', code: 'MOC_AAB', deletedAt: null, groupMode: 'any', waitingOnMetrics: ['NET_APE'], updatedAt: EARLIER,
      criteriaGroups: [{
        mode: 'all',
        criteria: [
          { metricKey: 'NET_APE', comparator: 'gte', value: 20_000_000_000, unit: 'idr_minor' },
          { metricKey: 'MONTHLY2_AA', comparator: 'gte', value: 2, unit: 'count' },
          { metricKey: 'MOC_PERSISTENCY', comparator: 'gte', value: MOC_PERSISTENCY_MIN_PCT, unit: 'percentage' },
        ],
      }],
    },
  ];
}

/** A `campaign_kinds` template payload as published before P19.3-T1: today's defaults with the old key put back. */
function oldPayload() {
  const payload = defaultCampaignKinds();
  return {
    rules: payload.rules.map((rule) => ({
      ...rule,
      criteriaGroups: rule.criteriaGroups.map((g) => ({
        ...g, criteria: g.criteria.map((c) => (c.metricKey === 'MOC_APE' ? { ...c, metricKey: 'NET_APE' } : c)),
      })),
    })),
  };
}

const keysOf = (groups: { criteria: { metricKey: string }[] }[]) => groups.flatMap((g) => g.criteria.map((c) => c.metricKey));

/**
 * P19.3-T1 AC-5 (ADR-0201 §1, D5). Every company's `moc` rules, and the `campaign_kinds` templates they are published
 * from, have `NET_APE` renamed `MOC_APE` in place: the threshold, the comparator, the unit and every other criterion kept,
 * `waitingOnMetrics` recomputed, nothing else touched. Recorded (its counts), and idempotent: a second run renames nothing.
 */
describe('0051 — the MOC rules’ NET_APE is MOC_APE (P19.3-T1, ADR-0201 §1)', () => {
  beforeAll(startMongo);
  afterAll(stopMongo);

  const db = () => mongoose.connection.db as mongoose.mongo.Db;
  const rules = () => db().collection('qualificationRules');
  const templates = () => db().collection('companyTemplates');

  beforeEach(async () => {
    await clearCollections();
    await rules().deleteMany({});
    await templates().deleteMany({});
  });

  it('P19.3-T1 AC-5 renames the seeded rules’ key in place, keeping the bar, and runs twice as a no-op', async () => {
    await rules().insertMany([...seeded('company-a'), ...seeded('company-b')]);

    expect(await up(db(), NOW)).toEqual({ rules: 4, templates: 0, current: 0 });

    for (const rule of await rules().find({ kind: 'moc' }).toArray()) {
      const keys = keysOf(rule.criteriaGroups);
      expect(keys).not.toContain('NET_APE');
      expect(keys[0]).toBe('MOC_APE');
      expect(rule.waitingOnMetrics).toEqual([]);
      expect(rule.updatedAt).toEqual(NOW);
      // A rename, not a new bar: no effective date is written.
      expect(rule.effectiveFrom).toBeUndefined();
    }
    const ab = await rules().findOne({ companyId: 'company-a', code: 'MOC_AB' });
    expect(ab!.criteriaGroups[0].criteria[0]).toEqual({ metricKey: 'MOC_APE', comparator: 'gte', value: 60_000_000_000, unit: 'idr_minor' });
    expect(keysOf(ab!.criteriaGroups)).toEqual(['MOC_APE', 'MONTHLY2_AA_DU', 'MONTHLY2_AA_DG', 'MOC_PERSISTENCY', 'DIRECT_AB_COUNT']);
    // What a company created from today's seed holds: the same keys, the same thresholds.
    const seededAb = SEED_MOC_RULES.find((r) => r.code === 'MOC_AB')!;
    expect(keysOf(ab!.criteriaGroups)).toEqual(keysOf(seededAb.criteriaGroups as never));
    expect(ab!.criteriaGroups[0].criteria[0].value).toBe(seededAb.criteriaGroups[0].criteria[0].value);

    expect(await up(db(), new Date('2026-11-06T02:00:00Z'))).toEqual({ rules: 0, templates: 0, current: 4 });
    expect((await rules().findOne({ companyId: 'company-a', code: 'MOC_AB' }))!.updatedAt).toEqual(NOW);
  });

  it('P19.3-T1 AC-5 touches only live moc rules: a club, a promotion path and a deleted rule keep what they hold', async () => {
    await rules().insertMany([
      ...seeded('company-a'),
      {
        companyId: 'company-a', kind: 'production_club', code: 'ODD', deletedAt: null, waitingOnMetrics: [], updatedAt: EARLIER,
        criteriaGroups: [{ mode: 'all', criteria: [{ metricKey: 'NET_APE', comparator: 'gte', value: 1 }] }],
      },
      {
        companyId: 'company-a', kind: 'moc', code: 'MOC_OLD', deletedAt: EARLIER, waitingOnMetrics: ['NET_APE'], updatedAt: EARLIER,
        criteriaGroups: [{ mode: 'all', criteria: [{ metricKey: 'NET_APE', comparator: 'gte', value: 1 }] }],
      },
    ]);

    expect(await up(db(), NOW)).toEqual({ rules: 2, templates: 0, current: 0 });
    const odd = await rules().findOne({ code: 'ODD' });
    expect(keysOf(odd!.criteriaGroups)).toEqual(['NET_APE']);
    expect(odd!.updatedAt).toEqual(EARLIER);
    const old = await rules().findOne({ code: 'MOC_OLD' });
    expect([keysOf(old!.criteriaGroups), old!.waitingOnMetrics]).toEqual([['NET_APE'], ['NET_APE']]);
  });

  it('P19.3-T1 AC-5 renames the campaign_kinds templates, draft and published, and no other kind, no club', async () => {
    const [draft, published, other] = [new mongoose.Types.ObjectId(), new mongoose.Types.ObjectId(), new mongoose.Types.ObjectId()];
    await templates().insertMany([
      { _id: draft, companyId: 'company-a', kind: 'campaign_kinds', status: 'draft', version: 3, deletedAt: null, payload: oldPayload() },
      { _id: published, companyId: 'company-a', kind: 'campaign_kinds', status: 'published', version: 2, deletedAt: null, payload: oldPayload() },
      { _id: other, companyId: 'company-a', kind: 'ratio_set', status: 'published', version: 1, deletedAt: null, payload: { metricKey: 'NET_APE' } },
    ]);

    expect(await up(db(), NOW)).toEqual({ rules: 0, templates: 2, current: 0 });
    for (const id of [draft, published]) {
      const row = await templates().findOne({ _id: id });
      const moc = row!.payload.rules.filter((r: { kind: string }) => r.kind === 'moc');
      expect(moc.flatMap((r: { criteriaGroups: never }) => keysOf(r.criteriaGroups))).toContain('MOC_APE');
      expect(JSON.stringify(row!.payload)).not.toContain('NET_APE');
      // Exactly today's defaults again; no version moves.
      expect(row!.payload).toEqual(JSON.parse(JSON.stringify(defaultCampaignKinds())));
    }
    expect((await templates().findOne({ _id: draft }))!.version).toBe(3);
    expect((await templates().findOne({ _id: other }))!.payload).toEqual({ metricKey: 'NET_APE' });

    expect(await up(db(), NOW)).toEqual({ rules: 0, templates: 0, current: 2 });
  });

  it('P19.3-T1 AC-5 writes nothing on a database with no rules and no templates, twice', async () => {
    await rules().drop().catch(() => undefined);
    await templates().drop().catch(() => undefined);
    expect(await up(db(), NOW)).toEqual({ rules: 0, templates: 0, current: 0 });
    expect(await up(db(), NOW)).toEqual({ rules: 0, templates: 0, current: 0 });
  });
});
