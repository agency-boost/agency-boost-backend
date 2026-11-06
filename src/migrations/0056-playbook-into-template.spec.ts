import mongoose from 'mongoose';
import { RequestContext } from '@/common/context/request-context';
import { SOURCE_READER } from '@/common/i18n/reader';
import type { RecruitmentPlaybookBody } from '@/domain/constants';
import { defaultPlaybookBody } from '@/modules/recruitment/recruitment-playbook-defaults';
import { readBrief, recruitmentPlanFor, recruitmentVocabulary } from '@/modules/recruitment/recruitment-plan';
import { playbookFor } from '@/modules/recruitment/recruitment-words';
import { Kpm, KpmSchema } from '@/modules/tenants/kpm.schema';
import { clearCollections, startMongo, stopMongo, syncIndexes } from '../../test/mongo';
import { configModule } from '../../test/config-module';
import { up } from './0056-playbook-into-template';

const NOW = new Date('2026-11-05T02:00:00Z');
const PRUDENTIAL = '66f0000000000000000000c1';
const ALLIANZ = '66f0000000000000000000c2';
const BLANK = '66f0000000000000000000c3';
const NEWCO = '66f0000000000000000000c4';
const BARE = '66f0000000000000000000c5';
const LIBRARY = '66f0000000000000000000c9';
const KPM_A = '66f0000000000000000000a1'; // Prudential, made from its default
const KPM_B = '66f0000000000000000000a2'; // Prudential, made from its second template
const KPM_C = '66f0000000000000000000a3'; // Prudential, made from the library's template
const KPM_BLANK = '66f0000000000000000000a4';
const BRIEF = { type: 'retiree', motivation: 'flexibility,leadership', hesitation: 'no-network,time' };

const member = (kpmId: string) => new RequestContext(`u-${kpmId}`, 'none', {
  membershipId: `m-${kpmId}`, kpmId, orgLevelCode: 'AGENT', hierarchyRole: 'agent', status: 'active',
  isKpmOwner: false, isKpmAdmin: false, directCount: 0,
} as never).withReader(SOURCE_READER);

/**
 * **0056 — each company's playbook into its templates** (P19.4-T5 AC-7, AC-8; ADR-0210 §5): a published version of the
 * `recruitment_playbook` kind continuing the record's version, in the default template and each template a KPM was made
 * from, the record marked `migratedTo`; idempotent; and every KPM reads the same words before and after.
 */
