import mongoose from 'mongoose';
import { RequestContext } from '@/common/context/request-context';
import { TenantDay } from '@/modules/tenants/tenant-day.service';
import { SUPER_ADMIN, declaredPermissions } from '../../../test/http-permissions';
import {
  COMPANY_FILE, COMPANY_LINK, KPM_A, KPM_B, startTrainingHarness, stopTrainingHarness, TODAY, UNCONFIRMED_FILE,
  type TrainingHarness, type Who,
} from '../../../test/training-office';
import { TrainingProgressController } from './training-progress.controller';

/** The read's fields, exactly: the contract the frontend builds against (`scratchpad/p185/contract-training.md`). */
const VIEW_KEYS = ['allOfferedDone', 'categories', 'done', 'membershipId', 'pct', 'total'];
const CATEGORY_KEYS = ['code', 'description', 'done', 'label', 'offered', 'pct', 'skills', 'total'];
const SKILL_KEYS = ['archived', 'code', 'done', 'label', 'modules', 'offered', 'pct', 'total'];
const ROW_KEYS = ['code', 'completedAt', 'formats', 'status', 'title'];
const PAGE_KEYS = ['can', 'category', 'code', 'completedAt', 'items', 'openedItemIds', 'skill', 'startedAt', 'status', 'title'];

type Row = { code: string; title: string; status: string; completedAt: string | null; formats: string[] };
type Skill = { code: string; label: string; offered: boolean; done: number; total: number; modules: Row[]; archived: Row[] };
type Category = { code: string; label: string; offered: boolean; done: number; total: number; pct: number | null; skills: Skill[] };
type View = { membershipId: string; done: number; total: number; pct: number | null; categories: Category[]; allOfferedDone: boolean };

const sales = (view: View) => view.categories.find((c) => c.code === 'SALES')!;
const row = (view: View, code: string) => view.categories.flatMap((c) => c.skills.flatMap((s) => s.modules)).find((m) => m.code === code);
const counts = (view: View) => ({
  catalog: [view.done, view.total],
  categories: view.categories.map((c) => [c.code, c.done, c.total]),
  skills: view.categories.flatMap((c) => c.skills.map((s) => [s.code, s.done, s.total])),
});

/**
 * **The learner's training over HTTP** (P18.5-T1 to T4): the four routes, the settings reads, and the activation
 * routes a training-linked item is read and ticked through — with the decorators, the production pipe and the
 * permission guard in front of the real services, over `test/training-office.ts`'s two offices.
 */
