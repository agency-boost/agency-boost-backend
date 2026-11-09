import { addDays, type LocalDate } from '@/common/time/local-day';
import { NPS, SURVEY, SURVEY_STATES, type SurveyRoleClass } from '@/domain/constants';
import type { LabelPair, NpsQuestion, QualItem, QualQuestionType } from '@/modules/config/analytics-config';
import type { ReminderMoment } from './survey-participation.schema';
import type { SnapshotQualBlock, SurveyKind, SurveySnapshot } from './survey-run.schema';

/*
 * **The surveys' rules, pure** (P19.5-T4; ADR-0216 §2 to §7): the periods and the cadence, a run's state on a KPM day,
 * the popup's moments, the questions a respondent is asked, an answer's shape, the bands, and the scores. Every date
 * is a KPM calendar day handed in (invariant §9): nothing here reads a clock, so a test puts the reminder on any day.
 */

// ------------------------------------------------------------------------------------------- periods and cadence

const pad = (n: number) => String(n).padStart(2, '0');
const lastDay = (year: number, month: number) => new Date(Date.UTC(year, month, 0)).getUTCDate();

/**
 * **The period a day falls in**, for a kind and an NPS cadence: `YYYY-Qn` or `YYYY-Hn` for NPS; for a qualitative run
 * the month itself, `YYYY-06` or `YYYY-12`, or `null` for any other month (OD-266 Q4).
 */
export function periodOf(kind: SurveyKind, cadence: 'quarter' | 'half', day: LocalDate, qualMonths: readonly number[]): string | null {
  const [y, m] = day.split('-').map(Number);
  if (kind === 'qual') return qualMonths.includes(m) ? `${y}-${pad(m)}` : null;
  return cadence === 'quarter' ? `${y}-Q${Math.ceil(m / 3)}` : `${y}-H${m <= 6 ? 1 : 2}`;
}

/** A period's first and last day. */
export function periodBounds(periodKey: string): { first: LocalDate; last: LocalDate } {
  const [yRaw, part] = periodKey.split('-');
  const y = Number(yRaw);
  let fromMonth: number;
  let toMonth: number;
  if (part.startsWith('Q')) {
    fromMonth = (Number(part.slice(1)) - 1) * 3 + 1;
    toMonth = fromMonth + 2;
  } else if (part.startsWith('H')) {
    fromMonth = part === 'H1' ? 1 : 7;
    toMonth = fromMonth + 5;
  } else {
    fromMonth = Number(part);
    toMonth = fromMonth;
  }
  return { first: `${y}-${pad(fromMonth)}-01`, last: `${y}-${pad(toMonth)}-${pad(lastDay(y, toMonth))}` };
}

/**
 * **The period a run's dates make, or why they make none** (ADR-0216 §2): both days in one period of the template's
 * cadence. `outside_cadence` otherwise — a qualitative run outside June and December, or one crossing two periods.
 */
export function runPeriod(
  kind: SurveyKind, cadence: 'quarter' | 'half', opensOn: LocalDate, closesOn: LocalDate, qualMonths: readonly number[],
): { periodKey: string } | { conflict: 'outside_cadence' } {
  const a = periodOf(kind, cadence, opensOn, qualMonths);
  const b = periodOf(kind, cadence, closesOn, qualMonths);
  if (!a || a !== b) return { conflict: 'outside_cadence' };
  return { periodKey: a };
}

export type RunState = 'scheduled' | 'open' | 'closed';

/** Scheduled before 00:00 on `opensOn`; open to the end of `closesOn`; closed after, in the KPM's calendar. */
export function runState(run: { opensOn: LocalDate; closesOn: LocalDate }, today: LocalDate): RunState {
  if (today < run.opensOn) return 'scheduled';
  return today <= run.closesOn ? 'open' : 'closed';
}

