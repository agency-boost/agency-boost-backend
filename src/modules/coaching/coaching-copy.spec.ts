import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import ts from 'typescript';
import { finalizeSentence, type FinalizeRefusal } from './coaching-session.rules';

/**
 * **ADR-0084 rule 2: a string coaching writes itself uses none of the six words** — *office*, *KPM*,
 * *reports to*, *tagged to*, *untagged* and *unassigned* — and a refusal a coaching screen shows is one of
 * those strings. Two of the module's refusals said *office* until the review of 2026-10-02 (parity L-66):
 * `CONFIG_ARCHIVED`'s, which the Leader Notes tab's banner shows as written, and `VALIDATION_FAILED`'s for
 * a code the catalog does not hold.
 *
 * **Read off the source, every message the module writes**, as `raw-writes.tenancy.spec.ts` reads writes:
 * the message of each `new DomainException(code, message, …)`, the resource each `new …Exception(name)`
 * names (*`{name}` not found.*), each `invalid(message, …)` and each validator's `message:`. A constant is
 * followed to its value and a template keeps its literal parts. **A message the scan cannot read fails
 * it** unless it is listed below with the reason, so a new way of writing one cannot pass unread.
 *
 * The shared exceptions the module throws but does not word — `NoMembershipException`,
 * `VersionConflictException` — are the rest of the product's, which rule 4 leaves as they are.
 */

/** The six, as words and phrases in any case: *offices* and *KPMs* included, `kpmId` not. */
const SIX_WORDS = /\b(offices?|kpms?|reports? to|tagged to|untagged|unassigned)\b/i;

const DIR = __dirname;
const FILES = readdirSync(DIR).filter((name) => name.endsWith('.ts') && !name.endsWith('.spec.ts')).sort();

/** Messages the scan cannot read by design, each read another way. */
const READ_ELSEWHERE: Record<string, string> = {
  'coaching-session.service.ts: message':
    '`invalid(message, details)` passes its argument through; every call of `invalid` is read instead.',
  'coaching-session.service.ts: finalizeSentence(refusal)':
    'finalize’s five sentences, which the test below writes for every rule.',
};

interface Message {
  where: string;
  text: string;
}

function messagesOf(file: string): { read: Message[]; unread: string[] } {
  const source = ts.createSourceFile(file, readFileSync(join(DIR, file), 'utf8'), ts.ScriptTarget.Latest, true);
  const constants = new Map<string, ts.Expression>();
  const read: Message[] = [];
  const unread: string[] = [];

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
    if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.PlusToken) {
      const left = textOf(node.left);
      const right = textOf(node.right);
      return left === null || right === null ? null : left + right;
    }
    if (ts.isIdentifier(node) && constants.has(node.text)) return textOf(constants.get(node.text)!);
    return null;
  };

  const take = (node: ts.Expression | undefined, wrap: (text: string) => string = (text) => text): void => {
    if (!node) return;
    const line = source.getLineAndCharacterOfPosition(node.getStart()).line + 1;
    const text = textOf(node);
    if (text === null) unread.push(`${file}: ${node.getText()}`);
    else read.push({ where: `${file}:${line}`, text: wrap(text) });
  };

  const visit = (node: ts.Node): void => {
    if (ts.isNewExpression(node) && ts.isIdentifier(node.expression) && node.expression.text.endsWith('Exception')) {
      if (node.expression.text === 'DomainException') take(node.arguments?.[1]);
      // `NotFoundException(resource)` writes *{resource} not found.*; the others word their own.
      else if (node.expression.text === 'NotFoundException') take(node.arguments?.[0], (name) => `${name} not found.`);
    }
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === 'invalid') {
      take(node.arguments[0]);
    }
    if (ts.isPropertyAssignment(node) && ts.isIdentifier(node.name) && node.name.text === 'message') {
      take(node.initializer);
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return { read, unread };
}

describe('ADR-0084 rule 2: coaching’s own error messages use none of the six words', () => {
  const scanned = FILES.map(messagesOf);
  const messages = scanned.flatMap((s) => s.read);

  it('ADR-0084 reads every message the coaching module writes, and leaves none unread but those read elsewhere', () => {
    expect(scanned.flatMap((s) => s.unread).sort()).toEqual(Object.keys(READ_ELSEWHERE).sort());
    // Not a vacuous pass: the refusals of the session, the profile, the print and the gate are all here.
    expect(messages.length).toBeGreaterThanOrEqual(15);
    expect(messages.map((m) => m.text)).toEqual(expect.arrayContaining([
      'This item has been retired. A profile that already had it keeps it; nobody ticks it anew.',
      'Every tick must name a milestone or a skill item in the capability catalog.',
      'This session is finalized and locked to view-only. Reopen it to change what was agreed.',
      'Coaching session not found.',
      'A date is written YYYY-MM-DD.',
    ]));
  });

  it('ADR-0084 no message the coaching module writes contains office, KPM, reports to, tagged to, untagged or unassigned', () => {
    expect(messages.filter((m) => SIX_WORDS.test(m.text))).toEqual([]);
  });

  it('ADR-0084 finalize’s five refusals, written for every rule, use none of the six either', () => {
    const rules: FinalizeRefusal[] = [
      { rule: 'NO_ACTION_ITEM' }, { rule: 'EMPTY_TIP' }, { rule: 'EMPTY_ACTION_ITEM' }, { rule: 'UNDATED_ACTION_ITEM' },
      { rule: 'LEAD_THIS_MONTH_UNDATED', leadId: 'l-1', leadName: 'Pak Fauzan Akbar' },
    ];
    const sentences = rules.map(finalizeSentence);
    expect(sentences.filter((sentence) => SIX_WORDS.test(sentence))).toEqual([]);
    // *tagged "this month"* is the prototype's own words about a lead's month, and is not *tagged to*.
    expect(sentences[4]).toContain('tagged "this month"');
  });

  it('ADR-0084 the scan’s pattern catches each of the six, and leaves an identifier like kpmId alone', () => {
    for (const phrase of ['The office has retired it', 'this KPM', 'Offices', 'who reports to Sari', 'tagged to a leader', 'Untagged', 'unassigned']) {
      expect({ phrase, caught: SIX_WORDS.test(phrase) }).toEqual({ phrase, caught: true });
    }
    for (const phrase of ['kpmId', 'tagged "this month"', 'reported', 'assigned to her']) {
      expect({ phrase, caught: SIX_WORDS.test(phrase) }).toEqual({ phrase, caught: false });
    }
  });
});
