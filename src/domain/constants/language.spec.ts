import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  DEFAULT_LANGUAGE, LANGUAGES, LANGUAGE_LIVE, LANGUAGE_UNCHOSEN, SOURCE_LANGUAGE, isLanguage, languageOf,
  unchosenLanguage,
} from './index';

/**
 * **Two languages, Indonesian by default** (ADR-0179 §1, P18.10-T1 AC-1): pinned so a change to either fails here
 * before it changes what anybody reads. Documented once in `docs/00-product/metrics-and-definitions.md` §B.27; the
 * frontend's copy is read against this module by its `contract.spec.ts`.
 */
describe('P18.10-T1 the languages (ADR-0179 §1)', () => {
  it('AC-1 speaks two languages, Bahasa Indonesia and English, by their ISO 639-1 codes', () => {
    expect([...LANGUAGES]).toEqual(['id', 'en']);
  });

  it('AC-1 gives a person who has chosen neither Bahasa Indonesia', () => {
    expect(DEFAULT_LANGUAGE).toBe('id');
    expect(LANGUAGES).toContain(DEFAULT_LANGUAGE);
  });

  it('reads a language only from one of the two codes', () => {
    expect(isLanguage('id')).toBe(true);
    expect(isLanguage('en')).toBe(true);
    for (const other of ['fr', 'ID', 'id-ID', 'en-US', '', null, undefined, 1]) expect(isLanguage(other)).toBe(false);
  });
});

/**
 * **P18.10-T2 AC-1: the stored choice, read** (ADR-0179 §2). `users.locale` is `'id'`, `'en'` or `null`; nothing ever
 * wrote it before the switch (ADR-0016), so every existing account holds `null`, and **there is no migration**: a `null`
 * reads as Indonesian here, wherever the API reads a person's language.
 */
describe('P18.10-T2 a stored language, read', () => {
  it('AC-1 reads a person who has chosen nothing — null, every account made before the switch — as Bahasa Indonesia', () => {
    expect(languageOf(null)).toBe('id');
    expect(languageOf(undefined)).toBe('id');
    expect(languageOf(null)).toBe(DEFAULT_LANGUAGE);
  });

  it('AC-1 reads a choice as itself', () => {
    expect(languageOf('id')).toBe('id');
    expect(languageOf('en')).toBe('en');
  });

  it('AC-1 never hands on a value that is not one of the two: it reads the default', () => {
    for (const other of ['fr', 'EN', 'id-ID', '', 1]) expect(languageOf(other)).toBe(DEFAULT_LANGUAGE);
  });
});

/**
 * **P18.10-T5 AC-1 — the live rule, and the same switch as the frontend's** (ADR-0179's dated note of 2026-10-29). The
 * Indonesian default went live for the API and the screens together, at P18.10-T4's exit (2026-10-29): a reader who has
 * chosen nothing reads Bahasa Indonesia, from both halves. Before it a reader who had chosen nothing read English, so
 * nothing turned Indonesian before the screens did; `unchosenLanguage(false)` still says so.
 */
describe('P18.10-T5 the Indonesian default, live with the screens', () => {
  it('AC-1 is live: one constant, true since P18.10-T4’s exit', () => {
    expect(LANGUAGE_LIVE).toBe(true);
  });

  it('AC-1 a reader who has chosen nothing reads Bahasa Indonesia, as it is live; English only while it was not', () => {
    expect(unchosenLanguage(false)).toBe('en');
    expect(unchosenLanguage(true)).toBe(DEFAULT_LANGUAGE);
    expect(LANGUAGE_UNCHOSEN).toBe(unchosenLanguage(LANGUAGE_LIVE));
    expect(LANGUAGE_UNCHOSEN).toBe('id');
  });

  it('writes every sentence in English first: the source of each catalogue', () => {
    expect(SOURCE_LANGUAGE).toBe('en');
  });

  /*
   * **Read from the frontend's own module**, at `../frontend` where the superproject has it, as the frontend's
   * `contract.spec.ts` reads `../backend`: the two constants cannot drift, so the switch flips for both or neither.
   * The backend's own CI puts only the superproject's `docs/` and `prototype/` beside this checkout
   * (`.github/ci/superproject-beside.sh`), so there — and only there — the frontend's half is not read here.
   */
  const FRONTEND = join(__dirname, '..', '..', '..', '..', 'frontend', 'src', 'i18n', 'language.ts');
  const besideFrontend = existsSync(FRONTEND) || process.env.GITHUB_ACTIONS !== 'true' ? describe : describe.skip;

  besideFrontend('agrees with the frontend’s (frontend/src/i18n/language.ts)', () => {
    const frontend = () => readFileSync(FRONTEND, 'utf8');

    it('AC-1 LANGUAGE_LIVE is the frontend’s: both live, or neither', () => {
      const declared = /export const LANGUAGE_LIVE: boolean = (true|false);/.exec(frontend());
      expect(declared?.[1]).toBe(String(LANGUAGE_LIVE));
    });

    it('AC-1 a reader who has chosen nothing reads the same language from both halves', () => {
      expect(/export const SOURCE_LANGUAGE: Language = '([^']+)';/.exec(frontend())?.[1]).toBe(SOURCE_LANGUAGE);
      expect(frontend()).toMatch(/export function unchosenLanguage\(live: boolean\): Language \{\s*return live \? DEFAULT_LANGUAGE : SOURCE_LANGUAGE;\s*\}/);
    });
  });
});
