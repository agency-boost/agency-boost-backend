import { SetMetadata } from '@nestjs/common';
import type { ReviewedPage } from './kpm-setup-mark.schema';

/** What a route that saves a setup page declares: the page, and — where one route saves several pages — when it is this one. */
export interface SetupStepSaved {
  page: ReviewedPage;
  /** Given the request's body: whether this save is the page's. Absent, every successful call is. */
  when?: (body: unknown) => boolean;
}

export const SETUP_STEP_SAVED = 'kpmSetup:stepSaved';

/**
 * **This route saves a page of the KPM setup card** (P19.3-T2: *"Saving any of the four pages also sets the flag"*;
 * UI-149's done rule, *"steps 1–4 tick when the owner saves on that page"*). Metadata only: the global
 * `SetupStepSavedInterceptor` sets the page's mark once the handler has succeeded, so a refused or failed save sets
 * nothing, and the page's own service is not touched.
 */
export const SavesSetupStep = (page: ReviewedPage, when?: SetupStepSaved['when']) =>
  SetMetadata(SETUP_STEP_SAVED, { page, when } satisfies SetupStepSaved);

/**
 * `POST /kpm/settings/changes` saves whichever pages its batch touches. Step 2 is *Activity types (+ Ratio benchmarks)*
 * (Overview R2), so a batch with an activity section, an activity type or a ratio is that page's save; a batch of
 * training rows alone is not.
 */
export const touchesActivityTypes = (body: unknown): boolean => {
  const ops = (body as { ops?: { op?: unknown }[] } | null)?.ops;
  return Array.isArray(ops) && ops.some((o) => typeof o?.op === 'string' && /^(category|type|ratio)\./.test(o.op));
};
