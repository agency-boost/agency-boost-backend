/**
 * **The calendar's limits** (`functional/calendar.md`, *Its fields* and the Data contract), held once
 * here and read by the DTOs, the service and the OpenAPI document (ADR-0030, invariant §7).
 *
 * None of them is an office setting: they bound what one entry can hold and what one read can answer,
 * and an office that changed them would change what every reader's screen has to draw.
 */
export const CALENDAR = {
  /** *Title*: optional, at most this many characters, trimmed. */
  TITLE_MAX: 120,
  /** *Notes / location*: optional, at most this many characters. */
  NOTES_MAX: 1000,
  /** Members invited to one entry, beside the member a block was placed on. */
  INVITEES_MAX: 50,
  /**
   * **The longest an entry lasts, in office days**: a trip from *Departure date* to *Return date*,
   * inclusive. A timed entry ends by midnight of its own date, so a trip is the longest kind — and a
   * range read reaches back this far for the entries that began before the period and still overlap it.
   */
  TRAVEL_DAYS_MAX: 31,
  /** The people picker's search text, at most. */
  PEOPLE_QUERY_MAX: 100,
  /** The people picker's page, at most and by default. */
  PEOPLE_PAGE_MAX: 50,
  /** Any id a request names: an entry, a member, an invitee. */
  ID_MAX: 64,
} as const;

/**
 * **The five entry types, by code, in the legend's order** (`Calendar_Section.html:310-314`). The code
 * is the identity and the order is display (invariant §4).
 */
export const CALENDAR_ENTRY_TYPES = ['meeting', 'coaching', 'client', 'task', 'travel'] as const;
export type CalendarEntryType = (typeof CALENDAR_ENTRY_TYPES)[number];

/** The one type with two office dates rather than a date and two times. */
export const CALENDAR_ALL_DAY_TYPE: CalendarEntryType = 'travel';
