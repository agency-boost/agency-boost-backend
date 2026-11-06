import type { LabelPair } from '@/modules/config/analytics-config';
import type { AnalyticsThresholds } from '@/modules/config/analytics-config';
import type { SurveyRoleClass } from '@/domain/constants';
import type { SurveyAnswer } from './survey-response.schema';
import type { SurveySnapshot } from './survey-run.schema';
import { complemented, isIssue, npsScore, pctOf, scrambled, severityOf, smallCell, underFloor } from './survey-rules';

/*
 * **The results, pure** (P19.5-T4; ADR-0216 §4; `metrics-and-definitions.md` §A.15): `NPS_SCORE`, `QUAL_ITEM_ISSUE_PCT`,
 * `QUAL_LEADER_SUPPORT`, `QUAL_COACHING_DOWNLINE_PCT` and `SURVEY_RESPONSE_RATE`, over a run's sent forms and on its own
 * snapshot. **No figure here is ever a person's**: the rows are counted, never listed, a breakdown cell under
 * `SURVEY.MIN_GROUP` respondents is `null` and never the only one hidden, and **an anonymous run's figure over fewer
 * than `SURVEY.MIN_GROUP` answers is `null`** (ADR-0216 §3, amended 2026-11-06).
 */

/**
 * **Who is reading** (ADR-0216 §3): the Owner and the Admins (`office`), a Core Leader (`core_leader`: no *Dukungan
 * leader*), or a Super Admin's view-as session (`summary`: counts, scores and percentages — no free text, no Q12).
 */
export type ResultsAudience = 'office' | 'core_leader' | 'summary';

/** A sent form as the results read it: its answers and its bands, never its author. */
export interface ResponseRow {
  answers: readonly SurveyAnswer[];
  roleClass: SurveyRoleClass;
  tenureBand: number | null;
  ageBand: number | null;
}

/** A run as the results read it: its snapshot, its sent forms, and whether it was anonymous (the floor's). */
export interface ResultsRun {
  snapshot: SurveySnapshot;
  rows: readonly ResponseRow[];
  anonymous: boolean;
}

const answerOf = (row: ResponseRow, kode: string) => row.answers.find((a) => a.questionKode === kode)?.value as
  Record<string, unknown> | undefined;

const scoreOf = (row: ResponseRow, kode: string): number | null => {
  const v = answerOf(row, kode)?.score;
  return typeof v === 'number' ? v : null;
};

/** `SURVEY_RESPONSE_RATE`: the share of the invitees who sent the form. */
export function responsesOf(invited: number, sent: number) {
  return { invited, sent, pct: pctOf(sent, invited) };
}

// ---------------------------------------------------------------------------------------------------------- NPS

export interface NpsQuestionResult {
  kode: string;
  text: LabelPair;
  aspect: string;
  score: number | null;
  n: number;
  /** Against the previous run's question of the same kode; `null` without one. */
  change: number | null;
  /** *"Pertanyaan diubah sejak periode lalu"*: the same kode, another text, in the previous run. */
  textChanged: boolean;
}

export interface NpsResults {
  /** The run's cut-offs, and the bands its breakdowns are by (`< 3 · 3–7 · …`, *Gen Z · Y · X*). */
  cutoffs: { promoterMin: number; passiveMin: number; ageBandUpper: [number, number]; tenureBands: [number, number, number] };
  respondents: number;
  /** `null` for an anonymous run under `SURVEY.MIN_GROUP` respondents, as are every score, change and open answer. */
  overall: ReturnType<typeof npsScore> | null;
  change: number | null;
  aspects: { aspect: string; score: number | null; n: number; change: number | null }[];
  questions: NpsQuestionResult[];
  /** The open question's answers, with no names and not in the order sent; `null` for a summary. */
  openAnswers: string[] | null;
  breakdowns: Record<'roleClass' | 'tenureBand' | 'ageBand', { key: string; respondents: number; score: number | null }[]>;
}

/** The scores of the questions named, pooled over the rows. */
function pooled(rows: readonly ResponseRow[], kodes: readonly string[]): number[] {
  return rows.flatMap((r) => kodes.map((k) => scoreOf(r, k)).filter((s): s is number => s !== null));
}

/**
 * **A run's NPS** (AC-3; `NPS_SCORE`): overall, every score answer pooled; per aspect, the answers of its questions; per
 * question; each with the change from `previous` matched by kode, on each run's own cut-offs (AT-8). The breakdowns
 * by role, tenure and age read the bands stored with each form — never the survey's questions.
 *
 * **An anonymous run under `SURVEY.MIN_GROUP` respondents shows no score** (ADR-0216 §3, amended 2026-11-06): `overall`,
 * every aspect's and question's score and change, and the open answers are `null`; the counts stay. A previous run
 * under its floor gives no change either, since the change and today's score would give it back.
 */
