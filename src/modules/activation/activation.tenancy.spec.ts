import { RequestContext } from '@/common/context/request-context';
import { SEED_ACTIVATION_ITEMS } from '@/domain/constants';
import type { ActivationService } from './activation.service';
import { clearCollections, startMongo, stopMongo } from '../../../test/mongo';
import { configModule, provisionOffice } from '../../../test/config-module';

const NOW = new Date('2026-09-18T02:00:00Z');
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
 * An office's 90-day activation checklist (P5-T3, ADR-0031). Named explicitly as the module's
 * isolation spec, which the tenancy gate requires the moment `/kpm/settings/activation-checklist`
 * ships.
 */
describe('the office activation checklist (P5-T3)', () => {
  let wired: ReturnType<typeof configModule>;
  let activation: ActivationService;

  beforeAll(async () => {
    await startMongo();
    wired = configModule(NOW);
    activation = wired.activation;
  });
  afterAll(stopMongo);

  beforeEach(async () => {
    await clearCollections();
    await provisionOffice(wired, KPM_A, COMPANY);
  });

  /** The whole checklist as a save takes it — the shape the screen sends back. */
  const asDraft = (view: Awaited<ReturnType<ActivationService['read']>>) => ({
    aspects: (view.draft ?? view.published)!.aspects.map((aspect) => ({
      code: aspect.code,
      label: aspect.label,
      items: aspect.items.map((i) => ({ code: i.code, label: i.label, autoLink: i.autoLink })),
    })),
  });

  describe('provisioning (AC-5)', () => {
    it('gives a new office the prototype’s checklist, published as version 1', async () => {
      const view = await activation.read(ctx(KPM_A));

      expect(view.draft).toBeNull();
      expect(view.published).toMatchObject({ version: 1, status: 'published' });
      expect(view.published!.aspects.map((a) => a.label)).toEqual([
        '1. Introduction', '2. Initial Setup', '3. Training & Certification',
        '4. First Sale', '5. Ongoing Habits',
      ]);
      expect(view.published!.aspects.flatMap((a) => a.items)).toHaveLength(16);
    });

    it('resolves each item’s link, so the screen knows what it is waiting for (AC-7)', async () => {
      const view = await activation.read(ctx(KPM_A));
      const items = view.published!.aspects.flatMap((a) => a.items);

      const goal = items.find((i) => i.code === 'GOAL_SETTING')!;
      // The whole link, not a subset: it says whether the link works, and never which phase makes
      // it work — a phase number is our schedule, not the Owner's (P10.1-T2 AC-13, ADR-0062 §3).
      expect(goal.link).toEqual({
        kind: 'feature:goals',
        label: 'Goal Settings',
        route: '/goals',
        completesWhen: 'the hire has saved any goal since joining',
        live: true,
      });
      expect(items.find((i) => i.code === 'CRM_SETUP')!.link).toBeNull();
    });

    it('reads the office’s own activation window beside it', async () => {
      const kpms = wired.kpms as unknown as {
        create(doc: Record<string, unknown>): Promise<unknown>;
      };
      await kpms.create({
        _id: KPM_A, companyId: COMPANY, code: '0417', branchName: 'BSD',
        settings: { activationWindowDays: 120 },
      });

      expect((await activation.read(ctx(KPM_A))).windowDays).toBe(120);
    });
  });

  describe('an office that has no checklist of its own', () => {
    /*
     * Provisioning gives a new office version 1, and migration 0012 gives one to every office that
     * already existed — but an office on a database the migration has not reached had neither, and
     * the screen had nothing to draw. Reported from a real office, where it surfaced as
     * "Could not reach the server".
     */
    it('opens on the standard checklist, unsaved, rather than on nothing', async () => {
      const view = await activation.read(ctx(KPM_B));

      expect(view.published).toBeNull();
      expect(view.draft).toMatchObject({ id: '', version: 1, status: 'draft', publishedAt: null });
      expect(view.draft!.aspects.flatMap((a) => a.items)).toHaveLength(16);
      // Its links resolve like any other, so the screen can say what each one waits for.
      expect(view.draft!.aspects.flatMap((a) => a.items).find((i) => i.code === 'GOAL_SETTING')!.link)
        .toMatchObject({ label: 'Goal Settings', live: true });
    });

    it('writes nothing until somebody saves it', async () => {
      await activation.read(ctx(KPM_B));
      expect(await activation.findVersion(ctx(KPM_B), 1)).toBeNull();

      const saved = await activation.saveDraft(ctx(KPM_B), {
        aspects: [{ code: 'START', label: 'Start', items: [{ code: 'FIRST_DAY', label: 'First day' }] }],
      });
      expect(saved.draft).toMatchObject({ version: 1, status: 'draft' });
      expect(saved.draft!.id).not.toBe('');

      const published = await activation.publish(ctx(KPM_B));
      expect(published.published).toMatchObject({ version: 1, status: 'published' });
    });
  });

  describe('isolation', () => {
    it('shows one office nothing of another’s, even when both have one', async () => {
      await provisionOffice(wired, KPM_B, OTHER_COMPANY);
      await activation.saveDraft(ctx(KPM_A), {
        aspects: [{ code: 'ONLY_A', label: 'Only A', items: [{ code: 'A_ITEM', label: 'A item' }] }],
      });

      const b = await activation.read(ctx(KPM_B));
      expect(b.draft).toBeNull();
      expect(b.published!.aspects.map((a) => a.code)).not.toContain('ONLY_A');
      expect(b.published!.aspects.flatMap((a) => a.items)).toHaveLength(16);
    });

    it('publishes only the caller’s office, leaving the other’s version where it was', async () => {
      await provisionOffice(wired, KPM_B, OTHER_COMPANY);
      const next = asDraft(await activation.read(ctx(KPM_A)));
      next.aspects[0].label = '1. Welcome';
      await activation.saveDraft(ctx(KPM_A), next);
      await activation.publish(ctx(KPM_A));

      expect((await activation.read(ctx(KPM_A))).published!.version).toBe(2);
      expect((await activation.read(ctx(KPM_B))).published!.version).toBe(1);
    });

    it('finds no version of another office’s checklist', async () => {
      await provisionOffice(wired, KPM_B, OTHER_COMPANY);

      expect(await activation.findVersion(ctx(KPM_B), 1)).not.toBeNull();
      // Same version number, different office: the read is scoped, so there is nothing to find.
      await clearCollections();
      await provisionOffice(wired, KPM_A, COMPANY);
      expect(await activation.findVersion(ctx(KPM_B), 1)).toBeNull();
    });
  });

  describe('draft, then publish (AC-1, AC-4)', () => {
    it('holds an edit in a draft, leaving the published version alone', async () => {
      const before = await activation.read(ctx(KPM_A));
      const next = asDraft(before);
      next.aspects[0].label = '1. Welcome';

      const after = await activation.saveDraft(ctx(KPM_A), next);

      expect(after.draft).toMatchObject({ version: 2, status: 'draft' });
      expect(after.draft!.aspects[0].label).toBe('1. Welcome');
      // Hires starting now still get what they were promised.
      expect(after.published!.version).toBe(1);
      expect(after.published!.aspects[0].label).toBe('1. Introduction');
    });

    it('publishes the draft as the next version, and leaves no draft behind', async () => {
      const next = asDraft(await activation.read(ctx(KPM_A)));
      next.aspects[0].items[0].label = 'Learn the basics';
      await activation.saveDraft(ctx(KPM_A), next);

      const after = await activation.publish(ctx(KPM_A));

      expect(after.draft).toBeNull();
      expect(after.published).toMatchObject({ version: 2, status: 'published' });
      expect(after.published!.aspects[0].items[0].label).toBe('Learn the basics');
    });

    it('keeps every published version readable by number, so a hire’s pin means something', async () => {
      const next = asDraft(await activation.read(ctx(KPM_A)));
      next.aspects[0].items[0].label = 'Learn the basics';
      await activation.saveDraft(ctx(KPM_A), next);
      await activation.publish(ctx(KPM_A));

      const one = await activation.findVersion(ctx(KPM_A), 1);
      const two = await activation.findVersion(ctx(KPM_A), 2);
      expect(one!.aspects[0].items[0].label).toBe('Learn insurance basics');
      expect(two!.aspects[0].items[0].label).toBe('Learn the basics');
      expect(await activation.findVersion(ctx(KPM_A), 3)).toBeNull();
    });

    it('refuses to publish when there is nothing to publish', async () => {
      await expect(activation.publish(ctx(KPM_A)))
        .rejects.toThrow(/nothing to publish/i);
    });

    /*
     * P13-T1 AC-2 (`functional/activation.md`, *Publishing*): a version number is what a hire's activation
     * pins, so a draft identical to the newest published version is refused rather than minted as one that
     * means nothing. Its order counts: a reorder alone is a change.
     */
    it('P13-T1 AC-2 refuses to publish a draft that is the same as the newest published version', async () => {
      const same = asDraft(await activation.read(ctx(KPM_A)));
      await activation.saveDraft(ctx(KPM_A), same);
      await expect(activation.publish(ctx(KPM_A))).rejects.toThrow(/same as version 1/);
      expect((await activation.read(ctx(KPM_A))).published!.version).toBe(1);

      same.aspects[0].items.reverse();
      await activation.saveDraft(ctx(KPM_A), same);
      expect((await activation.publish(ctx(KPM_A))).published!.version).toBe(2);
    });

    it('keeps codes across a rename and a reorder, which is what a hire’s progress points at', async () => {
      const next = asDraft(await activation.read(ctx(KPM_A)));
      next.aspects.reverse();
      next.aspects.forEach((aspect) => aspect.items.reverse());
      next.aspects[0].items[0].label = 'Renamed';

      const saved = await activation.saveDraft(ctx(KPM_A), next);
      const codes = saved.draft!.aspects.flatMap((a) => a.items.map((i) => i.code)).sort();

      expect(codes).toEqual(SEED_ACTIVATION_ITEMS.map((i) => i.code).sort());
      expect(saved.draft!.aspects[0].code).toBe('ONGOING_HABITS');
      expect(saved.draft!.aspects[0].displayOrder).toBe(1);
    });

    it('lets an Admin do what the Owner does (ADR-0028)', async () => {
      const next = asDraft(await activation.read(ctx(KPM_A)));
      next.aspects[0].label = '1. Induction';
      await activation.saveDraft(ctx(KPM_A, { admin: true }), next);

      expect((await activation.publish(ctx(KPM_A, { admin: true }))).published!.aspects[0].label)
        .toBe('1. Induction');
    });
  });

  describe('a training link names a module this office offers (AC-3)', () => {
    const withLink = async (code: string) => {
      const next = asDraft(await activation.read(ctx(KPM_A)));
      next.aspects[2].items[0].autoLink = `training:${code}`;
      return next;
    };

    it('accepts one the office publishes', async () => {
      const saved = await activation.saveDraft(ctx(KPM_A), await withLink('PROSPECT_LIST'));
      const item = saved.draft!.aspects[2].items[0];

      expect(item.autoLink).toBe('training:PROSPECT_LIST');
      // The link reads as the module's own title, not its code.
      expect(item.link).toEqual({
        kind: 'training:PROSPECT_LIST',
        label: 'Building Your Prospect List',
        route: '/training',
        completesWhen: 'the hire has completed that training module',
        live: false,
      });
    });

    it('refuses one the office does not have', async () => {
      await expect(activation.saveDraft(ctx(KPM_A), await withLink('NO_SUCH_MODULE')))
        .rejects.toThrow(/NO_SUCH_MODULE is not a training module in this office/);
    });

    it('refuses an archived module, naming why', async () => {
      const module = (await wired.training.list(ctx(KPM_A), true))
        .flatMap((c) => c.skills.flatMap((s) => s.modules))
        .find((m) => m.code === 'PROSPECT_LIST')!;
      await wired.training.archiveModule(ctx(KPM_A), module.id);

      await expect(activation.saveDraft(ctx(KPM_A), await withLink('PROSPECT_LIST')))
        .rejects.toThrow(/archived, so no agent is offered it/);
    });

    it('refuses a draft module, because no agent is offered one', async () => {
      const module = (await wired.training.list(ctx(KPM_A), true))
        .flatMap((c) => c.skills.flatMap((s) => s.modules))
        .find((m) => m.code === 'PROSPECT_LIST')!;
      await wired.training.updateModule(ctx(KPM_A), module.id, { publishState: 'draft' });

      await expect(activation.saveDraft(ctx(KPM_A), await withLink('PROSPECT_LIST')))
        .rejects.toThrow(/is a draft, so no agent is offered it/);
    });

    /*
     * The gap between saving and publishing is where a module can be withdrawn. Checking only at
     * save would publish a version with an item nothing can ever complete.
     */
    it('checks again at publish, after a module is archived in between', async () => {
      await activation.saveDraft(ctx(KPM_A), await withLink('PROSPECT_LIST'));
      const module = (await wired.training.list(ctx(KPM_A), true))
        .flatMap((c) => c.skills.flatMap((s) => s.modules))
        .find((m) => m.code === 'PROSPECT_LIST')!;
      await wired.training.archiveModule(ctx(KPM_A), module.id);

      await expect(activation.publish(ctx(KPM_A))).rejects.toThrow(/archived/);
    });
  });

  describe('what it refuses to store', () => {
    it('refuses a duplicate code before anything is written', async () => {
      const next = asDraft(await activation.read(ctx(KPM_A)));
      next.aspects[0].items[1].code = next.aspects[0].items[0].code;

      await expect(activation.saveDraft(ctx(KPM_A), next)).rejects.toThrow(/is used twice/);
      expect((await activation.read(ctx(KPM_A))).draft).toBeNull();
    });

    it('refuses a link this product does not have', async () => {
      const next = asDraft(await activation.read(ctx(KPM_A)));
      next.aspects[0].items[0].autoLink = 'feature:coaching';

      await expect(activation.saveDraft(ctx(KPM_A), next))
        .rejects.toThrow(/is not a link this product has/);
    });
  });
});