/** Whole days between two calendar days. */
export function daysBetween(from: LocalDate, to: LocalDate): number {
  const t = (d: LocalDate) => Date.UTC(Number(d.slice(0, 4)), Number(d.slice(5, 7)) - 1, Number(d.slice(8, 10)));
  return Math.round((t(to) - t(from)) / 86_400_000);
}

/** *n hari lagi*: the days left to `closesOn`, `0` on it. */
export const daysLeft = (today: LocalDate, closesOn: LocalDate) => Math.max(0, daysBetween(today, closesOn));

/** **The halfway day**: `opensOn + ⌊(closesOn − opensOn) / 2⌋` (§B.33) — 2 November for 27 October to 9 November. */
export function halfwayDay(opensOn: LocalDate, closesOn: LocalDate): LocalDate {
  return addDays(opensOn, Math.floor(daysBetween(opensOn, closesOn) / 2));
}

// ----------------------------------------------------------------------------------------------- the reminder

export interface ReminderRun {
  runId: string;
  opensOn: LocalDate;
  closesOn: LocalDate;
  remindHalfway: boolean;
}

export interface ReminderState {
  submitted: boolean;
  lastPopupOn: LocalDate | null;
  momentsShown: readonly ReminderMoment[];
}

const URGENCY: Record<ReminderMoment, number> = { opened: 0, halfway: 1, last_day: 2 };

/**
 * **The moment due today for one person and one run, or `null`** (C-R3; ADR-0216 §6):
 *
 * - `last_day` on `closesOn − SURVEY.REMINDER_DAYS_BEFORE_CLOSE` and on `closesOn`, **always** (C-R10), until shown;
 * - `halfway` from the halfway day, when `remindHalfway` is on, until shown — and it takes the place of an `opened`
 *   not yet shown;
 * - `opened` from `opensOn` until shown.
 *
 * Never after sending, before it opens or after it closes (C-R5).
 */
export function dueMoment(run: ReminderRun, state: ReminderState, today: LocalDate): ReminderMoment | null {
  if (state.submitted || runState(run, today) !== 'open') return null;
  const shown = new Set(state.momentsShown);
  if (today >= addDays(run.closesOn, -SURVEY.REMINDER_DAYS_BEFORE_CLOSE) && !shown.has('last_day')) return 'last_day';
  if (run.remindHalfway && today >= halfwayDay(run.opensOn, run.closesOn) && !shown.has('halfway') && !shown.has('last_day')) {
    return 'halfway';
  }
  if (!shown.has('opened') && !shown.has('halfway') && !shown.has('last_day')) return 'opened';
  return null;
}

/**
 * **Today's popup for one person, or `null`** (C-R3 to C-R7): at most `SURVEY.POPUPS_PER_DAY` a KPM day, whichever run
 * showed it — a popup shown today on any device means none again until tomorrow. Two runs due at once make **one**
 * popup (C-R7), its moment the most urgent of theirs.
 */
export function popupFor(
  runs: readonly { run: ReminderRun; state: ReminderState }[], today: LocalDate,
): { moment: ReminderMoment; runIds: string[] } | null {
  const shownToday = runs.filter((r) => r.state.lastPopupOn === today).length;
  if (shownToday >= SURVEY.POPUPS_PER_DAY) return null;
  const due = runs
    .map((r) => ({ runId: r.run.runId, moment: dueMoment(r.run, r.state, today) }))
    .filter((r): r is { runId: string; moment: ReminderMoment } => r.moment !== null);
  if (due.length === 0) return null;
  const moment = due.reduce<ReminderMoment>((top, r) => (URGENCY[r.moment] > URGENCY[top] ? r.moment : top), due[0].moment);
  return { moment, runIds: due.map((r) => r.runId) };
}

/** The moments a shown popup marks as shown: a later moment covers every earlier one (ADR-0216 §6). */
export function momentsCovered(moment: ReminderMoment): ReminderMoment[] {
  return (Object.keys(URGENCY) as ReminderMoment[]).filter((m) => URGENCY[m] <= URGENCY[moment]);
}

