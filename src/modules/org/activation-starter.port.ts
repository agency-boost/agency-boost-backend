import { Logger } from '@nestjs/common';
import { RequestContext } from '@/common/context/request-context';

/**
 * **What placing somebody under a leader starts** (OD-119, P13-T1 AC-1): their 90-day activation.
 *
 * `ApprovalsService` calls it when an approved request or a leader's tag makes a pending member active
 * under a leader, and `LeaderCodeService` when a leader's code does, in the same service call that places
 * them. The activation module decides the rest — the Agent rung only, nothing for a membership that
 * already has one. A port rather than an import, as `MemberDeparture` is: the org module owns joining,
 * and the module that keeps the activation answers it without org depending on it.
 *
 * A roster import and an office's creation never call it, so neither creates an activation.
 */
export abstract class ActivationStarter {
  abstract joined(ctx: RequestContext, membershipId: string): Promise<void>;
}

const logger = new Logger('ActivationStarter');

/**
 * **Creation fails open** (P13-T1 AC-2): the placement has happened before this is called, and it never
 * fails because of it. A failure is logged, and the hire's next read creates what is missing.
 */
export async function startActivation(
  starter: ActivationStarter | null | undefined, ctx: RequestContext, membershipId: string,
): Promise<void> {
  if (!starter) return;
  try {
    await starter.joined(ctx, membershipId);
  } catch (err) {
    logger.error({ err, membershipId }, 'failed to start an activation; the hire’s next read creates it');
  }
}
