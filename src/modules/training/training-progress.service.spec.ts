import { FixedClock } from '@/common/clock/clock.port';
import { RequestContext } from '@/common/context/request-context';
import { CoachResolver } from '@/modules/org/coach-resolver';
import { TrainingProgressService } from './training-progress.service';

const NOW = new Date('2026-09-14T03:00:00Z');
const KPM = '66f0000000000000000000a1';
const ME = '66f00000000000000000aaaa';
const agent = new RequestContext('u1', 'none', {
  membershipId: ME, kpmId: KPM, orgLevelCode: 'AGENT', hierarchyRole: 'agent', status: 'active',
  isKpmOwner: false, isKpmAdmin: false, directCount: 0,
});
const OFFERED = {
  module: { code: 'CLOSING_TECHNIQUES', title: 'Closing Techniques That Work' },
  skill: { code: 'CLOSING', label: 'Closing' },
  category: { code: 'SALES', label: 'Sales' },
};
const doc = (over: Record<string, unknown> = {}) => ({
  _id: 'row-1', membershipId: ME, moduleCode: 'CLOSING_TECHNIQUES', status: 'not_started', startedAt: null,
  completedAt: null, opened: [], ...over,
});
const DUPLICATE = Object.assign(new Error('E11000'), { code: 11000 });

/**
 * **The writes' races** (P18.5-T1 AC-7, D-opened): the paths an HTTP spec cannot time — a concurrent write that
 * changes the status between the read and the conditional update, two first writes meeting the unique index, and
 * two first opens of one item. Each is decided again on what is there now, and the audit's `before` is always the
 * value actually replaced.
 */
