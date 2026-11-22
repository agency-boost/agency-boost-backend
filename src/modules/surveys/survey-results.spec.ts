import { platformAnalyticsConfig } from '@/modules/config/analytics-config';
import { SURVEY } from '@/domain/constants';
import { snapshotOf } from './survey-opening';
import {
  npsHeadlineOf, npsResults, qualResults, rowsOf, sharesOf, whoShown, type NpsHistoryRun, type ResponseRow,
} from './survey-results';
import { complemented, underFloor } from './survey-rules';

/**
 * **The results, per view, and their floor at small n** (P19.5-T4, rebuilt by P19.22-T6 and T7; ADR-0216 §3, ADR-0276
 * §1–§5): the first NPS question is *Keseluruhan KPM*, the others lowest first with their shares, trend and reasons;
 * *Analisa kualitatif* ranks A–D by *% masalah* against *semester lalu*; an anonymous run under `SURVEY.MIN_GROUP`
 * shows no figure, a class view is hidden while either class is under it, and a quote names its class only from it.
 */
const published = { templateId: null, templateName: null, version: 1, config: platformAnalyticsConfig() };
const npsSnap = snapshotOf({ kind: 'nps', anonymous: true, perPerson: false }, published);
const qualSnap = snapshotOf({ kind: 'qual', anonymous: true, perPerson: false }, published);
const LIVE = { qualBigPct: 60, qualWatchPct: 40, coachingGoodPct: 70 };

/** A sent NPS form: `p1` on P1, `rest` on P2–P5 (P3 one lower), a *Kenapa?* on P2, and an open answer. */
function nps(p1: number, extra: Partial<Omit<ResponseRow, 'answers'>> = {}, rest = p1, why = '', open = ''): ResponseRow {
  return {
    answers: [
      { questionKode: 'P1', value: { score: p1 } },
      { questionKode: 'P2', value: { score: rest, ...(why ? { why } : {}) } },
      { questionKode: 'P3', value: { score: Math.max(0, rest - 1) } },
      { questionKode: 'P4', value: { score: rest } },
      { questionKode: 'P5', value: { score: rest } },
      ...(open ? [{ questionKode: 'OPEN', value: { text: open } }] : []),
    ],
    roleClass: 'agent', tenureBand: 0, ageBand: 0, ...extra,
  };
}

/** A sent qualitative form: Q4 with a note, every Q5 item at `rating`, Q12 with a reason; a leader the leader blocks. */
function qual(rating: number, leader = false, extra: Partial<Omit<ResponseRow, 'answers'>> = {}): ResponseRow {
  const items = (block: string, q = 0) => qualSnap.blocks.find((b) => b.kode === block)!.questions[q].items.map((i) => i.kode);
  return {
    answers: [
      { questionKode: 'Q4', value: { chosen: [leader ? 'TEAM' : 'TOP'], note: leader ? 'Membangun tim.' : 'Jadi MDRT.' } },
      { questionKode: 'Q5', value: Object.fromEntries(items('SALES').map((k) => [k, rating])) },
      ...(leader ? [
        { questionKode: 'Q6', value: Object.fromEntries(items('RECRUIT').map((k) => [k, rating])) },
        { questionKode: 'Q7', value: Object.fromEntries(items('ACTIVATION').map((k) => [k, rating <= 3 ? 'inconsistent' : 'consistent'])) },
        { questionKode: 'Q8', value: Object.fromEntries(items('UNIT').map((k) => [k, 'consistent'])) },
        { questionKode: 'Q9', value: Object.fromEntries(items('UNIT', 1).map((k) => [k, rating])) },
        { questionKode: 'Q10', value: { answer: 'yes' } },
        { questionKode: 'Q11', value: { leaders: [{ membershipId: 'mem-down', areas: rating <= 3 ? ['SALES'] : [] }] } },
      ] : []),
      { questionKode: 'Q12', value: { score: leader ? 6 : 9, reason: leader ? 'Jarang bertemu.' : 'Selalu membantu.' } },
    ],
    roleClass: leader ? 'ab' : 'agent', tenureBand: leader ? 2 : 0, ageBand: 0, workStatus: leader ? 'full_time' : 'part_time',
    membershipId: null, ...extra,
  };
}

const run = (rows: ResponseRow[], anonymous = true, periodKey = '2026-Q4'): NpsHistoryRun => ({ snapshot: npsSnap, rows, anonymous, periodKey });
const qrun = (rows: ResponseRow[], anonymous = true) => ({ snapshot: qualSnap, rows, anonymous });

