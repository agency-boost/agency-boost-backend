import { byTaskOrder, instantTiming, type CalendarTaskView } from './calendar-auto-items';

const JAKARTA = 'Asia/Jakarta';

const task = (over: Partial<CalendarTaskView>): CalendarTaskView => ({
  taskId: 'lead:1', source: 'lead', date: '2026-09-14', ownerMembershipId: 'me', name: 'Ibu Wiwik', note: '', phone: null,
  lead: null, coaching: null, ...over,
});

/**
 * **The two pure rules of the calendar's auto items** (UI V1, 2026-10-30, UI-104; `functional/calendar.md`, *UI V1*):
 * the *Tugas* checklist's order, which the Agenda and Home's *Aksi hari ini* both draw, and a joined event's span read
 * on the office's clock. `calendar-auto-items.int.spec.ts` walks them on real rows.
 */
describe('the calendar’s auto items, pure (UI-104)', () => {
  describe('the Tugas order: by date, coaching before leads, then A to Z, then by id', () => {
    it('UI-104 an earlier day comes first, whichever side it is on', () => {
      const monday = task({ date: '2026-09-14', name: 'Zul' });
      const tuesday = task({ date: '2026-09-15', name: 'Ani' });
      expect(byTaskOrder(monday, tuesday)).toBe(-1);
      expect(byTaskOrder(tuesday, monday)).toBe(1);
    });

    it('UI-104 on one day a coaching item comes before a lead, whatever their names', () => {
      const coaching = task({ taskId: 'coaching:s:1', source: 'coaching', name: 'Sari' });
      const lead = task({ taskId: 'lead:2', source: 'lead', name: 'Ani' });
      expect(byTaskOrder(coaching, lead)).toBe(-1);
      expect(byTaskOrder(lead, coaching)).toBe(1);
    });

    it('UI-104 one day and one source: A to Z by name, and two of one name by id', () => {
      expect(byTaskOrder(task({ name: 'Ani' }), task({ name: 'Budi' }))).toBeLessThan(0);
      expect(byTaskOrder(task({ name: 'Budi' }), task({ name: 'Ani' }))).toBeGreaterThan(0);
      expect(byTaskOrder(task({ taskId: 'lead:a' }), task({ taskId: 'lead:b' }))).toBeLessThan(0);
      expect(byTaskOrder(task({ taskId: 'lead:b' }), task({ taskId: 'lead:a' }))).toBeGreaterThan(0);
    });

    it('UI-104 sorts a day’s mixed list into the checklist the Agenda draws', () => {
      const list = [
        task({ taskId: 'lead:2', date: '2026-09-15', name: 'Pak Besok' }),
        task({ taskId: 'lead:b', name: 'Ibu Ani' }),
        task({ taskId: 'coaching:s:1', source: 'coaching', name: 'Sari Dewi' }),
        task({ taskId: 'lead:a', name: 'Ibu Ani' }),
        task({ taskId: 'lead:3', name: 'Pak Zul' }),
      ];
      expect([...list].sort(byTaskOrder).map((t) => t.taskId)).toEqual(['coaching:s:1', 'lead:a', 'lead:b', 'lead:3', 'lead:2']);
      expect([...list].reverse().sort(byTaskOrder).map((t) => t.taskId)).toEqual(['coaching:s:1', 'lead:a', 'lead:b', 'lead:3', 'lead:2']);
    });
  });

  describe('a joined event’s span on the office’s clock', () => {
    it('UI-104 an event within one day is that day’s, with no dates of its own', () => {
      expect(instantTiming(new Date('2026-09-16T02:00:00Z'), new Date('2026-09-16T04:00:00Z'), JAKARTA)).toEqual({
        allDay: false, date: '2026-09-16', start: '09:00', end: '11:00', startsOn: null, endsOn: null,
      });
    });

    it('UI-104 an end at the office’s midnight belongs to the day before it: one day, ending 00:00', () => {
      // 20:00 to 24:00 on Thursday 17 September in Jakarta.
      expect(instantTiming(new Date('2026-09-17T13:00:00Z'), new Date('2026-09-17T17:00:00Z'), JAKARTA)).toEqual({
        allDay: false, date: '2026-09-17', start: '20:00', end: '00:00', startsOn: null, endsOn: null,
      });
    });

    it('UI-104 an event that runs past its first day carries its two dates, as a trip with times is answered', () => {
      // 15:00 on the 14th to 15:00 on the 16th, Jakarta; and one that ends at midnight two days on.
      expect(instantTiming(new Date('2026-09-14T08:00:00Z'), new Date('2026-09-16T08:00:00Z'), JAKARTA)).toEqual({
        allDay: false, date: '2026-09-14', start: '15:00', end: '15:00', startsOn: '2026-09-14', endsOn: '2026-09-16',
      });
      expect(instantTiming(new Date('2026-09-14T08:00:00Z'), new Date('2026-09-16T17:00:00Z'), JAKARTA)).toMatchObject({
        date: '2026-09-14', end: '00:00', startsOn: '2026-09-14', endsOn: '2026-09-16',
      });
    });

    it('UI-104 the office’s date, not UTC’s: an event at 06:30 in Jakarta is that day’s, though the day before in UTC', () => {
      expect(instantTiming(new Date('2026-09-14T23:30:00Z'), new Date('2026-09-15T01:00:00Z'), JAKARTA)).toMatchObject({
        date: '2026-09-15', start: '06:30', end: '08:00', startsOn: null,
      });
    });
  });
});
