import { CALENDAR, CALENDAR_ALL_DAY_TYPE, CALENDAR_ENTRY_TYPES } from './index';

/**
 * **The calendar's limits, pinned** (`functional/calendar.md`, *Its fields*). The DTOs, the service and
 * the OpenAPI document read them from here; a drift fails this before it reaches a screen that
 * promises the old number.
 */
describe('calendar limits (functional/calendar.md, Its fields)', () => {
  it('P12-T2 AC-5 pins the title at 120 characters and the notes at 1,000', () => {
    expect(CALENDAR.TITLE_MAX).toBe(120);
    expect(CALENDAR.NOTES_MAX).toBe(1000);
  });

  it('P12-T2 AC-5 pins a trip at 31 days, inclusive — the longest an entry lasts, which a range read reaches back by', () => {
    expect(CALENDAR.TRAVEL_DAYS_MAX).toBe(31);
  });

  it('P12-T4 AC-1 pins at most 50 invitees, and the picker at 50 a page and 100 characters of search', () => {
    expect(CALENDAR.INVITEES_MAX).toBe(50);
    expect(CALENDAR.PEOPLE_PAGE_MAX).toBe(50);
    expect(CALENDAR.PEOPLE_QUERY_MAX).toBe(100);
  });

  it('pins an id a request names at 64 characters, as every subject parameter is', () => {
    expect(CALENDAR.ID_MAX).toBe(64);
  });

  it('P12-T1 AC-4 pins the five types by code in the legend’s order, Travel the one all-day type', () => {
    expect(CALENDAR_ENTRY_TYPES).toEqual(['meeting', 'coaching', 'client', 'task', 'travel']);
    expect(CALENDAR_ALL_DAY_TYPE).toBe('travel');
  });
});
