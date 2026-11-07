import mongoose from 'mongoose';
import { RequestContext } from '@/common/context/request-context';
import { SEED_TRAINING_MODULES } from '@/domain/constants';
import { clearCollections, startMongo, stopMongo } from '../../../test/mongo';
import { configModule, provisionFrom } from '../../../test/config-module';
import { english } from '../../../test/i18n';
import { TEMPLATE_PUSH_REFUSALS } from './template-push.messages';
import { OFFICE_TEMPLATE_KINDS } from './template-defaults';

const NOW = new Date('2026-11-05T03:00:00Z');
const COMPANY = '66f0000000000000000000c1';
const OTHER = '66f0000000000000000000c2';
const LIBRARY = '66f0000000000000000000c9';
const sa = RequestContext.platform('root');
const col = (name: string) => mongoose.connection.db!.collection(name);

/** The first published module of the defaults: where material goes in these specs. */
const MODULE = SEED_TRAINING_MODULES.find((m) => m.publishState === 'published')!.code;
const SECOND = SEED_TRAINING_MODULES.filter((m) => m.publishState === 'published')[1].code;

/** The Owner of one office, as a signed-in context. */
const ownerOf = (kpmId: string) => new RequestContext(`owner-${kpmId}`, 'none', {
  membershipId: `m-owner-${kpmId}`, kpmId, orgLevelCode: 'AB', hierarchyRole: 'ab', status: 'active',
  isKpmOwner: true, isKpmAdmin: false, directCount: 0,
} as never);

/**
 * **A template's Training material and its push to the KPMs made from it** (P19.4-T1; ADR-0208), against MongoDB with
 * the services wired as the app wires them: two KPMs of Prudential made from its default template, one of Allianz.
 */
