import { RequestContext } from '@/common/context/request-context';
import { indexCatalog } from './offered-training';
import { TrainingProgressReadings } from './training-progress-readings';
import type { TrainingCategoryView } from './training.service';

const ctx = RequestContext.forJob('66f0000000000000000000a1', 'readings-spec');
const at = new Date('2026-09-02T03:00:00Z');

const aModule = (code: string, skillCode: string, displayOrder = 1) => ({
  id: code, code, skillCode, title: `Title ${code}`, description: null, publishState: 'published' as const, displayOrder, version: 1, status: 'active' as const,
});
/** Sales offered with one skill and one module; everything else is history. */
const OFFERED: TrainingCategoryView[] = [{
  id: 'c1', code: 'SALES', label: 'Sales', description: 'Structured modules — tracked here.', displayOrder: 1, version: 1, status: 'active',
  skills: [{
    id: 's1', code: 'CLOSING', categoryCode: 'SALES', label: 'Closing', description: null, displayOrder: 4, version: 1, status: 'active',
    modules: [aModule('CLOSING_TECHNIQUES', 'CLOSING')],
  }],
}];

/** A module the office withdrew: archived. */
const withdrawn = (code: string, skillCode: string, displayOrder = 1) => ({ ...aModule(code, skillCode, displayOrder), status: 'archived' as const });

const progress = (moduleCode: string, status = 'done', completedAt: Date | null = at) => ({
  _id: `row-${moduleCode}`, membershipId: 'm1', moduleCode, status, startedAt: at, completedAt, opened: [],
});

/**
 * **`TrainingProgressReadings`'s edges** (P18.2-T2 AC-3, AC-4): the bounded read answering nothing for nobody without
 * a query, and D-history placed under the skill and category it belonged to — in their order, outside every count —
 * with a module whose place cannot be found left out rather than drawn somewhere wrong.
 */
