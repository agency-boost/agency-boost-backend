import { Logger } from '@nestjs/common';
import type { RequestContext } from '@/common/context/request-context';

/**
 * **An agent code registered in the KPM** (P19.5-T2 AC-5; ADR-0214 §8): a membership of the office now holds a code —
 * made active with it, by any path (*Tambah anggota*'s invitation accepted, the member import, an approval). The
 * production module answers: the months the Data upload held apart for that code as *Belum terdaftar* move onto the
 * membership. **A port, as `SalesEvents` is** — synchronous, no event bus — so the org module does not depend on
 * production.
 */
export abstract class HeldRowsPort {
  abstract codeRegistered(ctx: RequestContext, membershipId: string, agentCode: string): Promise<void>;
}

const logger = new Logger('HeldRowsPort');

/**
 * **It fails open**: the membership has been written and still answers. A failure is logged; the held rows wait, still
 * *Belum terdaftar*, and the next registration of the code — or the next import of its months — reaches them.
 */
export async function signalCodeRegistered(
  port: HeldRowsPort | null | undefined, ctx: RequestContext, membershipId: string, agentCode: string | null | undefined,
): Promise<void> {
  if (!port || !agentCode) return;
  try {
    await port.codeRegistered(ctx, membershipId, agentCode);
  } catch (err) {
    logger.error({ err, membershipId }, 'failed to move the held months of a registered code; they stay held');
  }
}
