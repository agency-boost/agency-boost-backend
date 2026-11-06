import { platformAnalyticsConfig } from '@/modules/config/analytics-config';
import { snapshotOf } from './survey-opening';
import {
  anonymised, askedQuestions, bandOf, checkAnswer, daysLeft, dueMoment, firstMissing, halfwayDay, isAnswered, isIssue,
  minutesFor, momentsCovered, npsScore, periodBounds, periodOf, popupFor, progressOf, runPeriod, runState, scrambled,
  severityOf, smallCell, tenureBandOf, wholeYears, type ReminderRun, type ReminderState,
} from './survey-rules';

const published = { templateId: null, templateName: null, version: 1, config: platformAnalyticsConfig() };
const npsSnap = snapshotOf({ kind: 'nps', anonymous: true, perPerson: false }, published);
const qualSnap = snapshotOf({ kind: 'qual', anonymous: false, perPerson: true }, published);

/** The reminder mockup's run: *Survei NPS KPM Q4 2026*, 27 October to 9 November, *Ingatkan di tengah* on. */
const RUN: ReminderRun = { runId: 'r-nps', opensOn: '2026-10-27', closesOn: '2026-11-09', remindHalfway: true };
const fresh: ReminderState = { submitted: false, lastPopupOn: null, momentsShown: [] };

