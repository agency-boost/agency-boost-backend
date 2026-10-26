import mongoose from 'mongoose';
import { SEED_ACTIVITY_CATEGORIES, SEED_ACTIVITY_TYPES } from '@/domain/constants';
import { clearCollections, startMongo, stopMongo } from '../../../test/mongo';
import { configModule, givenDefaultTemplate, provisionFrom } from '../../../test/config-module';
import { SUPER_ADMIN } from '../../../test/http-permissions';
import { defaultBinding } from './activity-binding';
import { templateKindsFromOffice } from './office-template';
import { platformDefaultPayload } from './template-defaults';

const NOW = new Date('2026-10-26T03:00:00Z');
const COMPANY = '66f0000000000000000000c1';
const KPM_A = '66f0000000000000000000a1';
const KPM_B = '66f0000000000000000000b1';
const TODAY = { leads: ['LEADS_CONTACTED'], appointments: ['SELL_PRESENTATION'], closings: ['SELL_SUBMISSION'] };

/** The platform's taxonomy with one more type in Selling: what a Super Admin replacing *Sales meeting* authors. */
const taxonomy = (bindings?: unknown) => ({
  categories: SEED_ACTIVITY_CATEGORIES.map((c) => ({ ...c })),
  types: [
    ...SEED_ACTIVITY_TYPES.map((t) => ({ ...t })),
    { code: 'SALES_MEETING', categoryCode: 'SELLING', label: 'Sales meeting', description: null, displayOrder: 13 },
  ],
  ...(bindings === undefined ? {} : { bindings }),
});

/**
 * **A template's activity binding** (P18.9-T2 AC-1, AC-3; ADR-0163 §1, §3): carried in its `activity_taxonomy`
 * payload, checked when it is published against the taxonomy it publishes, copied into every office made from it,
 * and carried by *Save as template* from an office's own binding.
 */
