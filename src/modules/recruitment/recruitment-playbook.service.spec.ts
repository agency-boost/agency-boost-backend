import mongoose from 'mongoose';
import { RequestContext } from '@/common/context/request-context';
import { DomainException } from '@/common/errors/domain.exception';
import { readerIn, SOURCE_READER } from '@/common/i18n/reader';
import { RECRUITMENT, SEED_RECRUITMENT_PLAYBOOK } from '@/domain/constants';
import { PUBLISH_ORDER } from '@/modules/config/template.service';
import { clearCollections, startMongo, stopMongo, syncIndexes } from '../../../test/mongo';
import { configModule } from '../../../test/config-module';
import { defaultPlaybookBody } from './recruitment-playbook-defaults';

const NOW = new Date('2026-11-05T02:00:00Z');
const PRUDENTIAL = '66f0000000000000000000c1';
const ALLIANZ = '66f0000000000000000000c2';
const KPM_A = '66f0000000000000000000a1';
const KIND = 'recruitment_playbook';

/** What a refusal was, or `null` when the call succeeded. */
async function refusalOf(work: Promise<unknown>) {
  try {
    await work;
    return null;
  } catch (err) {
    const e = err as DomainException;
    return { status: e.getStatus(), code: e.code, details: e.details, message: e.messageFor?.(readerIn('id')) };
  }
}

/**
 * **The recruitment playbook as a template section** (P19.4-T5 AC-6, AC-8; ADR-0210 §1, §2, §4): drafted as it is
 * typed through the template's kind routes, published whole, copied with the template, and read by each KPM from the
 * template it was made from — through `RecruitmentPlaybookService`'s named company-filtered reads.
 */
