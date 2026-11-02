import { Logger } from '@nestjs/common';
import { FixedClock } from '@/common/clock/clock.port';
import { RequestContext } from '@/common/context/request-context';
import { NotFoundException } from '@/common/errors/domain.exception';
import type { OfficePerson } from '../office-people';
import type { ComplianceCategoryRead, ComplianceScope } from './compliance-category';
import { ComplianceService } from './compliance.service';
import { TrainingComplianceCategory } from './training.category';

const NOW = new Date('2026-09-14T03:00:00Z');
const owner = new RequestContext('u-owner', 'none', {
  membershipId: 'ab', kpmId: 'kpm-a', orgLevelCode: 'AB', hierarchyRole: 'ab', status: 'active',
  isKpmOwner: true, isKpmAdmin: false, directCount: 1,
} as never);
const person = (membershipId: string, orgLevelCode: string, leaderId: string | null, ancestorIds: string[]): OfficePerson => ({
  // The default ladder's rungs, whose class is the code lower-cased (ADR-0156).
  membershipId, orgLevelCode, role: orgLevelCode.toLowerCase() as OfficePerson['role'], leaderId, ancestorIds, status: 'active', joinedAt: new Date('2026-01-02T02:00:00Z'),
  joinDate: '2026-01-02', joinDateStart: new Date('2026-01-01T17:00:00Z'), removedAt: null,
});

/** A category answering what it is told to, and remembering what it was asked. */
function category(answer: (scope: ComplianceScope, selection: { selected: boolean; item: string | null }) => Partial<ComplianceCategoryRead<unknown>>) {
  const asked: { selected: boolean; item: string | null }[] = [];
  return {
    asked,
    read: jest.fn(async (scope: ComplianceScope, selection: { selected: boolean; item: string | null }) => {
      asked.push(selection);
      return { catalog: null, chip: { count: 0, of: 0 }, item: null, cells: null, ...answer(scope, selection) };
    }),
  };
}

/**
 * **The tree's assembly, unit by unit** (P18.6-T1 AC-2, AC-8, AC-9): the branches the integration fixture cannot
 * reach — a name nobody can give, a category whose cells say nothing of a member, a category that refuses — over
 * fakes of the office's people and of the six categories. Behaviour over real records is `compliance.int.spec.ts`.
 */
