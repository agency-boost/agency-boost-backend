import { ANALYTICS } from '@/domain/constants';
import { compileLinearPattern, MAX_STATES } from './linear-pattern';

const MAX = ANALYTICS.CODE_PATTERN_MAX_LENGTH;
const compile = (source: string) => compileLinearPattern(source, MAX);
const tester = (source: string) => {
  const compiled = compile(source);
  if (!compiled.ok) throw new Error(`refused ${source}: ${compiled.problem}`);
  return compiled.pattern;
};

/**
 * **P19.5-T1 AC-11 — the agent-code pattern, in a linear-time engine** (ADR-0214 §7): JavaScript's meaning for what a
 * code format needs, every refusal named, and no pattern able to hang the API.
 */
describe('compileLinearPattern (ADR-0214 §7)', () => {
  it.each([
    ['^[0-9]{8}$', ['70012345', '00000000'], ['7001234', '700123456', '7001234a', '']],
    ['^\\d{3,32}$', ['123', '80777', '1'.repeat(32)], ['12', '1'.repeat(33), '12a']],
    ['^[A-Za-z0-9-]{1,32}$', ['KPM0417-001', 'a', 'A-1'], ['', 'a b', 'a_b']],
    ['^.{1,64}$', ['anything at all', 'x'], ['', 'x'.repeat(65), 'a\nb']],
    ['^KPM\\d{4}-\\d{3}$', ['KPM0417-001'], ['KPM0417-01', 'kpm0417-001']],
    ['^(AB|AAB)\\d+$', ['AB1', 'AAB22'], ['A1', 'ABAB1']],
    ['^(?:7|8)\\d{7}$', ['70012345', '80012345'], ['90012345']],
    ['^(?<prefix>[A-Z]{2})\\d*$', ['AB', 'AB123'], ['A1']],
    ['^[^\\s]+$', ['abc'], ['a c', '']],
    ['^a?b+c*$', ['b', 'abbb', 'bccc'], ['a', 'ac']],
    ['^\\w+\\.\\w+$', ['a.b'], ['ab']],
    ['^x{2,}$', ['xx', 'xxxx'], ['x']],
    ['^a+?$', ['a', 'aaa'], ['']],
    ['^[a\\-z]$', ['a', '-', 'z'], ['b']],
    ['^\\x41\\u0042$', ['AB'], ['ab']],
    // The negated class escapes, the control escapes, NUL at either end, a backspace in a class.
    ['^\\D\\W\\S$', ['a!x'], ['1!x', 'a_x', 'a! ']],
    ['^\\t\\n\\r\\f\\v$', ['\t\n\r\f\v'], ['\t\n\r\f', 'tnrfv']],
    ['^a\\0$', ['a\0'], ['a0', 'a']],
    ['^\\0a$', ['\0a'], ['0a']],
    ['^[\\b]$', ['\b'], ['b']],
    // Nothing at all: a repetition of none, an empty alternative, an empty pattern.
    ['^a{0}b$', ['b'], ['ab']],
    ['^(a|)b$', ['ab', 'b'], ['aab']],
    ['^$', [''], ['a']],
  ])('P19.5-T1 AC-11 %s means what JavaScript means by it', (source, yes, no) => {
    const pattern = tester(source);
    const js = new RegExp(source);
    for (const code of yes) {
      expect([code, pattern.test(code)]).toEqual([code, true]);
      expect(js.test(code)).toBe(true);
    }
    for (const code of no) {
      expect([code, pattern.test(code)]).toEqual([code, false]);
      expect(js.test(code)).toBe(false);
    }
  });

  it.each([
    ['[0-9]{8}', 'not_anchored'],
    ['^[0-9]{8}', 'not_anchored'],
    ['[0-9]{8}$', 'not_anchored'],
    ['^abc\\$', 'not_anchored'],
    ['^(a)\\1$', 'backreference'],
    ['^(?<x>a)\\k<x>$', 'backreference'],
    ['^(?=a)a$', 'lookaround'],
    ['^(?!b)a$', 'lookaround'],
    ['^(?<=a)b$', 'lookaround'],
    ['^(?<!a)b$', 'lookaround'],
    ['^\\bab$', 'unsupported'],
    ['^a^b$', 'unsupported'],
    ['^a**$', 'syntax'],
    ['^(ab$', 'syntax'],
    ['^ab)$', 'syntax'],
    ['^[ab$', 'syntax'],
    ['^a{3,1}$', 'syntax'],
    ['^\\q$', 'syntax'],
    ['', 'syntax'],
    // A `{` that is no count, and a quantifier or a closer with nothing before it.
    ['^a{x}$', 'syntax'],
    ['^*a$', 'syntax'],
    ['^+$', 'syntax'],
    ['^?$', 'syntax'],
    ['^{2}$', 'syntax'],
    ['^a}$', 'syntax'],
    ['^]$', 'syntax'],
    // A group name that is no name, and `(?` followed by nothing it knows.
    ['^(?<1x>a)$', 'syntax'],
    ['^(?x)$', 'syntax'],
    // A range bounded by a class escape, or running backwards.
    ['^[\\d-z]$', 'syntax'],
    ['^[\\w-z]$', 'syntax'],
    ['^[a-\\d]$', 'syntax'],
    ['^[z-a]$', 'syntax'],
    // `\0` followed by a digit is an octal back-reference; `\B` is an assertion, in a class or out.
    ['^\\01$', 'backreference'],
    ['^[\\B]$', 'unsupported'],
    ['^\\Ba$', 'unsupported'],
    // `\x` and `\u` without their hex digits.
    ['^\\xZZ$', 'syntax'],
    ['^\\u12$', 'syntax'],
  ])('P19.5-T1 AC-11 refuses %s: %s', (source, problem) => {
    expect(compile(source)).toEqual({ ok: false, problem });
  });

  it('P19.5-T1 AC-11 refuses a pattern longer than ANALYTICS.CODE_PATTERN_MAX_LENGTH', () => {
    expect(compile(`^${'a'.repeat(MAX - 1)}$`)).toEqual({ ok: false, problem: 'too_long' });
    expect(compile(`^${'a'.repeat(MAX - 2)}$`).ok).toBe(true);
  });

  it('P19.5-T1 AC-11 refuses a repetition whose automaton would pass MAX_STATES', () => {
    expect(MAX_STATES).toBe(20_000);
    expect(compile('^((a{1000}){1000})$')).toEqual({ ok: false, problem: 'too_large' });
  });

  it('P19.5-T1 AC-11 reads a catastrophic pattern in linear time — no backtracking', () => {
    const pattern = tester('^(a+)+$');
    const code = `${'a'.repeat(5000)}b`;
    const started = Date.now();
    expect(pattern.test(code)).toBe(false);
    expect(pattern.test('a'.repeat(5000))).toBe(true);
    expect(Date.now() - started).toBeLessThan(1000);
  });
});
