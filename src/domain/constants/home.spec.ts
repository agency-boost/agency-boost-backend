import { PERIOD } from './index';
import { HOME, HOME_QUOTE_POSES, HOME_QUOTES, homeDayNumber, quoteOfTheDay } from './home';

/** Pins `docs/00-product/metrics-and-definitions.md` §B.29 (Home) — a drift here fails, as invariant §7 asks. */
describe('Home’s constants and the quote of the day (UI-100)', () => {
  it('UI-100 holds the owner’s 20 quotes in his order, each with its person and no dash', () => {
    expect(HOME_QUOTES).toHaveLength(20);
    expect(HOME_QUOTES[0]).toEqual({ text: 'Well done is better than well said.', person: 'Benjamin Franklin' });
    expect(HOME_QUOTES[2].person).toBe('Robert Collier');
    expect(HOME_QUOTES[6]).toEqual({ text: 'Gantungkan cita-citamu setinggi langit.', person: 'Soekarno' });
    expect(HOME_QUOTES[17]).toEqual({ text: 'Habis gelap terbitlah terang.', person: 'R.A. Kartini' });
    expect(HOME_QUOTES[19].person).toBe('Muhammad Ali');
    for (const quote of HOME_QUOTES) {
      expect(quote.person).not.toMatch(/^[–—-]/);
      expect(quote.text.trim()).toBe(quote.text);
    }
  });

  it('UI-100 rotates Boost through the four poses in the owner’s order', () => {
    expect(HOME_QUOTE_POSES).toEqual(['thinking', 'celebrating', 'pointing', 'phone']);
  });

  it('UI-100 shows three actions at most, and reads the 7-day windows from ROLLING_7D', () => {
    expect(HOME.ACTIONS_SHOWN).toBe(3);
    expect(HOME.CHART_DAYS).toBe(PERIOD.ROLLING_7D_DAYS);
    expect(HOME.COACHED_WINDOW_DAYS).toBe(PERIOD.ROLLING_7D_DAYS);
  });

  it('UI-100 numbers the office’s day from 1 January 1970', () => {
    expect(homeDayNumber('1970-01-01')).toBe(0);
    expect(homeDayNumber('2026-10-30')).toBe(20756);
    expect(homeDayNumber('2026-10-31')).toBe(20757);
    // Across a month, a year and a leap day.
    expect(homeDayNumber('2027-01-01') - homeDayNumber('2026-12-31')).toBe(1);
    expect(homeDayNumber('2028-03-01') - homeDayNumber('2028-02-28')).toBe(2);
  });

  it('UI-100 quote = day number mod 20, pose = day number mod 4', () => {
    // 20756 mod 20 = 16 (#17, Peter Drucker); 20756 mod 4 = 0 (thinking).
    expect(quoteOfTheDay('2026-10-30')).toEqual({
      index: 16, person: 'Peter Drucker', pose: 'thinking',
      text: 'Plans are only good intentions unless they immediately degenerate into hard work.',
    });
    expect(quoteOfTheDay('2026-10-31')).toMatchObject({ index: 17, person: 'R.A. Kartini', pose: 'celebrating' });
    expect(quoteOfTheDay('2026-11-01')).toMatchObject({ index: 18, pose: 'pointing' });
    expect(quoteOfTheDay('2026-11-02')).toMatchObject({ index: 19, pose: 'phone' });
    // The list wraps after twenty days, the poses after four.
    expect(quoteOfTheDay('2026-11-03')).toMatchObject({ index: 0, pose: 'thinking' });
  });

  it('UI-100 every day of a cycle names a different quote, and every pose comes round', () => {
    const days = Array.from({ length: 20 }, (_, i) => quoteOfTheDay(`2026-12-${String(i + 1).padStart(2, '0')}`));
    expect(new Set(days.map((d) => d.index)).size).toBe(20);
    expect(new Set(days.map((d) => d.pose))).toEqual(new Set(HOME_QUOTE_POSES));
  });
});
