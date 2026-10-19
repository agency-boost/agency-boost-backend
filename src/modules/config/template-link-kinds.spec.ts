import mongoose from 'mongoose';
import { RequestContext } from '@/common/context/request-context';
import { activationLinkKinds } from '@/domain/constants';
import { clearCollections, startMongo, stopMongo } from '../../../test/mongo';
import { configModule, givenDefaultTemplate } from '../../../test/config-module';

const NOW = new Date('2026-10-10T03:00:00Z');
const root = new RequestContext('u-root', 'super_admin', null);

/**
 * **The Company template's *Auto*, from the `live` the server serves** (P18.5-T3 AC-6, I-80): an
 * `activation_checklist` read answers the link registry — the three feature kinds and the training kind — with what
 * each completes on and whether it is live, so the tab's badge never re-declares it. Every other kind answers none.
 */
describe('the Company template’s link kinds (P18.5-T3 AC-6)', () => {
  let wired: ReturnType<typeof configModule>;
  let companyId: string;

  beforeAll(async () => {
    await startMongo();
    wired = configModule(NOW);
  });
  afterAll(stopMongo);
  beforeEach(async () => {
    await clearCollections();
    const company = new mongoose.Types.ObjectId();
    await (wired.companies as unknown as mongoose.Model<object>).collection.insertOne({
      _id: company, name: 'Prudential', slug: 'prudential', deletedAt: null,
    });
    companyId = String(company);
    await givenDefaultTemplate(wired, companyId);
  });

  const expected = {
    'feature:goals': { label: 'Goal Settings', route: '/goals', completesWhen: 'the hire has saved any goal since joining', live: true },
    'feature:leads': { label: 'Leads Management', route: '/leads', completesWhen: 'the hire has added at least one prospect', live: true },
    'feature:activity': {
      label: 'Activity Management', route: '/activity/log', completesWhen: 'the hire has logged activity in four consecutive weeks', live: true,
    },
    training: { label: 'Training module', route: '/training', completesWhen: 'the hire has completed that training module', live: true },
  };

  it('P18.5-T3 AC-6 an activation checklist read answers every kind, the training kind live', async () => {
    const empty = await wired.templateService.read(companyId, 'activation_checklist');
    expect(empty.linkKinds).toEqual(expected);
    expect(empty.linkKinds).toEqual(activationLinkKinds());
  });

  it('P18.5-T3 AC-6 a saved draft carries them too, binding a training module or not', async () => {
    const saved = await wired.templateService.saveDraft(root, companyId, 'activation_checklist', {
      aspects: [{
        code: 'TRAINING', label: '1. Training', displayOrder: 1,
        items: [
          { code: 'MANDATORY_TRAINING', label: 'Mandatory training', displayOrder: 1, autoLink: 'training:CLOSING_TECHNIQUES' },
          { code: 'ROLE_PLAY', label: 'Role play', displayOrder: 2, autoLink: null },
        ],
      }],
    });
    expect(saved.linkKinds).toEqual(expected);
  });

  it('P18.5-T3 AC-6 every other kind answers none', async () => {
    const taxonomy = await wired.templateService.read(companyId, 'training_taxonomy');
    expect(taxonomy).not.toHaveProperty('linkKinds');
  });
});