describe('ComplianceService (P18.6-T1)', () => {
  const office = { today: '2026-09-14', month: '2026-09', timezone: 'Asia/Jakarta', settings: {}, companyId: 'c' };
  const build = (over: { names?: Map<string, string>; categories?: Partial<Record<string, ReturnType<typeof category>>> } = {}) => {
    const people = {
      read: jest.fn(async () => {
        const active = [person('ab', 'AB', null, []), person('agent', 'AGENT', 'ab', ['ab'])];
        return { everyone: active, active, names: over.names ?? new Map([['ab', 'Wilson'], ['agent', 'Rina']]) };
      }),
    };
    const subjectReads = { recordMany: jest.fn(async () => undefined) };
    const six = {
      training: category(() => ({ catalog: [] })),
      goals: category(() => ({ catalog: { year: '2026' } })),
      activity: category(() => ({})),
      activation: category(() => ({})),
      events: category(() => ({ catalog: [] })),
      campaigns: category(() => ({ catalog: [] })),
      ...over.categories,
    };
    const service = new ComplianceService(
      people as never, { office: async () => office } as never, new FixedClock(NOW), subjectReads as never,
      six.training as never, six.goals as never, six.activity as never, six.activation as never,
      six.events as never, six.campaigns as never,
    );
    return { service, subjectReads, six, people };
  };

  it('P18.6-T1 AC-2 reads training by default, asks every category once, the chosen one with its item', async () => {
    const { service, six } = build();
    const view = await service.read(owner);
    expect(view.selected).toEqual({ category: 'training', item: null });
    expect(six.training.asked).toEqual([{ selected: true, item: null }]);
    for (const key of ['goals', 'activity', 'activation', 'events', 'campaigns'] as const) {
      expect([key, six[key].asked]).toEqual([key, [{ selected: false, item: null }]]);
    }
    const { service: other, six: asked } = build();
    await other.read(owner, { category: 'events', item: 'evt-1' });
    expect(asked.events.asked).toEqual([{ selected: true, item: 'evt-1' }]);
    expect(asked.training.asked).toEqual([{ selected: false, item: null }]);
  });

  it('P18.6-T1 AC-1 an item on a single-item category is refused before anything is read', async () => {
    const { service, people, six } = build();
    await expect(service.read(owner, { category: 'activation', item: 'x' })).rejects.toMatchObject({
      code: 'VALIDATION_FAILED', details: { violations: [expect.stringContaining('item')] },
    });
    expect(people.read).not.toHaveBeenCalled();
    expect(six.activation.read).not.toHaveBeenCalled();
  });

  it('P18.6-T1 AC-8 a cell the category does not give — no cells, or none for a member — is the neutral one, out of every count', async () => {
    const { service } = build({
      categories: { activity: category((_, s) => ({ cells: s.selected ? new Map([['agent', { status: 'logged', done: true, on: '2026-09-14' }]]) : null })) },
    });
    const view = await service.read(owner, { category: 'activity' });
    expect(view.tree[0].units[0].rows.map((r) => [r.membershipId, r.cell])).toEqual([
      ['ab', { status: null, done: null, on: null }],
      ['agent', { status: 'logged', done: true, on: '2026-09-14' }],
    ]);
    expect([view.tree[0].done, view.tree[0].of]).toEqual([1, 1]);
    const { service: silent } = build();
    const none = await silent.read(owner, { category: 'goals' });
    expect(none.tree[0].units[0].rows.every((r) => r.cell.done === null)).toBe(true);
  });

  it('P18.6-T1 AC-8 a member nobody can name is listed under an empty name, never dropped', async () => {
    const { service } = build({ names: new Map([['ab', 'Wilson']]) });
    const view = await service.read(owner);
    expect(view.tree[0].units[0].rows.map((r) => [r.membershipId, r.name, r.leads, r.personal])).toEqual([
      ['ab', 'Wilson', true, true], ['agent', '', false, false],
    ]);
  });

  it('P18.6-T1 AC-9 exit review 5: the chosen category refusing its item is answered before any other chip reads, and nothing is audited', async () => {
    const { service, subjectReads, six } = build({
      categories: { training: category(() => { throw new NotFoundException('Training module'); }) },
    });
    await expect(service.read(owner, { category: 'training', item: 'OTHER' })).rejects.toMatchObject({ code: 'NOT_FOUND' });
    for (const key of ['goals', 'activity', 'activation', 'events', 'campaigns'] as const) {
      expect([key, six[key].read.mock.calls.length]).toEqual([key, 0]);
    }
    expect(subjectReads.recordMany).not.toHaveBeenCalled();
  });

  it('P18.6-T1 exit review 5: another chip failing is the server’s error, after every chip settles — never the chosen tab’s 404', async () => {
    const logged = jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    let settled = false;
    const { service, subjectReads } = build({
      categories: {
        goals: category(() => { throw new NotFoundException('Goal'); }),
        campaigns: category(() => { settled = true; return {}; }),
      },
    });
    const refusal = await service.read(owner, { category: 'activity' }).catch((err: unknown) => err);
    expect(refusal).toBeInstanceOf(Error);
    expect(refusal).not.toBeInstanceOf(NotFoundException);
    expect((refusal as Error).message).toBe('The goals chip could not be read.');
    expect((refusal as Error & { cause: unknown }).cause).toBeInstanceOf(NotFoundException);
    expect(settled).toBe(true);
    expect(subjectReads.recordMany).not.toHaveBeenCalled();
    expect(logged).toHaveBeenCalledWith(expect.objectContaining({ category: 'goals' }), 'a compliance chip could not be read');
    logged.mockRestore();
  });

  it('P18.6-T1 AC-9 the chosen category’s disclosure is written once, each subject from its own day; none without one', async () => {
    const { service, subjectReads } = build({
      categories: {
        activation: category((_, s) => (s.selected ? {
          cells: new Map(),
          disclosure: { surface: 'activation', subjects: [{ membershipId: 'agent', from: '2026-08-01' }, { membershipId: 'ab', from: null }] },
        } : {})),
      },
    });
    await service.read(owner, { category: 'activation' });
    expect(subjectReads.recordMany).toHaveBeenCalledTimes(1);
    const [, subjects, surface, range] = (subjectReads.recordMany.mock.calls[0] as unknown) as [unknown, unknown, string, (id: string) => unknown];
    expect([subjects, surface]).toEqual([[{ membershipId: 'agent', from: '2026-08-01' }, { membershipId: 'ab', from: null }], 'activation']);
    expect([range('agent'), range('ab')]).toEqual([{ from: '2026-08-01', to: '2026-09-14' }, { from: null, to: '2026-09-14' }]);

    const { service: quiet, subjectReads: none } = build();
    await quiet.read(owner, { category: 'goals' });
    expect(none.recordMany).not.toHaveBeenCalled();
  });

  it('P18.6-T1 AC-2 the scope: the office’s calendar year, start inclusive and end exclusive, and the tree’s members in order', async () => {
    const { service, six } = build();
    await service.read(owner);
    const scope = six.goals.read.mock.calls[0][0] as ComplianceScope;
    expect(scope.year).toEqual({
      from: '2026-01-01', to: '2026-12-31',
      start: new Date('2025-12-31T17:00:00Z'), end: new Date('2026-12-31T17:00:00Z'),
    });
    expect(scope.memberIds).toEqual(['ab', 'agent']);
    expect(scope.today).toBe('2026-09-14');
  });
});