/** *±m menit*: `SURVEY.SECONDS_PER_QUESTION` a question, rounded up, at least one. */
export const minutesFor = (questions: number) => Math.max(1, Math.ceil((questions * SURVEY.SECONDS_PER_QUESTION) / 60));

// ------------------------------------------------------------------------------------------- the questions asked

export type AskedType =
  | 'score' | 'text' | 'aspiration' | 'scale_items' | 'state_items' | 'unit_items' | 'downline_yes_no'
  | 'downline_areas' | 'support';

/** One screen of the form (C-R6; ADR-0216 §5): a question, as the respondent is asked it. */
export interface AskedQuestion {
  kode: string;
  type: AskedType;
  text: LabelPair;
  items: QualItem[];
  /** A score question's *Kenapa? (opsional)*. */
  askWhy: boolean;
  /** Needed before *Kirim*: every question but the open one and Q11's areas. */
  required: boolean;
  blockKode: string | null;
  blockTitle: LabelPair | null;
  /** NPS: the question's aspect. */
  aspect: string | null;
}

const ASKED: Record<Exclude<QualQuestionType, 'choice' | 'downline_coaching'>, AskedType> = {
  aspiration: 'aspiration', scale_items: 'scale_items', state_items: 'state_items', unit_items: 'unit_items',
  support: 'support',
};

/** Whether a class is asked the leader blocks: an AB or an AAB (ADR-0216 §4). */
export const isLeaderClass = (roleClass: SurveyRoleClass) => roleClass === 'ab' || roleClass === 'aab';

/**
 * **The questions a respondent of `roleClass` is asked, in order** (ADR-0216 §4, §5): NPS's score questions then the
 * open one; a qualitative run's blocks — **the *Semua* blocks for an agent**, every block for an AB or an AAB — and
 * never a `choice` question (*Tentang Anda*, whose three answers are the member list's). *Coaching leader downline*
 * (Q10, Q11) is asked only of a leader with a leader below them, as the coaching mockup draws it for Fajar and not for
 * Ika; whether they had one is fixed on their invitation when the run opens.
 */
export function askedQuestions(
  kind: SurveyKind, snapshot: SurveySnapshot, roleClass: SurveyRoleClass,
  /** Q10 and Q11 are about the respondent's own downline leaders: asked only of somebody who has one. */
  { downlineLeaders = true }: { downlineLeaders?: boolean } = {},
): AskedQuestion[] {
  if (kind === 'nps') {
    const scores: AskedQuestion[] = snapshot.questions.map((q: NpsQuestion) => ({
      kode: q.kode, type: 'score', text: q.text, items: [], askWhy: q.askWhy, required: true,
      blockKode: null, blockTitle: null, aspect: q.aspect,
    }));
    const open = snapshot.openQuestion
      ? [{
        kode: snapshot.openQuestion.kode, type: 'text' as const, text: snapshot.openQuestion.text, items: [], askWhy: false,
        required: false, blockKode: null, blockTitle: null, aspect: null,
      }]
      : [];
    return [...scores, ...open];
  }
  return snapshot.blocks
    .filter((b: SnapshotQualBlock) => b.audience === 'all' || isLeaderClass(roleClass))
    .flatMap((b) => b.questions
      .filter((q) => q.type !== 'choice' && (downlineLeaders || q.type !== 'downline_coaching'))
      .map((q): AskedQuestion => {
        const type: AskedType = q.type === 'downline_coaching'
          ? (q.items.length > 0 ? 'downline_areas' : 'downline_yes_no')
          : ASKED[q.type as keyof typeof ASKED];
        return {
          kode: q.kode, type, text: q.text, items: q.items, askWhy: false, required: type !== 'downline_areas',
          blockKode: b.kode, blockTitle: b.title, aspect: null,
        };
      }));
}

// ------------------------------------------------------------------------------------------------- an answer