describe('the activity binding in a template (P18.9-T2)', () => {
  let wired: ReturnType<typeof configModule>;

  beforeAll(async () => {
    await startMongo();
    wired = configModule(NOW);
  });
  afterAll(stopMongo);

  beforeEach(async () => {
    await clearCollections();
    await (wired.companies as unknown as mongoose.Model<never>).create({ _id: COMPANY, name: 'Prudential', slug: 'prudential' } as never);
    await givenDefaultTemplate(wired, COMPANY);
    await (wired.kpms as unknown as mongoose.Model<never>).create([
      { _id: KPM_A, companyId: COMPANY, code: '0417', branchName: 'A', timezone: 'Asia/Jakarta' },
      { _id: KPM_B, companyId: COMPANY, code: '0555', branchName: 'B', timezone: 'Asia/Jakarta' },
    ] as never);
  });

  const publish = async (payload: Record<string, unknown>) => {
    await wired.templateService.saveDraft(SUPER_ADMIN, COMPANY, 'activity_taxonomy', payload);
    return wired.templateService.publish(SUPER_ADMIN, COMPANY, 'activity_taxonomy');
  };
  const bindingOf = (kpmId: string) => mongoose.connection.db!.collection('activityBindings').findOne({ kpmId, deletedAt: null });

  it('P18.9-T2 AC-1 the AgencyBoost defaults carry the default binding: today’s three codes', () => {
    expect(platformDefaultPayload('activity_taxonomy').bindings).toEqual(TODAY);
    expect(defaultBinding()).toEqual(TODAY);
  });

  it('P18.9-T2 AC-1 an office made from a template is given the template’s binding', async () => {
    await publish(taxonomy({ ...TODAY, appointments: ['SELL_PRESENTATION', 'SALES_MEETING'] }));
    const provisioned = await provisionFrom(wired, KPM_A, COMPANY);
    expect(provisioned.seededFrom.activity_taxonomy.version).toBe(1);
    expect(await bindingOf(KPM_A)).toMatchObject({
      ...TODAY, appointments: ['SELL_PRESENTATION', 'SALES_MEETING'], version: 1, status: 'active',
    });
  });

  it('P18.9-T2 AC-1 a template with none, and Empty, give the default binding with its three types', async () => {
    await publish(taxonomy());
    await provisionFrom(wired, KPM_A, COMPANY);
    expect(await bindingOf(KPM_A)).toMatchObject({ ...TODAY, version: 1 });

    await provisionFrom(wired, KPM_B, COMPANY, { kind: 'empty' });
    expect(await bindingOf(KPM_B)).toMatchObject(TODAY);
    const types = await mongoose.connection.db!.collection('activityTypes').find({ kpmId: KPM_B }).toArray();
    expect(types.map((t) => t.code).sort()).toEqual(['LEADS_CONTACTED', 'SELL_PRESENTATION', 'SELL_SUBMISSION']);
  });

  it('P18.9-T2 AC-4 an office whose template binds a replacement is not given the platform code it no longer needs', async () => {
    const payload = taxonomy({ ...TODAY, appointments: ['SALES_MEETING'] });
    payload.types = payload.types.filter((t) => t.code !== 'SELL_PRESENTATION');
    await publish(payload);
    const provisioned = await provisionFrom(wired, KPM_A, COMPANY);
    expect(provisioned.cascadeAdded).toEqual([]);
    const codes = (await mongoose.connection.db!.collection('activityTypes').find({ kpmId: KPM_A }).toArray()).map((t) => t.code);
    expect(codes).toContain('SALES_MEETING');
    expect(codes).not.toContain('SELL_PRESENTATION');
  });

  it('P18.9-T2 AC-3 the template’s publish refuses a binding its taxonomy cannot honour, and publishes one it can', async () => {
    for (const bindings of [
      { ...TODAY, appointments: ['NOT_IN_THE_TEMPLATE'] },
      { ...TODAY, closings: [] },
      { ...TODAY, appointments: ['LEADS_CONTACTED'] },
      { leads: 'LEADS_CONTACTED', appointments: [], closings: [] },
    ]) {
      await expect(publish(taxonomy(bindings))).rejects.toMatchObject({
        status: 400, message: expect.stringMatching(/^Activity binding: /),
      });
    }
    // A platform code the template does not hold is one an office made from it is given (`withCascadeTypes`).
    const without = taxonomy({ ...TODAY, appointments: ['SELL_PRESENTATION'] });
    without.types = without.types.filter((t) => t.code !== 'SELL_PRESENTATION');
    await expect(publish(without)).resolves.toMatchObject({ status: 'published' });
  });

  describe('P18.9-T2 AC-1 Save as template carries the office’s own binding', () => {
    const snapshot = {
      activity: [{
        code: 'SELLING', label: 'Selling', displayOrder: 1, status: 'active',
        types: [
          { code: 'SELL_PRESENTATION', label: 'Presentasi', displayOrder: 1, status: 'archived' },
          { code: 'SALES_MEETING', label: 'Sales meeting', displayOrder: 2, status: 'active' },
          { code: 'SELL_SUBMISSION', label: 'Submission', displayOrder: 3, status: 'active' },
        ],
      }, {
        code: 'LEADS_GENERATION', label: 'Leads', displayOrder: 0, status: 'active',
        types: [{ code: 'LEADS_CONTACTED', label: 'Set appointment', displayOrder: 1, status: 'active' }],
      }],
    };

    it('keeps the codes the template holds, and says which archived one it took out', () => {
      const { kinds, dropped } = templateKindsFromOffice({
        snapshot, checklist: null, moduleContent: [],
        binding: { ...TODAY, appointments: ['SELL_PRESENTATION', 'SALES_MEETING'] },
      });
      expect(kinds.activity_taxonomy?.bindings).toEqual({ ...TODAY, appointments: ['SALES_MEETING'] });
      expect(dropped).toEqual([{
        kind: 'activity_taxonomy', code: null,
        reason: 'The activity binding no longer counts SELL_PRESENTATION, which is not an active activity type in this office.',
      }]);
    });

    it('leaves the binding out, and says so, when a role would count nothing', () => {
      const { kinds, dropped } = templateKindsFromOffice({
        snapshot, checklist: null, moduleContent: [], binding: TODAY,
      });
      expect(kinds.activity_taxonomy?.bindings).toBeUndefined();
      expect(dropped[0]).toMatchObject({
        kind: 'activity_taxonomy', reason: expect.stringMatching(/^The activity binding was left out: Sales meeting/),
      });
    });

    it('reads the snapshot’s record when no live binding is handed over', () => {
      const { kinds } = templateKindsFromOffice({
        snapshot: { ...snapshot, activityBinding: { ...TODAY, appointments: ['SALES_MEETING'], version: 3 } },
        checklist: null, moduleContent: [],
      });
      expect(kinds.activity_taxonomy?.bindings).toEqual({ ...TODAY, appointments: ['SALES_MEETING'] });
    });
  });
});
