import { normalisePhone, PHONE_COUNTRY_PREFIX, PHONE_NATIONAL_DIGITS } from './index';

/**
 * **A person's WhatsApp number** (UI V1, 2026-10-30; UI-081, D-22), pinned so a change to the rule fails here before it
 * reaches *Isi nomor WhatsApp*. Documented once in `docs/00-product/metrics-and-definitions.md`.
 */
describe('UI-081 / D-22 the phone number rule', () => {
  it('keeps 9 to 13 national digits after +62', () => {
    expect(PHONE_NATIONAL_DIGITS).toEqual({ min: 9, max: 13 });
    expect(PHONE_COUNTRY_PREFIX).toBe('+62');
  });

  it('reads the ways a number is typed as one number', () => {
    for (const typed of [
      '0812-1100-2200', '+62 812 1100 2200', '812 1100 2200', '6281211002200', '0062 812 1100 2200',
      '+62 0812 1100 2200', '(0812) 1100.2200', ' 0812 1100 2200 ',
    ]) {
      expect(normalisePhone(typed)).toBe('+6281211002200');
    }
  });

  it('takes the shortest and the longest number, and nothing beyond either', () => {
    expect(normalisePhone('812345678')).toBe('+62812345678');
    expect(normalisePhone('8'.repeat(13))).toBe(`+62${'8'.repeat(13)}`);
    expect(normalisePhone('12345678')).toBeNull();
    expect(normalisePhone('8'.repeat(14))).toBeNull();
  });

  it('refuses letters, other signs, an empty field and anything that is not text', () => {
    for (const typed of ['0812-ABCD-2200', '0812/1100/2200', '+1 202 555 0100 x', '', '   ', '+62']) {
      expect(normalisePhone(typed)).toBeNull();
    }
    expect(normalisePhone(null)).toBeNull();
    expect(normalisePhone(undefined)).toBeNull();
  });
});