export function npsResults(run: ResultsRun, audience: ResultsAudience, previous: ResultsRun | null): NpsResults {
  const { snapshot, rows } = run;
  const floored = underFloor(run.anonymous, rows.length);
  const promoterMin = snapshot.cutoffs.promoterMin!;
  const passiveMin = snapshot.cutoffs.passiveMin!;
  const score = (scores: number[]) => npsScore(scores, promoterMin, passiveMin);
  const prevShown = previous !== null && !underFloor(previous.anonymous, previous.rows.length);
  const prevScore = (kodes: readonly string[]) => (prevShown
    ? npsScore(pooled(previous.rows, kodes), previous.snapshot.cutoffs.promoterMin!, previous.snapshot.cutoffs.passiveMin!).score
    : null);
  const diff = (a: number | null, b: number | null) => (a === null || b === null ? null : a - b);

  const kodes = snapshot.questions.map((q) => q.kode);
  const overall = floored ? null : score(pooled(rows, kodes));
  const prevQuestions = new Map((previous?.snapshot.questions ?? []).map((q) => [q.kode, q]));

  const questions = snapshot.questions.map((q): NpsQuestionResult => {
    const own = score(pooled(rows, [q.kode]));
    const shown = floored ? null : own.score;
    const before = prevQuestions.get(q.kode);
    return {
      kode: q.kode, text: q.text, aspect: q.aspect, score: shown, n: own.n,
      change: before ? diff(shown, prevScore([q.kode])) : null,
      textChanged: before !== undefined && (before.text.id !== q.text.id || (before.text.en ?? '') !== (q.text.en ?? '')),
    };
  });

  const aspects = [...new Set(snapshot.questions.map((q) => q.aspect))].map((aspect) => {
    const own = snapshot.questions.filter((q) => q.aspect === aspect).map((q) => q.kode);
    const before = (previous?.snapshot.questions ?? []).filter((q) => q.aspect === aspect).map((q) => q.kode);
    const s = score(pooled(rows, own));
    const shown = floored ? null : s.score;
    return { aspect, score: shown, n: s.n, change: before.length ? diff(shown, prevScore(before)) : null };
  });

  const open = snapshot.openQuestion?.kode;
  const openAnswers = audience === 'summary' || !open || floored
    ? null
    : scrambled(rows.map((r) => answerOf(r, open)?.text).filter((t): t is string => typeof t === 'string' && t.trim() !== ''));

  const breakdown = (key: (r: ResponseRow) => string | null) => {
    const groups = new Map<string, ResponseRow[]>();
    let unkeyed = 0;
    for (const r of rows) {
      const k = key(r);
      if (k === null) {
        unkeyed += 1;
        continue;
      }
      groups.set(k, [...(groups.get(k) ?? []), r]);
    }
    return complemented([...groups].sort(([a], [b]) => (a < b ? -1 : 1)).map(([k, members]) => ({
      key: k, respondents: members.length, score: smallCell(members.length, score(pooled(members, kodes)).score),
    })), unkeyed);
  };

  return {
    cutoffs: {
      promoterMin, passiveMin, ageBandUpper: snapshot.cutoffs.ageBandUpper, tenureBands: snapshot.cutoffs.tenureBands,
    },
    respondents: rows.length,
    overall,
    change: previous ? diff(overall?.score ?? null, prevScore(previous.snapshot.questions.map((q) => q.kode))) : null,
    aspects,
    questions,
    openAnswers,
    breakdowns: {
      roleClass: breakdown((r) => r.roleClass),
      tenureBand: breakdown((r) => (r.tenureBand === null ? null : String(r.tenureBand))),
      ageBand: breakdown((r) => (r.ageBand === null ? null : String(r.ageBand))),
    },
  };
}

// --------------------------------------------------------------------------------------------------- qualitative

export interface QualItemResult {
  questionKode: string;
  itemKode: string;
  label: LabelPair;
  kind: 'rating' | 'state' | 'comfort';
  answers: number;
  /** `null` with `issuePct` and `severity` for an anonymous run's item under `SURVEY.MIN_GROUP` answers. */
  issues: number | null;
  issuePct: number | null;
  severity: 'big' | 'watch' | null;
}

export interface QualResults {
  respondents: number;
  cutoffs: { qualIssueMaxRating: number };
  blocks: { kode: string; title: LabelPair; audience: 'all' | 'leader'; questionKodes: string[]; items: QualItemResult[] }[];
  aspiration: { kode: string; label: LabelPair; count: number | null; pct: number | null }[];
  /** `QUAL_LEADER_SUPPORT` — the Owner's and the Admins' alone; `null` to anyone else. */
  support: { n: number; satisfiedPct: number | null; fairPct: number | null; poorPct: number | null } | null;
  /** `QUAL_COACHING_DOWNLINE_PCT` and whether it is *baik*, against the live `coachingGoodPct`. */
  coachingDownline: { n: number; pct: number | null; good: boolean | null };
}

