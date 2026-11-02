import { readerIn } from '@/common/i18n/reader';
import {
  firstAgendaTexts, meetingMonth, monthBefore, newActionItem, newAgendaItemText, preparePerformanceData, redated, startingAgenda,
} from './leader-meeting-agenda';
import type { LeaderMeetingActionItem } from './leader-meeting.schema';
import {
  actionItemsInOrder, agendaOf, meetingState, monthlyTargetOf, openItemsOf, partialPeriodsOf, scorecardOf, ytdChangeOf,
} from './leader-meeting.view';
import { liveRecord } from './scorecard/scorecard-record';
import { columnPeriods } from './scorecard/scorecard.service';
import type { ColumnKey, ComputedScorecard, ScorecardCell } from './scorecard/scorecard.types';

const M = 1_000_000 * 100;
const fig = (value: number, leavesOut: string[] = []): ScorecardCell => ({ kind: 'figure', value, leavesOut });
const PENDING: ScorecardCell = { kind: 'pending' };
const all = (cell: ScorecardCell, over: Partial<Record<ColumnKey, ScorecardCell>> = {}): Record<ColumnKey, ScorecardCell> => ({
  fy: cell, ytdLastYear: cell, ytd: cell, thisMonthLastYear: cell, lastMonth: cell, thisMonth: cell, ...over,
});

const row = (itemId: string, order: number, status: LeaderMeetingActionItem['status'] = 'not_planned'): LeaderMeetingActionItem => ({
  itemId, initiative: itemId, metric: '', action: '', pic: '', status, remarks: '', order, version: 1,
});

