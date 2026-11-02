import mongoose from 'mongoose';
import { RequestContext } from '@/common/context/request-context';
import { readerIn, SOURCE_READER } from '@/common/i18n/reader';
import { activationLinkKinds } from '@/domain/constants';
import { clearCollections, startMongo, stopMongo } from '../../../test/mongo';
import { configModule, givenDefaultTemplate } from '../../../test/config-module';

const NOW = new Date('2026-10-10T03:00:00Z');
/** The Super Admin, reading the API's English as an `Accept-Language: en` request does (ADR-0179 §9). */
const root = new RequestContext('u-root', 'super_admin', null).withReader(SOURCE_READER);

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
    const empty = await wired.templateService.read(companyId, 'activation_checklist', undefined, SOURCE_READER);
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
    const taxonomy = await wired.templateService.read(companyId, 'training_taxonomy', undefined, SOURCE_READER);
    expect(taxonomy).not.toHaveProperty('linkKinds');
  });
  it('P18.98-T7 what completes each kind is written for the reader — the activation module’s own words', async () => {
    const id = readerIn('id');
    const read = await wired.templateService.read(companyId, 'activation_checklist', undefined, id);
    expect(Object.fromEntries(Object.entries(read.linkKinds!).map(([k, v]) => [k, v.completesWhen]))).toEqual({
      'feature:goals': 'rekrut telah menyimpan goal apa pun sejak bergabung',
      'feature:leads': 'rekrut telah menambahkan setidaknya satu prospek',
      'feature:activity': 'rekrut telah mencatat aktivitas selama empat minggu berturut-turut',
      training: 'rekrut telah menyelesaikan modul training tersebut',
    });
    // The labels are page names and the kind's own, the same in both; route and live as they are.
    expect(Object.values(read.linkKinds!).map((k) => [k.label, k.route, k.live]))
      .toEqual(Object.values(expected).map((k) => [k.label, k.route, k.live]));
    const history = await wired.templateService.history(companyId, 'activation_checklist', undefined, id);
    for (const row of history) expect(row.linkKinds).toEqual(read.linkKinds);
    const saved = await wired.templateService.saveDraft(root.withReader(id), companyId, 'activation_checklist', {
      aspects: [{
        code: 'TRAINING', label: '1. Pelatihan', displayOrder: 1,
        items: [{ code: 'ROLE_PLAY', label: 'Role play', displayOrder: 1, autoLink: null }],
      }],
    });
    expect(saved.linkKinds).toEqual(read.linkKinds);
  });
});
