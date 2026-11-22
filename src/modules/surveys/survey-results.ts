import type { AnalyticsThresholds, LabelPair } from '@/modules/config/analytics-config';
import { SURVEY, type SurveyRoleClass, type WorkStatus } from '@/domain/constants';
import type { SurveyAnswer } from './survey-response.schema';
import type { SurveySnapshot } from './survey-run.schema';
import { isIssue, isLeaderClass, npsScore, pctOf, scrambled, severityOf, underFloor } from './survey-rules';

/*
 * **The results, pure** (P19.5-T4, rebuilt by P19.22-T6 and T7; ADR-0216 §4, ADR-0276; `metrics-and-definitions.md`
 * §A.15): `NPS_SCORE`, `NPS_KPM_OVERALL`, `QUAL_ITEM_ISSUE_PCT`, `QUAL_LEADER_SUPPORT`, `QUAL_COACHING_DOWNLINE_PCT` and
 * `SURVEY_RESPONSE_RATE`, over a run's sent forms and on its own snapshot, for one of the three views *Semua · Leader ·
 * Agent* (`SurveyWho`).
 *
 * **The floor** (ADR-0216 §3, amended 2026-11-06; ADR-0276 §3): an anonymous run's figure over fewer than
 * `SURVEY.MIN_GROUP` answers is `null`; **a class view of an anonymous run is shown only while both classes have that
 * many forms**, since the whole minus one class would give the other back; a quote of an anonymous run carries its
 * class only while that class has that many forms. Quotes are never in the order sent (`scrambled`).
 */

/**
 * **Who is reading** (ADR-0216 §3, amended by ADR-0276 §5): the Super Admin inside the KPM, the Owner and the Admins
 * (`office`); a core leader (`core_leader` — everything the Owner reads but *Suara responden*, the reasons given about
 * leaders, of whom they are one); a Super Admin's platform read or a view-as session (`summary` — counts, scores and
 * percentages, no free text, no name).
 */
export type ResultsAudience = 'office' | 'core_leader' | 'summary';

/** The three views of the NPS and *Analisa kualitatif* tabs: everybody, the leaders (AB and AAB), the agents. */
export const SURVEY_WHO = ['all', 'leader', 'agent'] as const;
export type SurveyWho = (typeof SURVEY_WHO)[number];

/** A sent form as the results read it. `membershipId` is a named run's only, and `null` on an anonymous run's. */
export interface ResponseRow {
  answers: readonly SurveyAnswer[];
  roleClass: SurveyRoleClass;
  tenureBand: number | null;
  ageBand: number | null;
  /** *Status kerja* as the member list held it when the form was sent; `null` unknown (forms sent before 19.22). */
  workStatus?: WorkStatus | null;
  membershipId?: string | null;
}

/** A run as the results read it: its snapshot, its sent forms, and whether it was anonymous (the floor's). */
export interface ResultsRun {
  snapshot: SurveySnapshot;
  rows: readonly ResponseRow[];
  anonymous: boolean;
}

/** One quote — a *Kenapa?*, a note, a reason — with the class of whoever wrote it, or `null` where that would name them. */
export interface SurveyQuote {
  text: string;
  who: 'leader' | 'agent' | null;
}

const answerOf = (row: ResponseRow, kode: string) => row.answers.find((a) => a.questionKode === kode)?.value as
  Record<string, unknown> | undefined;

const scoreOf = (row: ResponseRow, kode: string): number | null => {
  const v = answerOf(row, kode)?.score;
  return typeof v === 'number' ? v : null;
};

const textOf = (value: unknown): string | null => (typeof value === 'string' && value.trim() !== '' ? value.trim() : null);

const classOf = (row: ResponseRow): 'leader' | 'agent' => (isLeaderClass(row.roleClass) ? 'leader' : 'agent');

/** The forms of one view. */
export function rowsOf(rows: readonly ResponseRow[], who: SurveyWho): ResponseRow[] {
  return who === 'all' ? [...rows] : rows.filter((r) => classOf(r) === who);
}

/**
 * **Whether a class view may be shown** (ADR-0276 §3): always for *Semua* and for a run that is not anonymous; for an
 * anonymous run only while the leaders and the agents have each sent `SURVEY.MIN_GROUP` forms.
 */