describe('the survey rules (P19.5-T4; ADR-0216 §2, §4 to §6)', () => {
  describe('periods and the cadence (ADR-0216 §2; AC-1)', () => {
    it('AC-1 a day’s period: an NPS quarter or half, a qualitative June or December, nothing else', () => {
      expect(periodOf('nps', 'quarter', '2026-11-05', [6, 12])).toBe('2026-Q4');
      expect(periodOf('nps', 'half', '2026-03-31', [6, 12])).toBe('2026-H1');
      expect(periodOf('qual', 'quarter', '2026-06-10', [6, 12])).toBe('2026-06');
      expect(periodOf('qual', 'quarter', '2026-07-01', [6, 12])).toBeNull();
      expect(periodBounds('2026-Q4')).toEqual({ first: '2026-10-01', last: '2026-12-31' });
      expect(periodBounds('2026-H1')).toEqual({ first: '2026-01-01', last: '2026-06-30' });
      expect(periodBounds('2026-06')).toEqual({ first: '2026-06-01', last: '2026-06-30' });
    });

    it('AC-1 a run’s dates must sit in one period: crossing two, or a qualitative run in July, is outside the cadence', () => {
      expect(runPeriod('nps', 'quarter', '2026-10-27', '2026-11-09', [6, 12])).toEqual({ periodKey: '2026-Q4' });
      expect(runPeriod('nps', 'quarter', '2026-09-25', '2026-10-05', [6, 12])).toEqual({ conflict: 'outside_cadence' });
      expect(runPeriod('nps', 'half', '2026-09-25', '2026-10-05', [6, 12])).toEqual({ periodKey: '2026-H2' });
      expect(runPeriod('qual', 'quarter', '2026-06-01', '2026-06-30', [6, 12])).toEqual({ periodKey: '2026-06' });
      expect(runPeriod('qual', 'quarter', '2026-06-20', '2026-07-05', [6, 12])).toEqual({ conflict: 'outside_cadence' });
    });

    it('a run is scheduled before 00:00 on its first day, open to the end of its last, closed after — in the KPM’s days', () => {
      expect(runState(RUN, '2026-10-26')).toBe('scheduled');
      expect(runState(RUN, '2026-10-27')).toBe('open');
      expect(runState(RUN, '2026-11-09')).toBe('open');
      expect(runState(RUN, '2026-11-10')).toBe('closed');
      expect(daysLeft('2026-11-05', '2026-11-09')).toBe(4);
      expect(daysLeft('2026-11-12', '2026-11-09')).toBe(0);
    });
  });

  describe('the reminder, with the day handed in (C-R3 to C-R7; C2)', () => {
    it('§B.33 the halfway day is opensOn + ⌊(closesOn − opensOn) / 2⌋: 2 November for 27 October to 9 November', () => {
      expect(halfwayDay('2026-10-27', '2026-11-09')).toBe('2026-11-02');
    });

    it('C-R3 the three moments: Survei baru on opening, Tinggal n hari halfway, Berakhir besok one day before — always', () => {
      expect(dueMoment(RUN, fresh, '2026-10-27')).toBe('opened');
      expect(dueMoment(RUN, { ...fresh, momentsShown: ['opened'] }, '2026-10-30')).toBeNull();
      expect(dueMoment(RUN, { ...fresh, momentsShown: ['opened'] }, '2026-11-02')).toBe('halfway');
      expect(dueMoment(RUN, { ...fresh, momentsShown: ['opened', 'halfway'] }, '2026-11-08')).toBe('last_day');
      // Shown the day before the end, not again on the last day.
      expect(dueMoment(RUN, { ...fresh, momentsShown: ['opened', 'halfway', 'last_day'] }, '2026-11-09')).toBeNull();
    });

    it('C-R10 the day before the end is due even with Ingatkan di tengah off; halfway is not', () => {
      const quiet = { ...RUN, remindHalfway: false };
      expect(dueMoment(quiet, { ...fresh, momentsShown: ['opened'] }, '2026-11-02')).toBeNull();
      expect(dueMoment(quiet, { ...fresh, momentsShown: ['opened'] }, '2026-11-08')).toBe('last_day');
    });

    it('ADR-0216 §6 halfway takes the place of an opening popup never shown, and a later moment covers the earlier', () => {
      expect(dueMoment(RUN, fresh, '2026-11-03')).toBe('halfway');
      expect(momentsCovered('halfway')).toEqual(['opened', 'halfway']);
      expect(momentsCovered('last_day')).toEqual(['opened', 'halfway', 'last_day']);
      expect(momentsCovered('opened')).toEqual(['opened']);
    });

    it('C2-1 on 8 November the first Home of the day gets the red Berakhir besok; after Nanti saja, nothing again that day', () => {
      const before = popupFor([{ run: RUN, state: { ...fresh, momentsShown: ['opened', 'halfway'] } }], '2026-11-08');
      expect(before).toEqual({ moment: 'last_day', runIds: ['r-nps'] });
      const after = popupFor(
        [{ run: RUN, state: { ...fresh, lastPopupOn: '2026-11-08', momentsShown: ['opened', 'halfway', 'last_day'] } }],
        '2026-11-08',
      );
      expect(after).toBeNull();
    });

    it('C-R4 a popup shown today means none again today, even for another run due; tomorrow it may show', () => {
      const other: ReminderRun = { ...RUN, runId: 'r-qual' };
      const shown = { run: RUN, state: { ...fresh, lastPopupOn: '2026-10-27', momentsShown: ['opened' as const] } };
      expect(popupFor([shown, { run: other, state: fresh }], '2026-10-27')).toBeNull();
      expect(popupFor([shown, { run: other, state: fresh }], '2026-10-28')).toEqual({ moment: 'opened', runIds: ['r-qual'] });
    });

    it('C2-2 on an ordinary day — 3 November, opening and halfway shown — no popup', () => {
      expect(popupFor([{ run: RUN, state: { ...fresh, momentsShown: ['opened', 'halfway'] } }], '2026-11-03')).toBeNull();
    });

    it('C-R5, C2-4 never after sending, before opening or after closing', () => {
      expect(dueMoment(RUN, { ...fresh, submitted: true }, '2026-11-08')).toBeNull();
      expect(dueMoment(RUN, fresh, '2026-10-26')).toBeNull();
      expect(dueMoment(RUN, fresh, '2026-11-10')).toBeNull();
    });

    it('C-R7, C2-6 two runs due at once make one popup naming both, at the most urgent moment', () => {
      const qual: ReminderRun = { runId: 'r-qual', opensOn: '2026-10-27', closesOn: '2026-11-20', remindHalfway: true };
      expect(popupFor([{ run: RUN, state: fresh }, { run: qual, state: fresh }], '2026-10-27'))
        .toEqual({ moment: 'opened', runIds: ['r-nps', 'r-qual'] });
      expect(popupFor([{ run: RUN, state: { ...fresh, momentsShown: ['opened'] } }, { run: qual, state: { ...fresh, momentsShown: ['opened'] } }], '2026-11-08'))
        // The NPS run ends tomorrow, the qualitative one is halfway: one popup for both, red.
        .toEqual({ moment: 'last_day', runIds: ['r-nps', 'r-qual'] });
    });

    it('C-R2 ±m menit: 30 seconds a question, rounded up — 6 questions, ±3 menit', () => {
      expect(minutesFor(6)).toBe(3);
      expect(minutesFor(3)).toBe(2);
      expect(minutesFor(0)).toBe(1);
    });
  });

  describe('the questions asked (ADR-0216 §4, §5)', () => {
    it('AC-5 NPS asks its five score questions, then the open one: six screens', () => {
      const asked = askedQuestions('nps', npsSnap, 'agent');
      expect(asked.map((q) => [q.kode, q.type, q.required])).toEqual([
        ['P1', 'score', true], ['P2', 'score', true], ['P3', 'score', true], ['P4', 'score', true], ['P5', 'score', true],
        ['OPEN', 'text', false],
      ]);
    });

    it('AC-4 an agent answers the Semua blocks only; an AB or AAB answers every block — and Tentang Anda is never asked', () => {
      expect(askedQuestions('qual', qualSnap, 'agent').map((q) => q.kode)).toEqual(['Q4', 'Q5', 'Q12']);
      expect(askedQuestions('qual', qualSnap, 'aab').map((q) => q.kode))
        .toEqual(['Q4', 'Q5', 'Q6', 'Q7', 'Q8', 'Q9', 'Q10', 'Q11', 'Q12']);
      expect(askedQuestions('qual', qualSnap, 'ab').some((q) => ['Q1', 'Q2', 'Q3'].includes(q.kode))).toBe(false);
    });

    it('B4-3 Coaching leader downline is asked only of a leader with a leader below them (Fajar, not Ika)', () => {
      expect(askedQuestions('qual', qualSnap, 'aab', { downlineLeaders: false }).map((q) => q.kode))
        .toEqual(['Q4', 'Q5', 'Q6', 'Q7', 'Q8', 'Q9', 'Q12']);
    });

    it('Q10 is yes or no; Q11 the areas per downline leader, optional', () => {
      const asked = askedQuestions('qual', qualSnap, 'ab');
      expect(asked.find((q) => q.kode === 'Q10')).toMatchObject({ type: 'downline_yes_no', required: true });
      expect(asked.find((q) => q.kode === 'Q11')).toMatchObject({ type: 'downline_areas', required: false });
    });
  });

  describe('an answer, checked and stored in one shape (ADR-0216 §5)', () => {
    const nps = askedQuestions('nps', npsSnap, 'agent');
    const qual = askedQuestions('qual', qualSnap, 'ab');
    const q = (kode: string) => qual.find((x) => x.kode === kode)!;

    it('AC-5 a score is 0 to 10 with an optional Kenapa?; anything else is refused with its reason', () => {
      expect(checkAnswer(nps[0], { score: 9, why: '  Leadernya mendukung. ' }, new Set())).toEqual({ value: { score: 9, why: 'Leadernya mendukung.' } });
      expect(checkAnswer(nps[0], { score: 11 }, new Set())).toEqual({ problem: 'score' });
      expect(checkAnswer(nps[0], { score: 7.5 }, new Set())).toEqual({ problem: 'score' });
      expect(checkAnswer(nps[0], 'nine', new Set())).toEqual({ problem: 'shape' });
      expect(checkAnswer(nps[5], { text: 'x'.repeat(1001) }, new Set())).toEqual({ problem: 'text' });
    });

    it('Q4: at least one choice; an exclusive choice alone (“opsi 3 dan 4 hanya sendiri”)', () => {
      expect(checkAnswer(q('Q4'), { chosen: ['TOP', 'TEAM'], note: 'MDRT' }, new Set())).toEqual({ value: { chosen: ['TOP', 'TEAM'], note: 'MDRT' } });
      expect(checkAnswer(q('Q4'), { chosen: ['TOP', 'FLOW'] }, new Set())).toEqual({ problem: 'exclusive' });
      expect(checkAnswer(q('Q4'), { chosen: [] }, new Set())).toEqual({ problem: 'choices' });
      expect(checkAnswer(q('Q4'), { chosen: ['NOPE'] }, new Set())).toEqual({ problem: 'choices' });
    });

    it('items: 1 to 5, the three states, and only the question’s own items; partial while saving, whole when answered', () => {
      expect(checkAnswer(q('Q5'), { PIPELINE: 2 }, new Set())).toEqual({ value: { PIPELINE: 2 } });
      expect(isAnswered(q('Q5'), { PIPELINE: 2 })).toBe(false);
      expect(checkAnswer(q('Q5'), { PIPELINE: 6 }, new Set())).toEqual({ problem: 'rating' });
      expect(checkAnswer(q('Q5'), { NOPE: 3 }, new Set())).toEqual({ problem: 'shape' });
      expect(checkAnswer(q('Q7'), { JFW: 'not_done' }, new Set())).toEqual({ value: { JFW: 'not_done' } });
      expect(checkAnswer(q('Q7'), { JFW: 'sometimes' }, new Set())).toEqual({ problem: 'state' });
    });

    it('Q11 names only the respondent’s own downline leaders; an anonymous run keeps the areas without their ids', () => {
      const mine = new Set(['m-sari']);
      const ok = checkAnswer(q('Q11'), { leaders: [{ membershipId: 'm-sari', areas: ['SALES', 'UNIT'] }] }, mine);
      expect(ok).toEqual({ value: { leaders: [{ membershipId: 'm-sari', areas: ['SALES', 'UNIT'] }] } });
      expect(checkAnswer(q('Q11'), { leaders: [{ membershipId: 'm-other', areas: [] }] }, mine)).toEqual({ problem: 'leader' });
      expect(checkAnswer(q('Q11'), { leaders: [{ membershipId: 'm-sari', areas: ['NOPE'] }] }, mine)).toEqual({ problem: 'area' });
      expect(anonymised(q('Q11'), (ok as { value: Record<string, unknown> }).value)).toEqual({ leaders: [{ areas: ['SALES', 'UNIT'] }] });
      expect(anonymised(q('Q5'), { PIPELINE: 2 })).toEqual({ PIPELINE: 2 });
    });

    it('Q10 yes or no; Q12 0 to 10 with an optional reason', () => {
      expect(checkAnswer(q('Q10'), { answer: 'yes' }, new Set())).toEqual({ value: { answer: 'yes' } });
      expect(checkAnswer(q('Q10'), { answer: 'maybe' }, new Set())).toEqual({ problem: 'yes_no' });
      expect(checkAnswer(q('Q12'), { score: 8, reason: 'Sering hadir' }, new Set())).toEqual({ value: { score: 8, reason: 'Sering hadir' } });
    });

    it('C-R6, C2-3 one of six answered: 1 dari 6, and Lanjutkan opens question 2; Kirim names the first missing', () => {
      const answers = { P1: { score: 8 } };
      expect(progressOf(nps, answers)).toEqual({ answeredCount: 1, resumeIndex: 1 });
      expect(firstMissing(nps, answers)).toBe('P2');
      const all = Object.fromEntries(nps.filter((x) => x.type === 'score').map((x) => [x.kode, { score: 9 }]));
      expect(firstMissing(nps, all)).toBeNull();
      // The open question is optional: unanswered, the form can still be sent.
      expect(progressOf(nps, all)).toEqual({ answeredCount: 5, resumeIndex: 5 });
    });
  });

  describe('the bands and the scores (§A.15)', () => {
    it('ages and tenure from the member list, banded by the snapshot’s thresholds', () => {
      expect(wholeYears('1999-11-06', '2026-11-05')).toBe(26);
      expect(wholeYears('1999-11-05', '2026-11-05')).toBe(27);
      expect([29, 30, 45, 46].map((a) => bandOf(a, [29, 45]))).toEqual([0, 1, 1, 2]);
      expect([2, 3, 7, 10, 11].map((y) => tenureBandOf(y, [3, 7, 10]))).toEqual([0, 1, 2, 3, 3]);
    });

    it('NPS_SCORE is round(100 · (P − D) / n) on the given cut-offs — the same answers score differently on 9 and on 8 (AT-8)', () => {
      const scores = [10, 9, 8, 8, 7, 6, 3];
      expect(npsScore(scores, 9, 7)).toEqual({ score: 0, promoters: 2, passives: 3, detractors: 2, n: 7 });
      expect(npsScore(scores, 8, 7).score).toBe(29);
      expect(npsScore([], 9, 7).score).toBeNull();
    });

    it('QUAL_ITEM_ISSUE_PCT: a rating at or below the cut-off, any state but Konsisten; Masalah besar and Perlu perhatian', () => {
      expect([1, 3, 4].map((v) => isIssue('rating', v, 3))).toEqual([true, true, false]);
      expect(['consistent', 'inconsistent', 'not_done'].map((v) => isIssue('state', v, 3))).toEqual([false, true, true]);
      expect([60, 59, 40, 39, null].map((p) => severityOf(p, 60, 40))).toEqual(['big', 'watch', 'watch', null, null]);
    });

    it('ADR-0216 §3 a breakdown cell under three respondents is null; the open answers are not in the order sent', () => {
      expect(smallCell(2, 40)).toBeNull();
      expect(smallCell(3, 40)).toBe(40);
      const sent = ['a', 'b', 'c', 'd', 'e'];
      expect([...scrambled(sent)].sort()).toEqual(sent);
      expect(scrambled(sent)).toEqual(scrambled([...sent].reverse()));
    });
  });
});
