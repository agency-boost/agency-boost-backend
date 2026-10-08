import { nextFollowUp } from './follow-up';

/** Whole days between two office dates, as `Clock.daysBetween` answers in the office's zone. */
const between = (from: string, to: string) => Math.round((Date.parse(to) - Date.parse(from)) / 86_400_000);
const TODAY = '2026-10-02';

/** OD-140 (ADR-0124): the roster's *Flagged follow-up (system-detected)*, as a rule. */
describe('the next open action item (OD-140)', () => {
  it('P15-T2 AC-5 takes the earliest due date first, undated after', () => {
    expect(nextFollowUp([
      { text: 'Undated', dueDate: null },
      { text: 'Later', dueDate: '2026-10-09' },
      { text: 'Sooner', dueDate: '2026-10-05' },
    ], TODAY, between)).toEqual({ text: 'Sooner', dueDate: '2026-10-05', overdueDays: null });
    expect(nextFollowUp([{ text: 'Undated', dueDate: null }, { text: 'Also undated', dueDate: null }], TODAY, between))
      .toEqual({ text: 'Undated', dueDate: null, overdueDays: null });
  });

  it('P15-T2 AC-5 the order given does not change the answer: a dated item beats an undated one wherever it stands', () => {
    const dated = { text: 'Dated', dueDate: '2026-10-05' };
    const undated = { text: 'Undated', dueDate: null };
    for (const items of [[dated, undated], [undated, dated], [undated, undated, dated], [dated, undated, undated]]) {
      expect(nextFollowUp(items, TODAY, between)?.text).toBe('Dated');
    }
  });

  it('P15-T2 AC-5 a tie keeps the order given: typed items before lead actions', () => {
    expect(nextFollowUp([
      { text: 'Typed', dueDate: '2026-10-05' },
      { text: 'Call Pak Hendro', dueDate: '2026-10-05' },
    ], TODAY, between)?.text).toBe('Typed');
    expect(nextFollowUp([
      { text: 'Typed', dueDate: null },
      { text: 'Call Pak Hendro', dueDate: '2026-10-05' },
    ], TODAY, between)?.text).toBe('Call Pak Hendro');
  });

  it('P15-T2 AC-5 is overdue by whole office days when its date is before today; due today is not overdue', () => {
    expect(nextFollowUp([{ text: 'Late', dueDate: '2026-09-20' }], TODAY, between))
      .toEqual({ text: 'Late', dueDate: '2026-09-20', overdueDays: 12 });
    expect(nextFollowUp([{ text: 'Today', dueDate: TODAY }], TODAY, between)?.overdueDays).toBeNull();
  });

  it('P15-T2 AC-5 skips a blank item, keeps the text as stored, and answers nothing for none with text', () => {
    expect(nextFollowUp([{ text: '   ', dueDate: '2026-09-01' }, { text: 'Real ', dueDate: '2026-10-03' }], TODAY, between))
      .toEqual({ text: 'Real ', dueDate: '2026-10-03', overdueDays: null });
    expect(nextFollowUp([{ text: '', dueDate: null }], TODAY, between)).toBeNull();
    expect(nextFollowUp([], TODAY, between)).toBeNull();
  });
});
