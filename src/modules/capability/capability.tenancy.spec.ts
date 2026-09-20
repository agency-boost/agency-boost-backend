import mongoose from 'mongoose';
import { RequestContext } from '@/common/context/request-context';
import {
  SEED_CAPABILITY_GRIDS, SEED_CAPABILITY_MILESTONES, SEED_CAPABILITY_STAGES,
  capabilityStageFor,
} from '@/domain/constants';
import { clearCollections, startMongo, stopMongo } from '../../../test/mongo';
import { configModule, provisionOffice } from '../../../test/config-module';
import { capabilityLadderProblems, defaultCapabilityLadder } from './capability-payload';

const NOW = new Date('2026-09-18T02:00:00Z');
const KPM_A = '66f0000000000000000000a1';
const KPM_B = '66f0000000000000000000b1';
const COMPANY = '66f0000000000000000000c1';

const member = (kpmId: string) => new RequestContext('u1', 'none', {
  membershipId: `mem-${kpmId}`, kpmId, orgLevelCode: 'AB', hierarchyRole: 'ab',
  status: 'active', isKpmOwner: true, isKpmAdmin: false, directCount: 0,
} as never);

/**
 * The office's capability catalog (P5-T8, ADR-0025, ADR-0036).
 *
 * The defect this task exists to close: **two of the prototype's four grids have no ids at all**,
 * so a tick is bound to the label text and renaming an item orphans every record that used it. What
 * is proved here is that no item is special — every one carries a code, a rename never moves one,
 * and a code is never reused.
 */
