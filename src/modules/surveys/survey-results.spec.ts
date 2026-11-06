import { platformAnalyticsConfig } from '@/modules/config/analytics-config';
import { SURVEY } from '@/domain/constants';
import { snapshotOf } from './survey-opening';
import { npsResults, qualResults, type ResponseRow } from './survey-results';
import { complemented, underFloor } from './survey-rules';

/**
 * **The results' floor at small n** (P19.5-T4; ADR-0216 §3, amended 2026-11-06): one or two respondents' score is their
 * answer, so an anonymous run under `SURVEY.MIN_GROUP` shows no figure, and a breakdown never hides a single cell that
 * the overall and the other cells would give back.
 */
const published = { templateId: null, templateName: null, version: 1, config: platformAnalyticsConfig() };
const npsSnap = snapshotOf({ kind: 'nps', anonymous: true, perPerson: false }, published);
const qualSnap = snapshotOf({ kind: 'qual', anonymous: true, perPerson: false }, published);
const LIVE = { qualBigPct: 60, qualWatchPct: 40, coachingGoodPct: 70 };

/** A sent NPS form: the same score on P1 to P5, an open answer, and its bands. */
function nps(score: number, bands: Partial<Omit<ResponseRow, 'answers'>> = {}, open = 'Lebih banyak pelatihan.'): ResponseRow {
  return {
    answers: [
      ...['P1', 'P2', 'P3', 'P4', 'P5'].map((kode) => ({ questionKode: kode, value: { score } })),
      { questionKode: 'OPEN', value: { text: open } },
    ],
    roleClass: 'agent', tenureBand: 0, ageBand: 0, ...bands,
  };
}

/** A sent qualitative form: Q4, every Q5 item at `rating`, Q12; an AB also the leader blocks' Q6 and Q10. */
function qual(rating: number, leader = false): ResponseRow {
  const q5 = qualSnap.blocks.find((b) => b.kode === 'SALES')!.questions[0].items.map((i) => i.kode);
  const q6 = qualSnap.blocks.find((b) => b.kode === 'RECRUIT')!.questions[0].items.map((i) => i.kode);
  return {
    answers: [
      { questionKode: 'Q4', value: { chosen: ['TOP'] } },
      { questionKode: 'Q5', value: Object.fromEntries(q5.map((k) => [k, rating])) },
      ...(leader ? [
        { questionKode: 'Q6', value: Object.fromEntries(q6.map((k) => [k, rating])) },
        { questionKode: 'Q10', value: { answer: 'yes' } },
      ] : []),
      { questionKode: 'Q12', value: { score: 9 } },
    ],
    roleClass: leader ? 'ab' : 'agent', tenureBand: 0, ageBand: 0,
  };
}

const anonymous = (rows: ResponseRow[]) => ({ snapshot: npsSnap, rows, anonymous: true });
const named = (rows: ResponseRow[]) => ({ snapshot: npsSnap, rows, anonymous: false });