describe('TrainingComplianceCategory — an office that offers nothing (P18.6-T1 AC-4)', () => {
  const scope = { ctx: owner, office: { timezone: 'Asia/Jakarta' }, today: '2026-09-14', memberIds: ['ab', 'agent'] } as never;
  const offered = (tree: unknown[]) => ({ tree: jest.fn(async () => tree) });
  const progress = (rows: unknown[] = []) => ({
    ofMany: jest.fn(async (_: unknown, ids: string[]) => new Map(ids.map((id) => [id, { allOfferedDone: false }]))),
    rowsOf: jest.fn(async () => rows),
  });

  it('P18.6-T1 AC-4 lists its empty categories, selects no module, draws every cell —, counts nobody and discloses nothing', async () => {
    const reader = progress();
    const category = new TrainingComplianceCategory(
      offered([{ code: 'PRODUCT', label: 'Product', skills: [{ code: 'EMPTY', label: 'Empty', modules: [] }] }]) as never,
      reader as never, new FixedClock(NOW),
    );
    const read = await category.read(scope, { selected: true, item: null });
    expect(read.catalog).toEqual([{ code: 'PRODUCT', label: 'Product', skills: [] }]);
    expect(read.item).toBeNull();
    expect(read.chip).toEqual({ count: 0, of: 0 });
    expect([...read.cells!.values()]).toEqual([{ status: null, done: null, on: null }, { status: null, done: null, on: null }]);
    expect(read.disclosure).toBeUndefined();
    expect(reader.rowsOf).not.toHaveBeenCalled();
  });

  it('P18.6-T1 AC-4 a module done before its day was kept is Completed with no day; asked unselected, it reads no rows', async () => {
    const reader = progress([{ membershipId: 'agent', moduleCode: 'M1', status: 'done', completedAt: null }]);
    const category = new TrainingComplianceCategory(
      offered([{ code: 'SALES', label: 'Sales', skills: [{ code: 'S', label: 'S', modules: [{ code: 'M1', title: 'One' }] }] }]) as never,
      reader as never, new FixedClock(NOW),
    );
    const read = await category.read(scope, { selected: true, item: null });
    expect(read.cells!.get('agent')).toEqual({ status: 'done', done: true, on: null });
    expect(read.chip).toEqual({ count: 0, of: 2 });
    const unselected = await category.read(scope, { selected: false, item: null });
    expect([unselected.item, unselected.cells, unselected.disclosure]).toEqual([null, null, undefined]);
    expect(reader.rowsOf).toHaveBeenCalledTimes(1);
  });
});
