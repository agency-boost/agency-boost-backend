import { Logger } from '@nestjs/common';
import { RequestContext } from '@/common/context/request-context';

/**
 * **A month of the office's file is about to change, and has changed** (P19.5-T3 AC-9; ADR-0215 §6; AA UI-023): an
 * import committed or reverted, a figure corrected by hand. *Advanced analytics*' Quant runs answer (`QuantRuns`):
 *
 * - **before** the write, a run past its freeze (00:00 on the 16th of the month after its period) is frozen as it stands,
 *   so the write cannot move it;
 * - **after** it, a live run that reads the month is recalculated, and a frozen one is marked *"Data diunggah setelah
 *   periode dikunci"*.
 *
 * A port rather than an import, so production does not depend on reporting. **Synchronous, failing open**, as
 * `SalesEvents` is: the write has happened, or is about to, whatever the runs do; the next read of the run heals it.
 */
export abstract class ProductionWrites {
  abstract beforeWrite(ctx: RequestContext, month: string): Promise<void>;
  abstract afterWrite(ctx: RequestContext, month: string): Promise<void>;
}

const logger = new Logger('ProductionWrites');

export async function signalBeforeWrite(port: ProductionWrites | null | undefined, ctx: RequestContext, month: string): Promise<void> {
  if (!port) return;
  try {
    await port.beforeWrite(ctx, month);
  } catch (err) {
    logger.error({ err, month }, 'failed to freeze the Quant runs before a write; the next read freezes them');
  }
}

export async function signalAfterWrite(port: ProductionWrites | null | undefined, ctx: RequestContext, month: string): Promise<void> {
  if (!port) return;
  try {
    await port.afterWrite(ctx, month);
  } catch (err) {
    logger.error({ err, month }, 'failed to recalculate the Quant runs after a write; the next read recalculates them');
  }
}
