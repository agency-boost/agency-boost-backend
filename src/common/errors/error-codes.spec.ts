import { globSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { readerIn, SOURCE_READER } from '@/common/i18n/reader';
import { registeredMessages, registeredRefusals, render, type Message } from '@/common/i18n/sentence';
import { ErrorCode, type ErrorCodeValue } from './error-codes';

/**
 * **Outside a reader's scope is 404, `NOT_FOUND`, never a refusal that names the reason** (P11-T3
 * AC-3, `conventions.md` *Errors*). A 403 confirms that the person exists; a code that says *you do
 * not coach them* or *these notes are private* tells a subject that notes about them exist.
 */
describe('ErrorCode (P11-T3 AC-3)', () => {
  it('P11-T3 AC-3: holds neither COACHING_NOT_COACH_OF nor COACHING_NOTES_PRIVATE (ADR-0073, ADR-0074)', () => {
    expect(Object.keys(ErrorCode)).not.toContain('COACHING_NOT_COACH_OF');
    expect(Object.keys(ErrorCode)).not.toContain('COACHING_NOTES_PRIVATE');
    expect(ErrorCode.NOT_FOUND).toBe('NOT_FOUND');
  });

  it('P11-T3 AC-3: nothing raises PERM_OUT_OF_SCOPE — a subject outside the grant is answered 404', () => {
    // The activity reads raised it for an Agent naming somebody else until P11-T3. The code stays
    // in the enum while the error catalog still lists it; no service may answer with it.
    const src = join(__dirname, '../..');
    const raisers = globSync('**/*.ts', { cwd: src })
      .filter((file) => !file.includes('.spec.') && file !== 'common/errors/error-codes.ts')
      .filter((file) => readFileSync(join(src, file), 'utf8').includes('PERM_OUT_OF_SCOPE'));
    expect(raisers).toEqual([]);
  });
});

/**
 * **P18.98-T5 AC-2, AC-7 — every code says its refusal in both languages** (ADR-0179 §7). Every catalogue the API has
 * (`*.messages.ts`, found by reading the tree, so a new one needs no registering) is loaded; then every `ErrorCode`
 * must be filed in one, in English and Indonesian, or be one nothing raises. `tsc` already refuses a throw site whose
 * sentence is filed under another code, or that writes its words inline; this is the other half — a code with no
 * sentence at all.
 */
describe('P18.98-T5 every code’s refusal, in both languages', () => {
  const src = join(__dirname, '../..');
  const catalogueFiles = globSync('**/*.messages.ts', { cwd: src });

  beforeAll(() => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports -- each catalogue registers itself when loaded
    for (const file of catalogueFiles) require(join(src, file));
  });

  /**
   * **The codes nothing raises**, each with its reason: there is no sentence to write. Checked below to be raised by
   * nothing, so the list cannot hide one that is.
   */
  const NOT_RAISED: Readonly<Partial<Record<ErrorCodeValue, string>>> = {
    CONFIG_RATIO_FORMULA_FIXED: 'Retired by ADR-0024, kept and never reused: a client may still branch on it.',
    ORG_INVITE_EXHAUSTED: 'Catalogued for an invite with a use limit; every invite is single-use, answered ORG_INVITE_EXPIRED.',
    PERM_OUT_OF_SCOPE: 'P11-T3 AC-3: a subject outside the grant is answered NOT_FOUND, never this.',
    RATE_LIMITED: 'The generic limit: the API limits only signing in and registering, under AUTH_RATE_LIMITED.',
    VALIDATION_UNKNOWN_FIELD: 'An unknown field is refused VALIDATION_FAILED by the pipe (`forbidNonWhitelisted`).',
  };

  /** Sentences the same in both languages on purpose: the product's name, a tag around somebody's words, a kept term. */
  const SAME_IN_BOTH = new Set([
    'modules/notifications: emails:signOff',
    'modules/notifications: emails:subject',
    // *TBD*, the forum's own placeholder, kept English in both (the glossary's §A.4).
    'modules/leader-meetings:tbd',
    // *FAQ*, the recruitment pitch's third slot: the loanword Indonesian already uses (the glossary's §B.0 rule 5).
    'modules/recruitment:faqTitle',
  ]);

  /**
   * A value for every name an entry asks for, so a function entry can be written out and read: a text in a template
   * (`{name}`), and a sentence where an entry wraps one (`{name}` in English, `{name:id}` in Indonesian).
   */
  const placeholder = (key: string) => ({
    en: `{${key}}`, id: `{${key}:id}`, toString: () => `{${key}}`, [Symbol.toPrimitive]: () => `{${key}}`,
  });
  const placeholders = new Proxy({}, { get: (_target, key) => (typeof key === 'string' ? placeholder(key) : undefined) });

  type Entry = Message | ((values: unknown) => Message);
  /** An entry's two languages, written out — or `null` where its values cannot be stood in for (typed by `tsc`). */
  const written = (entry: Entry): { en: string; id: string; source: string } | null => {
    try {
      const message = typeof entry === 'function' ? entry(placeholders) : entry;
      // A text an entry passes through whole (Nest's own English) is a placeholder: read as the text it stands for.
      return {
        en: String(render(message, readerIn('en'))),
        id: String(render(message, readerIn('id'))),
        source: String(render(message, SOURCE_READER)),
      };
    } catch {
      return null;
    }
  };

  const filed = () => {
    const codes = new Map<string, string[]>();
    for (const { name, entries } of registeredRefusals()) {
      for (const [code, section] of Object.entries(entries)) {
        for (const key of Object.keys(section ?? {})) codes.set(code, [...(codes.get(code) ?? []), `${name}:${key}`]);
      }
    }
    return codes;
  };

  it('loads every catalogue the API has', () => {
    expect(catalogueFiles.length).toBeGreaterThan(10);
    expect(registeredRefusals().length).toBeGreaterThan(10);
  });

  it('AC-2 files a sentence for every code there is, or names it raised by nothing', () => {
    const codes = filed();
    const missing = Object.values(ErrorCode).filter((code) => !codes.has(code) && !(code in NOT_RAISED));
    expect(missing).toEqual([]);
  });

  it('AC-2 files sentences only under codes ErrorCode has', () => {
    const known = new Set<string>(Object.values(ErrorCode));
    expect([...filed().keys()].filter((code) => !known.has(code))).toEqual([]);
  });

  it('AC-2 a code named raised by nothing is raised by nothing', () => {
    const raised = globSync('**/*.ts', { cwd: src })
      .filter((file) => !file.includes('.spec.') && file !== 'common/errors/error-codes.ts')
      .map((file) => readFileSync(join(src, file), 'utf8'));
    const wrong = Object.keys(NOT_RAISED).filter((code) => raised.some((text) => text.includes(`ErrorCode.${code}`)));
    expect(wrong).toEqual([]);
    expect(Object.keys(NOT_RAISED).filter((code) => filed().has(code))).toEqual([]);
  });

  it('AC-2 writes every refusal in both languages, and the Indonesian is not the English', () => {
    const problems: string[] = [];
    for (const { name, entries } of registeredRefusals()) {
      for (const [code, section] of Object.entries(entries)) {
        for (const [key, entry] of Object.entries(section ?? {})) {
          const texts = written(entry as Entry);
          if (texts === null) continue;
          const at = `${name}:${code}.${key}`;
          if (!texts.en.trim() || !texts.id.trim() || !texts.source.trim()) problems.push(`${at}: a language is empty`);
          else if (texts.en === texts.id) problems.push(`${at}: the Indonesian is the English`);
        }
      }
    }
    expect(problems).toEqual([]);
  });

  it('AC-4, AC-5 writes every notice and email sentence in both languages', () => {
    const problems: string[] = [];
    for (const { name, entries } of registeredMessages()) {
      for (const [key, entry] of Object.entries(entries)) {
        const texts = written(entry as Entry);
        if (texts === null) continue;
        const at = `${name}:${key}`;
        if (!texts.en.trim() || !texts.id.trim()) problems.push(`${at}: a language is empty`);
        else if (texts.en === texts.id && !SAME_IN_BOTH.has(at)) problems.push(`${at}: the Indonesian is the English`);
      }
    }
    expect(problems).toEqual([]);
  });
});
