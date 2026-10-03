import { Logger } from '@nestjs/common';
import { RequestContext } from '@/common/context/request-context';

/**
 * **What the *New agent* section needs, served with the session** (P13-T7 AC-5): whether the reader has
 * an activation and whether it is open and complete, and whether they reach anybody's open activation.
 * Read once, with `GET /auth/me`, so no page reads it again.
 */
export interface ActivationNavFacts {
  /** `null` when the reader has none; `open` is false once graduated or expired; `complete` is 100%. */
  activation: { open: boolean; complete: boolean } | null;
  /** The reader reaches at least one open activation through `COACH` (OD-122). */
  newHires: boolean;
}

/** The facts, for `AuthController`. A port so the auth module does not depend on activation. */
export abstract class ActivationNav {
  abstract factsFor(ctx: RequestContext): Promise<ActivationNavFacts>;
}

/** Nothing to show: no activation, nobody on a roster. */
export const NO_ACTIVATION_NAV: ActivationNavFacts = { activation: null, newHires: false };

const logger = new Logger('ActivationNav');

/**
 * **Fails open to nothing**: a session that cannot say whether its reader has an activation still loads,
 * without the section. Every route refuses on its own, so a nav that shows too little hides nothing the
 * server would have served.
 */
export async function activationNavFor(
  nav: ActivationNav | null | undefined, ctx: RequestContext,
): Promise<ActivationNavFacts> {
  if (!nav || !ctx.membership) return NO_ACTIVATION_NAV;
  try {
    return await nav.factsFor(ctx);
  } catch (err) {
    logger.error({ err }, 'failed to read the activation facts for the session');
    return NO_ACTIVATION_NAV;
  }
}