describe('TrainingProgressReadings (P18.2-T2)', () => {
  const build = (rows: unknown[], live: { modules?: unknown[]; skills?: unknown[]; categories?: unknown[] } = {}) => {
    const find = jest.fn().mockResolvedValue(rows);
    const modules = { find: jest.fn().mockImplementation(async (_c, filter: { code: { $in: string[] }; status?: string }) => (
      (live.modules ?? []) as { code: string; status?: string }[])
      .filter((m) => filter.code.$in.includes(m.code) && (!filter.status || m.status === filter.status))) };
    const readings = new TrainingProgressReadings(
      { find } as never,
      { catalog: async () => indexCatalog(OFFERED) } as never,
      modules as never,
      { find: jest.fn().mockResolvedValue(live.skills ?? []) } as never,
      { find: jest.fn().mockResolvedValue(live.categories ?? []) } as never,
    );
    return { readings, find, modules };
  };

  it('P18.2-T2 AC-3 asks nothing for nobody, and nothing for no module', async () => {
    const { readings, find } = build([]);
    expect(await readings.rowsOf(ctx, [])).toEqual([]);
    expect(await readings.rowsOf(ctx, ['m1'], { moduleCodes: [] })).toEqual([]);
    expect((await readings.ofMany(ctx, [])).size).toBe(0);
    expect(find).not.toHaveBeenCalled();
  });

  it('P18.2-T2 AC-3 one query for many members, de-duplicated, filtered by module and status', async () => {
    const { readings, find } = build([]);
    await readings.rowsOf(ctx, ['m1', 'm2', 'm1'], { moduleCodes: ['A', 'A', 'B'], status: 'done' });
    expect(find).toHaveBeenCalledTimes(1);
    expect(find).toHaveBeenCalledWith(ctx, {
      membershipId: { $in: ['m1', 'm2'] }, moduleCode: { $in: ['A', 'B'] }, status: 'done',
    });
  });

  it('P18.2-T2 AC-3 performance: 500 members are read in a constant number of queries — never one per member', async () => {
    const members = Array.from({ length: 500 }, (_, i) => `m${i}`);
    const rows = members.flatMap((m) => [{ ...progress('CLOSING_TECHNIQUES'), membershipId: m, _id: `r-${m}` }]);
    const { readings, find, modules } = build(rows);
    const views = await readings.ofMany(ctx, members);
    expect(views.size).toBe(500);
    expect([...views.values()].every((v) => v.done === 1 && v.allOfferedDone)).toBe(true);
    // One query for every member's rows; one for the offered modules' content; no history, so nothing else.
    expect(find).toHaveBeenCalledTimes(1);
    expect(modules.find).toHaveBeenCalledTimes(1);
  });

  it('P18.2-T2 AC-4 places history under withdrawn skills of a withdrawn category, each in its order, outside the counts', async () => {
    const { readings } = build(
      [progress('RETAIN_TWO'), progress('RETAIN_ONE'), progress('SECOND_SKILL'), progress('CLOSING_TECHNIQUES', 'in_progress', null)],
      {
        modules: [
          withdrawn('RETAIN_ONE', 'RETENTION', 1), withdrawn('RETAIN_TWO', 'RETENTION', 2),
          { ...withdrawn('SECOND_SKILL', 'CROSS_SELL', 1), officeContent: { files: [], videos: [{ id: 'v' }], links: [{ id: 'l' }] } },
        ],
        skills: [
          { code: 'RETENTION', categoryCode: 'LEGACY', label: 'Retention', displayOrder: 6 },
          { code: 'CROSS_SELL', categoryCode: 'LEGACY', label: 'Cross-sell', displayOrder: 5 },
        ],
        categories: [{ code: 'LEGACY', label: 'Legacy', description: null, displayOrder: 9 }],
      },
    );
    const view = await readings.of(ctx, 'm1');
    expect([view.done, view.total, view.pct, view.allOfferedDone]).toEqual([0, 1, 0, false]);
    expect(view.categories.map((c) => [c.code, c.offered, c.done, c.total])).toEqual([['SALES', true, 0, 1], ['LEGACY', false, 0, 0]]);
    const legacy = view.categories[1];
    expect(legacy.skills.map((s) => [s.code, s.offered, s.archived.map((a) => a.code)])).toEqual([
      ['CROSS_SELL', false, ['SECOND_SKILL']],
      ['RETENTION', false, ['RETAIN_ONE', 'RETAIN_TWO']],
    ]);
    // A history row says what the module held, as an offered row's Format does.
    expect(legacy.skills[0].archived[0].formats).toEqual(['video', 'link']);
    expect(legacy.skills[1].archived[0].formats).toEqual([]);
    // In progress on an offered module: a status, never history.
    expect(view.categories[0].skills[0].modules[0]).toMatchObject({ code: 'CLOSING_TECHNIQUES', status: 'in_progress', completedAt: null });
  });

  it('P18.2-T2 AC-4 a module whose skill or category cannot be found is left out, never drawn somewhere wrong', async () => {
    const { readings } = build(
      [progress('NO_SKILL'), progress('NO_CATEGORY'), progress('GONE')],
      {
        modules: [withdrawn('NO_SKILL', 'MISSING'), withdrawn('NO_CATEGORY', 'ORPHANED')],
        skills: [{ code: 'ORPHANED', categoryCode: 'MISSING', label: 'Orphaned', displayOrder: 1 }],
      },
    );
    const view = await readings.of(ctx, 'm1');
    expect(view.categories.map((c) => c.code)).toEqual(['SALES']);
    expect(view.categories[0].skills.flatMap((s) => s.archived)).toEqual([]);
  });

  it('P18.2 exit review (training review 2) a done module set back to draft is not history: neither offered nor archived', async () => {
    const { readings } = build(
      [progress('BACK_TO_DRAFT')],
      {
        modules: [{ ...aModule('BACK_TO_DRAFT', 'CLOSING'), publishState: 'draft' }],
        skills: [{ code: 'CLOSING', categoryCode: 'SALES', label: 'Closing', displayOrder: 4 }],
        categories: [{ code: 'SALES', label: 'Sales', description: null, displayOrder: 1 }],
      },
    );
    const view = await readings.of(ctx, 'm1');
    expect(view.categories.flatMap((c) => c.skills.flatMap((s) => s.archived))).toEqual([]);
    expect(JSON.stringify(view)).not.toContain('BACK_TO_DRAFT');
  });

  it('P18.2-T2 AC-2 a done row with no completion date reads done, dated nothing', async () => {
    const { readings } = build([progress('CLOSING_TECHNIQUES', 'done', null)]);
    const view = await readings.of(ctx, 'm1');
    expect(view.categories[0].skills[0].modules[0]).toMatchObject({ status: 'done', completedAt: null });
    expect([view.done, view.total, view.allOfferedDone]).toEqual([1, 1, true]);
  });
});