/** Why an answer is refused, for `VALIDATION_FAILED`'s sentence. */
export type AnswerProblem =
  | 'score' | 'text' | 'choices' | 'exclusive' | 'rating' | 'state' | 'yes_no' | 'leader' | 'area' | 'shape';

const isObj = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v);
const whole = (v: unknown, min: number, max: number) => typeof v === 'number' && Number.isInteger(v) && v >= min && v <= max;

/** An optional text: absent, or a string of at most `SURVEY.TEXT_MAX_LENGTH` once trimmed. */
function optionalText(v: unknown): string | null | false {
  if (v === undefined || v === null) return null;
  if (typeof v !== 'string') return false;
  const t = v.trim();
  return t.length > SURVEY.TEXT_MAX_LENGTH ? false : t;
}

/**
 * **An answer, checked against its question and stored in its one shape** — or the reason it is refused (ADR-0216 §5).
 * A multi-item answer may be partial while it is saved one by one; `isAnswered` says when it is whole.
 *
 * | Type | Value |
 * |---|---|
 * | `score` | `{ score: 0..10, why? }` (*why* only where `askWhy`) |
 * | `text` | `{ text }` |
 * | `aspiration` | `{ chosen: [itemKode, …], note? }` — an `exclusive` choice alone |
 * | `scale_items`, `unit_items` | `{ [itemKode]: 1..5 }` |
 * | `state_items` | `{ [itemKode]: 'consistent' \| 'inconsistent' \| 'not_done' }` |
 * | `downline_yes_no` | `{ answer: 'yes' \| 'no' }` |
 * | `downline_areas` | `{ leaders: [{ membershipId, areas: [itemKode, …] }] }`, the respondent's own downline leaders |
 * | `support` | `{ score: 0..10, reason? }` |
 */
export function checkAnswer(
  question: AskedQuestion, value: unknown, downlineLeaderIds: ReadonlySet<string>,
): { value: Record<string, unknown> } | { problem: AnswerProblem } {
  if (!isObj(value)) return { problem: 'shape' };
  const itemKodes = new Set(question.items.map((i) => i.kode));
  switch (question.type) {
    case 'score':
    case 'support': {
      if (!whole(value.score, NPS.SCALE_MIN, NPS.SCALE_MAX)) return { problem: 'score' };
      const key = question.type === 'score' ? 'why' : 'reason';
      const text = optionalText(value[key]);
      if (text === false || (question.type === 'score' && !question.askWhy && text)) return { problem: 'text' };
      return { value: { score: value.score, ...(text ? { [key]: text } : {}) } };
    }
    case 'text': {
      const text = optionalText(value.text);
      if (text === false) return { problem: 'text' };
      return { value: { text: text ?? '' } };
    }
    case 'aspiration': {
      const chosen = value.chosen;
      if (!Array.isArray(chosen) || chosen.length === 0 || chosen.some((c) => typeof c !== 'string' || !itemKodes.has(c))
        || new Set(chosen).size !== chosen.length) return { problem: 'choices' };
      const exclusive = question.items.filter((i) => i.exclusive).map((i) => i.kode);
      if (chosen.length > 1 && chosen.some((c) => exclusive.includes(c as string))) return { problem: 'exclusive' };
      const note = optionalText(value.note);
      if (note === false) return { problem: 'text' };
      return { value: { chosen: [...chosen], ...(note ? { note } : {}) } };
    }
    case 'scale_items':
    case 'unit_items':
    case 'state_items': {
      const out: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(value)) {
        if (!itemKodes.has(k)) return { problem: 'shape' };
        if (question.type === 'state_items') {
          if (!(SURVEY_STATES as readonly unknown[]).includes(v)) return { problem: 'state' };
        } else if (!whole(v, 1, SURVEY.RATING_MAX)) return { problem: 'rating' };
        out[k] = v;
      }
      return { value: out };
    }
    case 'downline_yes_no':
      return value.answer === 'yes' || value.answer === 'no' ? { value: { answer: value.answer } } : { problem: 'yes_no' };
    case 'downline_areas': {
      if (!Array.isArray(value.leaders)) return { problem: 'shape' };
      const seen = new Set<string>();
      const leaders: { membershipId: string; areas: string[] }[] = [];
      for (const row of value.leaders) {
        if (!isObj(row) || typeof row.membershipId !== 'string' || !downlineLeaderIds.has(row.membershipId)
          || seen.has(row.membershipId)) return { problem: 'leader' };
        seen.add(row.membershipId);
        if (!Array.isArray(row.areas) || row.areas.some((a) => typeof a !== 'string' || !itemKodes.has(a))
          || new Set(row.areas).size !== row.areas.length) return { problem: 'area' };
        leaders.push({ membershipId: row.membershipId, areas: [...row.areas] as string[] });
      }
      return { value: { leaders } };
    }
  }
}