describe('the forum’s rules, unit by unit (P18.1-T2)', () => {
  it('P18.1-T2 AC-7 Upcoming through the meeting’s date in the office’s calendar, Completed from the day after (F-185)', () => {
    expect(meetingState('2026-09-20', '2026-09-19')).toBe('upcoming');
    expect(meetingState('2026-09-20', '2026-09-20')).toBe('upcoming');
    expect(meetingState('2026-09-20', '2026-09-21')).toBe('completed');
    expect(meetingState('2026-12-31', '2027-01-01')).toBe('completed');
  });

  it('P18.1-T2 AC-6 the open items are the rows not Implemented (`:2586`); none is All clear', () => {
    expect(openItemsOf([row('a', 0), row('b', 1, 'planned'), row('c', 2, 'implemented')])).toBe(2);
    expect(openItemsOf([row('c', 0, 'implemented')])).toBe(0);
    expect(openItemsOf([])).toBe(0);
  });

  it('P18.1-T2 AC-6 the rows are served by their order; two given one place keep the order they are stored in', () => {
    expect(actionItemsInOrder([row('c', 2), row('a', 0), row('b', 1)]).map((r) => r.id)).toEqual(['a', 'b', 'c']);
    expect(actionItemsInOrder([row('y', 1), row('x', 1), row('w', 0)]).map((r) => r.id)).toEqual(['w', 'y', 'x']);
  });

  it('P18.1-T2 AC-5 an agenda missing a section reads it empty', () => {
    expect(agendaOf(null)).toEqual({ preparation: [], during: [], post: [] });
    expect(agendaOf({ preparation: [{ itemId: 'i', text: 't', pic: '', done: false, version: 1 }] } as never).preparation)
      .toEqual([{ id: 'i', text: 't', pic: '', done: false, version: 1 }]);
  });

  describe('P18.97-T1 the scorecard a meeting serves (ADR-0175)', () => {
    const computed = (units: number, asOf: string | null = '2026-10-26'): ComputedScorecard => ({
      periods: columnPeriods('2026-10-27'),
      chips: { manpower: 28, agents: 19, units, ab: 5, aab: 4 },
      rows: (['ape', 'manpower', 'producing_agents'] as const).map((key) => ({ key, unit: key === 'ape' ? 'idr_minor' : 'count', cells: all(PENDING) })),
      asOf,
    });

    it('P18.97-T1 AC-10 a target is the rate × the meeting’s # of units; a row the table does not track takes none; never typed is version 0', () => {
      const served = scorecardOf(liveRecord(computed(9)), {
        ape: { rate: 2 * 10 * M, typed: null, version: 2 }, manpower: { rate: 1.5, typed: null, version: 1 },
      }, null);
      expect(served.rows.map((r) => r.monthlyTarget)).toEqual([
        { rate: 20 * M, value: 180 * M, typed: null, version: 2 },
        { rate: 1.5, value: 13.5, typed: null, version: 1 },
        null,
      ]);
      expect(served.frozenAt).toBeNull();
      expect(scorecardOf(liveRecord(computed(9)), undefined, new Date('2026-10-01T03:00:00Z')).frozenAt).toBe('2026-10-01T03:00:00.000Z');
      expect(scorecardOf(liveRecord(computed(9)), null, null).rows[0].monthlyTarget).toEqual({ rate: null, value: null, typed: null, version: 0 });
    });

    it('P18.97-T1 AC-10 the multiplier is the meeting’s own units: 9 today, 5 on a meeting frozen with five', () => {
      const flc = { manpower: { rate: 1, typed: null, version: 1 } };
      expect(scorecardOf(liveRecord(computed(9)), flc, null).rows[1].monthlyTarget!.value).toBe(9);
      expect(scorecardOf(liveRecord(computed(5)), flc, null).rows[1].monthlyTarget!.value).toBe(5);
      // Three per unit with nine units: *"27 (3 @ unit)"*, the client's own example (UI-008).
      expect(monthlyTargetOf({ rate: 3, typed: null, version: 1 }, 9)).toEqual({ rate: 3, value: 27, typed: null, version: 1 });
      // A decimal rate's product carries no binary noise.
      expect(monthlyTargetOf({ rate: 0.1, typed: null, version: 1 }, 3).value).toBe(0.3);
    });

    it('P18.97-T1 AC-11 a target the migration could not read shows as typed until a rate is entered; one not migrated yet too', () => {
      expect(monthlyTargetOf({ rate: null, typed: 'Ask Hellen', version: 2 }, 9)).toEqual({ rate: null, value: null, typed: 'Ask Hellen', version: 2 });
      // A rate entered wins over the text.
      expect(monthlyTargetOf({ rate: 2, typed: 'Ask Hellen', version: 3 }, 9)).toEqual({ rate: 2, value: 18, typed: null, version: 3 });
      // A database 0043 has not reached: the text as typed, never parsed here.
      expect(monthlyTargetOf({ value: '8 (1 @ unit)', version: 1 }, 9)).toEqual({ rate: null, value: null, typed: '8 (1 @ unit)', version: 1 });
      expect(monthlyTargetOf({ value: '', version: 1 }, 9).typed).toBeNull();
    });

    it('P18.97-T1 AC-13 AS OF: the day of the latest upload, or none with no file', () => {
      expect(scorecardOf(liveRecord(computed(9)), null, null).asOf).toEqual({ kind: 'date', date: '2026-10-26' });
      expect(scorecardOf(liveRecord(computed(9, null)), null, null).asOf).toEqual({ kind: 'none' });
    });

    it('P18.97-T1 AC-17 the phone’s change: YTD against last year’s, whole; — where either is no figure or last year’s is 0', () => {
      const pct = (value: number) => ({ kind: 'figure', value, unit: 'percent' });
      expect(ytdChangeOf(all(PENDING, { ytd: fig(118), ytdLastYear: fig(100) }), 'count')).toEqual(pct(18));
      expect(ytdChangeOf(all(PENDING, { ytd: fig(5.8e9 * 100), ytdLastYear: fig(6.4e9 * 100) }), 'idr_minor')).toEqual(pct(-9));
      // Half up, as `rateOver` rounds: 57,5% is 58.
      expect(ytdChangeOf(all(PENDING, { ytd: fig(63), ytdLastYear: fig(40) }), 'count')).toEqual(pct(58));
      // An average, a fraction: the same rule on its exact quotient.
      expect(ytdChangeOf(all(PENDING, { ytd: fig(2.5), ytdLastYear: fig(2) }), 'count')).toEqual(pct(25));
      expect(ytdChangeOf(all(PENDING, { ytd: fig(2.5), ytdLastYear: fig(2) }), 'ratio')).toEqual(pct(25));
      expect(ytdChangeOf(all(PENDING, { ytd: fig(4), ytdLastYear: fig(0) }), 'count')).toEqual({ kind: 'none' });
      expect(ytdChangeOf(all(PENDING, { ytd: fig(4) }), 'count')).toEqual({ kind: 'none' });
      expect(ytdChangeOf(all(PENDING, { ytd: fig(4), ytdLastYear: { kind: 'unrecorded' } }), 'count')).toEqual({ kind: 'none' });
    });

    describe('P18.97-T8 F1 a percentage row’s change is the difference in percentage points (parity F-256)', () => {
      const points = (value: number) => ({ kind: 'figure', value, unit: 'points' });
      const threeMonths = (ytd: ScorecardCell, ytdLastYear: ScorecardCell) => ytdChangeOf(all(PENDING, { ytd, ytdLastYear }), 'percentage');

      it('P18.97-T8 F1 3M new agent % at 60% against 100% is −40 points, and at 45% against 30% +15 — never −40% or +50%', () => {
        expect(threeMonths(fig(60), fig(100))).toEqual(points(-40));
        expect(threeMonths(fig(45), fig(30))).toEqual(points(15));
        expect(threeMonths(fig(30), fig(30))).toEqual(points(0));
      });

      it('P18.97-T8 F1 a difference from 0% is a difference: 0% last year and 40% this year is +40 points, and the reverse −40', () => {
        expect(threeMonths(fig(40), fig(0))).toEqual(points(40));
        expect(threeMonths(fig(0), fig(40))).toEqual(points(-40));
      });

      it('P18.97-T8 F1 whole points, half up toward +∞ as `rateOver` rounds — a tenth kept by an older scorecard, its binary noise moving no half', () => {
        // 33,3 − 20,8 is 12,5 exactly, though `33.3 - 20.8` is 12.499999999999996 in binary: +13, not +12.
        expect(threeMonths(fig(33.3), fig(20.8))).toEqual(points(13));
        // 20,2 − 32,7 is −12,5, though `20.2 - 32.7` is −12.500000000000004: −12, toward +∞ as `rateOver` takes a half.
        expect(threeMonths(fig(20.2), fig(32.7))).toEqual(points(-12));
        expect(threeMonths(fig(20.8), fig(33.3))).toEqual(points(-12));
        expect(threeMonths(fig(50.4), fig(50))).toEqual(points(0));
        expect(threeMonths(fig(49.5), fig(50))).toEqual(points(0));
        expect(threeMonths(fig(49.4), fig(50))).toEqual(points(-1));
      });

      it('P18.97-T8 F1 — where either year is no figure: pending, unrecorded on a scorecard kept before, not tracked', () => {
        expect(threeMonths(PENDING, fig(30))).toEqual({ kind: 'none' });
        expect(threeMonths(fig(45), PENDING)).toEqual({ kind: 'none' });
        expect(threeMonths(fig(45), { kind: 'unrecorded' })).toEqual({ kind: 'none' });
        expect(threeMonths(fig(45), { kind: 'none' })).toEqual({ kind: 'none' });
        expect(threeMonths({ kind: 'blocked' }, fig(30))).toEqual({ kind: 'none' });
      });

      it('P18.97-T8 F1 the scorecard serves each row its own: points on 3M new agent %, a percentage on every count, sum and ratio', () => {
        const record = liveRecord({
          periods: columnPeriods('2026-10-27'),
          chips: { manpower: 28, agents: 19, units: 9, ab: 5, aab: 4 },
          rows: [
            { key: 'ape', unit: 'idr_minor', cells: all(PENDING, { ytd: fig(118 * M), ytdLastYear: fig(100 * M) }) },
            { key: 'manpower', unit: 'count', cells: all(PENDING, { ytd: fig(60), ytdLastYear: fig(100) }) },
            { key: 'new_agent_3m', unit: 'percentage', cells: all(PENDING, { ytd: fig(60), ytdLastYear: fig(100) }) },
            { key: 'cases_per_producing_agent', unit: 'ratio', cells: all(PENDING, { ytd: fig(2.4), ytdLastYear: fig(2) }) },
          ],
          asOf: '2026-10-26',
        });
        expect(scorecardOf(record, null, null).rows.map((r) => [r.key, r.ytdChange])).toEqual([
          ['ape', { kind: 'figure', value: 18, unit: 'percent' }],
          // The same 60 against 100 on a count is a fall of 40%; on a percentage, of 40 points.
          ['manpower', { kind: 'figure', value: -40, unit: 'percent' }],
          ['new_agent_3m', points(-40)],
          ['cases_per_producing_agent', { kind: 'figure', value: 20, unit: 'percent' }],
        ]);
      });
    });

    it('P18.97-T1 AC-12 one partial period per column a figure of which leaves months out, the months once each, in order', () => {
      const rows = [
        { cells: all(fig(1), { fy: fig(1, ['2025-03', '2025-01', '2025-02']), ytd: fig(1, ['2026-08']) }) },
        { cells: all(fig(1), { fy: fig(1, ['2025-01']), ytd: PENDING }) },
      ];
      expect(partialPeriodsOf(rows)).toEqual([
        { column: 'fy', leavesOut: ['2025-01', '2025-02', '2025-03'] },
        { column: 'ytd', leavesOut: ['2026-08'] },
      ]);
      expect(partialPeriodsOf([{ cells: all(fig(1)) }])).toEqual([]);
    });
  });

  describe('ADR-0130 §3, ADR-0176 §11 the agenda a new meeting starts from', () => {
    it('P18.97-T2 AC-4 "Prepare {month} performance data" names the meeting’s own month, in English, at a year’s edges', () => {
      expect(meetingMonth('2026-10-27')).toBe('October');
      expect(meetingMonth('2026-01-05')).toBe('January');
      expect(meetingMonth('2026-12-31')).toBe('December');
      expect(firstAgendaTexts('2026-10-27').preparation[1]).toBe('Prepare October performance data');
      expect(firstAgendaTexts('2027-01-04').preparation[1]).toBe('Prepare January performance data');
      expect(firstAgendaTexts('2026-12-30').preparation[1]).toBe('Prepare December performance data');
      // The previous session's month, which #13's prototype agenda still names for its follow-ups.
      expect(monthBefore('2026-01-05')).toBe('December');
    });

    it('P18.97-T2 AC-4 a copied month item is re-dated to the new meeting’s month; one a leader reworded, as typed', () => {
      expect(redated('Prepare September performance data', '2026-10-27')).toBe('Prepare October performance data');
      expect(redated('Prepare December performance data', '2027-01-08')).toBe('Prepare January performance data');
      expect(redated('Prepare Sept performance data', '2026-10-27')).toBe('Prepare Sept performance data');
      expect(redated('Prepare September performance data and the deck', '2026-10-27')).toBe('Prepare September performance data and the deck');
      expect(redated('Review scorecard, draft talking points', '2026-10-27')).toBe('Review scorecard, draft talking points');
    });

    it('P18.1-T2 AC-5 the first is the prototype’s ten; a later one copies text and PIC, unticked, every item new', () => {
      let n = 0;
      const ids = () => `id-${(n += 1)}`;
      const first = startingAgenda('2026-10-13', null, ids);
      expect([first.preparation.length, first.during.length, first.post.length]).toEqual([3, 5, 2]);
      expect(first.post[1]).toEqual({ itemId: 'id-10', text: 'Note feedback for RBDO/BDO', pic: '', done: false, version: 1 });
      const ticked = { ...first, during: first.during.map((i) => ({ ...i, done: true, pic: 'Wilson', version: 7 })) };
      const copy = startingAgenda('2026-11-10', ticked, ids);
      expect(copy.during[0]).toEqual({ itemId: 'id-14', text: first.during[0].text, pic: 'Wilson', done: false, version: 1 });
      // P18.97-T2 AC-4: the copied month item names the new meeting's month; every other item is copied as typed.
      expect(first.preparation[1].text).toBe('Prepare October performance data');
      expect(copy.preparation[1].text).toBe('Prepare November performance data');
      expect(copy.preparation.filter((_, i) => i !== 1).map((i) => i.text)).toEqual(first.preparation.filter((_, i) => i !== 1).map((i) => i.text));
      // A previous meeting stored before a section existed copies it empty.
      expect(startingAgenda('2026-10-27', { preparation: [] } as never, ids)).toEqual({ preparation: [], during: [], post: [] });
    });
  });

  /**
   * **A new meeting's words are its maker's** (P18.98-T5 AC-6; the glossary's §C9): the first agenda in Bahasa
   * Indonesia for an Indonesian reader, *RBDO/BDO* kept; the English byte for byte for an English one, and with no
   * reader. A copied agenda is the office's text: copied as stored, its month item re-dated in its own language.
   */
  describe('P18.98-T5 AC-6 the agenda a new meeting starts from, in its maker’s language', () => {
    const ID = readerIn('id');
    const EN = readerIn('en');

    it('P18.98-T5 AC-6 the prototype’s ten in Indonesian, and the English unchanged', () => {
      expect(firstAgendaTexts('2026-10-27', ID)).toEqual({
        preparation: [
          'Kumpulkan follow-up & komitmen dari sesi sebelumnya',
          'Siapkan data kinerja Oktober',
          'Tinjau scorecard, susun poin pembahasan',
        ],
        during: [
          'Pembaruan proses — tinjau follow-up sebelumnya',
          'Tinjauan kinerja terhadap ambang batas utama',
          'Prioritas strategis (Korporat)',
          'Prioritas strategis (Agency)',
          'Rangkum langkah berikutnya & tetapkan penanggung jawab',
        ],
        post: ['Catat hasil ke dalam template', 'Catat masukan untuk RBDO/BDO'],
      });
      const english = {
        preparation: [
          'Compile follow-ups & commitments from prior session',
          'Prepare October performance data',
          'Review scorecard, draft talking points',
        ],
        during: [
          'Process update — review prior follow-ups',
          'Performance review vs. key thresholds',
          'Strategic priorities (Corporate)',
          'Strategic priorities (Agency)',
          'Summarize next steps & assign owners',
        ],
        post: ['Document outcomes into template', 'Note feedback for RBDO/BDO'],
      };
      expect(firstAgendaTexts('2026-10-27', EN)).toEqual(english);
      expect(firstAgendaTexts('2026-10-27')).toEqual(english);
      expect(meetingMonth('2026-08-03', 'id')).toBe('Agustus');
      expect(preparePerformanceData('2027-01-04', ID)).toBe('Siapkan data kinerja Januari');
    });

    it('P18.98-T5 AC-6 a copied month item is re-dated in the language it was written in; a reworded one stays as typed', () => {
      expect(redated('Siapkan data kinerja September', '2026-10-27')).toBe('Siapkan data kinerja Oktober');
      expect(redated('Siapkan data kinerja Desember', '2027-01-08')).toBe('Siapkan data kinerja Januari');
      expect(redated('Siapkan data kinerja Sept', '2026-10-27')).toBe('Siapkan data kinerja Sept');
      expect(redated('Prepare September performance data', '2026-10-27')).toBe('Prepare October performance data');
    });

    it('P18.98-T5 AC-6 an Indonesian reader’s first meeting; a copy of it made by an English reader keeps its words', () => {
      let n = 0;
      const ids = () => `id-${(n += 1)}`;
      const first = startingAgenda('2026-10-13', null, ids, ID);
      expect(first.post[1]).toEqual({ itemId: 'id-10', text: 'Catat masukan untuk RBDO/BDO', pic: '', done: false, version: 1 });
      expect(first.preparation[1].text).toBe('Siapkan data kinerja Oktober');
      const copy = startingAgenda('2026-11-10', first, ids, EN);
      expect(copy.preparation.map((i) => i.text)).toEqual([
        'Kumpulkan follow-up & komitmen dari sesi sebelumnya', 'Siapkan data kinerja November', 'Tinjau scorecard, susun poin pembahasan',
      ]);
      expect(startingAgenda('2026-10-13', null, ids, EN).post[1].text).toBe('Note feedback for RBDO/BDO');
    });

    it('P18.98-T5 AC-6 + Add item and + Add action item write their rows in the adder’s language; TBD is kept', () => {
      expect(newAgendaItemText(ID)).toBe('Item agenda baru');
      expect(newAgendaItemText()).toBe('New agenda item');
      expect(newActionItem(ID)).toEqual({
        initiative: 'Inisiatif baru', metric: 'Ukuran keberhasilan', action: 'Tindakan baru', pic: 'TBD', status: 'not_planned',
        remarks: 'TBD',
      });
      expect(newActionItem(EN)).toEqual({
        initiative: 'New initiative', metric: 'Success metric', action: 'New action item', pic: 'TBD', status: 'not_planned',
        remarks: 'TBD',
      });
    });
  });
});