describe('P19.4-T5 the recruitment playbook, a template section (ADR-0210)', () => {
  let wired: ReturnType<typeof configModule>;
  const db = () => mongoose.connection.db!;
  const sa = RequestContext.platform('root').withReader(SOURCE_READER);
  let prudentialDefault = '';

  beforeAll(async () => {
    await startMongo();
    wired = configModule(NOW);
    await syncIndexes();
  }, 60_000);
  afterAll(stopMongo);

  beforeEach(async () => {
    await clearCollections();
    await (wired.companies as { create: (d: unknown) => Promise<unknown> }).create([
      { _id: PRUDENTIAL, name: 'Prudential', slug: 'prudential' },
      { _id: ALLIANZ, name: 'Allianz Life', slug: 'allianz-life' },
    ]);
    prudentialDefault = (await wired.namedTemplates.create(sa, PRUDENTIAL, { name: 'Prudential template', from: 'empty' })).id;
  });

  const templates = () => wired.templateService;
  const save = (payload: Record<string, unknown>, revision?: number) =>
    templates().saveDraft(sa, PRUDENTIAL, KIND, payload, prudentialDefault, revision);
  const publish = () => templates().publish(sa, PRUDENTIAL, KIND, prudentialDefault);

  describe('AC-6: a section of its own', () => {
    it('P19.4-T5 AC-6 an empty template holds none: Kosong, version 0, with the editor’s defaults, vocabulary and bounds', async () => {
      const read = await templates().read(PRUDENTIAL, KIND, prudentialDefault, readerIn('id'));
      expect(read).toMatchObject({ kind: KIND, version: 0, status: 'draft', payload: {}, publishedVersion: null });
      expect(read.playbook!.defaults).toEqual(SEED_RECRUITMENT_PLAYBOOK);
      expect(read.playbook!.limits).toEqual({ textMax: RECRUITMENT.TEXT_MAX_LENGTH, benefitsMax: RECRUITMENT.BENEFITS_MAX });
      expect(read.playbook!.vocabulary.types.map((t) => t.code)).toHaveLength(5);
      // Only this kind carries it.
      expect((await templates().read(PRUDENTIAL, 'event_types', prudentialDefault)).playbook).toBeUndefined();
    });

    it('P19.4-T5 AC-6 its draft saves as it is made — half-written included — and goes out with Terbitkan, trimmed', async () => {
      const half = { nextAction: '  Ajak ke BOP  ' };
      const draft = await save(half);
      expect(draft).toMatchObject({ status: 'draft', version: 1, revision: 1, payload: half });

      const body = defaultPlaybookBody() as unknown as Record<string, unknown>;
      body.nextAction = '  Ajak ke BOP hari Kamis.  ';
      await save(body, 1);
      const published = await publish();
      expect(published).toMatchObject({ status: 'published', version: 1, publishedVersion: 1 });
      expect((published.payload as { nextAction: string }).nextAction).toBe('Ajak ke BOP hari Kamis.');
    });

    it('P19.4-T5 AC-6 a playbook that is not whole is refused at Terbitkan, every field named, and stays a draft', async () => {
      await save({ nextAction: '' });
      const refused = await refusalOf(publish());
      expect(refused).toMatchObject({ status: 400, code: 'VALIDATION_FAILED' });
      expect((refused!.details as { violations: { field: string }[] }).violations.map((v) => v.field))
        .toEqual(expect.arrayContaining(['body.profiles.retiree', 'body.nextAction']));
      expect(refused!.message).toMatch(/^Playbook ini tidak dapat diterbitkan: /);
      expect(await db().collection('companyTemplates').countDocuments({ kind: KIND, status: 'published' })).toBe(0);
    });

    it('P19.4-T5 AC-6 a stale draft save is refused 409, as every section’s (P19-T6)', async () => {
      await save({ nextAction: 'a' });
      expect(await refusalOf(save({ nextAction: 'b' }, 0))).toMatchObject({ status: 409, code: 'VERSION_CONFLICT' });
    });

    it('P19.4-T5 AC-6 Terbitkan semua publishes it after event_types, and the template counts it as its seventh section', async () => {
      expect(PUBLISH_ORDER.indexOf(KIND)).toBe(PUBLISH_ORDER.indexOf('event_types') + 1);
      await save(defaultPlaybookBody() as unknown as Record<string, unknown>);
      const all = await templates().publishAll(sa, PRUDENTIAL, prudentialDefault);
      // Right after the event types — Phase 19.5's *Advanced analytics* may follow it.
      const kinds = all.results.map((r) => r.kind);
      expect(kinds.indexOf(KIND)).toBe(kinds.indexOf('event_types') + 1);
      expect(all.results.find((r) => r.kind === KIND)).toEqual({ kind: KIND, outcome: 'published', version: 1 });
      expect(all.template.sections[KIND]).toEqual({ publishedVersion: 1, hasDraft: false });
      expect(all.template.publishedVersions[KIND]).toBe(1);
    });

    it('P19.4-T5 AC-6 no office is ever behind it: the playbook is read live, so nothing is pushed or counted', async () => {
      await db().collection('kpms').insertOne({
        _id: new mongoose.Types.ObjectId(KPM_A), companyId: PRUDENTIAL, code: '0417', deletedAt: null, status: 'active',
        startedFrom: { source: 'template', templateId: prudentialDefault, templateName: 'Prudential template' },
        seededFrom: {},
      });
      await save(defaultPlaybookBody() as unknown as Record<string, unknown>);
      const published = await publish();
      expect(published).toMatchObject({ officesBehind: 0, officesUnrecorded: 0 });
    });

    it('P19.4-T5 AC-6 Salin dari… copies it: within the company and from another, the words as published', async () => {
      const body = defaultPlaybookBody() as unknown as Record<string, unknown>;
      body.nextAction = 'Kata-kata Prudential.';
      await save(body);
      await publish();

      const copy = await wired.namedTemplates.create(sa, PRUDENTIAL, { name: 'Salinan', from: { templateId: prudentialDefault } });
      expect(copy.publishedVersions[KIND]).toBe(1);
      const imported = await wired.templateCopies.importFrom(sa, ALLIANZ, {
        fromCompanyId: PRUDENTIAL, templateId: prudentialDefault, name: 'Dari Prudential',
      });
      // Allianz's first template: its default (ADR-0213 §3), text only — the playbook names no rung.
      expect(imported).toMatchObject({ isDefault: true });
      for (const [companyId, templateId] of [[PRUDENTIAL, copy.id], [ALLIANZ, imported.id]]) {
        const read = await wired.recruitmentPlaybooks.publishedOf(companyId, templateId);
        expect(read).toMatchObject({ version: 1, body: { nextAction: 'Kata-kata Prudential.' } });
      }
    });
  });

  describe('AC-8: which playbook a KPM reads (RecruitmentPlaybookService)', () => {
    it('P19.4-T5 AC-8 nothing for an office that is not there, a malformed id, or a company with no template', async () => {
      expect(await wired.recruitmentPlaybooks.forOffice('66f0000000000000000000ff')).toBeNull();
      expect(await wired.recruitmentPlaybooks.forOffice('not-an-id')).toBeNull();
      expect(await wired.recruitmentPlaybooks.templateOf(ALLIANZ, null)).toBeNull();
    });

    it('P19.4-T5 AC-8 a KPM of a company with no template reads none — never another company’s published playbook', async () => {
      // Prudential publishes one; Allianz has no template at all, so its KPM is ADR-0125's empty state.
      await save(defaultPlaybookBody() as unknown as Record<string, unknown>);
      await publish();
      await db().collection('kpms').insertOne({
        _id: new mongoose.Types.ObjectId(KPM_A), companyId: ALLIANZ, code: '0417', deletedAt: null, status: 'active',
        // Even naming Prudential's template, as a KPM moved between companies still does (ADR-0191 §5).
        startedFrom: { source: 'template', templateId: prudentialDefault, templateName: 'Prudential template' },
        seededFrom: {},
      });
      expect(await wired.recruitmentPlaybooks.forOffice(KPM_A)).toBeNull();
    });

    it('P19.4-T5 AC-8 the template it was made from when that is its company’s, else the default; a stale id is the default', async () => {
      const second = await wired.namedTemplates.create(sa, PRUDENTIAL, { name: 'Kedua', from: 'empty' });
      const of = (from: Record<string, unknown> | null) => wired.recruitmentPlaybooks.templateOf(PRUDENTIAL, from as never);
      expect(await of({ source: 'template', templateId: second.id, templateName: 'Kedua' })).toBe(second.id);
      expect(await of({ source: 'template', templateId: second.id, templateName: 'Kedua', companyId: PRUDENTIAL })).toBe(second.id);
      expect(await of({ source: 'template', templateId: second.id, templateName: 'Kedua', companyId: ALLIANZ })).toBe(prudentialDefault);
      expect(await of({ source: 'template', templateId: '66f0000000000000000000ee', templateName: 'gone' })).toBe(prudentialDefault);
      expect(await of({ source: 'template', templateId: 'not-an-id', templateName: 'gone' })).toBe(prudentialDefault);
      expect(await of({ source: 'empty', templateId: null, templateName: null })).toBe(prudentialDefault);
      expect(await of(null)).toBe(prudentialDefault);
    });

    it('P19.4-T5 AC-8 the newest published version, never the draft beside it', async () => {
      const first = defaultPlaybookBody() as unknown as Record<string, unknown>;
      first.nextAction = 'Versi satu.';
      await save(first);
      await publish();
      const second = { ...first, nextAction: 'Versi dua.' };
      await save(second, 1);
      await publish();
      await save({ ...first, nextAction: 'Draf.' }, 2);
      expect(await wired.recruitmentPlaybooks.publishedOf(PRUDENTIAL, prudentialDefault))
        .toMatchObject({ version: 2, body: { nextAction: 'Versi dua.' } });
    });
  });
});