/** **Whether an answer is whole**: what *n dari M terjawab* counts and *Kirim* needs of a required question. */
export function isAnswered(question: AskedQuestion, value: unknown): boolean {
  if (!isObj(value)) return false;
  switch (question.type) {
    case 'text':
      return typeof value.text === 'string' && value.text.trim() !== '';
    case 'scale_items':
    case 'unit_items':
    case 'state_items':
      return question.items.every((i) => value[i.kode] !== undefined);
    case 'downline_areas':
      return Array.isArray(value.leaders) && value.leaders.length > 0;
    default:
      return true;
  }
}

/** The answered count and the first question not yet answered — where *Lanjutkan* opens (C-R6, C2-3). */
export function progressOf(questions: readonly AskedQuestion[], answers: Readonly<Record<string, unknown>>): {
  answeredCount: number; resumeIndex: number;
} {
  const answered = questions.map((q) => isAnswered(q, answers[q.kode]));
  const first = answered.indexOf(false);
  return { answeredCount: answered.filter(Boolean).length, resumeIndex: first < 0 ? Math.max(0, questions.length - 1) : first };
}

/** The first required question not answered, or `null`: what *Kirim* refuses on. */
export function firstMissing(questions: readonly AskedQuestion[], answers: Readonly<Record<string, unknown>>): string | null {
  return questions.find((q) => q.required && !isAnswered(q, answers[q.kode]))?.kode ?? null;
}

/**
 * **An answer as an anonymous run keeps it** (ADR-0216 §3): Q11's downline leaders lose their membership ids — a
 * leader's own people would name the leader — and keep their areas.
 */
export function anonymised(question: AskedQuestion, value: Record<string, unknown>): Record<string, unknown> {
  if (question.type !== 'downline_areas') return value;
  const leaders = (value.leaders as { areas: string[] }[]).map((l) => ({ areas: [...l.areas] }));
  return { leaders };
}

// ------------------------------------------------------------------------------------------------- the bands

/** Whole years from a calendar day to another: an age, or *Masa kerja* from the KPM join date (OD-254 Q8). */
export function wholeYears(from: LocalDate, to: LocalDate): number {
  const [fy, fm, fd] = from.split('-').map(Number);
  const [ty, tm, td] = to.split('-').map(Number);
  return ty - fy - (tm < fm || (tm === fm && td < fd) ? 1 : 0);
}

/** The band of a value against ascending uppers: `[29, 45]` gives 0 to 29, 1 to 45, 2 above (*Gen Z · Y · X*). */
export function bandOf(value: number, uppers: readonly number[]): number {
  const i = uppers.findIndex((u) => value <= u);
  return i < 0 ? uppers.length : i;
}

/**
 * The tenure band: `< 3 · 3–7 · 7–10 · > 10` years against `[3, 7, 10]`, a year count *below* an upper in its band —
 * 3 years is the second band, as the KPM's Demographics read it.
 */
export function tenureBandOf(years: number, uppers: readonly number[]): number {
  const i = uppers.findIndex((u) => years < u);
  return i < 0 ? uppers.length : i;
}

