import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import ts from 'typescript';
import { RESOURCE_NAMES, type ResourceName } from '@/common/errors/resources';
import { english, indonesian } from '../../../test/i18n';
import { finalizeSentence, type FinalizeRefusal } from './coaching-session.rules';

/**
 * **ADR-0084 rule 2: a string coaching writes itself uses none of the six words** — *office*, *KPM*,
 * *reports to*, *tagged to*, *untagged* and *unassigned* — and a refusal a coaching screen shows is one of
 * those strings. Two of the module's refusals said *office* until the review of 2026-10-02 (parity L-66):
 * `CONFIG_ARCHIVED`'s, which the Leader Notes tab's banner shows as written, and `VALIDATION_FAILED`'s for
 * a code the catalog does not hold.
 *
 * **In both languages since P18.98-T5** (ADR-0179 §7): every sentence the module writes is in its catalogue,
 * `coaching.messages.ts`, English and Indonesian side by side, and the Indonesian names none of the six either —
 * nor their Indonesian, *KPM* (the glossary's word for the office, §B.9), *kantor*, *melapor ke*, *di-tag ke* and
 * *tanpa tim*.
 *
 * **Read off the source**, as `raw-writes.tenancy.spec.ts` reads writes: every `en` and `id` of the catalogue —
 * a function's template keeps its literal parts, and every literal inside it is read too — and, everywhere else,
 * what each message argument is: the message of each `new DomainException(code, message, …)`, the resource each
 * `new …Exception(name)` names (*`{name}` not found.*, *`{name}` tidak ditemukan.*), each `invalid(message, …)` and
 * each validator's `message:`. One that names a catalogue sentence is read in the catalogue; a constant is followed
 * to its value. **A message the scan cannot read fails it** unless it is listed below with the reason, so a new way
 * of writing one cannot pass unread.
 *
 * The shared exceptions the module throws but does not word — `NoMembershipException`,
 * `VersionConflictException` — are the rest of the product's, which rule 4 leaves as they are.
 */

/** The six, as words and phrases in any case: *offices* and *KPMs* included, `kpmId` not. */
const SIX_WORDS = /\b(offices?|kpms?|reports? to|tagged to|untagged|unassigned)\b/i;
/** The six in Indonesian (glossary §B.9): *KPM* and *kantor* for the office, *melapor ke*, *di-tag ke*, *tanpa tim*. */
const SIX_WORDS_ID = /\b(kpms?|kantor|melapor (ke|kepada)|di-tag ke|tanpa tim|belum di-tag)\b/i;

const DIR = __dirname;
const FILES = readdirSync(DIR).filter((name) => name.endsWith('.ts') && !name.endsWith('.spec.ts')).sort();
/** The module's catalogue, and the names its sentences are reached by. */
const CATALOGUE = 'coaching.messages.ts';
const CATALOGUES = new Set(['COACHING_REFUSALS', 'COACHING_MESSAGES']);

/** Messages the scan cannot read by design, each read another way. */
const READ_ELSEWHERE: Record<string, string> = {
  'coaching-session.service.ts: message':
    '`invalid(message, details)` passes its argument through; every call of `invalid` is read instead.',
  'coaching-session.service.ts: finalizeSentence(refusal)':
    'finalize’s five sentences, which the test below writes for every rule.',
};

interface Message {
  where: string;
  language: 'en' | 'id';
  text: string;
}