export function whoShown(run: Pick<ResultsRun, 'rows' | 'anonymous'>, who: SurveyWho): boolean {
  if (who === 'all' || !run.anonymous) return true;
  const leaders = run.rows.filter((r) => classOf(r) === 'leader').length;
  return leaders >= SURVEY.MIN_GROUP && run.rows.length - leaders >= SURVEY.MIN_GROUP;
}

/**
 * **The quotes of a view**: each text with its writer's class — for an anonymous run only while that class has sent
 * `SURVEY.MIN_GROUP` forms in the whole run — in an order that is not the order sent. `null` under the floor.
 */
function quotesOf(
  run: ResultsRun, view: readonly ResponseRow[], pick: (row: ResponseRow) => string | null, hidden: boolean,
): SurveyQuote[] | null {
  if (hidden) return null;
  const counted = (c: 'leader' | 'agent') => run.rows.filter((r) => classOf(r) === c).length;
  const tagged = { leader: !run.anonymous || counted('leader') >= SURVEY.MIN_GROUP, agent: !run.anonymous || counted('agent') >= SURVEY.MIN_GROUP };
  const byText = new Map<string, SurveyQuote[]>();
  for (const r of view) {
    const text = pick(r);
    if (text) byText.set(text, [...(byText.get(text) ?? []), { text, who: tagged[classOf(r)] ? classOf(r) : null }]);
  }
  // Ordered by a hash of each text (`scrambled`), never the order the forms were sent.
  return scrambled([...byText.values()].flat().map((q) => q.text)).map((text) => byText.get(text)!.shift()!);
}

/** `SURVEY_RESPONSE_RATE`: the share of the invitees who sent the form, and how many of them were leaders and agents. */
export function responsesOf(invited: number, sent: number, leaders = 0, agents = 0) {
  return { invited, sent, pct: pctOf(sent, invited), leaders, agents };
}

// ---------------------------------------------------------------------------------------------------------- NPS

/** The promoter · passive · detractor bar, in whole percentages that add to 100 and whose ends differ by the score. */
export interface NpsShares {
  promoterPct: number;
  passivePct: number;
  detractorPct: number;
}

/** One line of the NPS tab: the *Keseluruhan KPM* card or one question's row. */
export interface NpsLine {
  kode: string;
  text: LabelPair;
  aspect: string;
  /** `NPS_SCORE` of the question's answers in the view; `null` under the floor or with none. */
  score: number | null;
  n: number;
  /** In *poin*, against the previous run's question of the same kode in the same view; `null` without one. */
  change: number | null;
  /** *"Pertanyaan diubah sejak periode lalu"*: the same kode, another text, in the previous run. */
  textChanged: boolean;
  shares: NpsShares | null;
  /** The score over the last runs, oldest first, this run last (`trendPeriods`); a hidden run `null`. */
  trend: (number | null)[];
  /** *Kenapa mereka memberi nilai ini*: the question's *Kenapa?* answers; `null` under the floor and for a summary. */
  reasons: SurveyQuote[] | null;
}

export interface NpsResults {
  cutoffs: { promoterMin: number; passiveMin: number };
  who: SurveyWho;
  /** `false`: an anonymous run's class view while a class has sent fewer than `SURVEY.MIN_GROUP` forms (ADR-0276 §3). */
  whoShown: boolean;
  /** Forms in the view. */
  respondents: number;
  /** **`NPS_KPM_OVERALL`** — the run's first question, *Keseluruhan KPM* (ADR-0276 §1); `null` for a run with none. */
  headline: NpsLine | null;
  /** Every other question, **lowest score first**, a hidden score last. */
  questions: NpsLine[];
  /** The periods the trends run over, oldest first, this run's last. */
  trendPeriods: string[];
  /** The open question's answers — what the respondents would improve, in their own words; `null` as `reasons`. */
  improve: SurveyQuote[] | null;
}

/** A run of the NPS history, and its period. */
export interface NpsHistoryRun extends ResultsRun {
  periodKey: string;
}

/** The shares of a set of scores, `null` with none. The detractors are the promoters less the score (ADR-0276 §1). */
export function sharesOf(scores: readonly number[], promoterMin: number, passiveMin: number): NpsShares | null {
  const s = npsScore(scores, promoterMin, passiveMin);
  if (s.n === 0 || s.score === null) return null;
  const promoterPct = Math.round((100 * s.promoters) / s.n);
  const detractorPct = Math.max(0, Math.min(100 - promoterPct, promoterPct - s.score));
  return { promoterPct, passivePct: 100 - promoterPct - detractorPct, detractorPct };
}