// ------------------------------------------------------------------------------------------------- the scores

/**
 * **`NPS_SCORE`** (`metrics-and-definitions.md` §A.15): `round(100 · (P − D) / n)` on the run's own cut-offs — `P` the
 * scores ≥ `promoterMin`, `D` those ≤ `passiveMin − 1`. `null` with no answer.
 */
export function npsScore(scores: readonly number[], promoterMin: number, passiveMin: number): {
  score: number | null; promoters: number; passives: number; detractors: number; n: number;
} {
  const promoters = scores.filter((s) => s >= promoterMin).length;
  const detractors = scores.filter((s) => s < passiveMin).length;
  const n = scores.length;
  return {
    score: n === 0 ? null : Math.round((100 * (promoters - detractors)) / n),
    promoters, passives: n - promoters - detractors, detractors, n,
  };
}

/** An item answered with an issue (B-R6, `QUAL_ITEM_ISSUE_PCT`): a rating or comfort ≤ the cut-off, a state not *Konsisten*. */
export function isIssue(kind: 'rating' | 'state', value: unknown, maxRating: number): boolean {
  return kind === 'state' ? value !== 'consistent' : typeof value === 'number' && value <= maxRating;
}

/** *Masalah besar* at `qualBigPct`, *Perlu perhatian* at `qualWatchPct` — colour only, read live (R6). */
export function severityOf(pct: number | null, big: number, watch: number): 'big' | 'watch' | null {
  if (pct === null) return null;
  if (pct >= big) return 'big';
  return pct >= watch ? 'watch' : null;
}

/** A whole percentage, `null` over nothing. */
export const pctOf = (part: number, whole: number) => (whole === 0 ? null : Math.round((100 * part) / whole));

/** A cell of a breakdown: its figure, or `null` under `SURVEY.MIN_GROUP` respondents (ADR-0216 §3). */
export const smallCell = <T>(n: number, figure: T): T | null => (n < SURVEY.MIN_GROUP ? null : figure);

/**
 * **An anonymous run's floor** (ADR-0216 §3, amended 2026-11-06): a figure of an anonymous run read over fewer than
 * `SURVEY.MIN_GROUP` answers is not shown — one or two respondents' score *is* their answer, whatever the notice
 * promised. A run that is not anonymous told its respondents so, and keeps its figures.
 */
export const underFloor = (anonymous: boolean, n: number): boolean => anonymous && n < SURVEY.MIN_GROUP;

/**
 * **A hidden cell is never the only one** (ADR-0216 §3, amended 2026-11-06). The overall figure and every shown cell
 * of a dimension are on screen, so a single hidden cell is their difference. When exactly one group is hidden, the
 * shown cell with the fewest respondents (the first by key on a tie) is hidden too. **The rows with no key** — no date
 * of birth, no join date — are a group of their own for this count: under the minimum, they are the hidden one.
 */
export function complemented<C extends { respondents: number; score: number | null }>(
  cells: readonly C[], unkeyed: number,
): C[] {
  const small = (n: number) => n < SURVEY.MIN_GROUP;
  const hidden = cells.filter((c) => small(c.respondents)).length + (unkeyed > 0 && small(unkeyed) ? 1 : 0);
  const shown = cells.filter((c) => !small(c.respondents));
  if (hidden !== 1 || shown.length === 0) return [...cells];
  const next = shown.reduce((a, b) => (b.respondents < a.respondents ? b : a));
  return cells.map((c) => (c === next ? { ...c, score: null } : c));
}

/** An order for the open answers that is not the order they were sent (ADR-0216 §3): by a hash of each text. */
export function scrambled(texts: readonly string[]): string[] {
  const hash = (s: string) => {
    let h = 2166136261;
    for (let i = 0; i < s.length; i += 1) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
    return h >>> 0;
  };
  return [...texts].sort((a, b) => hash(a) - hash(b) || (a < b ? -1 : a > b ? 1 : 0));
}