describe('P19.22 ADR-0276 the survey results', () => {
  describe('the floor and the views', () => {
    it('P19.22 ADR-0216 §3 the floor is an anonymous run’s, under SURVEY.MIN_GROUP (3)', () => {
      expect(SURVEY.MIN_GROUP).toBe(3);
      expect([0, 1, 2, 3].map((n) => underFloor(true, n))).toEqual([true, true, true, false]);
      expect([0, 1, 2].map((n) => underFloor(false, n))).toEqual([false, false, false]);
    });

    it('P19.22-T6 AC-1 ADR-0276 §3 the leaders are the ABs and the AABs; a class view of an anonymous run needs three of each class', () => {
      const rows = [nps(9, { roleClass: 'ab' }), nps(9, { roleClass: 'aab' }), nps(9), nps(9), nps(9)];
      expect(rowsOf(rows, 'leader')).toHaveLength(2);
      expect(rowsOf(rows, 'agent')).toHaveLength(3);
      expect(rowsOf(rows, 'all')).toHaveLength(5);
      expect(whoShown(run(rows), 'all')).toBe(true);
      expect(whoShown(run(rows), 'agent')).toBe(false);
      expect(whoShown(run([...rows, nps(9, { roleClass: 'ab' })]), 'agent')).toBe(true);
      expect(whoShown(run(rows, false), 'leader')).toBe(true);
    });

    it('P19.22-T6 AC-1 ADR-0276 §3 a hidden class view has no figure and no quote; the counts stay', () => {
      const rows = [nps(9, { roleClass: 'ab' }, 9, 'Jelas.'), ...[10, 10, 3].map((s) => nps(s, {}, s, 'Ok.'))];
      const r = npsResults(run(rows), 'office', [], 'agent');
      expect(r).toMatchObject({ who: 'agent', whoShown: false, respondents: 3, improve: null });
      expect(r.headline).toMatchObject({ score: null, n: 3, shares: null, reasons: null });
      expect(r.questions.every((q) => q.score === null && q.reasons === null)).toBe(true);
    });
  });

  describe('NPS', () => {
    it('P19.22-T6 AC-2 ADR-0276 §1 Keseluruhan KPM is the first question; the others follow lowest first', () => {
      const rows = [10, 10, 9, 8, 3].map((s) => nps(s, {}, 7));
      const r = npsResults(run(rows), 'office', []);
      expect(r.headline).toMatchObject({ kode: 'P1', score: 40, n: 5 });
      // P3 scores one lower than P2, P4, P5: 6s, all detractors.
      expect(r.questions.map((q) => q.kode)).toEqual(['P3', 'P2', 'P4', 'P5']);
      expect(r.questions[0].score).toBe(-100);
      expect(npsHeadlineOf(run(rows))).toBe(40);
    });

    it('P19.22-T6 AC-2 the promoter · passive · detractor shares add to 100 and their ends differ by the score', () => {
      expect(sharesOf([10, 10, 9, 8, 3], 9, 7)).toEqual({ promoterPct: 60, passivePct: 20, detractorPct: 20 });
      // 69 / 24 / 7 → 62, the mockup's headline.
      const scores = [...Array(20).fill(9), ...Array(7).fill(7), ...Array(2).fill(3)];
      const s = sharesOf(scores, 9, 7)!;
      expect(s.promoterPct + s.passivePct + s.detractorPct).toBe(100);
      expect(s.promoterPct - s.detractorPct).toBe(Math.round((100 * (20 - 2)) / 29));
      expect(sharesOf([], 9, 7)).toBeNull();
    });

    it('P19.22-T6 AC-2 change in poin against the previous run, and a four-run trend oldest first', () => {
      const q1 = run([10, 10, 3].map((s) => nps(s)), true, '2026-Q1');
      const q2 = run([10, 3, 3].map((s) => nps(s)), true, '2026-Q2');
      const q3 = run([10, 10].map((s) => nps(s)), true, '2026-Q3');
      const now = run([10, 10, 10].map((s) => nps(s)), true, '2026-Q4');
      const r = npsResults(now, 'office', [q1, q2, q3]);
      expect(r.trendPeriods).toEqual(['2026-Q1', '2026-Q2', '2026-Q3', '2026-Q4']);
      // Q3 had two answers, anonymous: hidden in the trend, and no change against it.
      expect(r.headline!.trend).toEqual([33, -33, null, 100]);
      expect(r.headline!.change).toBeNull();
      const named = npsResults(now, 'office', [q1, q2]);
      expect(named.headline!.change).toBe(100 - -33);
    });

    it('P19.22-T6 AC-2 ADR-0276 §3 the reasons: tagged by class from three of it, untagged below, none for a summary', () => {
      const rows = [
        nps(9, { roleClass: 'ab' }, 9, 'Visi sudah jelas.'),
        nps(9, {}, 9, 'Hanya slogan.'), nps(9, {}, 9, 'Terlalu umum.'), nps(9, {}, 9, ''),
      ];
      const r = npsResults(run(rows), 'office', []);
      const p2 = r.questions.find((q) => q.kode === 'P2')!;
      expect(p2.reasons).toHaveLength(3);
      expect(p2.reasons!.find((q) => q.text === 'Visi sudah jelas.')!.who).toBeNull();
      expect(p2.reasons!.find((q) => q.text === 'Hanya slogan.')!.who).toBe('agent');
      expect(npsResults(run(rows, false), 'office', []).questions.find((q) => q.kode === 'P2')!.reasons!
        .find((q) => q.text === 'Visi sudah jelas.')!.who).toBe('leader');
      expect(npsResults(run(rows), 'summary', []).questions.every((q) => q.reasons === null)).toBe(true);
      // Under the floor: no reasons at all.
      expect(npsResults(run(rows.slice(0, 2)), 'office', []).questions.find((q) => q.kode === 'P2')!.reasons).toBeNull();
    });

    it('P19.22-T6 AC-2 the open question’s answers are *what to improve*, in an order that is not the order sent', () => {
      const rows = ['Lebih banyak pelatihan.', 'Acara rutin.', 'Coaching mingguan.'].map((t) => nps(9, {}, 9, '', t));
      const r = npsResults(run(rows), 'office', []);
      expect(r.improve!.map((q) => q.text).sort()).toEqual(['Acara rutin.', 'Coaching mingguan.', 'Lebih banyak pelatihan.']);
      expect(npsResults(run(rows), 'summary', []).improve).toBeNull();
    });
  });

  describe('Analisa kualitatif', () => {
    it('P19.22-T7 AC-2 A–D in one row format, ranked by % masalah; the agents’ view of a leader block says it was not asked', () => {
      const rows = [qual(2, true), qual(5, true), qual(1, true), qual(2), qual(4), qual(5)];
      const r = qualResults(qrun(rows, false), 'office', LIVE);
      const sales = r.blocks.find((b) => b.kode === 'SALES')!;
      expect(sales).toMatchObject({ asked: true, respondents: 6 });
      expect(sales.rows[0]).toMatchObject({ answers: 6, issuePct: 50, severity: 'watch' });
      const recruit = r.blocks.find((b) => b.kode === 'RECRUIT')!;
      expect(recruit.rows[0]).toMatchObject({ answers: 3, issuePct: 67, severity: 'big' });
      const agents = qualResults(qrun(rows, false), 'office', LIVE, null, 'agent');
      expect(agents.blocks.find((b) => b.kode === 'RECRUIT')).toMatchObject({ asked: false, respondents: 0, rows: [] });
      expect(agents.blocks.find((b) => b.kode === 'SALES')!.rows[0].issuePct).toBe(33);
      expect(agents.coachingDownline.asked).toBe(false);
    });

    it('P19.22-T7 AC-2 D · Manajemen unit carries *tidak nyaman x%* from Q9 beside Q8’s consistency', () => {
      const r = qualResults(qrun([qual(2, true), qual(5, true), qual(1, true)], false), 'office', LIVE);
      const unit = r.blocks.find((b) => b.kode === 'UNIT')!;
      expect(unit.rows[0]).toMatchObject({ kind: 'state', issuePct: 0, comfortPct: 67 });
      expect(r.blocks.find((b) => b.kode === 'SALES')!.rows[0].comfortPct).toBeNull();
    });

    it('P19.22-T7 AC-2 ADR-0276 §4 semester lalu: ▲ worse, ▼ better against the run before, same view', () => {
      const before = qrun([qual(5), qual(5), qual(2)], false);
      const now = qrun([qual(2), qual(2), qual(5)], false);
      const r = qualResults(now, 'office', LIVE, before);
      expect(r.blocks.find((b) => b.kode === 'SALES')!.rows[0]).toMatchObject({ issuePct: 67, previousPct: 33, trend: 'worse' });
      const better = qualResults(before, 'office', LIVE, now);
      expect(better.blocks.find((b) => b.kode === 'SALES')!.rows[0]).toMatchObject({ issuePct: 33, previousPct: 67, trend: 'better' });
      expect(qualResults(now, 'office', LIVE, null).blocks[0].rows[0].trend).toBeNull();
    });

    it('P19.22-T7 AC-2 Siapa yang menjawab, Aspirasi with the leaders’ and agents’ shares, Dukungan leader by who rated', () => {
      const rows = [qual(2, true), qual(5, true), qual(1, true), qual(2), qual(4), qual(5)];
      const r = qualResults(qrun(rows, false), 'office', LIVE);
      expect(r.profile.workStatus).toEqual({ fullTime: 3, partTime: 3, unknown: 0 });
      expect(r.profile.tenure).toMatchObject({ counts: [3, 0, 3, 0], unknown: 0 });
      expect(r.aspiration.find((a) => a.kode === 'TOP')).toMatchObject({ pct: 50, leaderPct: 0, agentPct: 100 });
      expect(r.support).toEqual([
        { rater: 'agent', n: 3, average: 9, satisfiedPct: 100, fairPct: 0, poorPct: 0 },
        { rater: 'leader', n: 3, average: 6, satisfiedPct: 0, fairPct: 0, poorPct: 100 },
      ]);
      expect(qualResults(qrun(rows, false), 'office', LIVE, null, 'leader').support.map((s) => s.rater)).toEqual(['leader']);
      expect(r.aspirationNotes!.map((q) => q.text).sort()).toEqual(['Jadi MDRT.', 'Jadi MDRT.', 'Jadi MDRT.', 'Membangun tim.', 'Membangun tim.', 'Membangun tim.']);
    });

    it('P19.22-T7 AC-2 ADR-0276 §5 Suara responden: the office’s alone, from three reasons; a core leader and a summary get none', () => {
      const rows = [qual(2, true), qual(5), qual(4)];
      expect(qualResults(qrun(rows, false), 'office', LIVE).voices).toHaveLength(3);
      expect(qualResults(qrun(rows, false), 'core_leader', LIVE).voices).toBeNull();
      expect(qualResults(qrun(rows, false), 'summary', LIVE).voices).toBeNull();
      expect(qualResults(qrun(rows.slice(0, 2), false), 'office', LIVE).voices).toBeNull();
    });

    it('P19.22-T7 AC-2 Coaching leader downline: x dari y, and a named run’s table of downline leaders', () => {
      const rows = [qual(2, true, { membershipId: 'mem-agus' }), qual(5, true, { membershipId: 'mem-yosef' })];
      const r = qualResults(qrun(rows, false), 'office', LIVE);
      expect(r.coachingDownline).toMatchObject({ asked: true, n: 2, yes: 2, pct: 100, good: true });
      expect(r.coachingDownline.rows).toEqual([
        { leaderId: 'mem-down', uplineId: 'mem-agus', areas: ['SALES'], independent: false },
        { leaderId: 'mem-down', uplineId: 'mem-yosef', areas: [], independent: true },
      ]);
      expect(qualResults(qrun(rows, true), 'office', LIVE).coachingDownline.rows).toBeNull();
    });

    it('P19.22 ADR-0216 §3 an anonymous qualitative run: a figure over fewer than three answers is null; how many answered stays', () => {
      const two = qualResults(qrun([qual(1), qual(5)]), 'office', LIVE);
      const sales = two.blocks.find((b) => b.kode === 'SALES')!.rows;
      expect(sales.map((i) => [i.answers, i.issuePct, i.severity])).toEqual(sales.map(() => [2, null, null]));
      expect(two.aspiration.map((a) => a.pct)).toEqual(two.aspiration.map(() => null));
      expect(two.profile).toEqual({ workStatus: null, tenure: null });
      expect(two.support[0]).toMatchObject({ n: 2, average: null, satisfiedPct: null });
      expect(two.aspirationNotes).toBeNull();
      expect(two.respondents).toBe(2);
    });
  });

  describe('one hidden cell is never alone (the breakdown rule the class views follow)', () => {
    const cell = (key: string, respondents: number, score: number | null = respondents < 3 ? null : 10 * respondents) =>
      ({ key, respondents, score });

    it('P19.5-T4 ADR-0216 §3 one hidden cell: the shown cell with the fewest respondents is hidden too', () => {
      expect(complemented([cell('aab', 1), cell('ab', 3), cell('agent', 4)], 0))
        .toEqual([cell('aab', 1), { key: 'ab', respondents: 3, score: null }, cell('agent', 4)]);
      expect(complemented([cell('0', 3), cell('1', 5)], 0).map((c) => c.score)).toEqual([30, 50]);
      expect(complemented([cell('0', 3), cell('1', 4)], 1).map((c) => c.score)).toEqual([null, 40]);
    });
  });
});