describe('0056 — the recruitment playbook into the templates (ADR-0210 §5)', () => {
  const db = () => mongoose.connection.db as mongoose.mongo.Db;
  const col = (name: string) => db().collection(name);
  let wired: ReturnType<typeof configModule>;
  const sa = RequestContext.platform('root');
  let prudentialDefault = '';
  let prudentialJakarta = '';
  let allianzDefault = '';
  let bareRecord = '';

  beforeAll(async () => {
    await startMongo();
    wired = configModule(NOW);
    await syncIndexes();
  }, 60_000);
  afterAll(stopMongo);

  /** Prudential's words, reworded three times on the console before T5. */
  const prudentialWords = (): RecruitmentPlaybookBody => ({ ...defaultPlaybookBody(), nextAction: 'Kata-kata Prudential, versi 3.' });

  beforeEach(async () => {
    await clearCollections();
    await (wired.companies as { create: (d: unknown) => Promise<unknown> }).create([
      { _id: PRUDENTIAL, name: 'Prudential', slug: 'prudential' },
      { _id: ALLIANZ, name: 'Allianz', slug: 'allianz' },
      { _id: BLANK, name: 'Sejahtera', slug: 'sejahtera', usesPlatformDefaults: false },
      { _id: NEWCO, name: 'Baru', slug: 'baru', playbookInTemplates: true },
      { _id: BARE, name: 'Tanpa template', slug: 'tanpa-template' },
      { _id: LIBRARY, name: 'Template', slug: 'template', kind: 'template' },
    ]);
    prudentialDefault = (await wired.namedTemplates.create(sa, PRUDENTIAL, { name: 'Prudential template', from: 'empty' })).id;
    prudentialJakarta = (await wired.namedTemplates.create(sa, PRUDENTIAL, { name: 'Jakarta', from: 'empty' })).id;
    await wired.namedTemplates.create(sa, PRUDENTIAL, { name: 'Unused', from: 'empty' });
    allianzDefault = (await wired.namedTemplates.create(sa, ALLIANZ, { name: 'Allianz template', from: 'defaults' })).id;
    await wired.namedTemplates.create(sa, BLANK, { name: 'Sejahtera template', from: 'empty' });
    await wired.namedTemplates.create(sa, NEWCO, { name: 'Baru template', from: 'empty' });

    const office = (_id: string, companyId: string, code: string, startedFrom: Record<string, unknown> | null) =>
      ({ _id, companyId, code, branchName: code, timezone: 'Asia/Jakarta', startedFrom });
    await mongoose.model(Kpm.name, KpmSchema).create([
      office(KPM_A, PRUDENTIAL, '0417', { source: 'template', templateId: prudentialDefault, templateName: 'Prudential template' }),
      office(KPM_B, PRUDENTIAL, '0555', { source: 'template', templateId: prudentialJakarta, templateName: 'Jakarta' }),
      office(KPM_C, PRUDENTIAL, '0556', { source: 'template', templateId: 'library-default', templateName: 'Default template', companyId: LIBRARY }),
      office(KPM_BLANK, BLANK, '0701', { source: 'empty', templateId: null, templateName: null }),
    ]);

    // The records as they stood before T5: Prudential reworded (v3), Allianz given the words (v1), the new company's
    // written by 0025 on a later deploy, and one of a company with no template yet.
    const at = new Date('2026-10-20T02:00:00Z');
    await col('recruitmentPlaybooks').insertMany([
      { companyId: PRUDENTIAL, body: prudentialWords(), version: 3, updatedBy: 'sa-1', createdBy: null, deletedAt: null, createdAt: at, updatedAt: at },
      { companyId: ALLIANZ, body: defaultPlaybookBody(), version: 1, updatedBy: null, createdBy: null, deletedAt: null, createdAt: at, updatedAt: at },
      { companyId: NEWCO, body: defaultPlaybookBody(), version: 1, updatedBy: null, createdBy: null, deletedAt: null, createdAt: at, updatedAt: at },
      { companyId: BARE, body: defaultPlaybookBody(), version: 2, updatedBy: null, createdBy: null, deletedAt: null, createdAt: at, updatedAt: at },
    ]);
    bareRecord = String((await col('recruitmentPlaybooks').findOne({ companyId: BARE }))!._id);
  });

  /** What a KPM read before T5: its company's one record, as the plan was built from it. */
  async function before(kpmId: string) {
    const kpm = await col('kpms').findOne({ _id: new mongoose.Types.ObjectId(kpmId) });
    const record = await col('recruitmentPlaybooks').findOne({ companyId: kpm!.companyId, deletedAt: null });
    return {
      hasPlaybook: record !== null,
      vocabulary: recruitmentVocabulary(SOURCE_READER),
      plan: record ? recruitmentPlanFor(playbookFor(record.body, SOURCE_READER), readBrief(BRIEF)!, SOURCE_READER) : null,
    };
  }

  it('P19.4-T5 AC-7 moves Prudential’s into its default template and the template a KPM was made from, continuing version 3', async () => {
    const result = await up(db(), NOW);
    expect(result).toEqual({ moved: 2, versions: 2, current: 0, noTemplate: 1, skipped: 1, ownKept: 1 });

    const record = await col('recruitmentPlaybooks').findOne({ companyId: PRUDENTIAL });
    for (const templateId of [prudentialDefault, prudentialJakarta]) {
      expect(await col('companyTemplates').findOne({ companyId: PRUDENTIAL, templateId, kind: 'recruitment_playbook' })).toMatchObject({
        status: 'published', version: 3, revision: 3, payload: prudentialWords(), deletedAt: null,
        migratedFrom: { recruitmentPlaybookId: String(record!._id), version: 3 },
        // Published when it was last saved: the history reads on.
        publishedAt: new Date('2026-10-20T02:00:00Z'),
      });
    }
    // The record stays, read by nothing, marked.
    expect(record).toMatchObject({ migratedTo: { templateId: prudentialDefault, version: 3 }, deletedAt: null });
    // A template no KPM was made from, and not the default, is not given it.
    expect(await col('companyTemplates').countDocuments({ companyId: PRUDENTIAL, kind: 'recruitment_playbook' })).toBe(2);
  });

  it('P19.4-T5 AC-7 is idempotent: a second run writes nothing', async () => {
    await up(db(), NOW);
    const sections = await col('companyTemplates').find({ kind: 'recruitment_playbook' }).sort({ _id: 1 }).toArray();
    const records = await col('recruitmentPlaybooks').find({}).sort({ _id: 1 }).toArray();
    expect(await up(db(), NOW)).toEqual({ moved: 0, versions: 0, current: 2, noTemplate: 1, skipped: 1, ownKept: 0 });
    expect(await col('companyTemplates').find({ kind: 'recruitment_playbook' }).sort({ _id: 1 }).toArray()).toEqual(sections);
    expect(await col('recruitmentPlaybooks').find({}).sort({ _id: 1 }).toArray()).toEqual(records);
  });

  it('P19.4-T5 AC-8 every KPM reads the same words before and after', async () => {
    const was = await Promise.all([KPM_A, KPM_B, KPM_C, KPM_BLANK].map(before));
    await up(db(), NOW);
    const now = await Promise.all([KPM_A, KPM_B, KPM_C, KPM_BLANK].map((k) => wired.recruitmentPlans.attackPlan(member(k), BRIEF)));
    expect(now).toEqual(was);
    expect(now[0].plan!.nextAction).toBe('Kata-kata Prudential, versi 3.');
    expect(now[3]).toMatchObject({ hasPlaybook: false, plan: null });
  });

  it('P19.4-T5 AC-7 leaves a template’s own playbook, a company made since T5, and one with no template', async () => {
    await up(db(), NOW);
    // Allianz's template already held one: kept, version 1 of its own, nothing migratedFrom.
    const allianz = await col('companyTemplates').find({ companyId: ALLIANZ, kind: 'recruitment_playbook' }).toArray();
    expect(allianz).toHaveLength(1);
    expect(allianz[0]).toMatchObject({ templateId: allianzDefault, migratedFrom: null });
    // The company made since T5: 0025's words never reach its template.
    expect(await col('companyTemplates').countDocuments({ companyId: NEWCO, kind: 'recruitment_playbook' })).toBe(0);
    expect(await col('recruitmentPlaybooks').findOne({ companyId: NEWCO })).not.toHaveProperty('migratedTo');
    // No template: the record waits, unmarked, for a run after it has one.
    expect(await col('recruitmentPlaybooks').findOne({ companyId: BARE })).not.toHaveProperty('migratedTo');
    const made = await wired.namedTemplates.create(sa, BARE, { name: 'Kini ada', from: 'empty' });
    expect(await up(db(), NOW)).toMatchObject({ moved: 1, versions: 1, noTemplate: 0 });
    expect(await col('companyTemplates').findOne({ templateId: made.id, kind: 'recruitment_playbook' }))
      .toMatchObject({ version: 2, migratedFrom: { recruitmentPlaybookId: bareRecord, version: 2 } });
  });

  it('P19.4-T5 AC-7 the history goes on: the next publish is version 4', async () => {
    await up(db(), NOW);
    const read = await wired.templateService.read(PRUDENTIAL, 'recruitment_playbook', prudentialDefault);
    await wired.templateService.saveDraft(sa, PRUDENTIAL, 'recruitment_playbook', { ...prudentialWords(), nextAction: 'Versi 4.' } as never, prudentialDefault, read.revision);
    expect(await wired.templateService.publish(sa, PRUDENTIAL, 'recruitment_playbook', prudentialDefault)).toMatchObject({ version: 4 });
  });

  it('P19.4-T5 AC-7 writes nothing on an empty database', async () => {
    await clearCollections();
    expect(await up(db(), NOW)).toEqual({ moved: 0, versions: 0, current: 0, noTemplate: 0, skipped: 0, ownKept: 0 });
  });
});