describe('TrainingProgressService — races (P18.5-T1)', () => {
  const build = (rows: Record<string, jest.Mock>) => {
    const audit = { record: jest.fn() };
    const activation = { recorded: jest.fn() };
    const service = new TrainingProgressService(
      rows as never,
      {} as never,
      { catalog: async () => ({ modules: new Map([['CLOSING_TECHNIQUES', OFFERED]]) }) } as never,
      { readContent: async () => ({ content: { files: [], videos: [], links: [{ id: 'L1', label: 'Talk', url: 'https://x.test/t' }] } }) } as never,
      // The real resolver: a caller with no membership is refused by it before any read.
      new CoachResolver({} as never), {} as never, {} as never,
      audit as never,
      new FixedClock(NOW),
      activation as never,
    );
    return { service, audit, activation };
  };

  it('P18.5-T1 AC-7 a status changed under the write is decided again, and the audit names what was replaced', async () => {
    const findOne = jest.fn()
      .mockResolvedValueOnce(doc({ status: 'not_started' })) // read
      .mockResolvedValueOnce(doc({ status: 'in_progress', startedAt: NOW })); // read again, after the miss
    const updateWhere = jest.fn()
      .mockResolvedValueOnce(null) // somebody moved it first
      .mockResolvedValueOnce(doc({ status: 'done', startedAt: NOW, completedAt: NOW }));
    const { service, audit, activation } = build({ findOne, updateWhere, create: jest.fn() });

    const page = await service.setStatus(agent, 'closing_techniques', 'done');
    expect(page).toMatchObject({ status: 'done', completedAt: NOW.toISOString() });
    expect(updateWhere).toHaveBeenLastCalledWith(agent, { _id: 'row-1', status: 'in_progress' }, expect.anything());
    // startedAt is not rewritten on the second attempt: it was set by the first move.
    expect(updateWhere.mock.calls[1][2].$set).not.toHaveProperty('startedAt');
    expect(audit.record).toHaveBeenCalledWith(agent, expect.objectContaining({
      before: { moduleCode: 'CLOSING_TECHNIQUES', status: 'in_progress' },
      after: { moduleCode: 'CLOSING_TECHNIQUES', status: 'done' },
    }));
    expect(activation.recorded).toHaveBeenCalledWith(agent, ME, 'training');
  });

  it('P18.5-T1 AC-7 a status somebody else already set to the same value writes nothing and audits nothing', async () => {
    const findOne = jest.fn()
      .mockResolvedValueOnce(doc({ status: 'in_progress' }))
      .mockResolvedValueOnce(doc({ status: 'done', completedAt: NOW }))
      .mockResolvedValueOnce(doc({ status: 'done', completedAt: NOW }));
    const updateWhere = jest.fn().mockResolvedValueOnce(null);
    const { service, audit, activation } = build({ findOne, updateWhere, create: jest.fn() });
    expect((await service.setStatus(agent, 'CLOSING_TECHNIQUES', 'done')).status).toBe('done');
    expect(audit.record).not.toHaveBeenCalled();
    expect(activation.recorded).not.toHaveBeenCalled();
  });

  it('P18.5-T1 AC-2 two first writes meet the unique index: the loser is decided again as an update', async () => {
    const findOne = jest.fn().mockResolvedValueOnce(null).mockResolvedValueOnce(doc({ status: 'in_progress', startedAt: NOW }));
    const create = jest.fn().mockRejectedValueOnce(DUPLICATE);
    const updateWhere = jest.fn().mockResolvedValueOnce(doc({ status: 'done', startedAt: NOW, completedAt: NOW }));
    const { service } = build({ findOne, create, updateWhere });
    expect((await service.setStatus(agent, 'CLOSING_TECHNIQUES', 'done')).status).toBe('done');
    expect(create).toHaveBeenCalledTimes(1);
    expect(updateWhere).toHaveBeenCalledTimes(1);
  });

  it('a write that fails for any reason but a duplicate is thrown, not retried', async () => {
    const boom = new Error('disk full');
    const { service } = build({ findOne: jest.fn().mockResolvedValue(null), create: jest.fn().mockRejectedValue(boom), updateWhere: jest.fn() });
    await expect(service.setStatus(agent, 'CLOSING_TECHNIQUES', 'done')).rejects.toBe(boom);
  });

  it('a status that keeps changing under the write gives up after three attempts rather than looping', async () => {
    const findOne = jest.fn().mockResolvedValue(doc({ status: 'in_progress' }));
    const updateWhere = jest.fn().mockResolvedValue(null);
    const { service } = build({ findOne, updateWhere, create: jest.fn() });
    await expect(service.setStatus(agent, 'CLOSING_TECHNIQUES', 'done')).rejects.toThrow(/kept changing/);
    expect(updateWhere).toHaveBeenCalledTimes(3);
  });

  describe('opening (D-opened)', () => {
    it('P18.5-T1 AC-6 two first opens: the loser of the create is recorded by the update', async () => {
      const findOne = jest.fn().mockResolvedValueOnce(null);
      const create = jest.fn().mockRejectedValueOnce(DUPLICATE);
      const updateWhere = jest.fn().mockResolvedValueOnce(doc({ opened: [{ itemId: 'L1', at: NOW }] }));
      const { service } = build({ findOne, create, updateWhere });
      expect(await service.open(agent, 'CLOSING_TECHNIQUES', 'L1')).toEqual({
        url: 'https://x.test/t', openedItemIds: ['L1'], recorded: true,
      });
      expect(updateWhere).toHaveBeenCalledWith(
        agent, { membershipId: ME, moduleCode: 'CLOSING_TECHNIQUES', 'opened.itemId': { $ne: 'L1' } }, expect.anything(),
      );
    });

    it('P18.5-T1 AC-6 an open a racing request recorded first is answered, and not recorded twice', async () => {
      const findOne = jest.fn()
        .mockResolvedValueOnce(doc())
        .mockResolvedValueOnce(doc({ opened: [{ itemId: 'L1', at: NOW }] }));
      const updateWhere = jest.fn().mockResolvedValueOnce(null);
      const { service } = build({ findOne, create: jest.fn(), updateWhere });
      expect(await service.open(agent, 'CLOSING_TECHNIQUES', 'L1')).toEqual({
        url: 'https://x.test/t', openedItemIds: ['L1'], recorded: false,
      });
    });

    it('a create that fails for any reason but a duplicate is thrown', async () => {
      const boom = new Error('disk full');
      const { service } = build({ findOne: jest.fn().mockResolvedValue(null), create: jest.fn().mockRejectedValue(boom), updateWhere: jest.fn() });
      await expect(service.open(agent, 'CLOSING_TECHNIQUES', 'L1')).rejects.toBe(boom);
    });
  });

  it('P18.5-T3 AC-2 with no activation wired (a hand-built instance), a move to done still answers', async () => {
    const findOne = jest.fn().mockResolvedValueOnce(null);
    const create = jest.fn().mockResolvedValueOnce(doc({ status: 'done', startedAt: NOW, completedAt: NOW }));
    const service = new TrainingProgressService(
      { findOne, create, updateWhere: jest.fn() } as never, {} as never,
      { catalog: async () => ({ modules: new Map([['CLOSING_TECHNIQUES', OFFERED]]) }) } as never,
      { readContent: async () => ({ content: { files: [], videos: [], links: [] } }) } as never,
      new CoachResolver({} as never), {} as never, {} as never, { record: jest.fn() } as never, new FixedClock(NOW),
    );
    expect((await service.setStatus(agent, 'CLOSING_TECHNIQUES', 'done')).status).toBe('done');
  });

  it('P18.5-T1 AC-1 a caller with no membership is refused before anything is read', async () => {
    const { service } = build({ findOne: jest.fn(), create: jest.fn(), updateWhere: jest.fn() });
    const platform = RequestContext.platform('root');
    await expect(service.progress(platform)).rejects.toMatchObject({ code: 'TENANT_NO_MEMBERSHIP' });
    await expect(service.module(platform, 'CLOSING_TECHNIQUES')).rejects.toMatchObject({ code: 'TENANT_NO_MEMBERSHIP' });
    await expect(service.setStatus(platform, 'CLOSING_TECHNIQUES', 'done')).rejects.toMatchObject({ code: 'TENANT_NO_MEMBERSHIP' });
  });
});