/**
 * **A run's NPS, for one view** (P19.22-T6 AC-2; ADR-0276 §1–§3): the first question as *Keseluruhan KPM*, then every
 * other question lowest first — each with its `NPS_SCORE`, its change in *poin* from the previous run of `history`, its
 * trend over `history` and this run, its promoter · passive · detractor shares and, on tap, its *Kenapa?* answers; and
 * the open question's answers. `history` is the runs before this one, oldest first (the tab passes three).
 */
export function npsResults(
  run: NpsHistoryRun, audience: ResultsAudience, history: readonly NpsHistoryRun[], who: SurveyWho = 'all',
): NpsResults {
  const { snapshot } = run;
  const promoterMin = snapshot.cutoffs.promoterMin!;
  const passiveMin = snapshot.cutoffs.passiveMin!;
  const shown = whoShown(run, who);
  const view = rowsOf(run.rows, who);
  const previous = history.length > 0 ? history[history.length - 1] : null;

  /** A question's score in a run's view, `null` where the run or the view hides it. */
  const scoreIn = (r: NpsHistoryRun, kode: string): number | null => {
    if (!whoShown(r, who)) return null;
    const scores = rowsOf(r.rows, who).map((row) => scoreOf(row, kode)).filter((s): s is number => s !== null);
    if (underFloor(r.anonymous, scores.length)) return null;
    return npsScore(scores, r.snapshot.cutoffs.promoterMin!, r.snapshot.cutoffs.passiveMin!).score;
  };
  const prevQuestions = new Map((previous?.snapshot.questions ?? []).map((q) => [q.kode, q]));

  const lines = snapshot.questions.map((q): NpsLine => {
    const scores = view.map((row) => scoreOf(row, q.kode)).filter((s): s is number => s !== null);
    const hidden = !shown || underFloor(run.anonymous, scores.length);
    const own = hidden ? null : npsScore(scores, promoterMin, passiveMin).score;
    const before = prevQuestions.get(q.kode);
    const prev = before && previous ? scoreIn(previous, q.kode) : null;
    return {
      kode: q.kode, text: q.text, aspect: q.aspect, score: own, n: scores.length,
      change: own === null || prev === null ? null : own - prev,
      textChanged: before !== undefined && (before.text.id !== q.text.id || (before.text.en ?? '') !== (q.text.en ?? '')),
      shares: hidden ? null : sharesOf(scores, promoterMin, passiveMin),
      trend: [...history.map((h) => scoreIn(h, q.kode)), own],
      reasons: audience === 'summary'
        ? null
        : quotesOf(run, view, (row) => textOf(answerOf(row, q.kode)?.why), hidden),
    };
  });

  const [headline, ...rest] = lines;
  const open = snapshot.openQuestion?.kode;
  const openHidden = !shown || underFloor(run.anonymous, view.length);
  return {
    cutoffs: { promoterMin, passiveMin },
    who,
    whoShown: shown,
    respondents: view.length,
    headline: headline ?? null,
    questions: rest.sort((a, b) => (a.score ?? Infinity) - (b.score ?? Infinity) || a.kode.localeCompare(b.kode)),
    trendPeriods: [...history.map((h) => h.periodKey), run.periodKey],
    improve: audience === 'summary' || !open
      ? null
      : quotesOf(run, view, (row) => textOf(answerOf(row, open)?.text), openHidden),
  };
}

/** **`NPS_KPM_OVERALL` of a run** — *Survei sebelumnya*'s *NPS 62%*: the first question over every form, or `null`. */
export function npsHeadlineOf(run: ResultsRun): number | null {
  const first = run.snapshot.questions[0];
  if (!first) return null;
  const scores = run.rows.map((row) => scoreOf(row, first.kode)).filter((s): s is number => s !== null);
  if (underFloor(run.anonymous, scores.length)) return null;
  return npsScore(scores, run.snapshot.cutoffs.promoterMin!, run.snapshot.cutoffs.passiveMin!).score;
}

// --------------------------------------------------------------------------------------------------- qualitative

/** ▲ worse · ▼ better against *semester lalu*; `same` unchanged; `null` with nothing to compare. */
export type QualTrend = 'worse' | 'better' | 'same';

