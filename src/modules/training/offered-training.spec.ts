import { RequestContext } from '@/common/context/request-context';
import { indexCatalog, OfferedTraining } from './offered-training';
import type { TrainingCategoryView } from './training.service';

const ctx = RequestContext.forJob('66f0000000000000000000a1', 'offered-training-spec');

const TREE: TrainingCategoryView[] = [{
  id: 'c1', code: 'SALES', label: 'Sales', description: null, displayOrder: 1, version: 1, status: 'active',
  skills: [{
    id: 's1', code: 'CLOSING', categoryCode: 'SALES', label: 'Closing', description: null, displayOrder: 1, version: 1, status: 'active',
    modules: [{
      id: 'm1', code: 'CLOSING_TECHNIQUES', skillCode: 'CLOSING', title: 'Closing Techniques That Work', description: null,
      publishState: 'published', displayOrder: 1, version: 1, status: 'active',
    }],
  }],
}];

/**
 * **Offered = the office's published snapshot** (P18.2-T1 AC-3): the newest snapshot's training, `[]` for a
 * snapshot published before training existed, and — only for an office with no snapshot at all — the live
 * published rows, the fallback `TenantConfigService.readPublished` takes.
 */
describe('OfferedTraining (P18.2-T1 AC-3)', () => {
  const build = (snapshots: unknown[], live: TrainingCategoryView[] = []) => {
    const find = jest.fn().mockResolvedValue(snapshots);
    const offered = jest.fn().mockResolvedValue(live);
    return { service: new OfferedTraining({ find } as never, { offered } as never), find, offered };
  };

  it('P18.2-T1 AC-3 reads the newest snapshot’s training, and nothing live', async () => {
    const { service, find, offered } = build([{ payload: { training: TREE } }]);
    expect(await service.tree(ctx)).toBe(TREE);
    // Projected: the training tree and the version, never the office's whole configuration.
    expect(find).toHaveBeenCalledWith(ctx, {}, { sort: { version: -1 }, limit: 1, projection: { 'payload.training': 1, version: 1 } });
    expect(offered).not.toHaveBeenCalled();
  });

  it('P18.2-T1 AC-3 a snapshot published before training existed offers nothing', async () => {
    const { service } = build([{ payload: { activity: [] } }], TREE);
    expect(await service.tree(ctx)).toEqual([]);
  });

  it('P18.2-T1 AC-3 an office with no snapshot at all is offered its live published modules', async () => {
    const { service, offered } = build([], TREE);
    expect(await service.tree(ctx)).toBe(TREE);
    expect(offered).toHaveBeenCalledWith(ctx);
  });

  it('P18.2-T1 AC-3 indexes every offered module with its skill and category', async () => {
    const { service } = build([{ payload: { training: TREE } }]);
    const catalog = await service.catalog(ctx);
    expect(catalog.modules.get('CLOSING_TECHNIQUES')).toMatchObject({
      module: { title: 'Closing Techniques That Work' }, skill: { code: 'CLOSING' }, category: { code: 'SALES' },
    });
    expect([...(await service.moduleCodes(ctx))]).toEqual(['CLOSING_TECHNIQUES']);
    expect(indexCatalog([]).modules.size).toBe(0);
  });
});
