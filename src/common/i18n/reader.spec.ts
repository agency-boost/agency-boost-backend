import {
  headerLanguage, readerIn, readerOf, readerOfRequest, recipientReader, SOURCE_READER,
} from './reader';

/**
 * **P18.98-T5 AC-1 — the request's language** (ADR-0179 §7): the `Accept-Language` the app sends, else the signed-in
 * person's `users.locale`, else a reader who has chosen nothing — Bahasa Indonesia, since the default went live
 * (`LANGUAGE_LIVE`, P18.98-T4's exit); English while it was not, which `live: false` still reads. **A figure's language** is the chosen language, else Indonesian; once
 * live, the request's.
 */
describe('P18.98-T5 AC-1 the request’s language', () => {
  describe('the order: the header, then the saved choice, then nobody’s', () => {
    it.each([true, false])('AC-1 reads the header first, whatever is saved (live %s)', (live) => {
      expect(readerOf({ header: 'id', stored: 'en', live }).language).toBe('id');
      expect(readerOf({ header: 'en', stored: 'id', live }).language).toBe('en');
      expect(readerOf({ header: 'id', live }).language).toBe('id');
    });

    it.each([true, false])('AC-1 reads the saved choice where no header names one (live %s)', (live) => {
      expect(readerOf({ header: null, stored: 'id', live }).language).toBe('id');
      expect(readerOf({ stored: 'en', live }).language).toBe('en');
    });

    it('AC-1 a reader who has chosen nothing read English while the default was not live (live false)', () => {
      expect(readerOf({ live: false })).toEqual({ language: 'en', figures: 'id' });
      expect(readerOf({ header: null, stored: null, live: false }).language).toBe('en');
    });

    it('AC-1 and Bahasa Indonesia once it is', () => {
      expect(readerOf({ live: true })).toEqual({ language: 'id', figures: 'id' });
    });

    it('AC-1 reads LANGUAGE_LIVE when nobody says: today, live — Bahasa Indonesia, words and figures', () => {
      expect(readerOf()).toEqual({ language: 'id', figures: 'id' });
    });
  });

  describe('the figures’ language', () => {
    it('AC-1 not live, a reader with nothing saved read figures in Indonesian — as the product wrote them', () => {
      // The app's own `en` for a reader with no choice cannot be told from a choice, so it reads as the screens do.
      expect(readerOf({ header: 'en', live: false })).toEqual({ language: 'en', figures: 'id' });
      expect(readerOf({ header: 'id', live: false })).toEqual({ language: 'id', figures: 'id' });
    });

    it('AC-1 not live, a saved choice was the figures’ language too: it is a choice', () => {
      expect(readerOf({ stored: 'en', live: false })).toEqual({ language: 'en', figures: 'en' });
      expect(readerOf({ header: 'en', stored: 'en', live: false })).toEqual({ language: 'en', figures: 'en' });
      expect(readerOf({ header: 'id', stored: 'en', live: false })).toEqual({ language: 'id', figures: 'id' });
    });

    it('AC-1 once live, the figures are the request’s language, always', () => {
      expect(readerOf({ header: 'en', live: true })).toEqual({ language: 'en', figures: 'en' });
      expect(readerOf({ header: 'id', live: true })).toEqual({ language: 'id', figures: 'id' });
      expect(readerOf({ stored: 'en', live: true })).toEqual({ language: 'en', figures: 'en' });
    });
  });

  describe('the header', () => {
    it('AC-1 reads exactly the two the app sends, forgiving case and spaces', () => {
      expect(headerLanguage('id')).toBe('id');
      expect(headerLanguage('en')).toBe('en');
      expect(headerLanguage(' EN ')).toBe('en');
      expect(headerLanguage(['id', 'en'])).toBe('id');
    });

    it('AC-1 reads a browser’s own header as no choice, so nothing turns Indonesian before the screens do', () => {
      for (const other of ['id-ID,id;q=0.9,en;q=0.8', 'en-US,en;q=0.9', 'fr', '*', '', undefined, []]) {
        expect(headerLanguage(other as never)).toBeNull();
      }
    });
  });

  describe('an email’s reader (AC-5)', () => {
    it('AC-5 is the recipient’s saved language, words and figures', () => {
      expect(recipientReader('id', readerIn('en'), false)).toEqual({ language: 'id', figures: 'id' });
      expect(recipientReader('en', null, false)).toEqual({ language: 'en', figures: 'en' });
    });

    it('AC-5 for a recipient with none, the request that caused it, where it is the reader’s own', () => {
      expect(recipientReader(null, readerOf({ header: 'id', live: false }), false)).toEqual({ language: 'id', figures: 'id' });
    });

    it('AC-5 else nobody’s choice: Indonesian, as it is live; English only while it was not', () => {
      expect(recipientReader(null, undefined, false)).toEqual({ language: 'en', figures: 'id' });
      expect(recipientReader(null, null, true)).toEqual({ language: 'id', figures: 'id' });
      expect(recipientReader(null)).toEqual({ language: 'id', figures: 'id' });
    });
  });

  it('the API’s own English is English words with Indonesian figures, as it wrote them before the phase', () => {
    expect(SOURCE_READER).toEqual({ language: 'en', figures: 'id' });
    expect(Object.isFrozen(SOURCE_READER)).toBe(true);
    expect(readerIn('en')).toEqual({ language: 'en', figures: 'en' });
  });

  describe('the request’s reader, wherever it is asked for', () => {
    it('AC-1 is the one the guard resolved', () => {
      const reader = readerIn('id');
      expect(readerOfRequest({ reader, headers: { 'accept-language': 'en' } })).toBe(reader);
    });

    it('AC-1 is the header’s for a request no guard saw, and nobody’s without one', () => {
      expect(readerOfRequest({ headers: { 'accept-language': 'id' } })).toEqual({ language: 'id', figures: 'id' });
      expect(readerOfRequest({ headers: { 'accept-language': 'en' } })).toEqual({ language: 'en', figures: 'en' });
      expect(readerOfRequest({ headers: {} })).toEqual({ language: 'id', figures: 'id' });
      expect(readerOfRequest({})).toEqual({ language: 'id', figures: 'id' });
      expect(readerOfRequest(undefined)).toEqual({ language: 'id', figures: 'id' });
    });
  });
});