describe('the capability catalog (P5-T8)', () => {
  let wired: ReturnType<typeof configModule>;

  beforeAll(async () => {
    await startMongo();
    wired = configModule(NOW);
  });
  afterAll(stopMongo);

  beforeEach(async () => {
    await clearCollections();
    await provisionOffice(wired, KPM_A, COMPANY);
    await provisionOffice(wired, KPM_B, COMPANY);
  });

  describe('the seed (AC-1, AC-2)', () => {
    it('is the prototype’s four stages, five milestones and four grids of 7, 6, 7 and 7', () => {
      expect(SEED_CAPABILITY_STAGES.map((s) => s.label)).toEqual([
        'Competent Producer', 'Independent Producer',
        'Productive Team Builder', 'Transformative Team Builder',
      ]);
      expect(SEED_CAPABILITY_MILESTONES).toHaveLength(5);
      expect(SEED_CAPABILITY_GRIDS.map((g) => g.items.length)).toEqual([7, 6, 7, 7]);
    });

    it('gives every item a code — including the two grids the prototype keys by label', () => {
      // `downlineAgentSkills` and `downlineLeaderSkills` carry `{ label }` and nothing else.
      const unkeyed = SEED_CAPABILITY_GRIDS.filter((g) => g.requiresDownline);
      expect(unkeyed).toHaveLength(2);
      for (const grid of unkeyed) {
        expect(grid.items.every((i) => /^[A-Z][A-Z0-9_]*$/.test(i.code))).toBe(true);
      }

      // And every code in the catalog is unique, across all three lists.
      const all = [
        ...SEED_CAPABILITY_STAGES.map((s) => s.code),
        ...SEED_CAPABILITY_MILESTONES.map((m) => m.code),
        ...SEED_CAPABILITY_GRIDS.flatMap((g) => [g.code, ...g.items.map((i) => i.code)]),
      ];
      expect(new Set(all).size).toBe(all.length);
    });

    it('keeps the ladder strictly cumulative, by name rather than by count', () => {
      const codes = SEED_CAPABILITY_STAGES.map((s) => [...s.requiredMilestoneCodes]);
      for (let i = 1; i < codes.length; i += 1) {
        expect(codes[i]).toEqual(expect.arrayContaining(codes[i - 1]));
      }
      expect(codes.map((c) => c.length)).toEqual([1, 2, 4, 5]);
    });
  });

  describe('two offices from one version hold identical codes (AC-3)', () => {
    it('seeds both the same, item for item', async () => {
      const a = await wired.capability.read(member(KPM_A));
      const b = await wired.capability.read(member(KPM_B));

      const codes = (view: typeof a) => [
        ...view.stages.map((s) => s.code),
        ...view.milestones.map((m) => m.code),
        ...view.grids.flatMap((g) => [g.code, ...g.items.map((i) => i.code)]),
      ];
      expect(codes(a)).toEqual(codes(b));
      expect(a.grids.map((g) => g.items.length)).toEqual([7, 6, 7, 7]);
    });

    it('keeps one office’s edits out of the other’s', async () => {
      await wired.capability.rename(member(KPM_A), 'grid', 'PERSONAL_SELLING', 'Selling skills');

      expect((await wired.capability.read(member(KPM_A))).grids[0].label).toBe('Selling skills');
      expect((await wired.capability.read(member(KPM_B))).grids[0].label).toBe('Personal selling');
    });
  });

  describe('a code is the identity (AC-4)', () => {
    it('renames a label and never the code', async () => {
      const before = (await wired.capability.read(member(KPM_A)))
        .grids[0].items.find((i) => i.code === 'APPROACH')!;

      const after = await wired.capability.rename(
        member(KPM_A), 'item', 'APPROACH', 'Approaching and booking', 'PERSONAL_SELLING',
      );

      const item = after.grids[0].items.find((i) => i.code === 'APPROACH')!;
      expect(item.label).toBe('Approaching and booking');
      // The prototype binds a tick to the label, so this rename would orphan every record.
      expect(item.code).toBe(before.code);
    });

    it('archives an item and keeps it readable, and restores it', async () => {
      const archived = await wired.capability.setStatus(
        member(KPM_A), 'item', 'AFTER_SALES', 'archived', 'PERSONAL_SELLING',
      );
      expect(archived.grids[0].items.find((i) => i.code === 'AFTER_SALES')!.status)
        .toBe('archived');

      const restored = await wired.capability.setStatus(
        member(KPM_A), 'item', 'AFTER_SALES', 'active', 'PERSONAL_SELLING',
      );
      expect(restored.grids[0].items.find((i) => i.code === 'AFTER_SALES')!.status).toBe('active');
    });

    it('refuses to archive a milestone a stage still requires', async () => {
      // That stage would become unreachable, silently, for everybody.
      await expect(wired.capability.setStatus(
        member(KPM_A), 'milestone', 'SELLS_INDEPENDENTLY', 'archived',
      )).rejects.toThrow(/would make those stages unreachable/);
    });

    it('never reuses a code, archived rows included', async () => {
      await wired.capability.setStatus(
        member(KPM_A), 'item', 'AFTER_SALES', 'archived', 'PERSONAL_SELLING',
      );

      await expect(wired.capability.add(
        member(KPM_A), 'item', 'AFTER_SALES', 'Something else', 'PERSONAL_SELLING',
      )).rejects.toThrow(/never reused/);
    });

    it('has no delete, for anything', () => {
      for (const name of ['delete', 'remove', 'deleteItem', 'removeGrid']) {
        expect(wired.capability).not.toHaveProperty(name);
      }
    });

    it('adds an item with a code the office chooses once', async () => {
      const view = await wired.capability.add(
        member(KPM_A), 'item', 'referrals', 'Asking for referrals', 'PERSONAL_SELLING',
      );

      const added = view.grids[0].items.find((i) => i.code === 'REFERRALS')!;
      expect(added).toMatchObject({ label: 'Asking for referrals', displayOrder: 8 });
    });
  });

  describe('a broken payload never reaches an office (AC-5)', () => {
    it('passes the defaults', () => {
      expect(capabilityLadderProblems(defaultCapabilityLadder())).toEqual([]);
    });

    it('refuses a catalog with no stages, and one with no milestones', () => {
      expect(capabilityLadderProblems({ stages: [], milestones: [], grids: [] }))
        .toEqual(expect.arrayContaining([
          expect.stringMatching(/no stages/),
          expect.stringMatching(/no milestones/),
        ]));
    });

    it('refuses a duplicate code anywhere in the catalog', () => {
      const payload = defaultCapabilityLadder();
      payload.grids[1].items[0].code = 'LEADS_GEN';

      expect(capabilityLadderProblems(payload))
        .toEqual(expect.arrayContaining([expect.stringMatching(/LEADS_GEN is used twice/)]));
    });

    it('refuses an item with no code — the defect this task exists to close', () => {
      const payload = defaultCapabilityLadder();
      (payload.grids[2].items[0] as { code: string }).code = '';

      expect(capabilityLadderProblems(payload))
        .toEqual(expect.arrayContaining([expect.stringMatching(/has no code/)]));
    });

    it('refuses a stage requiring a milestone nobody defined', () => {
      const payload = defaultCapabilityLadder();
      payload.stages[0].requiredMilestoneCodes = ['NOT_A_MILESTONE'];

      expect(capabilityLadderProblems(payload))
        .toEqual(expect.arrayContaining([expect.stringMatching(/nobody could ever reach it/)]));
    });

    it('refuses two stages at the same seniority', () => {
      const payload = defaultCapabilityLadder();
      payload.stages[1].stageOrder = 1;

      expect(capabilityLadderProblems(payload))
        .toEqual(expect.arrayContaining([expect.stringMatching(/share stageOrder 1/)]));
    });

    /*
     * The four rules below were written with the rest and then never exercised — the branch that
     * raises each one was the whole of this module's coverage gap, and a validation rule nothing
     * calls is indistinguishable from one that was deleted. Each stops a payload that publishes
     * silently and breaks an office only when a leader opens an assessment.
     */
    it('refuses a part that is not a list at all, rather than reading it as empty', () => {
      // `{ stages: {} }` is what a hand-edited template or a half-migrated row looks like, and
      // treating it as an empty list would report "no stages" — true, but not what is wrong.
      expect(capabilityLadderProblems({ stages: {}, milestones: null, grids: 'none' }))
        .toEqual(expect.arrayContaining([
          expect.stringMatching(/stages must be a list/),
          expect.stringMatching(/milestones must be a list/),
          expect.stringMatching(/grids must be a list/),
        ]));
    });

    it('refuses a stage whose seniority is not a whole number of 1 or more', () => {
      // `stageOrder` is how senior a stage is, and the comparison that finds "the highest
      // reached" is numeric — a 0, a 1.5 or a "second" makes it meaningless rather than wrong.
      for (const bad of [0, -1, 1.5, 'second', null]) {
        const payload = defaultCapabilityLadder();
        (payload.stages[0] as { stageOrder: unknown }).stageOrder = bad;

        expect(capabilityLadderProblems(payload))
          .toEqual(expect.arrayContaining([expect.stringMatching(/stageOrder of 1 or more/)]));
      }
    });

    it('refuses a stage that requires nothing, because everybody is already on it', () => {
      const payload = defaultCapabilityLadder();
      payload.stages[0].requiredMilestoneCodes = [];

      expect(capabilityLadderProblems(payload))
        .toEqual(expect.arrayContaining([expect.stringMatching(/requires no milestone/)]));
    });

    it('refuses a grid with nothing in it to assess', () => {
      const payload = defaultCapabilityLadder();
      payload.grids[0].items = [];

      expect(capabilityLadderProblems(payload))
        .toEqual(expect.arrayContaining([expect.stringMatching(/has no items/)]));
    });
  });

  describe('the stage comes from the milestones, not from a position (AC-6)', () => {
    it('is the highest stage whose milestones are all ticked', () => {
      const stages = [...SEED_CAPABILITY_STAGES];

      expect(capabilityStageFor(stages, [])).toBeNull();
      expect(capabilityStageFor(stages, ['SELLS_INDEPENDENTLY'])!.code)
        .toBe('COMPETENT_PRODUCER');
      expect(capabilityStageFor(stages, ['SELLS_INDEPENDENTLY', 'SELLS_OUTSIDE_NETWORK'])!.code)
        .toBe('INDEPENDENT_PRODUCER');
    });

    it('is unmoved by reordering the ladder on screen', async () => {
      const ctx = member(KPM_A);
      const before = await wired.capability.stageFor(ctx, ['SELLS_INDEPENDENTLY']);

      // The prototype works the stage out from the stage's index in its own array, so tidying the
      // ladder for readability would move everybody.
      await wired.capability.reorder(ctx, 'stage', [
        'TRANSFORMATIVE_TEAM_BUILDER', 'PRODUCTIVE_TEAM_BUILDER',
        'INDEPENDENT_PRODUCER', 'COMPETENT_PRODUCER',
      ]);

      const after = await wired.capability.stageFor(ctx, ['SELLS_INDEPENDENTLY']);
      expect(after!.code).toBe(before!.code);
      expect(after!.stageOrder).toBe(before!.stageOrder);
      // The display order did move, which is the point of the control.
      expect((await wired.capability.read(ctx)).stages[0].code)
        .toBe('TRANSFORMATIVE_TEAM_BUILDER');
    });

    it('refuses a partial reorder', async () => {
      await expect(wired.capability.reorder(member(KPM_A), 'stage', ['COMPETENT_PRODUCER']))
        .rejects.toThrow(/4 of them/);
    });
  });

  describe('isolation', () => {
    it('gives each office exactly one catalog', async () => {
      const rows = await mongoose.connection.db!
        .collection('capabilityCatalogs').countDocuments({});
      expect(rows).toBe(2);
    });

    it('refuses a caller who is in no office', async () => {
      await expect(wired.capability.read(new RequestContext('u2', 'none', null)))
        .rejects.toThrow();
    });
  });
});