/**
 * **A run's qualitative results** (AC-4; `QUAL_ITEM_ISSUE_PCT`): for each item, the share of those who answered it with
 * an issue on the snapshot's `qualIssueMaxRating` (which never re-applies, R6), marked by the live colour thresholds.
 * *Dukungan leader* (Q12) is a KPM-level summary for the `office` audience only; its reasons and Q4's notes are never
 * served.
 *
 * **An anonymous run's figure over fewer than `SURVEY.MIN_GROUP` answers is `null`** (ADR-0216 §3, amended
 * 2026-11-06): an item's issues, share and mark; the aspirations; *Dukungan leader*'s shares; *Coaching downline*. Per
 * figure, since a leader block or Q10 can be answered by one AB of a run many sent; how many answered stays.
 */
export function qualResults(
  run: ResultsRun,
  audience: ResultsAudience,
  live: Pick<AnalyticsThresholds, 'qualBigPct' | 'qualWatchPct' | 'coachingGoodPct'>,
): QualResults {
  const { snapshot, rows } = run;
  const floored = (n: number) => underFloor(run.anonymous, n);
  const max = snapshot.cutoffs.qualIssueMaxRating!;
  const blocks = snapshot.blocks
    .map((b) => {
      const items = b.questions.flatMap((q) => {
        const kind = q.type === 'scale_items' ? 'rating' : q.type === 'state_items' ? 'state' : q.type === 'unit_items' ? 'comfort' : null;
        if (!kind) return [];
        return q.items.map((it): QualItemResult => {
          const values = rows.map((r) => answerOf(r, q.kode)?.[it.kode]).filter((v) => v !== undefined);
          const issues = values.filter((v) => isIssue(kind === 'state' ? 'state' : 'rating', v, max)).length;
          const hidden = floored(values.length);
          const pct = hidden ? null : pctOf(issues, values.length);
          return {
            questionKode: q.kode, itemKode: it.kode, label: it.label, kind, answers: values.length,
            issues: hidden ? null : issues, issuePct: pct, severity: severityOf(pct, live.qualBigPct, live.qualWatchPct),
          };
        });
      });
      return { kode: b.kode, title: b.title, audience: b.audience, questionKodes: b.questions.map((q) => q.kode), items };
    })
    .filter((b) => b.items.length > 0);

  const questions = snapshot.blocks.flatMap((b) => b.questions);
  const aspirationQ = questions.find((q) => q.type === 'aspiration');
  const aspirationRows = aspirationQ ? rows.filter((r) => Array.isArray(answerOf(r, aspirationQ.kode)?.chosen)) : [];
  const aspirationHidden = floored(aspirationRows.length);
  const aspiration = (aspirationQ?.items ?? []).map((it) => {
    const count = aspirationRows.filter((r) => (answerOf(r, aspirationQ!.kode)!.chosen as string[]).includes(it.kode)).length;
    return aspirationHidden
      ? { kode: it.kode, label: it.label, count: null, pct: null }
      : { kode: it.kode, label: it.label, count, pct: pctOf(count, aspirationRows.length) };
  });

  const supportQ = questions.find((q) => q.type === 'support');
  let support: QualResults['support'] = null;
  if (audience === 'office' && supportQ) {
    const scores = rows.map((r) => scoreOf(r, supportQ.kode)).filter((s): s is number => s !== null);
    const satisfied = scores.filter((s) => s >= snapshot.cutoffs.supportPromMin!).length;
    const fair = scores.filter((s) => s >= snapshot.cutoffs.supportPasMin! && s < snapshot.cutoffs.supportPromMin!).length;
    support = floored(scores.length)
      ? { n: scores.length, satisfiedPct: null, fairPct: null, poorPct: null }
      : {
        n: scores.length, satisfiedPct: pctOf(satisfied, scores.length), fairPct: pctOf(fair, scores.length),
        poorPct: pctOf(scores.length - satisfied - fair, scores.length),
      };
  }

  const yesNo = questions.find((q) => q.type === 'downline_coaching' && q.items.length === 0);
  const answered = yesNo ? rows.map((r) => answerOf(r, yesNo.kode)?.answer).filter((a) => a === 'yes' || a === 'no') : [];
  const pct = floored(answered.length) ? null : pctOf(answered.filter((a) => a === 'yes').length, answered.length);

  return {
    respondents: rows.length,
    cutoffs: { qualIssueMaxRating: max },
    blocks,
    aspiration,
    support,
    coachingDownline: { n: answered.length, pct, good: pct === null ? null : pct >= live.coachingGoodPct },
  };
}
