import { firstAgendaTexts, monthBefore, startingAgenda } from './leader-meeting-agenda';
import type { LeaderMeetingActionItem } from './leader-meeting.schema';
import { actionItemsInOrder, agendaOf, meetingState, openItemsOf, scorecardOf } from './leader-meeting.view';
import type { ComputedScorecard } from './scorecard/scorecard.types';

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

  it('P18.1-T2 AC-4 the typed targets lay over the six open rows; a blocked row takes none; a cell never typed is version 0', () => {
    const cells = { fy: { kind: 'pending' }, ytd: { kind: 'pending' }, thisMonthLastYear: { kind: 'pending' }, lastMonth: { kind: 'pending' }, thisMonth: { kind: 'pending' } };
    const computed = {
      periods: { fy: '2025', ytd: '2026', thisMonthLastYear: '2025-10', lastMonth: '2026-09', thisMonth: '2026-10' },
      chips: { manpower: 1, agents: 1, units: 0, ab: 0, aab: 0 },
      rows: (['ape', 'manpower', 'producing_agents'] as const).map((key) => ({ key, unit: 'count', cells })),
    } as unknown as ComputedScorecard;
    const served = scorecardOf(computed, { ape: { value: 'TBD', version: 2 } }, null);
    expect(served.rows.map((r) => r.monthlyTarget)).toEqual([{ value: 'TBD', version: 2 }, { value: '', version: 0 }, null]);
    expect(served.frozenAt).toBeNull();
    expect(scorecardOf(computed, undefined, new Date('2026-10-01T03:00:00Z')).frozenAt).toBe('2026-10-01T03:00:00.000Z');
    expect(scorecardOf(computed, null, null).rows[0].monthlyTarget).toEqual({ value: '', version: 0 });
  });

  describe('ADR-0130 §3 the agenda a new meeting starts from', () => {
    it('P18.1-T2 AC-5 "Prepare {month} performance data" names the month before the meeting’s, in English, across a year', () => {
      expect(monthBefore('2026-10-13')).toBe('September');
      expect(monthBefore('2026-01-05')).toBe('December');
      expect(monthBefore('2026-12-31')).toBe('November');
      expect(firstAgendaTexts('2027-01-04').preparation[1]).toBe('Prepare December performance data');
    });

    it('P18.1-T2 AC-5 the first is the prototype’s ten; a later one copies text and PIC, unticked, every item new', () => {
      let n = 0;
      const ids = () => `id-${(n += 1)}`;
      const first = startingAgenda('2026-10-13', null, ids);
      expect([first.preparation.length, first.during.length, first.post.length]).toEqual([3, 5, 2]);
      expect(first.post[1]).toEqual({ itemId: 'id-10', text: 'Note feedback for RBDO/BDO', pic: '', done: false, version: 1 });
      const ticked = { ...first, during: first.during.map((i) => ({ ...i, done: true, pic: 'Wilson', version: 7 })) };
      const copy = startingAgenda('2026-10-27', ticked, ids);
      expect(copy.during[0]).toEqual({ itemId: 'id-14', text: first.during[0].text, pic: 'Wilson', done: false, version: 1 });
      expect(copy.preparation[1].text).toBe('Prepare September performance data');
      // A previous meeting stored before a section existed copies it empty.
      expect(startingAgenda('2026-10-27', { preparation: [] } as never, ids)).toEqual({ preparation: [], during: [], post: [] });
    });
  });
});