describe('P19.4-T1 a template’s material and its push (ADR-0208)', () => {
  let wired: ReturnType<typeof configModule>;
  let templateId: string;
  let otherTemplateId: string;
  let A: string;
  let B: string;
  let C: string;

  /** An office made from a company's template, recorded as `createKpm` records it, its first version published. */
  async function office(code: string, companyId: string, template: string, owner: string | null = null): Promise<string> {
    const kpms = wired.kpms as unknown as mongoose.Model<never>;
    const _id = new mongoose.Types.ObjectId();
    const startFrom = { kind: 'template' as const, templateId: template };
    const plan = await wired.provisioning.planFor(companyId, startFrom);
    await kpms.create({
      _id, companyId, code, branchName: `${code} Branch`, startedFrom: plan.startedFrom, ownerUserId: owner,
    } as never);
    const done = await provisionFrom(wired, String(_id), companyId, startFrom);
    await kpms.updateOne({ _id } as never, { $set: { seededFrom: done.seededFrom } } as never);
    await wired.provisioning.publishInitialSnapshotFor(String(_id), RequestContext.superAdminInTenant('root', String(_id)));
    return String(_id);
  }

  /** A confirmed company file of the template, as the Super Admin's upload leaves one. */
  async function templateFile(template = templateId, companyId = COMPANY) {
    const signed = await wired.templateMaterial.requestUpload(sa, companyId, template, {
      filename: 'Modul.pdf', mimeType: 'application/pdf', bytes: 2048,
    });
    const confirmed = await wired.templateMaterial.confirmUpload(sa, companyId, template, signed.storageKey);
    return { id: '', label: 'Modul.pdf', ...confirmed };
  }

  /** The template's training, with material on `MODULE`, published: version 2. */
  async function publishMaterial(): Promise<{ storageKey: string }> {
    const file = await templateFile();
    await wired.templateMaterial.saveModuleContent(sa, COMPANY, templateId, MODULE, {
      files: [file], links: [{ label: 'Bacaan', url: 'https://example.com/modul' }],
    });
    await wired.templateService.publish(sa, COMPANY, 'training_taxonomy', templateId);
    return file;
  }

  const moduleOf = async (kpmId: string, code = MODULE) => col('trainingModules').findOne({ kpmId, code, deletedAt: null });

  beforeAll(async () => {
    await startMongo();
    wired = configModule(NOW);
  });
  afterAll(stopMongo);

  beforeEach(async () => {
    await clearCollections();
    wired.sentNotifications.length = 0;
    const companies = wired.companies as unknown as mongoose.Model<never>;
    const prudential = await companies.create({ _id: COMPANY, name: 'Prudential', slug: 'prudential' } as never);
    const allianz = await companies.create({ _id: OTHER, name: 'Allianz Life', slug: 'allianz' } as never);
    templateId = String((await wired.namedTemplates.createFirst(sa, prudential as never))._id);
    otherTemplateId = String((await wired.namedTemplates.createFirst(sa, allianz as never))._id);
    A = await office('0417', COMPANY, templateId, 'owner-0417');
    B = await office('0555', COMPANY, templateId);
    C = await office('9001', OTHER, otherTemplateId);
  });

  describe('the Training section’s material', () => {
    it('P19.4-T1 AC-1 a file is the company’s, stored under its folder, recorded as the template’s, confirmed against storage', async () => {
      const file = await templateFile();
      expect(file.storageKey).toMatch(new RegExp(`/company/${COMPANY}/templates/${templateId}/training/`));
      const row = await col('assets').findOne({ storageKey: file.storageKey });
      expect(row).toMatchObject({ companyId: COMPANY, kpmId: null, templateId, uploadState: 'confirmed' });
      expect((await col('auditLog').find({ action: { $in: ['company_template.material_upload_requested', 'company_template.material_uploaded'] } }).toArray()))
        .toHaveLength(2);
    });

    it('P19.4-T1 AC-1 the material is the draft’s, saved by module code, and goes live with Terbitkan', async () => {
      const file = await templateFile();
      const draft = await wired.templateMaterial.saveModuleContent(sa, COMPANY, templateId, MODULE.toLowerCase(), {
        files: [file], videos: [], links: [{ label: 'Bacaan', url: 'https://example.com/modul' }],
      });
      expect(draft.status).toBe('draft');
      const module = (draft.payload.modules as { code: string; content?: { files: unknown[]; links: { url: string; id: string }[] } }[])
        .find((m) => m.code === MODULE)!;
      expect(module.content!.files).toHaveLength(1);
      expect(module.content!.links[0]).toMatchObject({ url: 'https://example.com/modul' });
      expect(module.content!.links[0].id).toBeTruthy();
      // Nothing reaches the published version until it is published.
      expect((await wired.templateService.read(COMPANY, 'training_taxonomy', templateId)).published?.version).toBe(1);
      const published = await wired.templateService.publish(sa, COMPANY, 'training_taxonomy', templateId);
      expect(published.version).toBe(2);
      expect(await col('auditLog').countDocuments({ action: 'company_template.material_saved' })).toBe(1);
      // A file a template names is held, so the orphan sweep does not report it.
      expect((await col('assets').findOne({ storageKey: file.storageKey }))!.refCount).toBe(1);
    });

    it('P19.4-T1 AC-1 is pinned to the revision the editor read, as every draft save is', async () => {
      const file = await templateFile();
      const first = await wired.templateMaterial.saveModuleContent(sa, COMPANY, templateId, MODULE, { files: [file] });
      await expect(wired.templateMaterial.saveModuleContent(
        sa, COMPANY, templateId, MODULE, { files: [] }, first.revision - 1,
      )).rejects.toMatchObject({ code: 'VERSION_CONFLICT', status: 409 });
      const second = await wired.templateMaterial.saveModuleContent(sa, COMPANY, templateId, MODULE, { files: [] }, first.revision);
      const module = (second.payload.modules as { code: string; content?: unknown }[]).find((m) => m.code === MODULE)!;
      // Empty material takes `content` off the module.
      expect(module.content).toBeUndefined();
    });

    it('P19.4-T1 AC-1 refuses a module the section lacks, another company’s file, a stranger’s key, an unconfirmed upload and an archived template', async () => {
      await expect(wired.templateMaterial.saveModuleContent(sa, COMPANY, templateId, 'NO_SUCH_MODULE', { links: [] }))
        .rejects.toMatchObject({ code: 'VALIDATION_FAILED', status: 400 });
      const theirs = await templateFile(otherTemplateId, OTHER);
      await expect(wired.templateMaterial.saveModuleContent(sa, COMPANY, templateId, MODULE, { files: [theirs] }))
        .rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
      // Confirming another template's key, or another company's, is a 404: knowing a key buys nothing.
      await expect(wired.templateMaterial.confirmUpload(sa, COMPANY, templateId, theirs.storageKey))
        .rejects.toMatchObject({ code: 'NOT_FOUND', status: 404 });
      const pending = await wired.templateMaterial.requestUpload(sa, COMPANY, templateId, {
        filename: 'x.pdf', mimeType: 'application/pdf', bytes: 10,
      });
      await expect(wired.templateMaterial.saveModuleContent(sa, COMPANY, templateId, MODULE, {
        files: [{ label: 'x.pdf', storageKey: pending.storageKey, mimeType: 'application/pdf', bytes: 10 }],
      })).rejects.toMatchObject({ code: 'ASSET_NOT_CONFIRMED', status: 409 });
      await expect(wired.templateMaterial.saveModuleContent(sa, COMPANY, templateId, MODULE, { links: [{ label: 'x', url: 'http://plain.example' }] }))
        .rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
      const copy = await wired.namedTemplates.create(sa, COMPANY, { name: 'Copy', from: 'empty' });
      await wired.namedTemplates.archive(sa, COMPANY, copy.id);
      await expect(wired.templateMaterial.requestUpload(sa, COMPANY, copy.id, { filename: 'x.pdf', mimeType: 'application/pdf', bytes: 1 }))
        .rejects.toMatchObject({ code: 'VALIDATION_FAILED', status: 400 });
      // A template of another company is not found from this one.
      await expect(wired.templateMaterial.requestUpload(sa, COMPANY, otherTemplateId, { filename: 'x.pdf', mimeType: 'application/pdf', bytes: 1 }))
        .rejects.toMatchObject({ code: 'NOT_FOUND', status: 404 });
      // A file type the allow-list lacks, before anything is signed. `text/html` joined the list on 2026-11-06
      // (P19.6-T2, ADR-0217 §1); an archive never did.
      await expect(wired.templateMaterial.requestUpload(sa, COMPANY, templateId, { filename: 'x.zip', mimeType: 'application/zip', bytes: 1 }))
        .rejects.toMatchObject({ code: 'ASSET_TYPE_NOT_ALLOWED' });
    });

    it('P19.4-T1 AC-10 the service refuses anybody without company_template:write, before anything is read', async () => {
      const owner = ownerOf(A);
      await expect(wired.templateMaterial.requestUpload(owner, COMPANY, templateId, { filename: 'x.pdf', mimeType: 'application/pdf', bytes: 1 }))
        .rejects.toMatchObject({ status: 403 });
      await expect(wired.templateMaterial.saveModuleContent(owner, COMPANY, templateId, MODULE, {})).rejects.toMatchObject({ status: 403 });
      await expect(wired.templatePush.apply(owner, COMPANY, templateId, { kinds: ['training_taxonomy'], kpmIds: [A] }))
        .rejects.toMatchObject({ status: 403 });
      await expect(wired.templatePush.standings(owner, COMPANY, templateId, ['training_taxonomy'])).rejects.toMatchObject({ status: 403 });
    });

    it('P19.4-T1 AC-2 Salin dari… copies the material with the template, by reference: no byte copied, no new file', async () => {
      const file = await publishMaterial();
      const assets = await col('assets').countDocuments({});
      const copy = await wired.namedTemplates.create(sa, COMPANY, { name: 'Jakarta', from: { templateId } });
      const training = await wired.templateService.read(COMPANY, 'training_taxonomy', copy.id);
      const module = (training.payload.modules as { code: string; content?: { files: { storageKey: string }[] } }[]).find((m) => m.code === MODULE)!;
      expect(module.content!.files[0].storageKey).toBe(file.storageKey);
      expect(await col('assets').countDocuments({})).toBe(assets);
      expect(wired.storage.copies).toEqual([]);
    });
  });

  describe('what a KPM shows, and its own copy', () => {
    it('P19.4-T1 AC-3 a new KPM made from the template shows its material with nothing uploaded, and counts it', async () => {
      const file = await publishMaterial();
      const fresh = await office('0602', COMPANY, templateId);
      const kctx = ownerOf(fresh);
      const content = await wired.training.readContent(kctx, MODULE);
      expect(content).toMatchObject({ overridden: false });
      expect(content.content.files.map((f) => f.storageKey)).toEqual([file.storageKey]);
      expect(await col('assets').countDocuments({ kpmId: fresh })).toBe(0);
      // Delivered through the company's registry, to a member of an office of the company.
      await expect(wired.training.contentUrl(kctx, MODULE, file.storageKey)).resolves.toMatch(/^https:/);

      // AC-5: each module on the settings list says where its material comes from.
      const modules = (await wired.training.list(kctx)).flatMap((c) => c.skills.flatMap((s) => s.modules));
      expect(modules.find((m) => m.code === MODULE)!.material).toBe('company');
      expect(modules.filter((m) => m.material === 'none')).toHaveLength(modules.length - 1);
      // Never in what agents are offered.
      const offered = (await wired.training.offered(kctx)).flatMap((c) => c.skills.flatMap((s) => s.modules));
      expect(offered.every((m) => m.material === undefined)).toBe(true);
    });

    it('P19.4-T1 AC-4 a KPM’s own file is its own copy; Urungkan perubahan saya returns the template’s, keeping the KPM’s in history', async () => {
      await publishMaterial();
      const fresh = await office('0602', COMPANY, templateId);
      const owner = ownerOf(fresh);
      const signed = await wired.training.requestContentUpload(owner, { filename: 'Milik kami.pdf', mimeType: 'application/pdf', bytes: 99 });
      const mine = await wired.training.confirmContentUpload(owner, signed.storageKey);
      await wired.training.saveContent(owner, MODULE, { files: [{ label: 'Milik kami.pdf', ...mine }] });
      let modules = (await wired.training.list(owner)).flatMap((c) => c.skills.flatMap((s) => s.modules));
      expect(modules.find((m) => m.code === MODULE)!.material).toBe('own');
      // Another KPM is unaffected.
      expect((await moduleOf(A))!.officeContent).toBeNull();

      const reverted = await wired.training.resetContent(owner, MODULE);
      expect(reverted.overridden).toBe(false);
      const row = await moduleOf(fresh);
      expect(row!.officeContent).toBeNull();
      expect(row!.contentHistory).toHaveLength(1);
      expect(row!.contentHistory[0]).toMatchObject({ reason: 'revert', by: owner.userId, templateId: null });
      expect(row!.contentHistory[0].content.files[0].storageKey).toBe(mine.storageKey);
      // The KPM's file is released, never deleted (invariant §6).
      expect(await col('assets').findOne({ storageKey: mine.storageKey })).toMatchObject({ deletedAt: null, refCount: 0 });
      modules = (await wired.training.list(owner)).flatMap((c) => c.skills.flatMap((s) => s.modules));
      expect(modules.find((m) => m.code === MODULE)!.material).toBe('company');
    });
  });

  describe('Terapkan juga ke KPM yang sudah ada', () => {
    /** Office B with its own material on `SECOND`: a KPM that changed its training. */
    async function bWithOwnMaterial(): Promise<string> {
      const owner = ownerOf(B);
      const signed = await wired.training.requestContentUpload(owner, { filename: 'B.pdf', mimeType: 'application/pdf', bytes: 5 });
      const mine = await wired.training.confirmContentUpload(owner, signed.storageKey);
      await wired.training.saveContent(owner, SECOND, { files: [{ label: 'B.pdf', ...mine }] });
      return mine.storageKey;
    }

    it('P19.4-T1 AC-6 AC-7 AC-8 lists each KPM unchanged or changed, with what differs and how many modules use their own material', async () => {
      await publishMaterial();
      await bWithOwnMaterial();
      const rows = await wired.templatePush.standings(sa, COMPANY, templateId, ['training_taxonomy']);
      const byCode = Object.fromEntries(rows.map((r) => [r.code, r]));
      expect(Object.keys(byCode)).toEqual(['0417', '0555']);
      expect(byCode['0417']).toMatchObject({ state: 'unchanged', behind: ['training_taxonomy'] });
      expect(byCode['0417'].kinds).toEqual([expect.objectContaining({
        kind: 'training_taxonomy', state: 'unchanged', givenVersion: 1, newestVersion: 2, differences: [], ownMaterialModules: 0,
      })]);
      expect(byCode['0555'].state).toBe('changed');
      expect(byCode['0555'].kinds[0]).toMatchObject({
        ownMaterialModules: 1, differences: [{ level: 'modules', code: SECOND, change: 'changed', fields: ['material'] }],
      });
    });

    it('P19.4-T1 AC-6 an untouched KPM is given the template’s material by code, versioned, audited and told; a changed one is refused unconfirmed', async () => {
      const file = await publishMaterial();
      await bWithOwnMaterial();
      const progressId = new mongoose.Types.ObjectId();
      await col('trainingProgress').insertOne({
        _id: progressId, kpmId: A, membershipId: 'm-rina', moduleCode: MODULE, status: 'done', deletedAt: null,
      });
      const before = await moduleOf(A);

      const answer = await wired.templatePush.apply(sa, COMPANY, templateId, { kinds: ['training_taxonomy'], kpmIds: [A, B] });
      const [a, b] = answer.offices;
      expect(a.results).toEqual([{ kind: 'training_taxonomy', outcome: 'applied', version: 2, replaced: false }]);
      expect(a.awaitingPublish).toBe(false);
      expect(b.results[0]).toMatchObject({ outcome: 'refused', error: { code: 'TEMPLATE_APPLY_UNCONFIRMED' } });

      const after = await moduleOf(A);
      // The same row: identity, and agents' progress by module code, kept (invariant §4).
      expect(String(after!._id)).toBe(String(before!._id));
      expect(after!.companyContent.files[0].storageKey).toBe(file.storageKey);
      expect(await col('trainingProgress').countDocuments({ _id: progressId, deletedAt: null })).toBe(1);
      expect((await col('kpms').findOne({ _id: new mongoose.Types.ObjectId(A) }))!.seededFrom.training_taxonomy)
        .toEqual({ templateId, version: 2 });
      // A new configuration version, its origin the push.
      const [snapshot] = await col('configSnapshots').find({ kpmId: A }).sort({ version: -1 }).limit(1).toArray();
      expect(snapshot).toMatchObject({ version: 2, origin: { source: 'template_push', templateId, templateVersions: { training_taxonomy: 2 }, pushedBy: 'root' } });
      // Audited in the KPM's scope and once in the platform's.
      expect(await col('auditLog').countDocuments({ action: 'company_template.applied', kpmId: A })).toBe(1);
      expect(await col('auditLog').countDocuments({ action: 'company_template.applied', kpmId: null })).toBe(1);
      // The Owner told in-app.
      expect(wired.sentNotifications).toEqual([expect.objectContaining({
        userId: 'owner-0417', kpmId: A, templateId: 'template.applied',
        payload: { templateName: 'Prudential template', kinds: ['training_taxonomy'], awaitingPublish: false },
      })]);
      // Nothing written for the refused KPM.
      expect((await col('kpms').findOne({ _id: new mongoose.Types.ObjectId(B) }))!.seededFrom.training_taxonomy.version).toBe(1);
      expect(await col('configSnapshots').countDocuments({ kpmId: B })).toBe(1);
    });

    it('P19.4-T1 AC-8 a changed KPM alone and unconfirmed is 409 TEMPLATE_APPLY_UNCONFIRMED, naming it, and nothing is written', async () => {
      await publishMaterial();
      await bWithOwnMaterial();
      await expect(wired.templatePush.apply(sa, COMPANY, templateId, { kinds: ['training_taxonomy'], kpmIds: [B] }))
        .rejects.toMatchObject({ code: 'TEMPLATE_APPLY_UNCONFIRMED', status: 409, details: { codes: ['0555'], kpmIds: [B] } });
      expect(await col('auditLog').countDocuments({ action: 'company_template.applied' })).toBe(0);
      expect(english(TEMPLATE_PUSH_REFUSALS.TEMPLATE_APPLY_UNCONFIRMED.unconfirmed({ codes: ['0555'] }))).toContain('KPM 0555');
    });

    it('P19.4-T1 AC-8 confirmed a second time, the template’s material replaces the KPM’s own, which stays readable in history', async () => {
      const file = await publishMaterial();
      const own = await bWithOwnMaterial();
      const answer = await wired.templatePush.apply(sa, COMPANY, templateId, {
        kinds: ['training_taxonomy'], kpmIds: [B], replaceChanged: [B],
      });
      expect(answer.offices[0].results).toEqual([{ kind: 'training_taxonomy', outcome: 'applied', version: 2, replaced: true }]);
      const second = await moduleOf(B, SECOND);
      expect(second!.officeContent).toBeNull();
      expect(second!.contentHistory).toEqual([expect.objectContaining({ reason: 'template_push', templateId, by: 'root' })]);
      expect(second!.contentHistory[0].content.files[0].storageKey).toBe(own);
      expect(await col('assets').findOne({ storageKey: own })).toMatchObject({ deletedAt: null });
      expect((await moduleOf(B))!.companyContent.files[0].storageKey).toBe(file.storageKey);
      const audit = await col('auditLog').findOne({ action: 'company_template.applied', kpmId: B });
      expect(audit!.after).toMatchObject({ replacedOwnChanges: true, previousVersion: 1, version: 2 });
    });

    it('P19.4-T1 AC-6 applying a version a KPM already holds is skipped and writes nothing', async () => {
      await publishMaterial();
      await wired.templatePush.apply(sa, COMPANY, templateId, { kinds: ['training_taxonomy'], kpmIds: [A] });
      const snapshots = await col('configSnapshots').countDocuments({ kpmId: A });
      const again = await wired.templatePush.apply(sa, COMPANY, templateId, { kinds: ['training_taxonomy'], kpmIds: [A] });
      expect(again.offices[0].results).toEqual([{ kind: 'training_taxonomy', outcome: 'skipped', reason: 'current' }]);
      expect(await col('configSnapshots').countDocuments({ kpmId: A })).toBe(snapshots);
      const [row] = await wired.templatePush.standings(sa, COMPANY, templateId, ['training_taxonomy']);
      expect(row).toMatchObject({ code: '0417', state: 'current' });
    });

    it('P19.4-T1 AC-6 SA case 5: an activity type added to the template reaches the untouched KPM; the KPM that changed it is listed with its own', async () => {
      const taxonomy = (await wired.templateService.read(COMPANY, 'activity_taxonomy', templateId)).payload as {
        categories: { code: string }[]; types: Record<string, unknown>[];
      };
      const category = taxonomy.categories[0].code;
      await wired.templateService.saveDraft(sa, COMPANY, 'activity_taxonomy', {
        ...taxonomy,
        types: [...taxonomy.types, { code: 'COFFEE_MEETING', categoryCode: category, label: 'Ngopi dengan klien', displayOrder: 99 }],
      }, templateId);
      await wired.templateService.publish(sa, COMPANY, 'activity_taxonomy', templateId);
      // B added a type of its own.
      await col('activityTypes').insertOne({
        kpmId: B, code: 'B_OWN', categoryCode: category, label: 'Milik B', displayOrder: 50, version: 1,
        status: 'active', archivedAt: null, deletedAt: null,
      });

      const rows = await wired.templatePush.standings(sa, COMPANY, templateId, ['activity_taxonomy']);
      expect(rows.find((r) => r.code === '0417')!.state).toBe('unchanged');
      expect(rows.find((r) => r.code === '0555')!.kinds[0].differences).toEqual([{ level: 'types', code: 'B_OWN', change: 'added' }]);

      await wired.templatePush.apply(sa, COMPANY, templateId, { kinds: ['activity_taxonomy'], kpmIds: [A] });
      expect(await col('activityTypes').findOne({ kpmId: A, code: 'COFFEE_MEETING', deletedAt: null }))
        .toMatchObject({ status: 'active', label: 'Ngopi dengan klien' });
      // A KPM's own type is archived by a confirmed push, never removed (invariant §3).
      await wired.templatePush.apply(sa, COMPANY, templateId, { kinds: ['activity_taxonomy'], kpmIds: [B], replaceChanged: [B] });
      expect(await col('activityTypes').findOne({ kpmId: B, code: 'B_OWN' })).toMatchObject({ status: 'archived', version: 2 });
      expect(await col('activityTypes').findOne({ kpmId: B, code: 'COFFEE_MEETING' })).toMatchObject({ status: 'active' });
    });

    it('P19.8-T4 AC-13 MOB UI-180 the Super Admin edits a type’s short name in the template; the push carries it, and a type without the key keeps the seed’s', async () => {
      const taxonomy = (await wired.templateService.read(COMPANY, 'activity_taxonomy', templateId)).payload as {
        categories: { code: string }[]; types: Record<string, unknown>[];
      };
      // The office was given the seed's short names with its template.
      expect(await col('activityTypes').findOne({ kpmId: A, code: 'SELL_FOLLOWUP', deletedAt: null }))
        .toMatchObject({ shortLabel: 'Follow up' });

      // Past the bound, the draft is refused as an office's own write is, and nothing is saved.
      const tooLong = { ...taxonomy, types: taxonomy.types.map((t) => (t.code === 'SELL_PRESENTATION' ? { ...t, shortLabel: 'x'.repeat(21) } : t)) };
      const refused = await wired.templateService.saveDraft(sa, COMPANY, 'activity_taxonomy', tooLong, templateId).catch((e) => e);
      expect(refused).toMatchObject({ code: 'VALIDATION_FAILED', details: { field: 'shortLabel', code: 'SELL_PRESENTATION' } });
      expect(english(refused.sentence)).toMatch(/SELL_PRESENTATION: the short name must be text of at most 20 characters/);

      // One edited; every other type without the key, as a template published before the field holds them.
      const edited = {
        ...taxonomy,
        types: taxonomy.types.map(({ shortLabel: _old, ...t }) => (t.code === 'SELL_PRESENTATION' ? { ...t, shortLabel: 'Pres. jual' } : t)),
      };
      await wired.templateService.saveDraft(sa, COMPANY, 'activity_taxonomy', edited, templateId);
      await wired.templateService.publish(sa, COMPANY, 'activity_taxonomy', templateId);

      const [standing] = (await wired.templatePush.standings(sa, COMPANY, templateId, ['activity_taxonomy'])).filter((r) => r.code === '0417');
      expect(standing.state).toBe('unchanged');
      await wired.templatePush.apply(sa, COMPANY, templateId, { kinds: ['activity_taxonomy'], kpmIds: [A] });
      expect(await col('activityTypes').findOne({ kpmId: A, code: 'SELL_PRESENTATION', deletedAt: null }))
        .toMatchObject({ shortLabel: 'Pres. jual', version: 2 });
      // Never wiped: the type without the key gives the seed's words, which the office already holds — no version moves.
      expect(await col('activityTypes').findOne({ kpmId: A, code: 'SELL_FOLLOWUP', deletedAt: null }))
        .toMatchObject({ shortLabel: 'Follow up', version: 1 });
    });

    it('P19.4-T1 AC-6 every section applied to an untouched KPM leaves it current on every one, its rows matching the template’s', async () => {
      // A second version of each kind: the same payload, published again.
      for (const kind of OFFICE_TEMPLATE_KINDS) {
        const now = (await wired.templateService.read(COMPANY, kind, templateId)).payload;
        await wired.templateService.saveDraft(sa, COMPANY, kind, now, templateId);
        await wired.templateService.publish(sa, COMPANY, kind, templateId);
      }
      const answer = await wired.templatePush.apply(sa, COMPANY, templateId, { kinds: [...OFFICE_TEMPLATE_KINDS], kpmIds: [A] });
      expect(answer.offices[0].results.map((r) => r.outcome)).toEqual(Array(7).fill('applied'));
      const [row] = (await wired.templatePush.standings(sa, COMPANY, templateId, [OFFICE_TEMPLATE_KINDS.join(',')]))
        .filter((r) => r.code === '0417');
      expect(row.kinds.map((k) => [k.kind, k.state])).toEqual(
        ['activity_taxonomy', 'ratio_set', 'lead_pipeline', 'training_taxonomy', 'activation_checklist', 'capability_ladder', 'event_types']
          .map((k) => [k, 'current']),
      );
      // Nothing an Owner edits moved: the same payload writes no row version.
      expect(await col('activityTypes').countDocuments({ kpmId: A, version: { $gt: 1 } })).toBe(0);
    });

    it('P19.4-T1 AC-6 a KPM with changes of its own waiting gets the rows, and they wait with its own for its publish', async () => {
      await publishMaterial();
      await col('trainingModules').updateOne({ kpmId: A, code: SECOND }, { $set: { title: 'Belum terbit' }, $inc: { version: 1 } });
      // Retitled and not published: a change of the KPM's own, so it is confirmed.
      const answer = await wired.templatePush.apply(sa, COMPANY, templateId, {
        kinds: ['training_taxonomy'], kpmIds: [A], replaceChanged: [A],
      });
      expect(answer.offices[0]).toMatchObject({ awaitingPublish: true });
      expect(await col('configSnapshots').countDocuments({ kpmId: A })).toBe(1);
      expect(wired.sentNotifications[0]).toMatchObject({ payload: { awaitingPublish: true } });
    });

    it('P19.4-T1 AC-10 reaches only KPMs of the template’s own company: another company’s is 404 and nothing is written', async () => {
      await publishMaterial();
      await expect(wired.templatePush.apply(sa, COMPANY, templateId, { kinds: ['training_taxonomy'], kpmIds: [A, C] }))
        .rejects.toMatchObject({ code: 'NOT_FOUND', status: 404 });
      expect(await col('auditLog').countDocuments({ action: 'company_template.applied' })).toBe(0);
      await expect(wired.templatePush.standings(sa, COMPANY, otherTemplateId, ['training_taxonomy']))
        .rejects.toMatchObject({ status: 404 });
    });

    it('P19.4-T1 AC-6 refuses nothing to apply, an unknown section, one never published, and a built-in template', async () => {
      await expect(wired.templatePush.apply(sa, COMPANY, templateId, { kinds: [], kpmIds: [A] }))
        .rejects.toMatchObject({ code: 'VALIDATION_FAILED', status: 400 });
      await expect(wired.templatePush.apply(sa, COMPANY, templateId, { kinds: ['campaign_kinds'], kpmIds: [A] }))
        .rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
      const blank = await wired.namedTemplates.create(sa, COMPANY, { name: 'Kosong', from: 'empty' });
      await expect(wired.templatePush.apply(sa, COMPANY, blank.id, { kinds: ['training_taxonomy'], kpmIds: [A] }))
        .rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
      const companies = wired.companies as unknown as mongoose.Model<never>;
      const library = await companies.create({ _id: LIBRARY, name: 'Template', slug: 'template', kind: 'template' } as never);
      const builtIn = String((await wired.namedTemplates.createFirst(sa, library as never))._id);
      await expect(wired.templatePush.apply(sa, LIBRARY, builtIn, { kinds: ['training_taxonomy'], kpmIds: [A] }))
        .rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
      expect(english(TEMPLATE_PUSH_REFUSALS.VALIDATION_FAILED.builtInReachesNobody)).toMatch(/built-in/);
    });

    /** One kind published again, the same payload: version 2 for a template made by `createFirst`. */
    async function republish(kind: (typeof OFFICE_TEMPLATE_KINDS)[number]): Promise<void> {
      const now = (await wired.templateService.read(COMPANY, kind, templateId)).payload;
      await wired.templateService.saveDraft(sa, COMPANY, kind, now, templateId);
      await wired.templateService.publish(sa, COMPANY, kind, templateId);
    }
    const kpmRow = (id: string) => ({ _id: new mongoose.Types.ObjectId(id) });

    it('ADR-0214 §1 refuses Advanced analytics in a push, a push naming no KPM, and an archived template, writing nothing', async () => {
      await expect(wired.templatePush.apply(sa, COMPANY, templateId, { kinds: ['advanced_analytics'], kpmIds: [A] }))
        .rejects.toMatchObject({ code: 'VALIDATION_FAILED', status: 400 });
      await expect(wired.templatePush.apply(sa, COMPANY, templateId, { kinds: ['training_taxonomy'] } as never))
        .rejects.toMatchObject({ code: 'VALIDATION_FAILED', status: 400 });
      const old = await wired.namedTemplates.create(sa, COMPANY, { name: 'Lama', from: 'empty' });
      await wired.namedTemplates.archive(sa, COMPANY, old.id);
      await expect(wired.templatePush.apply(sa, COMPANY, old.id, { kinds: ['training_taxonomy'], kpmIds: [A] }))
        .rejects.toMatchObject({ code: 'VALIDATION_FAILED', status: 400 });
      expect(await col('auditLog').countDocuments({ action: 'company_template.applied' })).toBe(0);
    });

    it('P19.4-T1 AC-7 a KPM made when the template held none of a section added every item; one recorded from another template is read against the previous version', async () => {
      await republish('event_types');
      await col('kpms').updateOne(kpmRow(A), { $set: { 'seededFrom.event_types': { templateId, version: null } } });
      await col('kpms').updateOne(kpmRow(B), { $set: { 'seededFrom.event_types': { templateId: otherTemplateId, version: 1 } } });
      const rows = await wired.templatePush.standings(sa, COMPANY, templateId, ['event_types']);
      const a = rows.find((r) => r.code === '0417')!.kinds[0];
      expect(a).toMatchObject({ kind: 'event_types', state: 'changed', givenVersion: null, newestVersion: 2 });
      expect(a.differences.map((d) => d.change)).toEqual(Array(5).fill('added'));
      // Version 1 is the template's previous: B holds it untouched, so it is unchanged, though no record says so.
      expect(rows.find((r) => r.code === '0555')!.kinds[0]).toMatchObject({ state: 'unchanged', givenVersion: null, differences: [] });
    });

    it('P19.4-T1 AC-6 a KPM holding no binding, no published checklist and no capability catalogue is given the template’s, created', async () => {
      for (const kind of ['activity_taxonomy', 'activation_checklist', 'capability_ladder'] as const) await republish(kind);
      // An office made before each existed: nothing to match by code.
      await col('activityBindings').deleteMany({ kpmId: A });
      await col('activationTemplates').deleteMany({ kpmId: A });
      await col('capabilityCatalogs').deleteMany({ kpmId: A });
      const [before] = (await wired.templatePush.standings(sa, COMPANY, templateId, ['activation_checklist', 'capability_ladder']))
        .filter((r) => r.code === '0417');
      expect(before.kinds.map((k) => [k.kind, k.state])).toEqual([['activation_checklist', 'changed'], ['capability_ladder', 'changed']]);
      expect(before.kinds.every((k) => k.differences.every((d) => d.change === 'removed'))).toBe(true);

      const answer = await wired.templatePush.apply(sa, COMPANY, templateId, {
        kinds: ['activity_taxonomy', 'activation_checklist', 'capability_ladder'], kpmIds: [A], replaceChanged: [A],
      });
      expect(answer.offices[0].results.map((r) => r.outcome)).toEqual(['applied', 'applied', 'applied']);
      expect(await col('activityBindings').countDocuments({ kpmId: A, status: 'active', deletedAt: null })).toBe(1);
      expect(await col('activationTemplates').findOne({ kpmId: A, deletedAt: null }))
        .toMatchObject({ status: 'published', version: 1, origin: { source: 'template_push' } });
      expect(await col('capabilityCatalogs').countDocuments({ kpmId: A, deletedAt: null })).toBe(1);
      const [after] = (await wired.templatePush.standings(sa, COMPANY, templateId, ['activation_checklist', 'capability_ladder']))
        .filter((r) => r.code === '0417');
      expect(after.state).toBe('current');
    });

    it('ADR-0208 §5 a push brings back a row the KPM archived and puts a reordered one back, moving no version for the reorder', async () => {
      await republish('event_types');
      const [first, second] = await col('eventTypes').find({ kpmId: A, deletedAt: null }).sort({ displayOrder: 1 }).toArray();
      // Reordered, and stored with no description at all: neither is a change of anything an Owner edits.
      await col('eventTypes').updateOne({ _id: first._id }, { $set: { displayOrder: 99 }, $unset: { description: '' } });
      await col('eventTypes').updateOne({ _id: second._id }, { $set: { status: 'archived', archivedAt: NOW }, $inc: { version: 1 } });
      const answer = await wired.templatePush.apply(sa, COMPANY, templateId, { kinds: ['event_types'], kpmIds: [A], replaceChanged: [A] });
      expect(answer.offices[0].results).toEqual([{ kind: 'event_types', outcome: 'applied', version: 2, replaced: false }]);
      expect(await col('eventTypes').findOne({ _id: first._id }))
        .toMatchObject({ displayOrder: first.displayOrder, version: first.version, status: 'active' });
      expect(await col('eventTypes').findOne({ _id: second._id }))
        .toMatchObject({ status: 'active', archivedAt: null, version: second.version + 2 });
    });

    it('ADR-0208 §5 the checklist: a link to a module the KPM no longer offers is refused for it; a KPM’s draft keeps waiting, a version on', async () => {
      const checklist = (await wired.templateService.read(COMPANY, 'activation_checklist', templateId)).payload as {
        aspects: { items: Record<string, unknown>[] }[];
      };
      checklist.aspects[0].items[0] = { ...checklist.aspects[0].items[0], autoLink: `training:${MODULE}` };
      await wired.templateService.saveDraft(sa, COMPANY, 'activation_checklist', checklist, templateId);
      await wired.templateService.publish(sa, COMPANY, 'activation_checklist', templateId);
      // A archived the module the new link names.
      await col('trainingModules').updateOne({ kpmId: A, code: MODULE }, { $set: { status: 'archived' } });
      // B holds a draft of its own, one version past its published checklist.
      const held = (await col('activationTemplates').findOne({ kpmId: B, status: 'published', deletedAt: null }))!;
      const { _id: _held, ...rest } = held;
      await col('activationTemplates').insertOne({ ...rest, status: 'draft', version: held.version + 1, publishedAt: null });

      const answer = await wired.templatePush.apply(sa, COMPANY, templateId, { kinds: ['activation_checklist'], kpmIds: [A, B] });
      const [a, b] = answer.offices;
      expect(a.results[0]).toMatchObject({ outcome: 'refused', error: { code: 'VALIDATION_FAILED', message: expect.stringContaining(MODULE) } });
      expect(b.results[0]).toMatchObject({ outcome: 'applied', version: 2 });
      const rows = await col('activationTemplates').find({ kpmId: B, deletedAt: null }).sort({ version: 1 }).toArray();
      expect(rows.map((r) => [r.status, r.version])).toEqual([['published', 1], ['published', 2], ['draft', 3]]);
      expect(rows[1].aspects[0].items[0].autoLink).toBe(`training:${MODULE}`);
      expect(await col('activationTemplates').countDocuments({ kpmId: A, deletedAt: null })).toBe(1);
    });

    it('ADR-0208 §5 the ladder and the binding, matched by code: a deleted row comes back, the KPM’s own is archived, a changed binding is restored', async () => {
      for (const kind of ['activity_taxonomy', 'capability_ladder'] as const) await republish(kind);
      const catalog = (await col('capabilityCatalogs').findOne({ kpmId: A, deletedAt: null }))!;
      const [gone, ...milestones] = catalog.milestones as { code: string }[];
      await col('capabilityCatalogs').updateOne({ _id: catalog._id }, { $set: {
        milestones,
        stages: [...catalog.stages, { code: 'KPM_OWN', label: 'Milik KPM', requiredMilestoneCodes: [], stageOrder: 99, displayOrder: 99, status: 'active' }],
      } });
      const binding = (await col('activityBindings').findOne({ kpmId: B, status: 'active', deletedAt: null }))!;
      await col('activityBindings').updateOne({ kpmId: A, status: 'active' }, { $set: { leads: [...binding.leads, ...binding.closings] } });

      const answer = await wired.templatePush.apply(sa, COMPANY, templateId, {
        kinds: ['activity_taxonomy', 'capability_ladder'], kpmIds: [A], replaceChanged: [A],
      });
      expect(answer.offices[0].results.map((r) => r.outcome)).toEqual(['applied', 'applied']);
      const after = (await col('capabilityCatalogs').findOne({ kpmId: A, deletedAt: null }))!;
      expect(after.version).toBe(catalog.version + 1);
      expect(after.milestones.find((m: { code: string }) => m.code === gone.code)).toMatchObject({ status: 'active' });
      expect(after.stages.find((st: { code: string }) => st.code === 'KPM_OWN')).toMatchObject({ status: 'archived' });
      expect(await col('activityBindings').findOne({ kpmId: A, status: 'active', deletedAt: null }))
        .toMatchObject({ leads: binding.leads, appointments: binding.appointments, closings: binding.closings, version: 2 });
    });

    it('P19.4-T1 AC-6 a section a KPM cannot take is refused for it, and its later sections say why they were not applied', async () => {
      const ratios = (await wired.templateService.read(COMPANY, 'ratio_set', templateId)).payload as { ratios: { numerator: string[] }[] };
      await col('activityTypes').updateMany({ kpmId: A, code: ratios.ratios[0].numerator[0] }, { $set: { status: 'archived' } });
      for (const kind of ['ratio_set', 'event_types'] as const) {
        const now = (await wired.templateService.read(COMPANY, kind, templateId)).payload;
        await wired.templateService.saveDraft(sa, COMPANY, kind, now, templateId);
        await wired.templateService.publish(sa, COMPANY, kind, templateId);
      }
      const answer = await wired.templatePush.apply(sa, COMPANY, templateId, {
        kinds: ['ratio_set', 'event_types'], kpmIds: [A], replaceChanged: [A],
      });
      expect(answer.offices[0].results.map((r) => r.outcome)).toEqual(['refused', 'refused']);
      expect(answer.offices[0].results[1]).toMatchObject({ error: { code: 'VALIDATION_FAILED' } });
    });
  });
});