describe('P19.5-T4 ADR-0216 §3 the results at small n', () => {
  describe('the floor', () => {
    it('P19.5-T4 ADR-0216 §3 the floor is an anonymous run’s, under SURVEY.MIN_GROUP (3)', () => {
      expect(SURVEY.MIN_GROUP).toBe(3);
      expect([0, 1, 2, 3].map((n) => underFloor(true, n))).toEqual([true, true, true, false]);
      expect([0, 1, 2].map((n) => underFloor(false, n))).toEqual([false, false, false]);
    });

    it('P19.5-T4 ADR-0216 §3 an anonymous NPS run under three respondents: no overall, no score or change per aspect or question, no open answers', () => {
      for (const rows of [[nps(9)], [nps(9), nps(3)]]) {
        const r = npsResults(anonymous(rows), 'office', null);
        expect(r.respondents).toBe(rows.length);
        expect(r.overall).toBeNull();
        expect(r.change).toBeNull();
        expect(r.aspects.map((a) => [a.score, a.change])).toEqual(r.aspects.map(() => [null, null]));
        expect(r.questions.map((q) => [q.score, q.change])).toEqual(r.questions.map(() => [null, null]));
        // How many answered is a count, not an answer: it stays.
        expect(r.questions.map((q) => q.n)).toEqual(r.questions.map(() => rows.length));
        expect(r.openAnswers).toBeNull();
        expect(Object.values(r.breakdowns).flat().every((c) => c.score === null)).toBe(true);
        expect(JSON.stringify(r)).not.toContain('Lebih banyak pelatihan');
      }
    });

    it('P19.5-T4 ADR-0216 §3 at three respondents the anonymous run’s figures are shown', () => {
      const r = npsResults(anonymous([nps(9), nps(9), nps(3)]), 'office', null);
      // 15 scores: 10 promoters, 5 detractors — round(100 · 5 / 15) = 33.
      expect(r.overall).toEqual({ score: 33, promoters: 10, passives: 0, detractors: 5, n: 15 });
      expect(r.questions.every((q) => q.score === 33)).toBe(true);
      expect(r.openAnswers).toHaveLength(3);
    });

    it('P19.5-T4 ADR-0216 §3 a run that is not anonymous keeps its figures under three: its respondents were told', () => {
      const r = npsResults(named([nps(10)]), 'office', null);
      expect(r.overall).toMatchObject({ score: 100, n: 5 });
      expect(r.questions[0].score).toBe(100);
      expect(r.openAnswers).toEqual(['Lebih banyak pelatihan.']);
      // The cell minimum is every run's.
      expect(r.breakdowns.roleClass).toEqual([{ key: 'agent', respondents: 1, score: null }]);
    });

    it('P19.5-T4 ADR-0216 §3 a previous anonymous run under its floor gives no change, which today’s score would give back', () => {
      const today = anonymous([nps(9), nps(9), nps(9)]);
      expect(npsResults(today, 'office', anonymous([nps(3)])).change).toBeNull();
      expect(npsResults(today, 'office', anonymous([nps(3)])).questions.map((q) => q.change)).toEqual([null, null, null, null, null]);
      expect(npsResults(today, 'office', anonymous([nps(3)])).aspects.every((a) => a.change === null)).toBe(true);
      // Over its floor, or not anonymous, the previous run gives its change.
      expect(npsResults(today, 'office', anonymous([nps(3), nps(3), nps(3)])).change).toBe(200);
      expect(npsResults(today, 'office', named([nps(3)])).change).toBe(200);
    });

    it('P19.5-T4 ADR-0216 §3 an anonymous qualitative run: a figure over fewer than three answers is null; how many answered stays', () => {
      // Two agents: every figure is under the floor.
      const two = qualResults({ snapshot: qualSnap, rows: [qual(1), qual(5)], anonymous: true }, 'office', LIVE);
      const sales = two.blocks.find((b) => b.kode === 'SALES')!.items;
      expect(sales.map((i) => [i.answers, i.issues, i.issuePct, i.severity])).toEqual(sales.map(() => [2, null, null, null]));
      expect(two.aspiration.map((a) => [a.count, a.pct])).toEqual(two.aspiration.map(() => [null, null]));
      expect(two.support).toEqual({ n: 2, satisfiedPct: null, fairPct: null, poorPct: null });
      expect(two.respondents).toBe(2);
    });

    it('P19.5-T4 ADR-0216 §3 per figure: four sent, one AB answered the leader blocks — those are hidden, Penjualan is shown', () => {
      const r = qualResults({
        snapshot: qualSnap, rows: [qual(1, true), qual(1), qual(5), qual(5)], anonymous: true,
      }, 'office', LIVE);
      expect(r.blocks.find((b) => b.kode === 'SALES')!.items[0]).toMatchObject({ answers: 4, issues: 2, issuePct: 50, severity: 'watch' });
      expect(r.blocks.find((b) => b.kode === 'RECRUIT')!.items[0]).toMatchObject({ answers: 1, issues: null, issuePct: null, severity: null });
      expect(r.coachingDownline).toEqual({ n: 1, pct: null, good: null });
      expect(r.aspiration.find((a) => a.kode === 'TOP')).toMatchObject({ count: 4, pct: 100 });
      expect(r.support).toMatchObject({ n: 4, satisfiedPct: 100 });
    });

    it('P19.5-T4 ADR-0216 §3 a qualitative run that is not anonymous keeps its figures under three', () => {
      const r = qualResults({ snapshot: qualSnap, rows: [qual(1, true)], anonymous: false }, 'office', LIVE);
      expect(r.blocks.find((b) => b.kode === 'RECRUIT')!.items[0]).toMatchObject({ answers: 1, issues: 1, issuePct: 100, severity: 'big' });
      expect(r.coachingDownline).toEqual({ n: 1, pct: 100, good: true });
      expect(r.aspiration.find((a) => a.kode === 'TOP')).toMatchObject({ count: 1, pct: 100 });
    });
  });

  describe('one hidden cell is never alone', () => {
    const cell = (key: string, respondents: number, score: number | null = respondents < 3 ? null : 10 * respondents) =>
      ({ key, respondents, score });

    it('P19.5-T4 ADR-0216 §3 one hidden cell: the shown cell with the fewest respondents is hidden too', () => {
      expect(complemented([cell('aab', 1), cell('ab', 3), cell('agent', 4)], 0))
        .toEqual([cell('aab', 1), { key: 'ab', respondents: 3, score: null }, cell('agent', 4)]);
    });

    it('P19.5-T4 ADR-0216 §3 a tie hides the first by key; two hidden cells, or none, stay as they are', () => {
      expect(complemented([cell('0', 2), cell('1', 5), cell('2', 5)], 0).map((c) => c.score)).toEqual([null, null, 50]);
      expect(complemented([cell('0', 2), cell('1', 1), cell('2', 5)], 0).map((c) => c.score)).toEqual([null, null, 50]);
      expect(complemented([cell('0', 3), cell('1', 5)], 0).map((c) => c.score)).toEqual([30, 50]);
      // Nothing shown to hide: a lone hidden cell stays alone.
      expect(complemented([cell('0', 2)], 0).map((c) => c.score)).toEqual([null]);
    });

    it('P19.5-T4 ADR-0216 §3 the rows with no band are a group of their own: one or two of them hide the smallest cell', () => {
      expect(complemented([cell('0', 3), cell('1', 4)], 1).map((c) => c.score)).toEqual([null, 40]);
      expect(complemented([cell('0', 3), cell('1', 4)], 3).map((c) => c.score)).toEqual([30, 40]);
      // With a hidden cell beside them, two are hidden already.
      expect(complemented([cell('0', 2), cell('1', 4)], 2).map((c) => c.score)).toEqual([null, 40]);
    });

    it('P19.5-T4 ADR-0216 §3 in the NPS breakdowns: one AAB beside three ABs and four agents hides the ABs’ cell as well', () => {
      const rows = [
        nps(3, { roleClass: 'aab' }),
        ...[9, 9, 9].map((s) => nps(s, { roleClass: 'ab' })),
        ...[10, 10, 8, 8].map((s) => nps(s, { roleClass: 'agent' })),
      ];
      const r = npsResults(anonymous(rows), 'office', null);
      expect(r.breakdowns.roleClass).toEqual([
        { key: 'aab', respondents: 1, score: null },
        { key: 'ab', respondents: 3, score: null },
        { key: 'agent', respondents: 4, score: 50 },
      ]);
      // Two with no date of birth beside eight banded: the smallest band is hidden with them.
      const aged = npsResults(anonymous([
        ...rows.slice(0, 3).map((x) => ({ ...x, ageBand: 1 })), ...rows.slice(3, 6), ...rows.slice(6).map((x) => ({ ...x, ageBand: null })),
      ]), 'office', null);
      // Band 1: the AAB's 3s and two ABs' 9s — 10 promoters, 5 detractors of 15, 33. The tie hides band 0, first by key.
      expect(aged.breakdowns.ageBand.map((c) => [c.key, c.respondents, c.score])).toEqual([['0', 3, null], ['1', 3, 33]]);
    });
  });
});
