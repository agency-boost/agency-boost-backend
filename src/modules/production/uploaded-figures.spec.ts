import { RequestContext } from '@/common/context/request-context';
import { fileFigureKey, fileFigures } from './uploaded-figures';

const ctx = RequestContext.tenantRead('66f0000000000000000000a1', 'uploaded-figures-spec');
const M = 1_000_000 * 100;

/** The two repositories over fakes: the month's standing uploads, oldest first, and the rows they wrote. */
function stores(batchIds: string[], written: Record<string, unknown>[]) {
  const asked: unknown[] = [];
  const batches = { find: async () => batchIds.map((_id) => ({ _id })) };
  const rows = { find: async (_ctx: unknown, filter: unknown) => { asked.push(filter); return written; } };
  return { batches: batches as never, rows: rows as never, asked };
}

/**
 * **The file's number behind each cell of a month** (P19.21-T1 AC-4; ADR-0274 §1): what *"dari file: Rp …"* reads and
 * *Kembalikan ke angka dari file* writes back — the latest standing upload's figure where several wrote one.
 */
describe('fileFigures — the file’s number behind each cell (P19.21-T1 AC-4)', () => {
  it('P19.21-T1 AC-4 a month with no standing upload has no file figure, and no row is read', async () => {
    const { batches, rows, asked } = stores([], [{ membershipId: 'm-1', batchId: 'b-1', values: { APE: 1 } }]);
    expect(await fileFigures(ctx, batches, rows, '2026-10')).toEqual(new Map());
    expect(asked).toEqual([]);
  });

  it('P19.21-T1 AC-4 the latest upload’s figure is kept, whatever order the rows come back in', async () => {
    const { batches, rows, asked } = stores(['b-old', 'b-new'], [
      { membershipId: 'm-1', batchId: 'b-new', values: { APE: 250 * M } },
      { membershipId: 'm-1', batchId: 'b-old', values: { APE: 240 * M, KOMISI_YTD: 9 * M } },
    ]);
    const figures = await fileFigures(ctx, batches, rows, '2026-10');
    expect(figures.get(fileFigureKey('m-1', 'APE', false))).toEqual({ value: 250 * M, batchId: 'b-new' });
    expect(figures.get(fileFigureKey('m-1', 'KOMISI', true))).toEqual({ value: 9 * M, batchId: 'b-old' });
    // The standing uploads' rows only, matched to a member and ready.
    expect(asked[0]).toEqual({ batchId: { $in: ['b-old', 'b-new'] }, membershipId: { $ne: null }, status: 'ready' });
  });

  it('P19.21-T1 AC-4 a row that wrote no figure, or a blank cell, gives the cell no file figure', async () => {
    const { batches, rows } = stores(['b-1'], [
      { membershipId: 'm-1', batchId: 'b-1' },
      { membershipId: 'm-2', batchId: 'b-1', values: { APE: null, KOMISI: 'x' } },
      { membershipId: 'm-3', batchId: 'b-1', values: { APE: 0 } },
    ]);
    const figures = await fileFigures(ctx, batches, rows, '2026-10');
    // Nought is a figure the file gave; a blank or a word is not.
    expect([...figures.keys()]).toEqual([fileFigureKey('m-3', 'APE', false)]);
    expect(figures.get(fileFigureKey('m-3', 'APE', false))).toEqual({ value: 0, batchId: 'b-1' });
  });
});