/** One row of A–D: rank by `issuePct`, the item, its *% masalah* and *semester lalu*. */
export interface QualRow {
  questionKode: string;
  itemKode: string;
  label: LabelPair;
  kind: 'rating' | 'state';
  answers: number;
  /** `QUAL_ITEM_ISSUE_PCT`; `null` under the floor. */
  issuePct: number | null;
  /** Red at `qualBigPct`, yellow at `qualWatchPct`, else green — colour only, read live. */
  severity: 'big' | 'watch' | null;
  /** The previous run's figure for the same block and item in the same view (ADR-0276 §4). */
  previousPct: number | null;
  trend: QualTrend | null;
  /** *D · Manajemen unit*: *tidak nyaman x%* — the share whose comfort (Q9) is an issue; `null` elsewhere. */
  comfortPct: number | null;
}

export interface QualBlockResult {
  kode: string;
  title: LabelPair;
  audience: 'all' | 'leader';
  questionKodes: string[];
  /** `false` in the agents' view of a leader block: *"Pertanyaan ini hanya ditanyakan ke leader."* */
  asked: boolean;
  /** Forms in the view that answered the block: its *N = n*. */
  respondents: number;
  /** Highest *% masalah* first; a hidden one last. */
  rows: QualRow[];
}

/** One row of *Coaching leader downline*'s table: a downline leader, their upline (who answered), the areas coached. */
export interface DownlineCoachingRow {
  leaderId: string;
  uplineId: string;
  areas: string[];
  /** *Mandiri*: no area still coached. */
  independent: boolean;
  /** Filled by the service: the two names as the office reads them now (`''` for one who has left). */
  leaderName?: string;
  uplineName?: string;
}

export interface QualResults {
  who: SurveyWho;
  whoShown: boolean;
  respondents: number;
  cutoffs: { qualIssueMaxRating: number; supportPromMin: number; supportPasMin: number };
  /** *Siapa yang menjawab*: *Status kerja* and *Lama di KPM* of the view's forms; `null` under the floor. */
  profile: {
    workStatus: { fullTime: number; partTime: number; unknown: number } | null;
    tenure: { counts: number[]; unknown: number; bands: [number, number, number] } | null;
  };
  /** *Aspirasi jangka panjang*: each choice's share of the view, and of the leaders and the agents (*Semua* only). */
  aspiration: { kode: string; label: LabelPair; pct: number | null; leaderPct: number | null; agentPct: number | null }[];
  /** *Lihat catatan responden (n)*: Q4's notes; `null` under the floor and for a summary. */
  aspirationNotes: SurveyQuote[] | null;
  blocks: QualBlockResult[];
  /** *Dukungan leader*: *Agent menilai leader* and *Leader menilai upline*, as the view has them. */
  support: { rater: 'agent' | 'leader'; n: number; average: number | null; satisfiedPct: number | null; fairPct: number | null; poorPct: number | null }[];
  /** `QUAL_COACHING_DOWNLINE_PCT`: *x dari y masih meng-coach leader downline-nya*, and a named run's table. */
  coachingDownline: {
    asked: boolean; n: number; yes: number | null; pct: number | null; good: boolean | null;
    rows: DownlineCoachingRow[] | null;
  };
  /** *Suara responden*: Q12's reasons — the `office` audience's alone, and only from `SURVEY.MIN_GROUP` of them. */
  voices: SurveyQuote[] | null;
}

type Live = Pick<AnalyticsThresholds, 'qualBigPct' | 'qualWatchPct' | 'coachingGoodPct'>;

/** One block's rows for a view: the issue share per item, the comfort share where the block asks it, unranked. */
function blockRows(run: ResultsRun, view: readonly ResponseRow[], block: SurveySnapshot['blocks'][number], hiddenView: boolean, live: Live) {
  const max = run.snapshot.cutoffs.qualIssueMaxRating!;
  const scale = block.questions.find((q) => q.type === 'scale_items');
  const state = block.questions.find((q) => q.type === 'state_items');
  const comfort = block.questions.find((q) => q.type === 'unit_items');
  const main = scale ?? state;
  if (!main) return null;
  const kind = main === scale ? 'rating' as const : 'state' as const;
  const share = (kode: string, item: string, k: 'rating' | 'state') => {
    const values = view.map((r) => answerOf(r, kode)?.[item]).filter((v) => v !== undefined);
    const hidden = hiddenView || underFloor(run.anonymous, values.length);
    return { answers: values.length, pct: hidden ? null : pctOf(values.filter((v) => isIssue(k, v, max)).length, values.length) };
  };
  const respondents = view.filter((r) => block.questions.some((q) => answerOf(r, q.kode) !== undefined)).length;
  const rows = main.items.map((it) => {
    const s = share(main.kode, it.kode, kind);
    const c = comfort && comfort.items.some((x) => x.kode === it.kode) ? share(comfort.kode, it.kode, 'rating') : null;
    return {
      questionKode: main.kode, itemKode: it.kode, label: it.label, kind, answers: s.answers, issuePct: s.pct,
      severity: severityOf(s.pct, live.qualBigPct, live.qualWatchPct), comfortPct: c ? c.pct : null,
    };
  });
  return { respondents, rows };
}

