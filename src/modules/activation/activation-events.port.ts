import { Logger } from '@nestjs/common';
import { RequestContext } from '@/common/context/request-context';
import type { ActivationFeatureLink } from '@/domain/constants';

/**
 * **A write a linked activation item waits for has happened** (P13-T3 AC-5, D-links).
 *
 * `GoalService.save`, `LeadService.create`, `ActivityService.saveDay` and `correctDay` call it once, at
 * their end, naming whose record it was and which kind of link it can complete. The activation module
 * evaluates that member's open activation — **synchronously, with no event bus and no scheduler**, since
 * nothing in the backend emits or schedules events. A port rather than an import, as the calendar reaches
 * removal through `MemberDeparture`: goals, leads and activity do not depend on activation.
 */
export abstract class ActivationEvents {
  abstract recorded(ctx: RequestContext, membershipId: string, kind: ActivationFeatureLink): Promise<void>;
}

const logger = new Logger('ActivationEvents');

/**
 * **It fails open**: the write it follows has happened and still answers. A failure is logged, and
 * every read of the checklist evaluates again, so a missed call is healed on the hire's next look.
 */
export async function signalActivation(
  events: ActivationEvents | null | undefined,
  ctx: RequestContext,
  membershipId: string,
  kind: ActivationFeatureLink,
): Promise<void> {
  if (!events) return;
  try {
    await events.recorded(ctx, membershipId, kind);
  } catch (err) {
    logger.error({ err, membershipId, kind }, 'failed to evaluate an activation; its next read heals it');
  }
}
