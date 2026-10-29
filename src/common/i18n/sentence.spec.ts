import { formatDate } from '@/common/format/format';
import { readerIn, SOURCE_READER } from './reader';
import {
  filedUnder, inSource, isSentence, joinSentences, messages, prefixed, refusals, registeredMessages,
  registeredRefusals, render, renderDeep,
} from './sentence';

const SAY = refusals('common/i18n spec', {
  LEAD_ALREADY_CLOSED: {
    closed: { en: 'This lead is closed.', id: 'Lead ini sudah ditutup.' },
    since: ({ day }: { day: string }) => ({
      en: (figures) => `Closed on ${formatDate(day, figures)}.`,
      id: `Ditutup pada ${formatDate(day, 'id')}.`,
    }),
  },
});

const WORDS = messages('common/i18n spec words', {
  hello: ({ name }: { name: string }) => ({ en: `Hello ${name},`, id: `Halo ${name},` }),
  signOff: { en: '— AgencyBoost', id: '— AgencyBoost' },
});

/**
 * **P18.98-T5 — a sentence in both languages, written for its reader** (ADR-0179 §7): a catalogue files each by code,
 * a refusal's is written when it is answered, and a figure inside it is written in the reader's figures' language.
 */
describe('P18.98-T5 sentences', () => {
  it('AC-2 writes a sentence in its reader’s language', () => {
    expect(render(SAY.LEAD_ALREADY_CLOSED.closed, readerIn('en'))).toBe('This lead is closed.');
    expect(render(SAY.LEAD_ALREADY_CLOSED.closed, readerIn('id'))).toBe('Lead ini sudah ditutup.');
  });

  it('AC-1 writes a figure in the figures’ language: English words, Indonesian figures for a reader who chose nothing', () => {
    const sentence = SAY.LEAD_ALREADY_CLOSED.since({ day: '2026-10-26' });
    expect(render(sentence, { language: 'en', figures: 'en' })).toBe('Closed on 26 Oct 2026.');
    expect(render(sentence, { language: 'en', figures: 'id' })).toBe('Closed on 26 Okt 2026.');
    expect(render(sentence, readerIn('id'))).toBe('Ditutup pada 26 Okt 2026.');
    expect(inSource(sentence)).toBe('Closed on 26 Okt 2026.');
  });

  it('AC-2 files a refusal under its code, and any other sentence under none', () => {
    expect(filedUnder(SAY.LEAD_ALREADY_CLOSED.closed)).toBe('LEAD_ALREADY_CLOSED');
    expect(filedUnder(SAY.LEAD_ALREADY_CLOSED.since({ day: '2026-10-26' }))).toBe('LEAD_ALREADY_CLOSED');
    expect(filedUnder(WORDS.signOff)).toBeNull();
    expect(filedUnder(WORDS.hello({ name: 'Rina' }))).toBeNull();
    expect(isSentence(SAY.LEAD_ALREADY_CLOSED.closed)).toBe(true);
    // A message written inline is not a sentence out of a catalogue.
    expect(isSentence({ en: 'x', id: 'y' })).toBe(false);
    expect(isSentence(null)).toBe(false);
    expect(isSentence('closed')).toBe(false);
  });

  it('registers each catalogue, so the walk can read it', () => {
    expect(registeredRefusals().map((c) => c.name)).toContain('common/i18n spec');
    expect(registeredMessages().map((c) => c.name)).toContain('common/i18n spec words');
  });

  it('AC-3 joins sentences, each language its own parts, a figure in either written for the reader', () => {
    const both = joinSentences([SAY.LEAD_ALREADY_CLOSED.closed, SAY.LEAD_ALREADY_CLOSED.since({ day: '2026-01-05' })]);
    expect(render(both, readerIn('en'))).toBe('This lead is closed. Closed on 5 Jan 2026.');
    expect(render(both, readerIn('id'))).toBe('Lead ini sudah ditutup. Ditutup pada 5 Jan 2026.');
    expect(render(joinSentences([SAY.LEAD_ALREADY_CLOSED.closed, SAY.LEAD_ALREADY_CLOSED.closed], '; '), readerIn('en')))
      .toBe('This lead is closed.; This lead is closed.');
    expect(filedUnder(both)).toBe('LEAD_ALREADY_CLOSED');
    expect(render(joinSentences([]), readerIn('id'))).toBe('');
    expect(filedUnder(joinSentences([]))).toBeNull();
  });

  it('AC-3 puts a few characters that are no language’s before a sentence', () => {
    const coded = prefixed('REFERRAL_RATE: ', SAY.LEAD_ALREADY_CLOSED.closed);
    expect(render(coded, readerIn('en'))).toBe('REFERRAL_RATE: This lead is closed.');
    expect(render(coded, readerIn('id'))).toBe('REFERRAL_RATE: Lead ini sudah ditutup.');
    expect(filedUnder(coded)).toBe('LEAD_ALREADY_CLOSED');
  });

  describe('AC-3 every sentence inside a value', () => {
    it('writes each for the reader, in arrays and plain objects, and leaves everything else as it is', () => {
      const day = new Date('2026-10-26T00:00:00Z');
      const details = {
        violations: [SAY.LEAD_ALREADY_CLOSED.closed, 'as typed'],
        nested: { why: SAY.LEAD_ALREADY_CLOSED.since({ day: '2026-10-26' }), count: 3, day },
      };
      expect(renderDeep(details, readerIn('id'))).toEqual({
        violations: ['Lead ini sudah ditutup.', 'as typed'],
        nested: { why: 'Ditutup pada 26 Okt 2026.', count: 3, day },
      });
      expect(renderDeep(details, SOURCE_READER)).toEqual({
        violations: ['This lead is closed.', 'as typed'],
        nested: { why: 'Closed on 26 Okt 2026.', count: 3, day },
      });
    });

    it('answers a value with no sentence in it as the same object', () => {
      const details = { code: 'X', list: [1, 'two'], inner: { a: null } };
      expect(renderDeep(details, readerIn('id'))).toBe(details);
      expect(renderDeep(details.list, readerIn('id'))).toBe(details.list);
      expect(renderDeep(undefined, readerIn('id'))).toBeUndefined();
      expect(renderDeep(7, readerIn('id'))).toBe(7);
    });
  });

  it('freezes what it files, so nothing changes a sentence after it is written', () => {
    expect(Object.isFrozen(SAY)).toBe(true);
    expect(Object.isFrozen(SAY.LEAD_ALREADY_CLOSED)).toBe(true);
    expect(Object.isFrozen(SAY.LEAD_ALREADY_CLOSED.closed)).toBe(true);
    expect(Object.isFrozen(WORDS.signOff)).toBe(true);
  });
});