describe('training progress over HTTP (P18.5-T1 to T4)', () => {
  let h: TrainingHarness;
  const id = (who: Who) => h.id(who);
  const reads = () => h.col('auditLog').find({ action: 'activity_log.read_raw' }).toArray();
  const changes = () => h.col('auditLog').find({ action: 'training_progress.status_changed' }).sort({ createdAt: 1 }).toArray();
  const stored = (who: Who, moduleCode: string) => h.col('trainingProgress').findOne({ membershipId: id(who), moduleCode, deletedAt: null });
  const mark = (code: string, status: string) => h.http().put(`/training/modules/${code}/progress`).send({ status });

  beforeAll(async () => { h = await startTrainingHarness(); });
  afterAll(async () => { await stopTrainingHarness(h); });
  beforeEach(async () => { await h.reset(); });

  it('P18.5-T1 AC-1 declares a permission on every route, and the right one', () => {
    expect(declaredPermissions(TrainingProgressController)).toEqual({
      read: 'training_progress:read',
      module: 'training_progress:read',
      // A read by its permission: a support session is answered the address, and records nothing.
      open: 'training_progress:read',
      setStatus: 'training_progress:update',
    });
  });

  // ------------------------------------------------------------------ T1: the list

  describe('GET /training/progress (T1, T2)', () => {
    it('P18.5-T1 AC-4 answers the offered catalog in the contract’s shape: six categories, Sales’s six skills, its ten modules', async () => {
      h.as('RINA');
      const view: View = (await h.http().get('/training/progress').expect(200)).body;

      expect(Object.keys(view).sort()).toEqual(VIEW_KEYS);
      expect(view).toMatchObject({ membershipId: id('RINA'), done: 0, total: 10, pct: 0, allOfferedDone: false });
      expect(view.categories.map((c) => [c.code, c.label, c.offered, c.total])).toEqual([
        ['SALES', 'Sales', true, 10], ['PRODUCT', 'Product', true, 0], ['RECRUITING', 'Recruiting', true, 0],
        ['TEAM_MANAGEMENT', 'Team Management', true, 0], ['SOFT_SKILLS', 'Soft Skills', true, 0],
        ['COMPANY_AND_KPM', 'Company and KPM', true, 0],
      ]);
      expect(Object.keys(view.categories[0]).sort()).toEqual(CATEGORY_KEYS);
      // An empty category: no skills, and a null share — drawn (0/0), never 0%.
      expect(view.categories[1]).toMatchObject({ skills: [], done: 0, total: 0, pct: null });
      expect(sales(view).skills.map((s) => [s.code, s.modules.length])).toEqual([
        ['PROSPECTING', 3], ['NEEDS_ANALYSIS', 2], ['OBJECTION_HANDLING', 2], ['CLOSING', 1], ['CROSS_SELL', 1], ['RETENTION', 1],
      ]);
      expect(Object.keys(sales(view).skills[0]).sort()).toEqual(SKILL_KEYS);
      expect(Object.keys(sales(view).skills[0].modules[0]).sort()).toEqual(ROW_KEYS);
      // Within a skill, by the module's own display order — never sorted by title.
      expect(sales(view).skills[2].modules.map((m) => m.code)).toEqual(['OBJECTION_FUNDAMENTALS', 'PRICE_OBJECTIONS']);
    });

    it('P18.5-T1 AC-4 the Format column is the kinds a module’s content holds now, File · Video · Link order', async () => {
      h.as('RINA');
      const view: View = (await h.http().get('/training/progress').expect(200)).body;
      expect(row(view, 'PROSPECT_LIST')!.formats).toEqual(['file', 'link']);
      expect(row(view, 'REFERRAL_GENERATION')!.formats).toEqual(['file']);
      expect(row(view, 'CLOSING_TECHNIQUES')!.formats).toEqual([]);
    });

    it('P18.5-T2 AC-2 counts done over offered at every scope; in progress is not done', async () => {
      h.as('RINA');
      await mark('PROSPECT_LIST', 'done').expect(200);
      await mark('REFERRAL_GENERATION', 'done').expect(200);
      await mark('FINANCIAL_NEEDS_ANALYSIS', 'in_progress').expect(200);
      const view: View = (await h.http().get('/training/progress').expect(200)).body;

      expect([view.done, view.total, view.pct]).toEqual([2, 10, 20]);
      expect(sales(view)).toMatchObject({ done: 2, total: 10, pct: 20 });
      expect(sales(view).skills.find((s) => s.code === 'PROSPECTING')).toMatchObject({ done: 2, total: 3 });
      expect(sales(view).skills.find((s) => s.code === 'NEEDS_ANALYSIS')).toMatchObject({ done: 0, total: 2 });
      expect(row(view, 'PROSPECT_LIST')).toMatchObject({ status: 'done', completedAt: '2026-09-14T03:00:00.000Z' });
      expect(row(view, 'FINANCIAL_NEEDS_ANALYSIS')).toMatchObject({ status: 'in_progress', completedAt: null });
    });

    it('P18.5-T2 AC-3 every offered module done is all offered done', async () => {
      h.as('RINA');
      const all = (sales((await h.http().get('/training/progress').expect(200)).body as View)).skills.flatMap((s) => s.modules);
      for (const m of all) await mark(m.code, 'done').expect(200);
      const view: View = (await h.http().get('/training/progress').expect(200)).body;
      expect([view.done, view.total, view.pct, view.allOfferedDone]).toEqual([10, 10, 100, true]);
    });

    it.each([['the Owner (an AB)', 'OWNER'], ['the Admin (an AB)', 'ADMIN'], ['an AB', 'AGUS'], ['an AAB', 'SARI'], ['an agent', 'RINA']] as const)(
      'P18.5-T1 AC-1 positive: %s reads their own',
      async (_name, who) => {
        h.as(who);
        const view: View = (await h.http().get('/training/progress').expect(200)).body;
        expect(view.membershipId).toBe(id(who));
      },
    );

    it('P18.5-T1 AC-1 an Owner standing on no rung reads their own; a Super Admin outside a session belongs to no office', async () => {
      h.as(h.officeOnly('OWNER'));
      await h.http().get('/training/progress').expect(200);
      h.as(SUPER_ADMIN);
      const res = await h.http().get('/training/progress').expect(403);
      expect(res.body.error.code).toBe('TENANT_NO_MEMBERSHIP');
    });

    it('P18.5-T1 AC-1 negative: a removed or pending member is refused', async () => {
      for (const status of ['removed', 'pending'] as const) {
        const base = h.office.as('RINA');
        h.as(new RequestContext(base.userId, 'none', { ...base.membership!, status }));
        await h.http().get('/training/progress').expect(403);
      }
    });

    it('P18.5-T1 AC-1 a read-only support session reads its member’s', async () => {
      h.as(h.supporting('RINA'));
      const view: View = (await h.http().get('/training/progress').expect(200)).body;
      expect(view.membershipId).toBe(id('RINA'));
    });

    it('refuses a query parameter it does not know, and an empty for', async () => {
      h.as('RINA');
      const res = await h.http().get('/training/progress?membershipId=x').expect(400);
      expect(res.body.error.code).toBe('VALIDATION_FAILED');
      await h.http().get('/training/progress?for=').expect(400);
    });
  });

  // ------------------------------------------------------------------ T1: offered = the snapshot

  describe('offered = the published snapshot (T1 AC-3)', () => {
    beforeEach(() => { h.as('RINA'); });

    it('P18.5-T1 AC-3 a draft module is not offered: 404, and absent from the list', async () => {
      await h.wired.training.createModule(h.office.as('OWNER'), {
        code: 'DRAFT_CLOSE', skillCode: 'CLOSING', title: 'Not yet', publishState: 'draft',
      });
      await h.publish();
      await h.http().get('/training/modules/DRAFT_CLOSE').expect(404);
      await mark('DRAFT_CLOSE', 'done').expect(404);
      expect(row((await h.http().get('/training/progress')).body, 'DRAFT_CLOSE')).toBeUndefined();
    });

    it('P18.5-T1 AC-3 a module archived and published since is not offered', async () => {
      const module = await h.moduleRow('CLIENT_RETENTION');
      await h.wired.training.archiveModule(h.office.as('OWNER'), module.id);
      // Until the office publishes, agents are still offered it (the snapshot is what they read).
      await h.http().get('/training/modules/CLIENT_RETENTION').expect(200);
      await h.publish();
      await h.http().get('/training/modules/CLIENT_RETENTION').expect(404);
      await mark('CLIENT_RETENTION', 'done').expect(404);
    });

    it('P18.5-T1 AC-3 a module unpublished and published since is not offered', async () => {
      const module = await h.moduleRow('CROSS_SELL_OPPORTUNITIES');
      await h.wired.training.updateModule(h.office.as('OWNER'), module.id, { publishState: 'draft' });
      await h.publish();
      await h.http().get('/training/modules/CROSS_SELL_OPPORTUNITIES').expect(404);
    });

    it('P18.5-T1 AC-3 a module published in the working copy but not yet by the office is not offered', async () => {
      await h.wired.training.createModule(h.office.as('OWNER'), {
        code: 'NEW_CLOSE', skillCode: 'CLOSING', title: 'Coming', publishState: 'published',
      });
      await h.http().get('/training/modules/NEW_CLOSE').expect(404);
      expect(row((await h.http().get('/training/progress')).body, 'NEW_CLOSE')).toBeUndefined();
      await h.publish();
      await h.http().get('/training/modules/NEW_CLOSE').expect(200);
    });

    it('P18.5-T1 AC-3 an unknown code and another office’s module are 404, answered alike', async () => {
      await h.wired.training.createModule(h.office.as('B_AB'), {
        code: 'GADING_ONLY', skillCode: 'CLOSING', title: 'Only in 0555', publishState: 'published',
      });
      await h.publish(KPM_B);
      const unknown = await h.http().get('/training/modules/NOT_A_MODULE').expect(404);
      const other = await h.http().get('/training/modules/GADING_ONLY').expect(404);
      expect(other.body.error).toEqual(unknown.body.error);
      await mark('GADING_ONLY', 'done').expect(404);
      await h.http().post('/training/modules/GADING_ONLY/items/x/open').send({}).expect(404);
    });

    it('P18.5 exit review (docs) a material save and a reset reach agents at once and leave the publish bar silent', async () => {
      const owner = h.office.as('OWNER');
      const before = await h.moduleRow('CLOSING_TECHNIQUES');
      expect((await h.wired.config.state(owner)).hasUnpublishedChanges).toBe(false);

      const signed = await h.wired.training.requestContentUpload(owner, { filename: 'deck.pdf', mimeType: 'application/pdf', bytes: 1024 });
      await h.wired.training.confirmContentUpload(owner, signed.storageKey);
      await h.wired.training.saveContent(owner, 'CLOSING_TECHNIQUES', {
        files: [{ label: 'Closing deck.pdf', storageKey: signed.storageKey, mimeType: 'application/pdf', bytes: 1024 }],
      });
      expect((await h.wired.config.state(owner)).hasUnpublishedChanges).toBe(false);
      expect((await h.moduleRow('CLOSING_TECHNIQUES')).version).toBe(before.version);
      h.as('RINA');
      expect((await h.http().get('/training/modules/CLOSING_TECHNIQUES').expect(200)).body.items.map((i: { label: string }) => i.label))
        .toEqual(['Closing deck.pdf']);

      await h.wired.training.resetContent(owner, 'CLOSING_TECHNIQUES');
      expect((await h.wired.config.state(owner)).hasUnpublishedChanges).toBe(false);
      expect((await h.moduleRow('CLOSING_TECHNIQUES')).version).toBe(before.version);
      // A title is snapshot material, and still speaks.
      await h.wired.training.updateModule(owner, before.id, { title: 'Renamed' });
      expect((await h.wired.config.state(owner)).hasUnpublishedChanges).toBe(true);
    });

    it('P18.5-T1 AC-3 a title waits for the office’s publish; content reaches agents at once', async () => {
      const module = await h.moduleRow('CLOSING_TECHNIQUES');
      await h.wired.training.updateModule(h.office.as('OWNER'), module.id, { title: 'Closing, renamed' });
      await h.col('trainingModules').updateOne({ kpmId: KPM_A, code: 'CLOSING_TECHNIQUES' }, {
        $set: { officeContent: { files: [], videos: [], links: [{ id: '01JLINKNEW000000000000000', label: 'New talk', url: 'https://learn.example.com/close' }] } },
      });
      const page = (await h.http().get('/training/modules/CLOSING_TECHNIQUES').expect(200)).body;
      expect(page.title).toBe('Closing Techniques That Work');
      expect(page.items.map((i: { label: string }) => i.label)).toEqual(['New talk']);
    });
  });

  // ------------------------------------------------------------------ T1: the module page

  describe('GET /training/modules/:code (T1 AC-5)', () => {
    it('P18.5-T1 AC-5 answers the module as offered, its items files → videos → links, in the contract’s shape', async () => {
      h.as('RINA');
      const page = (await h.http().get('/training/modules/prospect_list').expect(200)).body;
      expect(Object.keys(page).sort()).toEqual(PAGE_KEYS);
      expect(page).toMatchObject({
        code: 'PROSPECT_LIST', title: 'Building Your Prospect List',
        category: { code: 'SALES', label: 'Sales' }, skill: { code: 'PROSPECTING', label: 'Prospecting' },
        status: 'not_started', startedAt: null, completedAt: null, openedItemIds: [], can: { update: true },
      });
      expect(page.items).toEqual([
        { id: COMPANY_FILE.id, kind: 'file', label: 'Prospect list worksheet.pdf', mimeType: 'application/pdf', bytes: 2048, url: null },
        { id: COMPANY_LINK.id, kind: 'link', label: 'The prospecting talk', mimeType: null, bytes: null, url: COMPANY_LINK.url },
      ]);
      // The storage key never leaves the server.
      expect(JSON.stringify(page)).not.toContain(COMPANY_FILE.storageKey);
    });

    it('P18.5-T1 AC-5 a module with nothing in it answers no items', async () => {
      h.as('RINA');
      expect((await h.http().get('/training/modules/CLOSING_TECHNIQUES').expect(200)).body.items).toEqual([]);
    });

    it('P18.5-T1 AC-7 no toggle in a support session, nor for an Owner on no rung: can.update is false', async () => {
      for (const who of [h.supporting('RINA'), h.supporting('RINA', false), h.officeOnly('OWNER')]) {
        h.as(who);
        expect((await h.http().get('/training/modules/PROSPECT_LIST').expect(200)).body.can).toEqual({ update: false });
      }
      h.as('OWNER');
      expect((await h.http().get('/training/modules/PROSPECT_LIST').expect(200)).body.can).toEqual({ update: true });
    });

    it('refuses a query parameter', async () => {
      h.as('RINA');
      await h.http().get('/training/modules/PROSPECT_LIST?for=x').expect(400);
    });
  });

  // ------------------------------------------------------------------ T1: opening

  describe('POST /training/modules/:code/items/:itemId/open (T1 AC-6)', () => {
    const open = (itemId: string, code = 'PROSPECT_LIST') => h.http().post(`/training/modules/${code}/items/${itemId}/open`).send({});

    it('P18.5-T1 AC-6 a company file is answered a signed address, and its first open is recorded once', async () => {
      h.as('RINA');
      const first = (await open(COMPANY_FILE.id).expect(200)).body;
      expect(first).toEqual({ url: `https://cdn.test/${COMPANY_FILE.storageKey}?sig=abc`, openedItemIds: [COMPANY_FILE.id], recorded: true });

      h.clock.set(new Date('2026-09-14T05:00:00Z'));
      const again = (await open(COMPANY_FILE.id).expect(200)).body;
      expect(again).toMatchObject({ openedItemIds: [COMPANY_FILE.id], recorded: false });

      const row = await stored('RINA', 'PROSPECT_LIST');
      expect(row).toMatchObject({ status: 'not_started', startedAt: null, completedAt: null });
      expect(row!.opened).toEqual([{ itemId: COMPANY_FILE.id, at: new Date('2026-09-14T03:00:00Z') }]);
      // Opening is not audited: the row carries the time.
      expect(await h.col('auditLog').countDocuments({ targetCollection: 'trainingProgress' })).toBe(0);
      // And the page shows it opened (D-opened, persisted).
      expect((await h.http().get('/training/modules/PROSPECT_LIST').expect(200)).body.openedItemIds).toEqual([COMPANY_FILE.id]);
    });

    it('P18.5-T1 AC-6 a link is answered its own address', async () => {
      h.as('SARI');
      expect((await open(COMPANY_LINK.id).expect(200)).body).toEqual({
        url: COMPANY_LINK.url, openedItemIds: [COMPANY_LINK.id], recorded: true,
      });
    });

    it('P18.5-T1 AC-6 an office’s own upload is answered from the office’s registry', async () => {
      const ownerCtx = h.office.as('OWNER');
      const signed = await h.wired.training.requestContentUpload(ownerCtx, { filename: 'own.pdf', mimeType: 'application/pdf', bytes: 1024 });
      await h.wired.training.confirmContentUpload(ownerCtx, signed.storageKey);
      const saved = await h.wired.training.saveContent(ownerCtx, 'CLOSING_TECHNIQUES', {
        files: [{ label: 'Our own closing deck', storageKey: signed.storageKey, mimeType: 'application/pdf', bytes: 1024 }],
      });
      h.as('RINA');
      const res = (await open(saved.content.files[0].id, 'CLOSING_TECHNIQUES').expect(200)).body;
      expect(res.url).toBe(`https://cdn.test/${signed.storageKey}?sig=abc`);
    });

    it('P18.5-T1 AC-6 a file whose upload never finished is 409 ASSET_NOT_CONFIRMED, and nothing is recorded', async () => {
      h.as('RINA');
      const res = await open(UNCONFIRMED_FILE.id, 'REFERRAL_GENERATION').expect(409);
      expect(res.body.error.code).toBe('ASSET_NOT_CONFIRMED');
      expect(await stored('RINA', 'REFERRAL_GENERATION')).toBeNull();
    });

    it('P18.5-T1 AC-6 an item the module does not hold is 404', async () => {
      h.as('RINA');
      await open('NOT_AN_ITEM').expect(404);
      // Another module's item, named under this one.
      await open(UNCONFIRMED_FILE.id, 'PROSPECT_LIST').expect(404);
    });

    it.each([['read-only', true], ['elevated', false]] as const)(
      'P18.5-T1 AC-6 a %s support session is answered the address and records nothing (D-support)',
      async (_kind, readOnly) => {
        h.as(h.supporting('RINA', readOnly));
        expect((await open(COMPANY_FILE.id).expect(200)).body).toMatchObject({ openedItemIds: [], recorded: false });
        expect(await stored('RINA', 'PROSPECT_LIST')).toBeNull();
      },
    );

    it('P18.5-T1 AC-6 an Owner on no rung opens and records nothing', async () => {
      h.as(h.officeOnly('OWNER'));
      expect((await open(COMPANY_LINK.id).expect(200)).body.recorded).toBe(false);
      expect(await stored('OWNER', 'PROSPECT_LIST')).toBeNull();
    });

    it('refuses a body', async () => {
      h.as('RINA');
      await h.http().post(`/training/modules/PROSPECT_LIST/items/${COMPANY_LINK.id}/open`).send({ membershipId: id('BUDI') }).expect(400);
    });
  });

  // ------------------------------------------------------------------ T1: the status

  describe('PUT /training/modules/:code/progress (T1 AC-7)', () => {
    it('P18.5-T1 AC-7 sets the status, never toggles; startedAt kept from the first move, completedAt on each move to done', async () => {
      h.as('RINA');
      const started = (await mark('DISCOVERY_QUESTIONS', 'in_progress').expect(200)).body;
      expect(started).toMatchObject({ status: 'in_progress', startedAt: '2026-09-14T03:00:00.000Z', completedAt: null });

      h.clock.set(new Date('2026-09-15T03:00:00Z'));
      expect((await mark('DISCOVERY_QUESTIONS', 'done').expect(200)).body)
        .toMatchObject({ status: 'done', startedAt: '2026-09-14T03:00:00.000Z', completedAt: '2026-09-15T03:00:00.000Z' });
      // Set, not toggled: the same status again changes nothing.
      expect((await mark('DISCOVERY_QUESTIONS', 'done').expect(200)).body.status).toBe('done');

      h.clock.set(new Date('2026-09-16T03:00:00Z'));
      // Done back to Not started is allowed (`Overall.html:7905-7911`): completedAt cleared, startedAt kept.
      expect((await mark('DISCOVERY_QUESTIONS', 'not_started').expect(200)).body)
        .toMatchObject({ status: 'not_started', startedAt: '2026-09-14T03:00:00.000Z', completedAt: null });
      expect(await h.col('trainingProgress').countDocuments({ membershipId: id('RINA') })).toBe(1);
    });

    it('P18.5-T1 AC-7 one audit row per change, with before and after; none for a write that changes nothing', async () => {
      h.as('RINA');
      await mark('PROSPECT_LIST', 'not_started').expect(200); // no row, nothing to change
      await mark('PROSPECT_LIST', 'in_progress').expect(200);
      await mark('PROSPECT_LIST', 'in_progress').expect(200);
      await mark('PROSPECT_LIST', 'done').expect(200);
      const rows = await changes();
      expect(rows.map((r) => [r.before, r.after])).toEqual([
        [{ moduleCode: 'PROSPECT_LIST', status: 'not_started' }, { moduleCode: 'PROSPECT_LIST', status: 'in_progress' }],
        [{ moduleCode: 'PROSPECT_LIST', status: 'in_progress' }, { moduleCode: 'PROSPECT_LIST', status: 'done' }],
      ]);
      expect(rows.every((r) => r.targetMembershipId === id('RINA') && r.targetCollection === 'trainingProgress')).toBe(true);
      // Nothing written for a no-op on a module never touched.
      expect(await stored('RINA', 'CLOSING_TECHNIQUES')).toBeNull();
    });

    it.each([['the Owner (an AB)', 'OWNER'], ['the Admin (an AB)', 'ADMIN'], ['an AB', 'AGUS'], ['an AAB', 'SARI'], ['an agent', 'RINA']] as const)(
      'P18.5-T1 AC-1 positive: %s sets their own status — every field rung learns',
      async (_name, who) => {
        h.as(who);
        expect((await mark('CLOSING_TECHNIQUES', 'done').expect(200)).body.status).toBe('done');
        expect(await stored(who, 'CLOSING_TECHNIQUES')).toMatchObject({ status: 'done' });
      },
    );

    it('P18.5-T1 AC-1 negative: an Owner or Admin on no rung, and a Super Admin, are refused', async () => {
      for (const who of [h.officeOnly('OWNER'), h.officeOnly('ADMIN'), SUPER_ADMIN]) {
        h.as(who);
        const res = await mark('CLOSING_TECHNIQUES', 'done').expect(403);
        expect(res.body.error.code).toBe('PERM_DENIED');
      }
    });

    it.each([['read-only', true], ['elevated', false]] as const)(
      'P18.5-T1 AC-1 D-support: a %s support session is refused, and nothing is written',
      async (_kind, readOnly) => {
        h.as(h.supporting('RINA', readOnly));
        await mark('CLOSING_TECHNIQUES', 'done').expect(403);
        expect(await stored('RINA', 'CLOSING_TECHNIQUES')).toBeNull();
      },
    );

    it('refuses an unknown status, a missing one, and a field it does not know', async () => {
      h.as('RINA');
      for (const body of [{ status: 'verified' }, {}, { status: 'done', membershipId: id('BUDI') }, { status: 'done', completedAt: '2026-01-01' }]) {
        const res = await h.http().put('/training/modules/CLOSING_TECHNIQUES/progress').send(body).expect(400);
        expect(res.body.error.code).toBe('VALIDATION_FAILED');
      }
      expect(await stored('RINA', 'CLOSING_TECHNIQUES')).toBeNull();
    });
  });

  // ------------------------------------------------------------------ T2: history, leavers

  describe('history and re-joins (T2)', () => {
    it('P18.5-T2 AC-4 D-history: a module done and then archived stays on the record, under its skill, outside the counts', async () => {
      h.as('RINA');
      await mark('CLIENT_RETENTION', 'done').expect(200);
      await mark('PROSPECT_LIST', 'done').expect(200);
      await h.wired.training.archiveModule(h.office.as('OWNER'), (await h.moduleRow('CLIENT_RETENTION')).id);
      await h.publish();

      const view: View = (await h.http().get('/training/progress').expect(200)).body;
      expect([view.done, view.total]).toEqual([1, 9]);
      expect(row(view, 'CLIENT_RETENTION')).toBeUndefined();
      const retention = sales(view).skills.find((s) => s.code === 'RETENTION')!;
      // The skill is still offered, with nothing offered in it: its card holds the history alone.
      expect(retention).toMatchObject({ offered: true, done: 0, total: 0, modules: [] });
      expect(retention.archived).toEqual([
        { code: 'CLIENT_RETENTION', title: 'Client Retention Best Practices', formats: [], status: 'done', completedAt: '2026-09-14T03:00:00.000Z' },
      ]);
      // A module in progress when it was withdrawn is not history: only done is.
      expect(await stored('RINA', 'CLIENT_RETENTION')).toMatchObject({ status: 'done' });
    });

    it('P18.5 exit review (training review 2) a done module set back to draft is not history: shown nowhere until published again', async () => {
      h.as('RINA');
      await mark('PROSPECT_LIST', 'done').expect(200);
      await h.wired.training.updateModule(h.office.as('OWNER'), (await h.moduleRow('PROSPECT_LIST')).id, { publishState: 'draft' });
      await h.publish();
      const view: View = (await h.http().get('/training/progress').expect(200)).body;
      expect(row(view, 'PROSPECT_LIST')).toBeUndefined();
      expect(view.categories.flatMap((c) => c.skills.flatMap((s) => s.archived))).toEqual([]);
      expect([view.done, view.total]).toEqual([0, 9]);
      // The record is kept: published again, it reads done.
      await h.wired.training.updateModule(h.office.as('OWNER'), (await h.moduleRow('PROSPECT_LIST')).id, { publishState: 'published' });
      await h.publish();
      expect(row((await h.http().get('/training/progress').expect(200)).body, 'PROSPECT_LIST')!.status).toBe('done');
    });

    it('P18.5-T2 AC-4 D-history carries the withdrawn module’s formats, as an offered row does', async () => {
      h.as('RINA');
      await mark('PROSPECT_LIST', 'done').expect(200);
      await h.wired.training.archiveModule(h.office.as('OWNER'), (await h.moduleRow('PROSPECT_LIST')).id);
      await h.publish();
      const view: View = (await h.http().get('/training/progress').expect(200)).body;
      expect(sales(view).skills.find((s) => s.code === 'PROSPECTING')!.archived).toMatchObject([
        { code: 'PROSPECT_LIST', formats: ['file', 'link'] },
      ]);
    });

    it('P18.5-T2 AC-4 D-history under a skill and a category no longer offered: drawn after the offered ones', async () => {
      h.as('RINA');
      await mark('CLIENT_RETENTION', 'done').expect(200);
      const owner = h.office.as('OWNER');
      const retention = (await h.wired.training.list(owner, true)).flatMap((c) => c.skills).find((s) => s.code === 'RETENTION')!;
      await h.wired.training.archiveSkill(owner, retention.id);
      await h.publish();

      let view: View = (await h.http().get('/training/progress').expect(200)).body;
      expect(sales(view).skills.at(-1)).toMatchObject({ code: 'RETENTION', offered: false, modules: [], archived: [{ code: 'CLIENT_RETENTION' }] });

      const salesRow = (await h.wired.training.list(owner, true)).find((c) => c.code === 'SALES')!;
      await h.wired.training.archiveCategory(owner, salesRow.id);
      await h.publish();
      view = (await h.http().get('/training/progress').expect(200)).body;
      expect(view.categories.map((c) => [c.code, c.offered])).toEqual([
        ['PRODUCT', true], ['RECRUITING', true], ['TEAM_MANAGEMENT', true], ['SOFT_SKILLS', true], ['COMPANY_AND_KPM', true],
        ['SALES', false],
      ]);
      expect(view.categories.at(-1)).toMatchObject({ done: 0, total: 0, pct: null, skills: [{ code: 'RETENTION', archived: [{ code: 'CLIENT_RETENTION' }] }] });
      expect([view.done, view.total]).toEqual([0, 0]);
    });

    it('P18.5-T2 AC-5 a re-join starts at nothing done; the old rows stay with the old membership', async () => {
      // LEFT left; their rows are theirs. A new membership for the same person reads nothing done.
      await h.col('trainingProgress').insertOne({
        kpmId: KPM_A, membershipId: id('LEFT'), moduleCode: 'PROSPECT_LIST', status: 'done', startedAt: new Date('2026-03-01'),
        completedAt: new Date('2026-03-02'), opened: [], version: 2, deletedAt: null, createdBy: id('LEFT'), updatedBy: id('LEFT'),
      });
      const rejoined = new mongoose.Types.ObjectId();
      const left = (await h.col('memberships').findOne({ _id: new mongoose.Types.ObjectId(id('LEFT')) }))!;
      await h.col('memberships').insertOne({ ...left, _id: rejoined, status: 'active', leaderCode: 'REJOIN01', agentCode: 'PRU-REJOIN' });
      try {
        const readings = h.wired.trainingReadings;
        const ctx = h.office.as('AGUS');
        expect((await readings.of(ctx, String(rejoined))).done).toBe(0);
        expect((await readings.of(ctx, id('LEFT'))).done).toBe(1);
      } finally {
        await h.col('memberships').deleteOne({ _id: rejoined });
      }
    });
  });

  // ------------------------------------------------------------------ T4: the coach's read

  describe('GET /training/progress?for= (T4)', () => {
    const forOf = (who: Who) => h.http().get(`/training/progress?for=${id(who)}`);

    beforeEach(async () => {
      h.as('RINA');
      await mark('PROSPECT_LIST', 'done').expect(200);
      await mark('DISCOVERY_QUESTIONS', 'in_progress').expect(200);
      await h.col('auditLog').deleteMany({});
    });

    it('P18.5-T4 AC-1 a coach reads a coachee’s, and one §3.5 entry is written, surface training', async () => {
      h.as('SARI');
      const view: View = (await forOf('RINA').expect(200)).body;
      expect(view).toMatchObject({ membershipId: id('RINA'), done: 1, total: 10 });

      const entries = await reads();
      expect(entries).toHaveLength(1);
      expect(entries[0]).toMatchObject({
        targetMembershipId: id('RINA'), targetCollection: 'memberships',
        after: { surface: 'training', from: null, to: TODAY },
      });
    });

    it('P18.5-T4 AC-1 reaches the whole downline: an AB two levels up, and the Owner standing above everybody', async () => {
      for (const who of ['AGUS', 'OWNER'] as const) {
        h.as(who);
        expect((await forOf('RINA').expect(200)).body.membershipId).toBe(id('RINA'));
      }
      expect(await reads()).toHaveLength(2);
    });

    /*
     * Permission review B5: the matrix's `own-kpm` for the Owner and the Admin (roles §3.7), through `CoachResolver.subject`
     * as campaigns and the Unit Dashboard read — the office, a member who has left included; the field rungs their COACH.
     */
    it('P18.5-T4 AC-1 the Owner and the Admin reach the office, a leaver included, as the office’s administration', async () => {
      for (const who of [h.officeOnly('ADMIN'), h.officeOnly('OWNER'), h.office.as('ADMIN')]) {
        h.as(who);
        expect((await forOf('PEER_AGENT').expect(200)).body.membershipId).toBe(id('PEER_AGENT'));
        expect((await forOf('LEFT').expect(200)).body.membershipId).toBe(id('LEFT'));
      }
      const entries = await reads();
      expect(entries).toHaveLength(6);
      expect(entries.every((e) => e.after.surface === 'training')).toBe(true);
    });

    it.each([
      ['a peer’s agent', 'AGUS', 'PEER_AGENT'],
      ['another office’s member', 'SARI', 'B_AGENT'],
      ['a member who left, to a leader', 'AGUS', 'LEFT'],
      ['another office’s leader, to the Owner', 'OWNER', 'B_AB'],
      ['an Agent’s colleague (own reaches nobody)', 'RINA', 'BUDI'],
      ['an Agent who leads, on an own grant', 'LUKAS', 'TARI'],
      ['a leader who leads nobody', 'DEWI', 'RINA'],
    ] as const)('P18.5-T4 AC-1 404 for %s, and no entry written', async (_name, reader, subject) => {
      h.as(reader);
      const res = await forOf(subject).expect(404);
      expect(res.body.error.code).toBe('NOT_FOUND');
      expect(await reads()).toEqual([]);
    });

    it('P18.5-T4 AC-1 an id that names nobody is 404, a malformed one too', async () => {
      h.as('AGUS');
      await h.http().get(`/training/progress?for=${new mongoose.Types.ObjectId().toString()}`).expect(404);
      await h.http().get('/training/progress?for=not-an-id').expect(404);
    });

    it('P18.5-T4 AC-3 the reader’s own read writes no entry', async () => {
      h.as('RINA');
      await h.http().get('/training/progress').expect(200);
      expect(await reads()).toEqual([]);
    });

    /*
     * The product's `for` convention (goals' `GoalReadQueryDto`, campaigns): omitted, or the reader's own, it is their
     * own. The phase file's AC-1 listed *"the reader named as their own coachee"* among the 404s; aligned with the
     * convention by the lead on 2026-10-10 — it is the reader's own record, so no §3.5 entry either.
     */
    it('P18.5-T4 AC-1 for naming the reader reads their own, and writes no entry', async () => {
      h.as('SARI');
      const own = (await h.http().get('/training/progress').expect(200)).body;
      const named = (await forOf('SARI').expect(200)).body;
      expect(named).toEqual(own);
      expect(named.membershipId).toBe(id('SARI'));
      // An Agent too: their `own` grant reaches themselves.
      h.as('RINA');
      expect((await forOf('RINA').expect(200)).body.membershipId).toBe(id('RINA'));
      expect(await reads()).toEqual([]);
    });

    it('P18.5-T4 AC-1 a read-only support session as the coach reads, and the entry names both actors', async () => {
      h.as(h.supporting('SARI'));
      await forOf('RINA').expect(200);
      const [entry] = await reads();
      expect(entry).toMatchObject({ targetMembershipId: id('RINA') });
      expect(entry.actorUserId).not.toBe(entry.effectiveUserId);
    });

    it('P18.5-T4 AC-4 exit test 3: the coach’s tab, /coaching/me/training and the learner’s read count alike after each kind of write', async () => {
      const learner = async () => counts((await (h.as('RINA'), h.http().get('/training/progress')).expect(200)).body);
      const coach = async () => counts((await (h.as('SARI'), forOf('RINA')).expect(200)).body);
      const writes: [string, string][] = [
        ['CLOSING_TECHNIQUES', 'in_progress'], ['CLOSING_TECHNIQUES', 'done'], ['PROSPECT_LIST', 'not_started'],
        ['DISCOVERY_QUESTIONS', 'done'], ['CROSS_SELL_OPPORTUNITIES', 'done'],
      ];
      expect(await coach()).toEqual(await learner());
      for (const [code, status] of writes) {
        h.as('RINA');
        await mark(code, status).expect(200);
        expect([code, status, await coach()]).toEqual([code, status, await learner()]);
      }
      // An open, too: it changes no count, and the two still agree.
      h.as('RINA');
      await h.http().post(`/training/modules/PROSPECT_LIST/items/${COMPANY_LINK.id}/open`).send({}).expect(200);
      expect(await coach()).toEqual(await learner());
      expect((await learner()).catalog).toEqual([3, 10]);
    });
  });

  // ------------------------------------------------------------------ T3: the training link

  describe('the training-link evaluator (T3)', () => {
    type Item = { code: string; done: boolean; source: string | null; doneAt: string | null; doneBy: { membershipId: string } | null; link: { kind: string; live: boolean; route: string; label: string; completesWhen: string } | null };
    const itemOf = (view: { aspects: { items: Item[] }[] }, code: string) => view.aspects.flatMap((a) => a.items).find((i) => i.code === code)!;
    const mine = async (who: Who) => { h.as(who); return (await h.http().get('/activation/me').expect(200)).body; };

    let activation: Awaited<ReturnType<TrainingHarness['start']>>;
    beforeEach(async () => {
      activation = await h.start('BUDI', '2026-07-15');
      await h.bind(activation, 'MANDATORY_TRAINING', 'training:CLOSING_TECHNIQUES');
    });

    it('P18.5-T3 AC-1 AC-5 the item is served live, Auto, going to the module’s own page', async () => {
      const view = await mine('BUDI');
      expect(itemOf(view, 'MANDATORY_TRAINING')).toMatchObject({
        done: false,
        link: {
          kind: 'training:CLOSING_TECHNIQUES', label: 'Closing Techniques That Work', live: true,
          route: '/training/SALES/CLOSING_TECHNIQUES', completesWhen: 'the hire has completed that training module',
        },
      });
    });

    it('P18.5-T3 AC-2 marking the module done completes the item: source link, by the hire, at completedAt, the record trainingProgress', async () => {
      h.as('BUDI');
      h.clock.set(new Date('2026-09-14T04:30:00Z'));
      await mark('CLOSING_TECHNIQUES', 'done').expect(200);

      // Evaluated at the end of the write: the stored row already holds it, before any read.
      const storedActivation = (await h.col('activationProgress').findOne({ _id: activation._id }))!;
      const progress = (await stored('BUDI', 'CLOSING_TECHNIQUES'))!;
      expect(storedActivation.items.find((i: { code: string }) => i.code === 'MANDATORY_TRAINING')).toMatchObject({
        done: true, source: 'link', doneByMembershipId: id('BUDI'), recordCollection: 'trainingProgress',
        recordId: String(progress._id), doneAt: new Date('2026-09-14T04:30:00Z'),
      });

      const view = await mine('BUDI');
      expect(itemOf(view, 'MANDATORY_TRAINING')).toMatchObject({
        done: true, source: 'link', doneAt: '2026-09-14T04:30:00.000Z', doneBy: { membershipId: id('BUDI') },
      });
    });

    it('P18.5-T3 AC-2 sticky: moving the module back does not untick the item', async () => {
      h.as('BUDI');
      await mark('CLOSING_TECHNIQUES', 'done').expect(200);
      await mark('CLOSING_TECHNIQUES', 'in_progress').expect(200);
      await mark('CLOSING_TECHNIQUES', 'not_started').expect(200);
      expect(itemOf(await mine('BUDI'), 'MANDATORY_TRAINING')).toMatchObject({ done: true, source: 'link' });
    });

    it('P18.5-T3 AC-2 a done record made before the item was read completes it on the next read (a missed signal heals)', async () => {
      await h.col('trainingProgress').insertOne({
        kpmId: KPM_A, membershipId: id('BUDI'), moduleCode: 'CLOSING_TECHNIQUES', status: 'done',
        startedAt: new Date('2026-09-01T03:00:00Z'), completedAt: new Date('2026-09-02T03:00:00Z'), opened: [], version: 2,
        deletedAt: null, createdBy: id('BUDI'), updatedBy: id('BUDI'),
      });
      expect(itemOf(await mine('BUDI'), 'MANDATORY_TRAINING')).toMatchObject({ done: true, source: 'link', doneAt: '2026-09-02T03:00:00.000Z' });
    });

    it('P18.5-T3 AC-2 a read-only session is shown it from memory, and writes nothing (N3)', async () => {
      await h.col('trainingProgress').insertOne({
        kpmId: KPM_A, membershipId: id('BUDI'), moduleCode: 'CLOSING_TECHNIQUES', status: 'done',
        startedAt: new Date('2026-09-01T03:00:00Z'), completedAt: new Date('2026-09-02T03:00:00Z'), opened: [], version: 2,
        deletedAt: null, createdBy: id('BUDI'), updatedBy: id('BUDI'),
      });
      h.as(h.supporting('BUDI'));
      const view = (await h.http().get('/activation/me').expect(200)).body;
      expect(itemOf(view, 'MANDATORY_TRAINING')).toMatchObject({ done: true, source: 'link' });
      const row = (await h.col('activationProgress').findOne({ _id: activation._id }))!;
      expect(row.items.find((i: { code: string }) => i.code === 'MANDATORY_TRAINING').done).toBe(false);
    });

    it('P18.5-T3 AC-3 nobody ticks it: 409 for the hire, every leader, and an elevated support session', async () => {
      h.as('BUDI');
      let res = await h.http().put('/activation/me/items/MANDATORY_TRAINING').send({ done: true }).expect(409);
      expect(res.body.error.code).toBe('ACTIVATION_ITEM_AUTOMATIC');
      for (const leader of ['SARI', 'AGUS', 'OWNER'] as const) {
        h.as(leader);
        res = await h.http().put(`/new-hires/${id('BUDI')}/items/MANDATORY_TRAINING`).send({ done: true }).expect(409);
        expect([leader, res.body.error.code]).toEqual([leader, 'ACTIVATION_ITEM_AUTOMATIC']);
      }
      h.as(h.supporting('SARI', false));
      res = await h.http().put(`/new-hires/${id('BUDI')}/items/MANDATORY_TRAINING`).send({ done: true }).expect(409);
      expect(res.body.error.code).toBe('ACTIVATION_ITEM_AUTOMATIC');
    });

    it('P18.5-T3 AC-3 a hand tick recorded before go-live stays done, and can no longer be unticked', async () => {
      await h.col('activationProgress').updateOne(
        { _id: activation._id },
        { $set: { 'items.$[i].done': true, 'items.$[i].source': 'hire', 'items.$[i].doneByMembershipId': id('BUDI'), 'items.$[i].doneAt': new Date('2026-08-01T03:00:00Z') } },
        { arrayFilters: [{ 'i.code': 'MANDATORY_TRAINING' }] },
      );
      expect(itemOf(await mine('BUDI'), 'MANDATORY_TRAINING')).toMatchObject({ done: true, source: 'hire' });
      await h.http().put('/activation/me/items/MANDATORY_TRAINING').send({ done: false }).expect(409);
      expect(itemOf(await mine('BUDI'), 'MANDATORY_TRAINING')).toMatchObject({ done: true, source: 'hire' });
    });

    it('P18.5-T3 AC-4 D-orphan: a bound module archived and published since is ticked by hand, served not live, its title kept, no route', async () => {
      await h.wired.training.archiveModule(h.office.as('OWNER'), (await h.moduleRow('CLOSING_TECHNIQUES')).id);
      await h.publish();
      expect(itemOf(await mine('BUDI'), 'MANDATORY_TRAINING').link).toMatchObject({
        kind: 'training:CLOSING_TECHNIQUES', label: 'Closing Techniques That Work', route: null, live: false,
      });

      h.as('BUDI');
      const view = (await h.http().put('/activation/me/items/MANDATORY_TRAINING').send({ done: true }).expect(200)).body;
      expect(itemOf(view, 'MANDATORY_TRAINING')).toMatchObject({ done: true, source: 'hire' });
      // A leader too.
      await h.http().put('/activation/me/items/MANDATORY_TRAINING').send({ done: false }).expect(200);
      h.as('SARI');
      await h.http().put(`/new-hires/${id('BUDI')}/items/MANDATORY_TRAINING`).send({ done: true }).expect(200);
    });

    it('P18.5-T3 AC-4 D-orphan: a done record made before the module was withdrawn still completes it', async () => {
      await h.col('trainingProgress').insertOne({
        kpmId: KPM_A, membershipId: id('BUDI'), moduleCode: 'CLOSING_TECHNIQUES', status: 'done',
        startedAt: new Date('2026-09-01T03:00:00Z'), completedAt: new Date('2026-09-02T03:00:00Z'), opened: [], version: 2,
        deletedAt: null, createdBy: id('BUDI'), updatedBy: id('BUDI'),
      });
      await h.wired.training.archiveModule(h.office.as('OWNER'), (await h.moduleRow('CLOSING_TECHNIQUES')).id);
      await h.publish();
      expect(itemOf(await mine('BUDI'), 'MANDATORY_TRAINING')).toMatchObject({ done: true, source: 'link' });
    });

    it('P18.5-T3 AC-4 a link to a module the office has never had reads as its code, goes to the catalog, and is ticked by hand', async () => {
      await h.bind(activation, 'MANDATORY_TRAINING', 'training:NO_SUCH_MODULE');
      expect(itemOf(await mine('BUDI'), 'MANDATORY_TRAINING').link).toMatchObject({
        kind: 'training:NO_SUCH_MODULE', label: 'NO_SUCH_MODULE', route: null, live: false,
      });
      h.as('BUDI');
      await h.http().put('/activation/me/items/MANDATORY_TRAINING').send({ done: true }).expect(200);
    });

    it('P18.5-T3 AC-2 a done row with no completion date completes the item now', async () => {
      await h.col('trainingProgress').insertOne({
        kpmId: KPM_A, membershipId: id('BUDI'), moduleCode: 'CLOSING_TECHNIQUES', status: 'done',
        startedAt: null, completedAt: null, opened: [], version: 2, deletedAt: null, createdBy: id('BUDI'), updatedBy: id('BUDI'),
      });
      expect(itemOf(await mine('BUDI'), 'MANDATORY_TRAINING')).toMatchObject({ done: true, source: 'link', doneAt: '2026-09-14T03:00:00.000Z' });
    });

    it('P18.5-T2 AC-3 the readings serve the offered catalog beside the rows, for 18.6', async () => {
      const catalog = await h.wired.trainingReadings.catalog(h.office.as('RINA'));
      expect(catalog.modules.get('CLOSING_TECHNIQUES')).toMatchObject({ skill: { code: 'CLOSING' }, category: { code: 'SALES' } });
    });

    it('P18.5 exit review (training review 1) D-orphan: an item its link completed stays the link’s — 409 for the hire and a leader, no audit, served live', async () => {
      h.as('BUDI');
      await mark('CLOSING_TECHNIQUES', 'done').expect(200);
      await h.wired.training.archiveModule(h.office.as('OWNER'), (await h.moduleRow('CLOSING_TECHNIQUES')).id);
      await h.publish();
      await h.col('auditLog').deleteMany({});

      // Not drawn as a hand tick — its link completed it, so nobody hand-edits it — and named by its real title, with no
      // *Go to* to a page that would not answer (the second training review, a).
      expect(itemOf(await mine('BUDI'), 'MANDATORY_TRAINING')).toMatchObject({
        done: true, source: 'link',
        link: { kind: 'training:CLOSING_TECHNIQUES', label: 'Closing Techniques That Work', route: null, live: true },
      });
      h.as('SARI');
      expect(itemOf((await h.http().get(`/new-hires/${id('BUDI')}`).expect(200)).body, 'MANDATORY_TRAINING').link)
        .toMatchObject({ label: 'Closing Techniques That Work', route: null, live: true });
      h.as('BUDI');
      for (const done of [false, true]) {
        const res = await h.http().put('/activation/me/items/MANDATORY_TRAINING').send({ done }).expect(409);
        expect(res.body.error.code).toBe('ACTIVATION_ITEM_AUTOMATIC');
      }
      h.as('SARI');
      await h.http().put(`/new-hires/${id('BUDI')}/items/MANDATORY_TRAINING`).send({ done: false }).expect(409);
      expect(await h.col('auditLog').countDocuments({ action: { $regex: '^activation\\.item_' } })).toBe(0);
      expect(itemOf(await mine('BUDI'), 'MANDATORY_TRAINING')).toMatchObject({ done: true, source: 'link', doneBy: { membershipId: id('BUDI') } });
    });

    it('P18.5 exit review (training review 1) D-orphan: a done progress row for the withdrawn module completes the item on the write’s own read, and the hand write is refused', async () => {
      await h.wired.training.archiveModule(h.office.as('OWNER'), (await h.moduleRow('CLOSING_TECHNIQUES')).id);
      await h.publish();
      await h.col('trainingProgress').insertOne({
        kpmId: KPM_A, membershipId: id('BUDI'), moduleCode: 'CLOSING_TECHNIQUES', status: 'done',
        startedAt: new Date('2026-09-01T03:00:00Z'), completedAt: new Date('2026-09-02T03:00:00Z'), opened: [], version: 2,
        deletedAt: null, createdBy: id('BUDI'), updatedBy: id('BUDI'),
      });
      h.as('BUDI');
      const res = await h.http().put('/activation/me/items/MANDATORY_TRAINING').send({ done: true }).expect(409);
      expect(res.body.error.code).toBe('ACTIVATION_ITEM_AUTOMATIC');
      const row = (await h.col('activationProgress').findOne({ _id: activation._id }))!;
      expect(row.items.find((i: { code: string }) => i.code === 'MANDATORY_TRAINING')).toMatchObject({ done: true, source: 'link' });
    });

    it('P18.5 exit review B2 a field reader’s link is named from what the office offers, never a working title', async () => {
      const module = await h.moduleRow('CLOSING_TECHNIQUES');
      await h.wired.training.updateModule(h.office.as('OWNER'), module.id, { title: 'Closing, renamed in the draft' });
      // Not yet published: the hire and the leader read the offered title.
      expect(itemOf(await mine('BUDI'), 'MANDATORY_TRAINING').link).toMatchObject({ label: 'Closing Techniques That Work' });
      h.as('SARI');
      expect(itemOf((await h.http().get(`/new-hires/${id('BUDI')}`).expect(200)).body, 'MANDATORY_TRAINING').link)
        .toMatchObject({ label: 'Closing Techniques That Work' });

      // Unpublished and published since: not offered, so its code, and the catalog — never the draft's title.
      await h.wired.training.updateModule(h.office.as('OWNER'), module.id, { publishState: 'draft' });
      await h.publish();
      // A draft's title is never named to a field reader: its code, and no route.
      expect(itemOf(await mine('BUDI'), 'MANDATORY_TRAINING').link).toMatchObject({
        label: 'CLOSING_TECHNIQUES', route: null, live: false,
      });
    });

    it('P18.5-T3 AC-5 the leader’s detail shows the same item, live, to the same page', async () => {
      h.as('SARI');
      const detail = (await h.http().get(`/new-hires/${id('BUDI')}`).expect(200)).body;
      expect(itemOf(detail, 'MANDATORY_TRAINING').link).toMatchObject({ live: true, route: '/training/SALES/CLOSING_TECHNIQUES' });
    });

    it('P18.5-T3 AC-7 bounded: one progress query for every training item waiting, none when nothing waits', async () => {
      const second = await h.start('RINA', '2026-07-20');
      await h.bind(second, 'MANDATORY_TRAINING', 'training:CLOSING_TECHNIQUES');
      const spy = jest.spyOn(h.wired.trainingReadings, 'rowsOf');
      try {
        const office = await new TenantDay(h.wired.kpms as never, h.clock).office(h.office.as('AGUS'));
        const docs = await h.wired.activationRows.find(h.office.as('AGUS'), {});
        await h.wired.activationProgress.resolve(h.office.as('AGUS'), docs, office);
        expect(spy).toHaveBeenCalledTimes(1);
        expect(spy.mock.calls[0][1]).toEqual(expect.arrayContaining([id('BUDI'), id('RINA')]));

        spy.mockClear();
        await h.bind(activation, 'MANDATORY_TRAINING', null);
        await h.wired.activationProgress.resolve(h.office.as('AGUS'), docs, office);
        expect(spy).toHaveBeenCalledTimes(0);
      } finally {
        spy.mockRestore();
      }
    });

    it('P18.5 exit review (training review 3) asks what is offered only while an open activation has a training item undone', async () => {
      const spy = jest.spyOn(h.wired.offeredTraining, 'moduleCodes');
      const ctx = h.office.as('BUDI');
      const office = await new TenantDay(h.wired.kpms as never, h.clock).office(ctx);
      try {
        await h.wired.activationProgress.resolve(ctx, [activation], office);
        expect(spy).toHaveBeenCalledTimes(1);

        h.as('BUDI');
        await mark('CLOSING_TECHNIQUES', 'done').expect(200);
        spy.mockClear();
        const [done] = await h.wired.activationRows.find(ctx, { _id: activation._id });
        await h.wired.activationProgress.resolve(ctx, [done], office);
        // The item is done: nothing waits on a training module, so nothing is read.
        expect(spy).toHaveBeenCalledTimes(0);
      } finally {
        spy.mockRestore();
      }
    });
  });
});
