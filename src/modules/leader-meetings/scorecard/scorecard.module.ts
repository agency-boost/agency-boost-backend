import { LeaderScorecardService } from './scorecard.service';

/**
 * **What the scorecard adds to the application's providers.** The backend is one `AppModule` holding every
 * provider (no feature modules), and the scorecard reads through readings that live there — the office's people,
 * production, the activations — so it is not a Nest module that could import them: `AppModule` spreads this list
 * into its `providers`, and the forum's service injects `LeaderScorecardService`.
 */
export const LEADER_SCORECARD_PROVIDERS = [LeaderScorecardService];
