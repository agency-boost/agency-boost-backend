import mongoose from 'mongoose';
import { RequestContext } from '@/common/context/request-context';
import { SEED_TRAINING_MODULES } from '@/domain/constants';
import type { ConfigChangeDto } from '@/modules/config/changes.dto';
import { TrainingService } from './training.service';
import { clearCollections, startMongo, stopMongo } from '../../../test/mongo';
import { configModule, provisionOffice } from '../../../test/config-module';

const NOW = new Date('2026-09-17T02:00:00Z');
const KPM_A = '66f0000000000000000000a1';
const KPM_B = '66f0000000000000000000b1';
const COMPANY = '66f0000000000000000000c1';
const OTHER_COMPANY = '66f0000000000000000000c2';

function ctx(kpmId: string, opts: { admin?: boolean } = {}) {
  return new RequestContext('u1', 'none', {
    membershipId: `mem-${kpmId}`, kpmId, orgLevelCode: 'AB', hierarchyRole: 'ab', status: 'active',
    isKpmOwner: !opts.admin, isKpmAdmin: Boolean(opts.admin), directCount: 0,
  });
}

/**
 * An office's training taxonomy (P5-T1, ADR-0029): categories, skills and modules, the office's
 * own at every level. Named explicitly as the module's isolation spec, which the tenancy gate
 * requires the moment `/kpm/settings/training` ships (AC-7).
 */
