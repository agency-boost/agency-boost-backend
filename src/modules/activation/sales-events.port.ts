import { Logger } from '@nestjs/common';
import { RequestContext } from '@/common/context/request-context';

/**
 * **A sale may have happened** (P18.96-T4 AC-1, AC-2; ADR-0171 §1): a sales lead moved to *Paid and issued*, a closing
 * logged from the checklist, or production-file figures written — an import committed, a figure corrected by hand.
 * **Or one the file gave may be gone** (the P18.96 exit review, M4): an import reverted, a month's policies corrected
 * to none or cleared — `FirstSaleService` then recomputes a first sale read from that month, while no 3M result is kept.
 *
 * `LeadService.setStatus` and `logClosing`, `ProductionImportService.commit` and `revert`, and
 * `ProductionCorrections.correct` call it once, at their end, naming whose records they were. The activation module answers: each member's `firstSaleDate`
 * is recomputed — moved earlier, never later — and their open activation evaluated, so *Close first case
 * independently* and *Reach Independent Agent milestone* tick from the write. **Synchronously, with no event bus**, as
 * `ActivationEvents` does; a port rather than an import, so leads and production do not depend on activation.
 */
export abstract class SalesEvents {
  abstract salesRecorded(ctx: RequestContext, membershipIds: readonly string[]): Promise<void>;
}

const logger = new Logger('SalesEvents');

/**
 * **It fails open**: the write it follows has happened and still answers. A failure is logged; the next sale signalled
 * for the member recomputes the date, migration 0042 backfills it, and every read of the checklist evaluates its links
 * again, so a missed call costs a moment, not a record.
 */
export async function signalSales(
  events: SalesEvents | null | undefined, ctx: RequestContext, membershipIds: readonly string[],
): Promise<void> {
  const ids = [...new Set(membershipIds)];
  if (!events || ids.length === 0) return;
  try {
    await events.salesRecorded(ctx, ids);
  } catch (err) {
    logger.error({ err, membershipIds: ids }, 'failed to record a first sale; the next sale or read heals it');
  }
}