/**
 * **A run's *Analisa kualitatif*, for one view** (P19.22-T7 AC-1, AC-2; ADR-0216 §4, ADR-0276 §4, §5): *Siapa yang
 * menjawab*, *Aspirasi jangka panjang* with its notes on tap, A–D in one row format ranked by *% masalah* with *semester
 * lalu* from `previous` (the run before, same view), *Coaching leader downline*, *Dukungan leader* by who rated, and
 * *Suara responden*. The agents' view says of every leader block that it was not asked.
 */
export function qualResults(
  run: ResultsRun, audience: ResultsAudience, live: Live, previous: ResultsRun | null = null, who: SurveyWho = 'all',
): QualResults {
  const { snapshot } = run;
  const shown = whoShown(run, who);
  const view = rowsOf(run.rows, who);
  const floored = (n: number) => !shown || underFloor(run.anonymous, n);

  // A–D, ranked, with *semester lalu*.
  const prevShown = previous !== null && whoShown(previous, who);
  const prevView = prevShown ? rowsOf(previous.rows, who) : [];
  const blocks: QualBlockResult[] = snapshot.blocks.flatMap((b) => {
    const asked = !(who === 'agent' && b.audience === 'leader');
    const own = blockRows(run, asked ? view : [], b, !shown, live);
    if (!own) return [];
    const before = prevShown ? previous.snapshot.blocks.find((x) => x.kode === b.kode) : undefined;
    const prev = before ? blockRows(previous!, asked ? prevView : [], before, false, live) : null;
    const rows = own.rows.map((r): QualRow => {
      const p = prev?.rows.find((x) => x.itemKode === r.itemKode && x.kind === r.kind)?.issuePct ?? null;
      const trend: QualTrend | null = r.issuePct === null || p === null ? null : r.issuePct > p ? 'worse' : r.issuePct < p ? 'better' : 'same';
      return { ...r, previousPct: p, trend };
    }).sort((a, b2) => (b2.issuePct ?? -1) - (a.issuePct ?? -1));
    return [{
      kode: b.kode, title: b.title, audience: b.audience, questionKodes: b.questions.map((q) => q.kode), asked,
      respondents: asked ? own.respondents : 0, rows: asked ? rows : [],
    }];
  });

  // *Siapa yang menjawab*.
  const profileHidden = floored(view.length);
  const bands = snapshot.cutoffs.tenureBands;
  const profile: QualResults['profile'] = profileHidden ? { workStatus: null, tenure: null } : {
    workStatus: {
      fullTime: view.filter((r) => r.workStatus === 'full_time').length,
      partTime: view.filter((r) => r.workStatus === 'part_time').length,
      unknown: view.filter((r) => r.workStatus !== 'full_time' && r.workStatus !== 'part_time').length,
    },
    tenure: {
      counts: [0, 1, 2, 3].map((i) => view.filter((r) => r.tenureBand === i).length),
      unknown: view.filter((r) => r.tenureBand === null).length,
      bands,
    },
  };

  // *Aspirasi jangka panjang*.
  const questions = snapshot.blocks.flatMap((b) => b.questions);
  const aspirationQ = questions.find((q) => q.type === 'aspiration');
  const chose = (rows: readonly ResponseRow[]) => (aspirationQ ? rows.filter((r) => Array.isArray(answerOf(r, aspirationQ.kode)?.chosen)) : []);
  const answeredAsp = chose(view);
  const share = (rows: readonly ResponseRow[], kode: string, hidden: boolean) => {
    const a = chose(rows);
    return hidden ? null : pctOf(a.filter((r) => (answerOf(r, aspirationQ!.kode)!.chosen as string[]).includes(kode)).length, a.length);
  };
  const aspHidden = floored(answeredAsp.length);
  const leaderRows = rowsOf(run.rows, 'leader');
  const agentRows = rowsOf(run.rows, 'agent');
  const split = who === 'all' && whoShown(run, 'leader');
  const aspiration = (aspirationQ?.items ?? []).map((it) => ({
    kode: it.kode, label: it.label, pct: share(view, it.kode, aspHidden),
    leaderPct: split ? share(leaderRows, it.kode, underFloor(run.anonymous, chose(leaderRows).length)) : null,
    agentPct: split ? share(agentRows, it.kode, underFloor(run.anonymous, chose(agentRows).length)) : null,
  }));
  const aspirationNotes = audience === 'summary' || !aspirationQ
    ? null
    : quotesOf(run, view, (row) => textOf(answerOf(row, aspirationQ.kode)?.note), aspHidden);

  // *Dukungan leader*, by who rated.
  const supportQ = questions.find((q) => q.type === 'support');
  const raters: ('agent' | 'leader')[] = who === 'all' ? ['agent', 'leader'] : [who];
  const support = supportQ ? raters.map((rater) => {
    const scores = rowsOf(run.rows, rater).map((r) => scoreOf(r, supportQ.kode)).filter((s): s is number => s !== null);
    const hidden = floored(scores.length);
    const satisfied = scores.filter((s) => s >= snapshot.cutoffs.supportPromMin!).length;
    const fair = scores.filter((s) => s >= snapshot.cutoffs.supportPasMin! && s < snapshot.cutoffs.supportPromMin!).length;
    const satisfiedPct = hidden ? null : pctOf(satisfied, scores.length);
    const poorPct = hidden ? null : pctOf(scores.length - satisfied - fair, scores.length);
    return {
      rater, n: scores.length,
      average: hidden || scores.length === 0 ? null : Math.round((10 * scores.reduce((a, b) => a + b, 0)) / scores.length) / 10,
      satisfiedPct,
      fairPct: satisfiedPct === null || poorPct === null ? null : 100 - satisfiedPct - poorPct,
      poorPct,
    };
  }) : [];

  // *Coaching leader downline*.
  const downline = questions.filter((q) => q.type === 'downline_coaching');
  const yesNo = downline.find((q) => q.items.length === 0);
  const areasQ = downline.find((q) => q.items.length > 0);
  const coachingAsked = who !== 'agent' && downline.length > 0;
  const answered = coachingAsked && yesNo
    ? view.map((r) => answerOf(r, yesNo.kode)?.answer).filter((a) => a === 'yes' || a === 'no')
    : [];
  const coachHidden = floored(answered.length);
  const yes = answered.filter((a) => a === 'yes').length;
  const pct = coachHidden ? null : pctOf(yes, answered.length);
  const rows = run.anonymous || !areasQ || !coachingAsked || audience === 'summary'
    ? null
    : view.flatMap((r) => {
      const leaders = (answerOf(r, areasQ.kode)?.leaders as { membershipId?: string; areas?: string[] }[] | undefined) ?? [];
      return r.membershipId ? leaders.filter((l) => typeof l.membershipId === 'string').map((l) => ({
        leaderId: l.membershipId!, uplineId: r.membershipId!, areas: [...(l.areas ?? [])], independent: (l.areas ?? []).length === 0,
      })) : [];
    });

  // *Suara responden*: the reasons given with Q12, the office's alone, from MIN_GROUP of them.
  const reasonOf = (row: ResponseRow) => (supportQ ? textOf(answerOf(row, supportQ.kode)?.reason) : null);
  const reasons = view.filter((r) => reasonOf(r) !== null).length;
  const voices = audience !== 'office' || !supportQ
    ? null
    : quotesOf(run, view, reasonOf, !shown || reasons < SURVEY.MIN_GROUP);

  return {
    who,
    whoShown: shown,
    respondents: view.length,
    cutoffs: {
      qualIssueMaxRating: snapshot.cutoffs.qualIssueMaxRating!,
      supportPromMin: snapshot.cutoffs.supportPromMin!,
      supportPasMin: snapshot.cutoffs.supportPasMin!,
    },
    profile,
    aspiration,
    aspirationNotes,
    blocks,
    support,
    coachingDownline: {
      asked: coachingAsked, n: answered.length, yes: coachHidden ? null : yes, pct,
      good: pct === null ? null : pct >= live.coachingGoodPct, rows,
    },
    voices,
  };
}