describe('the office training taxonomy (P5-T1)', () => {
  let wired: ReturnType<typeof configModule>;
  let training: TrainingService;

  beforeAll(async () => {
    await startMongo();
    wired = configModule(NOW);
    training = wired.training;
  });
  afterAll(stopMongo);

  beforeEach(async () => {
    await clearCollections();
    await provisionOffice(wired, KPM_A, COMPANY);
  });

  const categoryNamed = async (code: string, kpmId = KPM_A) =>
    (await training.list(ctx(kpmId), true)).find((c) => c.code === code)!;
  const skillNamed = async (code: string, kpmId = KPM_A) =>
    (await training.list(ctx(kpmId), true)).flatMap((c) => c.skills).find((s) => s.code === code)!;
  const moduleNamed = async (code: string, kpmId = KPM_A) =>
    (await training.list(ctx(kpmId), true)).flatMap((c) => c.skills.flatMap((s) => s.modules))
      .find((m) => m.code === code)!;

  describe('provisioning (AC-5, AC-8)', () => {
    it('seeds the Owner prototype’s taxonomy when the company has published none', async () => {
      const tree = await training.list(ctx(KPM_A));
      expect(tree.map((c) => c.code)).toEqual([
        'SALES', 'PRODUCT', 'RECRUITING', 'TEAM_MANAGEMENT', 'SOFT_SKILLS', 'COMPANY_AND_KPM',
      ]);
      const sales = tree[0];
      expect(sales.skills.map((s) => s.code)).toEqual([
        'PROSPECTING', 'NEEDS_ANALYSIS', 'OBJECTION_HANDLING', 'CLOSING', 'CROSS_SELL', 'RETENTION',
      ]);
      expect(sales.skills.flatMap((s) => s.modules)).toHaveLength(SEED_TRAINING_MODULES.length);
      // Numbered within their skill, in the prototype's order.
      expect(sales.skills[2].modules.map((m) => [m.code, m.displayOrder])).toEqual([
        ['OBJECTION_FUNDAMENTALS', 1], ['PRICE_OBJECTIONS', 2],
      ]);
      expect(tree.slice(1).every((c) => c.skills.length === 0)).toBe(true);
    });

    it('copies a company’s published template exactly — an empty level included — and records it', async () => {
      // ADR-0115 §4: the source is resolved before the office exists and handed to the seed.
      const result = await wired.provisioning.seedTrainingTaxonomy(KPM_B, {
        payload: {
          categories: [{ code: 'onboarding', label: ' Onboarding ' }, { code: 'LATER', label: 'Later' }],
          skills: [{ code: 'FIRST_WEEK', categoryCode: 'ONBOARDING', label: 'First week' }],
          modules: [{ code: 'WELCOME', skillCode: 'FIRST_WEEK', title: 'Welcome' }],
        },
        seededFrom: { templateId: `tpl-${OTHER_COMPANY}`, version: 4 },
      });

      expect(result).toMatchObject({ rows: 4, seededFrom: { version: 4 } });
      const tree = await training.list(ctx(KPM_B));
      expect(tree.map((c) => [c.code, c.label])).toEqual([['ONBOARDING', 'Onboarding'], ['LATER', 'Later']]);
      // No publish state in the template means draft, as a created module is.
      expect(tree[0].skills[0].modules[0]).toMatchObject({ code: 'WELCOME', publishState: 'draft' });
      // Two companies, two offices, neither sees the other's taxonomy.
      expect((await training.list(ctx(KPM_A))).map((c) => c.code)).toContain('SALES');
    });

    it('refuses a source that would build a broken tree, naming the office', async () => {
      await expect(wired.provisioning.seedTrainingTaxonomy(KPM_B, {
        payload: { categories: [], skills: [{ code: 'ORPHAN', categoryCode: 'NOWHERE', label: 'x' }], modules: [] },
        seededFrom: { templateId: null, version: 1 },
      })).rejects.toThrow(`The training taxonomy for office ${KPM_B} would be broken`);
    });
  });

  describe('isolation (AC-7)', () => {
    it('reads one office’s taxonomy and never another’s', async () => {
      await provisionOffice(wired, KPM_B, COMPANY);
      await training.createCategory(ctx(KPM_B), { code: 'ONLY_IN_B', label: 'Only in B' });

      expect((await training.list(ctx(KPM_A), true)).map((c) => c.code)).not.toContain('ONLY_IN_B');
    });

    it('answers another office’s rows as not found, at every level', async () => {
      await provisionOffice(wired, KPM_B, COMPANY);
      const theirCategory = await categoryNamed('SALES', KPM_B);
      const theirSkill = await skillNamed('PROSPECTING', KPM_B);
      const theirModule = await moduleNamed('PROSPECT_LIST', KPM_B);
      const mine = ctx(KPM_A);

      await expect(training.updateCategory(mine, theirCategory.id, { label: 'x' })).rejects.toThrow('not found');
      await expect(training.archiveCategory(mine, theirCategory.id)).rejects.toThrow('not found');
      await expect(training.restoreCategory(mine, theirCategory.id)).rejects.toThrow('not found');
      await expect(training.updateSkill(mine, theirSkill.id, { label: 'x' })).rejects.toThrow('not found');
      await expect(training.archiveSkill(mine, theirSkill.id)).rejects.toThrow('not found');
      await expect(training.restoreSkill(mine, theirSkill.id)).rejects.toThrow('not found');
      await expect(training.updateModule(mine, theirModule.id, { title: 'x' })).rejects.toThrow('not found');
      await expect(training.archiveModule(mine, theirModule.id)).rejects.toThrow('not found');
      await expect(training.restoreModule(mine, theirModule.id)).rejects.toThrow('not found');

      expect((await moduleNamed('PROSPECT_LIST', KPM_B)).status).toBe('active');
    });

    it('answers another office’s row as 404 through the batch, and writes nothing', async () => {
      await provisionOffice(wired, KPM_B, COMPANY);
      const theirs = await moduleNamed('PROSPECT_LIST', KPM_B);

      const err = await wired.changes.apply(ctx(KPM_A), [
        { op: 'trainingCategory.create', body: { code: 'NEW_ONE', label: 'New' } },
        { op: 'trainingModule.archive', id: theirs.id, expectedVersion: theirs.version },
      ]).then(() => null, (e: unknown) => e as { code: string; getStatus(): number });

      expect(err).toMatchObject({ code: 'NOT_FOUND' });
      expect(err!.getStatus()).toBe(404);
      expect((await training.list(ctx(KPM_A), true)).map((c) => c.code)).not.toContain('NEW_ONE');
    });
  });

  describe('creating and editing (AC-2, AC-9)', () => {
    it('appends a category, a skill within its category, and a module within its skill', async () => {
      const category = await training.createCategory(ctx(KPM_A), { code: 'onboarding', label: 'Onboarding' });
      expect(category).toMatchObject({ code: 'ONBOARDING', displayOrder: 7, version: 1, description: null });

      const skill = await training.createSkill(ctx(KPM_A), { code: 'FIRST_WEEK', categoryCode: 'onboarding', label: 'First week' });
      expect(skill).toMatchObject({ categoryCode: 'ONBOARDING', displayOrder: 1 });

      const second = await training.createSkill(ctx(KPM_A), { code: 'MANNERS', categoryCode: 'SALES', label: 'Manners' });
      expect(second.displayOrder).toBe(7);

      const module = await training.createModule(ctx(KPM_A), { code: 'WELCOME', skillCode: 'FIRST_WEEK', title: 'Welcome' });
      expect(module).toMatchObject({ skillCode: 'FIRST_WEEK', displayOrder: 1, publishState: 'draft' });
    });

    it('lets an Admin do all of it, exactly as the Owner can', async () => {
      const admin = ctx(KPM_A, { admin: true });
      await training.createCategory(admin, { code: 'BY_ADMIN', label: 'By an Admin' });
      const sales = await categoryNamed('SALES');
      await training.updateCategory(admin, sales.id, { description: 'Selling, done well' });

      expect((await categoryNamed('SALES')).description).toBe('Selling, done well');
      expect((await categoryNamed('BY_ADMIN')).label).toBe('By an Admin');
    });

    it('never reuses a code within a level, counting archived rows, while two levels may share one', async () => {
      const retired = await categoryNamed('PRODUCT');
      await training.archiveCategory(ctx(KPM_A), retired.id);

      await expect(training.createCategory(ctx(KPM_A), { code: 'PRODUCT', label: 'Again' }))
        .rejects.toThrow('already has a training category called PRODUCT');
      await expect(training.createSkill(ctx(KPM_A), { code: 'CLOSING', categoryCode: 'SALES', label: 'Again' }))
        .rejects.toThrow('already has a training skill called CLOSING');
      await expect(training.createModule(ctx(KPM_A), { code: 'PROSPECT_LIST', skillCode: 'CLOSING', title: 'Again' }))
        .rejects.toThrow('already has a training module called PROSPECT_LIST');

      // A skill and a category are different levels: `SALES` as a skill code is fine.
      await expect(training.createSkill(ctx(KPM_A), { code: 'SALES', categoryCode: 'SALES', label: 'Sales skill' }))
        .resolves.toMatchObject({ code: 'SALES' });
    });

    it('moves a skill to another category, and its modules go with it', async () => {
      const prospecting = await skillNamed('PROSPECTING');
      const moved = await training.updateSkill(ctx(KPM_A), prospecting.id, { categoryCode: 'RECRUITING' });

      expect(moved).toMatchObject({ categoryCode: 'RECRUITING', displayOrder: 1, version: 2 });
      const recruiting = await categoryNamed('RECRUITING');
      expect(recruiting.skills[0].modules.map((m) => m.code))
        .toEqual(['PROSPECT_LIST', 'REFERRAL_GENERATION', 'COLD_APPROACH_SCRIPTS']);
    });

    it('moves a module under another skill, to the end of it', async () => {
      const module = await moduleNamed('PROSPECT_LIST');
      const moved = await training.updateModule(ctx(KPM_A), module.id, { skillCode: 'closing', title: ' Closing lists ' });

      expect(moved).toMatchObject({ skillCode: 'CLOSING', displayOrder: 2, title: 'Closing lists', version: 2 });
    });

    it('publishes and unpublishes a module as an ordinary edit', async () => {
      const module = await moduleNamed('CLIENT_RETENTION');
      await training.updateModule(ctx(KPM_A), module.id, { publishState: 'draft' });
      expect((await moduleNamed('CLIENT_RETENTION'))).toMatchObject({ publishState: 'draft', version: 2 });
    });

    it('refuses a parent that is not active, and an edit that changes nothing', async () => {
      await expect(training.createSkill(ctx(KPM_A), { code: 'NEW_SKILL', categoryCode: 'NOPE', label: 'x' }))
        .rejects.toThrow('No active training category called NOPE');
      await expect(training.createModule(ctx(KPM_A), { code: 'NEW_MODULE', skillCode: 'NOPE', title: 'x' }))
        .rejects.toThrow('No active training skill called NOPE');

      const skill = await skillNamed('CLOSING');
      await expect(training.updateSkill(ctx(KPM_A), skill.id, { categoryCode: 'NOPE' }))
        .rejects.toThrow('No active training category called NOPE');
      // Naming the category it is already in changes nothing.
      await expect(training.updateSkill(ctx(KPM_A), skill.id, { categoryCode: 'SALES' }))
        .rejects.toThrow('Nothing to change');

      const module = await moduleNamed('CLOSING_TECHNIQUES');
      await expect(training.updateModule(ctx(KPM_A), module.id, { skillCode: 'NOPE' }))
        .rejects.toThrow('No active training skill called NOPE');
      await expect(training.updateModule(ctx(KPM_A), module.id, { skillCode: 'CLOSING' }))
        .rejects.toThrow('Nothing to change');

      const category = await categoryNamed('SALES');
      await expect(training.updateCategory(ctx(KPM_A), category.id, {})).rejects.toThrow('Nothing to change');
    });

    it('refuses a body its checker refuses, before anything is written (ADR-0030)', async () => {
      await expect(training.createModule(ctx(KPM_A), { code: 'LONG_ONE', skillCode: 'CLOSING', title: 'x'.repeat(201) }))
        .rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
      expect(await moduleNamed('LONG_ONE')).toBeUndefined();
    });
  });

  describe('archiving and restoring (AC-3, AC-10)', () => {
    it('archives a category and everything still active under it', async () => {
      const sales = await categoryNamed('SALES');
      await training.archiveCategory(ctx(KPM_A), sales.id);

      const after = await categoryNamed('SALES');
      expect(after.status).toBe('archived');
      expect(after.skills.every((s) => s.status === 'archived')).toBe(true);
      expect(after.skills.flatMap((s) => s.modules).every((m) => m.status === 'archived')).toBe(true);
      // The live read no longer has it at all.
      expect((await training.list(ctx(KPM_A))).map((c) => c.code)).not.toContain('SALES');
    });

    it('reaches a module left active under an already archived skill', async () => {
      // Only a hand-written row can be in this state; the cascade must not depend on it never happening.
      const closing = await skillNamed('CLOSING');
      await training.archiveSkill(ctx(KPM_A), closing.id);
      const module = await moduleNamed('CLOSING_TECHNIQUES');
      await mongoose.model('TrainingModuleModel').updateOne({ _id: module.id }, { $set: { status: 'active' } });

      await training.archiveCategory(ctx(KPM_A), (await categoryNamed('SALES')).id);
      expect((await moduleNamed('CLOSING_TECHNIQUES')).status).toBe('archived');
    });

    it('archives a skill and its modules, and restores only what is asked', async () => {
      const prospecting = await skillNamed('PROSPECTING');
      await training.archiveSkill(ctx(KPM_A), prospecting.id);
      expect((await skillNamed('PROSPECTING')).modules.every((m) => m.status === 'archived')).toBe(true);

      await training.restoreSkill(ctx(KPM_A), prospecting.id);
      const restored = await skillNamed('PROSPECTING');
      expect(restored.status).toBe('active');
      expect(restored.modules.every((m) => m.status === 'archived')).toBe(true);

      const module = restored.modules[0];
      await training.restoreModule(ctx(KPM_A), module.id);
      expect((await moduleNamed(module.code)).status).toBe('active');
    });

    it('restores a category alone', async () => {
      const sales = await categoryNamed('SALES');
      await training.archiveCategory(ctx(KPM_A), sales.id);
      await training.restoreCategory(ctx(KPM_A), sales.id);

      const after = await categoryNamed('SALES');
      expect(after.status).toBe('active');
      expect(after.skills.every((s) => s.status === 'archived')).toBe(true);
    });

    it('restores nothing under an archived parent, and names the parent', async () => {
      const sales = await categoryNamed('SALES');
      await training.archiveCategory(ctx(KPM_A), sales.id);

      const skill = await skillNamed('CLOSING');
      await expect(training.restoreSkill(ctx(KPM_A), skill.id))
        .rejects.toThrow('CLOSING is in SALES, which is archived');
      const module = await moduleNamed('CLOSING_TECHNIQUES');
      await expect(training.restoreModule(ctx(KPM_A), module.id))
        .rejects.toThrow('CLOSING_TECHNIQUES teaches CLOSING, which is archived');
      await expect(training.createSkill(ctx(KPM_A), { code: 'UNDER_ARCHIVED', categoryCode: 'SALES', label: 'x' }))
        .rejects.toThrow('No active training category called SALES');
    });

    it('archives a module on its own', async () => {
      const module = await moduleNamed('PRICE_OBJECTIONS');
      await training.archiveModule(ctx(KPM_A), module.id);
      expect(await moduleNamed('PRICE_OBJECTIONS')).toMatchObject({ status: 'archived', version: 2 });
    });
  });

  describe('through the staged batch (ADR-0030, AC-10)', () => {
    const apply = (ops: ConfigChangeDto[]) => wired.changes.apply(ctx(KPM_A), ops);
    const refusal = (ops: ConfigChangeDto[]) =>
      apply(ops).then(() => { throw new Error('the batch was applied'); }, (e: unknown) => e as { code: string; message: string });

    it('builds a whole branch in one batch, each op naming what an earlier one created', async () => {
      await apply([
        { op: 'trainingCategory.create', body: { code: 'ONBOARDING', label: 'Onboarding' } },
        { op: 'trainingSkill.create', body: { code: 'FIRST_WEEK', categoryCode: 'ONBOARDING', label: 'First week' } },
        { op: 'trainingModule.create', body: { code: 'WELCOME', skillCode: 'FIRST_WEEK', title: 'Welcome', publishState: 'published' } },
      ]);

      const onboarding = await categoryNamed('ONBOARDING');
      expect(onboarding.skills[0].modules[0]).toMatchObject({ code: 'WELCOME', publishState: 'published' });
    });

    it('applies every training op to the service that owns it', async () => {
      const sales = await categoryNamed('SALES');
      const closing = await skillNamed('CLOSING');
      const module = await moduleNamed('CLOSING_TECHNIQUES');

      await apply([
        { op: 'trainingCategory.update', id: sales.id, expectedVersion: sales.version, body: { label: 'Selling' } },
        { op: 'trainingSkill.update', id: closing.id, expectedVersion: closing.version, body: { label: 'Closing well' } },
        { op: 'trainingModule.update', id: module.id, expectedVersion: module.version, body: { publishState: 'draft' } },
        { op: 'trainingModule.archive', id: module.id, expectedVersion: module.version + 1 },
        { op: 'trainingModule.restore', id: module.id, expectedVersion: module.version + 2 },
        { op: 'trainingSkill.archive', id: closing.id, expectedVersion: closing.version + 1 },
        { op: 'trainingSkill.restore', id: closing.id, expectedVersion: closing.version + 2 },
        { op: 'trainingCategory.archive', id: sales.id, expectedVersion: sales.version + 1 },
        { op: 'trainingCategory.restore', id: sales.id, expectedVersion: sales.version + 2 },
      ]);

      const after = await categoryNamed('SALES');
      expect(after).toMatchObject({ label: 'Selling', status: 'active', version: sales.version + 3 });
      expect(await skillNamed('CLOSING')).toMatchObject({ label: 'Closing well', status: 'archived' });
    });

    it('moves a skill and a module through the batch, into rows made earlier in it', async () => {
      const closing = await skillNamed('CLOSING');
      const module = await moduleNamed('PRICE_OBJECTIONS');
      await apply([
        { op: 'trainingCategory.create', body: { code: 'ADVANCED', label: 'Advanced' } },
        { op: 'trainingSkill.update', id: closing.id, expectedVersion: closing.version, body: { categoryCode: 'ADVANCED' } },
        { op: 'trainingModule.update', id: module.id, expectedVersion: module.version, body: { skillCode: 'CLOSING' } },
      ]);

      expect((await categoryNamed('ADVANCED')).skills[0].modules.map((m) => m.code))
        .toEqual(['CLOSING_TECHNIQUES', 'PRICE_OBJECTIONS']);
    });

    it('refuses a skill for a category that is not there, before anything is written', async () => {
      const err = await refusal([
        { op: 'trainingCategory.create', body: { code: 'FIRST', label: 'First' } },
        { op: 'trainingSkill.create', body: { code: 'LOST', categoryCode: 'NOWHERE', label: 'Lost' } },
      ]);
      expect(err.message).toBe('Change 2 (trainingSkill.create): No active training category called NOWHERE. Add it first, or check the code.');
      expect(await categoryNamed('FIRST')).toBeUndefined();
    });

    it('refuses a module under a skill that is not there, or a move into one', async () => {
      const module = await moduleNamed('PRICE_OBJECTIONS');
      const skill = await skillNamed('CLOSING');

      expect((await refusal([
        { op: 'trainingModule.create', body: { code: 'LOST', skillCode: 'NOWHERE', title: 'Lost' } },
      ])).message).toContain('No active training skill called NOWHERE');
      expect((await refusal([
        { op: 'trainingModule.update', id: module.id, expectedVersion: module.version, body: { skillCode: 'NOWHERE' } },
      ])).message).toContain('No active training skill called NOWHERE to move PRICE_OBJECTIONS under');
      expect((await refusal([
        { op: 'trainingSkill.update', id: skill.id, expectedVersion: skill.version, body: { categoryCode: 'NOWHERE' } },
      ])).message).toContain('No active training category called NOWHERE to move CLOSING into');
    });

    it('lets an archive reach down, so a later op cannot create or restore beneath it', async () => {
      const sales = await categoryNamed('SALES');
      const closing = await skillNamed('CLOSING');
      const module = await moduleNamed('CLOSING_TECHNIQUES');

      expect((await refusal([
        { op: 'trainingCategory.archive', id: sales.id, expectedVersion: sales.version },
        { op: 'trainingModule.create', body: { code: 'TOO_LATE', skillCode: 'CLOSING', title: 'Too late' } },
      ])).message).toContain('Change 2 (trainingModule.create): No active training skill called CLOSING');

      expect((await refusal([
        { op: 'trainingSkill.archive', id: closing.id, expectedVersion: closing.version },
        { op: 'trainingModule.restore', id: module.id, expectedVersion: module.version },
      ])).message).toBe('Change 2 (trainingModule.restore): CLOSING_TECHNIQUES teaches CLOSING, which is archived. Restore the skill first.');

      expect((await refusal([
        { op: 'trainingCategory.archive', id: sales.id, expectedVersion: sales.version },
        { op: 'trainingSkill.restore', id: closing.id, expectedVersion: closing.version },
      ])).message).toBe('Change 2 (trainingSkill.restore): CLOSING is in SALES, which is archived. Restore the category first.');

      // Refused before anything was written: SALES is still active.
      expect((await categoryNamed('SALES')).status).toBe('active');
    });

    it('refuses a code already taken at its level, or a body its checker refuses', async () => {
      expect((await refusal([
        { op: 'trainingModule.create', body: { code: 'PROSPECT_LIST', skillCode: 'CLOSING', title: 'Again' } },
      ])).message).toBe('Change 1 (trainingModule.create): PROSPECT_LIST is already in use in this office. A code is never reused.');

      const err = await refusal([
        { op: 'trainingCategory.create', body: { code: 'OK_ONE', label: 'Fine' } },
        { op: 'trainingModule.create', body: { code: 'BAD_ONE', skillCode: 'CLOSING', title: 'x', publishState: 'live' } },
      ]);
      expect(err).toMatchObject({ code: 'VALIDATION_FAILED' });
      expect(err.message).toBe('Change 2 (trainingModule.create): publishState must be one of draft, published.');
      expect(await categoryNamed('OK_ONE')).toBeUndefined();
    });
  });

  describe('what agents are offered (AC-4)', () => {
    it('carries active categories and skills and published modules only, empty categories included', async () => {
      const retention = await moduleNamed('CLIENT_RETENTION');
      await training.updateModule(ctx(KPM_A), retention.id, { publishState: 'draft' });
      await training.createModule(ctx(KPM_A), { code: 'NOT_YET', skillCode: 'CLOSING', title: 'Not yet' });

      const offered = await wired.config.read(ctx(KPM_A));
      const codes = offered.training.flatMap((c) => c.skills.flatMap((s) => s.modules.map((m) => m.code)));
      expect(codes).not.toContain('CLIENT_RETENTION');
      expect(codes).not.toContain('NOT_YET');
      expect(codes).toContain('PROSPECT_LIST');
      expect(offered.training.find((c) => c.code === 'PRODUCT')).toMatchObject({ skills: [] });
    });

    it('keeps the publish bar silent for a draft’s edits, and speaks when a module is published', async () => {
      await wired.config.publish(ctx(KPM_A));
      const draft = await training.createModule(ctx(KPM_A), { code: 'WORK_IN_PROGRESS', skillCode: 'CLOSING', title: 'WIP' });
      await training.updateModule(ctx(KPM_A), draft.id, { title: 'Still in progress' });

      expect((await wired.config.state(ctx(KPM_A))).hasUnpublishedChanges).toBe(false);

      await training.updateModule(ctx(KPM_A), draft.id, { publishState: 'published' });
      expect((await wired.config.state(ctx(KPM_A))).hasUnpublishedChanges).toBe(true);

      await wired.config.publish(ctx(KPM_A));
      const published = await wired.config.readPublished(ctx(KPM_A));
      expect(published.training.flatMap((c) => c.skills.flatMap((s) => s.modules)).map((m) => m.code))
        .toContain('WORK_IN_PROGRESS');
    });

    it('reads a snapshot published before P5-T1 as offering no training, and says there is something to publish', async () => {
      await wired.config.publish(ctx(KPM_A));
      await mongoose.model('ConfigSnapshotModel').updateMany({ kpmId: KPM_A }, { $unset: { 'payload.training': '' } });

      expect((await wired.config.readPublished(ctx(KPM_A))).training).toEqual([]);
      expect((await wired.config.state(ctx(KPM_A))).hasUnpublishedChanges).toBe(true);
    });
  });
});
