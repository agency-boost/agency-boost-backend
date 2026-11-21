import type { RequestContext } from '@/common/context/request-context';
import type { DataUploadBatchRepository } from './data-upload-batch.repository';
import type { DataUploadRowRepository } from './data-upload-row.repository';
import { cellKey } from './upload-columns';

/** One figure as the month's standing uploads wrote it: the number, and the upload that wrote it last. */
export interface FileFigure {
  value: number;
  batchId: string;
}

/** A member's cell, as `fileFigures` keys it: the membership and the cell's key (`APE`, `KOMISI_YTD`). */
export const fileFigureKey = (membershipId: string, kode: string, ytd: boolean) => `${membershipId}|${cellKey(kode, ytd)}`;

/**
 * **The file's number behind each cell of a month** (P19.21-T1 AC-4; ADR-0274 §1): what the month's **standing**
 * uploads — committed, not reverted — wrote into each member's cell, the latest upload's figure where several wrote one.
 * The batch rows are the record of it (`dataUploadRows.values`), so a correction by hand, which overwrites the cell,
 * never loses the number the file gave: *"dari file: Rp 1.412.000"* reads it, and *Kembalikan ke angka dari file*
 * writes it back.
 *
 * Tenant-scoped throughout: both reads go through the repositories, which add the KPM.
 */
export async function fileFigures(
  ctx: RequestContext,
  batches: DataUploadBatchRepository,
  rows: DataUploadRowRepository,
  month: string,
): Promise<Map<string, FileFigure>> {
  const standing = await batches.find(ctx, { month, status: 'committed' }, { sort: { monthRevision: 1 } });
  const out = new Map<string, FileFigure>();
  if (standing.length === 0) return out;
  const order = new Map(standing.map((b, i) => [String(b._id), i]));
  const written = await rows.find(ctx, { batchId: { $in: [...order.keys()] }, membershipId: { $ne: null }, status: 'ready' });
  // Oldest upload first, so a later one's figure for the same cell is the one kept.
  written.sort((a, b) => (order.get(a.batchId) ?? 0) - (order.get(b.batchId) ?? 0));
  for (const row of written) {
    for (const [key, value] of Object.entries(row.values ?? {})) {
      if (typeof value !== 'number') continue;
      out.set(`${row.membershipId}|${key}`, { value, batchId: row.batchId });
    }
  }
  return out;
}
