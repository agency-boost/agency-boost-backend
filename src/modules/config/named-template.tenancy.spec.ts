import mongoose from 'mongoose';
import { RequestContext } from '@/common/context/request-context';
import { SEED_ACTIVITY_TYPES } from '@/domain/constants';
import { clearCollections, startMongo, stopMongo } from '../../../test/mongo';
import { configModule, provisionFrom } from '../../../test/config-module';
import { NAMED_TEMPLATE_KINDS, OFFICE_TEMPLATE_KINDS, platformDefaultPayload } from './template-defaults';

const NOW = new Date('2026-10-07T03:00:00Z');
const COMPANY = '66f0000000000000000000c1';
const BLANK = '66f0000000000000000000c3';
const sa = RequestContext.platform('root');
const col = (name: string) => mongoose.connection.db!.collection(name);

/**
 * **A company's named templates** (ADR-0115 §3, §5; P13.2-T6 AC-5, AC-6): one name over seven kinds, one
 * default, archived never deleted, every write audited — and each template's kinds its own.
 */
describe('named templates (P13.2-T6)', () => {
  let wired: ReturnType<typeof configModule>;
  let defaultId: string;

  beforeAll(async () => {
    await startMongo();
    wired = configModule(NOW);
  });
  afterAll(stopMongo);

  beforeEach(async () => {
    await clearCollections();
    const companies = wired.companies as unknown as mongoose.Model<never>;
    const prudential = await companies.create({ _id: COMPANY, name: 'Prudential', slug: 'prudential' } as never);
    const blank = await companies.create({
      _id: BLANK, name: 'Blank Co', slug: 'blank-co', usesPlatformDefaults: false,
    } as never);
    defaultId = String((await wired.namedTemplates.createFirst(sa, prudential as never))._id);
    await wired.namedTemplates.createFirst(sa, blank as never);
  });

  const audit = (action: string) => col('auditLog').find({ action }).toArray();

  describe('a company’s first template (ADR-0115 §1, §3)', () => {
    it('is the defaults, each kind a published version 1, for a company that took them', async () => {
      const [first] = await wired.namedTemplates.list(COMPANY);
      expect(first).toMatchObject({
        name: 'Prudential template', isDefault: true, status: 'active', origin: { kind: 'defaults' },
      });
      expect(first.publishedVersions).toEqual(Object.fromEntries(NAMED_TEMPLATE_KINDS.map((k) => [k, 1])));
      for (const kind of OFFICE_TEMPLATE_KINDS) {
        expect((await wired.templateService.read(COMPANY, kind)).payload).toEqual(platformDefaultPayload(kind));
      }
      expect(await audit('template.created')).toHaveLength(2);
    });

    it('holds nothing for a company created blank — the switch’s sentence, now true', async () => {
      const [first] = await wired.namedTemplates.list(BLANK);
      expect(first).toMatchObject({ name: 'Blank Co template', isDefault: true, origin: { kind: 'empty' } });
      // P19.5-T1 (ADR-0214 §9): every kind empty but *Advanced analytics*, whose four system columns are never missing.
      expect(Object.values(first.publishedVersions)).toEqual([...Array(8).fill(null), 1, null]); // P19.6-T1: *Tampilan* empty too
      expect(await col('companyTemplates').countDocuments({ companyId: BLANK })).toBe(1);
    });
  });

  describe('AC-5: names, the default, archiving', () => {
    it('makes an empty template and one from the defaults, neither the default', async () => {
      const empty = await wired.namedTemplates.create(sa, COMPANY, { name: 'Empty one', from: 'empty' });
      const full = await wired.namedTemplates.create(sa, COMPANY, { name: '  Full   one ', from: 'defaults' });
      expect(empty).toMatchObject({ isDefault: false, origin: { kind: 'empty' } });
      // P19.5-T1 (ADR-0214 §9): *Kosong* holds the platform's *Advanced analytics* version 1, and nothing else.
      expect(Object.values(empty.publishedVersions)).toEqual([...Array(8).fill(null), 1, null]); // P19.6-T1: *Tampilan* empty too
      // The name is trimmed and its inner spaces collapsed.
      expect(full).toMatchObject({ name: 'Full one', origin: { kind: 'defaults' } });
      expect(Object.values(full.publishedVersions)).toEqual(Array(10).fill(1)); // and *Tampilan* (P19.6-T1)
      expect((await audit('template.created')).map((r) => r.after.from)).toEqual(['defaults', 'empty', 'empty', 'defaults']);
    });

    it('refuses a name an active template of the company has, ignoring case; another company may use it', async () => {
      await expect(wired.namedTemplates.create(sa, COMPANY, { name: 'PRUDENTIAL Template', from: 'empty' }))
        .rejects.toMatchObject({ code: 'TEMPLATE_NAME_TAKEN', status: 409 });
      const other = await wired.namedTemplates.create(sa, COMPANY, { name: 'Other', from: 'empty' });
      await expect(wired.namedTemplates.update(sa, COMPANY, other.id, { name: 'prudential template' }))
        .rejects.toMatchObject({ code: 'TEMPLATE_NAME_TAKEN' });
      await expect(wired.namedTemplates.create(sa, BLANK, { name: 'Prudential template', from: 'empty' }))
        .resolves.toMatchObject({ name: 'Prudential template' });
    });

    /*
     * *Changed 2026-11-05 (P19.4-T3 AC-12; SA UI-017):* an archived template's name was freed for reuse (ADR-0115 §3), and
     * Manulife ended with two *"Manulife template"*. Names are unique within the company, archived ones included.
     */
    it('P19.4-T3 AC-12 keeps an archived template’s name: a new template, a rename and the archived one’s own rename are refused', async () => {
      const old = await wired.namedTemplates.create(sa, COMPANY, { name: 'Jakarta', from: 'empty' });
      await wired.namedTemplates.archive(sa, COMPANY, old.id);
      await expect(wired.namedTemplates.create(sa, COMPANY, { name: 'jakarta', from: 'empty' }))
        .rejects.toMatchObject({ code: 'TEMPLATE_NAME_TAKEN', status: 409, details: { name: 'jakarta', archived: true } });
      const other = await wired.namedTemplates.create(sa, COMPANY, { name: 'Other', from: 'empty' });
      await expect(wired.namedTemplates.update(sa, COMPANY, other.id, { name: 'JAKARTA' }))
        .rejects.toMatchObject({ code: 'TEMPLATE_NAME_TAKEN' });
      // The archived template is renamed under the same rule — not onto an active one's name.
      await expect(wired.namedTemplates.update(sa, COMPANY, old.id, { name: 'Other' }))
        .rejects.toMatchObject({ code: 'TEMPLATE_NAME_TAKEN', details: { archived: false } });
      // Another company may use it, and nothing was written by a refusal.
      await expect(wired.namedTemplates.create(sa, BLANK, { name: 'Jakarta', from: 'empty' })).resolves.toBeTruthy();
      expect((await wired.namedTemplates.list(COMPANY)).map((t) => t.name).sort())
        .toEqual(['Jakarta', 'Other', 'Prudential template']);
    });

    it('renames with an audit row naming both', async () => {

      await wired.namedTemplates.update(sa, COMPANY, defaultId, { name: 'Prudential — Jabodetabek' });
      expect(await audit('template.renamed')).toEqual([expect.objectContaining({
        before: { name: 'Prudential template' }, after: { companyId: COMPANY, name: 'Prudential — Jabodetabek' },
        targetCollection: 'templates', targetId: defaultId,
      })]);
    });

    it('keeps exactly one default: Make default moves it, and un-defaulting the default is refused', async () => {
      const other = await wired.namedTemplates.create(sa, COMPANY, { name: 'Other', from: 'empty' });
      await expect(wired.namedTemplates.update(sa, COMPANY, defaultId, { isDefault: false }))
        .rejects.toMatchObject({ code: 'TEMPLATE_IS_DEFAULT', status: 409 });

      await wired.namedTemplates.update(sa, COMPANY, other.id, { isDefault: true });
      const list = await wired.namedTemplates.list(COMPANY);
      expect(list.filter((t) => t.isDefault).map((t) => t.id)).toEqual([other.id]);
      expect(String((await wired.namedTemplates.resolve(COMPANY))._id)).toBe(other.id);
      expect(await audit('template.default_changed')).toEqual([expect.objectContaining({
        before: { defaultTemplateId: defaultId }, after: expect.objectContaining({ defaultTemplateId: other.id }),
      })]);
    });

    it('never archives the default, keeps an archived template readable, and offers it nowhere to write', async () => {
      await expect(wired.namedTemplates.archive(sa, COMPANY, defaultId))
        .rejects.toMatchObject({ code: 'TEMPLATE_IS_DEFAULT', status: 409 });

      const old = await wired.namedTemplates.create(sa, COMPANY, { name: 'Old', from: 'defaults' });
      const archived = await wired.namedTemplates.archive(sa, COMPANY, old.id);
      expect(archived).toMatchObject({ status: 'archived', archivedAt: NOW.toISOString() });
      // A second archive changes nothing and writes no second row.
      await wired.namedTemplates.archive(sa, COMPANY, old.id);
      expect(await audit('template.archived')).toHaveLength(1);

      // Still read, kinds and all; not written; not made the default; not a source.
      expect((await wired.templateService.read(COMPANY, 'activity_taxonomy', old.id)).version).toBe(1);
      await expect(wired.templateService.saveDraft(sa, COMPANY, 'event_types', { types: [] }, old.id))
        .rejects.toThrow(/archived/);
      await expect(wired.namedTemplates.update(sa, COMPANY, old.id, { isDefault: true })).rejects.toThrow(/archived/);
      await expect(wired.provisioning.planFor(COMPANY, { kind: 'template', templateId: old.id }))
        .rejects.toThrow(/archived/);
      expect((await wired.namedTemplates.list(COMPANY)).map((t) => [t.name, t.status]))
        .toEqual([['Prudential template', 'active'], ['Old', 'archived']]);
    });

    it('answers 404 for a template of another company, and for an id that is not one', async () => {
      const theirs = String((await wired.namedTemplates.resolve(BLANK))._id);
      await expect(wired.namedTemplates.update(sa, COMPANY, theirs, { name: 'x' })).rejects.toMatchObject({ status: 404 });
      await expect(wired.templateService.read(COMPANY, 'event_types', theirs)).rejects.toMatchObject({ status: 404 });
      await expect(wired.namedTemplates.archive(sa, COMPANY, 'nope')).rejects.toMatchObject({ status: 404 });
      await expect(wired.namedTemplates.list('66f0000000000000000000ff')).rejects.toMatchObject({ status: 404 });
    });
  });

  describe('AC-6: each template’s kinds are its own', () => {
    it('drafts, publishes and keeps history per template; campaign kinds are the company’s', async () => {
      const second = await wired.namedTemplates.create(sa, COMPANY, { name: 'Second', from: 'empty' });
      const types = { types: [{ code: 'TOWN_HALL', label: 'Town hall', emoji: '📣', color: '#2D9CDB' }] };
      await wired.templateService.saveDraft(sa, COMPANY, 'event_types', types, second.id);
      const published = await wired.templateService.publish(sa, COMPANY, 'event_types', second.id);
      expect(published).toMatchObject({ templateId: second.id, version: 1, status: 'published' });

      // The default's event types are where they were: its own version 1, the defaults.
      expect((await wired.templateService.read(COMPANY, 'event_types')).payload).toEqual(platformDefaultPayload('event_types'));
      expect((await wired.templateService.history(COMPANY, 'event_types', second.id)).map((h) => h.version)).toEqual([1]);
      // Its event types and the *Advanced analytics* version 1 every template is made with (ADR-0214 §9).
      expect(await col('companyTemplates').countDocuments({ companyId: COMPANY, templateId: second.id })).toBe(2);

      // Campaign kinds hang under no template, whichever is named.
      const campaigns = await wired.templateService.read(COMPANY, 'campaign_kinds', second.id);
      expect(campaigns.templateId).toBeNull();
    });

    it('counts offices per template: started from it, and none from the defaults or Empty', async () => {
      const second = await wired.namedTemplates.create(sa, COMPANY, { name: 'Second', from: 'defaults' });
      const kpms = wired.kpms as unknown as mongoose.Model<never>;
      const office = async (code: string, startFrom: { kind: 'template' | 'defaults' | 'empty'; templateId?: string }) => {
        const _id = new mongoose.Types.ObjectId();
        const plan = await wired.provisioning.planFor(COMPANY, startFrom);
        await kpms.create({ _id, companyId: COMPANY, code, branchName: code, startedFrom: plan.startedFrom } as never);
        const done = await provisionFrom(wired, String(_id), COMPANY, startFrom);
        await kpms.updateOne({ _id } as never, { $set: { seededFrom: done.seededFrom } } as never);
      };
      await office('A1', { kind: 'template', templateId: second.id });
      await office('A2', { kind: 'template', templateId: second.id });
      await office('B1', { kind: 'template', templateId: defaultId });
      await office('C1', { kind: 'defaults' });
      await office('D1', { kind: 'empty' });

      const counts = Object.fromEntries((await wired.namedTemplates.list(COMPANY)).map((t) => [t.name, t.officeCount]));
      expect(counts).toEqual({ 'Prudential template': 1, Second: 2 });

      // And a new version of a kind puts only that template's offices behind.
      const taxonomy = (await wired.templateService.read(COMPANY, 'activity_taxonomy', second.id)).payload;
      await wired.templateService.saveDraft(sa, COMPANY, 'activity_taxonomy', taxonomy, second.id);
      const v2 = await wired.templateService.publish(sa, COMPANY, 'activity_taxonomy', second.id);
      expect([v2.version, v2.officesBehind]).toEqual([2, 2]);
      expect((await wired.templateService.read(COMPANY, 'activity_taxonomy')).officesBehind).toBe(0);
    });
  });

  /**
   * **Exit review of P13.2, findings 3–5 and N3** — the writes that could leave a company with two
   * defaults, none, or an archived one; a refusal that came after a write; a template written before
   * its kinds; and the service's own permission check.
   */
  describe('exit review: writes that race, refuse or fail', () => {
    const Rows = () => wired.namedTemplateRows as unknown as mongoose.Model<never>;
    const defaults = async () => col('templates').find({ companyId: COMPANY, isDefault: true, deletedAt: null }).toArray();
    const duplicateOn = (key: Record<string, number>) => Object.assign(
      new Error(`E11000 duplicate key error collection: templates index: ${Object.keys(key).join('_')}`),
      { code: 11000, keyPattern: key },
    );
    /** `updateOne` passed through, but for the `n`th call, which runs `instead`. */
    const onUpdate = (n: number, instead: (real: () => Promise<unknown>) => Promise<unknown>) => {
      const model = Rows();
      const real = model.updateOne.bind(model) as (...args: unknown[]) => { exec(): Promise<unknown> };
      let calls = 0;
      return jest.spyOn(model, 'updateOne').mockImplementation(((...args: unknown[]) => {
        calls += 1;
        return calls === n ? { exec: () => instead(() => real(...args).exec()) } : real(...args);
      }) as never);
    };
    afterEach(() => jest.restoreAllMocks());

    it('finding 3: two Make defaults at once leave exactly one default, and the loser a 409 — never a 500', async () => {
      const a = await wired.namedTemplates.create(sa, COMPANY, { name: 'A', from: 'empty' });
      const b = await wired.namedTemplates.create(sa, COMPANY, { name: 'B', from: 'empty' });
      const results = await Promise.allSettled([
        wired.namedTemplates.update(sa, COMPANY, a.id, { isDefault: true }),
        wired.namedTemplates.update(sa, COMPANY, b.id, { isDefault: true }),
      ]);
      for (const r of results) {
        if (r.status === 'rejected') expect(r.reason).toMatchObject({ code: 'VERSION_CONFLICT', status: 409 });
      }
      const now = await defaults();
      expect(now).toHaveLength(1);
      const won = results.flatMap((r) => (r.status === 'fulfilled' ? [r.value.id] : []));
      expect(won).toContain(String(now[0]._id));
    });

    it('finding 3: a default that appears between clearing and setting answers 409, and the old one stands', async () => {
      const other = await wired.namedTemplates.create(sa, COMPANY, { name: 'Other', from: 'empty' });
      // The second write — setting this one — meets the one-default index.
      onUpdate(2, () => Promise.reject(duplicateOn({ companyId: 1, isDefault: 1 })));
      await expect(wired.namedTemplates.update(sa, COMPANY, other.id, { isDefault: true }))
        .rejects.toMatchObject({ code: 'VERSION_CONFLICT', status: 409 });
      expect((await defaults()).map((t) => String(t._id))).toEqual([defaultId]);
      expect(await audit('template.default_changed')).toHaveLength(0);
    });

    it('finding 3: any failure after the old default was cleared puts it back', async () => {
      const other = await wired.namedTemplates.create(sa, COMPANY, { name: 'Other', from: 'empty' });
      onUpdate(2, () => Promise.reject(new Error('connection reset')));
      await expect(wired.namedTemplates.update(sa, COMPANY, other.id, { isDefault: true })).rejects.toThrow('connection reset');
      expect((await defaults()).map((t) => String(t._id))).toEqual([defaultId]);
    });

    it('finding 3: an archive landing during Make default leaves it unset and the old default standing', async () => {
      const other = await wired.namedTemplates.create(sa, COMPANY, { name: 'Other', from: 'empty' });
      onUpdate(2, async (real) => {
        await col('templates').updateOne({ _id: new mongoose.Types.ObjectId(other.id) }, { $set: { status: 'archived' } });
        return real();
      });
      await expect(wired.namedTemplates.update(sa, COMPANY, other.id, { isDefault: true })).rejects.toThrow(/archived/);
      expect((await defaults()).map((t) => String(t._id))).toEqual([defaultId]);
    });

    it('finding 3: a Make default landing during Archive leaves the default unarchived, and the archive refused', async () => {
      const other = await wired.namedTemplates.create(sa, COMPANY, { name: 'Other', from: 'empty' });
      // The archive's one write: Make default lands first.
      onUpdate(1, async (real) => {
        await col('templates').updateOne({ _id: new mongoose.Types.ObjectId(defaultId) }, { $set: { isDefault: false } });
        await col('templates').updateOne({ _id: new mongoose.Types.ObjectId(other.id) }, { $set: { isDefault: true } });
        return real();
      });
      await expect(wired.namedTemplates.archive(sa, COMPANY, other.id))
        .rejects.toMatchObject({ code: 'TEMPLATE_IS_DEFAULT', status: 409 });
      expect(await col('templates').findOne({ _id: new mongoose.Types.ObjectId(other.id) }))
        .toMatchObject({ isDefault: true, status: 'active' });
      expect(await audit('template.archived')).toHaveLength(0);
    });

    it('finding 4: { name, isDefault: false } on the default is refused before anything is renamed or audited', async () => {
      await expect(wired.namedTemplates.update(sa, COMPANY, defaultId, { name: 'Renamed', isDefault: false }))
        .rejects.toMatchObject({ code: 'TEMPLATE_IS_DEFAULT', status: 409 });
      expect(await col('templates').findOne({ _id: new mongoose.Types.ObjectId(defaultId) }))
        .toMatchObject({ name: 'Prudential template' });
      expect(await audit('template.renamed')).toHaveLength(0);

      // And { name, isDefault: true } on an archived one: refused, the name kept.
      const old = await wired.namedTemplates.create(sa, COMPANY, { name: 'Old', from: 'empty' });
      await wired.namedTemplates.archive(sa, COMPANY, old.id);
      await expect(wired.namedTemplates.update(sa, COMPANY, old.id, { name: 'Revived', isDefault: true })).rejects.toThrow(/archived/);
      expect(await col('templates').findOne({ _id: new mongoose.Types.ObjectId(old.id) })).toMatchObject({ name: 'Old' });
    });

    it('finding 5: a template from the defaults is written after its kinds — a failure at the end leaves nothing', async () => {
      const rows = await col('companyTemplates').countDocuments({ companyId: COMPANY, deletedAt: null });
      const order: string[] = [];
      const kindRows = wired.templates as unknown as mongoose.Model<never>;
      const insertMany = kindRows.insertMany.bind(kindRows);
      jest.spyOn(kindRows, 'insertMany').mockImplementation(((docs: never) => { order.push('kinds'); return insertMany(docs); }) as never);
      jest.spyOn(Rows(), 'create').mockImplementationOnce((() => {
        order.push('template');
        return Promise.reject(duplicateOn({ companyId: 1, name: 1 }));
      }) as never);

      await expect(wired.namedTemplates.create(sa, COMPANY, { name: 'Raced', from: 'defaults' }))
        .rejects.toMatchObject({ code: 'TEMPLATE_NAME_TAKEN', status: 409 });
      expect(order).toEqual(['kinds', 'template']);
      expect(await col('templates').countDocuments({ companyId: COMPANY, name: 'Raced' })).toBe(0);
      expect(await col('companyTemplates').countDocuments({ companyId: COMPANY, deletedAt: null })).toBe(rows);
      expect(await audit('template.created')).toHaveLength(2);
    });

    it('N3: create, update and archive refuse anybody without company_template:write, before any write', async () => {
      const owner = new RequestContext('u-owner', 'none', {
        membershipId: 'm-owner', kpmId: '66f0000000000000000000a1', orgLevelCode: 'AB', hierarchyRole: 'ab',
        status: 'active', isKpmOwner: true, isKpmAdmin: false, directCount: 0,
      } as never);
      const refused = { code: 'PERM_DENIED', status: 403 };
      await expect(wired.namedTemplates.create(owner, COMPANY, { name: 'Mine', from: 'defaults' })).rejects.toMatchObject(refused);
      await expect(wired.namedTemplates.update(owner, COMPANY, defaultId, { name: 'Mine' })).rejects.toMatchObject(refused);
      await expect(wired.namedTemplates.archive(owner, COMPANY, defaultId)).rejects.toMatchObject(refused);
      expect(await col('templates').countDocuments({ companyId: COMPANY })).toBe(1);
      expect(await col('templates').findOne({ _id: new mongoose.Types.ObjectId(defaultId) })).toMatchObject({ name: 'Prudential template' });
    });
  });

  it('starts a template made from the defaults with the twelve activity types', async () => {
    const made = await wired.namedTemplates.create(sa, COMPANY, { name: 'Defaults', from: 'defaults' });
    const view = await wired.templateService.read(COMPANY, 'activity_taxonomy', made.id);
    expect((view.payload.types as unknown[])).toHaveLength(SEED_ACTIVITY_TYPES.length);
  });
});