function messagesOf(file: string): { read: Message[]; unread: string[]; catalogued: number } {
  const source = ts.createSourceFile(file, readFileSync(join(DIR, file), 'utf8'), ts.ScriptTarget.Latest, true);
  const constants = new Map<string, ts.Expression>();
  const read: Message[] = [];
  const unread: string[] = [];
  let catalogued = 0;

  const collect = (node: ts.Node): void => {
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer) {
      constants.set(node.name.text, node.initializer);
    }
    ts.forEachChild(node, collect);
  };
  collect(source);

  const textOf = (node: ts.Expression): string | null => {
    if (ts.isStringLiteralLike(node)) return node.text;
    if (ts.isTemplateExpression(node)) {
      return node.head.text + node.templateSpans.map((span) => `{…}${span.literal.text}`).join('');
    }
    if (ts.isParenthesizedExpression(node)) return textOf(node.expression);
    // A catalogue's figure-taking text: `(figures) => \`…\``.
    if (ts.isArrowFunction(node) && !ts.isBlock(node.body)) return textOf(node.body);
    if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.PlusToken) {
      const left = textOf(node.left);
      const right = textOf(node.right);
      return left === null || right === null ? null : left + right;
    }
    if (ts.isIdentifier(node) && constants.has(node.text)) return textOf(constants.get(node.text)!);
    return null;
  };

  /** Every literal inside a text — a conditional's two words inside a template included. */
  const literalsIn = (node: ts.Node, out: string[] = []): string[] => {
    if (ts.isStringLiteralLike(node)) out.push(node.text);
    ts.forEachChild(node, (child) => { literalsIn(child, out); });
    return out;
  };

  /** A sentence out of the catalogue: `COACHING_REFUSALS.X.y`, called with its values, or a DTO's `field(…)` of one. */
  const isCatalogue = (node: ts.Expression): boolean => {
    if (ts.isParenthesizedExpression(node)) return isCatalogue(node.expression);
    if (ts.isCallExpression(node)) {
      if (ts.isIdentifier(node.expression) && node.expression.text === 'field') {
        return node.arguments.length === 1 && isCatalogue(node.arguments[0]);
      }
      return isCatalogue(node.expression);
    }
    if (ts.isPropertyAccessExpression(node)) return isCatalogue(node.expression);
    if (ts.isConditionalExpression(node)) return isCatalogue(node.whenTrue) && isCatalogue(node.whenFalse);
    if (ts.isIdentifier(node)) {
      return CATALOGUES.has(node.text) || (constants.has(node.text) && isCatalogue(constants.get(node.text)!));
    }
    return false;
  };

  const lineOf = (node: ts.Node) => source.getLineAndCharacterOfPosition(node.getStart()).line + 1;

  const take = (node: ts.Expression | undefined): void => {
    if (!node) return;
    if (isCatalogue(node)) {
      catalogued += 1;
      return;
    }
    const text = textOf(node);
    if (text === null) unread.push(`${file}: ${node.getText()}`);
    else read.push({ where: `${file}:${lineOf(node)}`, language: 'en', text });
  };

  /** `NotFoundException(resource)` writes *{resource} not found.* and *{its Indonesian} tidak ditemukan.* */
  const takeResource = (node: ts.Expression | undefined): void => {
    if (!node) return;
    const name = textOf(node);
    if (name === null) {
      unread.push(`${file}: ${node.getText()}`);
      return;
    }
    const where = `${file}:${lineOf(node)}`;
    read.push({ where, language: 'en', text: `${name} not found.` });
    read.push({ where, language: 'id', text: `${RESOURCE_NAMES[name as ResourceName] ?? name} tidak ditemukan.` });
  };

  const visit = (node: ts.Node): void => {
    if (file === CATALOGUE) {
      if (ts.isPropertyAssignment(node) && ts.isIdentifier(node.name) && ['en', 'id'].includes(node.name.text)) {
        const language = node.name.text as Message['language'];
        const text = textOf(node.initializer);
        const where = `${file}:${lineOf(node)}`;
        if (text === null) unread.push(`${file}: ${node.initializer.getText()}`);
        else read.push({ where, language, text });
        for (const literal of literalsIn(node.initializer)) read.push({ where, language, text: literal });
        return;
      }
    } else {
      if (ts.isNewExpression(node) && ts.isIdentifier(node.expression) && node.expression.text.endsWith('Exception')) {
        if (node.expression.text === 'DomainException') take(node.arguments?.[1]);
        // `NotFoundException(resource)` writes its own; the others word theirs.
        else if (node.expression.text === 'NotFoundException') takeResource(node.arguments?.[0]);
      }
      if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === 'invalid') {
        take(node.arguments[0]);
      }
      if (ts.isPropertyAssignment(node) && ts.isIdentifier(node.name) && node.name.text === 'message') {
        take(node.initializer);
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return { read, unread, catalogued };
}

const writesASixWord = (m: Message) => SIX_WORDS.test(m.text) || (m.language === 'id' && SIX_WORDS_ID.test(m.text));

describe('ADR-0084 rule 2: coaching’s own error messages use none of the six words', () => {
  const scanned = FILES.map(messagesOf);
  const messages = scanned.flatMap((s) => s.read);

  it('ADR-0084 reads every message the coaching module writes, and leaves none unread but those read elsewhere', () => {
    expect(scanned.flatMap((s) => s.unread).sort()).toEqual(Object.keys(READ_ELSEWHERE).sort());
    // Not a vacuous pass: the refusals of the session, the profile, the print and the gate are all here, in both
    // languages, and each is raised by naming its catalogue sentence.
    expect(FILES).toContain(CATALOGUE);
    expect(scanned.reduce((n, s) => n + s.catalogued, 0)).toBeGreaterThanOrEqual(15);
    expect(messages.filter((m) => m.language === 'en').length).toBeGreaterThanOrEqual(15);
    expect(messages.filter((m) => m.language === 'id').length).toBeGreaterThanOrEqual(15);
    expect(messages.map((m) => m.text)).toEqual(expect.arrayContaining([
      'This item has been retired. A profile that already had it keeps it; nobody ticks it anew.',
      'Every tick must name a milestone or a skill item in the capability catalog.',
      'This session is finalized and locked to view-only. Reopen it to change what was agreed.',
      'Coaching session not found.',
      'A date is written YYYY-MM-DD.',
      'Item ini sudah diarsipkan. Profil yang sudah memilikinya tetap menyimpannya; profil lain tidak dapat mencentangnya.',
      'Sesi coaching tidak ditemukan.',
      'Tanggal ditulis dengan format YYYY-MM-DD.',
    ]));
  });

  it('ADR-0084 no message the coaching module writes contains office, KPM, reports to, tagged to, untagged or unassigned', () => {
    expect(messages.filter(writesASixWord)).toEqual([]);
  });

  it('ADR-0084 finalize’s five refusals, written for every rule, use none of the six either, in either language', () => {
    const rules: FinalizeRefusal[] = [
      { rule: 'NO_ACTION_ITEM' }, { rule: 'EMPTY_TIP' }, { rule: 'EMPTY_ACTION_ITEM' }, { rule: 'UNDATED_ACTION_ITEM' },
      { rule: 'LEAD_THIS_MONTH_UNDATED', leadId: 'l-1', leadName: 'Pak Fauzan Akbar' },
    ];
    const sentences = rules.map(finalizeSentence);
    const written = sentences.flatMap((s): Message[] => [
      { where: 'finalize', language: 'en', text: english(s) },
      { where: 'finalize', language: 'id', text: indonesian(s) },
    ]);
    expect(written.filter(writesASixWord)).toEqual([]);
    // *tagged "this month"* is the prototype's own words about a lead's month, and is not *tagged to*.
    expect(english(sentences[4])).toContain('tagged "this month"');
    expect(indonesian(sentences[4])).toContain('di-tag "bulan ini"');
  });

  it('ADR-0084 the scan’s pattern catches each of the six, and leaves an identifier like kpmId alone', () => {
    for (const phrase of ['The office has retired it', 'this KPM', 'Offices', 'who reports to Sari', 'tagged to a leader', 'Untagged', 'unassigned']) {
      expect({ phrase, caught: SIX_WORDS.test(phrase) }).toEqual({ phrase, caught: true });
    }
    for (const phrase of ['kpmId', 'tagged "this month"', 'reported', 'assigned to her']) {
      expect({ phrase, caught: SIX_WORDS.test(phrase) }).toEqual({ phrase, caught: false });
    }
  });

  it('P18.98-T5 the scan’s Indonesian pattern catches the six as the glossary words them, and a lead’s month tag passes', () => {
    for (const text of ['KPM ini', 'kantor Anda', 'yang melapor ke Sari', 'di-tag ke seorang leader', 'anggota tanpa tim']) {
      expect({ text, caught: writesASixWord({ where: '', language: 'id', text }) }).toEqual({ text, caught: true });
    }
    for (const text of ['kpmId', 'di-tag "bulan ini"', 'melaporkan', 'tim Anda']) {
      expect({ text, caught: writesASixWord({ where: '', language: 'id', text }) }).toEqual({ text, caught: false });
    }
  });
});
