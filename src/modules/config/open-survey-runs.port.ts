import type { RequestContext } from '@/common/context/request-context';

/** How many runs of one kind are open, and in how many KPMs — counts only (ADR-0214 §1). */
export interface OpenRunCounts {
  runs: number;
  kpms: number;
}

/**
 * **The survey runs open now in some KPMs** (ADR-0216 §2; AA UI-022, AT-12): what the template's *Bagian* switch asks
 * before NPS or *Analitik kualitatif* is turned off — *"1 survei sedang berjalan di n KPM…"*.
 *
 * A port, because the runs are the surveys module's (`surveyRuns`, P19.5-T4) and the template's editor is the config
 * module's: `SurveyOpenRuns` counts the rows through the run repository's named read, by the Super Admin who asks.
 */
export abstract class OpenSurveyRuns {
  abstract openIn(ctx: RequestContext, kpmIds: readonly string[], kind: 'nps' | 'qual'): Promise<OpenRunCounts>;
}
